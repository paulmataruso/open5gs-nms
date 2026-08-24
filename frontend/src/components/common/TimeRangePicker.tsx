import { useState, useRef, useEffect } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

export type TimeRangeValue =
  | { type: 'relative'; ms: number; label: string }
  | { type: 'absolute'; from: Date; to: Date; label: string };

interface QuickRange {
  ms: number;
  label: string;
}

// Modeled after Grafana's time picker: a button showing the current range,
// opening a popover with quick relative presets on the left and a custom
// absolute From/To range on the right.
const QUICK_RANGES: QuickRange[] = [
  { ms: 15 * 60 * 1000, label: 'Last 15 minutes' },
  { ms: 30 * 60 * 1000, label: 'Last 30 minutes' },
  { ms: 60 * 60 * 1000, label: 'Last 1 hour' },
  { ms: 3 * 60 * 60 * 1000, label: 'Last 3 hours' },
  { ms: 6 * 60 * 60 * 1000, label: 'Last 6 hours' },
  { ms: 12 * 60 * 60 * 1000, label: 'Last 12 hours' },
  { ms: 24 * 60 * 60 * 1000, label: 'Last 24 hours' },
  { ms: 2 * 24 * 60 * 60 * 1000, label: 'Last 2 days' },
  { ms: 7 * 24 * 60 * 60 * 1000, label: 'Last 7 days' },
  { ms: 30 * 24 * 60 * 60 * 1000, label: 'Last 30 days' },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// datetime-local inputs want "YYYY-MM-DDTHH:mm" in the browser's local time —
// no timezone suffix, which is also how the browser parses it back (local time).
function toDatetimeLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  value: TimeRangeValue;
  onChange: (range: TimeRangeValue) => void;
  // Which edge of the trigger button the popover's own edge locks to.
  // 'right' (default) anchors the popover's right edge to the button's
  // right edge, so it opens extending LEFTWARD — correct when the button
  // sits at the far right of the page (this component's original usage,
  // TrafficHistoryPage's page header), where there's open space to the left
  // and none to the right past the viewport edge. A button placed near the
  // LEFT side of the page (e.g. inside a filter row right after the sidebar)
  // needs 'left' instead — opens extending RIGHTWARD — otherwise the ~420px
  // popover overflows past the left edge of the scrollable content area and
  // gets clipped by its overflow-auto ancestor (looks like it's rendering
  // "behind" whatever is to the left, e.g. the sidebar, even though it's
  // actually just cut off, not a stacking/z-index issue).
  align?: 'left' | 'right';
}

export function TimeRangePicker({ value, onChange, align = 'right' }: Props) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Seed the custom inputs from the currently active range whenever the popover opens.
    if (value.type === 'absolute') {
      setCustomFrom(toDatetimeLocalValue(value.from));
      setCustomTo(toDatetimeLocalValue(value.to));
    } else {
      const now = new Date();
      setCustomFrom(toDatetimeLocalValue(new Date(now.getTime() - value.ms)));
      setCustomTo(toDatetimeLocalValue(now));
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const applyQuickRange = (qr: QuickRange) => {
    onChange({ type: 'relative', ms: qr.ms, label: qr.label });
    setOpen(false);
  };

  const applyCustomRange = () => {
    const from = new Date(customFrom);
    const to = new Date(customTo);
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) return;
    const label = `${from.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} → ${to.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    onChange({ type: 'absolute', from, to, label });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'flex items-center gap-2 px-3 py-2 text-sm rounded-md border transition-colors',
          'bg-nms-bg text-nms-text border-nms-border hover:border-nms-accent/50',
        )}
      >
        <Clock className="w-3.5 h-3.5 text-nms-text-dim shrink-0" />
        <span className="truncate max-w-[280px]">{value.label}</span>
        <ChevronDown className={clsx('w-3.5 h-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className={clsx(
          'absolute z-50 mt-1 flex bg-nms-surface border border-nms-border rounded-lg shadow-xl overflow-hidden',
          align === 'left' ? 'left-0' : 'right-0',
        )}>
          <div className="w-52 max-h-96 overflow-y-auto border-r border-nms-border py-1">
            {QUICK_RANGES.map(qr => (
              <button
                key={qr.label}
                type="button"
                onClick={() => applyQuickRange(qr)}
                className={clsx(
                  'w-full text-left px-3 py-1.5 text-xs hover:bg-nms-surface-2 transition-colors',
                  value.type === 'relative' && value.ms === qr.ms
                    ? 'text-nms-accent font-medium'
                    : 'text-nms-text-dim',
                )}
              >
                {qr.label}
              </button>
            ))}
          </div>

          <div className="w-72 p-3 space-y-3">
            <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Absolute time range</p>
            <div>
              <label className="nms-label">From</label>
              <input
                type="datetime-local"
                className="nms-input font-mono text-xs"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="nms-label">To</label>
              <input
                type="datetime-local"
                className="nms-input font-mono text-xs"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={applyCustomRange}
              className="nms-btn-primary w-full text-sm"
            >
              Apply time range
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
