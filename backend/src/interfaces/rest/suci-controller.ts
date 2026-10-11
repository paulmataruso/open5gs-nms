import { Router, Request, Response } from 'express';
import pino from 'pino';
import { SuciManagementUseCase } from '../../application/use-cases/suci-management';
import { requireAdmin } from './middleware/auth-middleware';

export function createSuciRouter(
  suciUseCase: SuciManagementUseCase,
  logger: pino.Logger,
): Router {
  const router = Router();

  // GET /api/suci/keys - List all SUCI keys
  router.get('/keys', async (req: Request, res: Response) => {
    try {
      const result = await suciUseCase.listKeys();
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'Failed to list SUCI keys');
      res.status(500).json({ error: 'Failed to list SUCI keys' });
    }
  });

  // GET /api/suci/next-id - Get next available PKI ID
  router.get('/next-id', async (req: Request, res: Response) => {
    try {
      const nextId = await suciUseCase.getNextAvailableId();
      res.json({ nextId });
    } catch (error) {
      logger.error({ error }, 'Failed to get next available ID');
      res.status(500).json({ error: 'Failed to get next available ID' });
    }
  });

  // POST /api/suci/keys - Generate new SUCI key
  //
  // This and the 3 other mutating routes below (PUT/PATCH/DELETE) all map a thrown
  // use-case error to 400 + error.message, not 500 + String(error) — real, confirmed-live
  // 2026-09-30 finding (a full-session live-API verification pass): the old 500 + String()
  // form produced doubled, ugly text (e.g. "Error: Key ID 2 is already in use") and the
  // wrong status code for what's genuinely a validation/business-logic rejection, not a
  // server fault. Matches the convention every sibling mutating route in this codebase
  // already uses (see apn-profile-controller.ts). GET routes above keep their existing
  // generic-500 handling — a read failure is a more plausible genuine server error.
  router.post('/keys', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { id, scheme } = req.body;
      
      if (!id || !scheme) {
        return res.status(400).json({ error: 'Missing required fields: id, scheme' });
      }

      if (scheme !== 1 && scheme !== 2) {
        return res.status(400).json({ error: 'Invalid scheme. Must be 1 (Profile A) or 2 (Profile B)' });
      }

      const key = await suciUseCase.generateKey({ id: Number(id), scheme });
      res.json(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message }, 'Failed to generate SUCI key');
      res.status(400).json({ error: message });
    }
  });

  // PUT /api/suci/keys/:id - Regenerate existing SUCI key
  router.put('/keys/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { scheme } = req.body;

      if (!scheme) {
        return res.status(400).json({ error: 'Missing required field: scheme' });
      }

      if (scheme !== 1 && scheme !== 2) {
        return res.status(400).json({ error: 'Invalid scheme. Must be 1 (Profile A) or 2 (Profile B)' });
      }

      // Delete the old key (with file)
      await suciUseCase.deleteKey(id, true);
      
      // Generate new key with same ID
      const key = await suciUseCase.generateKey({ id, scheme });
      res.json(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message }, 'Failed to regenerate SUCI key');
      res.status(400).json({ error: message });
    }
  });

  // PATCH /api/suci/keys/:id/rename - Rename PKI ID without touching the key
  router.patch('/keys/:id/rename', requireAdmin, async (req: Request, res: Response) => {
    try {
      const currentId = Number(req.params.id);
      const { newId } = req.body;

      if (newId === undefined || newId === null) {
        return res.status(400).json({ error: 'Missing required field: newId' });
      }

      const newIdNum = Number(newId);
      if (!Number.isInteger(newIdNum) || newIdNum < 0 || newIdNum > 255) {
        return res.status(400).json({ error: 'newId must be an integer between 0 and 255' });
      }

      const key = await suciUseCase.renameKey(currentId, newIdNum);
      res.json(key);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message }, 'Failed to rename SUCI key');
      res.status(400).json({ error: message });
    }
  });

  // DELETE /api/suci/keys/:id - Delete SUCI key
  router.delete('/keys/:id', requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const deleteFile = req.query.deleteFile === 'true';

      await suciUseCase.deleteKey(id, deleteFile);
      res.json({ success: true, id, deletedFile: deleteFile });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message }, 'Failed to delete SUCI key');
      res.status(400).json({ error: message });
    }
  });

  return router;
}
