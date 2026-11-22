// Tools (APP-23, SERRA-39): read-only. What the worker can use in a job: the recommended services, the MCP servers
// each provider gives it (managed in Claude or Codex, never here), and the command-line tools on this Mac. Nothing
// on this screen runs an install, a sign-in or an `mcp add`: commands are shown for people to copy.
import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown, CircleAlert, Cloud, Copy, ExternalLink, Info, Plug, RefreshCw, Terminal, TriangleAlert } from 'lucide-react';
import type { CliOverview } from '../../../src/clis.ts';
import type { McpOverview, McpServer } from '../../../src/mcp.ts';
import { serra } from '../bridge.ts';
import { Badge, Button, cx, Page, useToast } from '../ui/index.ts';
import { ToolIcon } from '../ui/ToolIcon.tsx';
import {
  brandFor, cliRows, driverGroups, providerLine, recommendationRows, recommendedCliIds, serverBrand, serverLabel, serverOrigin, serverStatus,
  transportLabel, type CliRow, type DriverGroup, type RecommendationRow, type Status,
} from './tools.logic.ts';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A filled dot for a checked state, a hollow one for "enabled but not checked", grey for off. */
const DOT: Record<Status['tone'], string> = { up: 'bg-up', warn: 'bg-warn', down: 'bg-down', neutral: 'border border-faint', off: 'bg-faint' };

/** A status as a dot and a word, the same width in every list so they line up. */
const StatusPill = ({ status }: { status: Status }) => (
  <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2 text-xs whitespace-nowrap text-ink">
    <span aria-hidden className={cx('size-1.5 rounded-full', DOT[status.tone])} />
    {status.text}
  </span>
);

const useCopy = () => {
  const toast = useToast();
  return (text: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => toast({ message: 'Copied.', tone: 'success' }))
      .catch((failure: unknown) => toast({ message: errorText(failure), tone: 'error' }));
  };
};

/** A command to copy and run yourself. `compact`: in a narrow container only the copy button shows, named for the command. */
const Command = ({ command, label, compact }: { command: string; label?: string; compact?: boolean }) => {
  const copy = useCopy();
  return (
    <div className="flex min-w-0 items-center gap-2">
      {label && <span className="w-28 shrink-0 text-xs text-muted">{label}</span>}
      <code className={cx(compact && 'hidden @2xl:block', 'min-w-0 flex-1 truncate rounded-md border border-line-subtle bg-raised px-2 py-1 font-mono text-xs')} title={command}>{command}</code>
      <Button size="sm" variant="ghost" icon={<Copy size={13} aria-hidden />} aria-label={`Copy: ${command}`} title={`Copy: ${command}`} onClick={() => copy(command)} />
    </div>
  );
};

const openDocs = (url: string, onError: (message: string) => void) => {
  serra()?.app.openExternal(url).catch((failure: unknown) => onError(errorText(failure)));
};

/**
 * One row of any list: icon, name and a short second line, an optional quiet detail, an action, and the status
 * pill in a fixed column. `more` is shown under the row behind a disclosure button.
 */
const Row = ({ icon, title, sub, meta, status, badge, more, moreLabel }: {
  icon: ReactNode;
  title: string;
  sub?: ReactNode;
  meta?: ReactNode;
  status: Status;
  badge?: ReactNode;
  more?: ReactNode;
  moreLabel?: string;
}) => {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <li className="px-4 py-3">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 @2xl:grid-cols-[auto_minmax(0,1fr)_minmax(0,15rem)_6.5rem_8.5rem]">
        {icon}
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            {badge}
          </span>
          {sub && <span className="text-xs break-words text-muted @2xl:truncate">{sub}</span>}
          {meta && <span className="text-xs break-words text-muted @2xl:hidden">{meta}</span>}
        </div>
        <span className="hidden truncate text-xs text-muted @2xl:block">{meta}</span>
        <span className="hidden justify-end @2xl:flex">
          {more && (
            <Button
              size="sm" variant="ghost" aria-expanded={open} aria-controls={panel} aria-label={`${moreLabel}: ${title}`}
              icon={<ChevronDown size={13} aria-hidden className={cx('transition-transform', open && 'rotate-180')} />}
              onClick={() => setOpen((value) => !value)}
            >
              {moreLabel}
            </Button>
          )}
        </span>
        <span className="col-start-3 flex justify-end @2xl:col-start-auto"><StatusPill status={status} /></span>
      </div>
      {more && (
        <div className="mt-2 flex pl-10 @2xl:hidden">
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={panel} aria-label={`${moreLabel}: ${title}`} onClick={() => setOpen((value) => !value)}>{moreLabel}</Button>
        </div>
      )}
      {more && open && <div id={panel} className="mt-3 flex flex-col gap-2 pl-10">{more}</div>}
    </li>
  );
};

