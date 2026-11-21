import assert from 'node:assert/strict';
import test from 'node:test';
import { ABOUT_MAX_CHARS, compileAboutMe, filterIndex, mayUse, pageAudience } from '../src/owner-model.ts';
import { frontmatter } from '../src/knowledge-rules.ts';

const page = (path: string, { type = 'preference', audience, verified = '2026-11-02', expires }: { type?: string; audience?: string; verified?: string; expires?: string }, body: string) => ({
  path,
  text: `---\ntype: ${type}\ndescription: x\n${audience ? `audience: ${audience}\n` : ''}written: 2026-11-01\nverified: ${verified}\n${expires ? `expires: ${expires}\n` : ''}sources:\n  - Owner interview, 2026-11-01\n---\n${body}\n`,
});
const NOW = new Date('2026-11-21T10:00:00Z');

test('a page without an audience is the owner\'s only; team pages reach teammates, external pages reach everyone', () => {
  assert.equal(pageAudience(frontmatter(page('a.md', {}, 'x').text)), 'owner');
  assert.equal(pageAudience(frontmatter(page('a.md', { audience: 'everyone' }, 'x').text)), 'owner', 'an unknown value is the narrowest');
  assert.deepEqual(['owner', 'team', 'external'].map((audience) => mayUse(audience as never, 'team')), [false, true, true]);
  assert.deepEqual(['owner', 'team', 'external'].map((audience) => mayUse(audience as never, 'external')), [false, false, true]);
  assert.deepEqual(['owner', 'team', 'external'].map((audience) => mayUse(audience as never, 'owner')), [true, true, true]);
});

test('About me: verified owner pages this audience may hear, who they are first, without replaced or expired text', () => {
  const pages = [
    page('owner/voice.md', { type: 'preference', audience: 'team' }, '- No exclamation marks.'),
    page('owner/role.md', { type: 'responsibility', audience: 'team' }, '- Staff engineer.'),
    page('owner/working-style.md', { audience: 'team' }, '- Ship on Tuesday.\n\n## Replaced\n\n- Ship on Thursday. Stopped 2026-11-14.'),
    page('owner/private.md', {}, '- Priya moves in January.'),
    page('owner/draft.md', { audience: 'team', verified: 'no' }, '- Unconfirmed.'),
    page('owner/q3.md', { audience: 'team', expires: '2026-10-01' }, '- Old priority.'),
    page('product/api.md', { audience: 'team' }, '- Not about the owner.'),
  ];
  const team = compileAboutMe(pages, 'team', NOW);
  assert.deepEqual(team.included, ['owner/role.md', 'owner/working-style.md', 'owner/voice.md']);
  assert.doesNotMatch(team.text, /Thursday|Priya|Unconfirmed|Old priority|Not about the owner/);
  assert.deepEqual(team.left.map(({ path, reason }) => `${path}: ${reason}`), [
    'owner/draft.md: not verified yet', 'owner/private.md: only for you', 'owner/q3.md: expired 2026-10-01',
  ]);
  assert.match(compileAboutMe(pages, 'owner', NOW).text, /Priya moves in January/);
});

test('About me is cut at whole pages to its size, keeping the most important', () => {
  const long = '- '.concat('x'.repeat(ABOUT_MAX_CHARS - 200));
  const about = compileAboutMe([
    page('owner/role.md', { type: 'responsibility', audience: 'team' }, long),
    page('owner/voice.md', { audience: 'team' }, '- No exclamation marks.\n'.repeat(20)),
  ], 'team', NOW);
  assert.deepEqual(about.included, ['owner/role.md']);
  assert.deepEqual(about.left, [{ path: 'owner/voice.md', reason: 'over the size limit' }]);
  assert.ok(about.chars <= ABOUT_MAX_CHARS);
});

