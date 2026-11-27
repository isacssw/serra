// The video's building blocks: Serra's dark tokens (app/renderer/styles.css), motion helpers and the shared pieces every
// beat uses (background, headline, card, node, the mark). Colour is only for meaning, as in the app: green is "up".
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BRAND_ICONS, type BrandId } from '../../../app/renderer/ui/brand-icons.ts';

export const C = {
  canvas: '#09090b',
  panel: '#0f0f11',
  raised: '#16161a',
  overlay: '#1c1c21',
  control: '#18181c',
  field: '#0a0a0c',
  line: '#ffffff12',
  lineStrong: '#ffffff1f',
  lineControl: '#ffffff5c',
  ink: '#ececef',
  muted: '#a1a1aa',
  faint: '#8b8b95',
  up: '#3ecf8e',
  warn: '#f5a524',
  mark: '#f2f1ec',
  sun: '#22c55e',
} as const;

export const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", system-ui, sans-serif';
export const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** Expo-out: fast start, long soft landing. */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0 → 1 from `start` over `dur` frames, eased. */
export const useProgress = (start: number, dur = 18, ease = easeOut): number => {
  const frame = useCurrentFrame();
  return interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
};

export const progressAt = (frame: number, start: number, dur = 18, ease = easeOut): number =>
  interpolate(frame, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });

/** Fade, rise and unblur in. */
export const appear = (p: number, rise = 18): CSSProperties => ({
  opacity: p,
  transform: `translateY(${(1 - p) * rise}px)`,
  filter: p < 1 ? `blur(${(1 - p) * 6}px)` : undefined,
});

export const useSquare = (): boolean => {
  const { width, height } = useVideoConfig();
  return width === height;
};

/** Near-black, a fine dot grid, and a soft glow behind the active element. */
export const Backdrop = ({ glow = { x: 50, y: 52, size: 900, color: '62, 207, 142', strength: 0.1 } }: {
  glow?: { x: number; y: number; size: number; color: string; strength: number };
}) => (
  <AbsoluteFill style={{ background: C.canvas }}>
    <AbsoluteFill
      style={{
        backgroundImage: 'radial-gradient(circle, #ffffff1a 1.1px, transparent 1.3px)',
        backgroundSize: '28px 28px',
        backgroundPosition: '14px 14px',
        maskImage: 'radial-gradient(ellipse 75% 70% at 50% 50%, #000 30%, transparent 100%)',
      }}
    />
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle ${glow.size / 2}px at ${glow.x}% ${glow.y}%, rgba(${glow.color}, ${glow.strength}) 0%, rgba(${glow.color}, ${glow.strength * 0.35}) 45%, transparent 100%)`,
      }}
    />
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse 90% 90% at 50% 50%, transparent 55%, #000000a0 100%)' }} />
  </AbsoluteFill>
);

/** A step counter or an uppercase eyebrow, a title and a grey subhead, each entering on its own beat. */
export const Headline = ({ eyebrow, title, sub, delay = 0, top }: { eyebrow?: string; title: ReactNode; sub?: string; delay?: number; top?: number }) => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const e = progressAt(frame, delay, 16);
  const t = progressAt(frame, delay + 3, 20);
  const s = progressAt(frame, delay + 9, 20);
  return (
    <div style={{ position: 'absolute', top: top ?? (square ? 92 : 104), left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center', padding: '0 64px' }}>
      {eyebrow && (
        <div style={{ ...appear(e, 8), fontFamily: MONO, fontSize: square ? 20 : 21, letterSpacing: '0.18em', color: C.up, textTransform: 'uppercase' }}>{eyebrow}</div>
      )}
      <div style={{ ...appear(t, 22), fontFamily: SANS, fontWeight: 700, fontSize: square ? 66 : 76, letterSpacing: '-0.035em', lineHeight: 1.04, color: C.ink }}>{title}</div>
      {sub && <div style={{ ...appear(s, 12), fontFamily: SANS, fontSize: square ? 27 : 29, color: C.muted, letterSpacing: '-0.01em' }}>{sub}</div>}
    </div>
  );
};

/** Where a beat's picture sits: centred below the headline, scaled down a step in the square cut. */
export const Stage = ({ children, y = 0, scale = 1 }: { children: ReactNode; y?: number; scale?: number }) => {
  const square = useSquare();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ transform: `translateY(${(square ? 70 : 90) + y}px) scale(${(square ? 0.82 : 1.15) * scale})` }}>{children}</div>
    </AbsoluteFill>
  );
};

export const Card = ({ children, style, glow = false }: { children: ReactNode; style?: CSSProperties; glow?: boolean }) => (
  <div
    style={{
      background: `linear-gradient(180deg, ${C.raised} 0%, ${C.panel} 100%)`,
      border: `1px solid ${glow ? '#3ecf8e66' : C.lineStrong}`,
      borderRadius: 18,
      boxShadow: `inset 0 1px 0 #ffffff0d, 0 30px 80px -30px #000000e0${glow ? ', 0 0 0 4px #3ecf8e14, 0 0 60px -10px #3ecf8e40' : ''}`,
      fontFamily: SANS,
      color: C.ink,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Brand = ({ id, size = 22, color = C.ink }: { id: BrandId; size?: number; color?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={color} aria-hidden>
    <path d={BRAND_ICONS[id].path} />
  </svg>
);

/** An icon in a rounded tile, as the app's cards show them. */
export const Tile = ({ children, size = 52, style }: { children: ReactNode; size?: number; style?: CSSProperties }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.27, background: C.overlay, border: `1px solid ${C.lineStrong}`, display: 'grid', placeItems: 'center', flexShrink: 0, ...style }}>
    {children}
  </div>
);

