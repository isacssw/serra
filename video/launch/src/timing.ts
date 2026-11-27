// One clock for picture and sound: beats start on the music's beat grid (120 BPM, a beat every 0.5 s).
export const FPS = 30;
export const BPM = 120;
export const DURATION_S = 30;
/** The kick comes in with the logo. */
export const DROP_S = 2.5;
/** Drums stop for the end card. */
export const OUTRO_S = 26;

const s = (seconds: number): number => Math.round(seconds * FPS);

/** Each beat's start and length, in frames. */
export const BEATS = {
  hook: { from: s(0), len: s(2.5) },
  logo: { from: s(2.5), len: s(2) },
  ask: { from: s(4.5), len: s(3) },
  run: { from: s(7.5), len: s(3) },
  pr: { from: s(10.5), len: s(3) },
  agents: { from: s(13.5), len: s(3) },
  chat: { from: s(16.5), len: s(3) },
  knowledge: { from: s(19.5), len: s(3) },
  app: { from: s(22.5), len: s(3.5) },
  end: { from: s(26), len: s(4) },
} as const;

export const TOTAL_FRAMES = s(DURATION_S);
export const sec = s;
