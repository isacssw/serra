import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SerraBridge } from '../app/main/bridge.ts';
import type { HandlerContext } from '../app/main/ipc/context.ts';
import { createHandlers } from '../app/main/ipc/index.ts';
import { memoryPrefs } from '../app/main/prefs.ts';
import { stoppedStatusSource } from '../app/main/status.ts';
import { addAllowedUser, builtinActions, navigationActions, navigationButton, openProfileFolder, restartBot } from '../app/renderer/commands/builtin.ts';
import { fuzzyMatch } from '../app/renderer/commands/fuzzy.logic.ts';
import { isPaletteShortcut, moveSelection } from '../app/renderer/commands/palette.logic.ts';
import { createActionRegistry, searchActions, searchChoices, type Action, type ActionContext } from '../app/renderer/commands/registry.ts';
import { routeForPath, routes, sections } from '../app/renderer/routes.ts';
import { CLEANUP_PARAM, cleanupWorktreesAction } from '../app/renderer/screens/jobs.logic.ts';
import { PROPOSAL_PARAM, promoteProposalAction } from '../app/renderer/screens/proposals.logic.ts';
import type { Profile } from '../src/contracts.ts';

const action = (id: string, title: string, extra: Partial<Action> = {}): Action =>
  ({ id, title, group: 'Actions', button: `Somewhere › ${title}`, run: () => {}, ...extra });

const titles = (actions: readonly Action[], query: string): string[] => searchActions(actions, query).map((result) => result.action.title);

// ---------------------------------------------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------------------------------------------

test('fuzzy: letters in order match, ignoring case and spaces in the query', () => {
  assert.ok(fuzzyMatch('rst', 'Restart bot'));
  assert.ok(fuzzyMatch('RESTART', 'Restart bot'));
  assert.ok(fuzzyMatch('add user', 'Add allowed user'));
  assert.equal(fuzzyMatch('tsr', 'Restart bot'), null, 'out of order');
  assert.equal(fuzzyMatch('xyz', 'Restart bot'), null);
  assert.equal(fuzzyMatch('restart bot now', 'Restart bot'), null, 'longer than the text');
});

test('fuzzy: an empty query matches with score 0', () => {
  assert.deepEqual(fuzzyMatch('', 'Anything'), { score: 0, indices: [] });
  assert.deepEqual(fuzzyMatch('   ', 'Anything'), { score: 0, indices: [] });
});

test('fuzzy: picks word starts over the first occurrence', () => {
  assert.deepEqual(fuzzyMatch('aau', 'Add allowed user')?.indices, [0, 4, 12]);
  assert.deepEqual(fuzzyMatch('opf', 'Open profile folder')?.indices, [0, 5, 13]);
  assert.deepEqual(fuzzyMatch('tm', 'Tools (MCP)')?.indices, [0, 7]);
});

test('fuzzy: a run of letters at the start beats scattered letters', () => {
  const people = fuzzyMatch('peo', 'People');
  const folder = fuzzyMatch('peo', 'Open profile folder');
  assert.ok(people && folder);
  assert.ok(people.score > folder.score);
  assert.deepEqual(people.indices, [0, 1, 2]);
});

// ---------------------------------------------------------------------------------------------------------------
// Registry and search
// ---------------------------------------------------------------------------------------------------------------

test('search: no query lists every action, Go to before Actions, in registration order, destructive ones last', () => {
  const actions = [action('x', 'Restart bot', { destructive: true }), action('go:a', 'Jobs', { group: 'Go to' }), action('y', 'Open profile folder'), action('go:b', 'People', { group: 'Go to' })];
  assert.deepEqual(titles(actions, ''), ['Jobs', 'People', 'Open profile folder', 'Restart bot']);
});

test('search: a destructive action loses a tie, so typing never pre-selects it over a safe one', () => {
  const actions = [action('r', 'Reset bot', { destructive: true }), action('s', 'Reset filters')];
  assert.deepEqual(titles(actions, 'reset'), ['Reset filters', 'Reset bot']);
});

test('search: ranks the best match first and drops non-matches', () => {
  const actions = [action('f', 'Open profile folder'), action('p', 'People', { group: 'Go to' }), action('r', 'Restart bot')];
  assert.deepEqual(titles(actions, 'peo'), ['People', 'Open profile folder']);
  assert.deepEqual(titles(actions, 'zzz'), []);
});

