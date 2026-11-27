// Knowledge › Graph layouts (SERRA-93): a small force simulation and the islands it keeps each area's pages on. No
// library: links pull, nearby pages push apart (a grid keeps that linear, so 1000 pages stay cheap), and a pull keeps
// each page near its area's island. Pure: no React, Electron or Node values.
import type { GraphArea, GraphLinkKind } from '../../../../src/knowledge-graph.ts';
import type { CanvasGraph } from './graph.logic.ts';

export interface Point { x: number; y: number }

interface SimOptions {
  /** Rest length of a link. */
  link?: number;
  /** How hard nearby nodes push apart. */
  charge?: number;
  /** How hard each node is pulled to its anchor (the origin when there is none). */
  gravity?: number;
  /** Per-node anchors: each area pulls its pages to its own island. */
  anchors?: Point[];
  /** Link strength by kind; a link across islands is weaker. */
  strength?: (kind: GraphLinkKind, sameAnchor: boolean) => number;
}

export interface Sim {
  x: Float32Array;
  y: Float32Array;
  /** Cools from 1 to 0; under 0.005 the layout has settled. */
  alpha: number;
  step(): void;
  /** Run until settled (or `max` steps): the reduced-motion and first-paint path. */
  settle(max?: number): void;
  /** Warm it up again: pages arrived. */
  reheat(alpha?: number): void;
  /** Nodes taking part (a replay adds them as they arrive); null: all. */
  active: Uint8Array | null;
}

const ALPHA_MIN = 0.005;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);

export const createSim = (graph: CanvasGraph, options: SimOptions = {}): Sim => {
  const n = graph.nodes.length;
  const link = options.link ?? 34;
  const charge = options.charge ?? 420;
  const gravity = options.gravity ?? 0.02;
  const cutoff = link * 5;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const degree = graph.neighbours.map((list) => Math.max(1, list.length));
  // Sunflower start, like d3: even spread, no overlaps, deterministic.
  for (let i = 0; i < n; i++) {
    const r = link * 0.6 * Math.sqrt(0.5 + i);
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const anchor = options.anchors?.[i];
    x[i] = (anchor?.x ?? 0) + r * Math.cos(angle) * (anchor ? 0.3 : 1);
    y[i] = (anchor?.y ?? 0) + r * Math.sin(angle) * (anchor ? 0.3 : 1);
  }
  const sameAnchor = (a: number, b: number): boolean => {
    const pa = options.anchors?.[a];
    const pb = options.anchors?.[b];
    return !pa || !pb || (pa.x === pb.x && pa.y === pb.y);
  };
  const strengths = graph.edges.map((edge) => options.strength?.(edge.kind, sameAnchor(edge.a, edge.b)) ?? 1);
  let head = new Int32Array(0);
  const next = new Int32Array(n);

  const sim: Sim = {
    x, y, alpha: 1, active: null,
    step() {
      const alpha = sim.alpha;
      const active = sim.active;
      // Links: a spring to the rest length, the lighter end moving more.
      graph.edges.forEach((edge, e) => {
        const { a, b } = edge;
        if (active && (!active[a] || !active[b])) return;
        let dx = x[b]! + vx[b]! - x[a]! - vx[a]!;
        let dy = y[b]! + vy[b]! - y[a]! - vy[a]!;
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const k = ((d - link) / d) * alpha * strengths[e]! / Math.min(degree[a]!, degree[b]!);
        dx *= k; dy *= k;
        const bias = degree[a]! / (degree[a]! + degree[b]!);
        vx[b] = vx[b]! - dx * bias; vy[b] = vy[b]! - dy * bias;
        vx[a] = vx[a]! + dx * (1 - bias); vy[a] = vy[a]! + dy * (1 - bias);
      });
      // Repulsion between nodes closer than the cutoff, found through a grid of cutoff-sized cells.
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        if (active && !active[i]) continue;
        if (x[i]! < minX) minX = x[i]!; if (x[i]! > maxX) maxX = x[i]!;
        if (y[i]! < minY) minY = y[i]!; if (y[i]! > maxY) maxY = y[i]!;
      }
      if (minX === Infinity) { sim.alpha += (0 - sim.alpha) * ALPHA_DECAY; return; }
      const cols = Math.min(512, Math.floor((maxX - minX) / cutoff) + 1);
      const rows = Math.min(512, Math.floor((maxY - minY) / cutoff) + 1);
      const cell = Math.max(cutoff, (maxX - minX) / cols, (maxY - minY) / rows);
      if (head.length < cols * rows) head = new Int32Array(cols * rows);
      head.fill(-1, 0, cols * rows);
      for (let i = 0; i < n; i++) {
        if (active && !active[i]) continue;
        const c = Math.min(cols - 1, Math.floor((x[i]! - minX) / cell)) + Math.min(rows - 1, Math.floor((y[i]! - minY) / cell)) * cols;
        next[i] = head[c]!;
        head[c] = i;
      }
      const cut2 = cutoff * cutoff;
      for (let i = 0; i < n; i++) {
        if (active && !active[i]) continue;
        const cx = Math.min(cols - 1, Math.floor((x[i]! - minX) / cell));
        const cy = Math.min(rows - 1, Math.floor((y[i]! - minY) / cell));
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(rows - 1, cy + 1); gy++) {
          for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
            for (let j = head[gx + gy * cols]!; j !== -1; j = next[j]!) {
              if (j <= i) continue;
              let dx = x[j]! - x[i]!;
              let dy = y[j]! - y[i]!;
              let d2 = dx * dx + dy * dy;
              if (d2 > cut2) continue;
              if (d2 < 1) { dx = (i % 7) - 3 || 1; dy = (j % 5) - 2 || 1; d2 = dx * dx + dy * dy; }
              const f = (charge * alpha) / d2;
              vx[i] = vx[i]! - dx * f / 8; vy[i] = vy[i]! - dy * f / 8;
              vx[j] = vx[j]! + dx * f / 8; vy[j] = vy[j]! + dy * f / 8;
            }
          }
        }
      }
      // Gravity to the anchor, then move with friction.
      for (let i = 0; i < n; i++) {
        if (active && !active[i]) continue;
        const anchor = options.anchors?.[i];
        vx[i] = vx[i]! + ((anchor?.x ?? 0) - x[i]!) * gravity * alpha;
        vy[i] = vy[i]! + ((anchor?.y ?? 0) - y[i]!) * gravity * alpha;
        vx[i] = vx[i]! * 0.6; vy[i] = vy[i]! * 0.6;
        x[i] = x[i]! + vx[i]!; y[i] = y[i]! + vy[i]!;
      }
      sim.alpha += (0 - sim.alpha) * ALPHA_DECAY;
    },
    settle(max = 400) {
      for (let s = 0; s < max && sim.alpha > ALPHA_MIN; s++) sim.step();
    },
    reheat(alpha = 0.3) { sim.alpha = Math.max(sim.alpha, alpha); },
  };
  return sim;
};

