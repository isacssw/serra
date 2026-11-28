// The eve on Vercel form (SB-17), the same in Add… › Profile and Settings › Worker: the URL, and behind More the
// Vercel team and a bypass secret; then the one-line notice that names the host, with Details. The owner's yes is
// the primary button next to it, which names the host too (`eveContinueLabel`).
import { useId, useState } from 'react';
import { Cloud } from 'lucide-react';
import { Input } from '../ui/index.ts';
import { EVE_DETAILS, eveHost, eveNotice } from './eve.logic.ts';

export interface EveForm { url: string; team: string; secret: string }

export const emptyEveForm: EveForm = { url: '', team: '', secret: '' };

/** The text link that shows or hides a few lines. */
const LinkButton = ({ open, onClick, children, controls }: { open: boolean; onClick: () => void; children: string; controls: string }) => (
  <button type="button" aria-expanded={open} aria-controls={controls} onClick={onClick}
    className="rounded-sm text-[13px] text-muted underline decoration-line-control underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
    {children}
  </button>
);

export const EveFields = ({ form, onChange, error, savedSecret = false, autoFocus = false }: {
  form: EveForm;
  onChange: (form: EveForm) => void;
  /** Why the last Check failed, as main's one sentence. */
  error?: string | null;
  /** A secret is saved already: blank keeps it. */
  savedSecret?: boolean;
  autoFocus?: boolean;
}) => {
  const moreId = useId();
  const detailsId = useId();
  const [more, setMore] = useState(Boolean(form.team || form.secret));
  const [details, setDetails] = useState(false);
  const host = eveHost(form.url);
  // A protected deployment needs the secret: open More so its field is right there.
  const showMore = more || /protected/.test(error ?? '');
  return (
    <div className="flex flex-col gap-3">
      <Input label="Agent URL" placeholder="https://researcher.vercel.app" spellCheck={false} autoComplete="off" autoFocus={autoFocus} data-autofocus={autoFocus || undefined}
        value={form.url} onChange={(event) => onChange({ ...form, url: event.target.value })} />
      {showMore ? (
        <div id={moreId} className="grid gap-3 sm:grid-cols-2">
          <Input label="Vercel team" placeholder="acme" spellCheck={false} autoComplete="off" hint="Only if you’re in several teams."
            value={form.team} onChange={(event) => onChange({ ...form, team: event.target.value })} />
          <Input label="Bypass secret" type="password" placeholder={savedSecret ? 'Saved' : 'Optional'} spellCheck={false} autoComplete="off"
            hint="Stored in Keychain." value={form.secret} onChange={(event) => onChange({ ...form, secret: event.target.value })} />
        </div>
      ) : (
        <div><LinkButton open={false} controls={moreId} onClick={() => setMore(true)}>More</LinkButton></div>
      )}
      {host && (
        <div className="flex flex-col gap-2">
          <p className="flex items-start gap-2 text-[13px] text-muted">
            <Cloud size={14} strokeWidth={1.75} aria-hidden className="mt-[3px] shrink-0 text-faint" />
            <span>{eveNotice(host)} <LinkButton open={details} controls={detailsId} onClick={() => setDetails(!details)}>Details</LinkButton></span>
          </p>
          {details && (
            <ul id={detailsId} className="ml-[22px] flex list-disc flex-col gap-1 pl-4 text-xs text-muted marker:text-faint">
              {EVE_DETAILS.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-[13px] text-down">{error}</p>}
    </div>
  );
};
