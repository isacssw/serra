// Beats 1–2: the problem (asks in Slack, agents on a Mac, nothing between them), then the logo.
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Brand, C, Card, Dot, Headline, Lockup, MONO, SANS, Stage, appear, progressAt, useSquare } from '../kit.tsx';

const ASKS = [
  { who: 'Maya', text: 'can someone fix the flaky checkout test?' },
  { who: 'Priya', text: 'add an empty state to the invoices table' },
  { who: 'Sam', text: 'what does the billing cron do on month end?' },
] as const;

const Avatar = ({ who }: { who: string }) => (
  <div style={{ width: 40, height: 40, borderRadius: 10, background: C.overlay, border: `1px solid ${C.lineStrong}`, display: 'grid', placeItems: 'center', fontSize: 19, fontWeight: 600, color: C.muted, flexShrink: 0 }}>{who[0]}</div>
);

export const Hook = () => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const laptop = progressAt(frame, 22, 20);
  const gap = progressAt(frame, 40, 16);
  return (
    <AbsoluteFill>
      <Headline
        title={
          <>
            <span style={{ ...appear(progressAt(frame, 2, 18)), display: 'inline-block' }}>The asks are in Slack.</span>
            <br />
            <span style={{ ...appear(progressAt(frame, 24, 18)), display: 'inline-block', color: C.muted }}>The agents are on your Mac.</span>
          </>
        }
      />
      <Stage y={square ? 60 : 70} scale={square ? 1.12 : 0.9}>
        <div style={{ display: 'flex', alignItems: 'center', gap: square ? 70 : 56, flexDirection: square ? 'column' : 'row' }}>
          <Card style={{ width: 620, padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 22, fontWeight: 600 }}>
              <Brand id="slack" size={22} />
              <span># web</span>
            </div>
            {ASKS.map((ask, i) => {
              const p = progressAt(frame, 4 + i * 8, 16);
              return (
                <div key={ask.who} style={{ ...appear(p, 14), display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <Avatar who={ask.who} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 19, fontWeight: 600 }}>{ask.who}</span>
                    <span style={{ fontSize: 20, color: C.muted }}>{ask.text}</span>
                  </div>
                </div>
              );
            })}
          </Card>
          <div style={{ ...appear(gap, 0), display: square ? 'none' : 'flex', alignItems: 'center', gap: 10, width: 120 }}>
            <div style={{ flex: 1, borderTop: `2px dashed ${C.lineControl}` }} />
            <Dot color={C.warn} size={10} pulse={0.5 + 0.5 * Math.sin(frame / 4)} />
            <div style={{ flex: 1, borderTop: `2px dashed ${C.lineControl}` }} />
          </div>
          <div style={{ ...appear(laptop, 24), display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: 460, height: 200, borderRadius: '18px 18px 6px 6px', border: `2px solid ${C.lineControl}`, background: C.panel, padding: 22, display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SANS }}>
              {[
                { name: 'Claude', icon: <Brand id="claude" size={20} /> },
                { name: 'Codex', icon: <span style={{ fontFamily: MONO, fontSize: 17, color: C.ink }}>{'</>'}</span> },
              ].map((agent) => (
                <div key={agent.name} style={{ display: 'flex', alignItems: 'center', gap: 14, background: C.raised, border: `1px solid ${C.line}`, borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: C.overlay, display: 'grid', placeItems: 'center' }}>{agent.icon}</div>
                  <span style={{ fontSize: 21, fontWeight: 600, color: C.ink }}>{agent.name}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 18, color: C.faint, display: 'flex', alignItems: 'center', gap: 8 }}><Dot color={C.faint} size={7} />Idle</span>
                </div>
              ))}
            </div>
            <div style={{ width: 560, height: 16, borderRadius: '2px 2px 14px 14px', border: `2px solid ${C.lineControl}`, borderTop: 'none', background: C.raised }} />
          </div>
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

export const Logo = () => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const draw = progressAt(frame, 0, 22);
  const sun = progressAt(frame, 16, 14);
  const reveal = progressAt(frame, 10, 22);
  const sub = progressAt(frame, 22, 18);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 44 }}>
      <div style={{ transform: `scale(${0.94 + 0.06 * draw})` }}>
        <Lockup height={square ? 120 : 150} draw={draw} sun={sun} reveal={reveal} />
      </div>
      <div style={{ ...appear(sub, 12), fontFamily: SANS, fontSize: square ? 32 : 36, color: C.muted, letterSpacing: '-0.01em', textAlign: 'center', padding: '0 60px' }}>
        The coding agents on your Mac, in Slack.
      </div>
    </AbsoluteFill>
  );
};
