// How the app shows paired servers (SB-33): the server's one word, its profiles in the switcher, Settings and the
// menubar ending ` · t480`, offline as a hollow dot on all of them together, and the short copy for Forget and
// devices. Pure logic: what the owner sees, without a window.
import assert from 'node:assert/strict';
import test from 'node:test';
import { multiTrayView, rowPresence, type TrayProfile, type TrayServer } from '../app/main/tray.logic.ts';
import type { ProfilesView, ServerHealth } from '../app/main/bridge.ts';
import { presence } from '../app/renderer/presence.logic.ts';
import { othersNeedingYou, profileRows, rowLabel, showsSwitcher, windowTitle } from '../app/renderer/profiles.logic.ts';
import {
  ago, deviceLine, forgetBody, forgetToast, serverAction, serverDiagnostics, serverPresence, serverSubtitle,
} from '../app/renderer/servers.logic.ts';
import { routes } from '../app/renderer/routes.ts';
import type { BotStatus } from '../src/contracts.ts';

const up = (needsYou: number, running: number): BotStatus =>
  ({ state: 'up', pid: 1, startedAt: '2026-11-28T08:00:00.000Z', slackConnected: true, counts: { needsYou, running } }) as BotStatus;

const server = (extra: Partial<ServerHealth> = {}): ServerHealth => ({
  id: 's_7f3k2q', name: 't480', via: 'address', address: 't480:47820', state: 'up', skew: null, protocol: 1, version: null, behind: null,
  lastSeen: '2026-11-28T10:00:00.000Z', fingerprint: 'sha256 9f3c…a1',
  profiles: [{ id: 'researcher', name: 'Researcher', status: up(0, 1) }], ...extra,
});

const local = (profiles: { name: string; active?: boolean; status?: BotStatus | null }[]): ProfilesView => ({
  pinned: false,
  palette: ['#2b2b30', '#4b6a8a', '#4f55b8', '#7a5aa6'],
  profiles: profiles.map((profile, index) => ({
    ref: `local/${profile.name.toLowerCase()}`, dir: `/p/${profile.name.toLowerCase()}`, name: profile.name, color: ['#2b2b30', '#4b6a8a'][index]!,
    active: profile.active ?? index === 0, setupDone: true, status: profile.status ?? null, agent: 'T3',
  })),
});

test('a server’s word: checking, up, offline, not paired, update needed; and the one thing to do about it', () => {
  assert.deepEqual(serverPresence(server({ state: 'checking' })), { dot: 'faint', pulse: true, word: 'checking' });
  assert.deepEqual(serverPresence(server()), { dot: 'up', pulse: false, word: 'up' });
  assert.deepEqual(serverPresence(server({ state: 'offline' })), { dot: 'hollow', pulse: false, word: 'offline' });
  assert.deepEqual(serverPresence(server({ state: 'unpaired' })), { dot: 'hollow', pulse: false, word: 'not paired' });
  assert.deepEqual(serverPresence(server({ skew: 'server' })), { dot: 'warn', pulse: false, word: 'update needed' });
  assert.equal(serverAction(server()), null);
  assert.equal(serverAction(server({ state: 'offline' })), 'retry');
  assert.equal(serverAction(server({ state: 'unpaired' })), 'pair');
});

test('the line under a server: its profiles, No profiles yet, and when an offline one was last seen', () => {
  const now = new Date('2026-11-28T12:00:00.000Z');
  assert.equal(serverSubtitle(server(), now), 'Researcher');
  assert.equal(serverSubtitle(server({ profiles: [] }), now), 'No profiles yet');
  assert.equal(serverSubtitle(server({ state: 'offline' }), now), 'Researcher · last seen 2h ago');
  assert.equal(serverSubtitle(server({ state: 'unpaired' }), now), 'Pair again to reach it');
  assert.equal(ago('2026-11-28T11:59:40.000Z', now), 'just now');
  assert.equal(ago('2026-11-28T11:55:00.000Z', now), '5 min ago');
  assert.equal(ago('2026-11-25T12:00:00.000Z', now), '3 days ago');
  assert.equal(serverDiagnostics(server()), 't480:47820 · protocol 1 · sha256 9f3c…a1');
  assert.equal(serverDiagnostics(server({ via: 'ssh', address: 'you@t480', protocol: null })), 'ssh you@t480 · sha256 9f3c…a1');
});

test('devices and Forget say it in a few words, naming what they act on', () => {
  const now = new Date('2026-11-28T12:00:00.000Z');
  const device = { id: 'd_0123456789ab', name: 'Mac mini', addedAt: '2026-11-01T00:00:00.000Z', lastUsed: '2026-11-25T12:00:00.000Z', thisMac: false };
  assert.equal(deviceLine(device, now), 'last used 3 days ago');
  assert.equal(deviceLine({ ...device, thisMac: true }, now), 'this Mac');
  assert.equal(deviceLine({ ...device, lastUsed: null }, now), 'not used yet');
  assert.equal(forgetBody(server({ profiles: [{ id: 'saitama', name: 'Saitama', status: null }, { id: 'r', name: 'Researcher', status: null }] })),
    'Saitama and Researcher stay on t480 and leave this app. Nothing is deleted.');
  assert.equal(forgetBody(server()), 'Researcher stays on t480 and leaves this app. Nothing is deleted.');
  assert.equal(forgetBody(server({ profiles: [] })), 'Nothing on t480 is deleted.');
  assert.equal(forgetToast('t480', true), 't480 forgotten');
  assert.match(forgetToast('t480', false), /^t480 forgotten\. On t480, run serra server devices revoke/);
});

