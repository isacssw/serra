import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { createBot } from './bot.ts';
import { createKnowledge } from './knowledge.ts';
import { createStore } from './state.ts';
import { loadConfig, defaultProfileRoot } from './config.ts';
import { acquireLock } from './lock.ts';
import { incomingMessage } from './incoming.ts';
import { eventLog, timestampedLogger } from './logging.ts';
import { QUESTION_ACTION, questionInteraction } from './questions.ts';
import { jobCounts, startStatusServer, type StatusServer } from './status-socket.ts';
import { watchProfile } from './profile-reload.ts';
import { checkProjectAccess } from './project-access.ts';

const POLL_MS = 15_000;

const config = loadConfig();
mkdirSync(dirname(config.statePath), { recursive: true, mode: 0o700 });
const releaseProfileLock = acquireLock(`${config.statePath}.lock`);
process.on('exit', releaseProfileLock);
const { checkKnowledge, loadIndex } = createKnowledge(config.knowledgeDir);

const logger = timestampedLogger(LogLevel.INFO);
// Under launchd, macOS may block the repository (Documents, Desktop, Downloads). Find out now, not on the first job.
try { await checkProjectAccess([config.project, ...config.repositories.map(({ path }) => path)]); }
catch (error) { logger.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
// The receiver is made here rather than by `socketMode: true` so its connection state can feed the status socket.
const receiver = new SocketModeReceiver({ appToken: config.appToken, logger, logLevel: LogLevel.INFO });
const app = new App({ token: config.botToken, receiver, logger, logLevel: LogLevel.INFO });
let slackConnected = false;

let botUserId = '';
let botId = '';
const logsDir = join(config.profileDir, 'logs');
mkdirSync(logsDir, { recursive: true, mode: 0o700 });
const store = createStore(config.statePath);
const logEvent = eventLog(join(logsDir, 'events.jsonl'));
let status: StatusServer | null = null;
const bot = createBot({
  config, client: app.client, botUserId: () => botUserId, store, loadIndex, logger: app.logger,
  // The app sees the same events as events.jsonl, live.
  events: (name, fields) => { logEvent(name, fields); status?.publish(name, fields); },
});

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let stopping = false;
const pending = new Set<Promise<unknown>>();
const track = async (work: Promise<unknown>): Promise<void> => {
  pending.add(work);
  try { await work; } finally { pending.delete(work); }
};

app.event('app_mention', async ({ event }) => {
  if (stopping) return;
  const msg = incomingMessage(event, 'app_mention', botUserId, bot.ownsThread, { messageTriggers: config.messageTriggers, botId });
  if (msg) await track(bot.handle(msg));
});

// Agent view emits this when someone opens the app. Wait for their message before starting work.
app.event('app_home_opened', async () => {});

app.action(QUESTION_ACTION, async ({ ack, body }) => {
  await ack();
  if (stopping) return;
  const interaction = questionInteraction(body);
  if (interaction) await track(bot.handleQuestionAction(interaction));
});

app.message(async ({ message }) => {
  if (stopping) return;
  const msg = incomingMessage(message, 'message', botUserId, bot.ownsThread, { messageTriggers: config.messageTriggers, botId });
  if (msg) await track(bot.handle(msg));
});

// A missing index stops the daemon here instead of failing the first request. An index over its cap and page problems only warn.
loadIndex();
const knowledge = checkKnowledge({
  roots: [{ name: basename(config.project), path: config.project }, ...config.repositories.map(({ name, path }) => ({ name, path }))],
});
for (const problem of knowledge.problems) app.logger.warn(`knowledge/${problem}`);
for (const warning of knowledge.warnings) app.logger.warn(`knowledge/${warning}`);

const auth = await app.client.auth.test();
botUserId = auth.user_id ?? '';
botId = auth.bot_id ?? '';
if (!botUserId) throw new Error('Slack auth.test returned no bot user ID');
const locksDir = join(defaultProfileRoot, 'locks');
mkdirSync(locksDir, { recursive: true, mode: 0o700 });
const releaseBotLock = acquireLock(join(locksDir, `${botUserId}.lock`));
process.on('exit', releaseBotLock);
receiver.client.on('connected', () => { slackConnected = true; status?.refresh(); });
for (const state of ['disconnected', 'reconnecting']) receiver.client.on(state, () => { slackConnected = false; status?.refresh(); });
await app.start();
slackConnected = true;
const startedAt = new Date().toISOString();
// The app's live view. Without it the bot still works, and the app shows "stopped".
status = await startStatusServer({
  profileDir: config.profileDir,
  status: () => ({ state: 'up', pid: process.pid, startedAt, slackConnected, counts: jobCounts(store.allJobs().map(([, job]) => job)) }),
}).catch((error: unknown) => {
  app.logger.warn(`Status socket not started: ${errorMessage(error)}`);
  return null;
});
if (status) process.on('exit', status.removeSocketFile);
const readyPath = config.profileDir ? join(config.profileDir, 'ready.json') : undefined;
if (readyPath) writeFileSync(readyPath, JSON.stringify({ pid: process.pid, botUserId, startedAt: new Date().toISOString() }), { mode: 0o600 });
app.logger.info(`${config.name} is up as @${auth.user} in ${auth.team}. Project ${config.project}, base ${config.baseRef}.`);
app.logger.info(
  `Knowledge: ${knowledge.pages.length} pages, ${knowledge.unverified.length} not verified, ${knowledge.proposals.length} proposals waiting.`,
);
// People and message triggers apply as soon as profile.json changes. Other sections wait for a restart.
const profileWatcher = watchProfile(config.profileDir, bot.reloadProfile, {
  onError: (error) => app.logger.warn(`Not watching profile.json, changes apply after a restart: ${errorMessage(error)}`),
});
const timer = setInterval(() => {
  if (stopping) return;
  void track(bot.poll()).catch((error: unknown) => {
    app.logger.error(`Poll failed: ${errorMessage(error)}`);
  }).finally(() => status?.refresh());
}, POLL_MS);

const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  profileWatcher.close();
  if (readyPath && existsSync(readyPath)) rmSync(readyPath);
  await status?.close();
  await app.stop();
  // Messages still waiting for a quiet moment go to their workers now, so a restart loses none.
  await bot.drain();
  await Promise.allSettled([...pending]);
  process.exit(0);
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
