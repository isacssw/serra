// Brief & policy (APP-21): edit the brief template and the owner policy with placeholder checks as you type, preview
// the brief a worker would get for a sample request (the draft, before saving), and apply a rewrite waiting in the
// profile's `proposed/`. Both files are read per job, so a save applies to the next job without a restart.
import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Eye, FileText, RotateCcw, Save, Sparkles } from 'lucide-react';
import type { BriefDocument } from '../../main/bridge.ts';
import { serra } from '../bridge.ts';
import { Badge, Button, cx, Dialog, Input, Page, useToast } from '../ui/index.ts';
import {
  DOCUMENTS, emptyDraft, isDirty, loadedDraft, proposedLabel, replacesLine, SAMPLE_REQUEST, type Draft,
} from './brief.logic.ts';
import { DiffView } from './proposals/DiffView.tsx';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Drafts = Record<BriefDocument, Draft>;
type Proposed = Partial<Record<BriefDocument, string>>;

const Tabs = ({ active, drafts, onSelect }: { active: BriefDocument; drafts: Drafts; onSelect: (document: BriefDocument) => void }) => (
  <div role="tablist" aria-label="Document" className="inline-flex w-fit rounded-md border border-line bg-raised p-0.5">
    {DOCUMENTS.map((document) => (
      <button
        key={document.id}
        type="button"
        role="tab"
        aria-selected={active === document.id}
        onClick={() => onSelect(document.id)}
        className={cx(
          'flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium',
          active === document.id ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink',
        )}
      >
        {document.label}
        {isDirty(drafts[document.id]) && <span className="size-1.5 rounded-full bg-warn" aria-label="unsaved changes" />}
      </button>
    ))}
  </div>
);

const Problems = ({ problems, dirty }: { problems: string[]; dirty: boolean }) => (
  problems.length ? (
    <ul className="flex flex-col gap-1 text-sm text-down" aria-live="polite">
      {problems.map((problem) => (
        <li key={problem} className="flex items-start gap-1.5"><CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />{problem}</li>
      ))}
    </ul>
  ) : (
    <p className="flex items-center gap-1.5 text-sm text-muted" aria-live="polite">
      <CircleCheck size={15} className="text-up" aria-hidden />
      {dirty ? 'Placeholders check out. Saving applies to the next job.' : 'Saved. Workers get this from their next job.'}
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
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-5 py-4" aria-label="Preview">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold">Preview</h2>
        <p className="text-sm text-muted">
          The brief a worker gets for this request from you in a new chat thread, with today's knowledge index.
          {dirty && ' It uses your unsaved draft.'}
        </p>
      </div>
      <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <Input className="flex-1" label="Sample request" value={request} onChange={(event) => setRequest(event.target.value)} error={error} />
        <Button type="submit" variant="primary" icon={<Eye size={16} />} disabled={busy || !request.trim()}>{busy ? 'Rendering…' : 'Preview'}</Button>
      </form>
      {result && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted">
            {result.fromDraft ? 'From the unsaved draft' : 'From the saved brief'} · {result.text.split('\n').length} lines
          </p>
          <pre className="max-h-[28rem] overflow-auto rounded-md border border-line bg-raised px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">{result.text}</pre>
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
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-5 py-4" aria-label="Proposed rewrites">
      <div className="flex flex-col gap-0.5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles size={16} className="text-accent" aria-hidden />Proposed rewrites <Badge shape="count">{names.length}</Badge>
        </h2>
        <p className="text-sm text-muted">Waiting in the profile's proposed/ folder. Compare one with what's saved, then apply it.</p>
      </div>
      <ul className="flex flex-col gap-1">
        {names.map((name) => {
          const label = proposedLabel(name);
          const active = name === selected;
          return (
            <li key={name}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => setSelected(active ? null : name)}
                className={cx('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm', active ? 'bg-raised font-medium' : 'hover:bg-raised')}
              >
                <FileText size={15} className="shrink-0 text-muted" aria-hidden />
                <span className="flex-1 truncate">{label.title}</span>
                {label.date && <span className="text-xs text-muted tabular-nums">{label.date}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {selected && proposed && (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          {documents.map((document) => (
            <div key={document.id} className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold">{document.file}</h3>
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
  const revert = () => setDrafts((current) => ({ ...current, [active]: loadedDraft(current[active].saved ?? '') }));

  const save = async () => {
    const bridge = serra();
    if (!bridge) return;
    setSaving(true);
    const document = active;
    const text = draft.text;
    try {
      await bridge.brief.save(document, text);
      setDrafts((current) => ({ ...current, [document]: { saved: text, text: current[document].text } }));
      toast({ message: `${DOCUMENTS.find((entry) => entry.id === document)!.file} saved. Workers get it from their next job.`, tone: 'success' });
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    } finally { setSaving(false); }
  };

  const about = DOCUMENTS.find((document) => document.id === active)!;
  const current = problems[active];

  return (
    <Page title="Brief & policy" subtitle="What every worker is told before it starts on a request.">
      {loadError ? (
        <p className="flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-4 text-sm text-down"><CircleAlert size={16} aria-hidden />{loadError}</p>
      ) : (
        <>
          <ProposedRewrites names={proposedNames} drafts={drafts} onApplied={load} />
          <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-5 py-4" aria-label="Editor">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Tabs active={active} drafts={drafts} onSelect={setActive} />
              <div className="flex items-center gap-2">
                <Button icon={<RotateCcw size={16} />} onClick={revert} disabled={!dirty || saving}>Revert</Button>
                <Button variant="primary" icon={<Save size={16} />} onClick={() => void save()} disabled={!dirty || saving || current.length > 0}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
            <p className="text-sm text-muted">{about.about}</p>
            <textarea
              aria-label={about.file}
              aria-invalid={current.length ? true : undefined}
              spellCheck={false}
              value={draft.text}
              disabled={draft.saved === null}
              onChange={(event) => edit(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (dirty && !current.length) void save(); }
              }}
              placeholder={active === 'policy' ? '# Owner policy\n\nAdd your workflow choices here.' : undefined}
              className={cx(
                'min-h-[24rem] resize-y rounded-md border bg-canvas px-3 py-2 font-mono text-xs leading-5 text-ink',
                'focus:outline-2 focus:outline-offset-1 focus:outline-focus',
                current.length ? 'border-down' : 'border-line',
              )}
            />
            <Problems problems={current} dirty={dirty} />
          </section>
          {active === 'brief' && <Preview draft={draft} />}
        </>
      )}
    </Page>
  );
};
