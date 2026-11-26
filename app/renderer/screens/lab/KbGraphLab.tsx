// Graph lab (SERRA-93, prototype, dev builds only): four ways to see the knowledge base as a graph, side by side, so
// the owner can pick one. Not a shipped screen: the route exists only under the Vite dev server (import.meta.env.DEV).
// Options: Web (force-directed), Orbit (radial around one page), Growth (the knowledge base growing over time),
// Islands (one island per area).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { themeStore, useTheme } from '../../theme.ts';
import { cx } from '../../ui/index.ts';
import { createController, GraphCanvas, type Controller } from './GraphCanvas.tsx';
import { AREA_NAMES, defaultCentre, growthOrder, seedGraph, type EdgeKind, type KbGraph } from './kbGraph.logic.ts';
import { createSim, ease, fitCamera, islandAnchors, radialLayout, type Point, type Sim } from './layout.logic.ts';

export type LabOption = 'web' | 'orbit' | 'growth' | 'islands';
const OPTIONS: { id: LabOption; name: string }[] = [
  { id: 'web', name: 'Web' }, { id: 'orbit', name: 'Orbit' }, { id: 'growth', name: 'Growth' }, { id: 'islands', name: 'Islands' },
];
type Size = 'small' | 800;

const KIND_NAMES: Record<EdgeKind, string> = { mentions: 'Links', source: 'Same source', cited: 'Used together', disagrees: 'Disagrees' };

const still = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const pointsOf = (sim: { x: ArrayLike<number>; y: ArrayLike<number> }, indexes: Iterable<number>): Point[] =>
  [...indexes].map((i) => ({ x: sim.x[i]!, y: sim.y[i]! }));

const all = (graph: KbGraph): number[] => graph.nodes.map((_, i) => i);

/** What the views share: the controller the canvas draws from and the selection. */
interface ViewProps {
  graph: KbGraph;
  selected: number | null;
  onSelect: (index: number | null) => void;
  controller: MutableRefObject<Controller>;
}

/** Aim the camera at `points`; `inset` keeps that many pixels at the bottom clear (the growth view's timeline). */
const fitTo = (c: Controller, points: Point[], pad = 56, inset = 0): void => {
  const fit = fitCamera(points, c.width || 800, (c.height || 600) - inset, pad);
  c.target.x = fit.x; c.target.y = fit.y + inset / 2 / fit.k; c.target.k = fit.k;
};

const focusOn = (c: Controller, at: Point): void => {
  c.target.x = at.x; c.target.y = at.y; c.target.k = Math.max(c.camera.k, 1.5);
};

// ---------------------------------------------------------------------------------------------------------------
// (a) Web: every page, pulled together by its links. Hover lights its neighbours; click focuses; drag to pull.
// ---------------------------------------------------------------------------------------------------------------

const WebView = ({ graph, selected, onSelect, controller }: ViewProps) => {
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const sim = useMemo(() => {
    const made = createSim(graph, graph.nodes.length > 200 ? { link: 24, charge: 200, gravity: 0.03 } : {});
    if (still()) made.settle();
    return made;
  }, [graph]);
  useEffect(() => {
    const c = controller.current;
    c.scene = { x: sim.x, y: sim.y, labelled: (i) => graph.nodes[i]!.uses >= (graph.nodes.length > 200 ? 26 : 12) };
    c.userMoved = false;
    let frames = 0;
    c.tick = () => {
      if (sim.alpha > 0.005) sim.step();
      if (!c.userMoved && selectedRef.current === null && frames++ % 6 === 0 && sim.alpha > 0.02) fitTo(c, pointsOf(sim, all(graph)));
      return sim.alpha > 0.005;
    };
    fitTo(c, pointsOf(sim, all(graph)));
    c.camera = { ...c.target, k: c.target.k * (still() ? 1 : 0.6) };
    c.invalidate();
  }, [graph, sim, controller]);
  useEffect(() => {
    if (selected !== null) focusOn(controller.current, { x: sim.x[selected]!, y: sim.y[selected]! });
    controller.current.invalidate();
  }, [selected, sim, controller]);
  const onDrag = useCallback((index: number, at: Point | null) => {
    sim.pin(index, at);
    if (at) sim.reheat(0.12);
    controller.current.invalidate();
  }, [sim, controller]);
  const onFit = useCallback(() => { onSelect(null); fitTo(controller.current, pointsOf(sim, all(graph))); controller.current.invalidate(); }, [sim, graph, controller, onSelect]);
  return <GraphCanvas graph={graph} controller={controller} selected={selected} onSelect={onSelect} onDrag={onDrag} onFit={onFit} label={`Knowledge graph: ${graph.nodes.length} pages, ${graph.edges.length} links. Use Find a page to move through it.`} />;
};