test('search: keywords and the hint find an action, below a title match', () => {
  const actions = [
    action('r', 'Restart bot', { keywords: ['daemon'] }),
    action('d', 'Diagnostics', { group: 'Go to', hint: 'Settings' }),
  ];
  assert.deepEqual(titles(actions, 'daemon'), ['Restart bot']);
  const [hit] = searchActions(actions, 'daemon');
  assert.deepEqual(hit?.indices, [], 'nothing to highlight in the title');
  assert.deepEqual(titles(actions, 'settings'), ['Diagnostics']);
  const both = [action('k', 'Keychain', { group: 'Go to' }), action('s', 'Secrets', { keywords: ['keychain'] })];
  assert.deepEqual(titles(both, 'keychain'), ['Keychain', 'Secrets']);
});

test('search: choices filter by label, best first', () => {
  const choices = [{ value: '1', label: 'deploy-notes.md' }, { value: '2', label: 'release-checklist.md' }, { value: '3', label: 'oncall.md' }];
  assert.deepEqual(searchChoices(choices, 'rel').map((c) => c.value), ['2']);
  assert.deepEqual(searchChoices(choices, 'o.md').map((c) => c.value)[0], '3');
  assert.deepEqual(searchChoices(choices, '').map((c) => c.value), ['1', '2', '3']);
});

// ---------------------------------------------------------------------------------------------------------------
// Palette keyboard
// ---------------------------------------------------------------------------------------------------------------

const press = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('shortcut: ⌘K or Ctrl+K, and nothing else', () => {
  assert.equal(isPaletteShortcut(press('k', { metaKey: true })), true);
  assert.equal(isPaletteShortcut(press('K', { metaKey: true })), true, 'caps lock');
  assert.equal(isPaletteShortcut(press('k', { ctrlKey: true })), true);
  assert.equal(isPaletteShortcut(press('k')), false);
  assert.equal(isPaletteShortcut(press('k', { metaKey: true, shiftKey: true })), false);
  assert.equal(isPaletteShortcut(press('k', { metaKey: true, altKey: true })), false);
  assert.equal(isPaletteShortcut(press('k', { metaKey: true, ctrlKey: true })), false);
  assert.equal(isPaletteShortcut(press('j', { metaKey: true })), false);
});

test('selection: arrows wrap and an empty list has no selection', () => {
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 0);
  assert.equal(moveSelection(0, -1, 3), 2);
  assert.equal(moveSelection(-1, 1, 3), 0);
  assert.equal(moveSelection(-1, -1, 3), 2);
  assert.equal(moveSelection(0, 1, 0), -1);
});

// ---------------------------------------------------------------------------------------------------------------
// Built-in actions
// ---------------------------------------------------------------------------------------------------------------

test('built-ins: the spike\'s palette examples are found by what the owner would type', () => {
  const all = builtinActions;
  assert.equal(titles(all, 'restart')[0], 'Restart bot');
  assert.equal(titles(all, 'profile folder')[0], 'Open profile folder');
  assert.equal(titles(all, 'add user')[0], 'Add allowed user');
  assert.equal(titles(all, 'secrets')[0], 'Secrets');
  assert.equal(titles(all, 'needs')[0], 'Needs you');
});

const recordingContext = (bridge: Partial<{ [N in keyof SerraBridge]: Partial<SerraBridge[N]> }> | null) => {
  const navigated: string[] = [];
  const toasts: { message: string; tone?: string; action?: { label: string; onClick: () => void } }[] = [];
  const context: ActionContext = {
    bridge: bridge as SerraBridge | null,
    navigate: (path) => navigated.push(path),
    toast: (toast) => toasts.push(toast),
  };
  return { context, navigated, toasts };
};

test('built-ins: Go to navigates to the screen\'s path', async () => {
  const { context, navigated } = recordingContext(null);
  for (const nav of navigationActions) await nav.run(context);
  assert.deepEqual(navigated, routes.map((route) => route.path));
});

test('built-ins: Restart bot and Open profile folder call the bridge', async () => {
  const calls: string[] = [];
  const { context, toasts } = recordingContext({
    bot: { restart: async () => { calls.push('restart'); } },
    app: { openProfileFolder: async () => { calls.push('open'); } },
  });
  await restartBot.run(context);
  await openProfileFolder.run(context);
  assert.deepEqual(calls, ['restart', 'open']);
  assert.deepEqual(toasts.map((t) => t.message), ['Bot restarted.']);
});

test('built-ins: a bridge failure or a missing bridge rejects with a message for the palette', async () => {
  const failing = recordingContext({ bot: { restart: async () => { throw new Error("bot.restart isn't available yet (APP-11)."); } } });
  await assert.rejects(Promise.resolve(restartBot.run(failing.context)), /APP-11/);
  assert.deepEqual(failing.toasts, []);
  await assert.rejects(Promise.resolve(openProfileFolder.run(recordingContext(null).context)), /only works in the Serra app/);
});

