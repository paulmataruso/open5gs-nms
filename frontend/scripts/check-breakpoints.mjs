#!/usr/bin/env node
/**
 * Fails the build if the mobile-shell breakpoint in JS drifts from Tailwind's
 * `md`.
 *
 * Why this exists rather than a unit test: this frontend has no test runner,
 * and adding one to assert a single integer is a poor trade. This runs as the
 * first link of `npm run build`, so it also runs inside the Docker image
 * build — a drift fails the deploy rather than shipping.
 *
 * What drift actually costs: layout differences that are purely visual are
 * `md:` variants in the markup, while the navigation is swapped in JS at
 * MOBILE_MAX_WIDTH_PX. If the two disagree there is a band of widths that gets
 * the mobile navigation with desktop spacing (or the reverse). The symptom is
 * a layout that is subtly wrong at exactly one window size, which is close to
 * impossible to notice deliberately.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function fail(msg) {
  console.error(`\n  check-breakpoints: ${msg}\n`);
  process.exit(1);
}

const tw = readFileSync(resolve(root, 'tailwind.config.js'), 'utf8');
const hook = readFileSync(resolve(root, 'src/hooks/useIsMobile.ts'), 'utf8');

// Scoped to the `screens` block so a `md:` string anywhere else in the config
// cannot satisfy this by accident.
const screens = tw.match(/screens:\s*\{([\s\S]*?)\}/);
if (!screens) fail('no `screens` block in tailwind.config.js — declare it explicitly so this check has something to compare against.');

const md = screens[1].match(/\bmd:\s*'(\d+)px'/);
if (!md) fail("no `md: '<n>px'` entry inside tailwind.config.js's `screens` block.");

const mobileMax = hook.match(/export const MOBILE_MAX_WIDTH_PX\s*=\s*(\d+)/);
if (!mobileMax) fail('no `export const MOBILE_MAX_WIDTH_PX = <n>` in src/hooks/useIsMobile.ts.');

const mdPx = Number(md[1]);
const maxPx = Number(mobileMax[1]);

if (maxPx !== mdPx - 1) {
  fail(
    `MOBILE_MAX_WIDTH_PX is ${maxPx} but Tailwind's md is ${mdPx}px, so it must be ${mdPx - 1}.\n`
    + `  As it stands, widths ${Math.min(maxPx + 1, mdPx)}–${Math.max(maxPx, mdPx - 1)}px get one shell's `
    + `navigation with the other's styles.\n`
    + '  Fix whichever is wrong in tailwind.config.js or src/hooks/useIsMobile.ts.',
  );
}

console.log(`check-breakpoints: ok (md=${mdPx}px, mobile<=${maxPx}px)`);
