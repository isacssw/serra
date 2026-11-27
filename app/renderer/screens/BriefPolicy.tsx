// Brief & policy (APP-21): edit the brief template and the owner policy with placeholder checks as you type, preview
// the brief a worker would get for a sample request (the draft, before saving), and apply a rewrite waiting in the
// profile's `proposed/`. Both files are read per job, so a save applies to the next job without a restart.
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, CircleAlert, CircleCheck, Eye, Sparkles } from 'lucide-react';
import type { BriefDocument } from '../../main/bridge.ts';
import { serra } from '../bridge.ts';
import { Badge, Button, cx, Dialog, Input, Page, useToast } from '../ui/index.ts';
import { fieldClass } from '../ui/field.ts';
import { SaveBar } from './settings/SettingsKit.tsx';
import {
  DOCUMENTS, emptyDraft, isDirty, loadedDraft, proposedLabel, replacesLine, SAMPLE_REQUEST, type Draft,
} from './brief.logic.ts';
import { DiffView } from './proposals/DiffView.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Drafts = Record<BriefDocument, Draft>;
type Proposed = Partial<Record<BriefDocument, string>>;

const Tabs = ({ active, drafts, onSelect }: { active: BriefDocument; drafts: Drafts; onSelect: (document: BriefDocument) => void }) => (
  <div
    role="tablist"
    aria-label="Document"
    className="inline-flex w-fit gap-0.5 rounded-lg border border-line bg-hover p-0.5"
    onKeyDown={(event) => {
      // Arrows, Home and End move between the two documents, as a tablist does.
      const at = DOCUMENTS.findIndex((document) => document.id === active);
      const to = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? DOCUMENTS.length - 1 : null;
      if (to === null) return;
      event.preventDefault();
      const next = DOCUMENTS[(to + DOCUMENTS.length) % DOCUMENTS.length]!;
      onSelect(next.id);
      requestAnimationFrame(() => document.getElementById(`brief-tab-${next.id}`)?.focus());
    }}
  >
    {DOCUMENTS.map((document) => (
      <button
        key={document.id}
        id={`brief-tab-${document.id}`}
        type="button"
        role="tab"
        aria-selected={active === document.id}
        tabIndex={active === document.id ? 0 : -1}
        onClick={() => onSelect(document.id)}
        className={cx(
          'relative flex h-7 items-center rounded-md border px-3.5 text-[13px] font-medium transition-colors duration-150',
          'focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-focus',
          active === document.id ? 'border-line-strong bg-overlay text-ink shadow-field' : 'border-transparent text-muted hover:text-ink',
        )}
      >
        {document.label}
        {/* The dot sits in the corner, taking no width, so the segments don't shift as you type. */}
        {isDirty(drafts[document.id]) && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-warn" aria-label="unsaved changes" />}
      </button>
    ))}
  </div>
);

const Problems = ({ problems, dirty }: { problems: string[]; dirty: boolean }) => (
  problems.length ? (
    <ul id="brief-problems" className="flex flex-col gap-1 text-xs text-down" aria-live="polite">
      {problems.map((problem) => (
        <li key={problem} className="flex items-start gap-1.5"><CircleAlert size={13} className="mt-px shrink-0" aria-hidden />{problem}</li>
      ))}
    </ul>
  ) : (
    <p className="flex items-center gap-1.5 text-xs text-faint" aria-live="polite">
      <CircleCheck size={13} className="text-up" aria-hidden />
      {dirty ? 'Placeholders look good' : 'Saved'}
    </p>
  )
);

const Preview = ({ draft }: { draft: Draft }) => {
  const [request, setRequest] = useState(SAMPLE_REQUEST);
  const [result, setResult] = useState<{ text: string; fromDraft: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = isDirty(draft);

  const run = async () => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      const text = dirty ? await bridge.brief.preview(request, draft.text) : await bridge.brief.preview(request);
      setResult({ text, fromDraft: dirty });
    } catch (failure) {
      setResult(null);
      setError(message(failure));
    } finally { setBusy(false); }
  };

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-7" aria-labelledby="brief-preview">
      <h2 id="brief-preview" className="text-sm leading-5 font-semibold">Preview</h2>
      <form className="flex items-start gap-2" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <Input className="flex-1" aria-label="Sample request" placeholder="A sample request" value={request} onChange={(event) => setRequest(event.target.value)} error={error} />
        <Button type="submit" icon={<Eye size={14} />} disabled={busy || !request.trim()}>{busy ? 'Rendering…' : 'Preview'}</Button>
      </form>
      {result && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-faint">
            {result.fromDraft ? 'From the unsaved draft' : 'From the saved brief'} · {result.text.split('\n').length} lines
          </p>
          <pre className="max-h-[28rem] overflow-auto rounded-lg border border-line bg-raised px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap">{result.text}</pre>
        </div>
      )}
    </section>
  );
};

