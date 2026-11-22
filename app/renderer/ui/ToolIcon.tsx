import type { ReactNode } from 'react';
import { BRAND_ICONS, BRAND_IMAGES, type BrandId, type BrandImageId } from './brand-icons.ts';
import { cx } from './cx.ts';

/**
 * A tool's mark in a small hairline tile: its Simple Icons brand mark in the text colour (so it fits both themes),
 * or `fallback` (a lucide icon) for tools without one. The row beside it names the tool, so the tile is hidden from
 * screen readers (they'd hear the name twice); the brand's name is its hover title.
 */
export const ToolIcon = ({ brand, image, fallback, label, className }: { brand: BrandId | null; image?: BrandImageId; fallback: ReactNode; label: string; className?: string }) => {
  const icon = brand ? BRAND_ICONS[brand] : null;
  // A brand whose own app icon is an image (Granola): shown as is, in the same tile.
  if (image) {
    return (
      <span aria-hidden title={BRAND_IMAGES[image].title} className={cx('grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-panel', className)}>
        <img src={BRAND_IMAGES[image].src} alt="" width={16} height={16} className="rounded-[3px]" />
      </span>
    );
  }
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
