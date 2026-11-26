// Graph lab (SERRA-93, prototype): one canvas renderer for every option. A view hands it a scene (positions, and
// per-node fade and pulse) and a camera to aim at; this draws it, hit-tests the pointer, pans and zooms, and only
// runs frames while something moves, so an idle graph costs nothing.
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { KbGraph } from './kbGraph.logic.ts';
import type { Camera, Point } from './layout.logic.ts';

export interface Scene {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** 0 hidden … 1 shown, per node; absent means all shown. */
  alpha?: ArrayLike<number>;
  /** 0 … 1: a ring that grows and fades, for a node that just appeared. */
  pulse?: ArrayLike<number>;
  /** Faint circles behind the graph (the orbit's rings). */
  rings?: number[];
  /** Soft areas behind the graph, with a name (the islands). */
  islands?: { x: number; y: number; r: number; label: string }[];
  /** Nodes whose name always shows. */
  labelled?: (index: number) => boolean;
  /** How strongly to draw a quiet link, 0 … 1 (the islands draw links across islands fainter). */
  edgeWeight?: (a: number, b: number) => number;
  /** Don't dim the rest when a page is selected (the orbit already shows only what is near). */
  noDim?: boolean;
}

export interface Controller {
  /** The view's scene, updated each frame by `tick`. */
  scene: Scene;
  /** Called once per frame; true while the view is still moving things. */
  tick: (now: number) => boolean;
  camera: Camera;
  target: Camera;
  /** Set by the canvas: draw again soon. */
  invalidate: () => void;
  width: number;
  height: number;
  /** Per-frame cost, for the performance check (window.__kbGraphPerf). */
  frameMs: number;
  /** The owner panned or zoomed: views stop re-fitting the camera on their own. */
  userMoved: boolean;
}

export const createController = (scene: Scene): Controller => ({
  scene, tick: () => false, camera: { x: 0, y: 0, k: 1 }, target: { x: 0, y: 0, k: 1 }, invalidate: () => {}, width: 0, height: 0, frameMs: 0, userMoved: false,
});

interface Palette { ink: string; muted: string; faint: string; line: string; lineStrong: string; canvas: string; raised: string; up: string; down: string; subtle: string }

/** The theme's colours as the canvas needs them: the tokens resolve through a probe element, so light-dark() picks. */
const readPalette = (probe: HTMLElement): Palette => {
  const read = (token: string): string => {
    probe.style.color = `var(--color-${token})`;
    return getComputedStyle(probe).color;
  };
  return {
    ink: read('ink'), muted: read('muted'), faint: read('faint'), line: read('line'), lineStrong: read('line-strong'),
    canvas: read('canvas'), raised: read('raised'), up: read('up'), down: read('down'), subtle: read('line-subtle'),
  };
};

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const nodeRadius = (uses: number): number => 2.2 + Math.sqrt(uses) * 1.15;

interface Props {
  graph: KbGraph;
  controller: MutableRefObject<Controller>;
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** Drag a node (the web view): a world point while dragging, null on release. */
  onDrag?: (index: number, at: Point | null) => void;
  /** Fit everything again (the 0 key). */
  onFit: () => void;
  label: string;
}

