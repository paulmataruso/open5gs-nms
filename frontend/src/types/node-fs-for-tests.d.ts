/**
 * The minimal `node:fs` surface the token-sweep test needs, declared here
 * rather than installed as @types/node.
 *
 * The frontend deliberately has no Node types: it builds for a browser, and
 * installing them would let a real component import 'fs' or touch `process`
 * and still typecheck. But `tsc` (the build gate) covers all of src/**,
 * __tests__ included, so a test that reads a repo file for comparison needs
 * SOME declaration. Two functions is the whole of it.
 *
 * Why the test reads from disk at all: vitest.config.ts sets `css: false`, and
 * a CSS import then resolves to the empty string under every query tried --
 * `?raw`, `?inline`, and an eager `import.meta.glob`. Scoping the config's own
 * `css` option to index.css does not change that either (measured). An empty
 * stylesheet would make every "is this class defined" assertion pass
 * vacuously, which is the exact bug class that test exists to catch, so
 * reading the real file is the only honest option.
 *
 * `process.cwd()` is declared too, and narrowly -- `cwd` only, never `env`.
 * `import.meta.url` is not usable for this: under vitest it is the module's
 * SERVED url, so walking up from src/components/common/__tests__ lands on
 * `/tailwind.config.js` -- the right path relative to the frontend root, with
 * no way to reach the filesystem root it sits under.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf-8'): string;
  export function existsSync(path: string): boolean;
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
}

declare const process: { cwd(): string };
