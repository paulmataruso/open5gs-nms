import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Adapts an async handler to what express 4 actually accepts.
 *
 * express 4 does NOT forward a rejected handler promise to its error handler
 * — that arrived in express 5 — and this project installs no
 * `unhandledRejection` handler anywhere, so a rejection escaping a handler
 * terminates the process. `@typescript-eslint/no-misused-promises` flags
 * exactly this: the handler returns a Promise where express's `RequestHandler`
 * declares `void`, so nothing is ever going to await it.
 *
 * `.catch(next)` is what closes the gap. index.ts already installs a
 * well-behaved express error handler at the end of the chain — it logs, and it
 * correctly calls `res.end()` rather than `res.status()` when headers have
 * already been sent, which matters because every module's streaming
 * `/install` has sent them (CLAUDE.md pattern #5). That handler was simply
 * unreachable from an async rejection. This makes it reachable.
 *
 * Note what this is NOT: a replacement for a handler's own try/catch. Measured
 * across src/interfaces/rest, all 434 async route handlers have one, and that
 * is where a handler's own errors should be answered with a meaningful status
 * and message. This is the net under the floor — for the throw nobody
 * anticipated, and for anything outside the try (a `JSON.parse` of a query
 * param, a `readFileSync` in a path-resolving helper) — so the failure is one
 * 500 instead of a dead backend.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
