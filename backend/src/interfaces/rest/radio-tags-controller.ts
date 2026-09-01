import { Router, Request, Response } from 'express';
import pino from 'pino';
import { SqliteRadioTagRepository } from '../../infrastructure/auth/sqlite-radio-tag-repository';
import { requireAdmin } from './middleware/auth-middleware';

export const createRadioTagsRouter = (
  radioTagRepo: SqliteRadioTagRepository,
  logger: pino.Logger,
): Router => {
  const router = Router();

  // GET / — nicknames only, open to all authenticated users (unchanged shape
  // for existing consumers — BaicellsAcsTab.tsx, FemtoConfigTab.tsx, etc.)
  router.get('/', (_req: Request, res: Response) => {
    try {
      const tags = radioTagRepo.getAll();
      res.json(tags);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to get radio tags');
      res.status(500).json({ error: 'Failed to get radio tags' });
    }
  });

  // GET /full — nickname + LTE band together, for the RAN page's band
  // tagging/filter UI.
  router.get('/full', (_req: Request, res: Response) => {
    try {
      const tags = radioTagRepo.getAllFull();
      res.json(tags);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to get full radio tags');
      res.status(500).json({ error: 'Failed to get radio tags' });
    }
  });

  // PUT /:ip — partial update, admin only. Body may include `nickname`
  // and/or `band` — each key present is upserted (empty string clears just
  // that field) independently of the other, so setting one never clobbers
  // the other.
  router.put('/:ip', requireAdmin, (req: Request, res: Response) => {
    try {
      const ip = decodeURIComponent(req.params.ip);
      const { nickname, band } = req.body as { nickname?: string; band?: string | null };

      if (nickname === undefined && band === undefined) {
        res.status(400).json({ error: 'At least one of nickname or band is required' });
        return;
      }

      if (nickname !== undefined) {
        if (nickname.trim().length > 64) {
          res.status(400).json({ error: 'Nickname must be 64 characters or fewer' });
          return;
        }
        radioTagRepo.upsertNickname(ip, nickname);
      }
      if (band !== undefined) {
        if (band && band.trim().length > 32) {
          res.status(400).json({ error: 'Band must be 32 characters or fewer' });
          return;
        }
        radioTagRepo.upsertBand(ip, band);
      }

      const full = radioTagRepo.getAllFull()[ip] ?? { nickname: '', band: null };
      logger.info({ ip, ...full }, 'Radio tag updated');
      res.json({ success: true, ip, ...full });
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
