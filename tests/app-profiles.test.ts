// Profiles (SB-10): what the owner sees when there are several bots on one Mac, and what must never mix between them.
// The switcher's list and its words, switching (and the screens' data following it), the order and colours kept in
// profiles.json, Add… › Profile, a remove that keeps a checked backup, and an alpha.9 install opening unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { profilesHandlers } from '../src/handlers/profiles.ts';
import { profileSlackNames } from '../src/handlers/slack-names.ts';
import { setupHandlers } from '../src/handlers/setup.ts';
import { defaultPrefs, memoryPrefs } from '../app/main/prefs.ts';
import { arrange, emptyProfilesFile, moveRef, parseProfilesFile, PROFILE_COLORS, resolveColors, withLooks, withoutRef, withOrder } from '../src/profile-order.ts';
import { createActionRegistry, searchActions } from '../app/renderer/commands/registry.ts';
import { socketStatusSource, stoppedStatusSource, type StatusSubscriber } from '../src/status-source.ts';
import type { ProfilesView } from '../app/main/bridge.ts';
import { presence } from '../app/renderer/presence.logic.ts';
import { lettersFor, newProfileLook, profileLooks, profileRows, rowLabel, showsSwitcher, takenColors, windowTitle } from '../app/renderer/profiles.logic.ts';
import { statusHeader, statusView } from '../app/renderer/status.logic.ts';
import { ADD_PROFILE_PATH, profileShortcut } from '../app/renderer/shell/shortcuts.logic.ts';
import type { BotStatus, StatusMessage } from '../src/contracts.ts';
import type { ServiceDriver } from '../src/service.ts';
import { MANIFEST_FILE } from '../src/profile-backup.ts';
import { createProfile } from '../src/setup.ts';
import { createHandlers, engineContext, type AppContext } from './fakes/app-context.ts';

const BOT = 'xoxb-1111-2222-fixturevalue';
const APP = 'xapp-1-A111-2222-fixturevalue';
const OWNER = 'U0123456789';

const up = (counts: { needsYou: number; running: number }, slackConnected = true): BotStatus =>
  ({ state: 'up', pid: 4242, startedAt: '2026-11-28T08:00:00.000Z', slackConnected, counts });

