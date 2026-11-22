import { Router } from 'express';
import { z } from 'zod';
import type { HighAvailabilityUseCase } from '../../application/use-cases/high-availability';
import type { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

export function createHighAvailabilityRouter(ha: HighAvailabilityUseCase, audit: IAuditLogger): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get('/overview', async (_req, res) => {
    try { res.set('Cache-Control','no-store').json(await ha.overview()); }
    catch (e) { res.status(503).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  router.post('/nodes', async (req, res) => {
    try { const node = ha.saveNode(req.body); await audit.log({ action:'ha_node_save', user:req.user!.username, target:node.id, success:true }); res.json(node); }
    catch(e) { res.status(400).json({error:e instanceof Error ? e.message : String(e)}); }
  });
  router.delete('/nodes/:id', async (req, res) => {
    try { ha.removeNode(req.params.id); await audit.log({action:'ha_node_remove',user:req.user!.username,target:req.params.id,success:true}); res.json({success:true}); }
    catch(e) { res.status(400).json({error:e instanceof Error ? e.message : String(e)}); }
  });
  router.post('/relocations', async (req, res) => {
    try {
      const input = z.object({ imsi:z.string().regex(/^\d{5,15}$/),source:z.string().max(64),target:z.string().max(64) }).strict().parse(req.body);
      const job = await ha.rebalance(input.imsi,input.source,input.target);
      await audit.log({action:'ha_ue_rebalance',user:req.user!.username,target:input.imsi,success:job.status==='requested',details:`${input.source} -> ${input.target}; ${job.id}; ${job.status}`});
      res.status(202).json(job);
    } catch(e) { const error = e instanceof Error ? e.message : String(e); await audit.log({action:'ha_ue_rebalance',user:req.user!.username,success:false,details:error}); res.status(409).json({error}); }
  });
  return router;
}
