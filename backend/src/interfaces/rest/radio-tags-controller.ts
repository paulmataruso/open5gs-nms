import { Router, Request, Response } from 'express';
import pino from 'pino';
import { SqliteRadioTagRepository } from '../../infrastructure/auth/sqlite-radio-tag-repository';
import { requireAdmin } from './middleware/auth-middleware';

export const createRadioTagsRouter = (
  radioTagRepo: SqliteRadioTagRepository,
  logger: pino.Logger,
): Router => {
  const router = Router();

  // GET / — all tags, open to all authenticated users
  router.get('/', (_req: Request, res: Response) => {
    try {
      const tags = radioTagRepo.getAll();
      res.json(tags);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to get radio tags');
      res.status(500).json({ error: 'Failed to get radio tags' });
    }
  });

  // PUT /:ip — upsert a tag, admin only
  router.put('/:ip', requireAdmin, (req: Request, res: Response) => {
    try {
      const ip = decodeURIComponent(req.params.ip);
      const { nickname } = req.body as { nickname: string };

      if (!nickname || !nickname.trim()) {
        // Empty nickname = delete the tag
        radioTagRepo.delete(ip);
        res.json({ success: true, deleted: true });
        return;
      }

      if (nickname.trim().length > 64) {
        res.status(400).json({ error: 'Nickname must be 64 characters or fewer' });
        return;
      }

      radioTagRepo.upsert(ip, nickname.trim());
      logger.info({ ip, nickname: nickname.trim() }, 'Radio tag updated');
      res.json({ success: true, ip, nickname: nickname.trim() });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to upsert radio tag');
      res.status(500).json({ error: 'Failed to save radio tag' });
    }
  });

  // DELETE /:ip — remove a tag, admin only
  router.delete('/:ip', requireAdmin, (req: Request, res: Response) => {
    try {
      const ip = decodeURIComponent(req.params.ip);
      radioTagRepo.delete(ip);
      logger.info({ ip }, 'Radio tag deleted');
      res.json({ success: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to delete radio tag');
      res.status(500).json({ error: 'Failed to delete radio tag' });
    }
  });

  return router;
};