/** A profiles folder in a temp dir, with launchd plists and a Trash beside it. */
const fixture = (t: TestContext) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'serra-profiles-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'serra');
  const agents = join(base, 'LaunchAgents');
  const trash = join(base, 'Trash');
  for (const dir of [root, agents, trash]) mkdirSync(dir, { recursive: true });
  /** A profile as `pnpm run setup` (or alpha.9's app) leaves it. `done` adds what finishes setup. */
  const profile = (id: string, { done = true }: { done?: boolean } = {}): string => {
    const dir = join(root, id);
    createProfile(dir, {
      version: 1, bot: { id, name: id[0]!.toUpperCase() + id.slice(1) }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
      project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
    });
    if (done) {
      writeFileSync(join(dir, '.env'), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`);
      const check = { verifiedAt: '2026-11-27T10:00:00.000Z' };
      writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, sources: {}, checks: { SLACK_BOT_TOKEN: check, SLACK_APP_TOKEN: check } }));
      writeFileSync(join(dir, 'setup.json'), JSON.stringify({ version: 1, owner: { slackUserId: OWNER, slackName: 'Alex', checkedAt: '2026-11-27T10:00:00.000Z' }, serviceAnsweredAt: '2026-11-27T10:05:00.000Z' }));
      writeFileSync(join(agents, `dev.serra.${id}.plist`), '<plist/>');
    }
    return dir;
  };
  const stopped: string[] = [];
  const driver: ServiceDriver = {
    loaded: async () => true, stop: async (label) => { stopped.push(label); }, start: async () => {}, ready: async () => {},
  };
  const context = (active: string | null, extra: Partial<AppContext> = {}): AppContext & { pushed: string[]; opened: string[] } => {
    const prefs = memoryPrefs({ ...defaultPrefs, profileDir: active });
    const pushed: string[] = [];
    const opened: string[] = [];
    return {
      pushed, opened,
      profileDir: () => { const dir = prefs.get().profileDir; if (!dir) throw new Error('No bot profile selected.'); return dir; },
      profileDirOrNull: () => prefs.get().profileDir,
      prefs,
      status: stoppedStatusSource(),
      runtime: { version: '0.0.0', electron: '45.4.1', node: '24.22.3', platform: 'darwin' },
      openExternal: async () => {},
      openPath: async (path) => { opened.push(path); },
      push: (channel) => { pushed.push(channel); },
      trashItem: async (path) => { renameSync(path, join(trash, basename(path))); },
      ...extra,
    };
  };
  const handlers = (ctx: AppContext) => profilesHandlers(engineContext(ctx), {
    root, launchAgentsDir: agents, service: driver, probeMs: 200, searchPath: async () => '', now: () => new Date('2026-11-28T12:00:00Z'),
  });
  return { base, root, agents, trash, profile, context, handlers, stopped };
};

/** Every file under `dir` with its size, time and hash, to prove nothing was written. */
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const stat = statSync(path);
        out[relative(dir, path)] = `${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
};

const view = (names: string[], active: number, extra: Partial<ProfilesView> = {}): ProfilesView => ({
  pinned: false,
  palette: [...PROFILE_COLORS],
  ...extra,
  profiles: names.map((name, index) => ({
    ref: `local/${name.toLowerCase()}`, dir: `/Users/you/.local/share/serra/${name.toLowerCase()}`, name, color: PROFILE_COLORS[index]!,
    active: index === active, setupDone: true, status: index === active ? null : { state: 'stopped' }, agent: 'T3',
  })),
});

// ---------------------------------------------------------------------------------------------------------------
// What the owner sees
// ---------------------------------------------------------------------------------------------------------------

test('one profile looks exactly as before: "Serra · up", no switcher, the window titled Serra', () => {
  const one = view(['Saitama'], 0);
  assert.equal(showsSwitcher(one), false);
  assert.equal(windowTitle(one), 'Serra');
  assert.equal(statusHeader(statusView(up({ needsYou: 0, running: 0 }))), 'Serra · up');
  assert.equal(statusHeader(statusView(up({ needsYou: 1, running: 2 }, false))), 'Serra · Slack disconnected');
  // Pinned with --profile, even several profiles show no switcher.
  assert.equal(showsSwitcher(view(['Saitama', 'Scout'], 0, { pinned: true })), false);
});

test('two profiles: the switcher names each one, with its phrase and ⌘ number, and the window title names the one in use', () => {
  const two = view(['Saitama', 'Scout'], 1);
  two.profiles[0]!.status = up({ needsYou: 1, running: 0 });
  assert.equal(showsSwitcher(two), true);
  assert.equal(windowTitle(two), 'Scout — Serra');
  const rows = profileRows(two, up({ needsYou: 0, running: 2 }));
  assert.deepEqual(rows.map((row) => [row.name, row.letters, row.presence.phrase, row.shortcut, row.active]), [
    ['Saitama', 'S', '1 needs you', '⌘1', false],
    ['Scout', 'Sc', '2 running', '⌘2', true],
  ]);
  // The one in use shows the window's live status; before its first report, `checking`, never a guess.
  assert.equal(profileRows(two, null)[1]!.presence.phrase, 'checking');
  assert.equal(rowLabel(rows[1]!), 'Scout, 2 running, command 2');
});

test('the status words: one dot and one phrase per state, from the daemon only', () => {
  const said = (status: BotStatus | null, setupDone = true) => {
    const { dot, word, phrase } = presence(status, { setupDone });
    return [dot, word, phrase];
  };
  assert.deepEqual(said(null), ['faint', 'checking', 'checking']);
  assert.deepEqual(said(up({ needsYou: 0, running: 0 })), ['up', 'up', 'up']);
  assert.deepEqual(said(up({ needsYou: 0, running: 3 })), ['up', 'up', '3 running']);
  assert.deepEqual(said(up({ needsYou: 1, running: 3 })), ['warn', 'up', '1 needs you']);
  assert.deepEqual(said(up({ needsYou: 2, running: 0 })), ['warn', 'up', '2 need you']);
  assert.deepEqual(said(up({ needsYou: 0, running: 0 }, false)), ['down', 'disconnected', 'Slack disconnected']);
  assert.deepEqual(said({ state: 'stopped' }), ['down', 'stopped', 'stopped']);
  // Left halfway: no dot, "Finish setup".
  assert.deepEqual(said({ state: 'stopped' }, false), ['none', 'stopped', 'Finish setup']);
  assert.equal(presence(null).pulse, true);
});

test('avatars: a unique letter (two when the first is taken) and a unique colour that stays put', () => {
  assert.equal(lettersFor('Saitama', new Set()), 'S');
  assert.equal(lettersFor('Scout', new Set(['S'])), 'Sc');
  assert.equal(lettersFor('Scout', new Set(['S', 'Sc'])), 'So');
  assert.equal(lettersFor('  researcher!', new Set()), 'R');
  assert.deepEqual(profileLooks([{ name: 'Saitama', color: '#2b2b30' }, { name: 'Scout', color: '#2f7a9a' }, { name: 'Sam', color: '#4b6a8a' }]).map((look) => look.letters), ['S', 'Sc', 'Sa']);
  // Colours: the kept one, else the first free, in list order.
  const file = { version: 1 as const, order: [], look: { 'local/scout': { color: '#2f7a9a' } } };
  assert.deepEqual(resolveColors(['local/saitama', 'local/scout', 'local/sam'], file), {
    'local/saitama': PROFILE_COLORS[0], 'local/scout': '#2f7a9a', 'local/sam': PROFILE_COLORS[1],
  });
  // Written in on every write, so removing the first profile doesn't recolour the others.
  const kept = withLooks(file, ['local/saitama', 'local/scout', 'local/sam']);
  assert.deepEqual(resolveColors(['local/scout', 'local/sam'], withoutRef(kept, 'local/saitama')), { 'local/scout': '#2f7a9a', 'local/sam': PROFILE_COLORS[1] });
  // Colours another profile shows are crossed out; a profile's own is not. A new one gets the first free.
  const two = view(['Saitama', 'Scout'], 0);
  assert.deepEqual([...takenColors(two.profiles, 'local/scout')], [PROFILE_COLORS[0]]);
  assert.deepEqual(newProfileLook(two, 'Sage'), { letters: 'Sa', color: PROFILE_COLORS[2] });
  // No status hue among the avatar colours.
  for (const color of PROFILE_COLORS) assert.doesNotMatch(color, /^#(16|3e|97|f5|b9|f8)/);
});

test('⌘K lists the profiles first, then screens, then actions', () => {
  const registry = createActionRegistry();
  registry.register([
    { id: 'go:jobs', title: 'Needs you', group: 'Go to', button: 'Sidebar › Jobs', run: () => {} },
    { id: 'bot:restart', title: 'Restart bot', group: 'Actions', destructive: true, button: 'Menubar', run: () => {} },
    { id: 'profiles:switch:local/scout', title: 'Switch to Scout', group: 'Profiles', hint: '2 running · ⌘2', button: 'Title row', run: () => {} },
  ]);
  assert.deepEqual(searchActions(registry.list(), '').map((result) => result.action.title), ['Switch to Scout', 'Needs you', 'Restart bot']);
  assert.equal(searchActions(registry.list(), 'scout')[0]?.action.title, 'Switch to Scout');
});

test('keys: ⌘1…⌘9 pick a profile by its place, ⌘⇧N opens Add…, and nothing else is taken', () => {
  const press = (key: string, more: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...more });
  assert.deepEqual(profileShortcut(press('1'), true), { kind: 'switch', index: 0 });
  assert.deepEqual(profileShortcut(press('9'), true), { kind: 'switch', index: 8 });
  assert.equal(profileShortcut(press('0'), true), null);
  assert.deepEqual(profileShortcut(press('N', { shiftKey: true }), true), { kind: 'add' });
  assert.equal(profileShortcut(press('n'), true), null, '⌘N stays New task');
  assert.equal(profileShortcut(press('1', { altKey: true }), true), null);
  assert.equal(profileShortcut(press('1', { metaKey: false, ctrlKey: true }), true), null, 'Ctrl+1 is not ⌘1 on a Mac');
  assert.deepEqual(profileShortcut(press('2', { metaKey: false, ctrlKey: true }), false), { kind: 'switch', index: 1 });
  assert.equal(ADD_PROFILE_PATH, '/setup/new');
});

// ---------------------------------------------------------------------------------------------------------------
// profiles.json
// ---------------------------------------------------------------------------------------------------------------

test('profiles.json: folders are the truth; the file only orders them and keeps colours, and a bad file is ignored', () => {
  assert.deepEqual(parseProfilesFile('nonsense'), emptyProfilesFile());
  const file = parseProfilesFile({ version: 1, order: ['local/scout', 'local/scout', 7, 's_7f3k2q/researcher', 'local/gone'], look: { 'local/scout': { color: '#2F7A9A' }, 'local/x': { color: 'red' } } });
  assert.deepEqual(file.order, ['local/scout', 's_7f3k2q/researcher', 'local/gone']);
  assert.deepEqual(file.look, { 'local/scout': { color: '#2f7a9a' } });
  // A folder with no entry comes after the ordered ones; an entry with no folder is left out of the list.
  assert.deepEqual(arrange(['saitama', 'scout', 'atlas'], file), ['local/scout', 'local/atlas', 'local/saitama']);
  assert.deepEqual(moveRef(['local/a', 'local/b', 'local/c'], 'local/c', 0), ['local/c', 'local/a', 'local/b']);
  assert.deepEqual(moveRef(['local/a', 'local/b'], 'local/a', 99), ['local/b', 'local/a']);
  // Entries the list doesn't show (a server's profile, a folder gone for now) stay in the file.
  const moved = withOrder(file, ['local/atlas', 'local/scout']);
  assert.deepEqual(moved.order, ['local/atlas', 'local/scout', 's_7f3k2q/researcher', 'local/gone']);
  assert.deepEqual(withoutRef(moved, 'local/scout'), { version: 1, order: ['local/atlas', 's_7f3k2q/researcher', 'local/gone'], look: {} });
});

// ---------------------------------------------------------------------------------------------------------------
// Upgrade from alpha.9
// ---------------------------------------------------------------------------------------------------------------

test('an alpha.9 install opens unchanged: one profile, no profiles.json, and nothing written to its folder', async (t) => {
  const f = fixture(t);
  const dir = f.profile('saitama');
  const before = snapshot(f.root);
  // alpha.9 saved the profile it manages in app prefs; that stays what the window opens.
  const ctx = f.context(dir);
  const profiles = f.handlers(ctx);
  const listed = await profiles.list();
  assert.deepEqual(listed.profiles.map((p) => [p.ref, p.name, p.active, p.setupDone, p.agent]), [['local/saitama', 'Saitama', true, true, 'T3']]);
  assert.equal(showsSwitcher(listed), false);
  assert.equal(windowTitle(listed), 'Serra');
  await profiles.switch('local/saitama');
  await createHandlers(ctx).bot.status();
  await setupHandlers(engineContext(ctx), { root: f.root, launchAgentsDir: f.agents }).progress();
  assert.equal(ctx.prefs.get().profileDir, dir);
  assert.equal(existsSync(join(f.root, 'profiles.json')), false, 'no profiles.json until the owner changes something');
  assert.deepEqual(snapshot(f.root), before, 'the profile folder is exactly as it was');
});

test('an alpha.9 Mac with two bots lists both by folder name, keeps the one in use, and still writes nothing', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  f.profile('friday');
  const before = snapshot(f.root);
  const listed = await f.handlers(f.context(saitama)).list();
  assert.deepEqual(listed.profiles.map((p) => [p.name, p.active]), [['Friday', false], ['Saitama', true]]);
  assert.deepEqual(listed.profiles.map((p) => p.status), [{ state: 'stopped' }, null]);
  assert.deepEqual(snapshot(f.root), before);
  // A profile kept outside the profiles folder (an older setup's own path) is still listed while it is in use.
  const elsewhere = join(f.base, 'bots', 'jarvis');
  createProfile(elsewhere, {
    version: 1, bot: { id: 'jarvis', name: 'Jarvis' }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  });
  const outside = await f.handlers(f.context(elsewhere)).list();
  assert.deepEqual(outside.profiles.map((p) => [p.name, p.active]), [['Friday', false], ['Saitama', false], ['Jarvis', true]]);
});

// ---------------------------------------------------------------------------------------------------------------
// Switching and isolation
// ---------------------------------------------------------------------------------------------------------------

test('switching shows the other profile’s knowledge, jobs, settings and secrets, and nothing of the first', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  const scout = f.profile('scout');
  // Each has a page, a job and tokens of its own; Scout's tokens are not set.
  writeFileSync(join(saitama, 'knowledge', 'saitama-deploys.md'), '---\ndescription: How Saitama deploys\n---\n# Deploys\n');
  writeFileSync(join(scout, 'knowledge', 'scout-pricing.md'), '---\ndescription: Scout’s pricing notes\n---\n# Pricing\n');
  const job = (channel: string) => ({
    [`${channel}:1700000000.000001`]: {
      t3ThreadId: `thread-${channel}`, channel, threadTs: '1700000000.000001', requester: OWNER, pendingReactionTs: null, lastPostedRunId: null,
      watching: true, ownerAskOpen: true, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    },
  });
  writeFileSync(join(saitama, 'state.json'), JSON.stringify(job('C0000000SAI')));
  writeFileSync(join(scout, 'state.json'), JSON.stringify(job('C0000000SCO')));
  writeFileSync(join(scout, '.env'), 'SLACK_APP_TOKEN=xapp-replace-me\nSLACK_BOT_TOKEN=xoxb-replace-me\n');

  const ctx = f.context(saitama);
  const all = createHandlers(ctx, profileSlackNames(engineContext(ctx), { ask: () => async () => null, log: () => {} }));
  const profiles = f.handlers(ctx);
  const seen = async () => ({
    bot: (await all.settings.read()).bot.name,
    pages: (await all.pages.list()).map((page) => page.path).filter((path) => /saitama|scout/.test(path)),
    jobs: (await all.jobs.list()).map((row) => row.channel),
    tokens: (await all.secrets.list()).map((secret) => [secret.name, secret.set]),
  });

  assert.deepEqual(await seen(), {
    bot: 'Saitama', pages: ['saitama-deploys.md'], jobs: ['C0000000SAI'],
    tokens: [['SLACK_BOT_TOKEN', true], ['SLACK_APP_TOKEN', true]],
  });
  const after = await profiles.switch('local/scout');
  assert.deepEqual(after.profiles.map((p) => [p.name, p.active]), [['Saitama', false], ['Scout', true]]);
  assert.deepEqual(await seen(), {
    bot: 'Scout', pages: ['scout-pricing.md'], jobs: ['C0000000SCO'],
    tokens: [['SLACK_BOT_TOKEN', false], ['SLACK_APP_TOKEN', false]],
  });
  // And back: Saitama's own again, untouched by the visit.
  await profiles.switch('local/saitama');
  assert.equal((await seen()).bot, 'Saitama');
  assert.equal(readFileSync(join(scout, 'knowledge', 'scout-pricing.md'), 'utf8').includes('Pricing'), true);
  assert.equal(existsSync(join(saitama, 'knowledge', 'scout-pricing.md')), false);
});

test('switching is refused while pinned with --profile or while a bot update switches releases, and an unknown profile is refused', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  f.profile('scout');
  const pinned = f.handlers({ ...f.context(saitama), profilePinned: true });
  assert.equal((await pinned.list()).pinned, true);
  await assert.rejects(async () => pinned.switch('local/scout'), /command line/);
  const busy = f.context(saitama, { switchBlocked: () => 'A bot update is switching versions. Try again when it finishes.' });
  await assert.rejects(async () => f.handlers(busy).switch('local/scout'), /bot update/);
  assert.equal(busy.prefs.get().profileDir, saitama);
  await assert.rejects(async () => f.handlers(f.context(saitama)).switch('local/nobody'), /isn’t on this Mac/);
});

