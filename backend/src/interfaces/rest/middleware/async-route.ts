import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Wraps an async route handler so a rejection reaches Express instead of
// escaping into an unhandled rejection.
//
// Express types RequestHandler as returning `void`. Handing it an `async`
// function therefore hands it a Promise it never awaits, and anything thrown
// outside the handler's own try/catch becomes an unhandled rejection with NO
// response ever written — the client waits until its own timeout rather than
// getting an error. That is the failure this fixes, and it is why
// @typescript-eslint/no-misused-promises flags the pattern at all.
//
// Measured on this codebase (2026-11-22): of 496 async route handlers, 445
// carry their own try/catch and 51 do not. Those 51 are the real hang risks;
// the rest are a lint finding without a defect behind them.
//
// Sending the error to next() rather than answering here is deliberate: the
// handler may already have written headers (several stream apt-get output —
// see CLAUDE.md pattern #5), and Express's own error handling knows to close
// the connection in that case rather than trying to write a second status.
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    try {
      // Promise.resolve, not a bare call: it also covers a non-async function
      // that returns a promise, and keeps the sync-throw path below honest.
      void Promise.resolve(handler(req, res, next)).catch(next);
    } catch (err) {
      // An `async` function cannot throw synchronously, but a plain function
      // returning a promise can throw before it returns one.
      next(err);
    }
  };
}