test('built-ins: Add allowed user asks for a member ID and reports when it applies', async () => {
  assert.ok(addAllowedUser.argument);
  const added: string[] = [];
  const { context, toasts, navigated } = recordingContext({
    people: {
      add: async (id) => {
        added.push(id);
        return { slackUserId: id, changed: id !== 'U0123456789', applies: 'now' };
      },
    },
  });
  await addAllowedUser.run(context, '  U0000000001 ');
  await addAllowedUser.run(context, 'U0123456789');
  await assert.rejects(Promise.resolve(addAllowedUser.run(context, '  ')), /Enter a Slack member ID/);
  assert.deepEqual(added, ['U0000000001', 'U0123456789']);
  assert.deepEqual(toasts.map((t) => [t.message, t.tone]), [
    ['U0000000001 can now use the bot. Applies now.', 'success'],
    ['U0123456789 already has access.', 'info'],
  ]);
  toasts[0]?.action?.onClick();
  assert.deepEqual(navigated, ['/settings/people']);
});

// ---------------------------------------------------------------------------------------------------------------
// people.add handler (APP-4's addAllowedUser behind the bridge)
// ---------------------------------------------------------------------------------------------------------------

const OWNER = 'U0123456789';
const MEMBER = 'U0000000001';

const tempProfile = (t: TestContext): string => {
  const directory = mkdtempSync(join(tmpdir(), 'serra-commands-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profile: Profile = {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: OWNER, githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [],
  };
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
  return directory;
};

const handlerContext = (profileDir: string): HandlerContext => ({
  profileDir: () => profileDir,
  profileDirOrNull: () => profileDir,
  prefs: memoryPrefs(),
  status: stoppedStatusSource(),
  runtime: { version: '0.0.0', electron: '45.4.1', node: '24.0.0', platform: 'darwin' },
  openExternal: async () => {},
  openPath: async () => {},
});

test('people.add: allows a member once, applies now, and leaves the owner alone', async (t) => {
  const directory = tempProfile(t);
  const { people } = createHandlers(handlerContext(directory));
  assert.deepEqual(await people.add(` ${MEMBER} `), { slackUserId: MEMBER, changed: true, applies: 'now' });
  assert.deepEqual(await people.add(MEMBER), { slackUserId: MEMBER, changed: false, applies: 'now' });
  assert.deepEqual(await people.add(OWNER), { slackUserId: OWNER, changed: false, applies: 'now' });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'profile.json'), 'utf8')).allowedUsers, [MEMBER]);
});

test('people.add: a bad ID is refused and the file is untouched', async (t) => {
  const directory = tempProfile(t);
  const before = readFileSync(join(directory, 'profile.json'), 'utf8');
  const { people } = createHandlers(handlerContext(directory));
  assert.throws(() => people.add('alex'), /Not a Slack member ID/);
  assert.throws(() => people.add(42 as unknown as string), /Enter a Slack member ID/);
  assert.equal(readFileSync(join(directory, 'profile.json'), 'utf8'), before);
});

// ---------------------------------------------------------------------------------------------------------------
// Screen actions (QA: ⌘K found nothing for "promote" or "clean up", though the registry promises both)
// ---------------------------------------------------------------------------------------------------------------

test('the Jobs and Proposals screens add Clean up worktrees and Promote proposal… to the palette', () => {
  const registry = createActionRegistry();
  registry.register(builtinActions);
  registry.register([cleanupWorktreesAction]);
  registry.register([promoteProposalAction]);
  assert.equal(titles(registry.list(), 'clean up')[0], 'Clean up worktrees');
  assert.equal(titles(registry.list(), 'promote')[0], 'Promote proposal…');
  assert.equal(titles(registry.list(), 'worktree')[0], 'Clean up worktrees');
  for (const action of [cleanupWorktreesAction, promoteProposalAction]) assert.match(action.button, /›/, 'each is also a button');
});

test('Clean up worktrees opens the Jobs screen on its dry run', async () => {
  const navigated: string[] = [];
  await cleanupWorktreesAction.run({ bridge: null, navigate: (path) => navigated.push(path), toast: () => {} });
  assert.deepEqual(navigated, [`/jobs/needs-you?${CLEANUP_PARAM}=1`]);
});

