// The whole video: ten beats on one timeline, the music bed, and each UI sound placed on the frame its action happens.
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { Backdrop, Beat, Camera, SANS, keyFrames } from './kit.tsx';
import { Hook, Logo } from './scenes/Intro.tsx';
import { AGENT_SWITCH_AT, Agents, CHAT_REPLY, CHAT_REPLY_AT, CHAT_TOOL_FRAMES, Chat, KNOW_APPROVE_AT, Knowledge } from './scenes/Payoff.tsx';
import { APP_TABS, App, End } from './scenes/Outro.tsx';
import { ASK_PER_CHAR, ASK_REACT, ASK_SEND, ASK_TEXT, ASK_TYPE_START, Ask, PR_CARD_AT, PR_FOLLOW_AT, PR_FOLLOW_TEXT, PR_PUSHED_AT, Pr, RUN_LINE_FRAMES, Run } from './scenes/Steps.tsx';
import { BEATS, TOTAL_FRAMES } from './timing.ts';

export type LaunchProps = { music: boolean; sfx: boolean };

const XF = 6; // each beat starts this many frames early and overlaps the one before: a soft crossfade.

type Cue = { at: number; sound: 'click' | 'key' | 'whoosh' | 'pop' | 'chime'; volume?: number };

const cues = (): Cue[] => {
  const b = BEATS;
  const list: Cue[] = [];
  // A whoosh into every beat after the first, landing on the cut.
  for (const beat of [b.logo, b.ask, b.run, b.pr, b.agents, b.chat, b.knowledge, b.app, b.end]) list.push({ at: beat.from - 8, sound: 'whoosh', volume: 0.5 });
  list.push(...[4, 12, 20].map((f) => ({ at: b.hook.from + f, sound: 'pop' as const, volume: 0.45 })));
  list.push({ at: b.logo.from + 16, sound: 'chime', volume: 0.5 });
  list.push(...keyFrames(ASK_TEXT, b.ask.from + ASK_TYPE_START, ASK_PER_CHAR, 2).map((f) => ({ at: f, sound: 'key' as const, volume: 0.55 })));
  list.push({ at: b.ask.from + ASK_SEND, sound: 'click', volume: 0.7 });
  list.push({ at: b.ask.from + ASK_REACT, sound: 'pop', volume: 0.6 });
  list.push(...RUN_LINE_FRAMES.map((f) => ({ at: b.run.from + f, sound: 'click' as const, volume: 0.4 })));
  list.push({ at: b.pr.from + PR_CARD_AT, sound: 'chime', volume: 0.55 });
  list.push(...keyFrames(PR_FOLLOW_TEXT, b.pr.from + PR_FOLLOW_AT, 0.6, 3).map((f) => ({ at: f, sound: 'key' as const, volume: 0.45 })));
  list.push({ at: b.pr.from + PR_PUSHED_AT, sound: 'pop', volume: 0.5 });
  list.push(...[0, 1, 2, 3, 4, 5].map((i) => ({ at: b.agents.from + 10 + i * 4, sound: 'pop' as const, volume: 0.25 })));
  list.push({ at: b.agents.from + AGENT_SWITCH_AT, sound: 'click', volume: 0.7 });
  list.push(...CHAT_TOOL_FRAMES.map((f) => ({ at: b.chat.from + f, sound: 'pop' as const, volume: 0.35 })));
  list.push(...keyFrames(CHAT_REPLY, b.chat.from + CHAT_REPLY_AT, 0.32, 6).map((f) => ({ at: f, sound: 'key' as const, volume: 0.3 })));
  list.push({ at: b.knowledge.from + KNOW_APPROVE_AT, sound: 'click', volume: 0.7 });
  list.push({ at: b.knowledge.from + KNOW_APPROVE_AT + 18, sound: 'pop', volume: 0.5 });
  list.push(...APP_TABS.slice(1).map((f) => ({ at: b.app.from + f, sound: 'click' as const, volume: 0.6 })));
  list.push({ at: b.end.from + 4, sound: 'chime', volume: 0.6 });
  return list;
};

const Music = () => {
  const frame = useCurrentFrame();
  // The last second fades to silence with the picture.
  const volume = interpolate(frame, [TOTAL_FRAMES - 40, TOTAL_FRAMES - 4], [0.9, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <Audio src={staticFile('audio/music.wav')} volume={volume} />;
};

const SCENES = [
  { beat: BEATS.hook, el: <Hook />, cam: { from: 1, to: 1.04 } },
  { beat: BEATS.logo, el: <Logo />, cam: { from: 1, to: 1.03 } },
  { beat: BEATS.ask, el: <Ask />, cam: { from: 1, to: 1.04 } },
  { beat: BEATS.run, el: <Run />, cam: { from: 1.02, to: 1.07 } },
  { beat: BEATS.pr, el: <Pr />, cam: { from: 1, to: 1.035 } },
  { beat: BEATS.agents, el: <Agents />, cam: { from: 1.08, to: 1.0 } },
  { beat: BEATS.chat, el: <Chat />, cam: { from: 1, to: 1.04 } },
  { beat: BEATS.knowledge, el: <Knowledge />, cam: { from: 1, to: 1.04 } },
  { beat: BEATS.app, el: <App />, cam: { from: 1, to: 1 } },
  { beat: BEATS.end, el: <End />, cam: { from: 1.02, to: 1 } },
] as const;

const GLOWS = [
  { x: 50, y: 62, size: 1100, color: '245, 165, 36', strength: 0.05 },
  { x: 50, y: 48, size: 1000, color: '62, 207, 142', strength: 0.11 },
] as const;

export const Launch = ({ music, sfx }: LaunchProps) => {
  const frame = useCurrentFrame();
  // The glow is warm (amber, "needs you") for the problem and turns green ("up") with the logo.
  const warm = interpolate(frame, [BEATS.logo.from - 10, BEATS.logo.from + 8], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const amber = GLOWS[0];
  return (
    <AbsoluteFill style={{ background: '#09090b', fontFamily: SANS }}>
      <Backdrop glow={{ ...GLOWS[1], strength: GLOWS[1].strength * (1 - warm) }} />
      <AbsoluteFill style={{ opacity: warm, background: `radial-gradient(circle ${amber.size / 2}px at ${amber.x}% ${amber.y}%, rgba(${amber.color}, ${amber.strength}) 0%, transparent 100%)` }} />
      {SCENES.map(({ beat, el, cam }, i) => {
        const from = i === 0 ? 0 : beat.from - XF;
        const len = beat.len + (i === 0 ? 0 : XF) + (i === SCENES.length - 1 ? 0 : XF);
        return (
          <Sequence key={beat.from} from={from} durationInFrames={len} premountFor={10}>
            <Sequence from={i === 0 ? 0 : XF} layout="none">
              <Beat len={beat.len + (i === SCENES.length - 1 ? 0 : XF)} fadeIn={i === 0 ? 0 : 10} fadeOut={i === SCENES.length - 1 ? 22 : 10}>
                <Camera len={beat.len} from={cam.from} to={cam.to}>{el}</Camera>
              </Beat>
            </Sequence>
          </Sequence>
        );
      })}
      {music && <Music />}
      {sfx && cues().filter((cue) => cue.at >= 0 && cue.at < TOTAL_FRAMES).map((cue, i) => (
        <Sequence key={`${cue.sound}-${cue.at}-${i}`} from={cue.at} durationInFrames={40} layout="none">
          <Audio src={staticFile(`audio/${cue.sound}.wav`)} volume={cue.volume ?? 0.6} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