// ---------------------------------------------------------------------------------------------------------------
// (b) Orbit: one page in the middle, what it links to round it, theirs beyond. Click a page to move it to the middle.
// ---------------------------------------------------------------------------------------------------------------

const OrbitView = ({ graph, selected, onSelect, controller }: ViewProps) => {
  const [trail, setTrail] = useState<number[]>(() => [selected ?? defaultCentre(graph)]);
  const centre = trail[trail.length - 1]!;
  const ring = graph.nodes.length > 200 ? 190 : 150;
  const layout = useMemo(() => radialLayout(graph, centre, ring), [graph, centre, ring]);
  const state = useMemo(() => ({
    x: new Float32Array(graph.nodes.length), y: new Float32Array(graph.nodes.length), alpha: new Float32Array(graph.nodes.length),
    from: { x: new Float32Array(graph.nodes.length), y: new Float32Array(graph.nodes.length), alpha: new Float32Array(graph.nodes.length) },
    started: 0,
  }), [graph]);

  useEffect(() => {
    // Tween from where everything is now to the new layout; pages that join come out of the new centre.
    const c = controller.current;
    const origin = { x: state.x[centre] ?? 0, y: state.y[centre] ?? 0 };
    for (let i = 0; i < graph.nodes.length; i++) {
      const shown = state.alpha[i]! > 0.01;
      state.from.x[i] = shown ? state.x[i]! - origin.x : 0;
      state.from.y[i] = shown ? state.y[i]! - origin.y : 0;
      state.from.alpha[i] = state.alpha[i]!;
    }
    state.started = performance.now();
    const duration = still() ? 0 : 650;
    c.scene = { x: state.x, y: state.y, alpha: state.alpha, rings: layout.rings, noDim: true, labelled: (i) => layout.depth[i] === 0 || layout.depth[i] === 1 || (graph.nodes.length < 200 && layout.depth[i] === 2) };
    c.tick = (now) => {
      const t = duration === 0 ? 1 : ease((now - state.started) / duration);
      for (let i = 0; i < graph.nodes.length; i++) {
        const to = layout.at[i];
        const tx = to?.x ?? state.from.x[i]! * 1.3;
        const ty = to?.y ?? state.from.y[i]! * 1.3;
        state.x[i] = state.from.x[i]! + (tx - state.from.x[i]!) * t;
        state.y[i] = state.from.y[i]! + (ty - state.from.y[i]!) * t;
        state.alpha[i] = state.from.alpha[i]! + ((to ? 1 : 0) - state.from.alpha[i]!) * t;
      }
      return t < 1;
    };
    c.camera.x -= origin.x;
    c.camera.y -= origin.y;
    fitTo(c, layout.at.filter((p): p is Point => p !== null), 64);
    c.invalidate();
  }, [graph, layout, state, controller, centre]);

  useEffect(() => { onSelect(centre); }, [centre, onSelect]);

  const choose = useCallback((index: number | null) => {
    if (index === null || index === centre) return;
    setTrail((list) => [...list.slice(-5), index]);
  }, [centre]);
  // The search box and the side panel select a page: in the orbit view, that moves it to the middle.
  useEffect(() => { if (selected !== null && selected !== centre) choose(selected); }, [selected, centre, choose]);
  const onFit = useCallback(() => { fitTo(controller.current, layout.at.filter((p): p is Point => p !== null), 64); controller.current.invalidate(); }, [layout, controller]);

  return (
    <>
      <GraphCanvas graph={graph} controller={controller} selected={centre} onSelect={choose} onFit={onFit} label={`${graph.nodes[centre]!.label} in the middle, ${graph.neighbours[centre]!.length} pages linked to it.`} />
      {trail.length > 1 && (
        <nav aria-label="Pages you came through" className="absolute top-3 left-3 flex max-w-[60%] flex-wrap items-center gap-1 text-xs">
          {trail.map((index, k) => (
            <span key={`${index}-${k}`} className="flex items-center gap-1">
              {k > 0 && <span aria-hidden className="text-faint">›</span>}
              {k === trail.length - 1
                ? <span className="font-medium text-ink" aria-current="page">{graph.nodes[index]!.label}</span>
                : <button type="button" onClick={() => setTrail((list) => list.slice(0, k + 1))} className="rounded px-1 text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">{graph.nodes[index]!.label}</button>}
            </span>
          ))}
        </nav>
      )}
      {layout.beyond > 0 && <p className="pointer-events-none absolute bottom-3 left-3 text-xs text-faint">+{layout.beyond} further away</p>}
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// (c) Growth: the knowledge base growing, page by page, in the order it was written. Play, pause, scrub.
// ---------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateName = (day: number): string => new Date(day * DAY_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const GrowthView = ({ graph, selected, onSelect, controller }: ViewProps) => {
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const order = useMemo(() => growthOrder(graph), [graph]);
  const first = dayOf(graph.nodes[order[0]!]!.written);
  const last = dayOf(graph.nodes[order[order.length - 1]!]!.written);
  const duration = graph.nodes.length > 200 ? 16_000 : 11_000;
  const [playing, setPlaying] = useState(() => !still());
  const [progress, setProgress] = useState(() => (still() ? 1 : 0));
  const live = useRef({ progress: still() ? 1 : 0, playing: !still(), last: 0 });
  const state = useMemo(() => {
    const sim: Sim = createSim(graph, graph.nodes.length > 200 ? { link: 26, charge: 300 } : {});
    sim.active = new Uint8Array(graph.nodes.length);
    return { sim, alpha: new Float32Array(graph.nodes.length), pulse: new Float32Array(graph.nodes.length), born: new Float64Array(graph.nodes.length).fill(-1) };
  }, [graph]);

  useEffect(() => {
    const c = controller.current;
    const { sim, alpha, pulse, born } = state;
    const active = sim.active!;
    c.scene = { x: sim.x, y: sim.y, alpha, pulse, labelled: (i) => graph.nodes[i]!.uses >= 24 };
    c.userMoved = false;
    let frames = 0;
    const apply = (now: number, instant: boolean): boolean => {
      const today = first + (last - first) * live.current.progress;
      let changed = false;
      for (const i of order) {
        const on = dayOf(graph.nodes[i]!.written) <= today;
        if (on && !active[i]) {
          // A new page starts beside the page it links to that is already there, so the graph grows outwards.
          const anchor = graph.neighbours[i]!.find((j) => active[j]);
          const jitter = (i % 13) - 6;
          sim.x[i] = anchor === undefined ? jitter * 4 : sim.x[anchor]! + jitter;
          sim.y[i] = anchor === undefined ? ((i % 7) - 3) * 4 : sim.y[anchor]! + ((i % 5) - 2) * 3;
          active[i] = 1;
          born[i] = instant ? now - 5000 : now;
          changed = true;
        } else if (!on && active[i]) {
          active[i] = 0;
          born[i] = -1;
          changed = true;
        }
      }
      if (changed) {
        sim.reheat(instant ? 1 : 0.35);
        if (instant) sim.settle(300);
      }
      let animating = false;
      for (let i = 0; i < graph.nodes.length; i++) {
        if (!active[i]) { alpha[i] = 0; pulse[i] = 0; continue; }
        const age = now - born[i]!;
        alpha[i] = Math.min(1, age / 450);
        pulse[i] = age < 1400 ? 1 - age / 1400 : 0;
        if (age < 1400) animating = true;
      }
      return animating;
    };
    c.tick = (now) => {
      const state = live.current;
      const dt = state.last ? Math.min(64, now - state.last) : 16;
      state.last = now;
      if (state.playing) {
        state.progress = Math.min(1, state.progress + dt / duration);
        if (frames++ % 8 === 0) setProgress(state.progress);
        if (state.progress >= 1) { state.playing = false; setPlaying(false); setProgress(1); }
      }
      const pulsing = apply(now, still());
      if (sim.alpha > 0.005) sim.step();
      if (!c.userMoved && selectedRef.current === null) {
        const shown = order.filter((i) => active[i]);
        if (shown.length) fitTo(c, pointsOf(sim, shown), 64, 56);
      }
      return state.playing || pulsing || sim.alpha > 0.005;
    };
    c.invalidate();
  }, [graph, order, state, first, last, duration, controller]);

  useEffect(() => {
    if (selected !== null) focusOn(controller.current, { x: state.sim.x[selected]!, y: state.sim.y[selected]! });
  }, [selected, state, controller]);

  const toggle = (): void => {
    const l = live.current;
    if (!l.playing && l.progress >= 1) { l.progress = 0; setProgress(0); }
    l.playing = !l.playing;
    l.last = 0;
    setPlaying(l.playing);
    controller.current.userMoved = false;
    controller.current.invalidate();
  };
  const scrub = (value: number): void => {
    live.current.progress = value;
    live.current.playing = false;
    setPlaying(false);
    setProgress(value);
    controller.current.invalidate();
  };
  const today = first + (last - first) * progress;
  const count = order.filter((i) => dayOf(graph.nodes[i]!.written) <= today).length;
  const onFit = useCallback(() => {
    controller.current.userMoved = false;
    fitTo(controller.current, pointsOf(state.sim, order.filter((i) => state.sim.active?.[i])), 64, 56);
    controller.current.invalidate();
  }, [controller, state, order]);
  const id = useId();

  return (
    <>
      <GraphCanvas graph={graph} controller={controller} selected={selected} onSelect={onSelect} onFit={onFit} label={`The knowledge base on ${dateName(today)}: ${count} pages.`} />
      <div className="pointer-events-none absolute top-4 left-5 flex flex-col gap-0.5">
        <span className="text-[28px] leading-none font-semibold tracking-tight tabular-nums text-ink">{count}</span>
        <span className="text-xs text-muted">pages · {dateName(today)}</span>
      </div>
      <div className="absolute inset-x-4 bottom-4 flex items-center gap-3 rounded-lg border border-line bg-panel/90 px-2 py-1.5 backdrop-blur">
        <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : progress >= 1 ? 'Replay' : 'Play'} className="grid size-7 place-items-center rounded-md text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus">
          {playing ? <Pause size={15} /> : progress >= 1 ? <RotateCcw size={15} /> : <Play size={15} />}
        </button>
        <label htmlFor={id} className="sr-only">Date</label>
        <input
          id={id} type="range" min={0} max={1000} value={Math.round(progress * 1000)}
          aria-valuetext={`${dateName(today)}, ${count} pages`}
          onChange={(event) => scrub(Number(event.target.value) / 1000)}
          className="h-1 flex-1 cursor-pointer accent-[var(--color-ink)]"
        />
        <span className="w-20 text-right text-xs tabular-nums text-muted">{dateName(last).replace(/ \d{4}$/, '')}</span>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// (d) Islands: one island per area (the Overview's areas), links within close, links across long and faint.
// ---------------------------------------------------------------------------------------------------------------

const IslandsView = ({ graph, selected, onSelect, controller }: ViewProps) => {
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const big = graph.nodes.length > 200;
  const { sim, centres } = useMemo(() => {
    const { anchors, centres: placed } = islandAnchors(graph, big ? 22 : 30);
    const made = createSim(graph, {
      anchors, gravity: big ? 0.025 : 0.06, link: big ? 22 : 30, charge: big ? 200 : 160,
      strength: (_kind, same) => (same ? 1 : 0.02),
    });
    // Each page stays on its island: after every step, one that drifted past the shore is set back on it.
    const step = made.step;
    made.step = () => {
      step();
      graph.nodes.forEach((node, i) => {
        const centre = placed.get(node.area)!;
        const dx = made.x[i]! - centre.x;
        const dy = made.y[i]! - centre.y;
        const d = Math.hypot(dx, dy);
        if (d > centre.r) { made.x[i] = centre.x + (dx / d) * centre.r; made.y[i] = centre.y + (dy / d) * centre.r; }
      });
    };
    if (still()) made.settle();
    return { sim: made, centres: placed };
  }, [graph, big]);
  // Each island's shore follows its pages: the circle round the anchor that holds nearly all of them.
  const shores = useCallback(() => [...centres].map(([area, centre]) => {
    const distances = graph.nodes.flatMap((node, i) => (node.area === area ? [Math.hypot(sim.x[i]! - centre.x, sim.y[i]! - centre.y)] : [])).sort((a, b) => a - b);
    const r = Math.max(34, (distances[Math.floor(distances.length * 0.95)] ?? 0) + 20);
    return { x: centre.x, y: centre.y, r, label: `${AREA_NAMES[area]} · ${distances.length}` };
  }), [centres, graph, sim]);
  const bounds = useMemo(() => [...centres.values()].flatMap((c) => [{ x: c.x - c.r - 14, y: c.y - c.r - 34 }, { x: c.x + c.r + 14, y: c.y + c.r + 14 }]), [centres]);
  useEffect(() => {
    const c = controller.current;
    c.scene = {
      x: sim.x, y: sim.y, islands: shores(),
      labelled: (i) => graph.nodes[i]!.uses >= (big ? 28 : 18),
      edgeWeight: (a, b) => (graph.nodes[a]!.area === graph.nodes[b]!.area ? 1 : 0.3),
    };
    c.userMoved = false;
    c.tick = () => {
      if (sim.alpha <= 0.005) return false;
      sim.step();
      c.scene.islands = shores();
      return true;
    };
    fitTo(c, bounds, 32);
    c.camera = { ...c.target, k: c.target.k * (still() ? 1 : 0.85) };
    c.invalidate();
  }, [graph, sim, shores, bounds, controller, big]);
  useEffect(() => {
    if (selected !== null) focusOn(controller.current, { x: sim.x[selected]!, y: sim.y[selected]! });
  }, [selected, sim, controller]);
  const onFit = useCallback(() => {
    onSelect(null);
    fitTo(controller.current, bounds, 32);
    controller.current.invalidate();
  }, [controller, onSelect, bounds]);
  return <GraphCanvas graph={graph} controller={controller} selected={selected} onSelect={onSelect} onFit={onFit} label={`Knowledge by area: ${centres.size} areas, ${graph.nodes.length} pages.`} />;
};

// ---------------------------------------------------------------------------------------------------------------
// The lab: option tabs, find a page, the selected page's card, size and theme switches.
// ---------------------------------------------------------------------------------------------------------------

const Segmented = <T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; name: ReactNode }[]; onChange: (value: T) => void }) => (
  <div role="radiogroup" aria-label={label} className="flex items-center rounded-lg border border-line p-0.5">
    {options.map((option) => (
      <button
        key={String(option.id)} type="button" role="radio" aria-checked={option.id === value} onClick={() => onChange(option.id)}
        className={cx('h-7 rounded-md px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus',
          option.id === value ? 'bg-selected text-ink' : 'text-muted hover:text-ink')}
      >
        {option.name}
      </button>
    ))}
  </div>
);