test('after a switch the window asks for the new bot’s status, not the `stopped` said while it connects', async () => {
  const listeners = new Map<string, (message: StatusMessage) => void>();
  const subscribe: StatusSubscriber = (dir, listener) => { listeners.set(dir, listener); return { close: () => {} }; };
  const source = socketStatusSource('/Users/you/a', subscribe);
  listeners.get('/Users/you/a')!({ type: 'status', status: up({ needsYou: 0, running: 1 }) });
  await source.settled!(1_000);
  source.follow('/Users/you/b');
  assert.deepEqual(source.current(), { state: 'stopped' });
  const waited = source.settled!(5_000).then(() => source.current());
  setTimeout(() => listeners.get('/Users/you/b')!({ type: 'status', status: up({ needsYou: 2, running: 0 }) }), 20);
  assert.deepEqual(await waited, up({ needsYou: 2, running: 0 }));
  // A daemon that never answers doesn't hold the window up.
  source.follow('/Users/you/c');
  const started = Date.now();
  await source.settled!(50);
  assert.ok(Date.now() - started < 1_000);
  source.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Order, colour, Add and Remove
// ---------------------------------------------------------------------------------------------------------------

test('reordering and a colour are kept in profiles.json, and ⌘ numbers follow the order', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  f.profile('scout');
  f.profile('atlas');
  const profiles = f.handlers(f.context(saitama));
  assert.deepEqual((await profiles.list()).profiles.map((p) => p.name), ['Atlas', 'Saitama', 'Scout']);
  const moved = await profiles.move('local/saitama', 0);
  assert.deepEqual(profileRows(moved, null).map((row) => [row.name, row.shortcut]), [['Saitama', '⌘1'], ['Atlas', '⌘2'], ['Scout', '⌘3']]);
  const colored = await profiles.setColor('local/scout', '#9a4f7c');
  assert.equal(colored.profiles.find((p) => p.name === 'Scout')?.color, '#9a4f7c');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'profiles.json'), 'utf8')), {
    version: 1, order: ['local/saitama', 'local/atlas', 'local/scout'],
    // Each keeps the colour it showed before the move.
    look: { 'local/atlas': { color: PROFILE_COLORS[0] }, 'local/saitama': { color: PROFILE_COLORS[1] }, 'local/scout': { color: '#9a4f7c' } },
  });
  await assert.rejects(async () => profiles.setColor('local/scout', 'red'), /colours/);
  await assert.rejects(async () => profiles.move('local/scout', 1.5), /where/);
});

