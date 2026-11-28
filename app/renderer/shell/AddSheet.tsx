// Add… (⌘⇧N, and Settings' Add… row): a chat beside the first one (Settings › Channels), a profile, or a server (SB-32). Server pairs this Mac with a server the owner runs, in one short flow:
// its address and the code `serra server pair` shows, the three words compared, then ready. Or over SSH, with the
// owner's keys. The steps and words are in pair.logic.ts; the code goes to the server only after "They match".
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronRight, MessagesSquare, Server, SquareTerminal, UserPlus } from 'lucide-react';
import { useNavigate } from 'react-router';
import { serra } from '../bridge.ts';
import { presence } from '../presence.logic.ts';
import { Button, Dialog, Input } from '../ui/index.ts';
import { cx } from '../ui/cx.ts';
import { labelClass, noteClass } from '../ui/field.ts';
import { OPEN_ADD } from './events.ts';
import { afterCode, codeComplete, codeInput, pairLine, pairTitle, sshError, type PairStep } from './pair.logic.ts';
import { ADD_PROFILE_PATH } from './shortcuts.logic.ts';

/** Opens Add… from anywhere: its first step, or straight at Server. */
export const openAdd = (start: 'add' | 'server' = 'add'): void => { window.dispatchEvent(new CustomEvent(OPEN_ADD, { detail: start })); };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** `serra server pair` in a line, set as a command. */
const withCommand = (line: string): ReactNode => {
  const at = line.indexOf('serra server pair');
  if (at < 0) return line;
  return <>{line.slice(0, at)}<code className="font-mono text-ink">serra server pair</code>{line.slice(at + 'serra server pair'.length)}</>;
};

const Tile = ({ children }: { children: ReactNode }) => (
  <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-panel text-muted">{children}</span>
);

const Choice = ({ icon, title, line, onClick, autoFocus }: { icon: ReactNode; title: string; line: string; onClick: () => void; autoFocus?: boolean }) => (
  <button
    type="button"
    onClick={onClick}
    data-autofocus={autoFocus ? '' : undefined}
    className="flex w-full items-center gap-3 rounded-xl border border-line bg-control px-3 py-2.5 text-left transition-colors hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
  >
    <Tile>{icon}</Tile>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="text-[13px] font-medium">{title}</span>
      <span className="truncate text-xs text-muted">{line}</span>
    </span>
    <ChevronRight size={15} aria-hidden className="text-faint" />
  </button>
);

const CodeField = ({ value, onChange, error, focus }: { value: string; onChange: (value: string) => void; error: string | null; focus?: boolean }) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor="pair-code" className={labelClass}>Code</label>
    <input
      id="pair-code"
      value={value}
      onChange={(event) => onChange(codeInput(event.target.value))}
      autoComplete="one-time-code"
      autoFocus={focus}
      data-autofocus={focus ? '' : undefined}
      spellCheck={false}
      inputMode="text"
      placeholder="K7Q-4MX"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? 'pair-code-note' : undefined}
      className={cx(
        'h-11 w-44 rounded-lg border bg-field px-3 font-mono text-xl tracking-[0.2em] text-ink uppercase shadow-field outline-none placeholder:text-faint',
        'focus-visible:ring-2 focus-visible:ring-focus/40',
        error ? 'border-down' : 'border-line-control focus:border-focus',
      )}
    />
    {error && <p id="pair-code-note" className={noteClass(true)}>{error}</p>}
  </div>
);

