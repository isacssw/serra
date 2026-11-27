// Knowledge › Graph (SERRA-93): what the bot knows about the owner, as a map. One island per area, pages on their
// island, links between them. On first open the pages arrive in the order they were written; after that only pages
// new since the last visit do. At rest it is the map, with Replay. Click a page (or use the arrow keys) to light it
// and its links; its card opens it, or settles two rules that disagree.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Pause, Play, RotateCcw, Search, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { GraphLinkKind } from '../../../../src/knowledge-graph.ts';
import { serra } from '../../bridge.ts';
import { Button, cx, EmptyState, Page, useToast } from '../../ui/index.ts';
import { fieldClass } from '../../ui/field.ts';
import { keepOne } from '../keep.ts';
import { keepLabel } from '../pages.logic.ts';
import { createController, GraphCanvas, type Controller } from './GraphCanvas.tsx';
import { growthPlan, nextInDirection, replayMs, startPage, toCanvasGraph, type CanvasGraph, type Direction, type Growth } from './graph.logic.ts';
import { fitCamera, islandSim, shoresOf, type Point, type Shore, type Sim } from './layout.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const still = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The pages seen on the last visit, so only new ones replay. Per window, a convenience: lost, it replays once. */
const SEEN_KEY = 'serra.graph.seen';
const readSeen = (): string[] | null => {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? 'null');
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
  } catch { return null; }
};
const saveSeen = (paths: string[]): void => { try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(paths)); } catch { /* replays again next time */ } };

const KIND_NAMES: Record<GraphLinkKind, string> = { mentions: 'Mentions', source: 'Same source', cited: 'Used together', disagrees: 'Disagrees' };

