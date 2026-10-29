# Dark Operator-Console Style Guide

A portable version of the design system the open5gs-nms frontend is built on:
five selectable dark themes driven by CSS custom properties, a small set of
component classes, a fixed page layout contract, and a WCAG 2.2 AA baseline.

It is written to be dropped into another project. Everything in the **Copy
these** sections is complete and self-contained — no imports from this
repository, no shared package. The stack it assumes is **React + TypeScript +
Vite + Tailwind CSS**, but only the Tailwind config and the CSS are
framework-specific; the layout and accessibility rules apply to any component
framework.

Rename the `nms-` prefix throughout if you want (`nms-card` → `ops-card`), but
rename it everywhere at once. A half-renamed token silently produces no CSS —
see [Anti-patterns](#anti-patterns).

---

## 1. The idea

**One accent hue per theme, semantic colors that never move.**

Every theme supplies its own background, surface, border, text and accent
colors. Green, red and amber are deliberately *identical across all themes*,
because in an operator console they carry meaning — healthy, failed, warning —
and that meaning must not shift when someone picks a different look.

**Tokens, never literals.** Components reference `bg-nms-surface`, never
`bg-[#111827]`. Themes are swapped at runtime by setting `data-theme` on
`<html>`, so any hardcoded color pins that element to whichever theme it was
eyeballed against and stays wrong in the other four.

**Density is the point.** This is a console for reading a lot of live state at
once: 12px labels, 4px/8px rhythm, tables over cards where the data is
tabular. It is not a marketing surface and should not be spaced like one.

---

## 2. Copy these — design tokens

Values are space-separated **RGB triplets**, not hex. That form is required so
Tailwind's opacity modifiers (`bg-nms-accent/20`) keep working: Tailwind can
only apply an alpha channel to a color expressed as
`rgb(var(--token) / <alpha-value>)`.

`:root` doubles as the default theme, so the UI renders correctly before any
JavaScript applies a stored preference.

```css
:root,
[data-theme="cyan"] {
  --nms-bg-rgb: 10 14 26;
  --nms-surface-rgb: 17 24 39;
  --nms-surface-2-rgb: 26 34 54;
  --nms-border-rgb: 30 41 59;
  --nms-border-strong-rgb: 70 96 137;
  --nms-accent-rgb: 6 182 212;
  --nms-accent-dim-rgb: 8 145 178;
  --nms-accent-fg-rgb: 10 14 26;
  --nms-text-rgb: 226 232 240;
  --nms-text-dim-rgb: 148 163 184;
  --nms-green-rgb: 16 185 129;
  --nms-red-rgb: 239 68 68;
  --nms-red-strong-rgb: 185 28 28;
  --nms-amber-rgb: 245 158 11;
}

[data-theme="violet"] {
  --nms-bg-rgb: 11 10 26;
  --nms-surface-rgb: 20 18 31;
  --nms-surface-2-rgb: 30 27 46;
  --nms-border-rgb: 42 38 64;
  --nms-border-strong-rgb: 95 86 144;
  --nms-accent-rgb: 139 92 246;
  --nms-accent-dim-rgb: 124 58 237;
  --nms-accent-fg-rgb: 11 10 26;
  --nms-text-rgb: 237 233 254;
  --nms-text-dim-rgb: 162 155 196;
  --nms-green-rgb: 16 185 129;
  --nms-red-rgb: 239 68 68;
  --nms-red-strong-rgb: 185 28 28;
  --nms-amber-rgb: 245 158 11;
}

[data-theme="emerald"] {
  --nms-bg-rgb: 6 18 12;
  --nms-surface-rgb: 13 31 22;
  --nms-surface-2-rgb: 20 43 31;
  --nms-border-rgb: 28 58 41;
  --nms-border-strong-rgb: 51 106 75;
  --nms-accent-rgb: 16 185 129;
  --nms-accent-dim-rgb: 5 150 105;
  --nms-accent-fg-rgb: 6 18 12;
  --nms-text-rgb: 209 250 229;
  --nms-text-dim-rgb: 134 169 150;
  --nms-green-rgb: 16 185 129;
  --nms-red-rgb: 239 68 68;
  --nms-red-strong-rgb: 185 28 28;
  --nms-amber-rgb: 245 158 11;
}

[data-theme="amber"] {
  --nms-bg-rgb: 18 14 8;
  --nms-surface-rgb: 28 21 13;
  --nms-surface-2-rgb: 38 28 17;
  --nms-border-rgb: 58 44 26;
  --nms-border-strong-rgb: 118 90 53;
  --nms-accent-rgb: 245 158 11;
  --nms-accent-dim-rgb: 217 119 6;
  --nms-accent-fg-rgb: 18 14 8;
  --nms-text-rgb: 254 243 199;
  --nms-text-dim-rgb: 184 163 126;
  --nms-green-rgb: 16 185 129;
  --nms-red-rgb: 239 68 68;
  --nms-red-strong-rgb: 185 28 28;
  --nms-amber-rgb: 245 158 11;
}

[data-theme="rose"] {
  --nms-bg-rgb: 18 7 10;
  --nms-surface-rgb: 28 15 19;
  --nms-surface-2-rgb: 41 22 32;
  --nms-border-rgb: 61 31 42;
  --nms-border-strong-rgb: 140 71 96;
  --nms-accent-rgb: 244 63 94;
  --nms-accent-dim-rgb: 225 29 72;
  --nms-accent-fg-rgb: 18 7 10;
  --nms-text-rgb: 255 228 230;
  --nms-text-dim-rgb: 185 141 149;
  --nms-green-rgb: 16 185 129;
  --nms-red-rgb: 239 68 68;
  --nms-red-strong-rgb: 185 28 28;
  --nms-amber-rgb: 245 158 11;
}
```

### What each token is for

| Token | Use |
|---|---|
| `nms-bg` | Page background. Also the fill behind inputs. |
| `nms-surface` | Card and panel fill — one step up from the page. |
| `nms-surface-2` | A panel inside a card: log output, tab bars, hover rows. |
| `nms-border` | **Decorative** edges only — card outlines, dividers. |
| `nms-border-strong` | **Interactive** edges — input, select, textarea, checkbox. |
| `nms-accent` | Primary action, active tab, link, selected state. |
| `nms-accent-dim` | Hover state for an accent fill. |
| `nms-accent-fg` | Foreground for anything sitting **on** `nms-accent`. |
| `nms-text` | Body text, values, headings. |
| `nms-text-dim` | Labels, help text, units, secondary values. |
| `nms-green` / `nms-red` / `nms-amber` | Healthy / failed / warning. Same in every theme. |
| `nms-red-strong` | A **solid** red fill that carries white text. |

### Three token choices that are load-bearing

These exist because the obvious alternative measurably fails. Keep them.

**`--nms-accent-fg` is the theme's own background, not white.** White on
`nms-accent` measures **2.15:1** (amber) to **4.23:1** (violet) — failing WCAG
AA in all five themes, and failing even the 3:1 large-text floor in three of
them. The theme's dark background on the same accent gives **4.62:1** (violet)
to **8.95:1** (amber), without touching the accent hues themselves.

**`--nms-border-strong` exists because `--nms-border` is far too faint for a
control.** Plain `nms-border` measures **1.32–1.53:1** against the page — fine
for a card edge or divider, which WCAG 1.4.11 exempts, and nowhere near the
3:1 that rule requires of the edge of something a user has to find and click.
Each strong value is the same border hue lightened until it clears 3:1, so the
UI still reads as one family.

**`--nms-red-strong` keeps white-on-red available.** White on `--nms-red` is
only **3.76:1**, so a solid danger fill with white text fails. Darkening just
the fill gets white to **6.42:1** and keeps the universally understood
white-on-red danger convention, instead of flipping to dark text on red, which
reads as a warning rather than a danger.

---

## 3. Copy these — Tailwind config

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'nms-bg': 'rgb(var(--nms-bg-rgb) / <alpha-value>)',
        'nms-surface': 'rgb(var(--nms-surface-rgb) / <alpha-value>)',
        'nms-surface-2': 'rgb(var(--nms-surface-2-rgb) / <alpha-value>)',
        'nms-border': 'rgb(var(--nms-border-rgb) / <alpha-value>)',
        'nms-border-strong': 'rgb(var(--nms-border-strong-rgb) / <alpha-value>)',
        'nms-accent': 'rgb(var(--nms-accent-rgb) / <alpha-value>)',
        'nms-accent-dim': 'rgb(var(--nms-accent-dim-rgb) / <alpha-value>)',
        'nms-accent-fg': 'rgb(var(--nms-accent-fg-rgb) / <alpha-value>)',
        'nms-green': 'rgb(var(--nms-green-rgb) / <alpha-value>)',
        'nms-red': 'rgb(var(--nms-red-rgb) / <alpha-value>)',
        'nms-red-strong': 'rgb(var(--nms-red-strong-rgb) / <alpha-value>)',
        'nms-amber': 'rgb(var(--nms-amber-rgb) / <alpha-value>)',
        'nms-text': 'rgb(var(--nms-text-rgb) / <alpha-value>)',
        'nms-text-dim': 'rgb(var(--nms-text-dim-rgb) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'flash-red': 'flashRed 1.2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Uses the CSS var directly, not the Tailwind color token: the token
        // only resolves its <alpha-value> placeholder inside a class name.
        // This way the animation still tracks a theme swap.
        flashRed: {
          '0%, 100%': { backgroundColor: 'rgb(var(--nms-red-rgb) / 0.06)' },
          '50%': { backgroundColor: 'rgb(var(--nms-red-rgb) / 0.28)' },
        },
      },
    },
  },
  plugins: [],
};
```

---

## 4. Typography

Two families, loaded from Google Fonts:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
  rel="stylesheet" />
```

