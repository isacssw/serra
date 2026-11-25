// Knowledge → Pages (APP-20): every page the index points workers at, with its verified, unverified or stale badge,
// and a Markdown editor. The editor checks the header and the line cap as the owner types, with the same rules and
// message the service refuses a save with, so Save stays disabled until the page would pass `pnpm knowledge`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, FileText, Search } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import type { KnowledgePage } from '../../../src/contracts.ts';
import type { KnowledgeOverview } from '../../../src/knowledge-overview.ts';
import { serra } from '../bridge.ts';
import { frontmatter, pageBody, setHeaderField } from '../../../src/knowledge-rules.ts';
import { pageAudience } from '../../../src/owner-model.ts';
import { AudienceChoice } from './AudienceChoice.tsx';
import { RuleDiff } from './proposals/RuleDiff.tsx';
import { PageBody } from './PageBody.tsx';
import { Badge, Button, cx, Dialog, Page, useToast } from '../ui/index.ts';
import {
  badgeLabel, currentRules, badgeTitle, badgeTone, editorState, filterPages, groupByArea, keepSelection, localDate, markVerified,
  pageName,
} from './pages.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Who may hear the page, set in its header as the owner types. A page without one is the owner's only. Save to keep it. */
const AudiencePicker = ({ text, disabled, onChange }: { text: string; disabled: boolean; onChange: (text: string) => void }) => (
  <AudienceChoice
    id="page-audience"
    value={pageAudience(frontmatter(text))}
    disabled={disabled || frontmatter(text) === null}
    onChange={(audience) => onChange(setHeaderField(text, 'audience', audience))}
  />
);

type Drifted = { path: string; approved: string | null; current: string | null };

/**
 * Files under knowledge/ that changed outside Serra (by hand, or a worker in a thread). Workers keep getting the
 * approved version until the owner looks at each change and accepts it as theirs or puts the approved text back.
 */
