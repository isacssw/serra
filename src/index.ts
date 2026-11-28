/** The daemon's entry: the profile, the logger and knowledge for `startDaemon`, plus signals. The daemon connects the chats. */
import { loadConfig } from './config.ts';
import { startDaemon } from './daemon.ts';
import { createKnowledge } from './knowledge.ts';
import { errorMessage } from './lib/errors.ts';
import { timestampedLogger } from './logging.ts';
import { systemClock } from './clock.ts';
import { createTelegramConnection } from './telegram/connection.ts';

const config = loadConfig();
const logger = timestampedLogger('info');

// Telegram, when the owner connected a bot in Settings › Channels. Slack is always served.
const telegram = config.telegram;
const chats = telegram ? [createTelegramConnection({
  token: () => telegram.token, profileDir: config.profileDir, bot: telegram.bot, ...(telegram.ownerId ? { ownerId: telegram.ownerId } : {}), logger, clock: systemClock,
})] : [];

const daemon = await startDaemon({ config, logger, knowledge: createKnowledge(config.knowledgeDir), chats }).catch((error: unknown) => {
  logger.error(errorMessage(error));
  process.exit(1);
});

let stopping = false;
const shutdown = (): void => {
  if (stopping) return;
  stopping = true;
  void daemon.stop().catch((error: unknown) => logger.error(`Shutdown failed: ${errorMessage(error)}`)).finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