- **JetBrains Mono is the default body face** (`font-sans` is mapped to it).
  Monospace by default is a deliberate choice for a console: identifiers, IPs,
  ports, hex and counters all line up without per-element opt-in.
- **Inter is `font-display`** — headings, stat values, anything meant to be
  read as prose rather than scanned as data.

| Role | Classes |
|---|---|
| Page title | `text-2xl font-semibold font-display` |
| Page subtitle | `text-sm text-nms-text-dim mt-1` |
| Card heading | `text-sm font-semibold text-nms-text` |
| Section heading | `text-sm font-semibold font-display uppercase tracking-wider text-nms-text-dim` |
| Stat label | `text-xs text-nms-text-dim uppercase tracking-wider` |
| Stat value | `text-2xl font-semibold font-display` |
| Body / field label | `text-xs` |
| Table cell, badge, log line | `text-xs` or smaller |

**Floor: body copy and field labels stay at `text-xs` (12px) or larger.**
Badges, inline markers, `<pre>` output and table cells may go smaller — that
density is deliberate, and WCAG sets no minimum font size — but explanatory
prose must not.

---

## 5. Copy these — component classes

```css
@layer components {
  .nms-card {
    @apply bg-nms-surface border border-nms-border rounded-lg p-4;
  }
  .nms-btn {
    @apply px-4 py-2 rounded-md font-medium text-sm transition-all duration-150
           disabled:opacity-50 disabled:cursor-not-allowed;
  }
  .nms-btn-primary {
    @apply nms-btn bg-nms-accent text-nms-accent-fg hover:bg-nms-accent-dim
           active:scale-[0.98];
  }
  .nms-btn-danger {
    @apply nms-btn bg-nms-red/20 text-nms-red border border-nms-red/30
           hover:bg-nms-red/30 active:scale-[0.98];
  }
  .nms-btn-ghost {
    @apply nms-btn bg-transparent text-nms-text-dim hover:bg-nms-surface-2
           hover:text-nms-text active:scale-[0.98];
  }
  .nms-input {
    @apply w-full bg-nms-bg border border-nms-border-strong rounded-md px-3 py-2 text-sm
           text-nms-text placeholder-nms-text-dim/50
           focus:outline-none focus:ring-2 focus:ring-nms-accent focus:border-nms-accent
           transition-colors;
  }
  .nms-label {
    @apply block text-xs font-medium text-nms-text-dim uppercase tracking-wider mb-1;
  }
  .nms-checkbox {
    @apply w-4 h-4 rounded border-nms-border-strong bg-nms-bg accent-nms-accent
           cursor-pointer;
  }
  /* Nesting a horizontal scroller inside the rounded clipper keeps the
     corners AND leaves overflowing columns reachable. */
  .nms-table-wrap {
    @apply border border-nms-border rounded-lg overflow-hidden;
  }
  .nms-table-scroll {
    @apply overflow-x-auto;
  }
  .status-dot {
    @apply w-2.5 h-2.5 rounded-full;
  }
  .status-dot-active {
    @apply status-dot bg-nms-green shadow-[0_0_6px_rgba(16,185,129,0.5)];
  }
  .status-dot-inactive {
    @apply status-dot bg-nms-red shadow-[0_0_6px_rgba(239,68,68,0.5)];
  }
}
```

