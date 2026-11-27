// The run chat's pieces: an agent's text (a small Markdown subset), images in and out, tool rows and question rows.
// What each shows is decided in chat.logic.ts; these only draw it.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRightLeft, Brain, Check, ChevronRight, Copy, FilePen, FileText, Globe, ImageOff, LoaderCircle, MessageCircleQuestion, Search,
  ShieldCheck, ShieldQuestion, ShieldX, SquareTerminal, ToggleRight, Trash2, Wrench, X,
} from 'lucide-react';
import { serra } from '../../bridge.ts';
import { BRAND_ICONS, type BrandId } from '../../ui/brand-icons.ts';
import { cx } from '../../ui/index.ts';
import { blocks, inline, toolBrand, toolSummary, toolTitle, type ChatImage, type ChatItem, type Inline, type ToolRow } from './chat.logic.ts';

const openLink = (url: string): void => { serra()?.app.openExternal(url).catch(() => {}); };

const InlineText = ({ text }: { text: string }) => (
  <>
    {inline(text).map((part, index) => {
      const key = `${index}`;
      if (part.type === 'code') return <code key={key} className="rounded-[5px] border border-line bg-raised px-1 py-px font-mono text-[0.86em] text-ink">{part.text}</code>;
      if (part.type === 'strong') return <strong key={key} className="font-semibold">{part.text}</strong>;
      if (part.type === 'em') return <em key={key}>{part.text}</em>;
      if (part.type === 'link') {
        const link = part as Extract<Inline, { type: 'link' }>;
        return (
          <a
            key={key}
            href={link.url}
            onClick={(event) => { event.preventDefault(); openLink(link.url); }}
            className="font-medium text-ink underline decoration-line-control underline-offset-[3px] hover:decoration-ink focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {link.text}
          </a>
        );
      }
      return <span key={key}>{part.text}</span>;
    })}
  </>
);

/** An agent's reply: paragraphs, headings, lists, quotes and code, at reading size. */
export const ChatText = ({ text, caret = false }: { text: string; caret?: boolean }) => {
  const shown = blocks(text);
  const last = shown.length - 1;
  const tail = caret ? <span aria-hidden className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.2em] animate-pulse rounded-full bg-muted" /> : null;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-[14.5px] leading-[1.65] text-ink">
      {shown.map((block, index) => {
        const end = index === last ? tail : null;
        const key = `${index}`;
        if (block.type === 'code') return <CodeBlock key={key} lang={block.lang} text={block.text} end={end} />;
        if (block.type === 'h') return <h3 key={key} className="pt-1 text-[14.5px] font-semibold"><InlineText text={block.text} />{end}</h3>;
        if (block.type === 'quote') return <blockquote key={key} className="border-l-2 border-line-strong pl-3 whitespace-pre-wrap text-muted"><InlineText text={block.text} />{end}</blockquote>;
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={key} className={cx('flex flex-col gap-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc', 'marker:text-faint')}>
              {block.items.map((item, at) => <li key={`${at}`} className="pl-0.5"><InlineText text={item} />{at === block.items.length - 1 ? end : null}</li>)}
            </List>
          );
        }
        return <p key={key} className="whitespace-pre-wrap [overflow-wrap:anywhere]"><InlineText text={block.text} />{end}</p>;
      })}
      {shown.length === 0 && caret && <p>{tail}</p>}
    </div>
  );
};

/** A code block, with its language and a copy button that shows on hover or focus. */
const CodeBlock = ({ lang, text, end }: { lang: string; text: string; end: ReactNode }) => {
  const [copied, setCopied] = useState(false);
  // Only a block that scrolls sideways is a tab stop (to scroll it); the copy button is the rest's.
  const pre = useRef<HTMLPreElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => { const box = pre.current; if (box) setWide(box.scrollWidth > box.clientWidth + 1); }, [text]);
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  };
  return (
    <div className="group/code relative">
      <pre ref={pre} tabIndex={wide ? 0 : undefined} className={cx('overflow-x-auto rounded-lg border border-line bg-raised px-3.5 pb-3 font-mono text-[12.5px] leading-5 text-ink focus-visible:outline-[1.5px] focus-visible:-outline-offset-1 focus-visible:outline-focus', lang ? 'pt-7' : 'pt-3 pr-10')} aria-label={lang ? `${lang} code` : 'Code'}>
        <code>{text}</code>{end}
      </pre>
      {lang && <span aria-hidden className="absolute top-2 left-3.5 font-mono text-[11px] text-muted">{lang}</span>}
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy'}
        className="absolute top-1 right-1 grid size-7 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-focus"
      >
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      </button>
    </div>
  );
};

