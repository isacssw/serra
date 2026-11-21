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

test('the index keeps only rows whose page this audience may open', () => {
  const index = '# Knowledge index\n\n| When | Open | Gives |\n|---|---|---|\n| a | `owner/role.md` | r |\n| b | `owner/private.md` | p |\n| c | `gone.md` | g |';
  const audiences: Record<string, 'owner' | 'team'> = { 'owner/role.md': 'team', 'owner/private.md': 'owner' };
  const filtered = filterIndex(index, (path) => audiences[path] ?? null, 'team');
  assert.match(filtered, /owner\/role\.md/);
  assert.doesNotMatch(filtered, /owner\/private\.md/);
  assert.match(filtered, /gone\.md/, 'a row for a missing page is the knowledge check\'s to report, not hidden here');
  assert.match(filterIndex(index, (path) => audiences[path] ?? null, 'owner'), /owner\/private\.md/);
});
