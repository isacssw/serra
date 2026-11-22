import { useId, type InputHTMLAttributes, type Ref } from 'react';
import { cx } from './cx.ts';

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
  const note = error || hint;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      {label && <label htmlFor={inputId} className="text-sm font-medium">{label}</label>}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={cx(
          'h-9 rounded-md border bg-panel px-3 text-sm text-ink placeholder:text-muted',
          'focus:outline-2 focus:outline-offset-1 focus:outline-focus',
          'disabled:opacity-50',
          error ? 'border-down' : 'border-line',
          inputClassName,
        )}
        {...rest}
      />
      {note && <p id={noteId} className={cx('text-xs', error ? 'text-down' : 'text-muted')}>{note}</p>}
    </div>
  );
};