const Footer = ({ left, children }: { left?: ReactNode; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-2 pt-1">
    <div className="min-w-0">{left}</div>
    <div className="flex gap-2">{children}</div>
  </div>
);

export const AddSheet = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<PairStep | null>(null);
  const [busy, setBusy] = useState(false);
  const probe = useRef<string | null>(null);

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const start = event instanceof CustomEvent && event.detail === 'server' ? 'server' : 'add';
      setBusy(false);
      setStep(start === 'server' ? { step: 'address', address: '', code: '', error: null } : { step: 'add' });
    };
    window.addEventListener(OPEN_ADD, onOpen);
    return () => window.removeEventListener(OPEN_ADD, onOpen);
  }, []);

  const close = (): void => {
    if (probe.current) void serra()?.servers.cancel(probe.current).catch(() => {});
    probe.current = null;
    setStep(null);
    setBusy(false);
  };

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };

  const toAddress = (address = '', code = ''): void => setStep({ step: 'address', address, code, error: null });

  const continueAddress = (event: FormEvent): void => {
    event.preventDefault();
    if (step?.step !== 'address' || busy) return;
    const { address, code } = step;
    void run(async () => {
      try {
        const found = await serra()!.servers.probe(address, code);
        probe.current = found.probeId;
        setStep({ step: 'words', address, code, probeId: found.probeId, name: found.name, words: found.words });
      } catch (error) { setStep({ step: 'address', address, code, error: message(error), ...(step.name ? { name: step.name } : {}) }); }
    });
  };

  const sendCode = (sent: { address: string; code: string; probeId: string; name: string }): void => {
    // Only these fields: the step it was sent from (words or code) must not come along.
    const current = { address: sent.address, code: sent.code, probeId: sent.probeId, name: sent.name };
    void run(async () => {
      try {
        const outcome = await serra()!.servers.pair(current.probeId, current.code);
        probe.current = null;
        setStep(afterCode(current, outcome));
      } catch (error) { probe.current = null; setStep({ step: 'address', address: current.address, code: '', error: null, codeError: message(error), name: current.name }); }
    });
  };

  const continueSsh = (event: FormEvent): void => {
    event.preventDefault();
    if (step?.step !== 'ssh' || busy) return;
    const { target } = step;
    void run(async () => {
      try {
        const outcome = await serra()!.servers.pairOverSsh(target);
        if (outcome.ok) setStep({ step: 'ready', server: outcome.server });
        else setStep({ step: 'ssh', target, error: sshError(target, outcome.detail) });
      } catch (error) { setStep({ step: 'ssh', target, error: { title: sshError(target, 'failed').title, line: message(error) } }); }
    });
  };

  if (!step) return null;
  const line = pairLine(step);

  const body = (): ReactNode => {
    switch (step.step) {
      case 'add':
        return (
          <div className="flex flex-col gap-2">
            <Choice autoFocus icon={<MessagesSquare size={17} strokeWidth={1.75} />} title="Chat" line="Telegram or Discord, beside the one you use" onClick={() => { close(); void navigate('/settings/channels'); }} />
            <Choice icon={<UserPlus size={17} strokeWidth={1.75} />} title="Profile" line="Another bot with its own chat, knowledge and agent" onClick={() => { close(); void navigate(ADD_PROFILE_PATH); }} />
            <Choice icon={<Server size={17} strokeWidth={1.75} />} title="Server" line="Keep profiles on another computer, always on" onClick={() => toAddress()} />
          </div>
        );
      case 'address':
        return (
          <form onSubmit={continueAddress} className="flex flex-col gap-4">
            <Input label="Address" value={step.address} autoFocus={!step.codeError} data-autofocus={step.codeError ? undefined : ''} spellCheck={false} autoCapitalize="off" placeholder="t480"
              error={step.error} onChange={(event) => setStep({ ...step, address: event.target.value, error: null })} />
            <CodeField value={step.code} error={step.codeError ?? null} focus={Boolean(step.codeError)} onChange={(code) => setStep({ ...step, code, codeError: null })} />
            <Footer left={<Button variant="ghost" size="sm" flush icon={<SquareTerminal size={14} aria-hidden />} onClick={() => setStep({ step: 'ssh', target: step.address, error: null })}>Pair over SSH instead</Button>}>
              <Button onClick={() => setStep({ step: 'add' })}>Back</Button>
              <Button type="submit" variant="primary" disabled={busy || !step.address.trim() || !codeComplete(step.code)} aria-busy={busy || undefined}>Continue</Button>
            </Footer>
          </form>
        );
      case 'words':
        return (
          <div className="flex flex-col gap-5">
            <ul aria-label="Words" className="flex flex-wrap justify-center gap-2 py-1">
              {step.words.map((word) => <li key={word} className="rounded-xl border border-line bg-panel px-4 py-2 text-xl font-semibold tracking-tight">{word}</li>)}
            </ul>
            <Footer>
              <Button onClick={() => { void serra()?.servers.cancel(step.probeId).catch(() => {}); probe.current = null; setStep({ step: 'mismatch', name: step.name }); }}>They don’t match</Button>
              <Button variant="primary" data-autofocus="" disabled={busy} aria-busy={busy || undefined} onClick={() => sendCode(step)}>They match</Button>
            </Footer>
          </div>
        );
      case 'mismatch':
        return <Footer><Button variant="primary" data-autofocus="" onClick={close}>Close</Button></Footer>;
      case 'locked':
        return <Footer><Button variant="primary" data-autofocus="" onClick={() => toAddress(step.address)}>Enter new code</Button></Footer>;
      case 'ssh':
        return (
          <form onSubmit={continueSsh} className="flex flex-col gap-4">
            <Input label="SSH address" value={step.target} autoFocus data-autofocus="" spellCheck={false} autoCapitalize="off" placeholder="you@t480"
              onChange={(event) => setStep({ step: 'ssh', target: event.target.value, error: null })} />
            {step.error && (
              <div role="alert" className="flex flex-col gap-0.5 rounded-lg border border-line bg-panel px-3 py-2.5">
                <p className="text-[13px] font-medium">{step.error.title}</p>
                <p className="text-xs text-muted">{step.error.line}</p>
              </div>
            )}
            <Footer>
              <Button onClick={() => toAddress(step.target)}>Back</Button>
              <Button type="submit" variant="primary" disabled={busy || !step.target.trim()} aria-busy={busy || undefined}>{busy ? 'Connecting…' : 'Continue'}</Button>
            </Footer>
          </form>
        );
      case 'ready':
        return (
          <div className="flex flex-col gap-4">
            {step.server.profiles.length > 0 && (
              <ul aria-label={`Profiles on ${step.server.name}`} className="flex flex-col divide-y divide-line rounded-xl border border-line">
                {step.server.profiles.map((profile) => {
                  const look = presence(profile.status);
                  return (
                    <li key={profile.id} className="flex items-center gap-3 px-3 py-2">
                      <span aria-hidden className={cx('size-2 shrink-0 rounded-full', look.dot === 'up' ? 'bg-up' : look.dot === 'warn' ? 'bg-warn' : look.dot === 'down' ? 'bg-down' : 'bg-faint')} />
                      <span className="flex-1 truncate text-[13px] font-medium">{profile.name}</span>
                      <span className="text-xs text-muted">{look.phrase}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <Footer><Button variant="primary" data-autofocus="" onClick={close}>Done</Button></Footer>
          </div>
        );
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={pairTitle(step)}
      description={line ? <span data-pair-line>{withCommand(line)}</span> : undefined}
    >
      <div data-pair-step={step.step}>{body()}</div>
    </Dialog>
  );
};
