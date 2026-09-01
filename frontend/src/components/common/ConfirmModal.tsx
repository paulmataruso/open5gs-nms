import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button red for destructive actions (the default — this
   *  component exists specifically to replace window.confirm() for those). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// In-app confirmation dialog — replaces window.confirm() (a native browser popup that
// doesn't match this app's look and can't be styled) for destructive/high-impact actions.
// Same portal/backdrop convention as Tooltip.tsx's TooltipTrigger, but with real
// Confirm/Cancel buttons instead of click-anywhere-to-dismiss, since confirming and
// canceling need to stay clearly distinct actions here.
export function ConfirmModal({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true, onConfirm, onCancel,
}: ConfirmModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onCancel}
    >
      <div className="nms-card max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <AlertTriangle className={danger ? 'w-5 h-5 text-nms-red flex-shrink-0 mt-0.5' : 'w-5 h-5 text-nms-accent flex-shrink-0 mt-0.5'} />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-nms-text">{title}</h3>
            <p className="text-sm leading-relaxed text-nms-text-dim mt-1 whitespace-pre-line">{message}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button type="button" onClick={onCancel} className="nms-btn-ghost text-sm">{cancelLabel}</button>
          <button type="button" onClick={onConfirm} className={danger ? 'nms-btn-danger text-sm' : 'nms-btn-primary text-sm'}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
