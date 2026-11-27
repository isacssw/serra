// Beats 9–10: the app window cycling Jobs, a run's Chat and Knowledge, then the end card.
import { BookOpen, Check, Download, FileText, GitPullRequest, Gauge, Inbox, Layers, MessageSquareText, Search, Settings, SquarePen, UserRound, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Brand, C, Dot, Headline, Lockup, MONO, Pill, SANS, SerraMark, Stage, appear, progressAt, useSquare } from '../kit.tsx';

export const APP_TABS = [0, 36, 72] as const;

type Screen = 'jobs' | 'chat' | 'overview';

const NavItem = ({ icon, label, active, badge }: { icon: ReactNode; label: string; active?: boolean; badge?: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8, background: active ? '#ffffff0f' : 'transparent', color: active ? C.ink : C.muted, fontSize: 16 }}>
    {icon}<span>{label}</span>{badge && <span style={{ marginLeft: 'auto', fontSize: 14, color: C.warn }}>{badge}</span>}
  </div>
);

const ic = { size: 17, strokeWidth: 1.8 } as const;

const JOBS = [
  { task: 'Add an empty state to the invoices table', meta: 'Priya · #web · now', status: 'Running', color: C.warn, pr: true },
  { task: 'Stop retrying gone webhooks', meta: 'Maya · #payments · 35m', status: 'Done', color: C.up, pr: true },
  { task: 'What does the billing cron do on month end?', meta: 'Sam · DM · 1h', status: 'Done', color: C.up, pr: false },
  { task: 'Fix the flaky checkout test', meta: 'Maya · #web · 2h', status: 'Done', color: C.up, pr: true },
] as const;

const Jobs = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em' }}>Jobs</div>
    <div style={{ display: 'inline-flex', gap: 4, background: C.field, border: `1px solid ${C.line}`, borderRadius: 10, padding: 4, width: 'fit-content', fontSize: 15 }}>
      {[['Needs you', '0'], ['Running', '1'], ['Done today', '3']].map(([label, n], i) => (
        <span key={label} style={{ padding: '6px 14px', borderRadius: 7, background: i === 1 ? C.overlay : 'transparent', color: i === 1 ? C.ink : C.muted }}>{label} <span style={{ color: C.faint, marginLeft: 6 }}>{n}</span></span>
      ))}
    </div>
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', background: C.panel }}>
      {JOBS.map((job, i) => (
        <div key={job.task} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderTop: i ? `1px solid ${C.line}` : 'none', background: i === 0 ? '#ffffff06' : 'transparent' }}>
          <Dot color={job.color} size={9} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap' }}>{job.task}</span>
            <span style={{ fontSize: 14, color: C.faint }}>{job.meta}</span>
          </div>
          <span style={{ fontSize: 13, color: job.color, background: `${job.color}1f`, borderRadius: 6, padding: '3px 8px' }}>{job.status}</span>
          <span style={{ display: 'flex', gap: 12, color: C.muted, width: 84, justifyContent: 'flex-end' }}>
            <Layers {...ic} /><MessageSquareText {...ic} />{job.pr ? <GitPullRequest {...ic} /> : <span style={{ width: 17 }} />}
          </span>
        </div>
      ))}
    </div>
  </div>
);

const ChatSheet = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>Add an empty state to the invoices table</span>
    </div>
    <div style={{ display: 'flex', gap: 8 }}>
      <Pill style={{ fontSize: 13 }}><span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Brand id="claude" size={12} />Claude Code</span></Pill>
      <Pill style={{ fontSize: 13 }} color={C.warn}>Running</Pill>
    </div>
    <div style={{ alignSelf: 'flex-end', background: C.overlay, borderRadius: '12px 12px 4px 12px', padding: '9px 14px', fontSize: 15 }}>@Friday add an empty state to the invoices table</div>
    {['Read  InvoicesTable.tsx', 'Edit  2 files', 'Ran  pnpm test'].map((row) => (
      <div key={row} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.muted, border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 10px', width: 'fit-content', fontFamily: MONO }}>
        <Check size={14} color={C.up} />{row}
      </div>
    ))}
    <div style={{ fontSize: 15, lineHeight: 1.55 }}>Added an empty state with a Create invoice button. Tests pass, draft PR is up.</div>
    <div style={{ marginTop: 'auto', border: `1px solid ${C.lineControl}`, borderRadius: 10, padding: '10px 14px', fontSize: 15, color: C.faint, background: C.field }}>Follow up…</div>
  </div>
);

const Overview = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em' }}>Overview</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.35fr', border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', background: C.panel }}>
      {[
        { label: 'Pages', value: '24', note: '+4 in 30 days' },
        { label: 'Used in replies', value: '31', note: 'of 40 replies this week' },
        { label: 'Health', value: '92%', note: 'Good' },
        { label: 'To review', value: '2', note: '2 proposals' },
      ].map((stat, i) => (
        <div key={stat.label} style={{ padding: '16px 18px', borderLeft: i ? `1px solid ${C.line}` : 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 14, color: C.muted }}>{stat.label}</span>
          <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em' }}>{stat.value}</span>
          <span style={{ fontSize: 13, color: C.faint }}>{stat.note}</span>
        </div>
      ))}
    </div>
    <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>Needs you</div>
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', background: C.panel }}>
      {['Open PRs as drafts. Ask Priya to review web changes.', 'Billing cron runs at 02:00 UTC on the 1st.'].map((row, i) => (
        <div key={row} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderTop: i ? `1px solid ${C.line}` : 'none', fontSize: 15 }}>
          <FileText size={16} color={C.muted} />{row}
          <span style={{ marginLeft: 'auto', fontSize: 13, background: C.ink, color: C.canvas, borderRadius: 7, padding: '5px 12px', fontWeight: 600 }}>Approve</span>
        </div>
      ))}
    </div>
  </div>
);