/** Images read once per path for the app's life: a run's images don't change. */
const imageCache = new Map<string, Promise<string | null>>();
const loadImage = (path: string): Promise<string | null> => {
  const bridge = serra();
  if (!bridge) return Promise.resolve(null);
  let found = imageCache.get(path);
  if (!found) { found = bridge.jobs.image(path).catch(() => null); imageCache.set(path, found); }
  return found;
};

/** An image a message names, from Serra's own folders; a quiet placeholder when it can't be read any more. */
export const ChatImageView = ({ image, small = false }: { image: ChatImage; small?: boolean }) => {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadImage(image.path).then((found) => { if (live) setSrc(found); });
    return () => { live = false; };
  }, [image.path]);
  const box = small ? 'h-28 max-w-[14rem]' : 'max-h-80 max-w-full';
  const preview = useRef<HTMLDialogElement>(null);
  if (src === null) {
    return (
      <span className="inline-flex h-8 w-fit items-center gap-2 rounded-lg border border-line bg-raised px-2.5 text-xs text-muted" title={image.name}>
        <ImageOff size={14} aria-hidden />{image.name}
      </span>
    );
  }
  if (src === undefined) return <span aria-hidden className={cx('block rounded-lg border border-line bg-raised', small ? 'h-28 w-40' : 'h-48 w-72')} />;
  return (
    <>
      <button
        type="button"
        onClick={() => preview.current?.showModal()}
        aria-label={`Open ${image.name}`}
        className="block w-fit cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <img src={src} alt={image.name} className={cx('block rounded-lg border border-line-strong bg-raised object-contain dark:brightness-[0.92]', box)} />
      </button>
      <dialog
        ref={preview}
        aria-label={image.name}
        onClick={() => preview.current?.close()}
        className="m-auto max-h-[90vh] max-w-[90vw] cursor-zoom-out rounded-xl border-0 bg-transparent p-0 backdrop:bg-scrim"
      >
        <img src={src} alt={image.name} className="block max-h-[88vh] max-w-[88vw] rounded-xl border border-line-strong object-contain shadow-overlay" />
        <button
          type="button"
          autoFocus
          aria-label="Close"
          onClick={() => preview.current?.close()}
          className="absolute top-2 right-2 grid size-8 place-items-center rounded-full border border-line-control bg-overlay text-ink shadow-overlay hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <X size={15} aria-hidden />
        </button>
      </dialog>
    </>
  );
};

const KIND_ICONS: Record<string, ReactNode> = {
  read: <FileText size={14} />, edit: <FilePen size={14} />, delete: <Trash2 size={14} />, move: <ArrowRightLeft size={14} />,
  search: <Search size={14} />, execute: <SquareTerminal size={14} />, think: <Brain size={14} />, fetch: <Globe size={14} />,
  switch_mode: <ToggleRight size={14} />,
};

const BRANDS = Object.keys(BRAND_ICONS).filter((key): key is BrandId => key in BRAND_ICONS);

/** A tool's mark: the service it names (an MCP tool), else its kind. */
const ToolMark = ({ tool }: { tool: ToolRow }) => {
  const brand = toolBrand(tool.title, BRANDS);
  if (brand) return <svg viewBox="0 0 24 24" width={13} height={13} fill="currentColor" aria-hidden><path d={BRAND_ICONS[brand].path} /></svg>;
  return <span aria-hidden className="contents">{(tool.kind && KIND_ICONS[tool.kind]) ?? <Wrench size={14} />}</span>;
};

/** A spinner while something runs; with less motion, a word instead of a frozen arc. */
const Running = () => (
  <span className="flex items-center gap-1.5 text-xs text-muted">
    <LoaderCircle size={13} className="animate-spin motion-reduce:hidden" aria-hidden />
    <span aria-hidden className="hidden size-1.5 rounded-full bg-up motion-reduce:inline-block" />
    <span className="sr-only motion-reduce:not-sr-only">Running</span>
  </span>
);

const ToolState = ({ state }: { state: ToolRow['state'] }) => {
  if (state === 'running') return <Running />;
  if (state === 'failed') return <span className="flex items-center gap-1 text-xs font-medium text-down"><X size={13} aria-hidden />Failed</span>;
  return <Check size={13} className="text-faint" aria-label="Done" />;
};