test('a server’s profiles follow this Mac’s in the switcher: phrase ends with the server, no ⌘ number, a free colour', () => {
  const view = local([{ name: 'Scout', status: null }]);
  // One local profile and a server without profiles is still today's window (UX rule D5).
  assert.equal(showsSwitcher(view, [server({ profiles: [] })]), false);
  assert.equal(showsSwitcher(view, [server()]), true);
  assert.equal(windowTitle(view, [server({ profiles: [] })]), 'Serra');
  assert.equal(windowTitle(view, [server()]), 'Scout — Serra');
  const rows = profileRows(view, up(0, 2), '⌘', [server()]);
  assert.deepEqual(rows.map((row) => [row.ref, row.name, row.presence.phrase, row.shortcut, row.server?.name ?? null]), [
    ['local/scout', 'Scout', '2 running', '⌘1', null],
    ['s_7f3k2q/researcher', 'Researcher', '1 running · t480', null, 't480'],
  ]);
  // Its colour is one no local profile shows.
  assert.notEqual(rows[1]!.color, rows[0]!.color);
  assert.equal(rowLabel(rows[1]!), 'Researcher, 1 running, on t480');
  // Offline: every profile of that server together (B9), as a hollow ring, never a colour.
  const offline = profileRows(view, null, '⌘', [server({ state: 'offline', profiles: [{ id: 'a', name: 'Ops', status: up(1, 0) }, { id: 'b', name: 'Nova', status: up(0, 0) }] })]);
  assert.deepEqual(offline.slice(1).map((row) => [row.presence.dot, row.presence.phrase]), [['hollow', 'offline · t480'], ['hollow', 'offline · t480']]);
  // An outdated server is amber, but it isn't a job waiting: Jobs' quiet line leaves it out.
  const skewed = profileRows(view, null, '⌘', [server({ skew: 'server' })]);
  assert.deepEqual([skewed[1]!.presence.word, skewed[1]!.presence.phrase], ['outdated', 'update needed · t480']);
  assert.deepEqual(othersNeedingYou(skewed).shown, []);
});

test('the menubar: remote rows end with their server, open its page, and offline is neutral in the icon', () => {
  const t480: TrayServer = { id: 's_7f3k2q', name: 't480', state: 'up', skew: null };
  const rows: TrayProfile[] = [
    { dir: '/p/scout', name: 'Scout', color: '#4b6a8a', setupDone: true, status: up(0, 2) },
    { dir: 's_7f3k2q/saitama', name: 'Saitama', color: '#2b2b30', setupDone: true, status: up(1, 0), server: t480 },
    { dir: 's_9zzzzz/ops', name: 'Ops', color: '#7a5aa6', setupDone: true, status: up(0, 0), server: { id: 's_9zzzzz', name: 'vps-fra', state: 'offline', skew: null } },
  ];
  const view = multiTrayView(rows);
  assert.deepEqual(view.rows.map((row) => [row.label, row.sublabel, row.avatar.dot, row.shortcut, row.serverId, row.open]), [
    ['Scout', '2 running', 'up', '⌘1', null, 'Open Scout'],
    ['Saitama', '1 needs you · t480', 'warn', null, 's_7f3k2q', 'Show on t480…'],
    ['Ops', 'offline · vps-fra', 'hollow', null, 's_9zzzzz', 'Show on vps-fra…'],
  ]);
  // A remote row has no New task, Restart or Stop yet: those need the profile opened here (phase 7).
  assert.deepEqual(view.rows.slice(1).map((row) => [row.newTask, row.restart, row.stop]), [[null, null, null], [null, null, null]]);
  assert.equal(view.icon, 'needs-you');
  // Offline alone never turns the icon red.
  assert.equal(multiTrayView([rows[0]!, rows[2]!]).icon, 'up');
});

test('the menubar and the window agree on a server profile’s dot and phrase in every server state', () => {
  const states: TrayServer['state'][] = ['checking', 'up', 'offline', 'unpaired'];
  for (const state of states) {
    for (const skew of [null, 'server', 'app'] as const) {
      for (const status of [null, up(1, 0), up(0, 3), { state: 'stopped' } as BotStatus]) {
        const mine = rowPresence(status, true, { id: 's_7f3k2q', name: 't480', state, skew });
        const window = presence(status, { server: { state, skew } });
        assert.deepEqual(mine, { dot: window.dot, phrase: window.phrase }, JSON.stringify({ state, skew, status }));
      }
    }
  }
});

test('Settings › Servers is an App setting that needs no profile', () => {
  const route = routes.find((entry) => entry.id === 'settings-servers');
  assert.deepEqual(route && [route.path, route.group, 'needs' in route], ['/settings/servers', 'App', false]);
});
