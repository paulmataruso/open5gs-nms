# Mobile UI

How this NMS behaves on a phone, and why it is built the way it is.

This is a companion to `docs/style-guide.md`, which defines the design system
itself. Everything here obeys that contract — the same `nms-*` theme tokens, the
same accessibility baseline, the same page/card patterns. Nothing in the mobile
layer introduces a second visual language.

---

## 1. The problem this solves

Before this, the app rendered one desktop layout at every width. A phone got a
persistent 224 px sidebar against a 375 px viewport — 60% of the screen spent on
navigation — and page content squeezed into the remainder. Nothing was broken in
the sense of throwing an error; it was simply unusable, which is a worse failure
because it looks like a working page.

Three things were genuinely missing, not merely small:

1. **No layout swap.** `Layout.tsx` had no breakpoint handling at all. The
   sidebar was `w-56` or `w-16`, forever.
2. **No working back gesture.** Navigation is state (`activeTab` in `App.tsx`),
   not routes, so the browser/OS back button did nothing. On a phone, back is
   the primary navigation gesture, and a back button that silently does nothing
   reads as a frozen app. WCAG-adjacent UX guidance rates this High severity.
3. **No mobile viewport plumbing.** `h-screen` (`100vh`) is wrong on mobile
   browsers, whose toolbars shrink the visible area dynamically; and nothing
   accounted for the iOS home-indicator safe area.

## 2. Detection: CSS for style, JS for a different page

**Superseded in part, 2026-10-30 — read this whole section, not just the rule
in bold.** The rule below still governs the CHROME and the desktop-only pages.
It no longer describes the nine operator pages, which are now separate
mobile-only components rather than the desktop pages reflowed. See §2a.

**Rule: if a difference can be expressed as a style, it is a Tailwind
breakpoint. JS detection is only for swapping one component for a different
one.**

Padding, column counts, font sizes and visibility are all styles, so they stay
in the markup as `md:` variants and work with no JavaScript and no resize
listener. (`useIsMobile` returns the correct value from its `useState`
initialiser, so there is no visible flash of the wrong shell — but its mount
effect does re-set the same value, which costs one extra render per mount. Not
free, just not visible.) That is the mobile-first guidance followed
literally: the mobile value is the default, and `md:`/`lg:` enhance upward.

The navigation is the one real exception. A phone gets a bottom tab bar plus a
searchable sheet; a desktop gets a persistent sidebar. Those are different
components with different DOM, different ARIA and different state — not one
component with different padding. Rendering both and hiding one with CSS would
put ~35 duplicate nav buttons in the accessibility tree and double the focus
stops, so the swap happens in JS.

`useIsMobile()` (`src/hooks/useIsMobile.ts`) is that switch. It is
`matchMedia('(max-width: 767px)')` with a subscription, so it tracks rotation
and window resizing rather than sampling width once.

**767 must stay in lockstep with Tailwind's `md`.** The constant is exported as
`MOBILE_MAX_WIDTH_PX`, and `frontend/scripts/check-breakpoints.mjs` compares it
against the `screens.md` value in `tailwind.config.js`. It is the first link of
`npm run build`, so it runs inside the Docker image build too and a drift fails
the deploy rather than shipping.

It is a build check rather than a unit test because this frontend has no test
runner, and pulling one in to assert a single integer is a bad trade. Tailwind's
`screens` are now declared explicitly in the config instead of inherited from
the defaults, so the value this check reads is visible at the place someone
would edit it.

If the two drift, there is a band of widths that gets one shell's navigation
with the other's styles, and the symptom is a layout that is subtly wrong at
exactly one window size — close to impossible to notice on purpose.

Detection is deliberately **width-only, not `pointer: coarse`.** A narrow
desktop window gets the mobile shell, which is how the layout is developed and
tested; gating on touch capability would make it unreachable on the machine it
is built on, and would wrongly give a touchscreen laptop the phone layout at
1440 px.

## 2a. The mobile site: nine purpose-built pages

The original version of this layer reflowed the desktop pages with `md:`
variants. That was the wrong shape, and it failed in two ways an operator hit
immediately:

- **Tables do not reflow.** The desktop pages put per-row actions in the
  rightmost column of a wide table. At 375px that column sits behind a
  horizontal scroll, and the two 20px action chips in it overlap. No breakpoint
  variant fixes that, because the problem is the table.
- **Header action rows overflow.** The layout convention mounts status badges
  and module controls in the page header. Four or five of those do not fit
  375px and spill off the right edge.

So the nine destinations an operator actually uses from a phone have their own
components under `src/mobile/`, chosen in `App.tsx` by `useIsMobile()`:

| Page | Mobile component |
|---|---|
| Dashboard | `MobileDashboardPage` |
| RAN Network | `MobileRanPage` |
| Services | `MobileServicesPage` |
| Subscribers | `MobileSubscribersPage` |
| Unified Logs | `MobileLogsPage` |
| 4G/5G UE Signal | `MobileUeSignalPage` |
| Traffic History | `MobileTrafficHistoryPage` |
| SAS | `MobileSasPage` |
| Call History | `MobileCallHistoryPage` |

`src/mobile/mobileNav.ts` owns that list. `MOBILE_PAGES` in `mobilePages.tsx`
is typed as a **total** record over `MobilePageId`, so adding an id without
building its page is a compile error rather than a destination that renders
blank. Everything else renders `NeedsDesktopPage`.

**The shared vocabulary is `MobileKit.tsx`**, and three of its rules are
load-bearing:

- **`MRow` replaces the table.** One item owns its whole line, with the fields
  that were columns as a subtitle. There is one trailing slot, never a cluster
  of small buttons.
- **Per-item actions live in `MSheet`**, a bottom sheet, where each is a
  full-width 48px `MAction` carrying a sentence of consequence. This is also
  strictly safer than the desktop: Detach and Block are one tap apart in a
  desktop table cell and do very different things.
- **`MIconButton` exists so a 36px target cannot come back.** A negative margin
  repositions an element; it does not expand a hit area. The tempting
  `-m-2 h-9 w-9` shape looks spacious and is still a 36px target, and nothing
  about it looks wrong until it is missed.

Mobile pages own presentation only — they reuse the same stores, API clients
and hooks as the desktop, so there is no second data path to keep in step.

**They are also deliberately narrower in capability, not just in pixels.** The
dashboard is read-only (the desktop's RAN kill switches drop every radio of a
generation at once, which is not a one-thumb-tap-from-monitoring action);
Services has no bulk start/stop; Subscribers is read and look up, with no
editing. Each page says so in a footnote rather than silently lacking it.

One real trap found building this, worth not rediscovering: `useLogStream`
sends `unsubscribe_logs` when `services` is empty, so `services: []` produces a
view that connects, reports "Streaming" and shows nothing forever. The mobile
logs page therefore passes the full service list per source
(`SOURCE_SERVICES`), mirroring `LogsPage`'s own constants, and fetches the
container list for the one source that is discovered at runtime.

## 3. Navigation

### Why not just a hamburger drawer

A drawer alone would have been less work. It was rejected because this app has
**19 unconditional nav destinations plus up to 18 more behind feature flags** (so most builds land in the mid-twenties), and a drawer makes every one
of them equally far away — two taps and a scroll through a long list, every
time. An operator checking on a live network reaches for the same few screens
over and over.

### The shape

- **Bottom tab bar, 4 destinations + More.** Thumb-reachable, always visible,
  one tap. Capped at 5 slots per standard bottom-nav guidance; beyond that the
  labels stop fitting and the targets fall under the touch minimum.
- **A "More" sheet** holding every remaining destination, **with a search
  field**, because a list that long is not navigable by scrolling. The sheet
  is full-height, closes on Escape (`useEscapeKey`, the same hook every other
  overlay uses) and on backdrop tap.
- **A top bar** carrying the logo and the current page name, so the user always
  knows where they are — the sidebar's selected state is what did that job on
  desktop, and a bottom bar showing only 4 of 35 destinations cannot.

### The four primary destinations

`MOBILE_PRIMARY_TAB_IDS` in `src/components/common/navItems.ts`:

| Tab | Why it earns a slot |
|---|---|
| Dashboard | The whole-network answer to "is anything wrong" |
| RAN Network | Radios are the thing that is physically out in the world |
| Subscribers | The most common single-record lookup |
| Logs | Where you go the moment the dashboard says something is wrong |

This is a judgement call, kept as one exported array so it is a one-line change
rather than an edit scattered through JSX. Configuration, Auto Config and RF
Planning are deliberately **not** here: they are sit-down tasks, and putting a
destructive multi-step wizard one thumb-tap from a monitoring screen invites
exactly the mistake you do not want made on a phone.

### Back, and deep links

`App.tsx` now pushes a history entry per top-level navigation and restores the
tab on `popstate`, so back and forward move between SECTIONS as the platform
expects. **Tabs inside a page are not in history** — `ConfigPage`,
`PstnGatewayPage`, `IMSPage`, `SASPage` and the rest keep their own local tab
state — so a back press from three tabs deep inside Voice Gateway leaves the
page rather than stepping back a tab. That is a deliberate limit, not an
oversight, but it is a limit. The tab is also
reflected in the URL hash, which means a screen can be bookmarked, reloaded
without losing your place, and shared.

Two things this had to get right:

- **Every navigation goes through one `navigate()` function.** Pages receive it
  as `onNavigate`, so an in-page link pushes history exactly like a tab tap
  does. A second code path that set state directly would produce a back button
  that works sometimes, which is worse than one that never works.
- **`pushState` happens outside the `setState` updater.** An updater has to be
  pure and React may re-invoke it — StrictMode double-invokes every updater in
  development — so a push inside one fired twice per tap, and a `prev === tab`
  guard inside could not suppress it because both invocations saw the same
  `prev`. The result was a back button needing two presses in dev and one in
  production.
- **A tab id from the URL is validated against what this build can show.**
  Falling back only in the page switch fixes what is rendered while leaving
  `activeTab` holding the bogus id, so the title and every nav highlight would
  claim the user is somewhere they are not. `#pstn` on a build with PSTN
  disabled is the normal case, not a hostile one.
- **`popstate` must not push.** Restoring state in response to a pop, and
  pushing while doing it, is how you build a back button that cannot escape the
  current page.

## 4. Touch and target sizes

Two different standards apply and are easy to conflate:

- **WCAG 2.2 Target Size (Minimum) is 24×24 CSS px** — that is the conformance
  floor for web, and it is what the accessibility baseline in
  `docs/style-guide.md` is measured against.
- **44 pt (iOS) / 48 dp (Android)** are the native platform *comfort* targets.