/** Consecutive tool calls as one compact row; it opens to list each call. */
export const ToolGroup = ({ tools }: { tools: ToolRow[] }) => {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const summary = toolSummary(tools);
  const latest = tools.at(-1)!;
  // One call has nothing more to show: a plain row, not a disclosure.
  if (tools.length === 1) {
    return (
      <div className="-mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-[13px] text-muted">
        <span aria-hidden className="w-[13px] shrink-0" />
        <span className="grid size-5 shrink-0 place-items-center"><ToolMark tool={latest} /></span>
        <span className="min-w-0 truncate font-mono text-[12.5px]" title={latest.title}>{summary.title}</span>
        <span className="ml-auto shrink-0 pl-2"><ToolState state={latest.state} /></span>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((was) => !was)}
        className="group -mx-2 flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus"
      >
        <ChevronRight size={13} aria-hidden className={cx('shrink-0 text-faint transition-transform duration-150', open && 'rotate-90')} />
        <span className="grid size-5 shrink-0 place-items-center text-muted">{open ? <Wrench size={14} aria-hidden /> : <ToolMark tool={latest} />}</span>
        {open
          ? <span className="min-w-0 truncate">{summary.count} tool calls</span>
          : <span className="min-w-0 truncate font-mono text-[12.5px]" title={latest.title}>{summary.title}</span>}
        {!open && <span className="shrink-0 rounded-full border border-line bg-raised px-1.5 text-[11px] leading-4 text-muted tabular-nums">+{summary.count - 1}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {summary.failed > 0 && !summary.running && (
            <span className={cx('flex items-center gap-1 text-xs', summary.endedFailed ? 'font-medium text-down' : 'text-muted')}>
              <X size={12} aria-hidden className={summary.endedFailed ? undefined : 'text-down'} />{summary.failed} failed
            </span>
          )}
          {summary.running ? <Running /> : summary.failed === 0 && <Check size={13} className="text-faint" aria-label="Done" />}
        </span>
      </button>
      {open && (
        <ul id={listId} className="mt-1 mb-2 ml-[7px] flex flex-col border-l border-line-strong pl-[13px]">
          {tools.map((tool) => (
            <li key={tool.key} className="flex h-7 min-w-0 items-center gap-2 text-[12.5px] text-muted">
              <span className="grid size-5 shrink-0 place-items-center"><ToolMark tool={tool} /></span>
              <span className="min-w-0 truncate font-mono" title={tool.title}>{toolTitle(tool.title)}</span>
              <span className="ml-auto shrink-0"><ToolState state={tool.state} /></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const OUTCOMES: Record<NonNullable<Extract<ChatItem, { type: 'ask' }>['outcome']>, { label: string; tone: string }> = {
  allowed: { label: 'Allowed', tone: 'text-up' },
  denied: { label: 'Denied', tone: 'text-down' },
  answered: { label: 'Answered', tone: 'text-muted' },
  cancelled: { label: 'Closed', tone: 'text-faint' },
  waiting: { label: 'Waiting', tone: 'text-warn' },
};

/** A permission the agent asked for, or a question it asked, and how it was settled. */
export const AskRow = ({ item }: { item: Extract<ChatItem, { type: 'ask' }> }) => {
  const outcome = item.outcome ? OUTCOMES[item.outcome] : null;
  const icon = !item.permission
    ? <MessageCircleQuestion size={14} />
    : item.outcome === 'allowed' ? <ShieldCheck size={14} /> : item.outcome === 'denied' ? <ShieldX size={14} /> : <ShieldQuestion size={14} />;
  return (
    <div className="-mx-2 flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 text-[13px]">
      <span aria-hidden className="w-[13px] shrink-0" />
      <span aria-hidden className={cx('grid size-5 shrink-0 place-items-center', item.outcome === 'waiting' ? 'text-warn' : 'text-muted')}>{icon}</span>
      <span className="shrink-0 text-muted">{item.permission ? 'Permission' : 'Question'}</span>
      <span className={cx('min-w-0 truncate', item.permission ? 'font-mono text-[12.5px] text-ink' : 'text-ink')} title={item.text}>{item.text}</span>
      {outcome && <span className={cx('ml-auto shrink-0 pl-2 text-xs font-medium', outcome.tone)}>{outcome.label}</span>}
    </div>
  );
};
