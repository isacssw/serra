import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  compareVersions, dmgFor, download, DownloadStalledError, fetchReleases, includePrereleases, isPrerelease, parseSums, pickUpdate, releasesUrl, verifyChecksum,
  type GithubRelease,
} from '../src/app-updates.ts';
import { createAppUpdater, installPlan, SWAP_SCRIPT, type AppUpdateView, type InstallPlan } from '../app/main/app-updater.ts';

// ---------------------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------------------

test('versions order by Semantic Versioning, prereleases included', () => {
  const ordered = [
    '0.1.0-alpha.2', '0.1.0-alpha.3', '0.1.0-alpha.10', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0-alpha.1', '0.2.0', '1.0.0',
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(compareVersions(ordered[i]!, ordered[i + 1]!) < 0, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.ok(compareVersions(ordered[i + 1]!, ordered[i]!) > 0, `${ordered[i + 1]} > ${ordered[i]}`);
  }
  assert.equal(compareVersions('v0.1.0-alpha.2', '0.1.0-alpha.2'), 0, 'a leading v is a tag, not a different version');
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0, 'build metadata is ignored');
  assert.throws(() => compareVersions('latest', '1.0.0'), /Not a version: latest/);
  assert.equal(isPrerelease('0.1.0-alpha.2'), true);
  assert.equal(isPrerelease('0.1.0'), false);
});

test('prereleases are offered while on one, unless the owner chose otherwise', () => {
  assert.equal(includePrereleases(null, '0.1.0-alpha.2'), true);
  assert.equal(includePrereleases(null, '0.1.0'), false);
  assert.equal(includePrereleases(false, '0.1.0-alpha.2'), false);
  assert.equal(includePrereleases(true, '0.1.0'), true);
});

// ---------------------------------------------------------------------------------------------------------------
// Picking a release
// ---------------------------------------------------------------------------------------------------------------

const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}`, size: 100 });
const gh = (tag: string, patch: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag, name: `Serra ${tag}`, body: `Notes for ${tag}`, draft: false, prerelease: tag.includes('-'), published_at: '2026-11-28T10:00:00Z',
  html_url: `https://github.com/acme/serra/releases/tag/${tag}`,
  assets: [asset(`Serra-${tag.slice(1)}-arm64.dmg`), asset('SHA256SUMS')], ...patch,
});

test('the newest installable release above the current one is picked; drafts and, when off, prereleases are skipped', () => {
  const releases = [gh('v0.1.0-alpha.2'), gh('v0.1.0-alpha.4'), gh('v0.1.0-alpha.3'), gh('v0.1.0-alpha.5', { draft: true }), gh('v0.0.9')];
  const pick = pickUpdate(releases, { current: '0.1.0-alpha.2', arch: 'arm64', prereleases: true });
  assert.equal(pick.kind, 'available');
  assert.ok(pick.kind === 'available');
  assert.equal(pick.release.version, '0.1.0-alpha.4');
  assert.equal(pick.release.dmg.name, 'Serra-0.1.0-alpha.4-arm64.dmg');
  assert.equal(pick.release.sums.url, 'https://example.test/SHA256SUMS');
  assert.equal(pick.release.notes, 'Notes for v0.1.0-alpha.4');
  assert.deepEqual(pickUpdate(releases, { current: '0.1.0-alpha.2', arch: 'arm64', prereleases: false }), { kind: 'up-to-date' });
  assert.deepEqual(pickUpdate(releases, { current: '0.1.0-alpha.4', arch: 'arm64', prereleases: true }), { kind: 'up-to-date' });
  // A stable release above the alphas wins when prereleases are off.
  const stable = pickUpdate([...releases, gh('v0.1.0')], { current: '0.1.0-alpha.2', arch: 'arm64', prereleases: false });
  assert.ok(stable.kind === 'available' && stable.release.version === '0.1.0' && !stable.release.prerelease);
});

