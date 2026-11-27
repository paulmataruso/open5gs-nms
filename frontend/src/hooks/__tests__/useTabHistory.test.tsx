import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabHistory } from '../useTabHistory';
// Vite's ?raw gives the module's own source as a string. Used instead of
// node's fs because the frontend has no @types/node (see vitest.config.ts) —
// and `npm run build` typechecks this file, so an fs import fails the build
// rather than just this test.
import hookSource from '../useTabHistory.ts?raw';

/**
 * The browser's back button, on an app that navigates by state rather than
 * routes.
 *
 * Every assertion here corresponds to a bug the hook's own comments record
 * fixing, and none of them were pinned: a first history entry with no state
 * so back did nothing; a StrictMode double-invoked updater pushing twice per
 * tap (so back needed two presses in dev and one in production); a
 * hashchange that popstate never sees; and an unknown id from the URL kept in
 * `activeTab` while the PAGE fell back to the dashboard, so the title and
 * every nav highlight disagreed with what was on screen.
 *
 * jsdom gives us a real History and real popstate/hashchange events, so these
 * drive the actual mechanism rather than a stand-in.
 */

/** jsdom keeps history across tests in a file; start each one clean. */
beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

/** popstate does not fire on programmatic back() in jsdom, so dispatch it. */
function pop(state: unknown): void {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });
}

function hashTo(hash: string): void {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

describe('initial tab', () => {
  it('uses the default when the URL carries no hash', () => {
    const { result } = renderHook(() => useTabHistory('dashboard'));
    expect(result.current[0]).toBe('dashboard');
  });

  it('reads the tab out of the hash, so a screen is linkable and survives reload', () => {
    window.history.replaceState(null, '', '#logs');
    const { result } = renderHook(() => useTabHistory('dashboard'));
    expect(result.current[0]).toBe('logs');
  });

  it('seeds history.state on mount, which is what makes the first back press work', () => {
    renderHook(() => useTabHistory('dashboard'));
    expect(window.history.state).toEqual({ nmsTab: 'dashboard' });
  });

  it('does NOT write a hash into a bare URL on first paint', () => {
    // Mounting happens behind the login screen too, so seeding the address bar
    // would be a visible side effect of merely loading the app.
    renderHook(() => useTabHistory('dashboard'));
    expect(window.location.hash).toBe('');
  });

  it('corrects the URL when the hash it carries is not a tab this build can show', () => {
    window.history.replaceState(null, '', '#not-a-real-page');
    const { result } = renderHook(() => useTabHistory('dashboard', t => t === 'dashboard'));
    expect(result.current[0]).toBe('dashboard');
    expect(window.location.hash).toBe('#dashboard');
  });
});

describe('hash validation', () => {
  it.each([
    ['#Logs', 'an uppercase id'],
    ['#logs%20page', 'an encoded space'],
    ['#../../etc/passwd', 'a traversal attempt'],
    [`#${'x'.repeat(41)}`, 'an id over the length cap'],
    ['#%E0%A4%A', 'a malformed escape sequence that throws in decodeURIComponent'],
  ])('ignores %s (%s)', (hash) => {
    window.history.replaceState(null, '', hash);
    const { result } = renderHook(() => useTabHistory('dashboard'));
    // The hash is user-controllable, so a well-formed-looking value is not
    // enough; anything outside lowercase-kebab is ignored rather than trusted.
    expect(result.current[0]).toBe('dashboard');
  });

  it('accepts a real lowercase-kebab id', () => {
    window.history.replaceState(null, '', '#traffic-history');
    const { result } = renderHook(() => useTabHistory('dashboard'));
    expect(result.current[0]).toBe('traffic-history');
  });

  it('rejects a well-formed id the build cannot show, via isKnownTab', () => {
    // Character safety and "does this build have that page" are two separate
    // questions: the second depends on feature flags the hook has no business
    // knowing about.
    window.history.replaceState(null, '', '#gsm');
    const known = (t: string) => t !== 'gsm';
    const { result } = renderHook(() => useTabHistory('dashboard', known));
    expect(result.current[0]).toBe('dashboard');
  });
});

describe('navigate', () => {
  it('pushes one history entry and reflects the tab in the hash', () => {
    const { result } = renderHook(() => useTabHistory('dashboard'));
    const before = window.history.length;
    act(() => { result.current[1]('logs'); });
    expect(result.current[0]).toBe('logs');
    expect(window.location.hash).toBe('#logs');
    expect(window.history.state).toEqual({ nmsTab: 'logs' });
    expect(window.history.length).toBe(before + 1);
  });

  it('never calls pushState from inside a setActiveTab updater', () => {
    // The bug this guards: pushState inside the setState updater. An updater
    // must be pure and React is free to re-invoke it -- StrictMode
    // double-invokes every one in development, which made this push TWICE per
    // tap, so back needed two presses in dev and one in production. A
    // `prev === tab` guard inside cannot fix it, because both invocations see
    // the same `prev`.
    //
    // Asserted on the SOURCE, not at runtime, because two measurements showed
    // runtime cannot see it here: vitest resolves React's production build,
    // where an updater is invoked once even with reactStrictMode on; and
    // React 18 invokes the updater EAGERLY on a first dispatch (its
    // unchanged-state bail-out), so even "has the push happened before
    // navigate returns" is true either way. A runtime test would therefore
    // have claimed to cover this while passing on the broken code -- which is
    // worse than no test. The invariant is about placement, so placement is
    // what gets checked.
    const src = hookSource
      .split('\n').map((l: string) => l.replace(/\/\/.*$/, '')).join('\n');
    // Comments stripped first: the paragraph in the hook explaining this very
    // rule contains the word pushState inside a sentence about the updater.
    const marker = 'setActiveTab(';
    for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + 1)) {
      let depth = 0;
      let end = at + marker.length - 1;
      do {
        if (src[end] === '(') depth++;
        else if (src[end] === ')') depth--;
        end++;
      } while (depth > 0 && end < src.length);
      expect(src.slice(at, end)).not.toContain('pushState');
    }
    // Guards the scan itself: if the call is ever renamed, the loop above
    // would check nothing at all.
    expect(src).toContain(marker);
    expect(src).toContain('pushState');
  });

  it('re-tapping the current tab stacks no duplicate entry', () => {
    // Otherwise the user must press back as many times as they tapped before
    // anything happens.
    const { result } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    const after = window.history.length;
    act(() => { result.current[1]('logs'); });
    act(() => { result.current[1]('logs'); });
    expect(window.history.length).toBe(after);
  });

  it('refuses to navigate to an id the build cannot show', () => {
    const { result } = renderHook(() => useTabHistory('dashboard', t => t !== 'gsm'));
    act(() => { result.current[1]('gsm') });
    expect(result.current[0]).toBe('dashboard');
  });

  it('keeps a stable callback identity across navigations', () => {
    // `navigate` is passed to every nav item; a new identity per navigation
    // would re-render the whole sidebar on each tap. This is why the hook
    // holds the current tab in a ref rather than taking it as a dependency.
    const { result } = renderHook(() => useTabHistory('dashboard'));
    const first = result.current[1];
    act(() => { result.current[1]('logs'); });
    expect(result.current[1]).toBe(first);
  });
});

