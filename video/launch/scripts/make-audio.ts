// Synthesizes the launch video's music bed and UI sounds from scratch, so every sample is original (CC0, see
// README.md). No samples, no downloads: oscillators, noise and envelopes, written as 16-bit 48 kHz WAV files to
// public/audio/. Run: pnpm audio. The cue times live in src/timing.ts; this file only reads the tempo and length.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BPM, DROP_S, DURATION_S, OUTRO_S } from '../src/timing.ts';

const RATE = 48000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio');
mkdirSync(OUT, { recursive: true });

// A fixed seed, so a re-run makes the same files.
let seed = 0x5eaa;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
const noise = (): number => rand() * 2 - 1;

const writeWav = (name: string, left: Float32Array, right: Float32Array = left): void => {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i] ?? 0)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i] ?? 0)) * 32767), 46 + i * 4);
  }
  writeFileSync(join(OUT, name), buf);
};

/** Scales to a peak, after a gentle tanh so stacked hits round off instead of clipping. */
const master = (chans: Float32Array[], peak: number, drive = 1): void => {
  let max = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) {
    c[i] = Math.tanh((c[i] ?? 0) * drive);
    max = Math.max(max, Math.abs(c[i] ?? 0));
  }
  const g = max > 0 ? peak / max : 1;
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i] = (c[i] ?? 0) * g;
};

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
// A band-limited saw: a handful of harmonics, enough for warmth without aliasing.
const saw = (phase: number, harmonics: number): number => {
  let s = 0;
  for (let k = 1; k <= harmonics; k++) s += Math.sin(phase * k) / k;
  return s * 0.6;
};

// ---------- Music ----------
const N = Math.round(DURATION_S * RATE);
const L = new Float32Array(N);
const R = new Float32Array(N);
const beat = 60 / BPM;
const add = (i: number, l: number, r = l): void => {
  if (i >= 0 && i < N) {
    L[i] = (L[i] ?? 0) + l;
    R[i] = (R[i] ?? 0) + r;
  }
};

// A minor: Am, F, C, G, one bar (4 beats) each, counted from the drop.
const CHORDS = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]] as const;
const ROOTS = [45, 41, 48, 43] as const;
const chordAt = (t: number): number => {
  const bar = Math.floor((t - DROP_S) / (beat * 4));
  return ((bar % 4) + 4) % 4;
};

// Sidechain: the bed ducks under each kick, which is what makes it "drive".
const duck = (t: number): number => {
  if (t < DROP_S || t >= OUTRO_S) return 1;
  const since = (t - DROP_S) % beat;
  return 0.35 + 0.65 * Math.min(1, since / (beat * 0.6)) ** 0.7;
};

// Pad: three detuned saws per chord tone, through a one-pole low-pass that opens over the intro.
{
  const phases = new Float64Array(9);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < N; i++) {
    const t = i / RATE;
    const chord = CHORDS[t < DROP_S ? 0 : chordAt(t)] ?? CHORDS[0];
    let sl = 0;
    let sr = 0;
    chord.forEach((note, n) => {
      [-0.08, 0, 0.08].forEach((det, d) => {
        const idx = n * 3 + d;
        phases[idx] = (phases[idx] ?? 0) + (2 * Math.PI * hz(note) * 2 ** (det / 12)) / RATE;
        const v = saw(phases[idx] ?? 0, 6);
        if (d === 0) { sl += v * 0.5; sr += v * 0.5; } else if (d === 1) sl += v; else sr += v;
      });
    });
    const open = t < DROP_S ? 0.02 + 0.1 * (t / DROP_S) : t < OUTRO_S ? 0.16 : 0.16 * Math.max(0.15, 1 - (t - OUTRO_S) / 3.5);
    lpL += open * (sl - lpL);
    lpR += open * (sr - lpR);
    const fadeIn = Math.min(1, t / 0.6);
    const fadeOut = Math.min(1, Math.max(0, (DURATION_S - t) / 2.2));
    const g = 0.05 * fadeIn * fadeOut * duck(t);
    add(i, lpL * g, lpR * g);
  }
}

