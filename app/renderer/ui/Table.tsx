import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from './cx.ts';

/** A bordered table, as on the People settings page. Compose with THead, TBody, Tr, Th and Td. */
export const Table = ({ className, children, ...rest }: HTMLAttributes<HTMLTableElement>) => (
  <div className="overflow-hidden rounded-xl border border-line">
    <table className={cx('w-full border-collapse text-sm', className)} {...rest}>{children}</table>
  </div>
);

export const THead = ({ children }: { children: ReactNode }) => <thead className="border-b border-line text-left text-xs text-muted">{children}</thead>;
export const TBody = ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>;

export const Tr = ({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cx('border-t border-line-subtle first:border-t-0', className)} {...rest} />
);

export const Th = ({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th scope="col" className={cx('h-9 px-4 font-medium', className)} {...rest} />
);

export const Td = ({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cx('px-4 py-2.5 align-middle', className)} {...rest} />
);
