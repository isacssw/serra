import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { diagnose } from '../src/doctor.ts';
import { createKnowledge } from '../src/knowledge.ts';
import { createProfile } from '../src/setup.ts';
import { saveProblems, saveRefusal } from '../src/knowledge-rules.ts';

const NOW = new Date('2026-11-18T12:00:00Z');

/** A knowledge folder with one indexed page, and a fake `webapp` checkout and `infra` checkout. */
const fixture = (t: TestContext, page: { verified?: string; body?: string } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-knowledge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path: string, text = ''): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const header = (verified: string): string =>
    ['---', 'type: product', 'description: A page', 'written: 2026-11-16', `verified: ${verified}`, 'sources: code', '---', ''].join('\n');
  write('knowledge/index.md', '# Index\n\n| When | Open |\n|---|---|\n| always | `product/billing.md` |\n| who | `owner/role.md` |\n');
  write('knowledge/owner/role.md', header('2026-11-16'));
  write('knowledge/product/billing.md', `${header(page.verified ?? '2026-11-16')}${page.body ?? ''}\n`);
  write('webapp/apps/api/app/api/v2/src/routes/billing/index.ts');
  write('webapp/docs/testing/billing-test-plan.md');
  write('webapp/.github/workflows/e2e-billing-smoke.yaml');
  write('infra/app/models.py');
  write('infra/tests/conftest.py');
  const roots = [
    { name: 'webapp', path: join(dir, 'webapp') },
    { name: 'Infra', path: join(dir, 'infra') },
  ];
  return { ...createKnowledge(join(dir, 'knowledge')), roots };
};

test('warns about a page verified more than 60 days ago, without failing the check', (t) => {
  const old = fixture(t, { verified: '2026-09-01' }).checkKnowledge({ now: NOW });
  assert.deepEqual(old.problems, []);
  assert.equal(old.warnings.length, 1);
  assert.match(old.warnings[0]!, /^product\/billing\.md: verified 78 days ago \(2026-09-01\)/);

  assert.deepEqual(fixture(t, { verified: '2026-09-19' }).checkKnowledge({ now: NOW }).warnings, [], '60 days is still fine');
  assert.deepEqual(fixture(t, { verified: 'no' }).checkKnowledge({ now: NOW }).warnings, [], 'unverified pages are listed elsewhere');
});