`.nms-input` is the one place `focus:outline-none` is acceptable, because it
replaces the outline with `focus:ring-2` in the same declaration.

---

## 6. Copy these — base layer

Thin scrollbars, one focus indicator for the whole app, and reduced-motion
handling.

```css
@layer base {
  * {
    scrollbar-width: thin;
    scrollbar-color: rgb(var(--nms-border-rgb)) transparent;
  }
  *::-webkit-scrollbar { width: 6px; height: 6px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb {
    background-color: rgb(var(--nms-border-rgb));
    border-radius: 3px;
  }
  body {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /*
   * One keyboard-focus indicator for every interactive element.
   *  - `:focus-visible`, not `:focus`, so a mouse click never leaves a ring
   *    stuck on a button — the reason people reach for `outline: none` and
   *    break keyboard access in the first place.
   *  - `:where()` keeps specificity at 0, so a component class can override
   *    it without an !important arms race.
   *  - `outline-offset` puts the ring in the gap OUTSIDE the control, against
   *    the page surface rather than the control's own fill. That is what keeps
   *    it visible on an accent-filled primary button as well as a flat one.
   */
  :where(button, a, [role='button'], [role='tab'], summary, [tabindex]):focus-visible {
    outline: 2px solid rgb(var(--nms-text-rgb));
    outline-offset: 2px;
    border-radius: 2px;
  }
  :where(input, select, textarea):focus-visible {
    outline: 2px solid rgb(var(--nms-accent-rgb));
    outline-offset: 1px;
  }

  /*
   * Honor the OS "reduce motion" setting. Spinners are deliberately slowed
   * rather than frozen: a spinner here is load-bearing feedback for real
   * multi-minute operations, and a motionless spinner reads as a hung UI.
   */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
    .animate-spin {
      animation-duration: 1.6s !important;
      animation-iteration-count: infinite !important;
    }
    .animate-flash-red {
      /* Hold the mid-pulse tint as a steady state: the alert still reads as
         red, without the strobe. */
      animation: none !important;
      background-color: rgb(var(--nms-red-rgb) / 0.28) !important;
    }
  }
}
```

