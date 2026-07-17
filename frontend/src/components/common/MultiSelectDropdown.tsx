import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, X, Check } from 'lucide-react';
import { clsx } from 'clsx';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface Props {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
}

// Generic searchable checkbox multi-select popover — used by the Major Events log view for
// the Radios and IMSIs filters, where a plain toggle-pill row (as used elsewhere for the
// ~16-service list) would be unwieldy for potentially large IMSI/radio lists.
export function MultiSelectDropdown({ label, options, selected, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const selectedSet = new Set(selected);
  const filtered = search.trim()
    ? options.filter(o => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  const toggle = (value: string) => {
    onChange(selectedSet.has(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'flex items-center gap-2 px-3 py-2 text-sm rounded-md border transition-colors min-w-[180px]',
          selected.length > 0
            ? 'bg-nms-accent/10 text-nms-accent border-nms-accent/30'
            : 'bg-nms-bg text-nms-text-dim border-nms-border hover:text-nms-text',
        )}
      >
        <span className="flex-1 text-left truncate">
          {label}{selected.length > 0 ? ` (${selected.length})` : ''}
        </span>
        {selected.length > 0 && (
          <X
            className="w-3.5 h-3.5 shrink-0 hover:text-nms-red"
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
          />
        )}
        <ChevronDown className={clsx('w-3.5 h-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-72 max-h-80 flex flex-col bg-nms-surface border border-nms-border rounded-lg shadow-xl">
          <div className="p-2 border-b border-nms-border relative shrink-0">
            <Search className="w-3.5 h-3.5 absolute left-4 top-1/2 -translate-y-1/2 text-nms-text-dim" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={placeholder ?? `Search ${label.toLowerCase()}...`}
              className="nms-input text-xs !pl-7"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <p className="text-xs text-nms-text-dim text-center py-4">No matches</p>
            ) : (
              filtered.map(opt => {
                const isSelected = selectedSet.has(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(opt.value)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-nms-surface-2"
                  >
                    <span className={clsx(
                      'w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center',
                      isSelected ? 'bg-nms-accent border-nms-accent' : 'border-nms-border',
                    )}>
                      {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                    </span>
                    <span className={clsx('truncate font-mono', isSelected ? 'text-nms-text' : 'text-nms-text-dim')}>
                      {opt.label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="shrink-0 text-xs text-nms-text-dim hover:text-nms-red px-3 py-2 border-t border-nms-border text-left"
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
