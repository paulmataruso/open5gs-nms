import { clsx } from 'clsx';
import { Tooltip } from '../common/Tooltip';
import { HelpCircle } from 'lucide-react';

interface FieldWithTooltipProps {
  label: string;
  value: string | number;
  onChange: (val: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
  tooltip?: string;
  required?: boolean;
  disabled?: boolean;
}

export function FieldWithTooltip({
  label,
  value,
  onChange,
  placeholder,
  mono = true,
  type = 'text',
  tooltip,
  required = false,
  disabled = false,
}: FieldWithTooltipProps): JSX.Element {
  return (
    <div>
      <label className="nms-label flex items-center gap-1.5">
        {label}
        {required && <span className="text-nms-red">*</span>}
        {tooltip && (
          <Tooltip content={tooltip} position="top">
            <HelpCircle className="w-3.5 h-3.5 text-nms-text-dim hover:text-nms-accent transition-colors cursor-help" />
          </Tooltip>
        )}
      </label>
      <input
        type={type}
        className={clsx('nms-input', mono && 'font-mono text-xs')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
      />
    </div>
  );
}

interface SelectWithTooltipProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
  tooltip?: string;
  required?: boolean;
  disabled?: boolean;
}

export function SelectWithTooltip({
  label,
  value,
  onChange,
  options,
  tooltip,
  required = false,
  disabled = false,
}: SelectWithTooltipProps): JSX.Element {
  return (
    <div>
      <label className="nms-label flex items-center gap-1.5">
        {label}
        {required && <span className="text-nms-red">*</span>}
        {tooltip && (
          <Tooltip content={tooltip} position="top">
            <HelpCircle className="w-3.5 h-3.5 text-nms-text-dim hover:text-nms-accent transition-colors cursor-help" />
          </Tooltip>
        )}
      </label>
      <select
        className="nms-input font-mono text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface CheckboxWithTooltipProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  tooltip?: string;
  disabled?: boolean;
}

export function CheckboxWithTooltip({
  label,
  checked,
  onChange,
  tooltip,
  disabled = false,
}: CheckboxWithTooltipProps): JSX.Element {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-2 focus:ring-nms-accent focus:ring-offset-0 disabled:opacity-50"
      />
      <span className="text-sm text-nms-text flex items-center gap-1.5">
        {label}
        {tooltip && (
          <Tooltip content={tooltip} position="top">
            <HelpCircle className="w-3.5 h-3.5 text-nms-text-dim hover:text-nms-accent transition-colors cursor-help" />
          </Tooltip>
        )}
      </span>
    </label>
  );
}