// Riser into the drop: noise through a rising band, plus the reverse swell of the pad.
for (let i = 0; i < Math.round(DROP_S * RATE); i++) {
  const t = i / RATE;
  const p = t / DROP_S;
  const v = noise() * p ** 3 * 0.08;
  add(i, v * (1 - p * 0.3), v * (0.7 + p * 0.3));
}

const kick = (t0: number, gain: number): void => {
  let phase = 0;
  const start = Math.round(t0 * RATE);
  for (let j = 0; j < 0.42 * RATE; j++) {
    const t = j / RATE;
    const f = 48 + 110 * Math.exp(-t * 32);
    phase += (2 * Math.PI * f) / RATE;
    const env = Math.exp(-t * 7.5);
    const click = j < 120 ? noise() * 0.25 * (1 - j / 120) : 0;
    add(start + j, (Math.sin(phase) * env + click) * gain);
  }
};
const hat = (t0: number, gain: number, open = false): void => {
  let prev = 0;
  const start = Math.round(t0 * RATE);
  const len = (open ? 0.16 : 0.045) * RATE;
  const pan = 0.25 * (rand() - 0.5);
  for (let j = 0; j < len; j++) {
    const n = noise();
    const hp = n - prev;
    prev = n;
    const env = Math.exp((-j / RATE) * (open ? 22 : 70));
    add(start + j, hp * env * gain * (1 - pan), hp * env * gain * (1 + pan));
  }
};
const clap = (t0: number, gain: number): void => {
  const start = Math.round(t0 * RATE);
  let bp1 = 0;
  let bp2 = 0;
  for (let j = 0; j < 0.22 * RATE; j++) {
    const t = j / RATE;
    // Three quick bursts, then a tail: the shape of a clap.
    const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 === 0 ? 1 : 0.4) : 1;
    const env = Math.exp(-t * 18) * burst;
    const n = noise();
    bp1 += 0.35 * (n - bp1);
    bp2 += 0.08 * (bp1 - bp2);
    add(start + j, (bp1 - bp2) * env * gain * 1.1, (bp1 - bp2) * env * gain * 0.9);
  }
};

// Drums from the drop to the outro. The last bar before the outro drops the kick for a lift.
for (let t = DROP_S; t < OUTRO_S - 1e-6; t += beat) {
  const n = Math.round((t - DROP_S) / beat);
  const lift = t >= OUTRO_S - beat * 2;
  if (!lift) kick(t, 0.9);
  if (n % 2 === 1) clap(t, 0.32);
  hat(t + beat / 2, 0.16, n % 4 === 3);
  if (t > DROP_S + beat * 8) {
    hat(t + beat / 4, 0.06);
    hat(t + (beat * 3) / 4, 0.06);
  }
}
kick(OUTRO_S, 1);
clap(OUTRO_S, 0.25);

// Bass: offbeat eighths on the chord root, a saw through a low-pass, ducked.
for (let t = DROP_S; t < OUTRO_S - 1e-6; t += beat / 2) {
  const n = Math.round((t - DROP_S) / (beat / 2));
  if (n % 2 === 0) continue;
  const root = ROOTS[chordAt(t)] ?? ROOTS[0];
  const start = Math.round(t * RATE);
  let phase = 0;
  let lp = 0;
  const len = Math.round(beat * 0.45 * RATE);
  for (let j = 0; j < len; j++) {
    const tt = j / RATE;
    phase += (2 * Math.PI * hz(root)) / RATE;
    const env = Math.min(1, j / 200) * Math.exp(-tt * 5) * Math.min(1, (len - j) / 300);
    lp += 0.09 * (saw(phase, 10) - lp);
    add(start + j, (lp * 0.9 + Math.sin(phase) * 0.5) * env * 0.22);
  }
}

