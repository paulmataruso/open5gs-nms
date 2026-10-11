// LIFO undo stack. Every mutating test case pushes its own undo action here
// the moment a change is confirmed made — *before* even verifying the
// change worked, so a change that "worked" but failed verification still
// gets cleaned up. Drained in reverse order at the very end of the run (and
// from a `finally`, so a crash mid-suite still cleans up everything queued
// so far) — reverse order matters when two test cases touch the same
// resource (e.g. create-then-edit a test subscriber): undoing the edit
// before the create's own undo (the delete) runs is the only order that
// doesn't leave something half-restored.
export class RevertQueue {
  constructor(report) {
    this.stack = [];
    this.report = report;
  }

  // label: short human-readable description, shown in the report.
  // fn: async () => void — must itself be safe to call even if some other
  // part of the system already changed (best-effort restore, not a strict
  // transaction).
  push(label, fn) {
    this.stack.push({ label, fn });
  }

  get pending() {
    return this.stack.length;
  }

  async drainAll() {
    const results = [];
    while (this.stack.length > 0) {
      const { label, fn } = this.stack.pop();
      try {
        await fn();
        results.push({ label, ok: true });
      } catch (err) {
        results.push({ label, ok: false, error: String(err?.stack || err) });
      }
    }
    return results;
  }
}
