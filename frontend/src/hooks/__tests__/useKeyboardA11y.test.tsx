// Keyboard parity for non-button controls, and dismiss-on-Escape for overlays.
//
// Worth testing first, ahead of anything cosmetic, because CLAUDE.md makes
// both of these MANDATORY for new UI ("A new overlay/modal closes on Escape.
// Use useEscapeKey"; "A clickable non-button needs tabIndex={0} +
// onKeyDown={activateOnKey(fn)}"). 35 files already call them. A rule applied
// that widely with no test under it is a rule that degrades quietly.
//
// The Escape block below also checks the mechanical claim the hook's own
// comment makes to justify `capture: true` — that with nested overlays "the
// innermost handler runs first and stops the event there". This repo has a
// recorded habit of comments asserting a property nobody re-measured (the
// sipTracing default in CLAUDE.md is the canonical one), so the claim is
// measured here rather than taken at its word.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEscapeKey, activateOnKey } from '../useKeyboardA11y';

/** A clickable non-button, wired the way CLAUDE.md tells new code to wire it. */
function Row({
  onActivate,
  children,
}: {
  onActivate: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="row"
      onClick={onActivate}
      onKeyDown={activateOnKey(onActivate)}
    >
      {children}
    </div>
  );
}

function Overlay({ onClose, label }: { onClose: () => void; label: string }) {
  useEscapeKey(onClose);
  return <div data-testid={label}>{label}</div>;
}

describe('activateOnKey', () => {
  it('activates on Enter and on Space', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Row onActivate={onActivate} />);

    screen.getByTestId('row').focus();
    await user.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.keyboard(' ');
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('ignores every other key, so typing elsewhere cannot activate a row', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Row onActivate={onActivate} />);

    screen.getByTestId('row').focus();
    await user.keyboard('{Tab}{Escape}{ArrowDown}a');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not activate the row when the key came from a nested control', async () => {
    // The real case this exists for: a table row that is itself clickable and
    // carries its own Delete button (CallDebugCard.tsx is the one such site in
    // the app today). The nested button stops its own click here, exactly as
    // that real site does — so what remains under test is purely whether the
    // KEYDOWN guard suppresses the row's own handler.
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onDelete = vi.fn();
    render(
      <Row onActivate={onActivate}>
        <button
          data-testid="delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          Delete
        </button>
      </Row>,
    );

    // By test id, not by role: the row itself carries role="button" and takes
    // its accessible name from its contents, so a by-role "Delete" query
    // legitimately matches BOTH the row and the button inside it.
    screen.getByTestId('delete').focus();
    await user.keyboard('{Enter}');

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('cannot protect the CLICK path — a nested control must stop its own click', async () => {
    // Same markup as above with the stopPropagation removed, which is the
    // mistake a new call site would make. The row's action fires anyway.
    //
    // This is a real limit of the hook, not a defect in it: activateOnKey is
    // an onKeyDown handler, so it never sees a click. Enter on a <button>
    // additionally makes the browser synthesise a click, and THAT is what
    // bubbles to the row's onClick. So the nested-control guard narrows the
    // keyboard path only.
    //
    // It matters because the hook's own comment described the thing it
    // protects as "clicking a row's own Delete button" — naming the one path
    // it does not cover, which invites a call site to omit the
    // stopPropagation it actually needs. That wording is corrected in the same
    // change as this test. The one real site with nested controls
    // (CallDebugCard.tsx) already stops both its <a> and its <button>, so
    // nothing is broken today; this pins why that is load-bearing rather than
    // decorative.
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onDelete = vi.fn();
    render(
      <Row onActivate={onActivate}>
        <button data-testid="delete" onClick={onDelete}>
          Delete
        </button>
      </Row>,
    );

    screen.getByTestId('delete').focus();
    await user.keyboard('{Enter}');

    expect(onDelete).toHaveBeenCalledTimes(1);
    // The row fired too — via the bubbling click, NOT via the guarded keydown.
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('still activates when the event target IS the row itself', async () => {
    // Guards the `t !== e.currentTarget` half of the nested-control check: a
    // naive `closest('button, ...)` test matches the row itself once the row
    // carries role="button", which would make every row inert.
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Row onActivate={onActivate} />);

    const row = screen.getByTestId('row');
    row.focus();
    expect(document.activeElement).toBe(row);
    await user.keyboard('{Enter}');

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('preventDefaults Space but not Enter', () => {
    // Space's default action on a focusable non-button is to scroll the page,
    // so the handler must consume it. Enter has no such default and
    // preventDefaulting it would break a form submit that happens to sit
    // inside the row.
    const handler = activateOnKey(() => {});

    const space = { key: ' ', preventDefault: vi.fn(), target: null, currentTarget: null };
    const enter = { key: 'Enter', preventDefault: vi.fn(), target: null, currentTarget: null };

    handler(space as never);
    handler(enter as never);

    expect(space.preventDefault).toHaveBeenCalledTimes(1);
    expect(enter.preventDefault).not.toHaveBeenCalled();
  });
});

describe('useEscapeKey', () => {
  it('closes on Escape regardless of where focus sits', async () => {
    // Bound on document, not the overlay, precisely so an overlay that never
    // took focus is still dismissible. Focus is parked on an outside input.
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <input data-testid="outside" />
        <Overlay onClose={onClose} label="solo" />
      </>,
    );

    screen.getByTestId('outside').focus();
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} label="solo" />);

    await user.keyboard('{Enter} {Tab}x');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does nothing when inactive or when no handler is supplied', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    function Inactive() {
      useEscapeKey(onClose, false);
      return null;
    }
    function NoHandler() {
      useEscapeKey(undefined);
      return null;
    }

    render(
      <>
        <Inactive />
        <NoHandler />
      </>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount, so a closed overlay stops responding', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(<Overlay onClose={onClose} label="solo" />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a nested overlay does NOT shield its parent — one Escape closes both', async () => {
    // This pins REAL behaviour, and it is the opposite of what the hook's own
    // comment claims ("the innermost handler runs first and stops the event
    // there"). Two reasons it cannot work as described:
    //
    //   1. Both listeners are attached to the SAME node (document), so the
    //      capture phase does not order them inner-first. Listeners on one
    //      node fire in REGISTRATION order, and the inner overlay mounts
    //      second, so it registers second and runs LAST.
    //   2. stopPropagation() does not stop other listeners on the same node.
    //      Only stopImmediatePropagation() does.
    //
    // So `capture: true` buys nothing for nesting. It is not currently a live
    // bug — no two of the 35 call sites are open at once today — but CLAUDE.md
    // requires this hook for every new overlay, so the first nested one will
    // close its parent too. Pinned rather than fixed: changing the hook would
    // alter dismissal behaviour for all 35 call sites, which is a decision for
    // the operator, not a drive-by. The comment is corrected in the same
    // change as this test.
    const user = userEvent.setup();
    const closeParent = vi.fn();
    const closeChild = vi.fn();

    render(
      <>
        <Overlay onClose={closeParent} label="parent" />
        <Overlay onClose={closeChild} label="child" />
      </>,
    );

    await user.keyboard('{Escape}');

    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeParent).toHaveBeenCalledTimes(1);
  });
});
