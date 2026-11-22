// Narrowing helpers for values this process did not create: an Express
// `req.body`, a third party's JSON response, a parsed config.
//
// Phase 5 of CI-LINT-PLAN.md types those boundaries so the no-unsafe-* rules
// stop firing on everything downstream. The pattern that keeps recurring is
// "treat this as a bag of unknown-valued keys, then check each one", so it
// lives here once rather than being re-written per controller.
//
// Deliberately NOT a validator. It answers one question — is this an object I
// can index — and leaves every value `unknown` so the caller still has to
// check what it reads. Returning `{}` rather than throwing matches what the
// `req.body ?? {}` idiom this replaces already did: a malformed body falls
// through to each field's own default or validation error, which is a 400 with
// a useful message rather than a 500.

/**
 * An object whose keys can be read, with every value still `unknown`.
 *
 * Arrays return `{}`: every caller so far wants "a JSON object", and an array
 * indexed by a field name yields undefined anyway, so this makes that explicit
 * instead of leaving a surprising half-usable value. `null` returns `{}` too,
 * since `typeof null === 'object'`.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
