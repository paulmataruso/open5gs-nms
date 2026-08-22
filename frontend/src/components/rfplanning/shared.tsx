import { useState } from 'react';
import { ChevronDown, AlertTriangle, Info } from 'lucide-react';
import { clsx } from 'clsx';
import type { CalculationResult, EquationRecord } from '../../api/rfPlanning';

export function NumField({ label, value, onChange, unit, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; unit?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-nms-text-dim mb-1">
        {label} {unit && <span className="text-nms-text-dim/70">({unit})</span>}
      </label>
      <input
        type="number"
        step="any"
        className="nms-input w-full"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

export function SelectField({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-xs text-nms-text-dim mb-1">{label}</label>
      <select className="nms-input w-full" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function EquationDisclosure({ eq }: { eq: EquationRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-nms-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-nms-surface-2 transition-colors"
      >
        <span className="text-xs font-medium text-nms-text">{eq.name}</span>
        <span className="flex items-center gap-1 text-[11px] text-nms-accent shrink-0">
          Show Calculation
          <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 bg-nms-bg border-t border-nms-border">
          <code className="block text-xs font-mono text-nms-accent">{eq.formula}</code>
          <div className="space-y-1">
            {Object.entries(eq.variables).map(([key, v]) => (
              <div key={key} className="flex items-center justify-between text-[11px]">
                <span className="text-nms-text-dim">{key} — {v.description}</span>
                <span className="font-mono text-nms-text">{v.value} {v.unit}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-nms-text-dim italic">Source: {eq.source}</p>
          {eq.applicableConditions && (
            <p className="text-[11px] text-nms-text-dim">Applies when: {eq.applicableConditions}</p>
          )}
          {eq.limitations && (
            <p className="text-[11px] text-amber-400">Limitations: {eq.limitations}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function AssumptionsWarnings<T>({ res }: { res: CalculationResult<T> }) {
  if (res.assumptions.length === 0 && res.warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {res.assumptions.length > 0 && (
        <div className="nms-card !p-3 space-y-1.5">
          <p className="text-xs font-semibold text-nms-text flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 text-nms-accent" /> Assumptions
          </p>
          {res.assumptions.map((a, i) => (
            <p key={i} className="text-[11px] text-nms-text-dim">
              <span className="text-nms-text font-mono">{a.parameter}</span> = {a.assumedValue}{a.unit ? ` ${a.unit}` : ''} — {a.reason}
            </p>
          ))}
        </div>
      )}
      {res.warnings.length > 0 && (
        <div className="nms-card !p-3 space-y-1.5">
          <p className="text-xs font-semibold text-nms-text flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Warnings
          </p>
          {res.warnings.map((w, i) => (
            <p key={i} className={clsx('text-[11px]', w.severity === 'error' ? 'text-red-400' : w.severity === 'warning' ? 'text-amber-400' : 'text-nms-text-dim')}>
              {w.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResultLine({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-nms-bg border border-nms-border rounded-lg">
      <span className="text-sm text-nms-text-dim">{label}</span>
      <span className="text-sm font-mono font-semibold text-nms-text">{value.toFixed(2)} {unit}</span>
    </div>
  );
}
