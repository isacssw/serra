// Knowledge → Pages (APP-20): every page the index points workers at, with its verified, unverified or stale badge,
// and a Markdown editor. The editor checks the header and the line cap as the owner types, with the same rules and
// message the service refuses a save with, so Save stays disabled until the page would pass `pnpm knowledge`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Search } from 'lucide-react';
import type { KnowledgePage } from '../../../src/contracts.ts';
import { serra } from '../bridge.ts';
import { Badge, Button, cx, Dialog, Page, useToast } from '../ui/index.ts';
import {
  badgeCounts, badgeLabel, badgeTitle, badgeTone, editorState, filterPages, groupByFolder, keepSelection, localDate, markVerified,
  pageName, pagesSummary, type PageFilter,
} from './pages.logic.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const FILTERS: { value: PageFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'verified', label: 'Verified' },
  { value: 'stale', label: 'Stale' },
  { value: 'unverified', label: 'Unverified' },
];

const PageList = ({ pages, selected, onSelect }: { pages: KnowledgePage[]; selected: string | null; onSelect: (path: string) => void }) => (
  <div className="flex flex-col gap-4">
    {groupByFolder(pages).map((group) => (
      <section key={group.folder || '.'} className="flex flex-col gap-1">
        <h2 className="px-1 text-xs font-semibold text-muted">{group.folder ? `${group.folder}/` : 'knowledge/'}</h2>
        {group.pages.map((page) => {
          const active = page.path === selected;
          return (
            <button
              key={page.path}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(page.path)}
              title={page.description ?? page.path}
              className={cx(
                'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm',
                'focus-visible:outline-2 focus-visible:outline-focus',
                active ? 'border-line-strong bg-selected' : 'border-transparent hover:bg-raised',
              )}
            >
              <FileText size={15} aria-hidden className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{pageName(page.path)}</span>
              {page.problems.length > 0 && (
                <AlertTriangle size={14} aria-label="Fails the knowledge check" className="shrink-0 text-down" />
              )}
              <Badge tone={badgeTone(page.badge)} title={badgeTitle(page)}>{badgeLabel(page.badge)}</Badge>
            </button>
          );
        })}
      </section>
    ))}
  </div>
);

export const Pages = () => {
  const toast = useToast();
  const [pages, setPages] = useState<KnowledgePage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<PageFilter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** A page the owner clicked while the draft had unsaved changes; the discard dialog asks first. */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const bridge = serra();
    if (!bridge) { setLoadError('The Serra bridge is missing: open this screen in the Serra app.'); return; }
    try {
      const list = await bridge.pages.list();
      setPages(list);
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
    return () => { live = false; };
  }, [selected]);

  const page = pages?.find((entry) => entry.path === selected) ?? null;
  const state = useMemo(() => (selected && saved !== null ? editorState(selected, saved, draft) : null), [selected, saved, draft]);
  const visible = useMemo(() => filterPages(pages ?? [], filter, query), [pages, filter, query]);
  const counts = useMemo(() => badgeCounts(pages ?? []), [pages]);

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
      const updated = await bridge.pages.save(selected, draft);
      const text = await bridge.pages.read(selected);
      setSaved(text);
      setDraft(text);
      setPages((list) => list?.map((entry) => (entry.path === updated.path ? updated : entry)) ?? list);
      toast({ message: `Saved ${updated.path}. The old text is in the profile's backups/knowledge/.`, tone: 'success' });
    } catch (error) {
      toast({ message: message(error), tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ⌘S / Ctrl+S saves, through the same checks as the button.
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
    <Page title="Pages" subtitle={pages ? pagesSummary(pages) : loadError ? undefined : 'Loading…'}>
      {loadError && <p role="alert" className="text-sm text-down">{loadError}</p>}
      {pages && pages.length === 0 && (
        <p className="text-sm text-muted">No pages yet. Pages come in through Proposals: promote one and it shows up here.</p>
      )}
      {pages && pages.length > 0 && (
        <div className="flex flex-col gap-6 border-t border-line pt-5 lg:flex-row lg:items-start">
          <nav aria-label="Pages" className="flex w-full shrink-0 lg:w-72 flex-col gap-3">
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
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cx(
                    'h-7 rounded-md border px-2 text-xs tabular-nums focus-visible:outline-2 focus-visible:outline-focus',
                    filter === option.value ? 'border-line-strong bg-selected text-ink' : 'border-line text-muted hover:bg-raised',
                  )}
                >
                  {option.label} {counts[option.value]}
                </button>
              ))}
            </div>
            {visible.length > 0
              ? <PageList pages={visible} selected={selected} onSelect={select} />
              : <p className="px-1 text-sm text-muted">No pages match.</p>}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-4 border-line lg:border-l lg:pl-6">
            {readError && <p role="alert" className="text-sm text-down">{readError}</p>}
            {!page && !readError && <p className="text-sm text-muted">Pick a page to edit.</p>}
            {page && (
              <>
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-mono text-base font-semibold">{page.path}</h2>
                    <Badge tone={badgeTone(page.badge)} title={badgeTitle(page)}>{badgeLabel(page.badge)}</Badge>
                    {page.verified && <span className="text-xs text-muted">verified {page.verified}</span>}
                  </div>
                  {page.description && <p className="text-sm text-muted">{page.description}</p>}
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
                      <CheckCircle2 size={15} aria-hidden className="text-up" />Header and length pass the knowledge check.
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
                  <span className={cx('ml-auto text-xs tabular-nums', state.overCap ? 'text-down' : 'text-muted')}>{state.linesLabel}</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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
