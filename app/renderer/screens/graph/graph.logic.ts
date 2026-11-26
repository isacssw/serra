// Knowledge › Graph (SERRA-93): the pure half of the screen. The backend's graph as the canvas draws it, what to
// replay, which page an arrow key moves to, and where a page's name fits without covering another.
// Pure: no React, Electron or Node values.
import type { GraphArea, GraphConflict, GraphLinkKind, KnowledgeGraph } from '../../../../src/knowledge-graph.ts';

export interface GraphNode { id: string; label: string; description: string; area: GraphArea; written: string | null; uses: number }
interface GraphEdge { a: number; b: number; kind: GraphLinkKind }

export interface CanvasGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node indexes linked to each node. */
  neighbours: number[][];
  /** Every area, in order, with a page or not: an empty one is drawn as a place to grow. */
  areas: { area: GraphArea; label: string }[];
  conflicts: GraphConflict[];
}

export const toCanvasGraph = (graph: KnowledgeGraph): CanvasGraph => {
  const neighbours: number[][] = graph.pages.map(() => []);
  for (const { a, b } of graph.links) {
    if (!neighbours[a]!.includes(b)) neighbours[a]!.push(b);
    if (!neighbours[b]!.includes(a)) neighbours[b]!.push(a);
  }
  return {
    nodes: graph.pages.map((page) => ({ id: page.path, label: page.label, description: page.description, area: page.area, written: page.written, uses: page.uses })),
    edges: graph.links,
    neighbours,
    areas: graph.areas,
    conflicts: graph.conflicts,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------------------------

export interface Growth {
  /** Node indexes in the order they arrive. */
  order: number[];
  /** When each node arrives, 0 … 1 through the replay; -1: there from the start. */
  at: Float32Array;
  /** What replays: everything (first open), only the pages new since the last visit, or nothing. */
  mode: 'all' | 'new' | 'none';
}

const DAY_MS = 86_400_000;
const dayOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/**
 * What the screen replays. On first open (`seen` null) every page arrives in the order it was written, spaced by its
 * date. After that only pages not in `seen` arrive, evenly, beside the ones already there. Pages with no date came
 * first. Reduced motion replays nothing: the finished map shows at once.
 */
export const growthPlan = (nodes: readonly Pick<GraphNode, 'id' | 'written'>[], seen: readonly string[] | null, reducedMotion: boolean): Growth => {
  const order = nodes.map((_, i) => i).sort((a, b) => (nodes[a]!.written ?? '').localeCompare(nodes[b]!.written ?? '') || nodes[a]!.id.localeCompare(nodes[b]!.id));
  const at = new Float32Array(nodes.length).fill(-1);
  if (reducedMotion || nodes.length === 0) return { order, at, mode: 'none' };
  if (seen === null) {
    const dated = order.filter((i) => nodes[i]!.written !== null);
    const first = dated.length ? dayOf(nodes[dated[0]!]!.written!) : 0;
    const last = dated.length ? dayOf(nodes[dated[dated.length - 1]!]!.written!) : 0;
    order.forEach((i, k) => {
      const written = nodes[i]!.written;
      // Dates spread the replay out; a folder written in one day still plays page by page.
      at[i] = last > first && written ? (dayOf(written) - first) / (last - first) : k / Math.max(1, order.length - 1);
    });
    return { order, at, mode: 'all' };
  }
  const known = new Set(seen);
  const fresh = order.filter((i) => !known.has(nodes[i]!.id));
  if (fresh.length === 0) return { order, at, mode: 'none' };
  fresh.forEach((i, k) => { at[i] = fresh.length === 1 ? 1 : k / (fresh.length - 1); });
  return { order: [...order.filter((i) => known.has(nodes[i]!.id)), ...fresh], at, mode: 'new' };
};

/** How long a replay runs: long enough to watch, short enough not to wait for. */
export const replayMs = (growth: Growth, count: number): number =>
  growth.mode === 'new' ? Math.min(4000, 900 + count * 450) : Math.min(14_000, Math.max(5000, count * 160));

// ---------------------------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------------------------

export type Direction = 'left' | 'right' | 'up' | 'down';

const VECTORS: Record<Direction, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/**
 * The page an arrow key moves to from `from`: the nearest one that lies that way, preferring ones straight ahead.
 * Null when nothing does. `shown` filters out pages not on screen yet (a replay still running).
 */
export const nextInDirection = (points: readonly { x: number; y: number }[], from: number, direction: Direction, shown: (i: number) => boolean = () => true): number | null => {
  const [dx, dy] = VECTORS[direction];
  const origin = points[from];
  if (!origin) return null;
  let best: number | null = null;
  let bestScore = Infinity;
  points.forEach((point, i) => {
    if (i === from || !shown(i)) return;
    const x = point.x - origin.x;
    const y = point.y - origin.y;
    const ahead = x * dx + y * dy;
    if (ahead <= 0) return;
    const across = Math.abs(x * dy - y * dx);
    // Within a 60° cone counts as ahead; further off to the side costs more than distance.
    if (across > ahead * 1.8) return;
    const score = ahead + across * 2.2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
};

/** The page to start from when an arrow key is pressed with nothing selected: the most used one. */
export const startPage = (nodes: readonly Pick<GraphNode, 'uses'>[], shown: (i: number) => boolean = () => true): number | null => {
  let best: number | null = null;
  nodes.forEach((node, i) => { if (shown(i) && (best === null || node.uses > nodes[best]!.uses)) best = i; });
  return best;
};

// ---------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------

export type Box = [left: number, top: number, right: number, bottom: number];

const overlaps = (a: Box, b: Box): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * Where a name of `width` × `height` fits beside a dot at (x, y) of radius `r`: below, above, right or left, the
 * first spot that covers no name already placed (`taken`) and no other dot (`dots`, as boxes), inside `view` when
 * given. Null when none does: the name is left out rather than drawn over another or cut off at the edge.
 */
export const placeLabel = (x: number, y: number, r: number, width: number, height: number, taken: readonly Box[], dots: readonly Box[], view?: Box): Box | null => {
  const gap = 3;
  const spots: Box[] = [
    [x - width / 2, y + r + gap, x + width / 2, y + r + gap + height],
    [x - width / 2, y - r - gap - height, x + width / 2, y - r - gap],
    [x + r + gap + 1, y - height / 2, x + r + gap + 1 + width, y + height / 2],
    [x - r - gap - 1 - width, y - height / 2, x - r - gap - 1, y + height / 2],
  ];
  const inside = (spot: Box): boolean => !view || (spot[0] >= view[0] && spot[1] >= view[1] && spot[2] <= view[2] && spot[3] <= view[3]);
  return spots.find((spot) => inside(spot) && !taken.some((box) => overlaps(spot, box)) && !dots.some((box) => overlaps(spot, box))) ?? null;
};
