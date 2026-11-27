// Beats 6–8, the payoff: any agent (T3 or ACP), every run as a chat, knowledge it learns with your approval.
import { BookOpen, Check, Code2, FilePen, FileText, Layers, Plus, ShieldCheck, Sparkle, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Brand, C, Card, Dot, Headline, Pill, SerraMark, Stage, Tile, Typed, Wire, appear, progressAt, useSquare } from '../kit.tsx';
import { ASK_TEXT } from './Steps.tsx';

const ink = { size: 26, color: C.ink } as const;
const AGENTS: { name: string; sub: string; icon: ReactNode; dashed?: boolean }[] = [
  { name: 'T3 Code', sub: 'Default', icon: <Layers {...ink} /> },
  { name: 'Claude Code', sub: 'ACP', icon: <Brand id="claude" size={24} /> },
  { name: 'Codex', sub: 'ACP', icon: <Code2 {...ink} /> },
  { name: 'OpenCode', sub: 'ACP', icon: <SquareTerminal {...ink} /> },
  { name: 'Gemini CLI', sub: 'ACP', icon: <Sparkle {...ink} /> },
  { name: 'Your agent', sub: 'Add ACP agent', icon: <Plus {...ink} />, dashed: true },
];
export const AGENT_SWITCH_AT = 56;

