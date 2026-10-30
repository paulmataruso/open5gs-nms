import { useCallback, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import { ChevronRight, X, Loader2 } from 'lucide-react';
import { useEscapeKey } from '../hooks/useKeyboardA11y';

/**
 * The mobile site's own component vocabulary.
 *
 * The desktop UI is built from wide cards, dense tables and header-mounted
 * action rows, which is correct at 1440px and wrong at 375px — a table forces
 * horizontal scroll to reach the column that holds the actions, and a header
 * action row overflows off the right edge. Rather than reflowing those with
 * breakpoint variants, the mobile pages are composed from the primitives here:
 * full-width cards, vertical rows that own their whole line, and actions moved
 * off the row into a bottom sheet where each one is a real 44px target.
 *
 * Every primitive obeys docs/style-guide.md — the same `nms-*` tokens, no
 * hardcoded hex (five runtime themes), `border-nms-border-strong` on anything
 * interactive (WCAG 1.4.11 wants 3:1 and plain `nms-border` is ~1.4:1), and
 * `active:` feedback rather than `hover:`, which never fires on touch.
 */

/* ── Formatting ─────────────────────────────────────────────────────────── */

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtMbps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)} Gbps`;
  return `${n < 10 ? n.toFixed(2) : n.toFixed(1)} Mbps`;
}

/** Short relative time — "4m", "2h", "3d". Phones have no room for prose. */
export function fmtAgo(when: string | number | Date | null | undefined): string {
  if (when === null || when === undefined) return '—';
  const t = new Date(when).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/* ── Screen ─────────────────────────────────────────────────────────────── */

export type Tone = 'ok' | 'warn' | 'bad' | 'accent' | 'muted';

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-nms-green',
  warn: 'text-nms-amber',
  bad: 'text-nms-red',
  accent: 'text-nms-accent',
  muted: 'text-nms-text-dim',
};

const TONE_CHIP: Record<Tone, string> = {
  ok: 'text-nms-green bg-nms-green/10 border-nms-green/30',
  warn: 'text-nms-amber bg-nms-amber/10 border-nms-amber/30',
  bad: 'text-nms-red bg-nms-red/10 border-nms-red/30',
  accent: 'text-nms-accent bg-nms-accent/10 border-nms-accent/30',
  muted: 'text-nms-text-dim bg-nms-surface-2 border-nms-border',
};

/**
 * A mobile page root.
 *
 * `title` is rendered as a visually-hidden `<h1>`. The title is already on
 * screen in MobileTopBar, so printing it again would waste a third of a small
 * viewport's first screenful — but the page still needs exactly one `<h1>` for
 * heading navigation, and MobileTopBar deliberately uses a `<p>` so as not to
 * own it. Hidden-but-present satisfies both.
 *
 * The bottom padding clears the fixed tab bar: `--nms-bottom-chrome` is
 * published on <html> by MobileTabBar for exactly this, so the inset tracks the
 * real bar height instead of a duplicated constant.
 */
export function MScreen(
  { title, children }: { title: string; children: React.ReactNode },
): JSX.Element {
  return (
    <div
      className="space-y-3 px-4 pt-3"
      style={{ paddingBottom: 'calc(var(--nms-bottom-chrome, 0px) + 1.5rem)' }}
    >
      <h1 className="sr-only">{title}</h1>
      {children}
    </div>
  );
}

/** A labelled group of rows or cards. */
export function MSection(
  { title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode },
): JSX.Element {
  return (
    <section className="space-y-2">
      {(title || right) && (
        <div className="flex min-h-6 items-center justify-between gap-2">
          {title && (
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-nms-text-dim">
              {title}
            </h2>
          )}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function MCard(
  { children, className, pad = true }: { children: React.ReactNode; className?: string; pad?: boolean },
): JSX.Element {
  return (
    <div className={clsx('rounded-xl border border-nms-border bg-nms-surface', pad && 'p-3', className)}>
      {children}
    </div>
  );
}

/* ── Stats ──────────────────────────────────────────────────────────────── */

/**
 * Two columns by default.
 *
 * Three 1/3-width stats at 375px leave ~100px per cell, where a four-digit
 * count plus its label wraps mid-word. Two is the widest that always fits the
 * real values here.
 */
export function MStatGrid(
  { children, cols = 2 }: { children: React.ReactNode; cols?: 2 | 3 },
): JSX.Element {
  return (
    <div className={clsx('grid gap-2', cols === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {children}
    </div>
  );
}

export function MStat(
  { label, value, sub, tone = 'accent', onPress }:
  { label: string; value: React.ReactNode; sub?: string; tone?: Tone; onPress?: () => void },
): JSX.Element {
  const body = (
    <>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-nms-text-dim">{label}</span>
      <span className={clsx('mt-0.5 block font-display text-2xl font-semibold leading-none tabular-nums', TONE_TEXT[tone])}>
        {value}
      </span>
      {sub && <span className="mt-1 block truncate text-[11px] text-nms-text-dim">{sub}</span>}
    </>
  );
  if (!onPress) {
    return <div className="rounded-xl border border-nms-border bg-nms-surface p-3">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onPress}
      className="rounded-xl border border-nms-border-strong bg-nms-surface p-3 text-left transition-colors active:bg-nms-surface-2"
    >
      {body}
    </button>
  );
}

export function MBadge(
  { tone = 'muted', children }: { tone?: Tone; children: React.ReactNode },
): JSX.Element {
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold', TONE_CHIP[tone])}>
      {children}
    </span>
  );
}

/** A status dot. Never the only carrier of meaning — always paired with text. */
export function MDot({ tone }: { tone: Tone }): JSX.Element {
  const bg: Record<Tone, string> = {
    ok: 'bg-nms-green', warn: 'bg-nms-amber', bad: 'bg-nms-red',
    accent: 'bg-nms-accent', muted: 'bg-nms-text-dim',
  };
  return <span aria-hidden="true" className={clsx('h-2 w-2 shrink-0 rounded-full', bg[tone])} />;
}

/* ── Rows ───────────────────────────────────────────────────────────────── */

/**
 * One list item that owns its whole line.
 *
 * This is the table replacement. A row carries a title, a subtitle for the
 * fields that would have been columns, and ONE trailing slot — never a cluster
 * of small buttons, which is what overlaps at 375px. Per-item actions belong in
 * a sheet opened by pressing the row.
 */
export function MRow(
  { title, subtitle, meta, right, tone, onPress, ariaLabel }:
  {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    meta?: React.ReactNode;
    right?: React.ReactNode;
    tone?: Tone;
    onPress?: () => void;
    ariaLabel?: string;
  },
): JSX.Element {
  const inner = (
    <>
      {tone && <MDot tone={tone} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-nms-text">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-xs text-nms-text-dim">{subtitle}</span>}
        {meta && <span className="mt-1 flex flex-wrap items-center gap-1">{meta}</span>}
      </span>
      {right}
      {onPress && <ChevronRight className="h-4 w-4 shrink-0 text-nms-text-dim" aria-hidden="true" />}
    </>
  );
  const cls = 'flex w-full min-h-[3.25rem] items-center gap-2.5 px-3 py-2.5 text-left';
  if (!onPress) return <div className={cls}>{inner}</div>;
  return (
    <button type="button" onClick={onPress} aria-label={ariaLabel}
      className={clsx(cls, 'transition-colors active:bg-nms-surface-2')}>
      {inner}
    </button>
  );
}

/** Rows in one bordered group, hairline-separated. */
export function MRows({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="divide-y divide-nms-border overflow-hidden rounded-xl border border-nms-border bg-nms-surface">
      {children}
    </div>
  );
}

/**
 * A small icon-only control with a real 44px hit area.
 *
 * The icon reads at 16px, but the BUTTON is 44px and the negative margin pulls
 * its box back so it does not stretch the row it sits in. That ordering
 * matters: a negative margin repositions an element, it does not expand a hit
 * area, so the common `-m-2 h-9 w-9` shape looks spacious and is still a 36px
 * target. Sized here once rather than per page, because the regression is
 * invisible — nothing about a 36px button looks wrong until it is missed.
 */
export function MIconButton(
  { label, icon: Icon, spinning, onPress }:
  { label: string; icon: React.ComponentType<{ className?: string }>; spinning?: boolean; onPress: () => void },
): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={label}
      className="-m-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-nms-text-dim transition-colors active:bg-nms-surface-2"
    >
      <Icon className={clsx('h-4 w-4', spinning && 'animate-spin')} aria-hidden="true" />
    </button>
  );
}

/* ── Filter chips ───────────────────────────────────────────────────────── */

/**
 * A horizontally scrollable single-select.
 *
 * A `<select>` would be fewer pixels, but these are the primary way to pivot a
 * monitoring view and need to show the current choice without being opened.
 * The negative margin lets the strip bleed to both screen edges so it reads as
 * scrollable, while the padding keeps the first and last chip inside the
 * 16px page gutter.
 */
export function MChips<T extends string>(
  { options, value, onChange, ariaLabel }:
  { options: ReadonlyArray<{ value: T; label: string; count?: number }>; value: T; onChange: (v: T) => void; ariaLabel: string },
): JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel}
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {options.map(o => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors',
              active
                ? 'border-nms-accent bg-nms-accent text-nms-accent-fg'
                : 'border-nms-border-strong bg-nms-surface text-nms-text-dim active:bg-nms-surface-2',
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={clsx('tabular-nums', active ? 'opacity-80' : 'text-nms-text-dim')}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Bottom sheet ───────────────────────────────────────────────────────── */

/**
 * Android's hardware back and the browser back must DISMISS a sheet rather
 * than navigate the page behind it.
 *
 * Opening pushes a marker history entry so there is something for back to pop;
 * closing by any other route (Escape, the handle, picking an action) retires
 * it, so the entry cannot linger and make the NEXT back press a silent no-op.
 * Same contract MobileTabBar's nav sheet uses — kept here so every sheet on
 * the mobile site behaves identically.
 */
function useSheetBackDismiss(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    window.history.pushState({ ...(window.history.state ?? {}), nmsSheet: true }, '');
    let popped = false;
    const onPop = () => { popped = true; onClose(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!popped && (window.history.state as { nmsSheet?: boolean } | null)?.nmsSheet) {
        window.history.back();
      }
    };
  }, [open, onClose]);
}

/**
 * The mobile site's modal surface, anchored to the bottom of the screen where
 * a thumb reaches — not centred like the desktop ConfirmModal, whose buttons
 * land mid-screen on a phone.
 */
export function MSheet(
  { open, title, subtitle, onClose, children }:
  { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode },
): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useEscapeKey(close, open);
  useSheetBackDismiss(open, close);

  useEffect(() => {
    if (!open) return;
    // Move focus into the sheet so the next Tab stays inside it rather than
    // walking the page behind.
    panelRef.current?.focus();
    // The page behind must not scroll under the sheet.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      {/* The backdrop closes on tap. It is deliberately not focusable: giving a
          backdrop a tab stop is worse than the gap, and Escape plus the Close
          control already provide the keyboard path. */}
      <div className="absolute inset-0 bg-black/60" onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative max-h-[85vh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-nms-border bg-nms-surface outline-none"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)' }}
      >
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-nms-border bg-nms-surface px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-base font-semibold text-nms-text">{title}</p>
            {subtitle && <p className="mt-0.5 truncate text-xs text-nms-text-dim">{subtitle}</p>}
          </div>
          <button type="button" onClick={close} aria-label="Close"
            className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-nms-text-dim transition-colors active:bg-nms-surface-2">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 p-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * A full-width action inside a sheet.
 *
 * Full width and 48px tall because this is where per-item actions moved to.
 * On the desktop these were 20px-tall bordered chips sitting side by side in a
 * table cell; at 375px two of them in one cell overlap, and even separated they
 * are far under any touch minimum.
 */
export function MAction(
  { label, hint, icon: Icon, tone = 'muted', disabled, busy, onPress }:
  {
    label: string; hint?: string; icon?: React.ComponentType<{ className?: string }>;
    tone?: Tone; disabled?: boolean; busy?: boolean; onPress: () => void;
  },
): JSX.Element {
  const ring: Record<Tone, string> = {
    ok: 'border-nms-green/40 text-nms-green',
    warn: 'border-nms-amber/40 text-nms-amber',
    bad: 'border-nms-red/40 text-nms-red',
    accent: 'border-nms-accent/40 text-nms-accent',
    muted: 'border-nms-border-strong text-nms-text',
  };
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled || busy}
      className={clsx(
        'flex min-h-12 w-full items-center gap-3 rounded-xl border bg-nms-surface px-3 py-2 text-left transition-colors',
        'active:bg-nms-surface-2 disabled:cursor-not-allowed disabled:opacity-50',
        ring[tone],
      )}
    >
      {busy
        ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        : Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] font-normal text-nms-text-dim">{hint}</span>}
      </span>
    </button>
  );
}

/** Label/value pairs for a detail sheet. */
export function MFacts(
  { rows }: { rows: ReadonlyArray<{ label: string; value: React.ReactNode; mono?: boolean }> },
): JSX.Element {
  return (
    <dl className="divide-y divide-nms-border overflow-hidden rounded-xl border border-nms-border">
      {rows.map(r => (
        <div key={r.label} className="flex items-start gap-3 px-3 py-2">
          <dt className="w-28 shrink-0 text-xs text-nms-text-dim">{r.label}</dt>
          <dd className={clsx('min-w-0 flex-1 break-words text-right text-xs text-nms-text', r.mono && 'font-mono')}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ── States ─────────────────────────────────────────────────────────────── */

export function MEmpty(
  { icon: Icon, title, hint }:
  { icon?: React.ComponentType<{ className?: string }>; title: string; hint?: string },
): JSX.Element {
  return (
    <div className="rounded-xl border border-nms-border bg-nms-surface px-4 py-10 text-center">
      {Icon && <Icon className="mx-auto mb-3 h-8 w-8 text-nms-text-dim opacity-50" aria-hidden="true" />}
      <p className="text-sm font-medium text-nms-text">{title}</p>
      {hint && <p className="mt-1 text-xs text-nms-text-dim">{hint}</p>}
    </div>
  );
}

export function MLoading({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-nms-text-dim">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span className="text-xs">{label}…</span>
    </div>
  );
}

/** A compact search field sized for a thumb. */
export function MSearch(
  { value, onChange, placeholder, label }:
  { value: string; onChange: (v: string) => void; placeholder?: string; label: string },
): JSX.Element {
  return (
    <input
      type="search"
      inputMode="search"
      aria-label={label}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="nms-input min-h-11 w-full"
    />
  );
}
