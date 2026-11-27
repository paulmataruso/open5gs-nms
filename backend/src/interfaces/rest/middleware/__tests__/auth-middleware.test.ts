import type { Request, Response } from 'express';
import { createAuthMiddleware, requireAdmin } from '../auth-middleware';

/**
 * auth-middleware.ts is testable only because every one of its imports is
 * `import type` — including `AppLucia`. A value import from
 * sqlite-auth-repository would pull in ESM-only `lucia`, which jest cannot
 * load at all, and this file would have to be deleted. Keep the type-only
 * imports type-only.
 */

type Lucia = Parameters<typeof createAuthMiddleware>[0];

interface FakeRes {
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  setHeader(k: string, v: string): FakeRes;
}

/** The three response methods this middleware actually uses, and nothing else. */
function res(): Response & FakeRes {
  const r: FakeRes = {
    statusCode: null,
    body: undefined,
    headers: {},
    status(code) { r.statusCode = code; return r; },
    json(payload) { r.body = payload; return r; },
    setHeader(k, v) { r.headers[k] = v; return r; },
  };
  return r as Response & FakeRes;
}

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

const attributes = {
  username: 'operator',
  role: 'admin',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastLoginAt: null,
};

function lucia(over: Partial<Record<string, unknown>> = {}): Lucia {
  return {
    readSessionCookie: () => 'sess-1',
    createBlankSessionCookie: () => ({ serialize: () => 'nms_session=; Max-Age=0' }),
    createSessionCookie: () => ({ serialize: () => 'nms_session=sess-1' }),
    validateSession: () => Promise.resolve({
      session: { id: 'sess-1', userId: 'u1', expiresAt: new Date(), fresh: false },
      user: { id: 'u1', ...attributes },
    }),
    ...over,
  } as unknown as Lucia;
}

const req = (over: Partial<Request> = {}): Request =>
  ({ headers: { cookie: 'nms_session=sess-1' }, path: '/api/subscribers', ...over }) as Request;

beforeEach(() => jest.clearAllMocks());

describe('createAuthMiddleware', () => {
  it('answers 500 rather than terminating the process when validateSession throws', async () => {
    // The defect this pins. express is pinned at 4.x and express 4 does NOT
    // forward a rejected async-middleware promise to its error handler, and
    // this project installs no unhandledRejection handler anywhere -- so
    // before the try/catch, a throw here took the whole backend down rather
    // than failing the one request. better-sqlite3 is synchronous and throws
    // on SQLITE_BUSY, so this is an ordinary Tuesday, not a contrived case.
    const next = jest.fn();
    const r = res();
    const mw = createAuthMiddleware(
      lucia({ validateSession: () => { throw new Error('SQLITE_BUSY: database is locked'); } }),
      logger as never,
    );

    await expect(mw(req(), r, next)).resolves.toBeUndefined();

    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ success: false, error: 'Session validation failed' });
    expect(next).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('answers 500 when validateSession rejects asynchronously', async () => {
    const r = res();
    const mw = createAuthMiddleware(
      lucia({ validateSession: () => Promise.reject(new Error('disk I/O error')) }),
      logger as never,
    );
    await mw(req(), r, jest.fn());
    expect(r.statusCode).toBe(500);
  });

  it('401s with no session cookie, and does not call validateSession', async () => {
    const validateSession = jest.fn();
    const r = res();
    const mw = createAuthMiddleware(
      lucia({ readSessionCookie: () => null, validateSession }),
      logger as never,
    );
    await mw(req({ headers: {} }), r, jest.fn());
    expect(r.statusCode).toBe(401);
    expect(validateSession).not.toHaveBeenCalled();
  });

  it('401s and blanks the cookie for a session that no longer validates', async () => {
    const r = res();
    const mw = createAuthMiddleware(
      lucia({ validateSession: () => Promise.resolve({ session: null, user: null }) }),
      logger as never,
    );
    await mw(req(), r, jest.fn());
    expect(r.statusCode).toBe(401);
    expect(r.headers['Set-Cookie']).toBe('nms_session=; Max-Age=0');
  });

  it('attaches every user attribute, including the two that needed casts', async () => {
    // createLucia's second generic names getUserAttributes' OUTPUT, and it
    // used to name the snake_case DATABASE row instead -- which is why
    // createdAt and lastLoginAt were read through `(user as any)`. The value
    // was always right; the type was wrong. Reading them here keeps the
    // generic honest: name the row type again and this stops compiling.
    const r = res();
    const next = jest.fn();
    const q = req();
    await createAuthMiddleware(lucia(), logger as never)(q, r, next);

    expect(next).toHaveBeenCalled();
    expect(r.statusCode).toBeNull();
    expect(q.user).toEqual({ id: 'u1', ...attributes });
    expect(q.user?.createdAt).toBeInstanceOf(Date);
  });

  it('re-issues the cookie for a freshly extended session', async () => {
    const r = res();
    await createAuthMiddleware(lucia({
      validateSession: () => Promise.resolve({
        session: { id: 'sess-1', userId: 'u1', expiresAt: new Date(), fresh: true },
        user: { id: 'u1', ...attributes },
      }),
    }), logger as never)(req(), r, jest.fn());
    expect(r.headers['Set-Cookie']).toBe('nms_session=sess-1');
  });
});

describe('requireAdmin', () => {
  it.each([
    ['viewer', 403],
    ['admin', null],
  ])('role %s', (role, expected) => {
    const r = res();
    const next = jest.fn();
    requireAdmin({ user: { role } } as Request, r, next);
    expect(r.statusCode).toBe(expected);
    expect(next).toHaveBeenCalledTimes(expected === null ? 1 : 0);
  });

  it('403s an unauthenticated request rather than reading role off undefined', () => {
    const r = res();
    const next = jest.fn();
    requireAdmin({} as Request, r, next);
    expect(r.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
