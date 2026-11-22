import { BRAND_ICONS, type BrandId } from './brand-icons.ts';

/** A brand's Simple Icons mark in the text colour, so it fits both themes. Decorative: the text beside it names it. */
export const BrandMark = ({ brand, size = 16, className }: { brand: BrandId; size?: number; className?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden className={className}>
    <path d={BRAND_ICONS[brand].path} />
  </svg>
);
