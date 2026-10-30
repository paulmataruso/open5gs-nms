import { useEffect, useRef, useState } from 'react';
import { LogOut, Check, Palette } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme, THEME_OPTIONS } from '../../contexts/ThemeContext';

/**
 * `variant` places the dropdown. The sidebar sits at the bottom of a tall
 * column, so its menu opens UPWARD; the mobile top bar is at the top of the
 * screen, where opening upward would put the whole menu off-screen. Additive
 * on purpose — 'sidebar' is the default and desktop behaviour is unchanged.
 */
export function UserMenu(
  { collapsed, variant = 'sidebar' }: { collapsed: boolean; variant?: 'sidebar' | 'topbar' },
): JSX.Element {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);

  return (
    <div
      ref={ref}
      className={clsx(
        'relative',
        variant === 'sidebar' ? 'border-t border-nms-border px-2 py-2' : 'shrink-0',
      )}
    >
      <button
        onClick={() => setOpen(o => !o)}
        // Only when there is no visible text. In the expanded sidebar the
        // button's visible label is the username + role, and an aria-label
        // that contains neither breaks WCAG 2.5.3 Label in Name — a
        // voice-control user saying "click <username>" would match nothing.
        aria-label={collapsed || variant === 'topbar' ? 'Account, theme and sign out' : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        className={clsx(
          'flex items-center gap-2 rounded-md transition-colors hover:bg-nms-surface-2 active:bg-nms-surface-2',
          variant === 'sidebar'
            ? 'w-full px-2 py-2'
            // 44px square: the touch comfort target. The sidebar version is
            // mouse-driven and keeps its original denser padding.
            : 'h-11 w-11 justify-center',
          collapsed && variant === 'sidebar' ? 'justify-center' : '',
        )}
      >
        <div className="w-7 h-7 rounded-full bg-nms-accent/20 border border-nms-accent/30 flex items-center justify-center shrink-0">
          <span className="text-xs font-semibold text-nms-accent">
            {user?.username?.[0]?.toUpperCase() ?? '?'}
          </span>
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0 text-left">
            <div className="text-xs font-medium text-nms-text truncate">{user?.username}</div>
            <div className="text-[10px] text-nms-text-dim uppercase tracking-wider">{user?.role}</div>
          </div>
        )}
      </button>

      {open && (
        <div
          className={clsx(
            'absolute z-20 w-56 rounded-lg border border-nms-border bg-nms-surface shadow-xl overflow-hidden',
            variant === 'topbar'
              // Anchored to the trigger's right edge so a 224px menu stays on
              // a 320px screen instead of overflowing the viewport.
              ? 'top-full mt-1 right-0'
              : clsx('bottom-full mb-1', collapsed ? 'left-full ml-1' : 'left-2 right-2 w-auto'),
          )}
        >
          <div className="px-3 py-2.5 border-b border-nms-border">
            <p className="text-xs text-nms-text-dim uppercase tracking-wider">Signed in as</p>
            <p className="text-sm font-medium text-nms-text truncate">{user?.username}</p>
          </div>

          <div className="p-1.5">
            <p className="px-1.5 pt-1 pb-1.5 text-xs font-semibold text-nms-text-dim uppercase tracking-wider flex items-center gap-1.5">
              <Palette className="w-3 h-3" /> Theme
            </p>
            {THEME_OPTIONS.map(t => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={clsx(
                  'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors',
                  t.id === theme
                    ? 'bg-nms-surface-2 text-nms-text'
                    : 'text-nms-text-dim hover:bg-nms-surface-2 hover:text-nms-text',
                )}
              >
                <span
                  className="w-3.5 h-3.5 rounded-full shrink-0 border border-nms-border"
                  style={{ backgroundColor: t.swatch }}
                />
                <span className="flex-1 text-left truncate">{t.label}</span>
                {t.id === theme && <Check className="w-3.5 h-3.5 shrink-0 text-nms-accent" />}
              </button>
            ))}
          </div>

          <div className="border-t border-nms-border p-1.5">
            <button
              onClick={logout}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-nms-text-dim hover:bg-nms-red/10 hover:text-nms-red transition-colors"
            >
              <LogOut className="w-3.5 h-3.5 shrink-0" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
