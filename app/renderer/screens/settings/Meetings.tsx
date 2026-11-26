// Settings › Meetings (SERRA-62, SERRA-69): turn meeting capture on (acknowledging what's sent and kept), see which T3
// provider and model meeting runs use, test a transcript source on demand, and forget a meeting. Opening this screen
// never makes a model call: only the Test button does, one short T3 run per press.
import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import type { MeetingRunner } from '../../../../src/meeting-runs.ts';
import type { MeetingSettings } from '../../../../src/meeting-settings.ts';
import type { MeetingProvider, ProviderStatus } from '../../../../src/meeting-sources.ts';
import type { MeetingView } from '../../../../src/meeting-store.ts';
import { serra } from '../../bridge.ts';
import { Badge, Button, Dialog, Page, useToast } from '../../ui/index.ts';
import { ToolIcon } from '../../ui/ToolIcon.tsx';
import { SourceIcon } from '../proposals/MeetingReview.tsx';
import { testedLine, testLabel } from './meetings.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type History = Awaited<ReturnType<NonNullable<ReturnType<typeof serra>>['meetings']['history']>>;

const Card = ({ title, description, children, actions }: { title: string; description?: ReactNode; children?: ReactNode; actions?: ReactNode }) => (
  <section className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
    {children}
  </section>
);

type BadgeTone = NonNullable<ComponentProps<typeof Badge>['tone']>;