export const Dot = ({ color = C.up, size = 9, pulse = 0 }: { color?: string; size?: number; pulse?: number }) => (
  <span style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', boxShadow: `0 0 0 ${pulse * 6}px ${color}22, 0 0 ${8 + pulse * 10}px ${color}80`, flexShrink: 0 }} />
);

/** Text typed in, one character per `perChar` frames from `start`, with a caret while it types. */
export const Typed = ({ text, start, perChar = 1.2, caret = true, style }: { text: string; start: number; perChar?: number; caret?: boolean; style?: CSSProperties }) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor((frame - start) / perChar)));
  const typing = frame >= start - 6 && n < text.length;
  return (
    <span style={style}>
      {text.slice(0, n)}
      {caret && (typing || (n === text.length && Math.floor(frame / 8) % 2 === 0 && frame < start + text.length * perChar + 30)) && (
        <span style={{ display: 'inline-block', width: 2, height: '1.05em', background: C.ink, marginLeft: 2, transform: 'translateY(0.18em)', borderRadius: 1 }} />
      )}
    </span>
  );
};

/** Frames at which each character of a typed string lands, for the key sounds. */
export const keyFrames = (text: string, start: number, perChar = 1.2, every = 2): number[] =>
  Array.from({ length: text.length }, (_, i) => Math.floor(start + (i + 1) * perChar)).filter((_, i) => i % every === 0 && text[i] !== ' ');

/** Serra's mark: a switchback trail that forms an S, and the sun at the summit (assets/brand). Draws itself in. */
export const SerraMark = ({ size = 120, draw = 1, sun = 1, sunColor = C.sun }: { size?: number; draw?: number; sun?: number; sunColor?: string }) => {
  const LEN = 1060;
  return (
    <svg viewBox="90 80 320 360" width={size * (320 / 360)} height={size} aria-hidden style={{ overflow: 'visible' }}>
      <path
        d="M306 150 L172 191 C118 208 117 262 172 272 L330 302 C380 311 380 356 330 365 L137 398"
        fill="none"
        stroke={C.mark}
        strokeWidth={44}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={LEN}
        strokeDashoffset={LEN * (1 - draw)}
      />
      <circle cx={374} cy={122} r={28 * sun} fill={sunColor} style={{ filter: `drop-shadow(0 0 ${18 * sun}px ${sunColor}aa)` }} />
    </svg>
  );
};

/** The wordmark, cut from assets/brand/serra-lockup.png (scripts/README). `reveal` wipes it in from the left. */
export const Wordmark = ({ height = 100, reveal = 1 }: { height?: number; reveal?: number }) => (
  <div style={{ height, width: height * (960 / 280) * 0.95, overflow: 'hidden', clipPath: `inset(0 ${(1 - reveal) * 100}% 0 0)` }}>
    <Img src={staticFile('brand/wordmark.png')} style={{ height, width: height * (960 / 280), objectFit: 'contain', marginLeft: -height * 0.05 }} />
  </div>
);