const ProposedRewrites = ({ names, drafts, onApplied }: { names: string[]; drafts: Drafts; onApplied: () => Promise<void> }) => {
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [proposed, setProposed] = useState<Proposed | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selected && !names.includes(selected)) setSelected(null);
  }, [names, selected]);

  useEffect(() => {
    setProposed(null);
    const bridge = serra();
    if (!selected || !bridge) return;
    let live = true;
    bridge.brief.readProposed(selected)
      .then((value) => { if (live) setProposed(value); })
      .catch((error: unknown) => { if (live) toast({ message: message(error), tone: 'error' }); });
    return () => { live = false; };
  }, [selected, toast]);

  if (!names.length) return null;
  const documents = proposed ? DOCUMENTS.filter((document) => proposed[document.id] !== undefined) : [];
  const unsaved = documents.filter((document) => isDirty(drafts[document.id]));

  const apply = async () => {
    const bridge = serra();
    if (!bridge || !selected) return;
    setBusy(true);
    try {
      await bridge.brief.applyProposed(selected);
      setConfirming(false);
      setSelected(null);
      toast({ message: `Applied “${proposedLabel(selected).title}”. Workers get it from their next job.`, tone: 'success' });
      await onApplied();
    } catch (error) {
      setConfirming(false);
      toast({ message: message(error), tone: 'error' });
    } finally { setBusy(false); }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="brief-proposed">
      <h2 id="brief-proposed" className="flex items-center gap-2 text-sm leading-5 font-semibold">
        <Sparkles size={14} className="text-muted" aria-hidden />Proposed rewrites <Badge shape="count">{names.length}</Badge>
      </h2>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
        {names.map((name) => {
          const label = proposedLabel(name);
          const active = name === selected;
          return (
            <li key={name}>
              <button
                type="button"
                aria-expanded={active}
                onClick={() => setSelected(active ? null : name)}
                className={cx(
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] transition-colors duration-150',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                  active ? 'bg-raised' : 'hover:bg-hover',
                )}
              >
                <span className="flex-1 truncate font-medium text-ink">{label.title}</span>
                {label.date && <span className="text-xs text-faint tabular-nums">{label.date}</span>}
                <span className="flex items-center gap-1 text-xs text-muted">{active ? 'Hide' : 'Review'}<ChevronRight size={14} aria-hidden className={cx('transition-transform duration-150', active && 'rotate-90')} /></span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected && proposed && (
        <div className="flex flex-col gap-4">
          {documents.map((document) => (
            <div key={document.id} className="flex flex-col gap-1.5">
              <h3 className="font-mono text-xs font-medium text-muted">{document.file}</h3>
              <DiffView current={drafts[document.id].saved ?? null} proposed={proposed[document.id]!} />
            </div>
          ))}
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setConfirming(true)} disabled={busy}>Apply rewrite…</Button>
          </div>
        </div>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Apply “${selected ? proposedLabel(selected).title : ''}”?`}
        description={replacesLine(documents.map((document) => document.id))}
        actions={<>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void apply()} disabled={busy}>{busy ? 'Applying…' : 'Apply'}</Button>
        </>}
      >
        {unsaved.length > 0 && (
          <p className="text-sm text-warn">Your unsaved changes to {unsaved.map((document) => document.file).join(' and ')} will be discarded.</p>
        )}
      </Dialog>
    </section>
  );
};

export const BriefPolicy = () => {
  const toast = useToast();
  const [active, setActive] = useState<BriefDocument>('brief');
  const [drafts, setDrafts] = useState<Drafts>({ brief: emptyDraft(), policy: emptyDraft() });
  const [problems, setProblems] = useState<Record<BriefDocument, string[]>>({ brief: [], policy: [] });
  const [proposedNames, setProposedNames] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setLoadError('The brief editor needs the Serra app.'); return; }
    try {
      const [brief, policy, names] = await Promise.all([bridge.brief.read('brief'), bridge.brief.read('policy'), bridge.brief.listProposed()]);
      setDrafts({ brief: loadedDraft(brief), policy: loadedDraft(policy) });
      setProposedNames(names);
      setLoadError(null);
    } catch (error) { setLoadError(message(error)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const draft = drafts[active];
  const dirty = isDirty(draft);

  // Check the draft shortly after typing stops; the service's rules are the only source of truth.
  useEffect(() => {
    const bridge = serra();
    if (!bridge || draft.saved === null) return;
    let live = true;
    const timer = setTimeout(() => {
      bridge.brief.check(active, draft.text)
        .then((found) => { if (live) setProblems((current) => ({ ...current, [active]: found })); })
        .catch(() => {});
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [active, draft.text, draft.saved]);

  const edit = (text: string) => setDrafts((current) => ({ ...current, [active]: { ...current[active], text } }));
  // The save bar covers both documents: an edit to the brief stays unsaved, and saveable, while Policy is open.
  const unsaved = DOCUMENTS.filter((document) => isDirty(drafts[document.id]));
  const revert = () => setDrafts((current) => ({
    brief: loadedDraft(current.brief.saved ?? ''), policy: loadedDraft(current.policy.saved ?? ''),
  }));

  const save = async () => {
    const bridge = serra();
    if (!bridge) return;
    setSaving(true);
    try {
      for (const { id: document, file } of unsaved) {
        const text = drafts[document].text;
        await bridge.brief.save(document, text);
        setDrafts((current) => ({ ...current, [document]: { saved: text, text: current[document].text } }));
        toast({ message: `${file} saved. Workers get it from their next job.`, tone: 'success' });
      }
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    } finally { setSaving(false); }
  };

  const about = DOCUMENTS.find((document) => document.id === active)!;
  const current = problems[active];

  return (
    <Page title="Brief & policy" subtitle="What every worker reads before it starts." width="narrow">
      {loadError ? (
        <p role="alert" className="flex items-center gap-2 rounded-xl border border-down/30 bg-down/8 px-4 py-2.5 text-[13px] text-ink"><CircleAlert size={15} className="text-down" aria-hidden />{loadError}</p>
      ) : (
        <>
          <ProposedRewrites names={proposedNames} drafts={drafts} onApplied={load} />
          <section className="flex flex-col gap-3" aria-label="Editor">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Tabs active={active} drafts={drafts} onSelect={setActive} />
              <span className="font-mono text-xs text-faint" title={about.about}>{about.hint}</span>
            </div>
            <textarea
              aria-label={about.file}
              aria-invalid={current.length ? true : undefined}
              aria-describedby={current.length ? 'brief-problems' : undefined}
              spellCheck={false}
              value={draft.text}
              disabled={draft.saved === null}
              onChange={(event) => edit(event.target.value)}
              placeholder={active === 'policy' ? '# Owner policy\n\nAdd your workflow choices here.' : undefined}
              className={cx('min-h-[20rem] max-h-[calc(100vh-20rem)] resize-none px-3.5 py-3 font-mono text-xs leading-5 [field-sizing:content]', fieldClass(current.length > 0))}
            />
            <Problems problems={current} dirty={dirty} />
          </section>
          {active === 'brief' && <Preview draft={draft} />}
          {/* Room for the floating save bar at the end of the page, so the last lines aren't under it. */}
          {unsaved.length > 0 && <div aria-hidden className="h-14" />}
          <SaveBar
            changed={unsaved.length > 0}
            count={unsaved.length}
            valid={unsaved.every((document) => problems[document.id].length === 0)}
            saving={saving}
            note={`${unsaved.map((document) => document.file).join(' and ')} · Applies on the next job`}
            onSave={() => void save()}
            onReset={revert}
            onReveal={() => { const bad = unsaved.find((document) => problems[document.id].length > 0); if (bad) setActive(bad.id); }}
          />
        </>
      )}
    </Page>
  );
};