test('a release without a build for this Mac or without SHA256SUMS is skipped, and named when nothing else fits', () => {
  const intelOnly = gh('v0.1.0-alpha.3', { assets: [asset('Serra-0.1.0-alpha.3.dmg'), asset('SHA256SUMS')] });
  assert.deepEqual(pickUpdate([intelOnly], { current: '0.1.0-alpha.2', arch: 'arm64', prereleases: true }), {
    kind: 'no-build', version: '0.1.0-alpha.3', url: intelOnly.html_url, reason: 'arch',
  });
  const intel = pickUpdate([intelOnly], { current: '0.1.0-alpha.2', arch: 'x64', prereleases: true });
  assert.ok(intel.kind === 'available' && intel.release.dmg.name === 'Serra-0.1.0-alpha.3.dmg');
  const unchecked = gh('v0.1.0-alpha.4', { assets: [asset('Serra-0.1.0-alpha.4-arm64.dmg')] });
  const pick = pickUpdate([unchecked, gh('v0.1.0-alpha.3')], { current: '0.1.0-alpha.2', arch: 'arm64', prereleases: true });
  assert.ok(pick.kind === 'available' && pick.release.version === '0.1.0-alpha.3', 'no checksum file, no install');
  assert.deepEqual(pickUpdate([unchecked], { current: '0.1.0-alpha.2', arch: 'arm64', prereleases: true }), {
    kind: 'no-build', version: '0.1.0-alpha.4', url: unchecked.html_url, reason: 'checksum',
  }, 'said as a missing checksum, not a missing build');
  assert.equal(dmgFor([asset('Serra-1.0.0-universal.dmg')], 'arm64')?.name, 'Serra-1.0.0-universal.dmg');
  assert.equal(dmgFor([asset('notes.txt')], 'arm64'), null);
});

test('the releases list is read from GitHub, or the QA feed', async () => {
  assert.equal(releasesUrl({}), 'https://api.github.com/repos/isacssw/serra/releases?per_page=30');
  assert.equal(releasesUrl({ SERRA_UPDATES_FEED: 'http://127.0.0.1:1/feed.json' }), 'http://127.0.0.1:1/feed.json');
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await fetchReleases(answer(200, [gh('v1.0.0')]), 'x'), [gh('v1.0.0')]);
  await assert.rejects(fetchReleases(answer(403, {}), 'x'), /limiting requests/);
  await assert.rejects(fetchReleases(answer(500, {}), 'x'), /GitHub answered 500/);
  await assert.rejects(fetchReleases(answer(200, { message: 'no' }), 'x'), /unexpected answer/);
  await assert.rejects(fetchReleases(async () => { throw new TypeError('fetch failed'); }, 'x'), /Couldn't reach GitHub/);
});

// ---------------------------------------------------------------------------------------------------------------
// Checksum and download
// ---------------------------------------------------------------------------------------------------------------

const temp = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-release-updates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