const PageCard = ({ graph, index, onSelect }: { graph: KbGraph; index: number; onSelect: (index: number) => void }) => {
  const node = graph.nodes[index]!;
  const links = graph.edges.filter((edge) => edge.a === index || edge.b === index)
    .map((edge) => ({ other: edge.a === index ? edge.b : edge.a, kind: edge.kind }))
    .sort((a, b) => Number(b.kind === 'disagrees') - Number(a.kind === 'disagrees') || graph.nodes[b.other]!.uses - graph.nodes[a.other]!.uses);
  const shown = links.slice(0, 7);
  return (
    <aside aria-label={node.label} className="absolute top-3 right-3 flex w-64 flex-col gap-3 rounded-lg border border-line bg-panel/95 p-3 backdrop-blur">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold text-ink">{node.label}</h2>
        <p className="font-mono text-[11px] text-faint">{node.id}</p>
      </div>
      <p className="text-xs text-muted">{AREA_NAMES[node.area]} · used {node.uses}× this month</p>
      {shown.length > 0 && (
        <ul className="flex flex-col">
          {shown.map(({ other, kind }) => (
            <li key={`${other}-${kind}`}>
              <button type="button" onClick={() => onSelect(other)} className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus">
                <span className="truncate">{graph.nodes[other]!.label}</span>
                <span className={cx('shrink-0 text-[11px]', kind === 'disagrees' ? 'font-medium text-down' : 'text-faint')}>{KIND_NAMES[kind]}</span>
              </button>
            </li>
          ))}
          {links.length > shown.length && <li className="px-1.5 pt-1 text-[11px] text-faint">+{links.length - shown.length} more</li>}
        </ul>
      )}
    </aside>
  );
};

