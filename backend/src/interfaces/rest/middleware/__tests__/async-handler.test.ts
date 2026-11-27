/* eslint-disable @typescript-eslint/require-await */
// The stand-in handlers below are `async` with no `await` on purpose, and
// that is the thing under test rather than an oversight: what asyncHandler
// adapts is a function that RETURNS A PROMISE, and `async` is how these
// one-line stubs produce one. Two of them specifically need a synchronous
// throw inside an async function, which is the case that proves one
// `.catch` covers both failure shapes -- adding an `await` to satisfy the
// rule would delete the distinction the test exists to make.

import type { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../async-handler';

const req = {} as Request;
const res = {} as Response;

/** Lets a test await work the wrapper deliberately does NOT return. */
function nextThatSettles(): { next: NextFunction; settled: Promise<unknown> } {
  let resolve!: (v: unknown) => void;
  const settled = new Promise<unknown>((r) => { resolve = r; });
  const next = ((err?: unknown) => resolve(err)) as NextFunction;
  return { next, settled };
}

describe('asyncHandler', () => {
  it('returns a VOID-returning handler, which is the whole point', () => {
    // express's RequestHandler declares void. A handler that returns a Promise
    // is a promise nothing will ever await -- which is what
    // no-misused-promises flags, and on express 4 it is also what lets a
    // rejection escape to the process.
    const handler = asyncHandler(async () => Promise.resolve('ignored'));
    expect(handler(req, res, (() => undefined) as NextFunction)).toBeUndefined();
  });

  it('routes a rejection to next(), rather than out of the process', async () => {
    // The defect. express 4 does not forward a rejected handler promise to its
    // error handler, and this project has no unhandledRejection handler, so
    // without the .catch this throw terminated the backend.
    const { next, settled } = nextThatSettles();
    const boom = new Error('SQLITE_BUSY: database is locked');
    asyncHandler(() => Promise.reject(boom))(req, res, next);
    await expect(settled).resolves.toBe(boom);
  });

  it('routes a SYNCHRONOUS throw from an async function the same way', async () => {
    // An `async` function converts a synchronous throw into a rejection, so
    // the one catch covers both. Worth pinning: a plain (non-async) function
    // passed in would throw before the .catch exists, and express 4 DOES
    // handle that case itself -- which is why the parameter type requires a
    // Promise return.
    const { next, settled } = nextThatSettles();
    asyncHandler(async () => { throw new Error('boom'); })(req, res, next);
    await expect(settled).resolves.toBeInstanceOf(Error);
  });

  it('does not call next() when the handler resolves', async () => {
    // A handler that answered the request must not also fall through to the
    // next layer; calling next() on success would hand a already-answered
    // request to the error handler or to a 404.
    const next = jest.fn();
    asyncHandler(async () => 'answered')(req, res, next as NextFunction);
    await Promise.resolve();
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
  });

  it('passes req, res and next straight through', async () => {
    const seen: unknown[] = [];
    const next = (() => undefined) as NextFunction;
    asyncHandler(async (a, b, c) => { seen.push(a, b, c); return undefined; })(req, res, next);
    await Promise.resolve();
    expect(seen).toEqual([req, res, next]);
  });
});