test('a non-owner index is rebuilt from approved page descriptions, fails closed, and copies nothing the owner wrote around it', () => {
  const index = '# Knowledge index\n\nPrivate note: Priya moves in January.\n\n| When | Open | Gives |\n|---|---|---|\n| a | `owner/role.md` | old row text about the reorg |\n| b | `owner/private.md` | p |\n| c | `gone.md` | g |\n| d | owner/plain.md | no backticks |';
  const pages: Record<string, { audience: 'owner' | 'team'; description: string }> = {
    'owner/role.md': { audience: 'team', description: "Robin's role" }, 'owner/private.md': { audience: 'owner', description: 'Private notes' },
  };
  const team = filterIndex(index, (path) => pages[path] ?? null, 'team');
  assert.match(team, /\| `owner\/role\.md` \| Robin's role \|/);
  assert.doesNotMatch(team, /reorg|Private note|owner\/private\.md|gone\.md|no backticks|\| When \| Open \| Gives \|/);
  assert.equal(filterIndex(index, (path) => pages[path] ?? null, 'owner'), index, 'the owner gets the whole index');
});

test('a teammate gets a private-topics rule that names nothing when an off-limits page is the owner\'s only', () => {
  const role = page('owner/role.md', { type: 'responsibility', audience: 'team' }, '- Engineering manager.');
  const ownerOnly = compileAboutMe([page('owner/offlimits.md', {}, '- Never discuss Priya\'s salary band.'), role], 'team', NOW);
  assert.equal(ownerOnly.included[0], 'private topics');
  assert.match(ownerOnly.text, /pay, promotion, hiring/);
  assert.doesNotMatch(ownerOnly.text, /Priya|salary band/);
  const shared = compileAboutMe([page('owner/offlimits.md', { audience: 'team' }, '- Never discuss pay.'), role], 'team', NOW);
  assert.ok(!shared.included.includes('private topics'), 'a shared off-limits page speaks for itself');
  assert.ok(!compileAboutMe([page('owner/offlimits.md', {}, '- x'), role], 'owner', NOW).included.includes('private topics'));
});

test('outsiders get a rule that names no internal topic, and off-limits pages only when marked for them', () => {
  const pages = [
    page('owner/offlimits.md', { audience: 'team' }, '- Don\'t comment on the reorg.'),
    page('owner/role.md', { type: 'responsibility', audience: 'team' }, '- Engineering manager.'),
  ];
  const outside = compileAboutMe(pages, 'external', NOW);
  assert.deepEqual(outside.included, ['outsiders']);
  assert.match(outside.text, /Never promise or confirm a date/);
  assert.doesNotMatch(outside.text, /reorg/);
  const marked = compileAboutMe([page('owner/offlimits.md', { audience: 'external' }, '- Never confirm a launch date to a partner.')], 'external', NOW);
  assert.deepEqual(marked.included, ['outsiders', 'owner/offlimits.md']);
  assert.match(compileAboutMe(pages, 'team', NOW).text, /^From owner\/offlimits\.md[\s\S]*reorg/, 'teammates get the page itself, first');
});

test('the people roster skips expired cards and never takes a line from replaced text', () => {
  const card = (path: string, fields: { expires?: string }, body: string) => page(path, { type: 'person', audience: 'team', ...fields }, body);
  const about = compileAboutMe([
    card('people/ana.md', { expires: '2026-01-01' }, '# Ana Ruiz\n\n- Left the team.'),
    card('people/ben.md', {}, '# Ben Ode\n\n## Replaced\n\n- Old role: release manager.\n\n## Now\n\n- Design lead.'),
  ], 'team', NOW);
  assert.doesNotMatch(about.text, /Ana Ruiz/);
  assert.match(about.text, /Ben Ode: Design lead/);
  assert.doesNotMatch(about.text, /release manager/);
});

test('off-limits pages from before the cap share one budget in About me, and what\'s cut is listed', () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `- Rule ${i}: never discuss this topic with anyone at all.`).join('\n');
  const about = compileAboutMe([
    page('owner/offlimits-a.md', { type: 'offlimits' }, long(30)),
    page('owner/offlimits-b.md', { type: 'offlimits' }, long(30)),
    page('owner/offlimits-c.md', { type: 'offlimits' }, long(30)),
  ], 'owner', NOW);
  assert.ok(about.chars <= ABOUT_MAX_CHARS, `About me is ${about.chars} characters`);
  assert.ok(about.left.some((item) => /over 1500 characters together/.test(item.reason)));
});