---

## 7. Page layout contract

Every page has the same skeleton. Consistency here is what makes a console with
dozens of pages feel like one application.

```tsx
<div className="p-6 space-y-6">
  {/* Header: title block left, status + actions right */}
  <div className="flex items-center justify-between flex-wrap gap-3">
    <div>
      <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
        <Icon className="w-6 h-6 text-nms-accent" />
        Page Title
      </h1>
      <p className="text-sm text-nms-text-dim mt-1">
        One sentence on what this page is for.
      </p>
    </div>
    <div className="flex items-center gap-3 flex-wrap">
      {/* status badges, then actions */}
    </div>
  </div>

  {/* content cards */}
</div>
```

**Rules**

- Outer wrapper is always `p-6 space-y-6`.
- Status badges and lifecycle actions (start/stop/restart/install) live in the
  **header**, never buried in a body card. An operator should never hunt for
  the stop button.
- Cards are **full width**. No `max-w` or centering wrapper on card content.
- Gate action visibility on *"is this thing installed"*, not *"is it fully
  configured"* — otherwise controls vanish for a service that is actually
  running but misconfigured, which is exactly when they are needed.

### Status badge

```tsx
<span className={`px-2.5 py-1 rounded-md text-xs font-medium border ${
  ok ? 'bg-nms-green/10 text-nms-green border-nms-green/30'
     : 'bg-nms-red/10 text-nms-red border-nms-red/30'
}`}>
  {ok ? 'Online' : 'Unreachable'}
</span>
```

Tinted-fill-plus-matching-border at 10%/30% alpha is the badge idiom
throughout. It works on every theme because both halves derive from the same
token.

### Tabs — centered pills

For a page with more than one logical section:

```tsx
<div className="flex justify-center">
  <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
    {TABS.map(t => (
      <button
        key={t.id}
        onClick={() => setTab(t.id)}
        className={clsx(
          'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
          tab === t.id
            ? 'bg-nms-accent text-nms-accent-fg shadow-sm'
            : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
        )}
      >
        {t.icon}
        {t.label}
      </button>
    ))}
  </div>
</div>
```

Note `text-nms-accent-fg` on the active pill, never `text-white`.

---

## 8. Card patterns

### Stat card

Label, value, one line of context, and a tinted icon tile on the right.