/**
 * Where each area's island sits: round a ring, each given room for its size. An area with no page yet keeps a small one.
 * `shape` is the view's width over its height: a wide view stretches the ring sideways (up to twice as wide), so the
 * map fills it. Stretching only moves islands further apart, never into each other.
 */
export const islandAnchors = (graph: CanvasGraph, spacing = 30, shape = 1): { anchors: Point[]; centres: Map<GraphArea, Point & { r: number }> } => {
  const stretch = Math.min(2, Math.max(1, Number.isFinite(shape) ? shape : 1));
  const counts = new Map<GraphArea, number>(graph.areas.map(({ area }) => [area, 0]));
  for (const node of graph.nodes) counts.set(node.area, (counts.get(node.area) ?? 0) + 1);
  const areas = [...counts.keys()];
  const radius = (area: GraphArea): number => spacing * (0.9 + Math.sqrt(counts.get(area) ?? 0) * 0.78);
  const gap = spacing * 2.2;
  const circumference = areas.reduce((sum, area) => sum + 2 * radius(area) + gap, 0);
  const ring = Math.max((circumference / (2 * Math.PI)) * 1.12, radius(areas[0] ?? 'rules') * 1.5);
  const centres = new Map<GraphArea, Point & { r: number }>();
  let walked = 0;
  for (const area of areas) {
    const r = radius(area);
    const angle = ((walked + r) / circumference) * Math.PI * 2 - Math.PI / 2;
    centres.set(area, { x: Math.cos(angle) * ring * stretch, y: Math.sin(angle) * ring, r });
    walked += 2 * r + gap;
  }
  return { anchors: graph.nodes.map((node) => centres.get(node.area) ?? { x: 0, y: 0 }), centres };
};

/** A simulation that keeps each page on its area's island: after every step, a page past the shore is set back on it. */
export const islandSim = (graph: CanvasGraph, shape = 1): { sim: Sim; centres: Map<GraphArea, Point & { r: number }> } => {
  const big = graph.nodes.length > 200;
  const { anchors, centres } = islandAnchors(graph, big ? 22 : 30, shape);
  const sim = createSim(graph, {
    anchors, gravity: big ? 0.025 : 0.06, link: big ? 22 : 30, charge: big ? 200 : 160,
    strength: (_kind, same) => (same ? 1 : 0.005),
  });
  const step = sim.step;
  sim.step = () => {
    step();
    graph.nodes.forEach((node, i) => {
      if (sim.active && !sim.active[i]) return;
      const centre = centres.get(node.area);
      if (!centre) return;
      const dx = sim.x[i]! - centre.x;
      const dy = sim.y[i]! - centre.y;
      const d = Math.hypot(dx, dy);
      if (d > centre.r) { sim.x[i] = centre.x + (dx / d) * centre.r; sim.y[i] = centre.y + (dy / d) * centre.r; }
    });
  };
  return { sim, centres };
};

export interface Shore { x: number; y: number; r: number; label: string; count: number }

/** Each island's shore follows its pages: the circle round the anchor that holds nearly all of them. An island with no page (yet) keeps a small empty shore. */
export const shoresOf = (graph: CanvasGraph, sim: Pick<Sim, 'x' | 'y' | 'active'>, centres: Map<GraphArea, Point & { r: number }>): Shore[] => graph.areas.flatMap(({ area, label }) => {
  const centre = centres.get(area);
  if (!centre) return [];
  const distances = graph.nodes.flatMap((node, i) => (node.area === area && (!sim.active || sim.active[i]) ? [Math.hypot(sim.x[i]! - centre.x, sim.y[i]! - centre.y)] : [])).sort((a, b) => a - b);
  const r = distances.length ? Math.max(30, (distances[Math.floor(distances.length * 0.95)] ?? 0) + 20) : 26;
  return [{ x: centre.x, y: centre.y, r, label, count: distances.length }];
});

export interface Camera { x: number; y: number; k: number }

/** The camera that fits `points` in a `width` × `height` view with `pad` pixels round them. */
export const fitCamera = (points: Point[], width: number, height: number, pad = 48, maxZoom = 2.4): Camera => {
  if (points.length === 0) return { x: 0, y: 0, k: 1 };
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const { x, y } of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const k = Math.min(maxZoom, (width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k: Math.max(0.05, k) };
};

