// SERRA-93: Knowledge › Graph's screen logic. What replays, where the arrow keys go, where names fit, and the islands.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeGraphFixture } from '../app/main/graph-fixture.ts';
import { growthPlan, nextInDirection, placeLabel, replayMs, startPage, toCanvasGraph, type Box } from '../app/renderer/screens/graph/graph.logic.ts';
import { createSim, islandAnchors, islandSim, shoresOf } from '../app/renderer/screens/graph/layout.logic.ts';
import { knowledgeGraph } from '../src/knowledge-overview.ts';

const NOW = new Date('2026-11-26T12:00:00Z');
const fixture = (size?: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-graph-screen-'));
  writeGraphFixture(dir, { now: NOW, ...(size ? { size } : {}) });
  return toCanvasGraph(knowledgeGraph({ knowledgeDir: join(dir, 'knowledge'), profileDir: dir, now: NOW }));
};

test('first open replays every page in the order it was written, spaced by date', () => {
  const nodes = [{ id: 'c.md', written: '2026-03-01' }, { id: 'a.md', written: '2026-01-01' }, { id: 'b.md', written: null }, { id: 'd.md', written: '2026-02-01' }];
  const plan = growthPlan(nodes, null, false);
  assert.equal(plan.mode, 'all');
  assert.deepEqual(plan.order.map((i) => nodes[i]!.id), ['b.md', 'a.md', 'd.md', 'c.md'], 'undated pages came first');
  assert.equal(plan.at[1], 0);
  assert.equal(plan.at[0], 1);
  assert.ok(plan.at[3]! > 0.5 && plan.at[3]! < 0.55, 'February sits about halfway between January and March');
});

test('a later visit replays only the pages new since, beside the ones already there', () => {
  const nodes = [{ id: 'a.md', written: '2026-01-01' }, { id: 'b.md', written: '2026-02-01' }, { id: 'c.md', written: '2026-03-01' }];
  const plan = growthPlan(nodes, ['a.md', 'c.md'], false);
  assert.equal(plan.mode, 'new');
  assert.deepEqual([...plan.at], [-1, 1, -1]);
  assert.deepEqual(plan.order.map((i) => nodes[i]!.id), ['a.md', 'c.md', 'b.md']);
  assert.ok(replayMs(plan, 1) <= 4000, 'a few new pages play quickly');
  assert.equal(growthPlan(nodes, ['a.md', 'b.md', 'c.md'], false).mode, 'none', 'nothing new: the map, at rest');
});

test('reduced motion never replays: the finished map shows at once', () => {
  const plan = growthPlan([{ id: 'a.md', written: '2026-01-01' }], null, true);
  assert.equal(plan.mode, 'none');
  assert.deepEqual([...plan.at], [-1]);
});

test('arrow keys move to the nearest page that way, and start from the most used page', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 5 }, { x: 40, y: -60 }, { x: -80, y: 0 }, { x: 30, y: 90 }];
  assert.equal(nextInDirection(points, 0, 'right'), 1);
  assert.equal(nextInDirection(points, 0, 'up'), 2);
  assert.equal(nextInDirection(points, 0, 'left'), 3);
  assert.equal(nextInDirection(points, 0, 'down'), 4);
  assert.equal(nextInDirection(points, 3, 'left'), null, 'nothing further left');
  assert.equal(nextInDirection(points, 0, 'right', (i) => i !== 1), 2, 'a page not shown yet is skipped for the next one that way');
  assert.equal(startPage([{ uses: 2 }, { uses: 9 }, { uses: 4 }]), 1);
});

test('a name goes below its dot, or above, or beside it, wherever it covers no other name or dot', () => {
  const below = placeLabel(100, 100, 5, 40, 14, [], []);
  assert.deepEqual(below, [80, 108, 120, 122]);
  const above = placeLabel(100, 100, 5, 40, 14, [below!], []);
  assert.ok(above && above[3] <= 95, 'above when the spot below is taken');
  const dot: Box = [95, 82, 105, 92];
  const beside = placeLabel(100, 100, 5, 40, 14, [below!], [dot]);
  assert.ok(beside && beside[0] > 105, 'to the right when a dot sits above');
  assert.equal(placeLabel(100, 100, 5, 40, 14, [[0, 0, 300, 300]], []), null, 'nowhere free: left out, never drawn over');
});

test('the islands sit apart, one per area, and each page settles on its own island', () => {
  const graph = fixture();
  const { centres } = islandAnchors(graph);
  const list = [...centres.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    assert.ok(Math.hypot(list[i]!.x - list[j]!.x, list[i]!.y - list[j]!.y) > list[i]!.r + list[j]!.r);
  }
  const { sim, centres: placed } = islandSim(graph);
  sim.settle();
  graph.nodes.forEach((node, i) => {
    const centre = placed.get(node.area)!;
    assert.ok(Math.hypot(sim.x[i]! - centre.x, sim.y[i]! - centre.y) <= centre.r + 1e-3, `${node.id} stays on ${node.area}`);
  });
  const shores = shoresOf(graph, sim, placed);
  assert.deepEqual(shores.map((shore) => shore.count), graph.areas.map(({ area }) => graph.nodes.filter((node) => node.area === area).length));
});

test('an area with no page yet keeps a small, empty island', () => {
  const graph = { ...fixture(), nodes: [], edges: [], neighbours: [], conflicts: [] };
  const { sim, centres } = islandSim(graph);
  const shores = shoresOf(graph, sim, centres);
  assert.equal(shores.length, 7);
  assert.ok(shores.every((shore) => shore.count === 0 && shore.r > 0));
});

test('800 pages lay out in well under a second, with nothing left unplaced', () => {
  const graph = fixture(800);
  assert.equal(graph.nodes.length, 800);
  const started = performance.now();
  const { sim } = islandSim(graph);
  sim.settle();
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  for (let i = 0; i < 800; i++) assert.ok(Number.isFinite(sim.x[i]!) && Number.isFinite(sim.y[i]!));
  // The same simulation without islands still settles (used on its own nowhere else, kept honest here).
  const free = createSim(graph);
  free.settle();
  assert.ok(free.alpha < 0.01);
});
