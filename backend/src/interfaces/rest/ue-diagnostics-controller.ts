import { Router } from 'express';
import type { UeDiagnosticsUseCase } from '../../application/use-cases/ue-diagnostics';
import type { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

export function createUeDiagnosticsRouter(diagnostics:UeDiagnosticsUseCase,audit:IAuditLogger):Router {
  const router=Router();
  router.use(requireAdmin);
  router.get('/overview',async(_req,res)=>{
    try{res.json(await diagnostics.overview());}
    catch(error){res.status(500).json({error:error instanceof Error?error.message:String(error)});}
  });
  router.post('/start',async(req,res)=>{
    const user=req.user?.username ?? 'unknown';
    try{
      const capture=await diagnostics.start(req.body ?? {});
      await audit.log({action:'pcap_start',user,target:capture.id,success:true,details:capture.scopeDescription});
      res.json({capture});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      await audit.log({action:'pcap_start',user,success:false,details:message});
      res.status(400).json({error:message});
    }
  });
  router.post('/captures/:id/stop',async(req,res)=>{
    try{
      const capture=await diagnostics.stop(req.params.id);
      await audit.log({action:'pcap_stop',user:req.user?.username ?? 'unknown',target:capture.id,success:true});
      res.json({capture});
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:String(error)});}
  });
  router.get('/captures/:id/live',async(req,res)=>{
    try{res.json(await diagnostics.snapshot(req.params.id,String(req.query.filter ?? '')));}
    catch(error){res.status(400).json({error:error instanceof Error?error.message:String(error)});}
  });
  return router;
}