const Section = ({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) => {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="shrink-0 text-sm font-semibold whitespace-nowrap">{title}</h2>
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
};

const List = ({ label, children }: { label: string; children: ReactNode }) => (
  <ul aria-label={label} className="@container divide-y divide-line-subtle rounded-xl border border-line">{children}</ul>
);

const Pending = ({ text }: { text: string }) => <p className="rounded-xl border border-line px-4 py-5 text-sm text-muted">{text}</p>;

const Failed = ({ text }: { text: string }) => (
  <p role="alert" className="flex items-center gap-2 rounded-xl border border-down/40 px-4 py-3 text-sm text-down">
    <CircleAlert size={15} aria-hidden /> {text}
  </p>
);

const RecommendationItem = ({ row }: { row: RecommendationRow }) => (
  <Row
    icon={<ToolIcon brand={brandFor(row.rec.icon)} fallback={<Cloud size={14} />} label={row.rec.label} />}
    title={row.rec.label}
    sub={row.reason}
    status={row.state}
    more={row.setup.length ? row.setup.map((step) => <Command key={step.command} label={step.label} command={step.command} />) : undefined}
    moreLabel="Set up"
  />
);

const CliItem = ({ row }: { row: CliRow }) => {
  const account = row.status?.check?.account;
  return (
    <Row
      icon={<ToolIcon brand={brandFor(row.spec.icon)} fallback={row.spec.icon === 'cloud' ? <Cloud size={14} /> : <Terminal size={14} />} label={row.spec.label} />}
      title={row.spec.label}
      badge={row.recommended ? <Badge tone="accent">Recommended</Badge> : undefined}
      sub={row.status?.path ? [row.status.version && `v${row.status.version}`, account].filter(Boolean).join(' · ') || undefined : undefined}
      meta={row.status?.path ? <span className="font-mono" title={row.status.path}>{row.status.path}</span> : undefined}
      status={row.state}
      more={row.command ? <Command command={row.command} /> : undefined}
      moreLabel={row.status?.path ? 'Sign in' : 'Install'}
    />
  );
};

const ServerItem = ({ server }: { server: McpServer }) => (
  <Row
    icon={<ToolIcon brand={serverBrand(server)} fallback={<Plug size={14} />} label={serverLabel(server)} />}
    title={serverLabel(server)}
    sub={serverOrigin(server)}
    meta={transportLabel(server)}
    status={serverStatus(server)}
    more={server.note ? <p className="flex items-start gap-2 text-xs text-muted"><Info size={13} aria-hidden className="mt-0.5 shrink-0" />{server.note}</p> : undefined}
    moreLabel="Why"
  />
);

const ProviderGroup = ({ group, onError }: { group: DriverGroup; onError: (message: string) => void }) => {
  const id = useId();
  return (
    <div className="@container flex flex-col gap-2" data-driver={group.driver ?? group.key}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 id={id} className="text-[13px] font-medium">
          {group.title} <span className="font-normal text-muted">· {group.summary}</span>
        </h3>
        {group.hint && (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted">
            <span className="shrink-0">Managed in {group.title}</span>
            <div className="min-w-0 max-w-[24rem]"><Command command={group.hint.command} compact /></div>
            <Button size="sm" variant="ghost" icon={<ExternalLink size={13} aria-hidden />} aria-label={`${group.title} MCP docs`} onClick={() => openDocs(group.hint!.docs, onError)}>Docs</Button>
          </div>
        )}
      </div>
      {group.listingNote && <p className="flex items-center gap-2 text-xs text-warn"><TriangleAlert size={13} aria-hidden /> {group.listingNote}</p>}
      {group.unreadable.map((path) => <p key={path} className="text-xs text-warn">Couldn&apos;t read {path}.</p>)}
      {group.unsupported
        ? <p className="flex items-start gap-2 rounded-xl border border-dashed border-line px-4 py-4 text-sm text-muted"><Info size={14} aria-hidden className="mt-0.5 shrink-0" />{group.unsupported}</p>
        : group.servers.length === 0
        ? <p className="rounded-xl border border-dashed border-line px-4 py-4 text-sm text-muted">No MCP servers in {group.title} yet.</p>
        : <ul aria-labelledby={id} className="@container divide-y divide-line-subtle rounded-xl border border-line">{group.servers.map((server) => <ServerItem key={`${server.scope}:${server.name}`} server={server} />)}</ul>}
    </div>
  );
};

export const Tools = () => {
  const toast = useToast();
  const [mcp, setMcp] = useState<McpOverview | null>(null);
  const [clis, setClis] = useState<CliOverview | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  const [loading, setLoading] = useState(0);
  const [announce, setAnnounce] = useState('');

  const load = useCallback((fresh = false) => {
    const bridge = serra();
    if (!bridge) {
      const message = 'The Serra bridge is not available in this window.';
      setMcpError(message);
      setCliError(message);
      return;
    }
    setLoading(2);
    setAnnounce('Checking tools…');
    const done = () => setLoading((count) => {
      if (count <= 1) setAnnounce('Tools checked.');
      return Math.max(0, count - 1);
    });
    bridge.tools.overview({ fresh }).then((value) => { setMcp(value); setMcpError(null); }, (failure: unknown) => setMcpError(errorText(failure))).finally(done);
    bridge.tools.clis({ fresh }).then((value) => { setClis(value); setCliError(null); }, (failure: unknown) => setCliError(errorText(failure))).finally(done);
  }, []);
  useEffect(() => { load(); }, [load]);

  const recommendations = clis || mcp ? recommendationRows(mcp, clis, undefined, undefined, !mcp && !mcpError) : [];
  const cliList = clis ? cliRows(clis, recommendedCliIds(recommendations)) : [];
  const installed = cliList.filter((row) => row.status?.path);
  const notInstalled = cliList.filter((row) => !row.status?.path);
  const onError = (message: string) => toast({ message, tone: 'error' });

  return (
    <Page
      title="Tools"
      subtitle="What the worker can use in a job. Read-only."
      actions={(
        <Button
          icon={<RefreshCw size={14} aria-hidden className={cx(loading > 0 && 'motion-safe:animate-spin')} />}
          onClick={() => load(true)} disabled={loading > 0} aria-busy={loading > 0}
        >
          Check again
        </Button>
      )}
    >
      <div aria-live="polite" className="sr-only">{announce}</div>

      {mcp?.warnings.map((warning) => (
        <p key={`${warning.driver}:${warning.tool}`} role="alert" data-missing-tool={warning.tool} className="flex items-start gap-3 rounded-xl border border-warn/50 px-4 py-3 text-sm">
          <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0 text-warn" />
          <span>{warning.text}</span>
        </p>
      ))}

      <Section title="Recommended">
        {recommendations.length
          ? <List label="Recommended tools">{recommendations.map((row) => <RecommendationItem key={row.rec.id} row={row} />)}</List>
          : <Pending text="Checking…" />}
      </Section>

      <Section title="MCP servers" aside={mcp ? providerLine(mcp.worker) : undefined}>
        {mcpError && <Failed text={mcpError} />}
        {!mcp && !mcpError && <Pending text="Asking T3's providers for their servers…" />}
        {mcp && (
          <div className="flex flex-col gap-6">
            {driverGroups(mcp).map((group) => <ProviderGroup key={group.key} group={group} onError={onError} />)}
            <p className="text-xs text-muted">T3 also gives every job its own <code className="font-mono">t3-code</code> server.</p>
          </div>
        )}
      </Section>

      <Section title="Command-line tools" aside={clis ? `${installed.length} of ${cliList.length} installed` : undefined}>
        {cliError && <Failed text={cliError} />}
        {!clis && !cliError && <Pending text="Looking for command-line tools…" />}
        {clis && installed.length > 0 && <List label="Installed command-line tools">{installed.map((row) => <CliItem key={row.spec.id} row={row} />)}</List>}
        {clis && notInstalled.length > 0 && (
          <details className="group rounded-xl border border-line">
            <summary className="flex cursor-default list-none items-center gap-2 rounded-xl px-4 py-3 text-sm text-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
              <ChevronDown size={14} aria-hidden className="-rotate-90 transition-transform group-open:rotate-0" />
              Not installed <span className="text-faint">· {notInstalled.length}</span>
            </summary>
            <ul aria-label="Command-line tools not installed" className="@container divide-y divide-line-subtle border-t border-line">{notInstalled.map((row) => <CliItem key={row.spec.id} row={row} />)}</ul>
          </details>
        )}
      </Section>
    </Page>
  );
};