const STATE: Record<ProviderStatus['state'], { label: string; tone: BadgeTone }> = {
  ready: { label: 'Ready', tone: 'up' },
  'needs-sign-in': { label: 'Sign in again', tone: 'warn' },
  missing: { label: 'Not connected', tone: 'neutral' },
  untested: { label: 'Not tested', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const PROVIDER_ROWS: { provider: MeetingProvider; label: string; how: string }[] = [
  { provider: 'granola', label: 'Granola', how: 'Send the note’s link, like notes.granola.ai/d/…' },
  { provider: 'google-meet', label: 'Google Meet', how: 'Send the transcript Doc’s link from Drive.' },
];

const SourceRow = ({ icon, label, how, status, action }: { icon: ReactNode; label: string; how: string; status: { label: string; tone: BadgeTone; detail?: string; tested?: string | null } | null; action?: ReactNode }) => (
  <li className="flex items-start gap-3 py-3">
    {icon}
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
      </div>
      <p className="text-[13px] text-muted">{how}</p>
      {status?.detail && <p className="text-[13px] text-muted">{status.detail}</p>}
      {status?.tested && <p className="text-xs text-muted">{status.tested}</p>}
    </div>
    {action}
  </li>
);

export const Meetings = () => {
  const toast = useToast();
  const [settings, setSettings] = useState<(MeetingSettings & { notice: string }) | null>(null);
  const [runner, setRunner] = useState<MeetingRunner | null>(null);
  const [sources, setSources] = useState<ProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState<MeetingProvider | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [error, setError] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const [forgetting, setForgetting] = useState<History[number] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setError('Open this screen in the Serra app.'); return; }
    try {
      const [next, past] = await Promise.all([bridge.meetings.settings(), bridge.meetings.history()]);
      setSettings(next);
      setHistory(past);
      setError(null);
    } catch (failure) { setError(message(failure)); }
  }, []);

  const check = useCallback(async () => {
    const bridge = serra();
    if (!bridge) return;
    setChecking(true);
    try {
      const next = await bridge.meetings.sources();
      setRunner(next.runner);
      setSources(next.sources);
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setChecking(false); }
  }, [toast]);

  /** One short T3 run, only on the owner's press. */
  const test = async (provider: MeetingProvider): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setTesting(provider);
    try {
      const result = await bridge.meetings.testSource(provider);
      setSources((current) => (current ?? []).map((entry) => (entry.provider === provider ? result : entry)));
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setTesting(null); }
  };

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (settings?.enabled && sources === null) void check(); }, [settings?.enabled, sources, check]);

  const setEnabled = async (enabled: boolean): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    try {
      setSettings(await bridge.meetings.setEnabled(enabled));
      toast({ message: enabled ? 'Meeting capture is on.' : 'Meeting capture is off.', tone: 'success' });
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setBusy(false); setAcknowledging(false); }
  };

  const forget = async (meeting: History[number]): Promise<void> => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    try {
      const result = await bridge.meetings.forget(meeting.id);
      toast({ message: `Forgot ${meeting.title}${result.pages.length ? `: ${result.pages.length} page${result.pages.length === 1 ? '' : 's'} changed` : ''}.`, tone: 'success' });
      await load();
    } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setBusy(false); setForgetting(null); }
  };

  const statusOf = (provider: MeetingProvider) => {
    const found = sources?.find((entry) => entry.provider === provider);
    if (!found) return checking ? { label: 'Checking…', tone: 'neutral' as const } : null;
    return { ...STATE[found.state], detail: found.detail, tested: testedLine(found, new Date()) };
  };

  return (
    <Page title="Meetings" subtitle="Keep the decisions from your team’s meetings, so coding work knows why.">
      {error && <p role="alert" className="text-sm text-down">{error}</p>}
      {settings && (
        <Card
          title="Meeting capture"
          description={settings.enabled
            ? <>In your DM with Serra, send a new message starting with &ldquo;remember this meeting&rdquo;, with the transcript attached, pasted, or linked. You review every item in Proposals.</>
            : 'Off. Turn it on to send Serra meeting transcripts from your DM.'}
          actions={settings.enabled
            ? <Button disabled={busy} onClick={() => void setEnabled(false)}>Turn off</Button>
            : <Button variant="primary" disabled={busy} onClick={() => setAcknowledging(true)}>Turn on…</Button>}
        >
          {settings.enabled && settings.acknowledged && <p className="text-xs text-muted">On since {new Date(settings.acknowledged.at).toLocaleDateString()}.</p>}
        </Card>
      )}
      {settings?.enabled && (
        <Card
          title="Sources"
          description="Serra reads Granola and Meet links in an agent run, through the connections your agent already has. It never holds their keys. Test runs one short run."
          actions={<Button size="sm" disabled={checking} icon={checking ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />} onClick={() => void check()}>Refresh</Button>}
        >
          {runner && (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Runs on {runner.label}{runner.model ? ` · ${runner.model}` : ''}</span>
              <Badge tone={runner.ready ? 'up' : 'warn'}>{runner.ready ? 'Ready' : 'Needs attention'}</Badge>
              <span className="text-[13px] text-muted">{runner.detail}</span>
            </p>
          )}
          <ul className="flex flex-col divide-y divide-line">
            {PROVIDER_ROWS.map((row) => (
              <SourceRow
                key={row.provider} icon={<SourceIcon source={row.provider} />} label={row.label} how={row.how} status={statusOf(row.provider)}
                action={(
                  <Button size="sm" disabled={testing !== null || runner?.ready === false} icon={testing === row.provider ? <LoaderCircle size={14} className="animate-spin" /> : undefined} onClick={() => void test(row.provider)}>
                    {testing === row.provider ? 'Testing…' : testLabel(sources?.find((entry) => entry.provider === row.provider))}
                  </Button>
                )}
              />
            ))}
            <SourceRow icon={<ToolIcon brand={null} fallback={<FileText size={14} />} label="File or text" />} label="File or pasted text" how="Attach a .txt, .md, .vtt or .srt export from any notetaker, or paste the summary." status={{ label: 'Ready', tone: 'up' }} />
          </ul>
        </Card>
      )}
      {history.length > 0 && (
        <Card title="Meetings" description="Forget a meeting to remove everything it added.">
          <ul className="flex flex-col divide-y divide-line">
            {history.map((meeting) => (
              <li key={meeting.id} className="flex items-center gap-3 py-3">
                <SourceIcon source={meeting.source as MeetingView['source']} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{meeting.title}</span>
                  <span className="text-xs text-muted">{meeting.date}{meeting.pages.length ? ` · ${meeting.pages.join(', ')}` : ''}{meeting.state === 'forgetting' ? ' · deleting the digest' : ''}</span>
                </div>
                <Button size="sm" disabled={busy || meeting.state !== 'open'} onClick={() => setForgetting(meeting)}>Forget</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Dialog
        open={acknowledging}
        onClose={() => setAcknowledging(false)}
        title="Turn on meeting capture"
        actions={(
          <>
            <Button onClick={() => setAcknowledging(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void setEnabled(true)}>I understand, turn on</Button>
          </>
        )}
      >
        <div className="flex flex-col gap-3 text-sm leading-6">
          {settings?.notice.split('\n\n').map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>
      </Dialog>
      <Dialog
        open={forgetting !== null}
        onClose={() => setForgetting(null)}
        title={`Forget ${forgetting?.title ?? 'this meeting'}?`}
        description="Removes what it added: page lines, backups, pending quotes and its digest message. Threads that read it start fresh on their next message. This can't be undone. Your Slack upload and T3 threads that already read it aren't touched."
        actions={(
          <>
            <Button onClick={() => setForgetting(null)}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void forget(forgetting!)}>Forget meeting</Button>
          </>
        )}
      />
    </Page>
  );
};
