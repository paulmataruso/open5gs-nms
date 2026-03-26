import { ReactNode, useState, useRef, useEffect } from 'react';
import { clsx } from 'clsx';

interface TooltipProps {
  content: string;
  children: ReactNode;
  delay?: number;
  position?: 'top' | 'bottom' | 'left' | 'right';
  maxWidth?: string;
  minWidth?: string;
}

export function Tooltip({
  content,
  children,
  delay = 500,
  position = 'top',
  maxWidth = '400px',
  minWidth = '200px',
}: TooltipProps): JSX.Element {
  const [visible, setVisible] = useState(false);
  const [adjustedPosition, setAdjustedPosition] = useState(position);
  const timeoutRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const showTooltip = () => {
    timeoutRef.current = window.setTimeout(() => {
      setVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setVisible(false);
  };

  // Adjust position if tooltip would overflow viewport
  useEffect(() => {
    if (visible && tooltipRef.current && triggerRef.current) {
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let newPosition = position;

      // Check horizontal overflow
      if (tooltipRect.right > viewportWidth && position === 'right') {
        newPosition = 'left';
      } else if (tooltipRect.left < 0 && position === 'left') {
        newPosition = 'right';
      }

      // Check vertical overflow
      if (tooltipRect.bottom > viewportHeight && position === 'bottom') {
        newPosition = 'top';
      } else if (tooltipRect.top < 0 && position === 'top') {
        newPosition = 'bottom';
      }

      setAdjustedPosition(newPosition);
    }
  }, [visible, position]);

  const getPositionClasses = () => {
    switch (adjustedPosition) {
      case 'top':
        return 'bottom-full left-1/2 -translate-x-1/2 mb-2';
      case 'bottom':
        return 'top-full left-1/2 -translate-x-1/2 mt-2';
      case 'left':
        return 'right-full top-1/2 -translate-y-1/2 mr-2';
      case 'right':
        return 'left-full top-1/2 -translate-y-1/2 ml-2';
      default:
        return 'bottom-full left-1/2 -translate-x-1/2 mb-2';
    }
  };

  const getArrowClasses = () => {
    switch (adjustedPosition) {
      case 'top':
        return 'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-nms-surface-1';
      case 'bottom':
        return 'bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-nms-surface-1';
      case 'left':
        return 'left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-nms-surface-1';
      case 'right':
        return 'right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-nms-surface-1';
      default:
        return 'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-nms-surface-1';
    }
  };

  return (
    <div
      ref={triggerRef}
      className="relative inline-block"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {visible && content && (
        <div
          ref={tooltipRef}
          className={clsx(
            'absolute z-50 px-3 py-2 text-xs leading-relaxed text-nms-text bg-nms-surface-1 border border-nms-border rounded-lg shadow-lg',
            'animate-fade-in pointer-events-none whitespace-normal',
            getPositionClasses()
          )}
          style={{ maxWidth, minWidth }}
        >
          {content}
          {/* Arrow */}
          <div
            className={clsx(
              'absolute w-0 h-0 border-4',
              getArrowClasses()
            )}
          />
        </div>
      )}
    </div>
  );
}
