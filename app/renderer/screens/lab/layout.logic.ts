// Graph lab layouts (SERRA-93, prototype): a small force simulation, the radial (orbit) layout and the islands'
// anchors. No library: links pull, nearby nodes push apart (a grid keeps that linear, so 1000 nodes stay cheap),
// and a weak pull keeps everything near its anchor. Pure: no React, Electron or Node values.
import { AREA_ORDER, type Area, type EdgeKind, type KbGraph } from './kbGraph.logic.ts';

export interface Point { x: number; y: number }

export interface SimOptions {
  /** Rest length of a link. */
  link?: number;
  /** How hard nearby nodes push apart. */
  charge?: number;
  /** How hard each node is pulled to its anchor (the origin when there is none). */
  gravity?: number;
  /** Per-node anchors: the islands view pulls each area to its own place. */
  anchors?: Point[];
  /** Link strength by kind; a cross-area link in the islands view is weaker. */
  strength?: (kind: EdgeKind, sameAnchor: boolean) => number;
  seedPositions?: Point[];
}

export interface Sim {
  x: Float32Array;
  y: Float32Array;
  /** Cools from 1 to 0; under 0.005 the layout has settled. */
  alpha: number;
  step(): void;
  /** Run until settled (or `max` steps): the reduced-motion and first-paint path. */
  settle(max?: number): void;
  /** Warm it up again after a drag. */
  reheat(alpha?: number): void;
  /** Hold a node at a point (a drag), or let it go with null. */
  pin(index: number, at: Point | null): void;
  /** Nodes taking part (the growth view adds them as they are written); null: all. */
  active: Uint8Array | null;
}

const ALPHA_MIN = 0.005;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);

export const createSim = (graph: KbGraph, options: SimOptions = {}): Sim => {
  const n = graph.nodes.length;
  const link = options.link ?? 34;
  const charge = options.charge ?? 420;
  const gravity = options.gravity ?? 0.02;
  const cutoff = link * 5;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const pinned = new Int8Array(n);
  const degree = graph.neighbours.map((list) => Math.max(1, list.length));
  // Sunflower start, like d3: even spread, no overlaps, deterministic.
  for (let i = 0; i < n; i++) {
    const seed = options.seedPositions?.[i];
    if (seed) { x[i] = seed.x; y[i] = seed.y; continue; }
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
        if (pinned[i]) { vx[i] = 0; vy[i] = 0; continue; }
        vx[i] = vx[i]! * 0.6; vy[i] = vy[i]! * 0.6;
        x[i] = x[i]! + vx[i]!; y[i] = y[i]! + vy[i]!;
      }
      sim.alpha += (0 - sim.alpha) * ALPHA_DECAY;
    },
    settle(max = 400) {
      for (let s = 0; s < max && sim.alpha > ALPHA_MIN; s++) sim.step();
    },
    reheat(alpha = 0.3) { sim.alpha = Math.max(sim.alpha, alpha); },
    pin(index, at) {
      if (at) { pinned[index] = 1; x[index] = at.x; y[index] = at.y; } else pinned[index] = 0;
    },
  };
  return sim;
};

/** Where each area's island sits: round a circle, each given room for its size. */
export const islandAnchors = (graph: KbGraph, spacing = 30): { anchors: Point[]; centres: Map<Area, Point & { r: number }> } => {
  const counts = new Map<Area, number>(AREA_ORDER.map((area) => [area, 0]));
  for (const node of graph.nodes) counts.set(node.area, (counts.get(node.area) ?? 0) + 1);
  const areas = AREA_ORDER.filter((area) => (counts.get(area) ?? 0) > 0);
  const radius = (area: Area): number => spacing * (0.9 + Math.sqrt(counts.get(area) ?? 0) * 0.78);
  const gap = spacing * 2.2;
  const circumference = areas.reduce((sum, area) => sum + 2 * radius(area) + gap, 0);
  const ring = Math.max((circumference / (2 * Math.PI)) * 1.12, radius(areas[0] ?? 'rules') * 1.5);
  const centres = new Map<Area, Point & { r: number }>();
  let walked = 0;
  for (const area of areas) {
    const r = radius(area);
    const angle = ((walked + r) / circumference) * Math.PI * 2 - Math.PI / 2;
    centres.set(area, { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring, r });
    walked += 2 * r + gap;
  }
  return { anchors: graph.nodes.map((node) => centres.get(node.area)!), centres };
};

export interface Radial {
  /** Target position per node; null for nodes more than two links away (not drawn). */
  at: (Point | null)[];
  /** 0 the centre, 1 and 2 the rings, -1 hidden. */
  depth: Int8Array;
  rings: number[];
  /** Nodes further than two links away. */
  beyond: number;
}

/**
 * The orbit view: the centre page, the pages it links to on the first ring, theirs on the second. Each first-ring
 * page gets a slice of the circle sized to its own children, and they sit inside it, so lines barely cross.
 */
export const radialLayout = (graph: KbGraph, centre: number, ring = 150): Radial => {
  const n = graph.nodes.length;
  const depth = new Int8Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  depth[centre] = 0;
  const first = [...graph.neighbours[centre]!].sort((a, b) =>
    graph.nodes[a]!.area.localeCompare(graph.nodes[b]!.area) || graph.nodes[a]!.label.localeCompare(graph.nodes[b]!.label));
  for (const i of first) depth[i] = 1;
  const children = new Map<number, number[]>(first.map((i) => [i, []]));
  for (const i of first) {
    for (const j of graph.neighbours[i]!) {
      if (depth[j] !== -1) continue;
      depth[j] = 2;
      parent[j] = i;
      children.get(i)!.push(j);
    }
  }
  const at: (Point | null)[] = new Array<Point | null>(n).fill(null);
  at[centre] = { x: 0, y: 0 };
  const second = first.reduce((sum, i) => sum + children.get(i)!.length, 0);
  const outer = ring * (second > 60 ? 2.6 : 2);
  const weight = (i: number): number => 1 + children.get(i)!.length;
  const total = first.reduce((sum, i) => sum + weight(i), 0);
  let walked = 0;
  for (const i of first) {
    const span = (weight(i) / total) * Math.PI * 2;
    const middle = walked + span / 2 - Math.PI / 2;
    at[i] = { x: Math.cos(middle) * ring, y: Math.sin(middle) * ring };
    const kids = children.get(i)!;
    kids.forEach((j, k) => {
      const angle = walked + ((k + 0.5) / kids.length) * span - Math.PI / 2;
      // Alternate two radii when a slice is crowded, so labels don't sit on each other.
      const r = outer + (kids.length > 6 && k % 2 ? ring * 0.35 : 0);
      at[j] = { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    });
    walked += span;
  }
  let beyond = 0;
  for (let i = 0; i < n; i++) if (depth[i] === -1) beyond += 1;
  return { at, depth, rings: second > 0 ? [ring, outer] : [ring], beyond };
};

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

/** Ease-out cubic, for tweens. */
export const ease = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