export const GraphCanvas = ({ graph, controller, selected, onSelect, onDrag, onFit, label }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const hover = useRef<number | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const fade = useRef(0);
  const callbacks = useRef({ onSelect, onDrag, onFit });
  callbacks.current = { onSelect, onDrag, onFit };

  useEffect(() => {
    const canvas = canvasRef.current;
    const probe = probeRef.current;
    if (!canvas || !probe) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const ctx = context;
    let palette = readPalette(probe);
    let frame = 0;
    let disposed = false;
    const c = controller.current;
    const still = reducedMotion();
    const samples: number[] = [];

    const toScreen = (x: number, y: number): Point => ({ x: (x - c.camera.x) * c.camera.k + c.width / 2, y: (y - c.camera.y) * c.camera.k + c.height / 2 });
    const toWorld = (sx: number, sy: number): Point => ({ x: (sx - c.width / 2) / c.camera.k + c.camera.x, y: (sy - c.height / 2) / c.camera.k + c.camera.y });
    const screenRadius = (i: number): number => nodeRadius(graph.nodes[i]!.uses) * Math.min(1.6, Math.max(0.42, c.camera.k));

    const draw = (now: number): void => {
      frame = 0;
      if (disposed) return;
      const started = performance.now();
      const moving = c.tick(now);
      // The camera eases to its target, or jumps for reduced motion.
      const ease = still ? 1 : 0.16;
      c.camera.x += (c.target.x - c.camera.x) * ease;
      c.camera.y += (c.target.y - c.camera.y) * ease;
      c.camera.k += (c.target.k - c.camera.k) * ease;
      const cameraMoving = Math.abs(c.target.k - c.camera.k) > 0.0005 * c.target.k || Math.hypot(c.target.x - c.camera.x, c.target.y - c.camera.y) * c.camera.k > 0.3;
      const focus = hover.current ?? selectedRef.current;
      const fadeTarget = focus === null ? 0 : 1;
      fade.current += (fadeTarget - fade.current) * (still ? 1 : 0.2);
      if (Math.abs(fadeTarget - fade.current) < 0.01) fade.current = fadeTarget;
      const fading = fade.current !== fadeTarget;

      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const { scene } = c;
      const near = new Set<number>(focus === null || (scene.noDim && focus === selectedRef.current) ? [] : [focus, ...graph.neighbours[focus]!]);
      const visible = (i: number): number => (scene.alpha ? scene.alpha[i]! : 1);
      const dim = (i: number): number => (near.size && !near.has(i) ? 1 - fade.current * 0.85 : 1);

      // Islands and rings behind everything.
      for (const island of scene.islands ?? []) {
        const at = toScreen(island.x, island.y);
        ctx.beginPath();
        ctx.arc(at.x, at.y, island.r * c.camera.k, 0, Math.PI * 2);
        ctx.fillStyle = palette.raised;
        ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (scene.rings) {
        const at = toScreen(0, 0);
        ctx.strokeStyle = palette.line;
        ctx.lineWidth = 1;
        for (const r of scene.rings) { ctx.beginPath(); ctx.arc(at.x, at.y, r * c.camera.k, 0, Math.PI * 2); ctx.stroke(); }
      }

      // Edges: the quiet ones in one path, then the focused ones, then the disagreements (dashed, red).
      const quiet = new Path2D();
      const lit = new Path2D();
      const clash = new Path2D();
      const faded: { a: Point; b: Point; alpha: number }[] = [];
      for (const edge of graph.edges) {
        const va = visible(edge.a);
        const vb = visible(edge.b);
        if (va <= 0.01 || vb <= 0.01) continue;
        const a = toScreen(scene.x[edge.a]!, scene.y[edge.a]!);
        const b = toScreen(scene.x[edge.b]!, scene.y[edge.b]!);
        const isLit = focus !== null && (edge.a === focus || edge.b === focus);
        const path = edge.kind === 'disagrees' ? clash : isLit ? lit : quiet;
        const weight = path === quiet && scene.edgeWeight ? scene.edgeWeight(edge.a, edge.b) : 1;
        if ((Math.min(va, vb) < 0.99 || weight < 1) && path === quiet) { faded.push({ a, b, alpha: Math.min(va, vb) * weight }); continue; }
        path.moveTo(a.x, a.y);
        path.lineTo(b.x, b.y);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.lineStrong;
      ctx.globalAlpha = 1 - fade.current * 0.75;
      ctx.stroke(quiet);
      for (const { a, b, alpha } of faded) {
        ctx.globalAlpha = alpha * (1 - fade.current * 0.75);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = palette.muted;
      ctx.lineWidth = 1.25;
      ctx.stroke(lit);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = palette.down;
      ctx.lineWidth = 1.5;
      ctx.stroke(clash);
      ctx.setLineDash([]);

      // Nodes.
      for (let i = 0; i < graph.nodes.length; i++) {
        const v = visible(i);
        if (v <= 0.01) continue;
        const at = toScreen(scene.x[i]!, scene.y[i]!);
        if (at.x < -20 || at.y < -20 || at.x > c.width + 20 || at.y > c.height + 20) continue;
        const r = screenRadius(i) * (0.4 + 0.6 * v);
        const pulse = scene.pulse ? scene.pulse[i]! : 0;
        if (pulse > 0) {
          ctx.beginPath();
          ctx.arc(at.x, at.y, r + 2 + (1 - pulse) * 14, 0, Math.PI * 2);
          ctx.strokeStyle = palette.up;
          ctx.globalAlpha = pulse * 0.9;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.globalAlpha = v * dim(i);
        ctx.beginPath();
        ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
        ctx.fillStyle = i === focus ? palette.ink : near.has(i) ? palette.ink : graph.nodes[i]!.area === 'identity' ? palette.ink : palette.muted;
        ctx.fill();
        if (graph.nodes[i]!.disputed) {
          ctx.strokeStyle = palette.down;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(at.x, at.y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
        }
        if (i === selectedRef.current) {
          ctx.strokeStyle = palette.ink;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(at.x, at.y, r + (graph.nodes[i]!.disputed ? 5.5 : 3.5), 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // Names: the focus and its neighbours first, then what the view always names, then the most used pages once
      // they are big enough on screen. A name that would overlap one already drawn is skipped.
      ctx.font = '500 11.5px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      const taken: [number, number, number, number][] = [];
      const order = graph.nodes.map((_, i) => i).sort((a, b) => {
        const rank = (i: number): number => (i === focus ? 3 : near.has(i) ? 2 : scene.labelled?.(i) ? 1 : 0);
        return rank(b) - rank(a) || graph.nodes[b]!.uses - graph.nodes[a]!.uses;
      });
      for (const i of order) {
        const v = visible(i);
        if (v < 0.5) continue;
        const forced = i === focus || (near.has(i) && fade.current > 0.5) || scene.labelled?.(i);
        if (!forced && screenRadius(i) < 9) continue;
        if (near.size && !near.has(i) && fade.current > 0.5) continue;
        const at = toScreen(scene.x[i]!, scene.y[i]!);
        const text = graph.nodes[i]!.label;
        const w = ctx.measureText(text).width;
        const top = at.y + screenRadius(i) + 4;
        const box: [number, number, number, number] = [at.x - w / 2 - 2, top - 1, at.x + w / 2 + 2, top + 14];
        if (taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
        taken.push(box);
        ctx.globalAlpha = v * dim(i);
        ctx.strokeStyle = palette.canvas;
        ctx.lineWidth = 3;
        ctx.strokeText(text, at.x, top);
        ctx.fillStyle = i === focus ? palette.ink : palette.muted;
        ctx.fillText(text, at.x, top);
      }
      ctx.globalAlpha = 1;

      // Island names on top, so nodes never hide them.
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
      for (const island of scene.islands ?? []) {
        const at = toScreen(island.x, island.y - island.r);
        ctx.strokeStyle = palette.canvas;
        ctx.lineWidth = 4;
        ctx.strokeText(island.label, at.x, at.y + 8);
        ctx.fillStyle = palette.ink;
        ctx.fillText(island.label, at.x, at.y + 8);
      }

      samples.push(performance.now() - started);
      if (samples.length > 60) samples.shift();
      c.frameMs = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
      if (moving || cameraMoving || fading) frame = requestAnimationFrame(draw);
    };

    c.invalidate = () => { if (!frame && !disposed) frame = requestAnimationFrame(draw); };

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = rect.width;
      c.height = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      c.invalidate();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    // A theme change (System, or the app's own setting) redraws with the new colours.
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const retheme = (): void => { palette = readPalette(probe); c.invalidate(); };
    scheme.addEventListener('change', retheme);
    const themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Pointer: hover names a node, a click selects it, dragging empty space pans, dragging a node moves it (web view).
    const hit = (sx: number, sy: number): number | null => {
      let best: number | null = null;
      let bestDistance = Infinity;
      for (let i = 0; i < graph.nodes.length; i++) {
        if (c.scene.alpha && c.scene.alpha[i]! < 0.5) continue;
        const at = toScreen(c.scene.x[i]!, c.scene.y[i]!);
        const d = Math.hypot(at.x - sx, at.y - sy);
        if (d < screenRadius(i) + 5 && d < bestDistance) { best = i; bestDistance = d; }
      }
      return best;
    };
    let press: { sx: number; sy: number; node: number | null; moved: boolean; camera: Camera } | null = null;
    const local = (event: PointerEvent | WheelEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onPointerDown = (event: PointerEvent): void => {
      const at = local(event);
      press = { sx: at.x, sy: at.y, node: hit(at.x, at.y), moved: false, camera: { ...c.camera } };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      const at = local(event);
      if (!press) {
        const over = hit(at.x, at.y);
        if (over !== hover.current) { hover.current = over; canvas.style.cursor = over === null ? 'grab' : 'pointer'; c.invalidate(); }
        return;
      }
      if (Math.hypot(at.x - press.sx, at.y - press.sy) > 4) press.moved = true;
      if (!press.moved) return;
      if (press.node !== null && callbacks.current.onDrag) {
        callbacks.current.onDrag(press.node, toWorld(at.x, at.y));
        c.invalidate();
        return;
      }
      canvas.style.cursor = 'grabbing';
      c.userMoved = true;
      c.camera.x = press.camera.x - (at.x - press.sx) / c.camera.k;
      c.camera.y = press.camera.y - (at.y - press.sy) / c.camera.k;
      c.target.x = c.camera.x;
      c.target.y = c.camera.y;
      c.invalidate();
    };
    const onPointerUp = (): void => {
      if (!press) return;
      if (!press.moved) callbacks.current.onSelect(press.node);
      if (press.moved && press.node !== null) callbacks.current.onDrag?.(press.node, null);
      canvas.style.cursor = 'grab';
      press = null;
    };
    const onLeave = (): void => { if (hover.current !== null) { hover.current = null; c.invalidate(); } };
    const zoomAt = (sx: number, sy: number, factor: number): void => {
      const before = toWorld(sx, sy);
      c.userMoved = true;
      c.camera.k = c.target.k = Math.min(8, Math.max(0.08, c.camera.k * factor));
      const after = toWorld(sx, sy);
      c.camera.x += before.x - after.x;
      c.camera.y += before.y - after.y;
      c.target.x = c.camera.x;
      c.target.y = c.camera.y;
      c.invalidate();
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const at = local(event);
      if (event.ctrlKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) zoomAt(at.x, at.y, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025)));
      else { c.camera.x += event.deltaX / c.camera.k; c.target.x = c.camera.x; c.invalidate(); }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === '+' || event.key === '=') zoomAt(c.width / 2, c.height / 2, 1.25);
      else if (event.key === '-') zoomAt(c.width / 2, c.height / 2, 0.8);
      else if (event.key === '0') callbacks.current.onFit();
      else if (event.key === 'Escape') callbacks.current.onSelect(null);
      else return;
      event.preventDefault();
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      scheme.removeEventListener('change', retheme);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKey);
      c.invalidate = () => {};
    };
  }, [graph, controller]);

  useEffect(() => { controller.current.invalidate(); }, [selected, controller]);

  return (
    <>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={label}
        className="block h-full w-full cursor-grab touch-none rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      />
      <span ref={probeRef} aria-hidden className="hidden" />
    </>
  );
};