test('Add… › Profile: the new one goes last (no one else’s ⌘ number moves), with its colour and agent, and is the one in use', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  const ctx = f.context(saitama);
  const profiles = f.handlers(ctx);
  const draft = {
    botName: 'Ada', ownerName: 'Alex', ownerSlackUserId: OWNER, githubLogin: 'alex', projectPath: '/Users/you/project', remote: 'origin',
    baseRef: 'origin/main', githubRepo: 'acme/project',
  };
  const progress = await profiles.create({ draft, color: '#4f55b8', agent: null });
  assert.equal(progress.next, 'slack', 'setup goes on from Slack');
  const listed = await profiles.list();
  // "Ada" sorts before "Saitama" by folder, but is added after it.
  assert.deepEqual(profileRows(listed, null).map((row) => [row.name, row.shortcut, row.active, row.setupDone]), [
    ['Saitama', '⌘1', false, true], ['Ada', '⌘2', true, false],
  ]);
  assert.equal(profileRows(listed, null)[1]!.presence.phrase, 'Finish setup');
  assert.equal(listed.profiles[1]!.color, '#4f55b8');
  assert.equal(ctx.prefs.get().profileDir, join(f.root, 'ada'));
  // An agent that isn't installed is refused before anything is made.
  await assert.rejects(async () => profiles.create({ draft: { ...draft, botName: 'Bea' }, color: null, agent: 'claude' }), /isn’t installed/);
  assert.equal(existsSync(join(f.root, 'bea')), false);
  await assert.rejects(async () => f.handlers({ ...ctx, profilePinned: true }).create({ draft, color: null, agent: null }), /command line/);
});

