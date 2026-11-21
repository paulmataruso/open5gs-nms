// Pins the changed-lines gate's notion of "added".
//
// The gate lives at scripts/lint-changed-lines.mjs and is plain ESM outside
// this workspace, so the parser was split into scripts/lib/diff-added-lines.mjs
// and is exercised here through a short node harness rather than imported:
// ts-jest runs CommonJS, and the gate must stay runnable by `node` with no
// build step.
//
// The case that matters is the first one. Until 2026-11-21 the parser read
// only the `@@` headers, so a byte-identical line that git had emitted as a
// `-`/`+` pair counted as added and the gate held a line nobody had edited to
// the full rule set. That is not hypothetical: it fired on PR #40.
import { execFileSync } from 'child_process';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const parserPath = path.join(repoRoot, 'scripts/lib/diff-added-lines.mjs');

function parseAddedLines(diff: string): Record<string, number[]> {
  const harness = `
    import { parseAddedLines } from ${JSON.stringify(parserPath)};
    let input = '';
    process.stdin.on('data', (d) => { input += d; }).on('end', () => {
      const out = {};
      for (const [file, lines] of parseAddedLines(input)) {
        out[file] = [...lines].sort((a, b) => a - b);
      }
      process.stdout.write(JSON.stringify(out));
    });
  `;
  const stdout = execFileSync('node', ['--input-type=module', '-e', harness], {
    input: diff,
    encoding: 'utf-8',
  });
  return JSON.parse(stdout) as Record<string, number[]>;
}

describe('changed-lines gate: which lines count as added', () => {
  it('ignores a line git emitted as -/+ with identical content', () => {
    // Reduced from the real PR #40 diff. Adding requireAdmin to /overview
    // realigned the hunk, so /poll came through as an unchanged -/+ pair.
    const diff = [
      'diff --git a/backend/src/interfaces/rest/radio-signal-controller.ts b/backend/src/interfaces/rest/radio-signal-controller.ts',
      'index 1111111..2222222 100644',
      '--- a/backend/src/interfaces/rest/radio-signal-controller.ts',
      '+++ b/backend/src/interfaces/rest/radio-signal-controller.ts',
      '@@ -375 +375 @@',
      "-  router.post('/poll', requireAdmin, async (_req, res) => {",
      "+  router.post('/poll', requireAdmin, async (_req, res) => {",
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({});
  });

  it('still reports a line whose content really changed', () => {
    const diff = [
      'diff --git a/backend/src/x.ts b/backend/src/x.ts',
      '--- a/backend/src/x.ts',
      '+++ b/backend/src/x.ts',
      '@@ -408 +408 @@',
      "-  router.get('/overview', async (req, res) => {",
      "+  router.get('/overview', requireAdmin, async (req, res) => {",
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({ 'backend/src/x.ts': [408] });
  });

  it('counts the second copy when a hunk removes one line and adds two', () => {
    // Guards the multiset: a set would swallow the genuinely new duplicate.
    const diff = [
      'diff --git a/backend/src/x.ts b/backend/src/x.ts',
      '--- a/backend/src/x.ts',
      '+++ b/backend/src/x.ts',
      '@@ -10 +10,2 @@',
      '-  doThing();',
      '+  doThing();',
      '+  doThing();',
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({ 'backend/src/x.ts': [11] });
  });

  it('reports every line of a pure addition', () => {
    const diff = [
      'diff --git a/backend/src/x.ts b/backend/src/x.ts',
      '--- a/backend/src/x.ts',
      '+++ b/backend/src/x.ts',
      '@@ -0,0 +1,3 @@',
      '+const a = 1;',
      '+const b = 2;',
      '+const c = 3;',
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({ 'backend/src/x.ts': [1, 2, 3] });
  });

  it('adds nothing for a pure deletion', () => {
    const diff = [
      'diff --git a/backend/src/x.ts b/backend/src/x.ts',
      '--- a/backend/src/x.ts',
      '+++ b/backend/src/x.ts',
      '@@ -5,2 +4,0 @@',
      '-const gone = 1;',
      '-const alsoGone = 2;',
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({});
  });

  it('ignores a deleted file rather than attributing its lines somewhere', () => {
    const diff = [
      'diff --git a/backend/src/gone.ts b/backend/src/gone.ts',
      '--- a/backend/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-const a = 1;',
      '-const b = 2;',
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({});
  });

  it('keeps per-file line sets separate across a multi-file diff', () => {
    const diff = [
      'diff --git a/backend/src/a.ts b/backend/src/a.ts',
      '--- a/backend/src/a.ts',
      '+++ b/backend/src/a.ts',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const a = 2;',
      'diff --git a/frontend/src/b.tsx b/frontend/src/b.tsx',
      '--- a/frontend/src/b.tsx',
      '+++ b/frontend/src/b.tsx',
      '@@ -0,0 +7,2 @@',
      '+const b = 1;',
      '+const c = 2;',
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({
      'backend/src/a.ts': [1],
      'frontend/src/b.tsx': [7, 8],
    });
  });

  it('handles several hunks in one file independently', () => {
    const diff = [
      'diff --git a/backend/src/x.ts b/backend/src/x.ts',
      '--- a/backend/src/x.ts',
      '+++ b/backend/src/x.ts',
      '@@ -3 +3 @@',
      '-  const untouched = 1;',
      '+  const untouched = 1;',
      '@@ -20 +20 @@',
      '-  const changed = 1;',
      '+  const changed = 2;',
      '',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual({ 'backend/src/x.ts': [20] });
  });
});