const AppWindow = ({ screen, swap }: { screen: Screen; swap: number }) => {
  const nav: { id: string; label: string; icon: ReactNode; badge?: string; for?: Screen }[] = [
    { id: 'new', label: 'New task', icon: <SquarePen {...ic} /> },
    { id: 'search', label: 'Search', icon: <Search {...ic} /> },
    { id: 'jobs', label: 'Jobs', icon: <Inbox {...ic} />, badge: '1', for: 'jobs' },
  ];
  const knowledge: { id: string; label: string; icon: ReactNode; for?: Screen }[] = [
    { id: 'overview', label: 'Overview', icon: <Gauge {...ic} />, for: 'overview' },
    { id: 'graph', label: 'Graph', icon: <Waypoints {...ic} /> },
    { id: 'about', label: 'About me', icon: <UserRound {...ic} /> },
    { id: 'proposals', label: 'Proposals', icon: <FileText {...ic} /> },
    { id: 'pages', label: 'Pages', icon: <BookOpen {...ic} /> },
  ];
  const active = screen === 'chat' ? 'jobs' : screen;
  return (
    <div style={{ width: 1300, height: 640, borderRadius: 16, overflow: 'hidden', background: C.canvas, border: `1px solid ${C.lineStrong}`, boxShadow: '0 0 0 1px #00000080, 0 50px 120px -30px #000000f0, 0 0 120px -40px #3ecf8e30', display: 'flex', fontFamily: SANS, color: C.ink }}>
      <div style={{ width: 270, borderRight: `1px solid ${C.line}`, background: C.canvas, padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, paddingLeft: 4 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />)}
          <span style={{ marginLeft: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 600 }}><SerraMark size={18} />Serra <span style={{ color: C.muted, fontWeight: 400 }}>· up</span></span>
        </div>
        {nav.map((item) => <NavItem key={item.id} icon={item.icon} label={item.label} badge={item.badge} active={item.id === active} />)}
        <div style={{ fontSize: 13, color: C.faint, padding: '16px 12px 6px' }}>Knowledge</div>
        {knowledge.map((item) => <NavItem key={item.id} icon={item.icon} label={item.label} active={item.id === active} />)}
        <div style={{ marginTop: 'auto', borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
          <NavItem icon={<Settings {...ic} />} label="Settings" />
        </div>
      </div>
      <div style={{ flex: 1, padding: '34px 40px', position: 'relative', overflow: 'hidden' }}>
        <div style={{ ...appear(swap, 10) }}>{screen === 'overview' ? <Overview /> : <Jobs />}</div>
        {screen === 'chat' && (
          <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 560, background: C.overlay, borderLeft: `1px solid ${C.lineStrong}`, padding: '28px 28px', display: 'flex', flexDirection: 'column', boxShadow: '-30px 0 60px -20px #000000c0', transform: `translateX(${(1 - swap) * 80}px)`, opacity: swap }}>
            <ChatSheet />
          </div>
        )}
      </div>
    </div>
  );
};

export const App = () => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const screen: Screen = frame >= APP_TABS[2] ? 'overview' : frame >= APP_TABS[1] ? 'chat' : 'jobs';
  const since = frame - (screen === 'overview' ? APP_TABS[2] : screen === 'chat' ? APP_TABS[1] : APP_TABS[0]);
  const swap = progressAt(since, 0, 14);
  const win = progressAt(frame, 0, 22);
  const zoom = 0.94 + 0.04 * progressAt(frame, 0, 100);
  return (
    <AbsoluteFill>
      <Headline title="Every job, one click away." sub="Its thread, its chat, its PR." />
      <Stage y={square ? 20 : 50} scale={(square ? 0.92 : 0.8) * zoom}>
        <div style={{ ...appear(win, 40) }}>
          <AppWindow screen={screen} swap={screen === 'jobs' ? 1 : swap} />
        </div>
      </Stage>
    </AbsoluteFill>
  );
};

export const End = () => {
  const frame = useCurrentFrame();
  const square = useSquare();
  const logo = progressAt(frame, 0, 22);
  const line = progressAt(frame, 8, 18);
  const cta = progressAt(frame, 16, 18);
  const foot = progressAt(frame, 24, 18);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 30, fontFamily: SANS, textAlign: 'center', padding: '0 60px' }}>
      <div style={{ ...appear(logo, 16), transform: `scale(${0.96 + 0.04 * logo})` }}>
        <Lockup height={square ? 104 : 124} draw={1} sun={logo} reveal={1} />
      </div>
      <div style={{ ...appear(line, 12), fontSize: square ? 32 : 36, color: C.muted, letterSpacing: '-0.01em' }}>The coding agents on your Mac, in Slack.</div>
      <div style={{ ...appear(cta, 12), display: 'flex', gap: 14, marginTop: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, background: C.ink, color: C.canvas, borderRadius: 12, padding: '15px 26px', fontSize: 24, fontWeight: 600 }}>
          <Download size={24} strokeWidth={2.2} />Download for Mac
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, border: `1px solid ${C.lineControl}`, borderRadius: 12, padding: '15px 24px', fontSize: 24, fontFamily: MONO, color: C.ink, background: C.panel }}>
          <Brand id="github" size={24} />github.com/isacssw/serra
        </span>
      </div>
      <div style={{ ...appear(foot, 8), fontSize: 21, color: C.faint, display: 'flex', alignItems: 'center', gap: 12 }}>
        Free and open source <span>·</span> MIT <span>·</span> Apple silicon <span>·</span> Alpha
      </div>
    </AbsoluteFill>
  );
};
