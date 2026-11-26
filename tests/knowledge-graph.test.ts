// SERRA-93: Knowledge › Graph's backend. The pages the bot reads, linked by what Serra's own files say.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeGraphFixture } from '../app/main/graph-fixture.ts';
import { buildKnowledgeGraph } from '../src/knowledge-graph.ts';
import { createJournal } from '../src/knowledge-journal.ts';
import { knowledgeGraph } from '../src/knowledge-overview.ts';

const NOW = new Date('2026-11-26T12:00:00Z');

const page = (fields: Record<string, string | string[]>, body: string): string => ['---', ...Object.entries(fields).flatMap(([key, value]) =>
  (Array.isArray(value) ? [`${key}:`, ...value.map((item) => `  - ${item}`)] : [`${key}: ${value}`])), '---', '', body, ''].join('\n');

const profile = (): string => mkdtempSync(join(tmpdir(), 'serra-graph-'));

const kinds = (graph: ReturnType<typeof buildKnowledgeGraph>, a: string, b: string): string | undefined => {
  const at = (path: string): number => graph.pages.findIndex((item) => item.path === path);
  const [x, y] = [at(a), at(b)].sort((p, q) => p - q);
  return graph.links.find((link) => link.a === x && link.b === y)?.kind;
};

test('links pages a page names, by path or by a person\'s name, and pages from the same source', () => {
  const graph = buildKnowledgeGraph({
    now: NOW,
    files: [
      { path: 'index.md', text: '# Knowledge index\n' },
      { path: 'people/ana-silva.md', text: page({ type: 'person', description: 'Who Ana is', written: '2026-10-01', sources: ['Meeting: launch sync'] }, '# Ana Silva\n\n- Product manager.') },
      { path: 'owner/releases.md', text: page({ type: 'preference', description: 'When releases ship', written: '2026-10-02', sources: ['Meeting: launch sync'] }, '# Release days\n\n- Ask Ana before a launch.') },
      { path: 'workflows/deploy.md', text: page({ type: 'workflow', description: 'How deploys go', written: '2026-10-03' }, '# Deploys\n\n- Follow [the release days](../owner/releases.md).') },
      { path: 'product/billing.md', text: page({ type: 'project', description: 'Billing', written: '2026-10-04' }, '# Billing\n\n- Nothing about Anastasia here.') },
    ],
  });
  assert.deepEqual(graph.pages.map((item) => item.path), ['owner/releases.md', 'people/ana-silva.md', 'product/billing.md', 'workflows/deploy.md']);
  assert.equal(kinds(graph, 'owner/releases.md', 'people/ana-silva.md'), 'mentions', 'a person is found by first name, and a mention outranks a shared source');
  assert.equal(kinds(graph, 'workflows/deploy.md', 'owner/releases.md'), 'mentions', 'a relative Markdown link names the page');
  assert.equal(kinds(graph, 'product/billing.md', 'people/ana-silva.md'), undefined, 'a longer word is not the name');
  assert.deepEqual(graph.pages.map((item) => item.area), ['rules', 'people', 'projects', 'processes']);
  assert.equal(graph.pages.find((item) => item.path === 'people/ana-silva.md')!.label, 'Ana Silva');
});

test('pages one reply used together are linked, and uses count only the last month', () => {
  const files = ['owner/voice.md', 'owner/slack.md'].map((path) => ({ path, text: page({ type: 'voice', description: path, written: '2026-10-01' }, `# ${path}\n\n- A rule.`) }));
  const graph = buildKnowledgeGraph({
    now: NOW, files,
    uses: [
      { at: '2026-11-20T10:00:00Z', cited: ['owner/voice.md', 'owner/slack.md'] },
      { at: '2026-11-21T10:00:00Z', cited: ['owner/voice.md'] },
      { at: '2026-08-01T10:00:00Z', cited: ['owner/slack.md'] },
    ],
  });
  assert.equal(kinds(graph, 'owner/voice.md', 'owner/slack.md'), 'cited');
  assert.deepEqual(graph.pages.map((item) => [item.path, item.uses]), [['owner/slack.md', 1], ['owner/voice.md', 2]]);
});

test('a page with no written date takes the day it was first approved', () => {
  const graph = buildKnowledgeGraph({
    now: NOW,
    files: [{ path: 'owner/notes.md', text: page({ type: 'preference', description: 'Notes' }, '# Notes\n\n- A rule.') }],
    changes: [
      { id: 'b', action: 'edit', at: '2026-10-09T10:00:00Z', files: [{ path: 'owner/notes.md', before: 'old', after: 'new' }] },
      { id: 'a', action: 'promote', at: '2026-09-14T10:00:00Z', files: [{ path: 'owner/notes.md', before: null, after: 'new' }] },
    ],
  });
  assert.equal(graph.pages[0]!.written, '2026-09-14');
});

test('the fixture profile: every page, the release-day disagreement with both rules, and every area as an island', () => {
  const dir = profile();
  const paths = writeGraphFixture(dir, { now: NOW });
  const graph = knowledgeGraph({ knowledgeDir: join(dir, 'knowledge'), profileDir: dir, now: NOW });
  assert.equal(graph.pages.length, paths.length);
  assert.deepEqual(graph.areas.map((area) => area.label), ['Who you are', 'How you work', 'How you write', 'Off-limits', 'People', 'Processes', 'Projects']);
  const releases = graph.conflicts.find((conflict) => conflict.rules.some((rule) => rule.text.includes('Tuesday')));
  assert.ok(releases, 'the Tuesday and Thursday rules disagree');
  assert.deepEqual(releases.rules.map((rule) => rule.page).sort(), ['decisions/thursday-releases.md', 'owner/releases.md']);
  assert.equal(kinds(graph, 'owner/releases.md', 'decisions/thursday-releases.md'), 'disagrees');
  for (const kind of ['mentions', 'source', 'cited', 'disagrees']) assert.ok(graph.links.some((link) => link.kind === kind), kind);
  assert.equal(graph.pages.find((item) => item.path === 'owner/voice.md')!.uses > 20, true);
});

test('reads the approved copy, like Overview: an edit made outside Serra is not on the map until it is accepted', () => {
  const dir = profile();
  const knowledge = join(dir, 'knowledge');
  mkdirSync(join(knowledge, 'owner'), { recursive: true });
  writeFileSync(join(knowledge, 'owner/role.md'), page({ type: 'role', description: 'Role', written: '2026-10-01' }, '# Role\n\n- Tech lead.'));
  createJournal(knowledge).seed();
  writeFileSync(join(knowledge, 'owner/new.md'), page({ type: 'preference', description: 'New', written: '2026-11-01' }, '# New\n\n- Added by hand.'));
  assert.deepEqual(knowledgeGraph({ knowledgeDir: knowledge, profileDir: dir, now: NOW }).pages.map((item) => item.path), ['owner/role.md']);
});

test('800 pages build in well under a second', () => {
  const dir = profile();
  writeGraphFixture(dir, { size: 800, now: NOW });
  const started = performance.now();
  const graph = knowledgeGraph({ knowledgeDir: join(dir, 'knowledge'), profileDir: dir, now: NOW });
  const ms = performance.now() - started;
  assert.equal(graph.pages.length, 800);
  assert.ok(graph.links.length > 1500, `${graph.links.length} links`);
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});
