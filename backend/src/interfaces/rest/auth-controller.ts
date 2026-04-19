import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { AuthLoginUseCase } from '../../application/use-cases/auth-login';
import { InvalidCredentialsError } from '../../application/use-cases/auth-login';
import type { AuthLogoutUseCase } from '../../application/use-cases/auth-logout';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────
// Auth Controller
// POST /api/auth/login
// POST /api/auth/logout
// GET  /api/auth/me
// ─────────────────────────────────────────────────────────────

// Rate limiter: max 10 login attempts per 15 minutes per IP
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts, please try again later' },
  skipSuccessfulRequests: true, // Only count failed attempts
});

export function createAuthRouter(
  loginUseCase: AuthLoginUseCase,
  logoutUseCase: AuthLogoutUseCase,
  logger: Logger,
): Router {
  const router = Router();

  // ── POST /api/auth/login ──
  router.post('/login', loginRateLimiter, async (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Username and password are required' });
      return;
    }

    try {
      const { sessionCookie, user } = await loginUseCase.execute(username, password);

      // Set HttpOnly session cookie
      res.setHeader('Set-Cookie', sessionCookie);
      res.json({ success: true, data: { user } });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        // 401 with generic message — never reveal which field was wrong
        res.status(401).json({ success: false, error: 'Invalid username or password' });
        return;
      }
      logger.error({ err }, 'Auth: unexpected login error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/auth/logout ── (requires valid session — enforced by authMiddleware upstream)
  router.post('/logout', async (req: Request, res: Response) => {
    if (!req.session) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    try {
      const blankCookie = await logoutUseCase.execute(req.session.id);
      res.setHeader('Set-Cookie', blankCookie);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Auth: logout error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/auth/me ── (requires valid session)
  router.get('/me', (req: Request, res: Response) => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    res.json({ success: true, data: { user: req.user } });
  });

  return router;
}
