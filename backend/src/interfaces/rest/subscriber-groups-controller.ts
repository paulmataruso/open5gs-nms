import { Router, Request, Response } from 'express';
import { Db, ObjectId } from 'mongodb';
import pino from 'pino';

export function createSubscriberGroupsRouter(db: Db, logger: pino.Logger): Router {
  const router = Router();
  const col = () => db.collection('nms_subscriber_groups');

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const groups = await col().find({}).sort({ createdAt: 1 }).toArray();
      res.json({ success: true, data: groups });
    } catch (err) {
      logger.error({ err }, 'Failed to list subscriber groups');
      res.status(500).json({ error: 'Failed to list groups' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    const { name, imsis, color } = req.body;
    if (!name || typeof name !== 'string' || !Array.isArray(imsis)) {
      return res.status(400).json({ error: 'name (string) and imsis (array) required' });
    }
    try {
      const doc = { name: name.trim(), imsis, color: color || null, createdAt: Date.now() };
      const result = await col().insertOne(doc);
      res.json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (err) {
      logger.error({ err }, 'Failed to create subscriber group');
      res.status(500).json({ error: 'Failed to create group' });
    }
  });

  router.put('/:id', async (req: Request, res: Response) => {
    const { name, imsis, color } = req.body;
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = String(name).trim();
    if (imsis !== undefined) update.imsis = imsis;
    if (color !== undefined) update.color = color;
    try {
      await col().updateOne({ _id: id }, { $set: update });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Failed to update subscriber group');
      res.status(500).json({ error: 'Failed to update group' });
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }
    try {
      await col().deleteOne({ _id: id });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete subscriber group');
      res.status(500).json({ error: 'Failed to delete group' });
    }
  });

  return router;
}