test('Promote proposal… lists the waiting proposals and opens the picked one on Proposals, without promoting it', async () => {
  const calls: string[] = [];
  const bridge = { proposals: {
    list: async () => [
      { path: '2026-11-19-oncall.md', date: '2026-11-19', target: null },
      { path: 'team/2026-11-18-reviews.md', date: '2026-11-18', target: 'owner/role.md' },
    ],
    promote: async () => { calls.push('promote'); return { undoId: 'x' }; },
  } } as unknown as SerraBridge;
  const navigated: string[] = [];
  const context: ActionContext = { bridge, navigate: (path) => navigated.push(path), toast: () => {} };
  const choices = await promoteProposalAction.argument!.choices!(context);
  assert.deepEqual(choices.map((choice) => [choice.label, choice.detail]), [['Oncall', 'Nov 19'], ['Reviews', 'changes owner/role.md']]);
  await promoteProposalAction.run(context, 'team/2026-11-18-reviews.md');
  assert.deepEqual(navigated, [`/knowledge/proposals?${PROPOSAL_PARAM}=team%2F2026-11-18-reviews.md`]);
  assert.deepEqual(calls, [], 'the palette opens the proposal; the owner promotes it after seeing the diff');
  assert.throws(() => promoteProposalAction.run(context, ''), /Pick a proposal/);
});

// ---------------------------------------------------------------------------------------------------------------
// What the palette lists as screens open and close
// ---------------------------------------------------------------------------------------------------------------

/** A palette as Palette.tsx sets it up: the built-ins registered, then whatever the open screens add. */
const openPalette = () => {
  const registry = createActionRegistry();
  registry.register(builtinActions);
  return { registry, listed: (query = '') => titles(registry.list(), query) };
};

test('the palette lists every screen, and picking one opens that screen and names the sidebar item it stands for', async () => {
  const { registry } = openPalette();
  for (const route of routes) {
    const found = searchActions(registry.list(), route.label).map((result) => result.action).find((a) => a.group === 'Go to' && a.title === route.label);
    assert.ok(found, `typing "${route.label}" finds the screen`);
    assert.match(found.button, /^Sidebar › /, `${route.label} names its sidebar item`);
    const { context, navigated } = recordingContext(null);
    await found.run(context);
    assert.deepEqual(navigated, [route.path]);
    assert.equal(routeForPath(navigated[0]!)?.id, route.id, `${route.label} opens its own screen, not another with the same path`);
    assert.ok(sections.some((section) => section.id === route.section), `${route.label} sits under a sidebar heading`);
  }
  assert.equal(navigationButton(routes.find((route) => route.id === 'jobs-running')!), 'Sidebar › Jobs › Running');
  // ⌘K then ↩ opens a screen; it never restarts the bot.
  const listed = searchActions(registry.list(), '').map((result) => result.action);
  assert.equal(listed[0]?.group, 'Go to');
  assert.equal(listed[0]?.title, 'Needs you');
  assert.equal(listed.at(-1)?.title, 'Restart bot');
});

test('a screen whose palette actions include a bad one adds none of them, and the palette keeps what it listed', () => {
  const { registry, listed } = openPalette();
  const before = listed();
  const batches: [batch: Action[], refusal: RegExp][] = [
    [[cleanupWorktreesAction, { ...restartBot, title: 'Restart again' }], /bot:restart is already registered/],
    [[cleanupWorktreesAction, action('jobs:x', 'No button', { button: ' ' })], /needs a button/],
    [[promoteProposalAction, action('', 'No id')], /needs a id/],
    [[promoteProposalAction, action('p:e', '')], /needs a title/],
    [[promoteProposalAction, action('p:g', 'Bad group', { group: 'Other' as 'Actions' })], /unknown group/],
    [[cleanupWorktreesAction, action('c', 'One'), action('c', 'Two')], /c is already registered/],
  ];
  for (const [batch, refusal] of batches) assert.throws(() => registry.register(batch), refusal);
  assert.deepEqual(listed(), before);
  assert.deepEqual(listed('clean up worktrees'), []);
  assert.deepEqual(listed('promote proposal'), []);
});

test('closing a screen late keeps the palette actions a newer copy of that screen added', () => {
  const { registry, listed } = openPalette();
  const closeFirst = registry.register([cleanupWorktreesAction]);
  closeFirst();
  assert.deepEqual(listed('clean up worktrees'), [], 'closing the screen takes its action away');
  // The screen opens again; then the first copy's cleanup runs a second time (a hot reload's dispose, a late unmount).
  registry.register([{ ...cleanupWorktreesAction }]);
  closeFirst();
  assert.deepEqual(listed('clean up worktrees'), ['Clean up worktrees']);
});
