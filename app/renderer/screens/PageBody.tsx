// A knowledge page's Markdown as it reads: shared by About me and Pages' read view.
import { pageBlocks, type Span } from './about.logic.ts';
import { cx, Table, TBody, Td, Th, THead, Tr } from '../ui/index.ts';

/** A link opens outside the window, through the app, as every outside link here does; a failure shows as a toast. */
const Inline = ({ spans, onOpen }: { spans: Span[]; onOpen: (href: string) => void }) => (
  <>
    {spans.map((span, at) => {
      switch (span.kind) {
        case 'bold': return <strong key={at} className="font-semibold text-ink">{span.text}</strong>;
        case 'italic': return <em key={at} className="text-ink">{span.text}</em>;
        case 'code': return <code key={at} className="rounded bg-raised px-1 py-0.5 font-mono text-[12px] text-ink">{span.text}</code>;
        case 'link': return (
          <a
            key={at}
            href={span.href}
            onClick={(event) => { event.preventDefault(); onOpen(span.href); }}
            className="text-ink underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            {span.text}
          </a>
        );
        case 'text': return <span key={at}>{span.text}</span>;
      }
    })}
  </>
);

/** A page's Markdown as it reads: headings, bullets, tables, quotes, fences and paragraphs, with bold, code and links live. */
export const PageBody = ({ text, onOpen }: { text: string; onOpen: (href: string) => void }) => (
  <div className="flex flex-col gap-1.5 px-4 py-3 text-[13px] leading-6 text-ink">
    {pageBlocks(text).map((block, at) => {
      switch (block.kind) {
        case 'heading':
          return <p key={at} className={cx('text-ink', block.level <= 1 ? 'pt-1 text-sm font-semibold' : block.level === 2 ? 'pt-1 font-semibold' : 'pt-0.5 font-medium')}>{<Inline spans={block.spans} onOpen={onOpen} />}</p>;
        case 'item':
          return (
            <p key={at} className="flex gap-2 text-muted" style={block.depth ? { marginLeft: block.depth * 16 } : undefined}>
              <span aria-hidden className="shrink-0 text-faint">{block.number === null ? '•' : `${block.number}.`}</span>
              <span className="min-w-0"><Inline spans={block.spans} onOpen={onOpen} /></span>
            </p>
          );
        case 'quote':
          return <blockquote key={at} className="border-l-2 border-line pl-2 text-muted"><Inline spans={block.spans} onOpen={onOpen} /></blockquote>;
        case 'fence':
          return <pre key={at} className="overflow-x-auto rounded-md bg-raised px-2.5 py-2 font-mono text-[12px] leading-5 text-ink">{block.text}</pre>;
        case 'table':
          return (
            <div key={at} className="overflow-x-auto">
              <Table className="text-xs">
                {block.head.length > 0 && (
                  <THead>
                    <Tr>{block.head.map((cell, cellAt) => <Th key={cellAt} className="px-2 py-1"><Inline spans={cell} onOpen={onOpen} /></Th>)}</Tr>
                  </THead>
                )}
                <TBody>
                  {block.rows.map((row, rowAt) => (
                    <Tr key={rowAt}>{row.map((cell, cellAt) => <Td key={cellAt} className="px-2 py-1 text-muted"><Inline spans={cell} onOpen={onOpen} /></Td>)}</Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          );
        case 'text':
          return <p key={at} className="text-muted"><Inline spans={block.spans} onOpen={onOpen} /></p>;
      }
    })}
  </div>
);