const DAY_MS = 86_400_000;
const dayOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateName = (day: number): string => new Date(day * DAY_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const pointsOf = (sim: Pick<Sim, 'x' | 'y'>, indexes: Iterable<number>): Point[] => [...indexes].map((i) => ({ x: sim.x[i]!, y: sim.y[i]! }));
const islandBounds = (islands: readonly Shore[]): Point[] =>
  islands.flatMap((island) => [{ x: island.x - island.r, y: island.y - island.r - 26 }, { x: island.x + island.r, y: island.y + island.r }]);

/** Aim the camera at `points`, keeping `bottom` pixels clear (the replay bar) and `right` (the card). */
const fitTo = (c: Controller, points: Point[], pad = 40, { bottom = 0, right: wanted = 0, maxZoom = 2.4 }: { bottom?: number; right?: number; maxZoom?: number } = {}): void => {
  const width = c.width || 800;
  // A narrow window has no room beside the card: the card lies over the map instead.
  const right = width - wanted < 360 ? 0 : wanted;
  const fit = fitCamera(points, width - right, (c.height || 600) - bottom, Math.min(pad, (width - right) * 0.12), maxZoom);
  c.target.x = fit.x + right / 2 / fit.k; c.target.y = fit.y + bottom / 2 / fit.k; c.target.k = fit.k;
};

/** The top `count` most used pages of each area: always named, so no island is blank. */
const topOfEachArea = (graph: CanvasGraph, count: number): Set<number> => {
  const byArea = new Map<string, number[]>();
  graph.nodes.forEach((node, i) => { byArea.set(node.area, [...(byArea.get(node.area) ?? []), i]); });
  return new Set([...byArea.values()].flatMap((list) => list.sort((a, b) => graph.nodes[b]!.uses - graph.nodes[a]!.uses).slice(0, count)));
};

const CARD_WIDTH = 272;

// ---------------------------------------------------------------------------------------------------------------
// The card: the selected page, its links, and its disagreements.
// ---------------------------------------------------------------------------------------------------------------

const PageCard = ({ graph, index, onSelect, onOpen, onChanged }: { graph: CanvasGraph; index: number; onSelect: (index: number) => void; onOpen: (path: string) => void; onChanged: () => void }) => {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const node = graph.nodes[index]!;
  const conflicts = graph.conflicts.filter((conflict) => conflict.pages.includes(index));
  const links = graph.edges.filter((edge) => (edge.a === index || edge.b === index) && edge.kind !== 'disagrees')
    .map((edge) => ({ other: edge.a === index ? edge.b : edge.a, kind: edge.kind }))
    .sort((a, b) => graph.nodes[b.other]!.uses - graph.nodes[a.other]!.uses);
  const shown = links.slice(0, 6);
  const keep = async (kept: { page: string; text: string }, drop: { page: string; text: string }): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    try {
      const result = await keepOne(bridge, kept, drop);
      if (result === 'open') { onOpen(drop.page); return; }
      toast({ message: 'Kept.', tone: 'success', action: { label: 'Undo', onClick: () => { void result.undo().then(onChanged, (failure: unknown) => toast({ message: message(failure), tone: 'error' })); } } });
      onChanged();
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <aside aria-label={node.label} className="absolute top-3 right-3 flex max-h-[calc(100%-24px)] flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-panel/95 p-3 backdrop-blur" style={{ width: CARD_WIDTH - 24 }}>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold text-ink">{node.label}</h2>
        {node.description && node.description !== node.label && <p className="text-xs text-muted">{node.description}</p>}
        <p className="text-xs text-muted">{graph.areas.find((area) => area.area === node.area)?.label}{node.uses > 0 ? ` · used ${node.uses}× this month` : ''}</p>
      </div>
      <Button size="sm" variant="secondary" className="self-start" onClick={() => onOpen(node.id)}>Open page</Button>
      {conflicts.map((conflict) => {
        const [a, b] = conflict.rules;
        const other = conflict.pages[0] === index ? conflict.pages[1] : conflict.pages[0];
        return (
          <div key={`${a.text}|${b.text}`} className="flex flex-col gap-1.5 border-t border-line pt-3">
            <p className="text-xs font-medium text-down">{other === index ? 'Two rules here disagree' : `Disagrees with ${graph.nodes[other]!.label}`}</p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={busy} title={a.text} onClick={() => void keep(a, b)}>{keepLabel(a.text, b.text)}</Button>
              <Button size="sm" disabled={busy} title={b.text} onClick={() => void keep(b, a)}>{keepLabel(b.text, a.text)}</Button>
            </div>
          </div>
        );
      })}
      {shown.length > 0 && (
        <ul aria-label="Linked pages" className="flex flex-col border-t border-line pt-2">
          {shown.map(({ other, kind }) => (
            <li key={`${other}-${kind}`}>
              <button type="button" onClick={() => onSelect(other)} className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus">
                <span className="truncate">{graph.nodes[other]!.label}</span>
                <span className="shrink-0 text-[11px] text-faint">{KIND_NAMES[kind]}</span>
              </button>
            </li>
          ))}
          {links.length > shown.length && <li className="px-1.5 pt-1 text-[11px] text-faint">+{links.length - shown.length} more</li>}
        </ul>
      )}
    </aside>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The map, with its replay.
// ---------------------------------------------------------------------------------------------------------------

const GraphMap = ({ graph, controller, onOpen, onChanged }: { graph: CanvasGraph; controller: MutableRefObject<Controller>; onOpen: (path: string) => void; onChanged: () => void }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [plan, setPlan] = useState<Growth>(() => growthPlan(graph.nodes, readSeen(), still()));
  const replaying = plan.mode !== 'none';
  const duration = replayMs(plan, plan.mode === 'new' ? [...plan.at].filter((at) => at >= 0).length : graph.nodes.length);
  const [playing, setPlaying] = useState(replaying);
  const [progress, setProgress] = useState(replaying ? 0 : 1);
  const live = useRef({ progress: replaying ? 0 : 1, playing: replaying, last: 0 });
  const [announce, setAnnounce] = useState('');
  const findId = useId();
  const rangeId = useId();
  const big = graph.nodes.length > 200;

  // The next visit replays only what is new from here.
  useEffect(() => { saveSeen(graph.nodes.map((node) => node.id)); }, [graph]);

  const state = useMemo(() => {
    const made = islandSim(graph);
    made.sim.active = new Uint8Array(graph.nodes.length);
    return { ...made, alpha: new Float32Array(graph.nodes.length), pulse: new Float32Array(graph.nodes.length), born: new Float64Array(graph.nodes.length).fill(-1) };
  }, [graph]);
  const named = useMemo(() => topOfEachArea(graph, big ? 1 : 2), [graph, big]);
  const planRef = useRef(plan);
  planRef.current = plan;

  useEffect(() => {
    const c = controller.current;
    const { sim, alpha, pulse, born, centres } = state;
    const active = sim.active!;
    c.scene = {
      x: sim.x, y: sim.y, alpha, pulse, islands: shoresOf(graph, sim, centres),
      labelled: (i) => named.has(i),
      edgeWeight: (a, b) => (graph.nodes[a]!.area === graph.nodes[b]!.area ? 1 : 0.15),
    };
    c.userMoved = false;
    let frames = 0;
    // Pages arrive: each starts beside a page on its island it links to that is already there, so islands grow outwards.
    const apply = (now: number, instant: boolean): boolean => {
      const { at, order } = planRef.current;
      let changed = false;
      for (const i of order) {
        const on = at[i]! < 0 || at[i]! <= live.current.progress;
        if (on && !active[i]) {
          const anchor = graph.neighbours[i]!.find((j) => active[j] && graph.nodes[j]!.area === graph.nodes[i]!.area);
          const home = centres.get(graph.nodes[i]!.area) ?? { x: 0, y: 0 };
          const jitter = (i % 13) - 6;
          sim.x[i] = (anchor === undefined ? home.x : sim.x[anchor]!) + jitter * (anchor === undefined ? 3 : 1);
          sim.y[i] = (anchor === undefined ? home.y : sim.y[anchor]!) + ((i % 5) - 2) * 3;
          active[i] = 1;
          born[i] = instant || at[i]! < 0 ? now - 5000 : now;
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
    const frame = (): void => {
      c.scene.islands = shoresOf(graph, sim, centres);
      if (c.userMoved || selectedRef.current !== null) return;
      fitTo(c, islandBounds(c.scene.islands), 40, { bottom: live.current.playing || live.current.progress < 1 ? 56 : 0, maxZoom: 1.6 });
    };
    // At rest from the start (nothing new, or reduced motion): the finished map, laid out before the first frame.
    const first = performance.now();
    if (planRef.current.mode === 'none') { apply(first, true); sim.settle(); }
    frame();
    c.camera = { ...c.target };
    c.tick = (now) => {
      const l = live.current;
      const dt = l.last ? Math.min(64, now - l.last) : 16;
      l.last = now;
      if (l.playing) {
        l.progress = Math.min(1, l.progress + dt / duration);
        if (frames++ % 8 === 0) setProgress(l.progress);
        if (l.progress >= 1) { l.playing = false; setPlaying(false); setProgress(1); }
      }
      const pulsing = apply(now, still());
      if (sim.alpha > 0.005) sim.step();
      frame();
      return l.playing || pulsing || sim.alpha > 0.005;
    };
    c.invalidate();
  }, [graph, state, named, duration, controller]);

  // Focus: frame the page and every page it links to, beside the card.
  useEffect(() => {
    const c = controller.current;
    if (selected !== null) fitTo(c, pointsOf(state.sim, [selected, ...graph.neighbours[selected]!]), 72, { right: CARD_WIDTH, maxZoom: 1.8 });
    else if (!c.userMoved) fitTo(c, islandBounds(c.scene.islands ?? []), 40);
    c.invalidate();
    setAnnounce(selected === null ? '' : `${graph.nodes[selected]!.label}, ${graph.areas.find((area) => area.area === graph.nodes[selected]!.area)?.label ?? ''}, ${graph.neighbours[selected]!.length} linked pages`);
  }, [selected, state, graph, controller]);

  const shown = useCallback((i: number) => (state.sim.active?.[i] ?? 0) === 1, [state]);
  const onArrow = useCallback((direction: Direction) => {
    const from = selectedRef.current;
    const next = from === null ? startPage(graph.nodes, shown) : nextInDirection(pointsOf(state.sim, graph.nodes.map((_, i) => i)), from, direction, shown);
    if (next !== null) setSelected(next);
  }, [graph, state, shown]);
  const onFit = useCallback(() => {
    const c = controller.current;
    c.userMoved = false;
    setSelected(null);
    fitTo(c, islandBounds(c.scene.islands ?? []), 40);
    c.invalidate();
  }, [controller]);
  const onBackground = useCallback((at: Point) => {
    const c = controller.current;
    const island = (c.scene.islands ?? []).find((shore) => shore.count > 0 && Math.hypot(at.x - shore.x, at.y - shore.y) < shore.r);
    if (island) { c.userMoved = true; fitTo(c, islandBounds([island]), 48); } else { c.userMoved = false; fitTo(c, islandBounds(c.scene.islands ?? []), 40); }
    c.invalidate();
  }, [controller]);

  const replay = (): void => {
    const l = live.current;
    if (l.playing) { l.playing = false; setPlaying(false); return; }
    if (l.progress >= 1) {
      // Replay is always the whole story, from the first page.
      const full = growthPlan(graph.nodes, null, false);
      setPlan(full);
      planRef.current = full;
      l.progress = 0;
      setProgress(0);
    }
    l.playing = true;
    l.last = 0;
    setPlaying(true);
    setSelected(null);
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

  const arrived = plan.order.filter((i) => plan.at[i]! < 0 || plan.at[i]! <= progress);
  const newest = progress < 1 && arrived.length ? graph.nodes[arrived[arrived.length - 1]!]! : null;
  const dated = plan.order.filter((i) => graph.nodes[i]!.written);
  const firstDay = dated.length ? dayOf(graph.nodes[dated[0]!]!.written!) : null;
  const lastDay = dated.length ? dayOf(graph.nodes[dated[dated.length - 1]!]!.written!) : null;
  const today = plan.mode === 'all' && firstDay !== null && lastDay !== null ? firstDay + (lastDay - firstDay) * progress : null;
  const atRest = !playing && progress >= 1;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 px-8 pt-3 pb-6">
      <header className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2.5">
          <h1 tabIndex={-1} className="text-xl leading-7 font-semibold tracking-[-0.012em]">Graph</h1>
          <span className="text-[13px] text-faint tabular-nums">
            {graph.nodes.length} {graph.nodes.length === 1 ? 'page' : 'pages'} · {graph.areas.filter((area) => graph.nodes.some((node) => node.area === area.area)).length} areas
            {graph.conflicts.length > 0 && <span className="text-warn"> · {graph.conflicts.length} {graph.conflicts.length === 1 ? 'conflict' : 'conflicts'}</span>}
          </span>
        </div>
        <div className="flex-1" />
        <div className="relative flex w-56 items-center">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 text-faint" />
          <label htmlFor={findId} className="sr-only">Find a page</label>
          <input
            id={findId} list={`${findId}-pages`} placeholder="Find a page" type="search"
            onChange={(event) => {
              const index = graph.nodes.findIndex((node) => node.label.toLowerCase() === event.target.value.trim().toLowerCase());
              if (index !== -1) { setSelected(index); event.target.value = ''; }
            }}
            className={cx('h-8 w-full pr-2.5 pl-8', fieldClass())}
          />
        </div>
        <datalist id={`${findId}-pages`}>{graph.nodes.map((node) => <option key={node.id} value={node.label} />)}</datalist>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-line-subtle">
        <GraphCanvas
          graph={graph} controller={controller} selected={selected} onSelect={setSelected} onBackground={onBackground}
          onArrow={onArrow} onOpen={(i) => onOpen(graph.nodes[i]!.id)} onFit={onFit}
          label={`Your knowledge as a map: ${graph.nodes.length} pages on ${new Set(graph.nodes.map((node) => node.area)).size} islands. Arrow keys move between pages, Enter opens one, Escape clears.`}
        />
        {!atRest && <div className="pointer-events-none absolute top-4 left-5 flex flex-col gap-0.5">
          <span className="text-[28px] leading-none font-semibold tracking-tight tabular-nums text-ink">{arrived.length}</span>
          <span className="text-xs text-muted">{arrived.length === 1 ? 'page' : 'pages'}{today !== null && !atRest ? ` · ${dateName(today)}` : ''}</span>
          {newest && <span key={newest.id} className="mt-1 text-xs text-ink [animation:serra-rise_200ms_ease-out]"><span className="text-up">+</span> {newest.label}</span>}
        </div>}
        {selected !== null && <PageCard graph={graph} index={selected} onSelect={setSelected} onOpen={onOpen} onChanged={onChanged} />}
        {atRest
          ? !still() && (
            <Button size="sm" variant="secondary" className="absolute bottom-4 left-4 bg-panel/90 backdrop-blur" icon={<RotateCcw size={14} aria-hidden />} onClick={replay}>Replay</Button>
          )
          : (
            <div className={cx('absolute bottom-4 left-4 flex items-center gap-3 rounded-lg border border-line bg-panel/90 px-2 py-1.5 backdrop-blur', selected === null ? 'right-4' : 'right-[284px]')}>
              <button type="button" onClick={replay} aria-label={playing ? 'Pause' : 'Play'} className="grid size-7 place-items-center rounded-md text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus">
                {playing ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
              </button>
              <label htmlFor={rangeId} className="sr-only">Replay position</label>
              <input
                id={rangeId} type="range" min={0} max={1000} value={Math.round(progress * 1000)}
                aria-valuetext={`${today !== null ? `${dateName(today)}, ` : ''}${arrived.length} pages`}
                onChange={(event) => scrub(Number(event.target.value) / 1000)}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--color-ink)]"
              />
              <button type="button" onClick={() => scrub(1)} className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">Skip</button>
            </div>
          )}
      </div>
      <p aria-live="polite" className="sr-only">{announce}</p>
    </div>
  );
};

/** The graph changes when a page, a link or a use count does; a reload with the same graph keeps the map as it is. */
const signature = (graph: CanvasGraph): string => JSON.stringify([graph.nodes.map((node) => `${node.id}:${node.uses}:${node.label}`), graph.edges.length, graph.conflicts.length]);

export const Graph = () => {
  const navigate = useNavigate();
  const [graph, setGraph] = useState<{ graph: CanvasGraph; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<Controller>(createController({ x: [], y: [] }));

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      const next = toCanvasGraph(await bridge.pages.graph());
      const key = signature(next);
      setGraph((current) => (current?.key === key ? current : { graph: next, key }));
      setError(null);
    } catch (failure) { setError(message(failure)); }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  const open = useCallback((path: string): void => { void navigate(`/knowledge/pages?page=${encodeURIComponent(path)}`); }, [navigate]);

  if (error) return <Page title="Graph"><p role="alert" className="text-sm text-down">{error}</p></Page>;
  if (!graph) return <Page title="Graph" />;
  if (graph.graph.nodes.length === 0) {
    return (
      <Page title="Graph">
        <EmptyState icon={<Sparkles size={18} />} title="Nothing to map yet" action={<Button variant="primary" onClick={() => void navigate('/knowledge/proposals?interview=1')}>Start interview</Button>}>
          Each page your bot learns lands on its island here.
        </EmptyState>
      </Page>
    );
  }
  return <GraphMap key={graph.key} graph={graph.graph} controller={controller} onOpen={open} onChanged={() => void load()} />;
};
