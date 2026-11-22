import type { NextFunction, Request, Response } from 'express';
import { asyncRoute } from '../async-route';

const req = {} as Request;
const res = {} as Response;
const tick = (): Promise<void> => new Promise((resolve) => { process.nextTick(resolve); });

describe('asyncRoute', () => {
  it('does not call next when the handler resolves', async () => {
    const next = jest.fn();
    asyncRoute(() => Promise.resolve('done'))(req, res, next as unknown as NextFunction);
    await tick();
    expect(next).not.toHaveBeenCalled();
  });

  it('routes a rejection to next instead of leaving it unhandled', async () => {
    // The defect this exists for: without the wrapper Express receives a
    // Promise it never awaits, the rejection goes unhandled, and NO response
    // is ever written -- the request hangs until the client times out.
    const boom = new Error('boom');
    const next = jest.fn();
    asyncRoute(() => Promise.reject(boom))(req, res, next as unknown as NextFunction);
    await tick();
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('returns synchronously, so Express is never handed a Promise', () => {
    // The whole point: what Express sees must be void, not a thenable.
    const result = asyncRoute(() => Promise.resolve())(req, res, jest.fn() as unknown as NextFunction);
    expect(result).toBeUndefined();
  });

  it('routes a synchronous throw to next as well', () => {
    // An async function cannot do this, but a plain function returning a
    // promise can throw before it returns one.
    const boom = new Error('sync boom');
    const next = jest.fn();
    const handler = (() => { throw boom; }) as unknown as () => Promise<void>;
    asyncRoute(handler)(req, res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('passes req, res and next through to the handler', async () => {
    const handler = jest.fn(() => Promise.resolve());
    const next = jest.fn();
    asyncRoute(handler)(req, res, next as unknown as NextFunction);
    await tick();
    expect(handler).toHaveBeenCalledWith(req, res, next);
  });

  it('forwards a rejection that is not an Error', async () => {
    const next = jest.fn();
    asyncRoute(() => Promise.reject('a string'))(req, res, next as unknown as NextFunction);
    await tick();
    expect(next).toHaveBeenCalledWith('a string');
  });
});