test('a download passes when it matches its SHA256SUMS line and fails when it differs or is missing', async (t) => {
  const dir = temp(t);
  const file = join(dir, 'Serra-0.1.0-alpha.3-arm64.dmg');
  writeFileSync(file, 'the real disk image');
  const sums = `${sha('the real disk image')}  Serra-0.1.0-alpha.3-arm64.dmg\n${sha('other')}  Serra-0.1.0-alpha.3.dmg\n`;
  assert.equal(parseSums(sums).size, 2);
  await verifyChecksum(file, 'Serra-0.1.0-alpha.3-arm64.dmg', sums);
  await verifyChecksum(file, 'Serra-0.1.0-alpha.3-arm64.dmg', sums.toUpperCase().replace('SERRA-0.1.0-ALPHA.3-ARM64.DMG', 'Serra-0.1.0-alpha.3-arm64.dmg'));
  writeFileSync(file, 'a tampered disk image');
  await assert.rejects(verifyChecksum(file, 'Serra-0.1.0-alpha.3-arm64.dmg', sums), /doesn't match the checksum published/);
  await assert.rejects(verifyChecksum(file, 'Serra-9.dmg', sums), /has no line for Serra-9\.dmg/);
});

/** A local HTTP server: `routes` maps a path to its body (or a status). */
const serve = async (t: TestContext, routes: Record<string, string | Buffer | number>): Promise<string> => {
  const server: Server = createServer((request, response) => {
    const route = routes[request.url ?? ''];
    if (route === undefined || typeof route === 'number') { response.writeHead(route ?? 404); response.end(); return; }
    response.writeHead(200, { 'content-length': Buffer.byteLength(route) });
    response.end(route);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
};

test('download writes the file, reports progress, and leaves nothing behind on failure', async (t) => {
  const dir = temp(t);
  const body = Buffer.alloc(300_000, 7);
  const base = await serve(t, { '/dmg': body, '/gone': 404 });
  const seen: number[] = [];
  await download(fetch, `${base}/dmg`, join(dir, 'a.dmg'), { progress: ({ received, total }) => { seen.push(received); assert.equal(total, body.length); } });
  assert.deepEqual(readFileSync(join(dir, 'a.dmg')), body);
  assert.equal(seen.at(-1), body.length);
  await assert.rejects(download(fetch, `${base}/gone`, join(dir, 'b.dmg')), /GitHub answered 404/);
  assert.equal(existsSync(join(dir, 'b.dmg')), false);
});

/** A server that sends the headers and `first` bytes of a larger file, then nothing, holding the connection open. */
const serveStalled = async (t: TestContext, first: number): Promise<string> => {
  const open: import('node:http').ServerResponse[] = [];
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': first * 10 });
    response.write(Buffer.alloc(first, 1));
    open.push(response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => { for (const response of open) response.destroy(); server.close(() => done()); }));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/dmg`;
};

test('a download that stops receiving bytes fails as stalled and leaves nothing behind', async (t) => {
  const dir = temp(t);
  const url = await serveStalled(t, 1000);
  const started = Date.now();
  await assert.rejects(download(fetch, url, join(dir, 'a.dmg'), { stallMs: 150 }), (error: Error) => {
    assert.ok(error instanceof DownloadStalledError);
    assert.match(error.message, /^No data arrived for 1 second\. Check your connection and try again\.$/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000, 'gives up soon after the stall, not at a total-time cap');
  assert.equal(existsSync(join(dir, 'a.dmg')), false);
});

test('a slow download that keeps receiving bytes is not cut off by the stall timeout', async (t) => {
  const dir = temp(t);
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': 10 });
    let sent = 0;
    const tick = setInterval(() => {
      response.write(Buffer.alloc(1, 2));
      if (++sent === 10) { clearInterval(tick); response.end(); }
    }, 40);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/dmg`;
  // 10 bytes over ~400 ms, well past the 150 ms stall limit in total, but never 150 ms without a byte.
  await download(fetch, url, join(dir, 'slow.dmg'), { stallMs: 150 });
  assert.equal(readFileSync(join(dir, 'slow.dmg')).length, 10);
});

test('cancelling a download still reports a cancel, not a stall', async (t) => {
  const dir = temp(t);
  const url = await serveStalled(t, 10);
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 50);
  await assert.rejects(download(fetch, url, join(dir, 'a.dmg'), { signal: cancel.signal, stallMs: 5_000 }), (error: Error) => !(error instanceof DownloadStalledError));
  assert.equal(existsSync(join(dir, 'a.dmg')), false);
});

// ---------------------------------------------------------------------------------------------------------------
// The app's updater
// ---------------------------------------------------------------------------------------------------------------