// Arp: sixteenth plucks over the chord, from the payoff on, panned left and right in turn.
const ARP_FROM = DROP_S + beat * 22;
for (let t = ARP_FROM; t < OUTRO_S - 1e-6; t += beat / 4) {
  const n = Math.round((t - ARP_FROM) / (beat / 4));
  const chord = CHORDS[chordAt(t)] ?? CHORDS[0];
  const note = (chord[n % 3] ?? 57) + (n % 6 >= 3 ? 12 : 0);
  const start = Math.round(t * RATE);
  const f = hz(note);
  const pan = n % 2 === 0 ? 0.7 : 1.3;
  for (let j = 0; j < 0.18 * RATE; j++) {
    const tt = j / RATE;
    const env = Math.exp(-tt * 22) * Math.min(1, j / 60);
    const v = (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt)) * env * 0.05;
    add(start + j, v * pan, v * (2 - pan));
  }
}

// A soft echo on the whole bed (a ping-pong delay at a dotted eighth) for space.
{
  const d = Math.round(beat * 0.75 * RATE);
  for (let i = d; i < N; i++) {
    L[i] = (L[i] ?? 0) + (R[i - d] ?? 0) * 0.18;
    R[i] = (R[i] ?? 0) + (L[i - d] ?? 0) * 0.18;
  }
}
master([L, R], 0.84, 1.2);
writeWav('music.wav', L, R);

// ---------- UI sounds ----------
const sfx = (name: string, seconds: number, fn: (t: number, j: number) => number, peak: number): void => {
  const buf = new Float32Array(Math.round(seconds * RATE));
  for (let j = 0; j < buf.length; j++) buf[j] = fn(j / RATE, j);
  master([buf], peak);
  writeWav(name, buf);
};

// Click: a short, bright tick with a little body.
sfx('click.wav', 0.06, (t) => (Math.sin(2 * Math.PI * 2400 * t) * 0.6 + Math.sin(2 * Math.PI * 900 * t)) * Math.exp(-t * 160), 0.5);

// Key: a tiny filtered noise tap, for typing.
{
  let lp = 0;
  sfx('key.wav', 0.03, (t) => {
    lp += 0.45 * (noise() - lp);
    return lp * Math.exp(-t * 260);
  }, 0.28);
}

// Whoosh: noise through a band that sweeps up then down, with a swell.
{
  let a = 0;
  let b = 0;
  sfx('whoosh.wav', 0.55, (t) => {
    const p = t / 0.55;
    const cut = 0.02 + 0.25 * Math.sin(Math.PI * p);
    a += cut * (noise() - a);
    b += 0.02 * (a - b);
    return (a - b) * Math.sin(Math.PI * p) ** 2;
  }, 0.4);
}

// Pop: a sine that bends up, for a card or a reaction appearing.
{
  let ph = 0;
  sfx('pop.wav', 0.12, (t) => {
    ph += (2 * Math.PI * (520 + 900 * Math.min(1, t / 0.05))) / RATE;
    return Math.sin(ph) * Math.exp(-t * 34) * Math.min(1, t / 0.003);
  }, 0.4);
}

// Chime: two bell-ish notes (E6 then A6), for the PR coming back and the end card.
sfx('chime.wav', 1.2, (t) => {
  const bell = (f: number, t0: number): number => {
    const tt = t - t0;
    if (tt < 0) return 0;
    return (Math.sin(2 * Math.PI * f * tt) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * tt) * Math.exp(-tt * 6)) * Math.exp(-tt * 4.5);
  };
  return bell(hz(88), 0) * 0.8 + bell(hz(93), 0.09);
}, 0.42);

console.log(`wrote music.wav (${DURATION_S}s, ${BPM} BPM) and click, key, whoosh, pop, chime to ${OUT}`);
