import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

interface TooltipTriggerProps {
  content: string;
  className?: string;
}

// Click-to-open help popup. Previously this was a hover-delay popover (500ms
// mouseenter/leave), which cut off long/detailed explanations on stray mouse
// movement and didn't work on touch devices at all. Clicking now opens a
// centered modal overlay with the full explanation — click anywhere (the
// backdrop or the box itself) to dismiss, no close button to hunt for, since
// the content here is read-only text with nothing else to interact with.
export function TooltipTrigger({ content, className }: TooltipTriggerProps): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={className ?? 'inline-flex text-nms-text-dim hover:text-nms-accent transition-colors'}
        aria-label="Show help"
      >
        <HelpCircle className="w-3.5 h-3.5 flex-shrink-0" />
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-6 cursor-pointer"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => setOpen(false)}
        >
          <div className="nms-card max-w-md w-full shadow-2xl">
            <div className="flex items-start gap-3">
              <HelpCircle className="w-5 h-5 text-nms-accent flex-shrink-0 mt-0.5" />
              <p className="text-sm leading-relaxed text-nms-text whitespace-pre-line">{content}</p>
            </div>
            <p className="text-xs text-nms-text-dim mt-3 text-center">Click anywhere to close</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
