// Vitest config for the frontend workspace.
//
// This MERGES the real `vite.config.ts` rather than restating any of it. The
// `@` alias and the React plugin therefore resolve identically under test and
// in the production bundle, from one definition. A second, hand-copied alias
// table is the obvious shortcut and it drifts on the first edit — at which
// point a test can pass against a module the shipped bundle never loads.
//
// Why a separate file at all, instead of a `test:` key inside vite.config.ts:
// adding one would mean importing `defineConfig` from 'vitest/config' in the
// file that builds the real artifact, so a vitest resolution problem could
// break `npm run build`. The production config stays free of test concerns.
//
// Scope note: the three PURE frontend modules (`components/dhcp/subnet-reach`,
// `components/ran/radio-grouping`, `components/config/editors/address-field`)
// are already executed by the BACKEND's jest run, which imports them across
// the workspace boundary. They are deliberately not re-tested here. What this
// runner adds is the part jest cannot reach: anything that needs a DOM —
// components, hooks and stores.
// Note: this file is not reached by any typecheck gate, and neither is
// vite.config.ts. `tsconfig.json` includes only `src`, and tsconfig.node.json
// (which includes vite.config.ts) is a project REFERENCE, which plain `tsc`
// does not build. Adding this file there was tried and reverted: that config
// has no `types: ["node"]`, so `tsc -p tsconfig.node.json` already fails on
// vite.config.ts's own `path` import and `__dirname`, and installing
// @types/node into the frontend purely to fix an ungated config is a worse
// trade than leaving it. This file was checked clean directly instead.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // jsdom, not happy-dom: this suite asserts on real event-phase ordering
      // (see hooks/__tests__/useKeyboardA11y.test.tsx), and jsdom is the
      // implementation whose capture/bubble semantics are specified against
      // the DOM standard rather than approximated for speed.
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
      css: false,

      // Two workers, matching the backend's own `--runInBand` reasoning in
      // CLAUDE.md: this host is 4 cores and is also running the live 5G core,
      // so an unbounded worker-per-core default is measurably antisocial. CI
      // runners are 2-core anyway, so this costs nothing there.
      maxWorkers: 2,
      minWorkers: 1,

      coverage: {
        provider: 'v8',
        // json-summary is what a future coverage ratchet reads; text is for a
        // human reading CI output. No lcov until something consumes it.
        reporter: ['text-summary', 'json-summary'],
        reportsDirectory: './coverage',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          // Type-only: no statements to cover, so counting them would flatter
          // the number rather than measure anything.
          'src/**/*.d.ts',
          'src/types/**',
          // The tests themselves, and their setup.
          'src/**/__tests__/**',
          'src/test/**',
          // Bootstrap: mounts React into a real document and is exercised by
          // the production build, not by unit tests.
          'src/main.tsx',
        ],
        // Deliberately NO thresholds here. The honest starting number is low,
        // and a threshold set to whatever today happens to be is a number that
        // only ever blocks; the ratchet (a one-way floor, like lint-baseline
        // .json) is the mechanism that actually moves it, and it is not built
        // yet. An unset threshold reports the truth without failing the build.
      },
    },
  }),
);
