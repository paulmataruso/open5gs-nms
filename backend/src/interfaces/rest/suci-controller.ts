import { Router, Request, Response } from 'express';
import pino from 'pino';
import { SuciManagementUseCase } from '../../application/use-cases/suci-management';

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
  router.post('/keys', async (req: Request, res: Response) => {
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
      logger.error({ error }, 'Failed to generate SUCI key');
      res.status(500).json({ error: String(error) });
    }
  });

  // PUT /api/suci/keys/:id - Regenerate existing SUCI key
  router.put('/keys/:id', async (req: Request, res: Response) => {
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
      logger.error({ error }, 'Failed to regenerate SUCI key');
      res.status(500).json({ error: String(error) });
    }
  });

  // DELETE /api/suci/keys/:id - Delete SUCI key
  router.delete('/keys/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const deleteFile = req.query.deleteFile === 'true';

      await suciUseCase.deleteKey(id, deleteFile);
      res.json({ success: true, id, deletedFile: deleteFile });
    } catch (error) {
      logger.error({ error }, 'Failed to delete SUCI key');
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}