```tsx
<div className="nms-card animate-fade-in">
  <div className="flex items-start justify-between">
    <div>
      <p className="text-xs text-nms-text-dim uppercase tracking-wider">Label</p>
      <p className="text-2xl font-semibold font-display mt-1">{value}</p>
      <p className="text-xs text-nms-text-dim mt-1">{context}</p>
    </div>
    <div className="p-2.5 rounded-lg bg-nms-accent/10">
      <Icon className="w-5 h-5 text-nms-accent" />
    </div>
  </div>
</div>
```

The sub-line is not optional decoration — it is where the number gets its
meaning ("9 authorized · 0 pending" rather than a bare 9).

### Split card

One card, several sections, divided rather than nested. Set `!p-0` on the card
so each section owns its own padding.

```tsx
<div className="nms-card !p-0 divide-y divide-nms-border">
  <div className="grid grid-cols-2 divide-x divide-nms-border">
    <div className="p-4">{/* stat */}</div>
    <div className="p-4">{/* stat */}</div>
  </div>
  <div className="p-4 space-y-1.5">{/* detail rows */}</div>
</div>
```

**Prefer one divided card over two cards when the content comes from one
source.** Two cards read as two subsystems that could disagree.

### Detail row

The workhorse for "dim label left, mono value right":

```tsx
<div className="flex items-center justify-between text-xs">
  <span className="text-nms-text-dim">Band in use</span>
  <span className="font-mono text-nms-text">94 / 150 MHz (63%)</span>
</div>
```

### Grid rhythm, and how to avoid dead space inside a card

```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
```

CSS grid defaults to `align-items: stretch`, so every column fills the row's
tallest natural height. That is what makes the bottom edges line up — and also
what produces a band of unused surface inside any card shorter than its
neighbours.

Three rules keep that from happening:

1. **Balance the columns by content, not by hope.** Group short cards together
   so each column's *natural* height lands within a few tens of pixels of its
   siblings. This is the only real fix; the other two just absorb a remainder.
2. **Give a multi-card column's LAST card `flex-1`** so a small remainder
   grows that card rather than appending blank margin below it.
3. **For a single card that stretches, make the card `flex flex-col` and its
   last section `flex-1 flex flex-col justify-between`** so the remainder
   spreads the rows apart instead of pooling under the last one.

If a column is genuinely much shorter than the rest and there is nothing real
to put in it, give the row `items-start` instead and accept a ragged bottom
edge. Empty page background below a card reads as layout; empty card surface
inside a card reads as a bug.

### Table inside a card

```tsx
<div className="nms-table-scroll">
  <table className="w-full text-xs font-mono">
    <thead>
      <tr className="text-nms-text-dim">
        <th scope="col" className="text-left font-normal pb-1">Client</th>
        <th scope="col" className="text-right font-normal pb-1 pl-2">Requests</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-nms-border/40">
      {rows.map(r => (
        <tr key={r.id}>
          <td className="py-1 text-nms-text whitespace-nowrap">{r.name}</td>
          <td className="py-1 pl-2 text-right text-nms-text-dim">{r.count}</td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

Numbers right-aligned, labels left, `divide-y` at 40% alpha so rows separate
without striping. Every table that can outgrow its container gets
`.nms-table-scroll`.

### Empty and error states

Never render a blank card. Say what is missing and what it means:

```tsx
<p className="text-xs text-nms-text-dim">
  Nothing has asked this server for time in the last hour.
