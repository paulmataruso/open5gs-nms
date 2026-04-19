import type { Request, Response, NextFunction } from 'express';
import type { AppLucia } from '../../../infrastructure/auth/sqlite-auth-repository';

// ─────────────────────────────────────────────────────────────
// Auth Middleware
// Validates the Lucia session cookie on every protected request.
// Attaches req.user and req.session if valid.
// ─────────────────────────────────────────────────────────────

// Extend Express Request type to carry auth data
declare global {
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

export function createAuthMiddleware(lucia: AppLucia) {
  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Read session cookie
    const sessionId = lucia.readSessionCookie(req.headers.cookie ?? '');

    if (!sessionId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // Validate session
    const { session, user } = await lucia.validateSession(sessionId);

    if (!session) {
      // Session expired or invalid — clear cookie
      res.setHeader('Set-Cookie', lucia.createBlankSessionCookie().serialize());
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // Lucia rolling window: if session was refreshed, send updated cookie
    if (session.fresh) {
      res.setHeader('Set-Cookie', lucia.createSessionCookie(session.id).serialize());
    }

    // Attach to request for use in controllers
    req.session = session;
    req.user = {
      id: user.id,
      username: (user as any).username,
      role: (user as any).role,
      createdAt: (user as any).createdAt,
      lastLoginAt: (user as any).lastLoginAt,
    };

    next();
  };
}
