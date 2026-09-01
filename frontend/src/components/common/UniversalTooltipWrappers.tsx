import { ReactNode } from 'react';
import { TooltipTrigger } from '../common/Tooltip';

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
      {tooltip && <TooltipTrigger content={tooltip} className="inline-flex flex-shrink-0 text-nms-text-dim hover:text-nms-accent transition-colors" />}
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
