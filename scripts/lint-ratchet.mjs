#!/usr/bin/env node
// Lint ratchet: fails when a workspace's finding count RISES above its
// recorded baseline, and tells you to lower the baseline when it falls.
//
// Why a ratchet instead of a gate: the backend carries thousands of
// pre-existing findings (CI-LINT-PLAN.md). Gating on zero today would mean a
// permanently red build, which trains everyone to ignore it. A ratchet makes
// the number a one-way street while the cleanup happens, and Phase 7 replaces
// it with a real `--max-warnings 0` gate.
//
// Reads ESLint JSON on stdin so the rule set stays single-sourced in each
// workspace's own `lint:json` npm script:
//
//   cd backend && npm run -s lint:json | node ../scripts/lint-ratchet.mjs backend
//
// `--update` rewrites the baseline instead of checking it. The count is
// EXPECTED to rise twice during the plan (backend test files becoming
// lintable, and the frontend moving to the type-aware tier); re-baseline on
// purpose in those cases rather than treating them as regressions.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint-baseline.json');

const args = process.argv.slice(2);
const update = args.includes('--update');
const workspace = args.find((a) => !a.startsWith('--'));

if (!workspace) {
  console.error('usage: lint-ratchet.mjs <workspace> [--update]  (ESLint JSON on stdin)');
  process.exit(2);
}

const raw = readFileSync(0, 'utf-8').trim();
if (!raw) {
  console.error(`${workspace}: no ESLint JSON on stdin — refusing to report 0 findings.`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  // A non-JSON payload means eslint itself failed (a config error, a crash).
  // Treating that as "0 findings" would silently green the build and, with
  // --update, would overwrite the baseline with zeros.
  console.error(`${workspace}: stdin was not valid ESLint JSON — eslint probably failed to run.`);
  console.error(raw.slice(0, 2000));
  process.exit(2);
}
if (!Array.isArray(report)) {
  console.error(`${workspace}: expected an ESLint JSON array, got ${typeof report}.`);
  process.exit(2);
}

let errors = 0;
let warnings = 0;
let filesWithFindings = 0;
let fatals = 0;
for (const file of report) {
  if (file.messages?.length) filesWithFindings++;
  for (const m of file.messages ?? []) {
    if (m.fatal) fatals++;
    if (m.severity === 2) errors++;
    else if (m.severity === 1) warnings++;
  }
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));

if (update) {
  baseline[workspace] = { errors, warnings, files: report.length, filesWithFindings, fatals };
  baseline.measuredAt = new Date().toISOString().slice(0, 10);
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`${workspace}: baseline updated -> ${errors} errors, ${warnings} warnings`);
  process.exit(0);
}

const prev = baseline[workspace];
if (!prev) {
  console.error(`${workspace}: no baseline recorded. Run with --update to set one.`);
  process.exit(2);
}

const label = `${workspace}: ${errors} errors, ${warnings} warnings ` +
  `(baseline ${prev.errors}/${prev.warnings}) across ${filesWithFindings} of ${report.length} files`;

// A fatal is a parse failure, not a rule finding: the file was never actually
// linted. Counting it as one finding understates it badly, so say so plainly.
if (fatals > prev.fatals) {
  console.error(`${label}\nFAIL: fatal parse errors rose ${prev.fatals} -> ${fatals}. ` +
    `A fatal means the file was not linted at all.`);
  process.exit(1);
}

if (errors > prev.errors || warnings > prev.warnings) {
  console.error(`${label}\nFAIL: the count went UP. Fix the new findings, or — if this is a ` +
    `deliberate re-baseline (a widened rule set, newly lintable files) — re-run with --update ` +
    `and say why in the commit message.`);
  process.exit(1);
}

if (errors < prev.errors || warnings < prev.warnings) {
  console.log(`${label}\nThe count went DOWN. Lower the baseline in the same commit:\n` +
    `  cd ${workspace} && npm run -s lint:json | node ../scripts/lint-ratchet.mjs ${workspace} --update`);
  process.exit(0);
}

console.log(`${label}\nUnchanged.`);
