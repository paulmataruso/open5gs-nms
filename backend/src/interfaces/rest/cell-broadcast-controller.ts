import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { CellBroadcastUseCase, BroadcastCaller } from '../../application/use-cases/cell-broadcast';
import type { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const id = z.string().uuid();
const errorText = (e:unknown) => e instanceof Error ? e.message : String(e);

export function createCellBroadcastRouters(cbc:CellBroadcastUseCase,audit:IAuditLogger) {
  const admin=Router(), external=Router();
  admin.use(requireAdmin);
  admin.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const actor=(req:Request):BroadcastCaller=>({name:req.user!.username});
  const log=async(req:Request,caller:BroadcastCaller,target:string,success:boolean,details:string)=>audit.log({action:'cbc_operation',user:caller.name,target,success,details});
  admin.get('/overview',async(_req,res)=>{try {res.json(await cbc.status());}catch(e){res.status(503).json({error:errorText(e)});}});
  admin.post('/zones',async(req,res)=>{try {const zone=cbc.saveZone(req.body);await log(req,actor(req),zone.id,true,'Create zone');res.json(zone);}catch(e){res.status(400).json({error:errorText(e)});}});
  admin.put('/zones/:id',async(req,res)=>{try {const zone=cbc.saveZone(req.body,id.parse(req.params.id));await log(req,actor(req),zone.id,true,'Update zone');res.json(zone);}catch(e){res.status(400).json({error:errorText(e)});}});
  admin.delete('/zones/:id',async(req,res)=>{try {cbc.removeZone(id.parse(req.params.id));await log(req,actor(req),req.params.id,true,'Delete zone label');res.json({success:true});}catch(e){res.status(400).json({error:errorText(e)});}});
  admin.post('/keys',async(req,res)=>{try {const result=cbc.createToken(req.body);await log(req,actor(req),result.id,true,'Create scoped API key');res.json(result);}catch(e){res.status(400).json({error:errorText(e)});}});
  admin.delete('/keys/:id',async(req,res)=>{try {cbc.revokeToken(id.parse(req.params.id));await log(req,actor(req),req.params.id,true,'Revoke API key');res.json({success:true});}catch(e){res.status(400).json({error:errorText(e)});}});
  admin.post('/install',async(req,res)=>{try {z.object({confirm:z.literal(true)}).strict().parse(req.body);const job=await cbc.install();await log(req,actor(req),job.id,true,'Install CBC');res.status(202).json(job);}catch(e){res.status(400).json({error:errorText(e)});}});
  admin.post('/service/:action',async(req,res)=>{try {res.json(await cbc.service(req.params.action));await log(req,actor(req),'cbc-service',true,req.params.action);}catch(e){res.status(400).json({error:errorText(e)});}});
  const send=async(req:Request,res:Response,caller:BroadcastCaller)=>{
    try {const result=await cbc.send(req.body,caller);await log(req,caller,String(req.body.requestId),true,'Submit Cell Broadcast request');res.status(202).json(result);}
    catch(e){await log(req,caller,'cbc-message',false,'Submission refused or failed');res.status(409).json({error:errorText(e)});}
  };
  const stop=async(req:Request,res:Response,caller:BroadcastCaller)=>{
    try {const result=await cbc.stop(id.parse(req.params.id),caller);await log(req,caller,req.params.id,true,'Stop Cell Broadcast');res.json(result);}
    catch(e){res.status(409).json({error:errorText(e)});}
  };
  admin.post('/messages',(req,res)=>void send(req,res,actor(req)));
  admin.post('/messages/:id/stop',(req,res)=>void stop(req,res,actor(req)));
  // Mounted before session middleware; this router has its own scoped key authentication.
  external.use(rateLimit({windowMs:60000,max:20,standardHeaders:true,legacyHeaders:false}));
  external.use((req,res,next)=>{
    res.set('Cache-Control','no-store');const match=/^Bearer (cbc_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');
    const caller=match?cbc.authenticate(match[1]):null;
    if(!caller){res.status(401).json({error:'Valid Cell Broadcast API key required'});return;}
    res.locals.cbcCaller=caller;next();
  });
  external.get('/zones',(_req,res)=>{const caller=res.locals.cbcCaller as BroadcastCaller;res.json({zones:cbc.zones().filter(z=>caller.allowedZones?.includes(z.id))});});
  external.get('/messages',(_req,res)=>res.json({messages:cbc.messages(res.locals.cbcCaller as BroadcastCaller)}));
  external.post('/messages',(req,res)=>void send(req,res,res.locals.cbcCaller as BroadcastCaller));
  external.post('/messages/:id/stop',(req,res)=>void stop(req,res,res.locals.cbcCaller as BroadcastCaller));
  return {admin,external};
}
