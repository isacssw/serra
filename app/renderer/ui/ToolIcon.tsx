import type { ReactNode } from 'react';
import { BRAND_ICONS, type BrandId } from './brand-icons.ts';
import { cx } from './cx.ts';

/**
 * A tool's mark in a small hairline tile: its Simple Icons brand mark in the text colour (so it fits both themes),
 * or `fallback` (a lucide icon) for tools without one. The row beside it names the tool, so the tile is hidden from
 * screen readers (they'd hear the name twice); the brand's name is its hover title.
 */
export const ToolIcon = ({ brand, fallback, label, className }: { brand: BrandId | null; fallback: ReactNode; label: string; className?: string }) => {
  const icon = brand ? BRAND_ICONS[brand] : null;
  return (
    <span
      aria-hidden
      title={icon ? icon.title : label}
      className={cx('grid size-7 shrink-0 place-items-center rounded-md border border-line bg-panel text-ink', className)}
    >
      {icon
        ? <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden><path d={icon.path} /></svg>
        : <span className="text-muted" aria-hidden>{fallback}</span>}
    </span>
  );
};
