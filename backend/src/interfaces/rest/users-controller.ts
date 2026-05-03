import { Router, type Request, type Response } from 'express';
import type { UserManagementUseCase } from '../../application/use-cases/user-management';
import {
  UserNotFoundError,
  DuplicateUsernameError,
  CannotDeleteSelfError,
  CannotDeleteLastUserError,
  WeakPasswordError,
  InvalidRoleError,
} from '../../application/use-cases/user-management';
import { requireAdmin } from './middleware/auth-middleware';
import type { Logger } from 'pino';

export function createUsersRouter(
  userManagementUseCase: UserManagementUseCase,
  logger: Logger,
): Router {
  const router = Router();

  // GET /api/users — list all users (admin + viewer can see this)
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const users = await userManagementUseCase.listUsers();
      res.json({ success: true, data: { users } });
    } catch (err) {
      logger.error({ err }, 'Users: list error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // POST /api/users — create user (admin only)
  router.post('/', requireAdmin, async (req: Request, res: Response) => {
    const { username, password, role } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Username and password are required' });
      return;
    }

    try {
      const user = await userManagementUseCase.createUser(username, password, role ?? 'admin');
      res.status(201).json({ success: true, data: { user } });
    } catch (err) {
      if (err instanceof DuplicateUsernameError) {
        res.status(409).json({ success: false, error: err.message }); return;
      }
      if (err instanceof WeakPasswordError || err instanceof InvalidRoleError ||
          err instanceof Error && err.message.startsWith('Username')) {
        res.status(400).json({ success: false, error: (err as Error).message }); return;
      }
      logger.error({ err }, 'Users: create error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // PATCH /api/users/:id/role — change role (admin only)
  router.patch('/:id/role', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { role } = req.body;
    const requestingUserId = req.user?.id;

    if (!role) {
      res.status(400).json({ success: false, error: 'Role is required' }); return;
    }
    if (!requestingUserId) {
      res.status(401).json({ success: false, error: 'Unauthorized' }); return;
    }

    try {
      await userManagementUseCase.updateRole(id, requestingUserId, role);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        res.status(404).json({ success: false, error: err.message }); return;
      }
      if (err instanceof InvalidRoleError || err instanceof Error) {
        res.status(400).json({ success: false, error: (err as Error).message }); return;
      }
      logger.error({ err }, 'Users: role update error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // PUT /api/users/:id/password — change password (admin only)
  router.put('/:id/password', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      res.status(400).json({ success: false, error: 'Password is required' }); return;
    }

    try {
      await userManagementUseCase.changePassword(id, password);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        res.status(404).json({ success: false, error: err.message }); return;
      }
      if (err instanceof WeakPasswordError) {
        res.status(400).json({ success: false, error: err.message }); return;
      }
      logger.error({ err }, 'Users: change password error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // DELETE /api/users/:id — delete user (admin only)
  router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestingUserId = req.user?.id;

    if (!requestingUserId) {
      res.status(401).json({ success: false, error: 'Unauthorized' }); return;
    }

    try {
      await userManagementUseCase.deleteUser(id, requestingUserId);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof CannotDeleteSelfError || err instanceof CannotDeleteLastUserError) {
        res.status(400).json({ success: false, error: (err as Error).message }); return;
      }
      if (err instanceof UserNotFoundError) {
        res.status(404).json({ success: false, error: err.message }); return;
      }
      logger.error({ err }, 'Users: delete error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}