</p>
```

Distinguish *"not installed"*, *"installed but stopped"*, *"running but
unreachable"* and *"running, nothing to report"*. Collapsing them into one
"No data" is how a real outage gets read as an empty table.

---

## 9. Accessibility baseline

Non-negotiables for new UI. Each one exists because its absence was measured,
not assumed.

- **Never `text-white` on a themed background.** Use `text-nms-accent-fg` on
  `bg-nms-accent`, and `bg-nms-red-strong` for a solid red fill that carries
  white text. See §2 for the measurements.
- **Never hardcode a hex color in a component.** Use the tokens.
- **`border-nms-border-strong` for interactive boundaries** (input, select,
  textarea, checkbox), which WCAG 1.4.11 holds to 3:1. Plain `nms-border` is
  for decorative edges only.
- **Every icon-only button needs an `aria-label`,** and a destructive one must
  name its target: `aria-label="Remove network slice"`, not `"Remove"`. A
  state toggle describes what pressing it will *do*:
  `aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}`.
- **Every form control needs an accessible name.** An adjacent `<label>` does
  not give a control one — associate it with `htmlFor`/`id`, wrap the control
  in the label, or put a matching `aria-label` on the control. A wrapper
  component whose *caller* renders the label must accept a name prop and
  forward it, because the caller's label cannot reach inside.
- **Don't remove focus outlines.** The `:focus-visible` rule in §6 covers
  everything; `focus:outline-none` is acceptable only alongside a
  `focus:ring-*` replacement.
- **Overlays close on Escape.** A backdrop that closes on click has no
  keyboard equivalent, and giving the backdrop a tab stop is worse than the
  gap — it puts a focusable element with no accessible name in the tab order.
- **A clickable non-button needs keyboard parity:** `tabIndex={0}` plus
  Enter/Space handling, and `role="button"` — except on a `<tr>`, where that
  role destroys the table's semantics. A row takes the `tabIndex`/`onKeyDown`
  pair plus `aria-expanded`/`-selected`/`-current` and no role.
- **Never nest an interactive element inside another.** A `<button>` inside a
  `<button>` is invalid HTML and the inner one is keyboard-unreachable.
- **New motion must survive `prefers-reduced-motion`** (§6).
- **Charts and status must not rely on color alone.** Pair every color with a
  label, icon, or shape.

### Copy these — keyboard helpers

```ts
import { useEffect } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Enter/Space activation for a non-button control. Space is preventDefault'ed
 * because its default action on a focusable non-button is to scroll the page.
 * Activation is ignored when the event came from a nested control, so clicking
 * a row's own Delete button does not also trigger the row.
 */
export function activateOnKey<T extends HTMLElement>(handler: () => void) {
  return (e: ReactKeyboardEvent<T>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    if (t && t !== e.currentTarget && t.closest('button, a, input, select, textarea')) return;
    if (e.key === ' ') e.preventDefault();
    handler();
  };
}

/**
 * Dismiss-on-Escape for an overlay. Bound on document rather than the overlay
 * so it works regardless of where focus sits; `capture` keeps a nested overlay
 * from closing its parent as well — the innermost handler runs first and stops
 * the event there.
 */
export function useEscapeKey(onEscape: (() => void) | undefined, active = true) {
  useEffect(() => {
    if (!active || !onEscape) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onEscape, active]);
}
```

---

## 10. Anti-patterns

- **A phantom token renders nothing, silently.** Tailwind does not error on an
  undefined custom class or color — it generates no CSS, and the element
  renders unstyled. Before using a new `nms-*` class or color, confirm it
  exists in the CSS *and* in the Tailwind config.
- **`text-white` on an accent fill.** Fails AA in every theme (§2).
- **A literal hex in a component.** Pins that element to one theme.
- **A bare table inside `rounded-lg overflow-hidden`.** Clips overflowing
  columns with no way to reach them — worse than no wrapper, because the
  content is silently unreachable rather than merely awkward. Use
  `.nms-table-wrap` + `.nms-table-scroll`.
- **A static page import in the router.** Lazy-import pages
  (`lazy(() => import('./FooPage').then(m => ({ default: m.FooPage })))`). On
  this codebase, route splitting cut first load from ~821 kB to ~111 kB gzip;
  one static page import gives a chunk of that straight back.
- **Explanatory prose below 12px.**
- **Two cards for one data source** (§8).
- **A duplicated formatter or parser.** Two views of the same data that each
  parse it their own way will disagree eventually, and the disagreement shows
  up as a support question, not a test failure. Put the rule in one module and
  import it.

### One hard-won exception to "no literal hex"

Data-series colors — a per-entity palette for a chart and its legend — are
allowed to be literal hex, and should be, with a comment saying why: an entity
must keep its color when the operator switches theme, or the chart and its
legend stop agreeing about which series is which. That only works if every
theme is dark, so one palette is readable on all of them.

---

## 11. Porting checklist

1. Copy the token blocks (§2) into your global stylesheet, above
   `@layer base`.
2. Copy the Tailwind `colors`, `fontFamily`, `animation` and `keyframes`
   extensions (§3).
3. Add the font `<link>` (§4).
4. Copy the `@layer components` block (§5) and the `@layer base` block (§6).
5. Add a theme switcher that sets `data-theme` on `<html>` and persists the
   choice. `:root` already covers the pre-JavaScript render, so there is no
   flash of unstyled content.
6. Give `body` an explicit `bg-nms-bg text-nms-text` so the page background is
   never the browser default.
7. Build one page against §7 and §8 and use it as the reference for the rest.
8. Keep this file next to the code and update it when something here stops
   being true. A style guide that disagrees with the app is worse than none,
   because it gets cited.