const Radio = ({ on }: { on: boolean }) => (
  <span style={{ width: 26, height: 26, borderRadius: '50%', border: `2px solid ${on ? C.up : C.lineControl}`, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
    {on && <span style={{ width: 12, height: 12, borderRadius: '50%', background: C.up }} />}
  </span>
);

export const Agents = () => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const chosen = frame >= AGENT_SWITCH_AT ? 1 : 0;
  const hub = progressAt(frame, 0, 18);
  const W = 1380;
  const rowH = 96;
  const top = 0;
  const cardW = 400;
  const hubY = top + (rowH * 6 - 16) / 2;
  return (
    <AbsoluteFill>
      <Headline title="Bring the agent you use." sub="T3 Code by default, or any ACP agent." />
      <Stage y={square ? 40 : 22} scale={square ? 0.84 : 0.9}>
        <div style={{ width: W, height: rowH * 6, position: 'relative' }}>
          <svg width={W} height={rowH * 6} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
            <Wire from={[300, hubY]} to={[470, hubY]} p={progressAt(frame, 4, 12)} flow={((frame - 10) % 36) / 36} />
            {AGENTS.map((agent, i) => (
              <Wire
                key={agent.name}
                from={[850, hubY]}
                to={[W - cardW, top + i * rowH + (rowH - 16) / 2]}
                p={progressAt(frame, 8 + i * 4, 14)}
                lit={i === chosen}
                flow={i === chosen ? ((frame - 20) % 30) / 30 : -1}
              />
            ))}
          </svg>
          <div style={{ position: 'absolute', left: 0, top: hubY - 46, ...appear(progressAt(frame, 2, 16), 10) }}>
            <Card style={{ width: 300, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14, borderRadius: 16 }}>
              <Tile size={54}><Brand id="slack" size={26} /></Tile>
              <span style={{ fontSize: 24, fontWeight: 600 }}>Slack</span>
            </Card>
          </div>
          <div style={{ position: 'absolute', left: 470, top: hubY - 56, ...appear(hub, 10) }}>
            <Card glow style={{ width: 380, padding: '24px 22px', display: 'flex', alignItems: 'center', gap: 16, borderRadius: 16 }}>
              <Tile size={58}><SerraMark size={34} /></Tile>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 26, fontWeight: 600 }}>Friday</span>
                <span style={{ fontSize: 18, color: C.muted, display: 'flex', alignItems: 'center', gap: 8 }}><Dot size={8} />Serra · up</span>
              </div>
            </Card>
          </div>
          {AGENTS.map((agent, i) => {
            const p = progressAt(frame, 10 + i * 4, 16);
            const on = i === chosen;
            return (
              <div key={agent.name} style={{ position: 'absolute', right: 0, top: top + i * rowH, ...appear(p, 12) }}>
                <div
                  style={{
                    width: cardW, height: rowH - 16, boxSizing: 'border-box', borderRadius: 14, padding: '0 18px', display: 'flex', alignItems: 'center', gap: 16,
                    background: on ? C.raised : C.panel,
                    border: `${agent.dashed ? '2px dashed' : '1px solid'} ${on ? '#3ecf8e99' : agent.dashed ? C.lineControl : C.lineStrong}`,
                    boxShadow: on ? '0 0 0 4px #3ecf8e14, 0 0 40px -10px #3ecf8e55' : undefined,
                                      }}
                >
                  <Tile size={48}>{agent.icon}</Tile>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                    <span style={{ fontSize: 22, fontWeight: 600, color: C.ink }}>{agent.name}</span>
                    <span style={{ fontSize: 17, color: C.muted }}>{agent.sub}</span>
                  </div>
                  {!agent.dashed && <Radio on={on} />}
                </div>
              </div>
            );
          })}
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

const TOOLS = [
  { at: 14, icon: <FileText size={20} color={C.muted} />, title: 'Read', detail: 'InvoicesTable.tsx' },
  { at: 24, icon: <FilePen size={20} color={C.muted} />, title: 'Edit', detail: '2 files' },
  { at: 34, icon: <SquareTerminal size={20} color={C.muted} />, title: 'Ran', detail: 'pnpm test' },
] as const;
export const CHAT_TOOL_FRAMES = [...TOOLS.map((t) => t.at), 46];
export const CHAT_REPLY = 'Added an empty state with a Create invoice button. Tests pass, draft PR is up.';
export const CHAT_REPLY_AT = 56;

export const Chat = () => {
  const frame = useCurrentFrame();
  const card = progressAt(frame, 0, 20);
  const perm = progressAt(frame, 46, 12);
  return (
    <AbsoluteFill>
      <Headline eyebrow="Jobs › Chat" title="Every run, as a chat." sub="Watch it stream. Answer it. Follow up." />
      <Stage y={44} scale={0.92}>
        <Card style={{ ...appear(card, 30), width: 1040, padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 24px', borderBottom: `1px solid ${C.line}` }}>
            <span style={{ fontSize: 21, fontWeight: 600 }}>Add an empty state to the invoices table</span>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pill><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Brand id="claude" size={15} />Claude Code</span></Pill>
              <Pill color={frame >= CHAT_REPLY_AT + 30 ? C.up : C.warn}>{frame >= CHAT_REPLY_AT + 30 ? 'Done' : 'Running'}</Pill>
            </span>
          </div>
          <div style={{ padding: '22px 26px 18px', display: 'flex', flexDirection: 'column', gap: 12, height: 410, boxSizing: 'border-box' }}>
            <div style={{ alignSelf: 'flex-end', background: C.overlay, border: `1px solid ${C.line}`, borderRadius: '16px 16px 4px 16px', padding: '12px 18px', fontSize: 20, maxWidth: 640 }}>@Friday {ASK_TEXT}</div>
            {TOOLS.map((tool) => {
              const p = progressAt(frame, tool.at, 12);
              return (
                <div key={tool.title} style={{ ...appear(p, 10), display: 'flex', alignItems: 'center', gap: 12, fontSize: 19, color: C.muted, border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 14px', width: 'fit-content' }}>
                  {tool.icon}<span style={{ color: C.ink, fontWeight: 600 }}>{tool.title}</span><span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 17 }}>{tool.detail}</span>
                  <Check size={18} color={C.up} />
                </div>
              );
            })}
            <div style={{ ...appear(perm, 10), display: 'flex', alignItems: 'center', gap: 12, fontSize: 19, color: C.muted, border: `1px solid #3ecf8e40`, background: '#3ecf8e0d', borderRadius: 10, padding: '9px 14px', width: 'fit-content' }}>
              <ShieldCheck size={20} color={C.up} /><span style={{ color: C.ink, fontWeight: 600 }}>Push the branch</span><span>Allowed</span>
            </div>
            <div style={{ fontSize: 21, lineHeight: 1.55, color: C.ink, marginTop: 6, minHeight: 66 }}>
              {frame >= CHAT_REPLY_AT && <Typed text={CHAT_REPLY} start={CHAT_REPLY_AT} perChar={0.32} />}
            </div>
          </div>
          <div style={{ margin: '0 20px 20px', border: `1px solid ${C.lineControl}`, borderRadius: 12, padding: '15px 18px', fontSize: 20, color: C.faint, background: C.field }}>Follow up…</div>
        </Card>
      </Stage>
    </AbsoluteFill>
  );
};

const PAGES = ['How we work', 'Billing', 'Web app'] as const;
export const KNOW_APPROVE_AT = 40;

export const Knowledge = () => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const card = progressAt(frame, 2, 18);
  const press = frame >= KNOW_APPROVE_AT && frame < KNOW_APPROVE_AT + 4;
  const approved = frame >= KNOW_APPROVE_AT + 5;
  const done = progressAt(frame, KNOW_APPROVE_AT + 5, 12);
  const landed = progressAt(frame, KNOW_APPROVE_AT + 18, 14);
  return (
    <AbsoluteFill>
      <Headline eyebrow="Knowledge" title="It learns how you work." sub="Approve what it learns. Every job reads it." />
      <Stage y={square ? 10 : 60} scale={square ? 0.98 : 1.08}>
        <div style={{ display: 'flex', alignItems: 'center', gap: square ? 40 : 110, flexDirection: square ? 'column' : 'row' }}>
          <div style={{ width: 620, height: 330, position: 'relative' }}>
            <Card glow={approved} style={{ ...appear(card, 24), position: 'absolute', inset: 0, padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 18, color: C.muted }}>
                <FileText size={20} color={C.muted} />Proposal · from the interview
              </div>
              <div style={{ fontSize: 26, lineHeight: 1.4, fontWeight: 500 }}>Open PRs as drafts. Ask Priya to review web changes.</div>
              {approved ? (
                <div style={{ ...appear(done, 8), marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 10, fontSize: 21, color: C.up, fontWeight: 600, height: 46 }}>
                  <Check size={22} color={C.up} strokeWidth={2.6} />Approved · now a page
                </div>
              ) : (
              <div style={{ display: 'flex', gap: 12, marginTop: 'auto' }}>
                <span style={{ background: C.ink, color: C.canvas, borderRadius: 10, padding: '11px 22px', fontSize: 20, fontWeight: 600, transform: `scale(${press ? 0.94 : 1})`, boxShadow: press ? "0 0 0 4px #ececef38" : undefined }}>Approve</span>
                <span style={{ border: `1px solid ${C.lineControl}`, color: C.ink, borderRadius: 10, padding: '11px 22px', fontSize: 20 }}>Dismiss</span>
              </div>
              )}
            </Card>
          </div>
          <Card style={{ ...appear(progressAt(frame, 8, 18), 20), width: 460, height: 330, boxSizing: 'border-box', padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
              <BookOpen size={22} color={C.ink} />Pages
              <span style={{ marginLeft: 'auto', fontSize: 18, color: C.muted, fontWeight: 400 }}>{frame >= KNOW_APPROVE_AT + 18 ? 4 : 3}</span>
            </div>
            {frame >= KNOW_APPROVE_AT + 18 && (
              <div style={{ ...appear(landed, 10), flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, fontSize: 20, padding: '12px 14px', borderRadius: 10, background: '#3ecf8e12', border: '1px solid #3ecf8e55' }}>
                <FileText size={20} color={C.up} />Reviews<Pill color={C.up} bg="#3ecf8e1a" style={{ marginLeft: 'auto', fontSize: 15 }}>New</Pill>
              </div>
            )}
            {PAGES.map((page) => (
              <div key={page} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 20, padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.line}`, color: C.muted }}>
                <FileText size={20} color={C.faint} />{page}
              </div>
            ))}
          </Card>
        </div>
      </Stage>
    </AbsoluteFill>
  );
};
