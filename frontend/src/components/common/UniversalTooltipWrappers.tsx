import { ReactNode } from 'react';
import { Tooltip } from '../common/Tooltip';
import { HelpCircle } from 'lucide-react';

/**
 * Universal label wrapper that adds tooltip support
 * Use this to wrap any label element to add a tooltip
 */
export function LabelWithTooltip({
  children,
  tooltip,
  required = false,
}: {
  children: ReactNode;
  tooltip?: string;
  required?: boolean;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {required && <span className="text-nms-red">*</span>}
      {tooltip && (
        <Tooltip content={tooltip} position="top" maxWidth="450px" minWidth="250px">
          <HelpCircle className="w-3.5 h-3.5 text-nms-text-dim hover:text-nms-accent transition-colors cursor-help flex-shrink-0" />
        </Tooltip>
      )}
    </span>
  );
}

/**
 * Quick wrapper for any input group
 * Wraps label + input together with tooltip support
 */
export function InputWithTooltip({
  label,
  tooltip,
  required = false,
  children,
  className = '',
}: {
  label: string;
  tooltip?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={className}>
      <label className="nms-label">
        <LabelWithTooltip tooltip={tooltip} required={required}>
          {label}
        </LabelWithTooltip>
      </label>
      {children}
    </div>
  );
}