test('Remove stops the bot, keeps a checked backup without tokens, then moves the folder to the Trash; the order closes up', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  const scout = f.profile('scout');
  const atlas = f.profile('atlas');
  writeFileSync(join(scout, 'knowledge', 'scout-pricing.md'), '# Pricing\n');
  mkdirSync(join(scout, 'releases', 'r1'), { recursive: true });
  writeFileSync(join(scout, 'releases', 'r1', 'big.js'), 'code');
  const ctx = f.context(saitama);
  const profiles = f.handlers(ctx);
  await profiles.move('local/atlas', 2);

  const { backup, view: after } = await profiles.remove('local/scout');
  assert.deepEqual(f.stopped, ['dev.serra.scout']);
  assert.equal(backup, join(f.root, 'backups', 'scout@2026-11-28'));
  // The backup has the knowledge, a manifest every file matches, and no tokens or bot code.
  assert.equal(readFileSync(join(backup, 'knowledge', 'scout-pricing.md'), 'utf8'), '# Pricing\n');
  const manifest = readFileSync(join(backup, MANIFEST_FILE), 'utf8').trim().split('\n');
  for (const line of manifest) {
    const [hash, file] = [line.slice(0, 64), line.slice(66)];
    assert.equal(createHash('sha256').update(readFileSync(join(backup, file))).digest('hex'), hash, file);
  }
  assert.equal(existsSync(join(backup, '.env')), false);
  assert.equal(existsSync(join(backup, 'releases')), false);
  assert.match(readFileSync(join(backup, 'removed.json'), 'utf8'), /"name": "Scout"/);
  // The folder and its service went to the Trash, not deleted.
  assert.equal(existsSync(scout), false);
  assert.equal(existsSync(join(f.trash, 'scout', 'knowledge', 'scout-pricing.md')), true);
  assert.equal(existsSync(join(f.trash, 'dev.serra.scout.plist')), true);
  assert.equal(existsSync(join(f.agents, 'dev.serra.scout.plist')), false);
  // ⌘ numbers close up, colours stay put; the backups folder is never listed as a profile.
  assert.deepEqual(profileRows(after, null).map((row) => [row.name, row.shortcut, row.color]), [['Saitama', '⌘1', PROFILE_COLORS[1]], ['Atlas', '⌘2', PROFILE_COLORS[0]]]);
  assert.equal(ctx.prefs.get().profileDir, saitama);
  // Show opens the backup in Finder, and nothing outside the backups folder.
  await profiles.showBackup(backup);
  assert.deepEqual(ctx.opened, [backup]);
  await assert.rejects(async () => profiles.showBackup(saitama), /isn’t a Serra backup/);

  // Removing the profile in use moves the window to the next one.
  await profiles.remove('local/saitama');
  assert.equal(ctx.prefs.get().profileDir, atlas);
  assert.equal(existsSync(join(f.root, 'backups', 'saitama@2026-11-28')), true);
});

test('Remove saves nothing away when the backup can’t be made, and leaves the profile where it was', async (t) => {
  const f = fixture(t);
  const saitama = f.profile('saitama');
  const scout = f.profile('scout');
  // A file where the backups folder should be: the copy can't start.
  writeFileSync(join(f.root, 'backups'), 'not a folder');
  const profiles = f.handlers(f.context(saitama));
  await assert.rejects(async () => profiles.remove('local/scout'));
  assert.equal(existsSync(join(scout, 'profile.json')), true);
  assert.equal(readdirSync(f.trash).length, 0);
  // Without a Trash (a test, a smoke run), nothing is removed at all.
  await assert.rejects(async () => f.handlers(f.context(saitama, { trashItem: undefined })).remove('local/scout'), /Trash/);
});
