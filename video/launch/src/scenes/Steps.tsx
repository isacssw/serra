// Beats 3–5, the three steps: ask in Slack, it runs on your Mac in a fresh worktree, a draft PR comes back.
import type { ReactNode } from 'react';
import { Check, GitPullRequestDraft, Layers, LoaderCircle } from 'lucide-react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Brand, C, Card, Dot, Headline, MONO, Node, Pill, SerraMark, Stage, Typed, Wire, appear, progressAt, useSquare } from '../kit.tsx';

export const ASK_TEXT = 'add an empty state to the invoices table';
export const ASK_TYPE_START = 12;
export const ASK_PER_CHAR = 0.9;
export const ASK_SEND = 54;
export const ASK_REACT = 66;

const Mention = () => (
  <span style={{ background: '#3ecf8e24', color: '#7ee2b4', borderRadius: 6, padding: '1px 6px', fontWeight: 600 }}>@Friday</span>
);

const Message = ({ who, children, time = 'now', bot = false }: { who: string; children: ReactNode; time?: string; bot?: boolean }) => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
    <div style={{ width: 46, height: 46, borderRadius: 11, background: bot ? C.mark : C.overlay, border: `1px solid ${C.lineStrong}`, display: 'grid', placeItems: 'center', fontSize: 20, fontWeight: 600, color: C.muted, flexShrink: 0, overflow: 'hidden' }}>
      {bot ? <div style={{ background: '#1a1a1c', width: '100%', height: '100%', display: 'grid', placeItems: 'center' }}><SerraMark size={30} /></div> : who[0]}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 21, fontWeight: 700 }}>{who}</span>
        {bot && <span style={{ fontSize: 13, fontWeight: 700, color: C.muted, background: C.overlay, borderRadius: 4, padding: '1px 5px', letterSpacing: '0.04em' }}>APP</span>}
        <span style={{ fontSize: 16, color: C.faint }}>{time}</span>
      </div>
      <div style={{ fontSize: 22, color: C.ink, lineHeight: 1.45 }}>{children}</div>
    </div>
  </div>
);