This UI treats 44 px as the design target for anything in the mobile chrome
(tab bar items, the top bar's menu button, sheet rows) and 24 px as the hard
floor nothing may go under. Adjacent targets keep **at least 8 px** between
them.

Also handled:

- `touch-action: manipulation` on buttons, `[role=button]`, `summary`,
  checkboxes and radios, removing the legacy ~300 ms tap delay without a JS
  shim. Be precise about what that costs, because it is easy to state
  backwards: `manipulation` tells the browser to consider a touch starting on
  the element for panning and pinch-zoom **only**, so it is exactly what
  disables double-tap-to-zoom there — that is *how* it removes the delay. Page
  zoom is unaffected, including pinch-zoom over those controls. Links and
  `label`s are deliberately excluded, since they are as likely as ordinary text
  to be something you want to double-tap.
- `-webkit-tap-highlight-color: transparent`, because the default grey flash
  fights the theme's own `:active` state. **This makes an `active:` style
  mandatory** on anything in that selector list: `hover:` never fires on touch,
  so a control with only a hover style now gives a tap no feedback at all.
- **Nothing depends on hover.** Hover-only affordances are invisible on touch;
  where a hover reveal exists on desktop it is additive, and the underlying
  control is always tappable.

## 5. Viewport plumbing

- The shell is `100dvh`, with `100vh` as a preceding fallback for browsers that
  lack `dvh`. `100vh` alone puts the bottom tab bar under the browser toolbar
  on iOS Safari.
- **No `env(safe-area-inset-*)` padding is used, deliberately.** An earlier
  version of this layer added it to the top and bottom bars. Those rules were
  inert: without `viewport-fit=cover` on the viewport meta — which this app
  does not set — iOS lays the page out *inside* the safe area already and every
  `env(safe-area-inset-*)` resolves to `0`. So the home indicator was being
  cleared by the default viewport, not by those rules, and keeping them would
  have left four untested code paths that all go live the moment someone adds
  `viewport-fit=cover` for an edge-to-edge look. They were removed rather than
  left as decoration. If edge-to-edge is wanted later, add the meta and the
  insets together, and note the desktop shell would need them too.
- `.nms-table-scroll` gets `-webkit-overflow-scrolling: touch` and
  `overscroll-behavior-x: contain` (the x axis only — it is a horizontal
  scroller), so flicking a wide table to its end does not rubber-band the page
  behind it. The nav sheet's list gets `overscroll-contain` for the same reason
  on the y axis.

Fixed chrome is compensated for with padding on the scroll container, never by
overlapping content — a sticky bar that covers the first row of a table is a
real defect, and it is invisible in a screenshot taken at the top of the page.

## 6. Content density

Every page's wrapper moved from `p-6 space-y-6` to
`p-4 space-y-4 md:p-6 md:space-y-6`. 24 px of padding on each side of a 375 px
screen spends 13% of the width on margin.

Card internals that split into fixed columns (`grid-cols-2`, `grid-cols-4` with
`divide-x`) collapse at mobile width: a 4-across stat row leaves ~70 px per
column, which truncates both the label and the number. They become 2-across on
a phone and keep their desktop arrangement from `md:` up. The vertical dividers
are dropped in the collapsed state, since `divide-x` on a wrapped grid draws
lines in the middle of nowhere.

Tables keep `.nms-table-scroll`. A table is **not** reflowed into cards: these
are dense diagnostic tables where column-to-column comparison is the point, and
card-per-row destroys that. Horizontal scroll is the honest choice, and the
guidance explicitly allows either. What matters is that the wrapper is present —
the old idiom of a bare table inside `rounded-lg overflow-hidden` *clips* the
overflow and makes those columns permanently unreachable.

## 7. What is explicitly not mobile-optimised

Honesty is more useful than a claim of universal support. Everything outside
the nine in §2a — RF Planning's map-and-canvas workspace, the 17 core NF YAML
editors, Auto Config, Backup & Restore, the module install lifecycles, Packet
Capture's call-flow diagrams — has no mobile page, by decision rather than by
omission. These are sit-down tasks, and a cramped version of a destructive
multi-step wizard is worse than no version: it invites the mistake you least
want made one-thumbed, and it implies support that is not there.

**They are not hidden, and that distinction is the point.** Hiding by viewport
is its own trap — several modules here can genuinely be switched off at build
time, so an absent nav entry is indistinguishable from a disabled feature, and
the operator is left guessing which. Instead:

- the nav sheet lists them in a second group headed **"Needs a desktop"**,
  marked but still tappable;
- tapping one opens `NeedsDesktopPage`, which says plainly why, confirms the
  page is fully available at the same address on a desktop, and offers the
  mobile destinations;
- that screen is also reached without a tap — a tablet rotated from landscape
  into portrait crosses 768px with its nav state preserved, by design.

## 8. Testing

- Width breakpoints to check: **320, 375, 414, 768, 1024, 1440**. 320 is the
  floor (a small iPhone SE in portrait); 768 is the exact boundary and is worth
  checking on both sides, since that is where the shell swaps.
- `MOBILE_MAX_WIDTH_PX` vs Tailwind's `md` is enforced by
  `frontend/scripts/check-breakpoints.mjs`, which runs as part of
  `npm run build`. It is mutation-checked: setting the constant wrong does fail
  it, rather than the check merely passing on the happy path.
- **There is no frontend test runner**, so the shell swap, the primary-tab list
  and the history behaviour are not unit-tested. They are verified by hand
  against the widths above. That is a real gap, stated rather than papered
  over: adding vitest is the obvious next step if this layer grows.
