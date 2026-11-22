// Settings › Meetings (SERRA-62): turn meeting capture on (acknowledging what's sent and kept), see which transcript
// sources Claude Code can read now and what to do when one can't, and forget a meeting.
import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import type { MeetingSettings } from '../../../../src/meeting-settings.ts';
import type { MeetingProvider, ProviderStatus } from '../../../../src/meeting-sources.ts';
import type { MeetingView } from '../../../../src/meeting-store.ts';
import { serra } from '../../bridge.ts';
import { Badge, Button, Dialog, Page, useToast } from '../../ui/index.ts';
import { ToolIcon } from '../../ui/ToolIcon.tsx';
import { SourceIcon } from '../proposals/MeetingReview.tsx';

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
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const PROVIDER_ROWS: { provider: MeetingProvider; label: string; how: string }[] = [
  { provider: 'granola', label: 'Granola', how: 'Send the note’s link, like notes.granola.ai/d/…' },
  { provider: 'google-meet', label: 'Google Meet', how: 'Send the transcript Doc’s link from Drive.' },
];

const SourceRow = ({ icon, label, how, status }: { icon: ReactNode; label: string; how: string; status: { label: string; tone: BadgeTone; detail?: string } | null }) => (
  <li className="flex items-start gap-3 py-3">
    {icon}
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
      </div>
      <p className="text-[13px] text-muted">{how}</p>
      {status?.detail && <p className="text-[13px] text-muted">{status.detail}</p>}
    </div>
  </li>
);

export const Meetings = () => {
  const toast = useToast();
  const [settings, setSettings] = useState<(MeetingSettings & { notice: string }) | null>(null);
  const [sources, setSources] = useState<ProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
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
    try { setSources(await bridge.meetings.sources()); } catch (failure) { toast({ message: message(failure), tone: 'error' }); } finally { setChecking(false); }
  }, [toast]);

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
    return { ...STATE[found.state], detail: found.detail };
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
          description="Serra reads Granola and Meet through your own Claude Code connections. It never holds their keys."
          actions={<Button size="sm" disabled={checking} icon={checking ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />} onClick={() => void check()}>Check</Button>}
        >
          <ul className="flex flex-col divide-y divide-line">
            <SourceRow icon={<SourceIcon source="granola" />} label="Granola" how={PROVIDER_ROWS[0]!.how} status={statusOf('granola')} />
            <SourceRow icon={<SourceIcon source="google-meet" />} label="Google Meet" how={PROVIDER_ROWS[1]!.how} status={statusOf('google-meet')} />
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
