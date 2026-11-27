import type { Request, Response, NextFunction } from 'express';
import type pino from 'pino';
import type { AppLucia } from '../../../infrastructure/auth/sqlite-auth-repository';

// ─────────────────────────────────────────────────────────────
// Auth Middleware
// Validates the Lucia session cookie on every protected request.
// Attaches req.user and req.session if valid.
// ─────────────────────────────────────────────────────────────

// Extend Express Request type to carry auth data.
//
// The disable is unavoidable rather than a preference: `declare global {
// namespace Express { interface Request } }` is the ONLY way express 4's
// Request type can be augmented, since @types/express declares it inside that
// namespace. Scoped to this one declaration, not the file -- a namespace
// anywhere else in this codebase would be worth questioning.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        role: string;
        createdAt: Date;
        lastLoginAt: Date | null;
      };
      session?: {
        id: string;
        userId: string;
        expiresAt: Date;
        fresh: boolean;
      };
    }
  }
}

export function createAuthMiddleware(lucia: AppLucia, logger: pino.Logger) {
  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const sessionId = lucia.readSessionCookie(req.headers.cookie ?? '');

      if (!sessionId) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const { session, user } = await lucia.validateSession(sessionId);

      if (!session) {
        res.setHeader('Set-Cookie', lucia.createBlankSessionCookie().serialize());
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      if (session.fresh) {
        res.setHeader('Set-Cookie', lucia.createSessionCookie(session.id).serialize());
      }

      req.session = session;
      // No assertions: createLucia's generic now names what getUserAttributes
      // really returns, so these are checked.
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };

      next();
    } catch (err) {
      // Load-bearing, not tidiness. express is pinned at 4.x here, and
      // express 4 does NOT forward a rejected promise from an async
      // middleware to its error handler -- that arrived in express 5. The
      // rejection escapes as an unhandledRejection instead, and this project
      // installs no unhandledRejection handler anywhere, so Node's default
      // terminates the process.
      //
      // The reachable failure is ordinary: validateSession goes through
      // better-sqlite3, which is SYNCHRONOUS and throws -- SQLITE_BUSY on a
      // locked database, a disk error, a corrupt page. Any one of those, on
      // any authenticated API request, would have taken the whole NMS backend
      // down rather than failing that one request. Answering 500 keeps the
      // blast radius at the request that hit it.
      logger.error({ err: String(err), path: req.path }, 'Session validation failed');
      res.status(500).json({ success: false, error: 'Session validation failed' });
    }
  };
}

// Middleware that blocks viewer role — admin only
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Forbidden: admin role required' });
    return;
  }
  next();
}
