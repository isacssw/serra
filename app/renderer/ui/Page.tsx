import type { ReactNode } from 'react';

/** A screen's frame: the title row (with actions on the right, like Jobs' filter and cleanup) and its content. */
export const Page = ({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pt-3 pb-10">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
    {children}
  </div>
);
