// Safe wrapper every test case runs through. This is what satisfies "must
// not crash if an operation does not work — it should just flag and
// report": no matter what a test case's `fn` throws (a network error, a
// malformed response it didn't expect, an assertion helper throwing), it's
// caught here and turned into a recorded `error` result instead of taking
// down the whole suite.
//
// A test case's `fn` receives { client, revertQueue, ctx } and returns
// either:
//   { status: 'pass' | 'fail' | 'skipped', detail, evidence }
//   or nothing (treated as a bare pass) for terse read-only checks.
export async function runCase(report, client, revertQueue, ctx, { module, name, fn, disruptive }) {
  if (disruptive && !ctx.includeDisruptive) {
    report.record({
      module, name, status: 'skipped',
      detail: 'disruptive test (restarts a live, always-on core NF) — pass --include-disruptive to run it',
    });
    return;
  }
  try {
    const result = await fn({ client, revertQueue, ctx });
    report.record({
      module,
      name,
      status: result?.status ?? 'pass',
      detail: result?.detail,
      evidence: result?.evidence,
    });
  } catch (err) {
    report.record({
      module,
      name,
      status: 'error',
      detail: err?.message ?? String(err),
      evidence: { stack: String(err?.stack || err) },
    });
  }
}

// Small assertion helpers test cases can throw from freely — the runCase
// wrapper above turns any throw into a recorded `error`, and a case can
// also just `return { status: 'fail', detail: '...' }` directly when it
// wants to distinguish "the product did the wrong thing" (fail) from "my
// test blew up" (error, via throwing).
export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertOk(res, label) {
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status} — ${JSON.stringify(res.data)}`);
  }
}

// Many modules expose a GET /<module>/status with an `installed`/`enabled`
// flag — use this at the top of a test case to turn "module not present on
// this instance" into a clean `skipped` instead of a flood of failures,
// which is what makes the suite portable across differently-configured
// instances (per-deployment ENABLE_*_MODULE flags).
export function skip(detail) {
  return { status: 'skipped', detail };
}

export function fail(detail, evidence) {
  return { status: 'fail', detail, evidence };
}

export function pass(detail, evidence) {
  return { status: 'pass', detail, evidence };
}