test('the app replaces itself only from a writable .app outside a disk image or translocation', () => {
  const yes = () => true;
  assert.deepEqual(installPlan('/Applications/Serra.app', yes), { kind: 'replace' });
  assert.deepEqual(installPlan('/Applications/Serra.app', () => false), { kind: 'installer', reason: 'Serra needs an administrator to replace itself in Applications.', folder: 'Applications' });
  assert.equal((installPlan('/Users/you/Apps/Serra.app', () => false) as { folder: string }).folder, '/Users/you/Apps');
  assert.equal(installPlan(null, yes).kind, 'installer');
  assert.match((installPlan('/Volumes/Serra/Serra.app', yes) as { reason: string }).reason, /disk image/);
  assert.match((installPlan('/private/var/folders/x/AppTranslocation/ABC/d/Serra.app', yes) as { reason: string }).reason, /temporary location/);
  assert.match((installPlan('/Applications/Serra.app', () => false) as { reason: string }).reason, /needs an administrator/);
});

const updaterFixture = async (t: TestContext, { dmgBody = 'disk image bytes', sumsBody, plan = { kind: 'replace' }, stalledDmg = false }: { dmgBody?: string; sumsBody?: string; plan?: InstallPlan; stalledDmg?: boolean } = {}) => {
  const dir = temp(t);
  const dmgName = 'Serra-0.1.0-alpha.3-arm64.dmg';
  const base = await serve(t, {
    '/dmg': dmgBody,
    '/SHA256SUMS': sumsBody ?? `${sha('disk image bytes')}  ${dmgName}\n`,
  });
  const dmgUrl = stalledDmg ? await serveStalled(t, 10) : `${base}/dmg`;
  const feed = [gh('v0.1.0-alpha.3', { assets: [{ name: dmgName, browser_download_url: dmgUrl, size: dmgBody.length }, { name: 'SHA256SUMS', browser_download_url: `${base}/SHA256SUMS`, size: 1 }] })];
  const calls: string[] = [];
  const pushed: AppUpdateView[] = [];
  let choice: boolean | null = null;
  const bundle = join(dir, 'Applications/Serra.app');
  mkdirSync(bundle, { recursive: true });
  const updater = createAppUpdater({
    current: '0.1.0-alpha.2', arch: 'arm64', unavailable: null, dir: join(dir, 'updates'),
    fetch: async (url, init) => url === 'feed' ? new Response(JSON.stringify(feed)) : fetch(url, init),
    feedUrl: 'feed', bundlePath: bundle,
    getChoice: () => choice, setChoice: (next) => { choice = next; },
    stage: async (_dmg, expected, into) => { calls.push(`stage ${expected.version} ${expected.bundleId}`); mkdirSync(into, { recursive: true }); return into; },
    plan: () => plan,
    launchSwap: (script, args) => { calls.push(`swap ${args.slice(1, 3).map((p) => p.split('/').slice(-2).join('/')).join(' ')}`); assert.equal(readFileSync(script, 'utf8'), SWAP_SCRIPT); },
    quit: () => { calls.push('quit'); },
    openPath: async (path) => { calls.push(`open ${path.split('/').pop()}`); },
    push: (view) => pushed.push(view),
    ...(stalledDmg ? { stallMs: 150 } : {}),
  });
  /** Waits for the download started by `download()` to settle. */
  const settle = async () => {
    for (let i = 0; i < 200 && ['downloading', 'verifying'].includes(updater.view().state); i++) await new Promise((done) => setTimeout(done, 10));
  };
  return { dir, updater, calls, pushed, settle, bundle };
};

