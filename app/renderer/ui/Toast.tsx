import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { Button } from './Button.tsx';
import { cx } from './cx.ts';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** One action, such as Undo. Clicking it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Milliseconds before it goes away on its own; 0 keeps it until dismissed. Errors stay by default. */
  duration?: number;
}

interface ToastEntry extends ToastOptions { id: number }

const ToastContext = createContext<((toast: ToastOptions) => void) | null>(null);

/** Shows a toast: `const toast = useToast(); toast({ message: 'Promoted', action: { label: 'Undo', onClick } })`. */
export const useToast = (): ((toast: ToastOptions) => void) => {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast needs a ToastProvider above it.');
  return show;
};

const icons: Record<ToastTone, ReactNode> = {
  info: <Info size={16} className="text-muted" />,
  success: <CircleCheck size={16} className="text-up" />,
  error: <CircleAlert size={16} className="text-down" />,
};

const ToastItem = ({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) => {
  const tone = toast.tone ?? 'info';
  const duration = toast.duration ?? (tone === 'error' ? 0 : 6000);
  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [toast.id, duration, onDismiss]);
  return (
    <div data-toast role={tone === 'error' ? 'alert' : 'status'} className={cx('flex items-center gap-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13px] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]')}>
      {icons[tone]}
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <Button size="sm" onClick={() => { toast.action?.onClick(); onDismiss(toast.id); }}>{toast.action.label}</Button>
      )}
      <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={() => onDismiss(toast.id)} icon={<X size={14} />} />
    </div>
  );
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const show = useCallback((toast: ToastOptions) => {
    const id = nextId.current++;
    // Keep the newest few; older ones would only pile up.
    setToasts((list) => [...list.slice(-3), { ...toast, id }]);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 [&>*]:pointer-events-auto">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
};
