import { Router, type Request, type Response } from 'express';
import type { UserManagementUseCase } from '../../application/use-cases/user-management';
import {
  UserNotFoundError,
  DuplicateUsernameError,
  CannotDeleteSelfError,
  CannotDeleteLastUserError,
  WeakPasswordError,
} from '../../application/use-cases/user-management';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────
// Users Controller
// All routes are already protected by authMiddleware in index.ts
//
// GET    /api/users              → list all users
// POST   /api/users              → create user
// PUT    /api/users/:id/password → change password
// DELETE /api/users/:id          → delete user
// ─────────────────────────────────────────────────────────────

export function createUsersRouter(
  userManagementUseCase: UserManagementUseCase,
  logger: Logger,
): Router {
  const router = Router();

  // ── GET /api/users ──
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const users = await userManagementUseCase.listUsers();
      res.json({ success: true, data: { users } });
    } catch (err) {
      logger.error({ err }, 'Users: list error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/users ──
  router.post('/', async (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Username and password are required' });
      return;
    }

    try {
      const user = await userManagementUseCase.createUser(username, password);
      res.status(201).json({ success: true, data: { user } });
    } catch (err) {
      if (err instanceof DuplicateUsernameError) {
        res.status(409).json({ success: false, error: err.message });
        return;
      }
      if (err instanceof WeakPasswordError || err instanceof Error && err.message.startsWith('Username')) {
        res.status(400).json({ success: false, error: (err as Error).message });
        return;
      }
      logger.error({ err }, 'Users: create error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── PUT /api/users/:id/password ──
  router.put('/:id/password', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Password is required' });
      return;
    }

    try {
      await userManagementUseCase.changePassword(id, password);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        res.status(404).json({ success: false, error: err.message });
        return;
      }
      if (err instanceof WeakPasswordError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      logger.error({ err }, 'Users: change password error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── DELETE /api/users/:id ──
  router.delete('/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestingUserId = req.user?.id;

    if (!requestingUserId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    try {
      await userManagementUseCase.deleteUser(id, requestingUserId);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof CannotDeleteSelfError || err instanceof CannotDeleteLastUserError) {
        res.status(400).json({ success: false, error: (err as Error).message });
        return;
      }
      if (err instanceof UserNotFoundError) {
        res.status(404).json({ success: false, error: err.message });
        return;
      }
      logger.error({ err }, 'Users: delete error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}