test('check, download, verify and restart: the swap runs after the app quits', async (t) => {
  const f = await updaterFixture(t);
  assert.equal(f.updater.view().state, 'idle');
  const checked = await f.updater.check();
  assert.equal(checked.state, 'available');
  assert.deepEqual(checked.prereleases, { on: true, choice: null, byDefault: true });
  f.updater.download();
  await f.settle();
  const ready = f.updater.view();
  assert.equal(ready.state, 'ready');
  assert.deepEqual(f.calls, ['stage 0.1.0-alpha.3 dev.serra.app']);
  assert.ok(f.pushed.some((view) => view.state === 'downloading'), 'progress is pushed to the window');
  assert.equal((await f.updater.check()).state, 'ready', 'a verified download stays ready');
  // A lock left by a helper that died (or a reused PID waiting on another process) doesn't block the install.
  writeFileSync(join(f.dir, 'updates/swap.lock'), `${process.pid} 999999`);
  f.updater.install();
  assert.deepEqual(f.calls.slice(1), ['swap Applications/Serra.app 0.1.0-alpha.3/Serra.app', 'quit']);
  const pending = JSON.parse(readFileSync(join(f.dir, 'updates/pending.json'), 'utf8'));
  assert.deepEqual({ ...pending, release: pending.release.version }, { from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', target: f.bundle, release: '0.1.0-alpha.3' });
  // The swap is about to take the staged app: changing the channel now leaves it alone.
  assert.equal((await f.updater.setPrereleases(false)).state, 'installing');
  assert.ok(existsSync(join(f.dir, 'updates/0.1.0-alpha.3/Serra.app')));
});

test('a download that fails its checksum is deleted and nothing is staged', async (t) => {
  const f = await updaterFixture(t, { dmgBody: 'a swapped disk image' });
  await f.updater.check();
  f.updater.download();
  await f.settle();
  const failed = f.updater.view();
  assert.ok(failed.state === 'error' && failed.stage === 'verify');
  assert.match(failed.state === 'error' ? failed.message : '', /doesn't match the checksum published with the release\. The download was deleted\./);
  assert.deepEqual(f.calls, [], 'not mounted, not staged');
  assert.equal(existsSync(join(f.dir, 'updates/0.1.0-alpha.3')), false);
  f.updater.install();
  assert.deepEqual(f.calls, [], 'nothing to install');
});

test('a stalled download ends in an error the screen can retry, and its partial file is removed', async (t) => {
  const f = await updaterFixture(t, { stalledDmg: true });
  await f.updater.check();
  f.updater.download();
  await f.settle();
  const failed = f.updater.view();
  assert.ok(failed.state === 'error' && failed.stage === 'download', failed.state);
  assert.equal(failed.state === 'error' ? failed.message : '', 'The download stopped: No data arrived for 1 second. Check your connection and try again.');
  assert.equal(existsSync(join(f.dir, 'updates/0.1.0-alpha.3')), false);
  assert.deepEqual(f.calls, [], 'nothing staged');
});

test('turning prereleases off checks again and hides the alpha', async (t) => {
  const f = await updaterFixture(t);
  await f.updater.check();
  const off = await f.updater.setPrereleases(false);
  assert.equal(off.state, 'up-to-date');
  assert.deepEqual(off.prereleases, { on: false, choice: false, byDefault: true });
});

test('the first launch after a swap confirms the start for the swap script; a launch on the old version reports it did not apply', async (t) => {
  const dir = temp(t);
  const target = join(dir, 'Serra.app');
  mkdirSync(`${target}.previous`, { recursive: true });
  mkdirSync(join(dir, 'updates/0.1.0-alpha.3/Serra.app'), { recursive: true });
  const base = {
    arch: 'arm64', unavailable: null, dir: join(dir, 'updates'), fetch: async () => new Response('[]'), feedUrl: 'feed', bundlePath: target,
    getChoice: () => null, setChoice: () => {}, quit: () => {}, openPath: async () => {},
  };
  const write = () => writeFileSync(join(dir, 'updates/pending.json'), JSON.stringify({ from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', target }));
  write();
  const updated = createAppUpdater({ ...base, current: '0.1.0-alpha.3' });
  assert.equal(updated.view().updatedFrom, '0.1.0-alpha.2');
  assert.equal(existsSync(join(dir, 'updates/0.1.0-alpha.3')), false, 'leftover downloads are cleared');
  assert.equal(existsSync(join(dir, 'updates/started')), false, 'not confirmed before the window is up');
  updated.started();
  assert.equal(readFileSync(join(dir, 'updates/started'), 'utf8'), '0.1.0-alpha.3', 'the swap script may now drop the old copy');
  assert.equal(existsSync(join(dir, 'updates/pending.json')), false);
  write();
  const stuck = createAppUpdater({ ...base, current: '0.1.0-alpha.2' });
  // (No verified disk image left, so there is nothing to offer for a manual install.)
  const view = stuck.view();
  assert.ok(view.state === 'error' && view.stage === 'install');
  assert.match(view.state === 'error' ? view.message : '', /didn't finish, so Serra is still on 0\.1\.0-alpha\.2/);
  rmSync(join(dir, 'updates/started'));
  stuck.started();
  assert.equal(existsSync(join(dir, 'updates/started')), false, 'only a launch that finishes an update confirms');
});

test('when Serra could not replace itself, the verified disk image is kept and offered as the installer', async (t) => {
  const dir = temp(t);
  const target = join(dir, 'Applications/Serra.app');
  const release = {
    version: '0.1.0-alpha.3', prerelease: true, notes: '', publishedAt: null, url: 'https://example.test/r',
    dmg: { name: 'Serra-0.1.0-alpha.3-arm64.dmg', url: 'https://example.test/dmg', size: 1 }, sums: { url: 'https://example.test/s' },
  };
  mkdirSync(join(dir, 'updates/0.1.0-alpha.3'), { recursive: true });
  writeFileSync(join(dir, 'updates/0.1.0-alpha.3', release.dmg.name), 'verified');
  writeFileSync(join(dir, 'updates/swap.log'), 'Sat swap: waiting\ncouldn\'t move the old app aside\n');
  writeFileSync(join(dir, 'updates/pending.json'), JSON.stringify({ from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', target, release }));
  const opened: string[] = [];
  const updater = createAppUpdater({
    current: '0.1.0-alpha.2', arch: 'arm64', unavailable: null, dir: join(dir, 'updates'), fetch: async () => new Response('[]'), feedUrl: 'feed',
    bundlePath: target, getChoice: () => null, setChoice: () => {}, quit: () => {}, openPath: async (path) => { opened.push(path); },
  });
  const view = updater.view();
  assert.ok(view.state === 'ready' && view.install.kind === 'installer');
  assert.match(view.state === 'ready' && view.install.kind === 'installer' ? view.install.reason : '', /^Serra couldn't replace itself \(couldn't move the old app aside\)\.$/);
  await updater.openInstaller();
  assert.deepEqual(opened, [join(dir, 'updates/0.1.0-alpha.3', release.dmg.name)]);
});

test('when the new version did not start, the screen says so instead of offering to install it again', async (t) => {
  const dir = temp(t);
  const release = {
    version: '0.1.0-alpha.3', prerelease: true, notes: '', publishedAt: null, url: 'https://example.test/r',
    dmg: { name: 'Serra-0.1.0-alpha.3-arm64.dmg', url: 'https://example.test/dmg', size: 1 }, sums: { url: 'https://example.test/s' },
  };
  mkdirSync(join(dir, 'updates/0.1.0-alpha.3'), { recursive: true });
  writeFileSync(join(dir, 'updates/0.1.0-alpha.3', release.dmg.name), 'verified');
  writeFileSync(join(dir, 'updates/swap.log'), "Sat swap: the new version didn't start; restoring the old one\n");
  writeFileSync(join(dir, 'updates/pending.json'), JSON.stringify({ from: '0.1.0-alpha.2', to: '0.1.0-alpha.3', target: join(dir, 'Serra.app'), release }));
  let feed = [gh('v0.1.0-alpha.3')];
  const options = {
    current: '0.1.0-alpha.2', arch: 'arm64', unavailable: null, dir: join(dir, 'updates'), fetch: async () => new Response(JSON.stringify(feed)), feedUrl: 'feed',
    bundlePath: join(dir, 'Serra.app'), getChoice: () => null, setChoice: () => {}, quit: () => {}, openPath: async () => {},
  };
  const updater = createAppUpdater(options);
  const view = updater.view();
  assert.ok(view.state === 'error' && view.stage === 'install');
  assert.equal(view.state === 'error' ? view.message : '', "Serra 0.1.0-alpha.3 didn't start on this Mac, so Serra put 0.1.0-alpha.2 back. It isn't offered again; a newer version will be.");
  // The automatic check doesn't offer the same version again, even after the next launch.
  assert.equal((await updater.check()).state, 'error');
  assert.equal((await createAppUpdater(options).check()).state, 'error');
  // A newer release is offered, and the note is forgotten.
  feed = [gh('v0.1.0-alpha.4'), gh('v0.1.0-alpha.3')];
  const newer = await updater.check();
  assert.ok(newer.state === 'available' && newer.release.version === '0.1.0-alpha.4');
  assert.equal(existsSync(join(dir, 'updates/failed-start.json')), false);
});

test('turning pre-releases off drops a downloaded pre-release and checks again', async (t) => {
  const f = await updaterFixture(t);
  await f.updater.check();
  f.updater.download();
  await f.settle();
  assert.equal(f.updater.view().state, 'ready');
  const off = await f.updater.setPrereleases(false);
  assert.equal(off.state, 'up-to-date');
  assert.equal(existsSync(join(f.dir, 'updates/0.1.0-alpha.3')), false);
});

test('the installer plan opens the verified disk image instead of swapping', async (t) => {
  const f = await updaterFixture(t, { plan: { kind: 'installer', reason: 'Serra is running from its disk image.', folder: 'Applications' } });
  await f.updater.check();
  f.updater.download();
  await f.settle();
  assert.equal(f.updater.install().state, 'ready', 'no swap for an installer plan');
  await f.updater.openInstaller();
  assert.deepEqual(f.calls, ['stage 0.1.0-alpha.3 dev.serra.app', 'open Serra-0.1.0-alpha.3-arm64.dmg']);
});

// SERRA-61: the updater's markers are read through a guard.
test('a broken pending.json or failed-start.json is dropped at launch, never shown or compared', async (t) => {
  const dir = temp(t);
  const target = join(dir, 'Serra.app');
  mkdirSync(join(dir, 'updates'), { recursive: true });
  const logged: string[] = [];
  const launch = () => createAppUpdater({
    current: '0.1.0-alpha.2', arch: 'arm64', unavailable: null, dir: join(dir, 'updates'), fetch: async () => new Response(JSON.stringify([gh('v0.1.0-alpha.3')])), feedUrl: 'feed',
    bundlePath: target, getChoice: () => null, setChoice: () => {}, quit: () => {}, openPath: async () => {}, log: (line) => logged.push(line),
  });
  const release = { version: '0.1.0-alpha.3', prerelease: true, notes: '', publishedAt: null, url: 'u', dmg: { name: 'Serra.dmg', url: 'u', size: 1 }, sums: { url: 'u' } };
  for (const pending of ['{', JSON.stringify({ from: '0.1.0-alpha.1', to: 3, target }), JSON.stringify({ from: '0.1.0-alpha.1', to: '0.1.0-alpha.3', target, release: { ...release, dmg: null } })]) {
    writeFileSync(join(dir, 'updates/pending.json'), pending);
    logged.length = 0;
    assert.equal(launch().view().state, 'idle');
    assert.equal(existsSync(join(dir, 'updates/pending.json')), false, 'the broken marker is removed');
    assert.deepEqual(logged, ['dropped an unreadable pending.json']);
  }
  // A failed-start marker that isn't a version would make every check throw when it compares versions.
  writeFileSync(join(dir, 'updates/failed-start.json'), JSON.stringify({ version: { major: 0 }, from: '0.1.0-alpha.2' }));
  const updater = launch();
  assert.equal(updater.view().state, 'idle');
  const checked = await updater.check();
  assert.ok(checked.state === 'available' && checked.release.version === '0.1.0-alpha.3', 'the check works and offers the release');
});