const optionFromHash = (): LabOption => {
  const match = /[?&]option=(web|orbit|growth|islands)/.exec(window.location.hash);
  return match?.[1] === 'orbit' || match?.[1] === 'growth' || match?.[1] === 'islands' ? match[1] : 'web';
};
const sizeFromHash = (): Size => (/[?&]size=800/.test(window.location.hash) ? 800 : 'small');

export const KbGraphLab = () => {
  const [option, setOption] = useState<LabOption>(optionFromHash);
  const [size, setSize] = useState<Size>(sizeFromHash);
  const [selected, setSelected] = useState<number | null>(null);
  const graph = useMemo(() => seedGraph(size), [size]);
  const controller = useRef<Controller>(createController({ x: [], y: [] }));
  const theme = useTheme();
  const searchId = useId();
  const [announce, setAnnounce] = useState('');

  useEffect(() => {
    setAnnounce(selected === null ? '' : `${graph.nodes[selected]!.label}: ${graph.neighbours[selected]!.length} linked pages`);
  }, [selected, graph]);
  // For the performance check and the screenshots: the last frames' average cost, and the graph's size.
  useEffect(() => {
    Object.assign(window, {
      __kbGraphPerf: () => ({ frameMs: controller.current.frameMs, nodes: graph.nodes.length, edges: graph.edges.length }),
      __kbGraphSelect: (label: string) => { const index = graph.nodes.findIndex((node) => node.label === label); setSelected(index === -1 ? null : index); },
      __kbGraphTheme: (value: 'light' | 'dark') => { void themeStore.set(value); },
    });
  }, [graph]);
  const select = useCallback((index: number | null) => { setSelected(index); }, []);

  const view = { graph, selected, onSelect: select, controller };
  return (
    <div className="flex h-full flex-col gap-3 px-6 pb-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Graph</h1>
        <Segmented label="Option" value={option} options={OPTIONS} onChange={(value) => { setSelected(null); setOption(value); }} />
        <div className="flex-1" />
        <label htmlFor={searchId} className="sr-only">Find a page</label>
        <input
          id={searchId} list={`${searchId}-pages`} placeholder="Find a page"
          onChange={(event) => {
            const index = graph.nodes.findIndex((node) => node.label.toLowerCase() === event.target.value.trim().toLowerCase());
            if (index !== -1) { setSelected(index); event.target.value = ''; }
          }}
          className="h-8 w-44 rounded-md border border-line bg-panel px-2.5 text-[13px] text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-focus"
        />
        <datalist id={`${searchId}-pages`}>{graph.nodes.map((node) => <option key={node.id} value={node.label} />)}</datalist>
        <Segmented label="Pages" value={size} options={[{ id: 'small', name: String(seedGraph('small').nodes.length) }, { id: 800, name: '800' }]} onChange={(value) => { setSelected(null); setSize(value); }} />
        <Segmented label="Theme" value={theme} options={[{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }]} onChange={(value) => { void themeStore.set(value); }} />
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line-subtle">
        {option === 'web' && <WebView key={`web-${size}`} {...view} />}
        {option === 'orbit' && <OrbitView key={`orbit-${size}`} {...view} />}
        {option === 'growth' && <GrowthView key={`growth-${size}`} {...view} />}
        {option === 'islands' && <IslandsView key={`islands-${size}`} {...view} />}
        {selected !== null && <PageCard graph={graph} index={selected} onSelect={select} />}
      </div>
      <p aria-live="polite" className="sr-only">{announce}</p>
    </div>
  );
};