/** Mark and wordmark side by side, in the lockup's proportions. */
export const Lockup = ({ height = 120, draw = 1, sun = 1, reveal = 1 }: { height?: number; draw?: number; sun?: number; reveal?: number }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: height * 0.32 }}>
    <SerraMark size={height * 1.2} draw={draw} sun={sun} />
    <Wordmark height={height * 0.98} reveal={reveal} />
  </div>
);

/** A small rounded label: "Draft", "Default", "New". */
export const Pill = ({ children, color = C.muted, bg = C.overlay, style }: { children: ReactNode; color?: string; bg?: string; style?: CSSProperties }) => (
  <span style={{ fontFamily: SANS, fontSize: 17, fontWeight: 500, color, background: bg, border: `1px solid ${C.lineStrong}`, borderRadius: 999, padding: '4px 12px', whiteSpace: 'nowrap', ...style }}>{children}</span>
);

/** A curved connector with a glowing pulse travelling along it. `p` draws it; `flow` moves the pulse. */
export const Wire = ({ from, to, p = 1, flow = -1, lit = true }: { from: [number, number]; to: [number, number]; p?: number; flow?: number; lit?: boolean }) => {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const mx = (x1 + x2) / 2;
  const d = `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  const len = Math.hypot(x2 - x1, y2 - y1) * 1.25;
  return (
    <g>
      <path d={d} fill="none" stroke="#ffffff14" strokeWidth={3} />
      <path d={d} fill="none" stroke={lit ? C.up : C.lineControl} strokeOpacity={lit ? 0.75 : 0.5} strokeWidth={2.5} strokeDasharray={len} strokeDashoffset={len * (1 - p)} style={{ filter: lit ? `drop-shadow(0 0 6px ${C.up})` : undefined }} />
      {flow >= 0 && flow <= 1 && p >= 1 && (
        <path d={d} fill="none" stroke="#d9ffe9" strokeWidth={4} strokeLinecap="round" strokeDasharray={`28 ${len}`} strokeDashoffset={-flow * len + 14} style={{ filter: `drop-shadow(0 0 8px ${C.up})` }} />
      )}
      <circle cx={x1} cy={y1} r={5} fill={lit ? C.up : C.faint} opacity={p > 0 ? 1 : 0} />
      <circle cx={x2} cy={y2} r={5} fill={lit ? C.up : C.faint} opacity={p >= 1 ? 1 : 0} />
    </g>
  );
};

/** A node on the graph: an icon tile, a name and a status line. */
export const Node = ({ icon, name, status, statusColor = C.muted, dot, glow = false, width = 330, style, right }: {
  icon: ReactNode; name: string; status?: ReactNode; statusColor?: string; dot?: string; glow?: boolean; width?: number; style?: CSSProperties; right?: ReactNode;
}) => (
  <Card glow={glow} style={{ width, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 16, borderRadius: 16, ...style }}>
    <Tile size={54}>{icon}</Tile>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{name}</div>
      {status && (
        <div style={{ fontSize: 18, color: statusColor, display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
          {dot && <Dot color={dot} size={8} />}
          {status}
        </div>
      )}
    </div>
    {right}
  </Card>
);

/** A beat's own clock: fades in over the first frames and out over the last, so cuts are soft crossfades. */
export const Beat = ({ len, children, fadeIn = 8, fadeOut = 8 }: { len: number; children: ReactNode; fadeIn?: number; fadeOut?: number }) => {
  const frame = useCurrentFrame();
  const o = Math.min(
    fadeIn ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1,
    fadeOut ? interpolate(frame, [len - fadeOut, len], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1,
  );
  const blur = (1 - o) * 8;
  return <AbsoluteFill style={{ opacity: o, filter: blur > 0.05 ? `blur(${blur}px)` : undefined }}>{children}</AbsoluteFill>;
};

/** A slow camera move over a beat: scale and drift, eased. */
export const Camera = ({ len, from = 1, to = 1.05, x = 0, y = 0, children }: { len: number; from?: number; to?: number; x?: number; y?: number; children: ReactNode }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, len], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easeInOut });
  return <AbsoluteFill style={{ transform: `translate(${x * p}px, ${y * p}px) scale(${from + (to - from) * p})` }}>{children}</AbsoluteFill>;
};
