import { BRAND_ICONS } from './brand-icons.ts';

/** GitHub's mark in the text colour, so it fits both themes. Decorative: the label beside it names it. */
export const GitHubMark = ({ size = 14, className }: { size?: number; className?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden focusable="false" className={className}>
    <path d={BRAND_ICONS.github.path} />
  </svg>
);
