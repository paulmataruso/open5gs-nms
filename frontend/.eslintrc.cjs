/* eslint-env node */

// Variant A of CI-LINT-PLAN.md: eslint:recommended + @typescript-eslint
// recommended + react-hooks, WITHOUT the type-aware
// `recommended-requiring-type-checking` tier the backend uses. Measured
// 2026-11-21: this tier reports 488 errors, the type-aware tier 4,692.
// Raising to the type-aware tier is Phase 6, once the `no-explicit-any` work
// is done — most of the extra 4,204 are `no-unsafe-*` downstream of those
// same `any`s, so doing it in the other order means fixing the same thing
// twice.
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['react-refresh'],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs', 'scripts'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

    // `while (true)` is how you drain a ReadableStream reader, and this app
    // does that in 20 places to stream apt-get output into an install log.
    // Every one of those was a finding under the default; none was dead code
    // or an inverted test. ESLint 9 changed this rule's OWN default to stop
    // flagging `while (true)` for the same reason, via
    // `checkLoops: 'allExceptWhileTrue'` — but 8.57 only accepts a boolean
    // here and rejects the string outright as a schema error, so this is the
    // closest equivalent available. The valuable half of the rule is intact:
    // a constant condition in an `if`, a ternary or a `&&` is still an error.
    // TIGHTEN THIS to 'allExceptWhileTrue' when the ESLint 9 flat-config
    // migration happens (CI-LINT-PLAN.md, deferred to after Phase 7).
    'no-constant-condition': ['error', { checkLoops: false }],

    // `const { sd, ...rest } = x` is how this codebase deletes an optional
    // key while preserving unknown ones, so the omitted binding is
    // deliberately never read. Mirrors backend/.eslintrc.json's own
    // argsIgnorePattern, extended to the destructuring cases that idiom
    // actually produces. A genuinely unused variable with no underscore is
    // still an error.
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    }],
  },
};
