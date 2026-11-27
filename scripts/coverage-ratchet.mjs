#!/usr/bin/env node
// Coverage ratchet: a one-way floor on frontend test coverage, PER FILE.
//
// Sibling of lint-ratchet.mjs, and the mechanism vitest.config.ts's coverage
// block says is "not built yet" while deliberately leaving `thresholds` unset.
//
// Why per file rather than a global percentage. The honest starting number is
// about 0.08%, and the goal is 100%, so the gate has to survive a long climb.
// A global-percentage floor fails that: adding one new page drops the
// percentage, so a commit that touches no tested code at all goes red, and the
// only way out is to re-baseline — which trains everyone to re-baseline, and a
// floor that is routinely lowered is not a floor. Ratcheting each file's own
// covered-statement count instead means a new file starts at zero and blocks
// nothing, while a file that has been covered can never quietly lose it.
//
// The baseline therefore records only what has been WON. A file with no
// coverage has no entry, because there is nothing to protect; it gains one the
// first time a test reaches it. At 0.04% the file is nearly empty, and it
// grows into the real record of the climb.
//
//   cd frontend && npm run -s test:coverage && node ../scripts/coverage-ratchet.mjs
//
// `--update` rewrites the baseline instead of checking it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'coverage-baseline.json');
const SUMMARY = join(ROOT, 'frontend', 'coverage', 'coverage-summary.json');

const args = process.argv.slice(2);
const update = args.includes('--update');

if (!existsSync(SUMMARY)) {
  // The same discipline as lint-ratchet's "no JSON on stdin": a missing
  // report means the coverage run did not happen or did not finish, and
  // reporting that as a pass — or, with --update, writing a baseline of
  // nothing — is worse than failing.
  console.error(`coverage: no ${relative(ROOT, SUMMARY)} — the coverage run did not produce a report.`);
  console.error('Run `cd frontend && npm run -s test:coverage` first.');
  process.exit(2);
}

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, 'utf-8'));
} catch {
  console.error(`coverage: ${relative(ROOT, SUMMARY)} is not valid JSON — the run probably crashed.`);
  process.exit(2);
}

const total = summary.total?.statements;
if (!total || typeof total.total !== 'number' || total.total === 0) {
  // Zero instrumented statements means the `include` glob matched nothing, or
  // the provider failed to load. Every file would then read as "lost no
  // coverage" and the ratchet would pass while measuring nothing.
  console.error('coverage: the report instruments 0 statements — nothing was measured. Refusing to report a pass.');
  process.exit(2);
}

/** Covered statements per file, keyed by path relative to the repo root. */
const covered = {};
const foreign = [];
for (const [abs, m] of Object.entries(summary)) {
  if (abs === 'total') continue;
  const rel = relative(ROOT, abs).split('\\').join('/');
  // A report whose paths are not under this checkout is a report of somebody
  // else's tree -- a stale copy, a different worktree, a container path. The
  // keys would then be `../../..` strings that match nothing in the baseline,
  // so every file would read as "lost no coverage" and the gate would pass
  // while comparing nothing. Found by running this script against a report
  // copied in from another directory, which is exactly how it would happen.
  if (rel.startsWith('..')) { foreign.push(abs); continue; }
  const n = m.statements?.covered ?? 0;
  if (n > 0) covered[rel] = n;
}
if (foreign.length) {
  console.error(`coverage: ${foreign.length} file(s) in the report are outside this checkout, ` +
    `starting with ${foreign[0]}.\nThe report does not describe this tree — re-run the ` +
    `coverage suite here rather than trusting it.`);
  process.exit(2);
}

// STATEMENTS and LINES only, deliberately. Measured on the first real run:
// 210 files in the report, 2 with any coverage, and v8 synthesises statement
// and line totals for a file it never loaded but NOT branch or function
// totals. So the report read `branches 17.62%` and `functions 11.37%` while
// the honest figure was 0.08% — those two percentages were coverage of the
// two loaded files, not of the frontend, and they will keep LOOKING high and
// drifting as the loaded set changes. Reporting them next to the real number
// would invite exactly the wrong conclusion.
const shape = {
  files: Object.keys(covered).length,
  statements: total.covered,
  statementsTotal: total.total,
  pct: {
    statements: summary.total.statements?.pct ?? 0,
    lines: summary.total.lines?.pct ?? 0,
  },
};

if (update) {
  const next = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf-8')) : {};
  next._comment = [
    'Per-file covered-STATEMENT counts for the frontend. A one-way floor: a',
    'file listed here may not come back with fewer covered statements than it',
    'has now. A file absent from `perFile` has no coverage to protect and is',
    'free to stay that way, so adding an untested page never fails this gate.',
    '',
    'Written by scripts/coverage-ratchet.mjs --update. The `total` block is',
    'reporting only — the gate is `perFile`.',
    '',
    'Only statements and lines are reported. v8 synthesises those totals for a',
    'file it never loaded, but not branch or function totals, so a branches or',
    'functions percentage here would describe only the files the suite happens',
    'to load. On the first run that read 17.62% branches against 0.08%',
    'statements, which is a number that can only mislead.',
  ];
  next.measuredAt = new Date().toISOString().slice(0, 10);
  next.total = shape;
  next.perFile = Object.fromEntries(Object.entries(covered).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + '\n');
  console.log(`coverage: baseline updated -> ${shape.files} covered file(s), ` +
    `${shape.statements}/${shape.statementsTotal} statements (${shape.pct.statements}%)`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('coverage: no baseline recorded. Run with --update to set one.');
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));
const prev = baseline.perFile ?? {};

const label = `coverage: ${shape.files} covered file(s), ` +
  `${shape.statements}/${shape.statementsTotal} statements (${shape.pct.statements}%) ` +
  `— baseline ${baseline.total?.files ?? '?'} file(s), ${baseline.total?.statements ?? '?'} statements`;

const lost = [];
for (const [file, was] of Object.entries(prev)) {
  const now = covered[file];
  if (now === undefined) {
    // Deleted or renamed files are a legitimate reason for an entry to
    // vanish, and this gate cannot tell that from a test being removed. Say
    // which it looks like rather than guessing.
    lost.push(`  ${file}: ${was} -> absent (file deleted or renamed? re-run with --update if so)`);
  } else if (now < was) {
    lost.push(`  ${file}: ${was} -> ${now} covered statements`);
  }
}

if (lost.length) {
  console.error(`${label}\nFAIL: ${lost.length} file(s) lost coverage:\n${lost.join('\n')}\n` +
    'Restore the coverage, or — if a file was deliberately deleted or renamed — ' +
    're-run with --update and say why in the commit message.');
  process.exit(1);
}

const gained = Object.entries(covered).filter(([f, n]) => (prev[f] ?? 0) < n).length;
if (gained) {
  console.log(`${label}\n${gained} file(s) gained coverage. Raise the floor in the same commit:\n` +
    '  cd frontend && npm run -s test:coverage && node ../scripts/coverage-ratchet.mjs --update');
  process.exit(0);
}

console.log(`${label}\nUnchanged.`);