const DriftNotice = ({ files, busy, onAccept, onRestore, name }: {
  name: (path: string) => string; files: Drifted[]; busy: boolean; onAccept: (file: Drifted) => void; onRestore: (file: Drifted) => void;
}) => {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-labelledby="drift-title" className="flex gap-3 rounded-lg border border-line bg-panel p-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="drift-title" className="text-sm font-semibold">
          {files.length === 1 ? '1 hand edit' : `${files.length} hand edits`}
        </h2>
        <ul className="mt-2 flex flex-col divide-y divide-line-subtle border-t border-line-subtle">
          {files.map((file) => (
            <li key={file.path} className="flex flex-col gap-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-expanded={open === file.path}
                  onClick={() => setOpen(open === file.path ? null : file.path)}
                  className="inline-flex min-w-0 items-center gap-1 rounded-md px-1 text-left font-mono text-xs text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <ChevronRight size={13} aria-hidden className={cx('shrink-0 transition-transform', open === file.path && 'rotate-90')} />
                  <span className="truncate font-sans" title={file.path}>{name(file.path)}</span>
                </button>
                <span className="text-xs text-muted">{file.current === null ? 'deleted' : file.approved === null ? 'new' : 'edited'}</span>
                <span className="ml-auto flex gap-1">
                  {/* Accepted only once seen: the first click shows the change. */}
                  {open === file.path
                    ? <Button size="sm" variant="primary" disabled={busy} onClick={() => onAccept(file)} title="The bot uses it from now on">Accept</Button>
                    : <Button size="sm" disabled={busy} onClick={() => setOpen(file.path)}>See change</Button>}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRestore(file)} title="Put back the version you approved">Undo it</Button>
                </span>
              </div>
              {open === file.path && <RuleDiff current={file.approved} proposed={file.current ?? ''} labels={['Approved', 'Now']} emptyCurrent="Not in the approved knowledge." />}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};


const PageList = ({ pages, selected, onSelect }: { pages: KnowledgePage[]; selected: string | null; onSelect: (path: string) => void }) => (
  <div className="flex flex-col gap-4">
    {groupByArea(pages).map((group) => (
      <section key={group.area} className="flex flex-col gap-1">
        <h2 className="px-1 text-xs font-semibold text-muted">{group.area}</h2>
        {group.pages.map((page) => {
          const active = page.path === selected;
          return (
            <button
              key={page.path}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(page.path)}
              title={page.path}
              className={cx(
                'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm',
                'focus-visible:outline-2 focus-visible:outline-focus',
                active ? 'border-line-strong bg-selected' : 'border-transparent hover:bg-raised',
              )}
            >
              <FileText size={15} aria-hidden className="shrink-0 text-muted" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{page.description ?? pageName(page.path)}</span>
              </span>
              {page.problems.length > 0 && (
                <AlertTriangle size={14} aria-label="Fails the knowledge check" className="shrink-0 text-down" />
              )}
              {/* Only what needs a look gets a pill: a list of "Verified" says nothing. */}
              {page.badge !== 'verified' && <Badge tone={badgeTone(page.badge)} title={badgeTitle(page)}>{badgeLabel(page.badge)}</Badge>}
            </button>
          );
        })}
      </section>
    ))}
  </div>
);

/**
 * Rules on this page that disagree with or repeat another, shown as they read. Overview's To do keeps one in a click
 * where it can; here the page's own Edit settles it, so a rule inside a sentence of prose is never a dead end.
 */
const RulesNote = ({ issues, oneClick, onSettle }: { issues: KnowledgeOverview['health']['issues']; oneClick: boolean; onSettle: () => void }) => {
  const pairs = issues.filter((issue) => (issue.kind === 'conflict' || issue.kind === 'duplicate') && (issue.facts?.length ?? 0) === 2);
  if (pairs.length === 0) return null;
  return (
    <section aria-label="Rules to settle" className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-panel px-3 py-2.5">
      {pairs.map((issue, at) => (
        <div key={at} className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 text-[13px]"><AlertTriangle size={14} aria-hidden className="text-warn" />{issue.kind === 'conflict' ? 'Two rules disagree' : 'Written twice'}</p>
          {issue.facts!.map((fact) => <p key={fact.text} className="border-l-2 border-line pl-2 text-xs text-muted" title={fact.page}>{fact.text}</p>)}
        </div>
      ))}
      {/* Only where To do can settle it in a click: a rule inside prose stays here, with the page's Edit. */}
      {oneClick && <button type="button" onClick={onSettle} className="self-start text-xs text-ink underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-focus">Settle in To do</button>}
    </section>
  );
};

export const Pages = () => {
  const navigate = useNavigate();
  const toast = useToast();
  const [pages, setPages] = useState<KnowledgePage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** A page the owner clicked while the draft had unsaved changes; the discard dialog asks first. */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  /** Retired pages, listed under Archived with Restore. */
  const [archived, setArchived] = useState<{ path: string; description: string }[]>([]);
  /** Pages open as they read; the Markdown, header and all, only when the owner chooses to edit. */
  const [editing, setEditing] = useState(false);
  /** "Still true" only where nothing suggests the page changed: no rule on it disagrees, no newer page on its topic. */
  const [confirmable, setConfirmable] = useState(false);
  /** Rules on the open page that disagree with or repeat another, as saved. */
  const [pairs, setPairs] = useState<KnowledgeOverview['health']['issues']>([]);
  const [drifted, setDrifted] = useState<Drifted[]>([]);
  const [resolving, setResolving] = useState(false);
  /** Bumped after an outside change is accepted or restored, so the open page shows its text as it is now. */
  const [readVersion, setReadVersion] = useState(0);

  // `?page=<path>` (About me's Edit) opens that page, once.
  const [search, setSearch] = useSearchParams();
  const asked = search.get('page');
  useEffect(() => {
    if (asked === null) return;
    setSearch((current) => { const next = new URLSearchParams(current); next.delete('page'); return next; }, { replace: true });
    setSelected(asked);
  }, [asked, setSearch]);

  const reload = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setLoadError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      const [list, drift, gone] = await Promise.all([bridge.pages.list(), bridge.pages.drift(), bridge.proposals.archived().catch(() => [])]);
      setPages(list);
      setDrifted(drift);
      setArchived(gone);
      setLoadError(null);
      setSelected((current) => keepSelection(list, current));
    } catch (error) {
      setLoadError(message(error));
    }
  }, []);

  useEffect(() => {
    void reload();
    // Badges change with time and with merges from Proposals; coming back to the window rereads the list (not the draft).
    const refresh = () => { void reload(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [reload]);

  useEffect(() => {
    const bridge = serra();
    setSaved(null);
    setDraft('');
    setReadError(null);
    if (!bridge || !selected) return;
    let live = true;
    bridge.pages.read(selected).then(
      (text) => { if (live) { setSaved(text); setDraft(text); } },
      (error) => { if (live) setReadError(message(error)); },
    );
    setPairs([]);
    setEditing(false);
    setConfirmable(false);
    bridge.pages.canConfirm(selected).then((ok) => { if (live) setConfirmable(ok); }, () => undefined);
    bridge.pages.issues(selected).then((found) => { if (live) setPairs(found); }, () => undefined);
    return () => { live = false; };
  }, [selected, readVersion]);

  const page = pages?.find((entry) => entry.path === selected) ?? null;
  const state = useMemo(() => (selected && saved !== null ? editorState(selected, saved, draft) : null), [selected, saved, draft]);
  const visible = useMemo(() => filterPages(pages ?? [], 'all', query), [pages, query]);

  const resolveDrift = async (file: Drifted, accept: boolean) => {
    const bridge = serra();
    if (!bridge || resolving) return;
    setResolving(true);
    try {
      if (accept) await bridge.pages.acceptDrift(file.path, file.current);
      else await bridge.pages.restoreDrift(file.path);
      toast({ message: accept ? `Accepted ${file.path}. The bot uses it now.` : `Restored ${file.path}. The replaced text is in backups/knowledge/.`, tone: 'success' });
      await reload();
      // Only the open page's own change reloads it; a draft of another page is left alone.
      if (selected === file.path) setReadVersion((version) => version + 1);
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
      await reload();
    } finally {
      setResolving(false);
    }
  };

  const select = (path: string) => {
    if (path === selected) return;
    if (state?.dirty) setPendingSelect(path);
    else setSelected(path);
  };

  const save = async () => {
    const bridge = serra();
    if (!bridge || !selected || !state?.canSave || saving) return;
    setSaving(true);
    try {
      const updated = await bridge.pages.save(selected, draft, saved ?? undefined);
      const text = await bridge.pages.read(selected);
      setSaved(text);
      setDraft(text);
      setPages((list) => list?.map((entry) => (entry.path === updated.path ? updated : entry)) ?? list);
      // What the page still has to settle, as saved: a kept rule leaves the panel and the warning.
      bridge.pages.issues(updated.path).then(setPairs, () => undefined);
      toast({ message: `Saved ${updated.path}. The old text is in the profile's backups/knowledge/.`, tone: 'success' });
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  /** Bring a retired page back where it was. */
  const restore = async (path: string) => {
    const bridge = serra();
    if (!bridge) return;
    try {
      await bridge.proposals.restore(path);
      await reload();
      toast({ message: 'Restored. The bot uses it again.', tone: 'success' });
    } catch (error) { toast({ message: message(error), tone: 'error' }); }
  };

  /** The page still holds: its confirmed date becomes today, saved straight away. */
  const confirmToday = async () => {
    const bridge = serra();
    if (!bridge || !selected || saved === null || saving) return;
    setSaving(true);
    try {
      await bridge.pages.save(selected, markVerified(saved, localDate(new Date())), saved);
      setReadVersion((version) => version + 1);
      await reload();
      toast({ message: 'Marked as still true today.', tone: 'success' });
    } catch (error) { toast({ message: message(error), tone: 'error' }); } finally { setSaving(false); }
  };

  /** Takes the open page out of what the bot knows: it moves to archive/, its index row goes, and undo brings it back. */
  const retire = async () => {
    const bridge = serra();
    const path = selected;
    setRetiring(false);
    if (!bridge || !path || saved === null) return;
    try {
      const { undoId } = await bridge.proposals.retire(path, saved);
      setSelected(null);
      await reload();
      toast({
        message: `Retired ${path}. The bot no longer uses it; it's kept in archive/.`, tone: 'success',
        action: { label: 'Undo', onClick: () => { bridge.proposals.undo(undoId).then(() => reload(), (error: unknown) => toast({ message: message(error), tone: 'error' })); } },
      });
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    }
  };

  // ⌘S / Ctrl+S saves, through the same checks as the button.
  // A page picked from the list comes into view, wherever the list left the window scrolled.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = detailRef.current;
    if (!selected || !el) return;
    const top = el.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.6 || top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [selected]);

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Page title="Pages">
      {loadError && <p role="alert" className="text-sm text-down">{loadError}</p>}
      {drifted.length > 0 && (
        <DriftNotice name={(path) => pages?.find((entry) => entry.path === path)?.description ?? path} files={drifted} busy={resolving} onAccept={(file) => void resolveDrift(file, true)} onRestore={(file) => void resolveDrift(file, false)} />
      )}
      {pages && pages.length === 0 && (
        <p className="text-sm text-muted">No pages yet.</p>
      )}
      {pages && pages.length > 0 && (
        <div className="flex flex-col gap-6 border-t border-line pt-5 lg:flex-row lg:items-start">
          <nav aria-label="Pages" className="flex w-full shrink-0 lg:w-72 flex-col gap-3">
            {/* A short list needs no search. */}
            {pages.length > 8 && (
              <div className="relative flex items-center">
              <Search size={15} aria-hidden className="pointer-events-none absolute left-2.5 text-muted" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter pages"
                aria-label="Filter pages"
                className="h-8 w-full rounded-md border border-line bg-panel pl-8 pr-2 text-sm text-ink placeholder:text-muted focus:outline-2 focus:outline-offset-1 focus:outline-focus"
              />
            </div>
            )}
            {visible.length > 0
              ? <>
                <PageList pages={visible} selected={selected} onSelect={select} />
                {archived.length > 0 && (
                  <section aria-label="Archived" className="flex flex-col gap-1 border-t border-line-subtle pt-3">
                    <h2 className="px-1 text-xs font-semibold text-muted">Archived</h2>
                    {archived.map((item) => (
                      <div key={item.path} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                        <span className="min-w-0 flex-1 truncate text-muted" title={item.path}>{item.description || item.path}</span>
                        <Button size="sm" variant="ghost" onClick={() => void restore(item.path)}>Restore</Button>
                      </div>
                    ))}
                  </section>
                )}
              </>
              : <p className="px-1 text-sm text-muted">No pages match.</p>}
          </nav>

          <div ref={detailRef} className="flex min-w-0 flex-1 scroll-mt-4 flex-col gap-4 border-line lg:border-l lg:pl-6">
            {readError && <p role="alert" className="text-sm text-down">{readError}</p>}
            {!page && !readError && <p className="text-sm text-muted">Pick a page to edit.</p>}
            {page && (
              <>
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{page.description ?? page.path}</h2>
                    {/* A page whose rules disagree isn't settled, however recently it was confirmed. */}
                    {!pairs.some((issue) => issue.kind === 'conflict') && page.badge !== 'verified' && <Badge tone={badgeTone(page.badge)} title={badgeTitle(page)}>{badgeLabel(page.badge)}</Badge>}
                  </div>
                </div>
                {(page.warnings.length > 0 || page.problems.length > 0) && (
                  <ul className="flex flex-col gap-1 text-sm">
                    {page.problems.map((problem) => (
                      <li key={problem} className="flex gap-2 text-down"><AlertTriangle size={15} aria-hidden className="mt-0.5 shrink-0" />{problem}</li>
                    ))}
                    {page.warnings.map((warning) => (
                      <li key={warning} className="flex gap-2 text-warn"><AlertTriangle size={15} aria-hidden className="mt-0.5 shrink-0" />{warning}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {page && saved === null && !readError && <p className="text-sm text-muted">Loading…</p>}
            {page && state && (
              <>
                <AudiencePicker text={draft} disabled={saving} onChange={setDraft} />
                <RulesNote
                  issues={pairs}
                  oneClick={pairs.some((issue) => issue.kind === 'conflict' && (issue.facts ?? []).length === 2 && issue.facts!.every((fact) => fact.page === selected && currentRules(saved ?? '').includes(fact.text)))}
                  onSettle={() => void navigate('/knowledge/overview#todo')}
                />
                {!editing && !state.dirty && (
                  <div className="flex flex-col gap-3">
                    <div className="rounded-lg border border-line bg-panel"><PageBody text={pageBody(draft)} onOpen={(href) => void serra()?.app.openExternal(href)} /></div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="primary" onClick={() => setEditing(true)}>Edit</Button>
                      {confirmable && <Button disabled={saving} title="It still holds: mark it confirmed today." onClick={() => void confirmToday()}>Still true</Button>}
                      <Button variant="ghost" disabled={saving} title="Stop using this page. It moves to the archive; you can undo." onClick={() => setRetiring(true)}>Retire…</Button>
                    </div>
                  </div>
                )}
                {(editing || state.dirty) && <>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                  aria-label={`Markdown of ${page.path}`}
                  aria-invalid={state.problems.length > 0 ? true : undefined}
                  aria-describedby="page-editor-status"
                  className={cx(
                    'min-h-[28rem] w-full resize-y rounded-md border bg-panel p-3 font-mono text-[13px] leading-5 text-ink',
                    'focus:outline-2 focus:outline-offset-1 focus:outline-focus',
                    state.problems.length > 0 ? 'border-down' : 'border-line',
                  )}
                />
                <div id="page-editor-status" className="flex flex-col gap-2">
                  {state.refusal ? (
                    <div role="alert" className="flex flex-col gap-1 text-sm text-down">
                      {state.refusal.split('\n').map((line, index) => <p key={index}>{line}</p>)}
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-sm text-muted">
                      {pairs.some((issue) => (issue.kind === 'conflict' || issue.kind === 'duplicate') && (issue.facts ?? []).filter((fact) => fact.page !== selected || currentRules(draft).some((line) => line.includes(fact.text))).length >= 2)
                        ? <><AlertTriangle size={15} aria-hidden className="text-warn" />Keep only one of the rules above</>
                        : <><CheckCircle2 size={15} aria-hidden className="text-up" />Looks good</>}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={!state.canSave || saving} title={state.refusal ?? undefined} onClick={() => void save()}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                  <Button disabled={!state.dirty || saving} onClick={() => setDraft(saved ?? '')}>Revert</Button>
                  <Button
                    variant="ghost"
                    disabled={saving}
                    title="Set the header's verified date to today. Save to keep it."
                    onClick={() => setDraft((text) => markVerified(text, localDate(new Date())))}
                  >
                    Mark verified today
                  </Button>
                  <Button variant="ghost" disabled={saving || state.dirty} title={state.dirty ? 'Save or revert your edits first.' : 'Stop using this page. It moves to archive/; you can undo.'} onClick={() => setRetiring(true)}>
                    Retire…
                  </Button>
                  {!state.dirty && <Button variant="ghost" onClick={() => setEditing(false)}>Done</Button>}
                  <span className={cx('ml-auto text-xs tabular-nums', state.overCap ? 'text-down' : 'text-muted')}>{state.linesLabel}</span>
                </div>
                </>}
              </>
            )}
          </div>
        </div>
      )}
      <Dialog
        open={retiring}
        onClose={() => setRetiring(false)}
        title={`Retire ${page?.description ?? selected ?? 'this page'}?`}
        description="The bot stops using it. It moves to the archive, and you can undo."
        actions={(
          <>
            <Button data-autofocus onClick={() => setRetiring(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void retire()}>Retire</Button>
          </>
        )}
      />
      <Dialog
        open={pendingSelect !== null}
        onClose={() => setPendingSelect(null)}
        title="Discard your changes?"
        description={selected ? `${selected} has edits that aren't saved.` : undefined}
        actions={(
          <>
            <Button onClick={() => setPendingSelect(null)}>Keep editing</Button>
            <Button
              variant="danger"
              onClick={() => {
                const next = pendingSelect;
                setPendingSelect(null);
                if (next) setSelected(next);
              }}
            >
              Discard
            </Button>
          </>
        )}
      />
    </Page>
  );
};
