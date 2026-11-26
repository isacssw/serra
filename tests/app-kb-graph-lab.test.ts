// Graph lab (SERRA-93, prototype): the seed graph and the layouts the four options draw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCentre, growthOrder, seedGraph } from '../app/renderer/screens/lab/kbGraph.logic.ts';
import { createSim, fitCamera, islandAnchors, radialLayout } from '../app/renderer/screens/lab/layout.logic.ts';

test('the seed is a profile a few months in, and grows to the size asked for, the same every time', () => {
  const small = seedGraph('small');
  assert.ok(small.nodes.length > 40 && small.nodes.length < 80);
  assert.ok(small.edges.some((edge) => edge.kind === 'disagrees'));
  assert.equal(seedGraph(800).nodes.length, 800);
  assert.deepEqual(seedGraph(800).edges, seedGraph(800).edges);
  for (const { a, b } of small.edges) assert.ok(small.neighbours[a]!.includes(b) && small.neighbours[b]!.includes(a));
});

test('growth plays pages in the order they were written', () => {
  const graph = seedGraph('small');
  const dates = growthOrder(graph).map((i) => graph.nodes[i]!.written);
  assert.deepEqual(dates, [...dates].sort());
});

test('the force layout settles 800 pages to finite, spread-out positions', () => {
  const graph = seedGraph(800);
  const sim = createSim(graph, { link: 24, charge: 200 });
  sim.settle();
  assert.ok(sim.alpha < 0.01);
  for (let i = 0; i < graph.nodes.length; i++) assert.ok(Number.isFinite(sim.x[i]!) && Number.isFinite(sim.y[i]!));
  const fit = fitCamera(graph.nodes.map((_, i) => ({ x: sim.x[i]!, y: sim.y[i]! })), 1200, 800);
  assert.ok(fit.k > 0.05 && fit.k < 2.5);
});

test('the orbit puts linked pages on the first ring and theirs on the second, and hides the rest', () => {
  const graph = seedGraph('small');
  const centre = defaultCentre(graph);
  const layout = radialLayout(graph, centre, 150);
  for (const i of graph.neighbours[centre]!) {
    assert.equal(layout.depth[i], 1);
    assert.ok(Math.abs(Math.hypot(layout.at[i]!.x, layout.at[i]!.y) - 150) < 1e-6);
  }
  assert.equal(layout.at.filter((at) => at === null).length, layout.beyond);
});

test('islands sit apart, one per area', () => {
  const { centres } = islandAnchors(seedGraph(800));
  const list = [...centres.values()];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    assert.ok(Math.hypot(list[i]!.x - list[j]!.x, list[i]!.y - list[j]!.y) > list[i]!.r + list[j]!.r);
  }
});
