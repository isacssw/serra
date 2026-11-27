import { useId, type InputHTMLAttributes, type Ref } from 'react';
import { cx } from './cx.ts';
import { fieldClass, labelClass, noteClass } from './field.ts';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** A visible label above the field. */
  label?: string;
  /** A validation message under the field; marks the field invalid. */
  error?: string | null;
  /** Help text under the field when there is no error. */
  hint?: string;
  /** Classes for the field itself, like `font-mono`. `className` lays out the wrapper with the label and note. */
  inputClassName?: string;
  /** React 19 passes `ref` as a prop; it reaches the <input>. */
  ref?: Ref<HTMLInputElement>;
}

export const Input = ({ label, error, hint, className, inputClassName, id, ...rest }: InputProps) => {
  const generated = useId();
  const inputId = id ?? generated;
  const noteId = `${inputId}-note`;
  const hintId = `${inputId}-hint`;
  // An error goes above the hint, and the hint stays: it's often what says how to fix it.
  const described = [error && noteId, hint && hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      {label && <label htmlFor={inputId} className={labelClass}>{label}</label>}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={cx('h-8 min-w-0 px-2.5', fieldClass(Boolean(error)), inputClassName)}
        {...rest}
      />
      {error && <p id={noteId} className={noteClass(true)}>{error}</p>}
      {hint && <p id={hintId} className={noteClass(false)}>{hint}</p>}
    </div>
  );
};
