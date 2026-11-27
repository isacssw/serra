import { useId, type Ref, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx.ts';
import { fieldClass, labelClass, noteClass } from './field.ts';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  /** A validation message under the field; marks the field invalid. */
  error?: string | null;
  /** Help text under the field when there is no error. */
  hint?: string;
  /** Classes for the field itself. `className` lays out the wrapper with the label and note. */
  textareaClassName?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

/** A multi-line field, styled like Input. */
export const TextArea = ({ label, error, hint, className, textareaClassName, id, ...rest }: TextAreaProps) => {
  const generated = useId();
  const fieldId = id ?? generated;
  const note = error || hint;
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={fieldId} className={labelClass}>{label}</label>
      <textarea
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${fieldId}-note` : undefined}
        className={cx('min-h-20 resize-y px-2.5 py-1.5 leading-5', fieldClass(Boolean(error)), textareaClassName)}
        {...rest}
      />
      {note && <p id={`${fieldId}-note`} className={noteClass(Boolean(error))}>{note}</p>}
    </div>
  );
};