describe('browser back and forward', () => {
  it('restores the tab from the popped entry state', () => {
    const { result } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    pop({ nmsTab: 'dashboard' });
    expect(result.current[0]).toBe('dashboard');
  });

  it('falls back to the hash for an entry this app did not create', () => {
    // A pasted link, or an entry from before a deploy.
    const { result } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    window.history.replaceState(null, '', '#metrics');
    pop(null);
    expect(result.current[0]).toBe('metrics');
  });

  it('pushes nothing while handling a pop', () => {
    // Pushing from inside a pop handler builds a stack that grows as the user
    // tries to leave, so back can never escape the page.
    const { result } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    const push = vi.spyOn(window.history, 'pushState');
    pop({ nmsTab: 'dashboard' });
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it('does not adopt an unsafe id from a popped state — it falls back to the hash', () => {
    const { result } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    window.history.replaceState(null, '', '#metrics');
    pop({ nmsTab: '../../etc/passwd' });
    expect(result.current[0]).toBe('metrics');
  });

  it('falls all the way back to the default when neither state nor hash is usable', () => {
    window.history.replaceState(null, '', '/');
    const { result } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    window.history.replaceState(null, '', '#%E0%A4%A');
    pop({ nmsTab: 'Logs' });
    expect(result.current[0]).toBe('dashboard');
  });

  it('stops listening once unmounted', () => {
    const { result, unmount } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    unmount();
    // No assertion on state here — the point is that dispatching after
    // unmount does not warn or throw, which it would if the listener stayed.
    expect(() => pop({ nmsTab: 'metrics' })).not.toThrow();
  });
});

describe('editing the address bar', () => {
  it('follows a same-document fragment change, which popstate never sees', () => {
    // Typing #logs over #dashboard and pressing Enter fires hashchange, NOT
    // popstate. Without handling it the URL and the UI silently disagree, and
    // the next back press "restores" the tab the user is already on.
    const { result } = renderHook(() => useTabHistory('dashboard'));
    hashTo('#metrics');
    expect(result.current[0]).toBe('metrics');
  });

  it('ignores a hashchange that clears the hash', () => {
    const { result } = renderHook(() => useTabHistory('dashboard'));
    act(() => { result.current[1]('logs'); });
    hashTo('');
    expect(result.current[0]).toBe('logs');
  });

  it('falls back to the default for a hash the build cannot show', () => {
    const { result } = renderHook(() => useTabHistory('dashboard', t => t !== 'gsm'));
    hashTo('#gsm');
    expect(result.current[0]).toBe('dashboard');
  });
});
