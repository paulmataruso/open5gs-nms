#!/usr/bin/env node
// Blocking lint gate for CHANGED LINES ONLY.
//
// The ratchet beside this file stops the total from rising, but it would
// happily accept a commit that adds 5 findings to one file and removes 5 from
// another. This is the gate that holds new code to the full rule set from day
// one — without failing a one-line edit to a legacy file that already carries
// 400 findings (ims-controller.ts really does; see CI-LINT-PLAN.md).
//
// Deliberately changed LINES, not changed FILES. Per-file granularity would
// make the 303 already-affected backend files untouchable, and the pressure
// that creates is to split an edit across a new file to dodge the gate, which
// is worse code for a greener build.
//
// Usage:  node scripts/lint-changed-lines.mjs <base-ref>
//
// A line counts as changed if the diff ADDS it. A finding is reported only
// when its line is one of those. Findings whose line the diff merely shifted
// are not yours.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const base = process.argv[2];
if (!base) {
  console.error('usage: lint-changed-lines.mjs <base-ref>');
  process.exit(2);
}

const repoRoot = resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim());

const git = (...a) => execFileSync('git', a, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

// Three-dot: compare against the merge base, so unrelated commits that landed
// on the base branch meanwhile are not attributed to this change.
// A brand-new branch's first push reports an all-zero "before" SHA, and a
// force-push can report a SHA that no longer exists. Neither is a failure of
// the change under test, so skip rather than fail the job on it.
if (/^0{40}$/.test(base)) {
  console.log('No usable base commit (first push on this ref) — nothing to compare against.');
  process.exit(0);
}

let mergeBase;
try {
  mergeBase = git('merge-base', base, 'HEAD').trim();
} catch {
  console.log(`Base commit "${base}" is not reachable (force-push, or a shallow clone) — skipping.`);
  process.exit(0);
}

// `blockOnWarnings` mirrors each workspace's OWN lint script, so this gate is
// never stricter than the command a developer runs by hand:
//   backend  `eslint src --ext .ts`                        -> warnings are advisory
//   frontend `eslint . ... --max-warnings 0`               -> warnings are errors
// This matters most for the backend's `explicit-function-return-type`, which is
// a warning and fires on practically every arrow function in a new test. Failing
// a PR over that would make adding a test unpleasant, and an unpleasant gate
// gets routed around. Warnings are still printed — just not fatal.
const WORKSPACES = [
  { name: 'backend',  prefix: 'backend/',  blockOnWarnings: false,
    args: ['src', '--ext', '.ts'] },
  { name: 'frontend', prefix: 'frontend/', blockOnWarnings: true,
    args: ['.', '--ext', 'ts,tsx', '--report-unused-disable-directives'] },
];

// Added line numbers per file, from -U0 hunk headers.
const diff = git('diff', '-U0', `${mergeBase}...HEAD`, '--', '*.ts', '*.tsx');
const added = new Map();
let current = null;
for (const line of diff.split('\n')) {
  const f = /^\+\+\+ b\/(.+)$/.exec(line);
  if (f) { current = f[1]; continue; }
  const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (h && current) {
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    if (count === 0) continue; // a pure deletion adds nothing
    let set = added.get(current);
    if (!set) { set = new Set(); added.set(current, set); }
    for (let i = 0; i < count; i++) set.add(start + i);
  }
}

if (added.size === 0) {
  console.log('No added/modified TypeScript lines in this change.');
  process.exit(0);
}

let blocking = 0;
let advisory = 0;
let filesChecked = 0;

for (const ws of WORKSPACES) {
  const files = [...added.keys()].filter((f) => f.startsWith(ws.prefix) && existsSync(resolve(repoRoot, f)));
  if (files.length === 0) continue;

  // Lint the whole workspace target rather than passing the file list: the
  // backend's type-aware rules need the tsconfig project, and passing paths
  // that the project excludes makes eslint fatal on them.
  let report;
  try {
    const out = execFileSync('npx', ['eslint', ...ws.args, '-f', 'json'], {
      cwd: resolve(repoRoot, ws.name), encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024,
    });
    report = JSON.parse(out);
  } catch (e) {
    // eslint exits non-zero when it reports anything; stdout is still the JSON.
    if (!e.stdout) { console.error(`${ws.name}: eslint failed to run\n${e.message}`); process.exit(2); }
    try { report = JSON.parse(e.stdout); }
    catch { console.error(`${ws.name}: eslint output was not JSON\n${String(e.stdout).slice(0, 2000)}`); process.exit(2); }
  }

  for (const file of report) {
    // eslint reports absolute paths; the diff speaks repo-relative ones.
    const repoRel = relative(repoRoot, file.filePath);
    const lines = added.get(repoRel);
    if (!lines) continue;
    filesChecked++;
    for (const m of file.messages ?? []) {
      if (!lines.has(m.line)) continue;
      const isWarning = !m.fatal && m.severity === 1;
      const blocks = !isWarning || ws.blockOnWarnings;
      if (blocks) blocking++; else advisory++;
      const sev = m.fatal ? 'fatal' : m.severity === 2 ? 'error' : blocks ? 'warning' : 'warning (advisory)';
      console.log(`${repoRel}:${m.line}:${m.column}  ${sev}  ${m.message}  ${m.ruleId ?? ''}`);
    }
  }
}

console.log(
  `\nChecked ${filesChecked} changed file(s) — ${blocking} blocking finding(s) ` +
  `and ${advisory} advisory warning(s) on added lines.`,
);
process.exit(blocking > 0 ? 1 : 0);
