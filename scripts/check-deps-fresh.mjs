#!/usr/bin/env node
// Is node_modules actually what the lockfile says?
//
// CI cannot drift: it runs `npm ci` into a clean tree. A working copy can, and
// does — `npm install` on one branch leaves its resolutions behind when you
// switch to another, and nothing tells you.
//
// That is not hypothetical. On 2026-11-27 a frontend lint run reported 510
// errors against a baseline of 379 and looked exactly like a change having
// added 131 findings. It was eslint-plugin-react-hooks 7.1.1 sitting in
// node_modules while that branch's lockfile still pinned 4.6.2. Two people hit
// the same false reading independently and both spent real time on it before
// recognising the toolchain rather than the code.
//
// Only direct dependencies are compared. A transitive mismatch is almost
// always a consequence of a direct one, and walking the whole tree turns a
// sub-second check into a slow one nobody runs.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const workspaces = process.argv.slice(2);
if (workspaces.length === 0) {
  console.error('usage: check-deps-fresh.mjs <workspace> [workspace...]');
  process.exit(2);
}

let drifted = 0;
let missing = 0;

for (const ws of workspaces) {
  const pkgPath = join(ws, 'package.json');
  const lockPath = join(ws, 'package-lock.json');
  if (!existsSync(pkgPath) || !existsSync(lockPath)) {
    console.error(`${ws}: no package.json/package-lock.json — skipped`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const direct = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const lockPkgs = lock.packages ?? {};

  for (const name of Object.keys(direct).sort()) {
    const want = lockPkgs[`node_modules/${name}`]?.version;
    if (want === undefined) continue; // not resolved in the lock; npm's problem, not ours
    const onDiskPath = join(ws, 'node_modules', name, 'package.json');
    if (!existsSync(onDiskPath)) {
      console.error(`${ws}: ${name} is in the lockfile at ${want} but NOT INSTALLED`);
      missing++;
      continue;
    }
    const have = JSON.parse(readFileSync(onDiskPath, 'utf8')).version;
    if (have !== want) {
      console.error(`${ws}: ${name} installed ${have}, lockfile says ${want}`);
      drifted++;
    }
  }
}

if (drifted || missing) {
  console.error('');
  console.error(`node_modules does not match the lockfile (${drifted} drifted, ${missing} missing).`);
  console.error('Any lint count, type error or test result from this tree may be an artifact of');
  console.error('the installed toolchain rather than the code. Run `npm ci` in the affected');
  console.error('workspace before trusting a number from it.');
  process.exit(1);
}
console.log(`node_modules matches the lockfile in: ${workspaces.join(', ')}`);
