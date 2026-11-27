// Knowledge → Pages (APP-20): every page the index points workers at, with its verified, unverified or stale badge,
// and a Markdown editor. The editor checks the header and the line cap as the owner types, with the same rules and
// message the service refuses a save with, so Save stays disabled until the page would pass `pnpm knowledge`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Archive, Check, CheckCircle2, ChevronRight, Pencil, Search } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import type { KnowledgePage } from '../../../src/contracts.ts';
import type { KnowledgeOverview } from '../../../src/knowledge-overview.ts';
import { serra } from '../bridge.ts';
import { frontmatter, pageBody, setHeaderField } from '../../../src/knowledge-rules.ts';
import { pageAudience } from '../../../src/owner-model.ts';
import { AudienceChoice } from './AudienceChoice.tsx';
import { RuleDiff } from './proposals/RuleDiff.tsx';
import { PageBody } from './PageBody.tsx';
import { aboutCard } from './about.logic.ts';

/** The body as it reads under the page's title: without its own first heading when that heading is the title. */
const readBody = (page: KnowledgePage, body: string): string => {
  const card = aboutCard(page.path, body);
  return card.title.toLowerCase() === pageLabel(page).toLowerCase() ? card.body : body;
};
import { Badge, Button, cx, Dialog, EmptyState, Page, useToast } from '../ui/index.ts';
import { fieldClass } from '../ui/field.ts';
import {
  badgeLabel, currentRules, badgeTitle, badgeTone, editorState, filterPages, groupByArea, keepSelection, localDate, markVerified,
  pageDetail, pageLabel, pageMeta,
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


/** A page's state in the list, as quietly as it can be said: a check for verified, a dot for stale, a mark for a broken page. */
const RowMark = ({ page }: { page: KnowledgePage }) => {
  if (page.problems.length > 0) return <AlertTriangle size={14} aria-label="Fails the knowledge check" className="mt-0.5 shrink-0 text-down" />;
  if (page.disputed) return <span aria-label="Rules disagree" title="Rules disagree" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />;
  if (page.badge === 'verified') return <Check size={14} strokeWidth={2} aria-label="Verified" className="mt-0.5 shrink-0 text-faint" />;
  if (page.badge === 'stale') return <span aria-label="Stale" title={badgeTitle(page)} className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn" />;
  return null;
};

const PageList = ({ pages, selected, onSelect }: { pages: KnowledgePage[]; selected: string | null; onSelect: (path: string) => void }) => (
  <div className="flex flex-col gap-4">
    {groupByArea(pages).map((group) => (
      <section key={group.area} aria-label={group.area} className="flex flex-col gap-px">
        <h2 className="px-2.5 pb-1 text-xs font-medium text-faint">{group.area}</h2>
        {group.pages.map((page) => {
          const active = page.path === selected;
          const detail = pageDetail(page);
          return (
            <button
              key={page.path}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(page.path)}
              title={page.path}
              className={cx(
                'flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                active ? 'bg-selected' : 'hover:bg-hover',
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cx('truncate text-[13px] leading-5 text-ink', active && 'font-medium')}>{pageLabel(page)}</span>
                {detail && <span className="truncate text-xs leading-4 text-muted">{detail}</span>}
              </span>
              <RowMark page={page} />
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
    <section aria-label="Rules to settle" className="flex flex-col gap-2.5 rounded-xl border border-warn/40 bg-warn/5 px-4 py-3">
      {pairs.map((issue, at) => (
        <div key={at} className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-warn"><AlertTriangle size={14} aria-hidden />{issue.kind === 'conflict' ? 'Two rules disagree' : 'A rule is written twice'}</p>
          {issue.facts!.map((fact) => <p key={fact.text} className="border-l-2 border-warn/40 pl-2.5 text-[13px] text-ink" title={fact.page}>{fact.text}</p>)}
        </div>
      ))}
      {/* Only where To do can settle it in a click: a rule inside prose stays here, with the page's Edit. */}
      {oneClick && <Button size="sm" className="self-start" onClick={onSettle}>Settle in To do</Button>}
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

  const filter = pages && pages.length > 8 && (
    <div className="relative flex w-56 items-center">
      <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 text-faint" />
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); } }}
        placeholder="Filter pages"
        aria-label="Filter pages"
        className={cx('h-8 w-full pr-2.5 pl-8', fieldClass())}
      />
    </div>
  );
  const conflicted = pairs.some((issue) => issue.kind === 'conflict');
  const detail = page ? pageDetail(page) : null;

  return (
    <Page title="Pages" meta={pages && pages.length > 0 ? pages.length : undefined} actions={filter || undefined}>
      {loadError && <p role="alert" className="text-sm text-down">{loadError}</p>}
      {drifted.length > 0 && (
        <DriftNotice name={(path) => { const entry = pages?.find((item) => item.path === path); return entry ? pageLabel(entry) : path; }} files={drifted} busy={resolving} onAccept={(file) => void resolveDrift(file, true)} onRestore={(file) => void resolveDrift(file, false)} />
      )}
      {pages && pages.length === 0 && (
        <EmptyState icon={<Pencil size={18} />} title="No pages yet" action={<Button variant="primary" onClick={() => void navigate('/knowledge/proposals?interview=1')}>Start interview</Button>} />
      )}
      {pages && pages.length > 0 && (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <nav aria-label="Pages" className="-mx-2.5 flex w-[calc(100%+20px)] shrink-0 flex-col gap-3 lg:sticky lg:top-3 lg:max-h-[calc(100vh-88px)] lg:w-72 lg:overflow-y-auto lg:overscroll-contain lg:pb-4">
            {visible.length > 0
              ? <>
                <PageList pages={visible} selected={selected} onSelect={select} />
                {archived.length > 0 && (
                  <section aria-label="Archived" className="flex flex-col gap-px border-t border-line-subtle pt-3">
                    <h2 className="px-2.5 pb-1 text-xs font-medium text-faint">Archived</h2>
                    {archived.map((item) => (
                      <div key={item.path} className="flex items-center gap-2 py-0.5 pl-2.5 text-[13px]">
                        <span className="min-w-0 flex-1 truncate text-muted" title={item.path}>{item.description || item.path}</span>
                        <Button size="sm" variant="ghost" onClick={() => void restore(item.path)}>Restore</Button>
                      </div>
                    ))}
                  </section>
                )}
              </>
              : <p className="px-2.5 text-[13px] text-muted">No pages match.</p>}
          </nav>

          <div ref={detailRef} className="flex min-w-0 flex-1 scroll-mt-4 flex-col gap-5 lg:min-h-[calc(100vh-88px)] lg:border-l lg:border-line lg:pl-8">
            {readError && <p role="alert" className="text-sm text-down">{readError}</p>}
            {!page && !readError && <p className="pt-1 text-[13px] text-muted">Pick a page.</p>}
            {page && (
              <header className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="min-w-0 text-lg leading-7 font-semibold tracking-[-0.01em]">{pageLabel(page)}</h2>
                    {/* A page whose rules disagree isn't settled, however recently it was confirmed. */}
                    {!conflicted && (
                      <Badge tone={badgeTone(page.badge)} title={badgeTitle(page)} className="gap-1">
                        {page.badge === 'verified' && <Check size={11} strokeWidth={2.5} aria-hidden />}{badgeLabel(page.badge)}
                      </Badge>
                    )}
                  </div>
                  {state && (
                    <div className="flex items-center gap-1.5">
                      <AudiencePicker text={draft} disabled={saving} onChange={setDraft} />
                      {!editing && !state.dirty && <>
                        {confirmable && <Button size="sm" variant="ghost" disabled={saving} title="It still holds: mark it confirmed today" onClick={() => void confirmToday()}>Still true</Button>}
                        <Button size="sm" icon={<Pencil size={13} aria-hidden />} onClick={() => setEditing(true)}>Edit</Button>
                        <Button size="sm" variant="ghost" aria-label="Retire…" title="Retire: the bot stops using it" disabled={saving} icon={<Archive size={14} aria-hidden />} className="px-1.5 enabled:hover:bg-down/10 enabled:hover:text-down" onClick={() => setRetiring(true)} />
                      </>}
                    </div>
                  )}
                </div>
                <p className="text-xs text-faint">{detail ? `${detail} · ` : ''}{pageMeta(page)}</p>
              </header>
            )}
            {page && (page.warnings.length > 0 || page.problems.length > 0) && (
              <ul className="flex flex-col gap-1 text-[13px]">
                {page.problems.map((problem) => (
                  <li key={problem} className="flex gap-2 text-down"><AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />{problem}</li>
                ))}
                {page.warnings.map((warning) => (
                  <li key={warning} className="flex gap-2 text-warn"><AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />{warning}</li>
                ))}
              </ul>
            )}
            {page && saved === null && !readError && <p className="text-[13px] text-muted">Loading…</p>}
            {page && state && (
              <>
                <RulesNote
                  issues={pairs}
                  oneClick={pairs.some((issue) => issue.kind === 'conflict' && (issue.facts ?? []).length === 2 && issue.facts!.every((fact) => fact.page === selected && currentRules(saved ?? '').includes(fact.text)))}
                  onSettle={() => void navigate('/knowledge/overview#todo')}
                />
                {!editing && !state.dirty && (
                  <div className="-mx-4 text-sm"><PageBody text={readBody(page, pageBody(draft))} onOpen={(href) => void serra()?.app.openExternal(href)} /></div>
                )}
                {(editing || state.dirty) && <>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                  aria-label={`Markdown of ${page.path}`}
                  aria-invalid={state.problems.length > 0 ? true : undefined}
                  aria-describedby="page-editor-status"
                  className={cx('min-h-[28rem] w-full resize-y px-3 py-2.5 font-mono leading-5', fieldClass(state.problems.length > 0))}
                />
                <div id="page-editor-status" className="-mt-2 flex flex-col gap-2">
                  {state.refusal ? (
                    <div role="alert" className="flex flex-col gap-1 text-[13px] text-down">
                      {state.refusal.split('\n').map((line, index) => <p key={index}>{line}</p>)}
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-[13px] text-muted">
                      {pairs.some((issue) => (issue.kind === 'conflict' || issue.kind === 'duplicate') && (issue.facts ?? []).filter((fact) => fact.page !== selected || currentRules(draft).some((line) => line.includes(fact.text))).length >= 2)
                        ? <><AlertTriangle size={14} aria-hidden className="text-warn" />Keep only one of the rules above</>
                        : <><CheckCircle2 size={14} aria-hidden className="text-up" />Looks good</>}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={!state.canSave || saving} title={state.refusal ?? undefined} onClick={() => void save()}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                  {state.dirty ? <Button disabled={saving} onClick={() => setDraft(saved ?? '')}>Revert</Button> : <Button onClick={() => setEditing(false)}>Done</Button>}
                  <Button
                    variant="ghost"
                    disabled={saving}
                    title="Sets the verified date. Save to keep it."
                    onClick={() => setDraft((text) => markVerified(text, localDate(new Date())))}
                  >
                    Mark verified today
                  </Button>
                  <span className={cx('ml-auto text-xs tabular-nums', state.overCap ? 'text-down' : 'text-faint')}>{state.linesLabel}</span>
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
        title={`Retire ${page ? pageLabel(page) : 'this page'}?`}
        description="The bot stops using it. You can undo."
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
