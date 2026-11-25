import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button.tsx';

export interface DialogProps {
  open: boolean;
  /** Called on Escape, the close button or a click on the backdrop. */
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons at the bottom right, primary action last. */
  actions?: ReactNode;
}

/** A modal on the native <dialog>, so focus trapping and Escape come from the browser. */
export const Dialog = ({ open, onClose, title, description, children, actions }: DialogProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The browser focuses the first control (the close button); a dialog can name a safer one with data-autofocus.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-line bg-panel p-0 text-ink shadow-[0_24px_64px_-12px_rgb(0_0_0/0.45)] backdrop:bg-black/45"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-base font-semibold">{title}</h2>
              {description && <div className="text-sm text-muted">{description}</div>}
            </div>
            <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose} icon={<X size={16} />} />
          </div>
          {children}
          {actions && <div className="flex justify-end gap-2">{actions}</div>}
        </div>
      )}
    </dialog>
  );
};