export const Ask = () => {
  const frame = useCurrentFrame();
  const sent = frame >= ASK_SEND;
  const post = progressAt(frame, ASK_SEND, 14);
  const react = progressAt(frame, ASK_REACT, 12);
  const card = progressAt(frame, 4, 20);
  return (
    <AbsoluteFill>
      <Headline eyebrow="01 / 03" title="Ask in Slack." sub="Mention the bot, or DM it." />
      <Stage y={20}>
        <Card style={{ ...appear(card, 30), width: 1000, padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 26px', borderBottom: `1px solid ${C.line}`, fontSize: 22, fontWeight: 600 }}>
            <Brand id="slack" size={22} /># web
          </div>
          <div style={{ padding: '24px 26px', display: 'flex', flexDirection: 'column', gap: 22, minHeight: 150, justifyContent: 'flex-end' }}>
            <Message who="Maya" time="9:41">Shipping the invoices page today 🚀</Message>
            {sent && (
              <div style={{ ...appear(post, 16) }}>
                <Message who="Priya"><Mention /> {ASK_TEXT}</Message>
                <div style={{ marginLeft: 62, marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 19, border: `1px solid ${react > 0 ? '#3ecf8e66' : 'transparent'}`, background: '#3ecf8e14', borderRadius: 999, padding: '3px 12px', opacity: react, transform: `scale(${0.6 + 0.4 * react})`, transformOrigin: 'left center' }}>
                  <span>👀</span><span style={{ color: C.ink, fontWeight: 600 }}>1</span>
                </div>
              </div>
            )}
          </div>
          <div style={{ margin: '0 22px 22px', border: `1px solid ${C.lineControl}`, borderRadius: 12, padding: '16px 18px', fontSize: 22, display: 'flex', alignItems: 'center', gap: 12, background: C.field, minHeight: 62 }}>
            {sent ? (
              <span style={{ color: C.faint }}>Message #web</span>
            ) : (
              <span style={{ color: C.ink }}>
                {frame >= ASK_TYPE_START - 4 ? <Mention /> : <span style={{ color: C.faint }}>Message #web</span>}{' '}
                <Typed text={ASK_TEXT} start={ASK_TYPE_START} perChar={ASK_PER_CHAR} />
              </span>
            )}
            <div style={{ marginLeft: 'auto', width: 40, height: 40, borderRadius: 10, display: 'grid', placeItems: 'center', background: frame > ASK_SEND - 10 && !sent ? C.up : C.overlay, color: frame > ASK_SEND - 10 && !sent ? C.canvas : C.faint, fontSize: 20, transform: `scale(${frame >= ASK_SEND - 2 && frame < ASK_SEND + 3 ? 0.9 : 1})` }}>➤</div>
          </div>
        </Card>
      </Stage>
    </AbsoluteFill>
  );
};

const RUN_LINES = [
  { at: 34, text: 'New T3 thread in acme/project' },
  { at: 46, text: 'Worktree  friday/invoices-empty-state' },
  { at: 58, text: 'Claude is working…' },
] as const;
export const RUN_LINE_FRAMES = RUN_LINES.map((l) => l.at);

export const Run = () => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const n1 = progressAt(frame, 2, 18);
  const n2 = progressAt(frame, 8, 18);
  const n3 = progressAt(frame, 20, 18);
  const w1 = progressAt(frame, 10, 14);
  const w2 = progressAt(frame, 22, 14);
  const term = progressAt(frame, 28, 16);
  const W = square ? 1200 : 1400;
  const nodeW = square ? 330 : 360;
  return (
    <AbsoluteFill>
      <Headline eyebrow="02 / 03" title="It runs on your Mac." sub="A fresh worktree. Your logins. No server." />
      <Stage y={square ? 20 : 30} scale={square ? 0.9 : 0.92}>
        <div style={{ width: W, height: 560, position: 'relative' }}>
          <svg width={W} height={200} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
            <Wire from={[nodeW, 100]} to={[W / 2 - 190, 100]} p={w1} flow={((frame - 24) % 40) / 40} />
            <Wire from={[W / 2 + 190, 100]} to={[W - nodeW, 100]} p={w2} flow={((frame - 36) % 40) / 40} />
          </svg>
          <div style={{ position: 'absolute', left: 0, top: 54, ...appear(n1, 14) }}>
            <Node width={nodeW} icon={<Brand id="slack" size={26} />} name="#web" status="Priya" />
          </div>
          <div style={{ position: 'absolute', left: W / 2 - 190, top: 40, ...appear(n2, 14) }}>
            <Node width={380} glow icon={<SerraMark size={32} />} name="Friday" status="Serra · up" dot={C.up} style={{ padding: '24px 22px' }} />
          </div>
          <div style={{ position: 'absolute', right: 0, top: 54, ...appear(n3, 14) }}>
            <Node width={nodeW} icon={<Layers size={26} color={C.ink} />} name="T3 Code" status="acme/project" />
          </div>
          <Card style={{ position: 'absolute', left: W / 2 - 420, top: 250, width: 840, padding: '26px 30px', fontFamily: MONO, fontSize: 23, display: 'flex', flexDirection: 'column', gap: 16, ...appear(term, 20) }}>
            {RUN_LINES.map((line, i) => {
              const shown = frame >= line.at - 2;
              const last = i === RUN_LINES.length - 1;
              return (
                <div key={line.text} style={{ display: 'flex', alignItems: 'center', gap: 14, opacity: shown ? 1 : 0, color: last ? C.ink : C.muted, height: 30 }}>
                  {last ? (
                    <LoaderCircle size={22} color={C.up} style={{ transform: `rotate(${frame * 12}deg)` }} />
                  ) : (
                    <Check size={22} color={C.up} />
                  )}
                  <Typed text={line.text} start={line.at} perChar={0.55} caret={false} />
                </div>
              );
            })}
          </Card>
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

export const PR_CARD_AT = 18;
export const PR_FOLLOW_AT = 44;
export const PR_FOLLOW_TEXT = 'make the button say Create invoice';
export const PR_PUSHED_AT = 74;

export const Pr = () => {
  const frame = useCurrentFrame();
  const card = progressAt(frame, 2, 20);
  const reply = progressAt(frame, 8, 18);
  const pr = progressAt(frame, PR_CARD_AT, 16);
  const follow = progressAt(frame, PR_FOLLOW_AT - 4, 14);
  const pushed = progressAt(frame, PR_PUSHED_AT, 14);
  return (
    <AbsoluteFill>
      <Headline eyebrow="03 / 03" title="A draft PR comes back." sub="Reply in the thread to keep going." />
      <Stage y={34}>
        <Card style={{ ...appear(card, 30), width: 1000, padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 26px', borderBottom: `1px solid ${C.line}`, fontSize: 21, fontWeight: 600 }}>
            Thread <span style={{ color: C.faint, fontWeight: 400 }}># web</span>
          </div>
          <div style={{ padding: '22px 26px 26px', display: 'flex', flexDirection: 'column', gap: 20, height: 470, boxSizing: 'border-box' }}>
            <div style={{ fontSize: 19 }}>
              <Message who="Priya" time="9:42"><span style={{ fontSize: 20 }}>@Friday {ASK_TEXT}</span></Message>
            </div>
            <div style={appear(reply, 14)}>
              <Message who="Friday" bot time="9:51">
                Added an empty state to the invoices table, with a test.
                <div style={{ ...appear(pr, 10), marginTop: 12, display: 'flex', alignItems: 'center', gap: 16, border: `1px solid ${C.lineStrong}`, borderLeft: `4px solid ${C.faint}`, borderRadius: 10, padding: '14px 18px', background: C.raised, width: 760 }}>
                  <GitPullRequestDraft size={26} color={C.muted} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 21, fontWeight: 600 }}>Add an empty state to the invoices table</span>
                    <span style={{ fontSize: 17, color: C.faint, display: 'flex', alignItems: 'center', gap: 8 }}><Brand id="github" size={16} color={C.faint} />acme/project #128</span>
                  </div>
                  <Pill style={{ marginLeft: 'auto' }}>Draft</Pill>
                </div>
              </Message>
            </div>
            {frame >= PR_FOLLOW_AT - 4 && (
              <div style={appear(follow, 12)}>
                <Message who="Priya" time="9:53"><Typed text={PR_FOLLOW_TEXT} start={PR_FOLLOW_AT} perChar={0.6} /></Message>
              </div>
            )}
            {frame >= PR_PUSHED_AT && (
              <div style={appear(pushed, 12)}>
                <Message who="Friday" bot time="9:55">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>Pushed to the same PR. <Dot size={9} /></span>
                </Message>
              </div>
            )}
          </div>
        </Card>
      </Stage>
    </AbsoluteFill>
  );
};

