// Which lines of a unified diff are genuinely NEW.
//
// Split out of lint-changed-lines.mjs so it can be tested directly: the gate
// script itself does git and eslint work at import time, which a unit test
// has no business triggering.
//
// The reason this is not just "read the @@ headers" — which is what the gate
// did until 2026-11-21 — is that git's hunk alignment routinely emits a
// byte-identical line as a `-`/`+` PAIR. The header then claims the line was
// added and the gate holds a line nobody edited to the full rule set.
// Confirmed live on PR #40: `router.post('/poll', requireAdmin, async (_req,
// res) => {` was identical on both sides of the diff and was still blamed.
//
// Note what is deliberately NOT excluded here. A line whose content really
// did change owns every finding on it, including one that predates the
// change. Adding an argument to a call that was already breaking a rule makes
// that break yours to resolve. That is the gate working as intended.
export function parseAddedLines(diffText) {
  const added = new Map();
  let file = null;
  let inHunk = false;
  let nextPlusLine = 0;
  let plus = [];
  let minus = [];

  const flush = () => {
    if (file && plus.length) {
      // A multiset, not a set: if a hunk removes one copy of a line and adds
      // two, the second copy is genuinely new and must still be checked.
      const removed = new Map();
      for (const text of minus) removed.set(text, (removed.get(text) ?? 0) + 1);
      let set = added.get(file);
      for (const { line, text } of plus) {
        const remaining = removed.get(text) ?? 0;
        if (remaining > 0) { removed.set(text, remaining - 1); continue; }
        if (!set) { set = new Set(); added.set(file, set); }
        set.add(line);
      }
    }
    plus = [];
    minus = [];
  };

  for (const raw of diffText.split('\n')) {
    // Order matters: `--- a/x` and `+++ b/x` begin with the same characters as
    // body lines and are only distinguishable by sitting outside a hunk.
    if (raw.startsWith('diff --git ')) { flush(); inHunk = false; file = null; continue; }
    if (!inHunk && raw.startsWith('+++ ')) {
      flush();
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null; // `+++ /dev/null` on a delete
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { flush(); inHunk = true; nextPlusLine = Number(hunk[1]); continue; }
    if (!inHunk) continue;
    if (raw.startsWith('+')) { plus.push({ line: nextPlusLine++, text: raw.slice(1) }); continue; }
    if (raw.startsWith('-')) { minus.push(raw.slice(1)); continue; }
    if (raw.startsWith(' ')) { nextPlusLine++; continue; } // only if -U0 ever stops being used
  }
  flush();
  return added;
}
