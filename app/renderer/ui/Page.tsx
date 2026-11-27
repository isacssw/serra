import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { inSettings } from '../routes.ts';
import { cx } from './cx.ts';

/** The content grid every screen shares: `narrow` for forms and every settings screen, `wide` for lists and split panes. */
const widths = { narrow: 'max-w-3xl', wide: 'max-w-5xl' } as const;

/** A screen's frame: the title row (with actions on the right, like Jobs' filter and cleanup) and its content. */
export const Page = ({ title, subtitle, actions, width, children }: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  width?: keyof typeof widths;
  children?: ReactNode;
}) => {
  const { pathname } = useLocation();
  const column = width ?? (inSettings(pathname) ? 'narrow' : 'wide');
  return (
  <div className={cx('mx-auto flex min-h-full w-full flex-col gap-6 px-8 pt-3 pb-10', widths[column])}>
    <header className="flex min-h-8 flex-wrap items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-7 font-semibold tracking-[-0.012em]">{title}</h1>
        {subtitle && <p className="text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
    {children}
  </div>
  );
};