test('names the missing paths and ignores everything that is not an anchored repository path', (t) => {
  const f = fixture(t, {
    body: [
      'Real: `apps/api/app/api/v2/src/routes/billing/index.ts`, `apps/api/app/api/v2/src/routes/billing/index.ts:12`, `webapp/docs/testing/billing-test-plan.md`,',
      '`webapp/docs/testing/`, `infra/app/models.py`, `app/models.py`, `Infra/app/models.py`, `.github/workflows/e2e-billing-smoke.yaml`.',
      'Missing: `apps/api/app/api/v2/src/routes/billing/gone.ts`, `webapp/docs/testing/old-plan.md`, `app/missing.py`, `.github/workflows/gone.yaml`.',
      'Not paths: `slack-pr-review`, `/api/v1/deploy`, `~/.local/bin/sentry`, `https://x.test/a/b`, `git -C a/b fetch`,',
      '`.../services/reports/`, `tests/database/billing-*.test.ts`, `TEAM-DDMM/<goal>`, `{a,b}/c`, `./local/file.ts`, `owner/role.md`.',
      'Fragments relative to a deeper folder: `services/billing/common.ts`, `tests/integration/billing/`, `app/(new)/billing/`, `src/routes/billing/index.ts`.',
      '```sh',
      'cat apps/api/fenced/`apps/api/fenced-missing.ts`',
      '```',
    ].join('\n'),
  });
  const { warnings, problems } = f.checkKnowledge({ now: NOW, roots: f.roots });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings.map((warning) => /`([^`]+)`/.exec(warning)?.[1]), [
    'apps/api/app/api/v2/src/routes/billing/gone.ts',
    'webapp/docs/testing/old-plan.md',
    'app/missing.py',
    '.github/workflows/gone.yaml',
  ]);
  assert.match(warnings[0]!, /^product\/billing\.md: names .*, which doesn't exist in webapp or Infra\.$/);
});

test('without roots, paths are not checked', (t) => {
  const report = fixture(t, { body: '`apps/api/nowhere.ts`' }).checkKnowledge({ now: NOW });
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.pages.sort(), ['owner/role.md', 'product/billing.md']);
});

// ---------------------------------------------------------------------------------------------------------------
// Pages for the app (APP-20): listPages, readPage, savePage
// ---------------------------------------------------------------------------------------------------------------

/** A profile folder with knowledge/ holding one page per badge, and an empty backups/ next to it. */
const pagesFixture = (t: TestContext) => {
  const profile = mkdtempSync(join(tmpdir(), 'bots-pages-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const knowledge = join(profile, 'knowledge');
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(knowledge, path)), { recursive: true });
    writeFileSync(join(knowledge, path), text);
  };
  const page = (verified: string, body = 'Body.\n'): string =>
    ['---', 'type: product', 'description: A page', 'written: 2026-11-01', `verified: ${verified}`, 'sources: code', '---', body].join('\n');
  write('index.md', '# Index\n\n| `owner/role.md` |\n| `product/billing.md` |\n| `product/old.md` |\n');
  write('owner/role.md', page('2026-11-16'));
  write('product/billing.md', page('no'));
  write('product/old.md', page('2026-09-01'));
  write('product/orphan.md', page('2026-11-16'));
  write('proposals/2026-11-18-new.md', page('no'));
  return { profile, knowledge, page, service: createKnowledge(knowledge) };
};

test('listPages gives each page its verified, unverified or stale badge and its own problems', (t) => {
  const { service } = pagesFixture(t);
  const pages = service.listPages({ now: NOW });
  assert.deepEqual(pages.map((page) => [page.path, page.badge, page.verified]), [
    ['owner/role.md', 'verified', '2026-11-16'],
    ['product/billing.md', 'unverified', null],
    ['product/old.md', 'stale', '2026-09-01'],
    ['product/orphan.md', 'verified', '2026-11-16'],
  ], 'proposals are not pages');
  const old = pages.find((page) => page.path === 'product/old.md')!;
  assert.match(old.warnings[0]!, /verified 78 days ago/);
  assert.deepEqual(old.problems, []);
  assert.equal(old.description, 'A page');
  assert.equal(old.type, 'product');
  assert.equal(old.written, '2026-11-01');
  assert.deepEqual(pages.find((page) => page.path === 'product/orphan.md')!.problems, ['product/orphan.md: not in index.md, so no worker will ever open it.']);
  const badgeOn = (date: string) => service.listPages({ now: new Date(`${date}T12:00:00Z`) }).find((page) => page.path === 'product/old.md')!.badge;
  assert.equal(badgeOn('2026-10-31'), 'verified', '60 days after verifying, a page is still verified');
  assert.equal(badgeOn('2026-11-01'), 'stale', 'after 60 days it is stale');
});

test('savePage writes the page, keeps a backup of the old text and returns the new badge', (t) => {
  const { profile, knowledge, page, service } = pagesFixture(t);
  const before = readFileSync(join(knowledge, 'product/billing.md'), 'utf8');
  const saved = service.savePage('product/billing.md', page('2026-11-18', 'Checked by the owner.\r\n'), { now: NOW });
  assert.equal(saved.page.badge, 'verified');
  assert.equal(saved.page.verified, '2026-11-18');
  const after = readFileSync(join(knowledge, 'product/billing.md'), 'utf8');
  assert.match(after, /verified: 2026-11-18\n/);
  assert.ok(after.endsWith('Checked by the owner.\n'), 'line endings normalized, one trailing newline');
  assert.equal(service.readPage('product/billing.md'), after);

  const backups = readdirSync(join(profile, 'backups', 'knowledge'));
  assert.deepEqual(backups, [saved.backupId]);
  const backup = JSON.parse(readFileSync(join(profile, 'backups', 'knowledge', saved.backupId!, 'change.json'), 'utf8'));
  assert.deepEqual(backup.files, [{ path: 'product/billing.md', before, after }]);
  assert.equal(backup.action, 'edit');

  const again = service.savePage('product/billing.md', after, { now: NOW });
  assert.equal(again.backupId, null, 'unchanged text writes nothing');
  assert.equal(readdirSync(join(profile, 'backups', 'knowledge')).length, 1);
});

test('savePage refuses a page over the line cap and leaves the file untouched', (t) => {
  const { profile, knowledge, page, service } = pagesFixture(t);
  const before = readFileSync(join(knowledge, 'owner/role.md'), 'utf8');
  const long = page('2026-11-16', Array.from({ length: 130 }, (_, index) => `Line ${index}`).join('\n'));
  assert.throws(() => service.savePage('owner/role.md', long, { now: NOW }), (error: Error) => {
    assert.equal(error.message, saveRefusal(saveProblems('owner/role.md', long)), 'the editor shows the same message');
    assert.match(error.message, /^Not saved\. Fix the page first:\nowner\/role\.md: 137 lines\. The cap is 120; split the page\.$/);
    return true;
  });
  assert.equal(readFileSync(join(knowledge, 'owner/role.md'), 'utf8'), before);
  assert.equal(existsSync(join(profile, 'backups')), false, 'no backup for a refused save');
});

test('savePage refuses a broken header', (t) => {
  const { knowledge, service } = pagesFixture(t);
  const before = readFileSync(join(knowledge, 'owner/role.md'), 'utf8');
  assert.throws(() => service.savePage('owner/role.md', 'No header at all.\n'), /owner\/role\.md: no header/);
  assert.throws(
    () => service.savePage('owner/role.md', before.replace('written: 2026-11-01', 'written: soon').replace('sources: code\n', '')),
    /header is missing `sources`\.\nowner\/role\.md: `written` must be a date/,
  );
  assert.throws(() => service.savePage('owner/role.md', before.replace('verified: 2026-11-16', 'verified: yes')), /`verified` must be `no` or the date/);
  assert.equal(readFileSync(join(knowledge, 'owner/role.md'), 'utf8'), before);
});

test('savePage and readPage only touch existing pages inside knowledge/', (t) => {
  const { profile, knowledge, page, service } = pagesFixture(t);
  const text = page('no');
  writeFileSync(join(profile, 'outside.md'), text);
  symlinkSync(profile, join(knowledge, 'escape'));
  for (const path of ['../outside.md', join(profile, 'outside.md'), 'escape/outside.md']) {
    assert.throws(() => service.savePage(path, text), /inside knowledge\/|outside knowledge\//, path);
    assert.throws(() => service.readPage(path), /inside knowledge\/|outside knowledge\//, path);
  }
  assert.throws(() => service.savePage('index.md', text), /not a page/);
  assert.throws(() => service.savePage('proposals/2026-11-18-new.md', text), /can't be inside proposals/);
  assert.throws(() => service.savePage('owner/new.md', text), /No page owner\/new\.md.*Proposals/);
  assert.throws(() => service.savePage('owner/role.txt', text), /must be a \.md file/);
  assert.equal(existsSync(join(knowledge, 'owner/new.md')), false);
});

/** An index of `rows` table rows under the template-like header. */
const longIndex = (rows: number): string =>
  `# Index\n\n| When | Open |\n|---|---|\n${Array.from({ length: rows }, (_, i) => `| topic ${i} | \`owner/role.md\` |`).join('\n')}\n`;

test('an index over its cap is still loaded whole, and the check still reports it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-knowledge-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'owner'), { recursive: true });
  writeFileSync(join(dir, 'owner/role.md'), ['---', 'type: role', 'description: A page', 'written: 2026-11-16', 'verified: no', 'sources: code', '---', ''].join('\n'));
  // Written outside the app, as a hand edit or a worker promoting in Slack would: 4 header lines + 70 rows.
  writeFileSync(join(dir, 'index.md'), longIndex(70));
  const service = createKnowledge(dir);

  const index = service.loadIndex();
  // Every row reaches the brief, none cut; each says its page is a draft, since owner/role.md isn't confirmed.
  assert.equal(index, longIndex(70).trim().replaceAll('`owner/role.md` |', '`owner/role.md` (draft: not confirmed) |'), 'every row reaches the brief; none is cut');
  assert.match(index, /topic 69/);

  const report = service.checkKnowledge({ now: NOW });
  assert.equal(report.indexOverCap, 'index.md: 74 lines. The cap is 60, because the index goes into every brief.');
  assert.ok(report.problems.includes(report.indexOverCap!), '`pnpm knowledge` still fails on it');

  writeFileSync(join(dir, 'index.md'), longIndex(10));
  assert.equal(service.checkKnowledge({ now: NOW }).indexOverCap, null);

  rmSync(join(dir, 'index.md'));
  assert.throws(() => service.loadIndex(), /ENOENT/, 'a missing index still stops the daemon at startup');
});

test('doctor passes the knowledge check with an over-cap index and says to tidy it, but still fails on a broken page', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-knowledge-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createProfile(dir, {
    version: 1, bot: { id: 'friday', name: 'Friday' }, owner: { name: 'Alex', slackUserId: 'U0123456789', githubLogin: 'alex' },
    project: { path: '/Users/you/project', remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' },
    allowedUsers: [], worker: { provider: 'claude', model: 'opus' },
  });
  const knowledgeCheck = async () =>
    (await diagnose(loadConfig({ profileDir: dir, env: {} }), { offline: true })).find((check) => check.name === 'Knowledge and brief')!;

  writeFileSync(join(dir, 'knowledge/index.md'), longIndex(70).replaceAll('`owner/role.md`', 'nothing'));
  const overCap = await knowledgeCheck();
  assert.equal(overCap.ok, true, overCap.detail);
  assert.match(overCap.detail, /Jobs still run, but tidy it: index\.md: 74 lines\. The cap is 60/);

  writeFileSync(join(dir, 'knowledge/owner.md'), 'No header.\n');
  const broken = await knowledgeCheck();
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /owner\.md: no header/);
  assert.doesNotMatch(broken.detail, /74 lines/, 'the index cap is not among the failures');
});
