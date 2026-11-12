import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { CellBroadcastUseCase, sendSchema, uniqueTais } from '../cell-broadcast';
import type { IHostExecutor } from '../../../domain/interfaces/host-executor';
import type { IConfigRepository } from '../../../domain/interfaces/config-repository';
import express from 'express';
import { createCellBroadcastRouters } from '../../../interfaces/rest/cell-broadcast-controller';
import type { IAuditLogger } from '../../../domain/interfaces/audit-logger';
import type { AddressInfo } from 'net';

describe('Cell Broadcast targeting and scoped API',()=>{
  let db:Database.Database,cbc:CellBroadcastUseCase;
  let sent:Array<{method:string;endpoint:string;body?:Record<string,unknown>}>;
  let deliveryFails:boolean;
  const a={plmn:'00101',tac:1},b={plmn:'302190',tac:24};
  beforeEach(()=>{
    db=new Database(':memory:',{nativeBinding:process.env.HA_SQLITE_TEST_BINDING});sent=[];deliveryFails=false;
    const host={executeCommand:jest.fn(async(command:string,args:string[])=>{
      if(command==='curl')return {exitCode:0,stderr:'',stdout:JSON.stringify({items:[{enb_id:2,name:'Lab radio',s1:{setup_success:true},supported_ta_list:[{plmn:'00101',tac:'0001'},{plmn:'302190',tac:'0018'}]}],pager:{page:0}})};
      if(args[1].includes('MainPID'))return {exitCode:0,stderr:'',stdout:''};
      const method=args[2],endpoint=args[3];
      if(endpoint==='nms-capabilities')return {exitCode:0,stderr:'',stdout:JSON.stringify({code:200,body:JSON.stringify({protocol:1,scope_tais:true})})};
      sent.push({method,endpoint,body:args[4]?JSON.parse(Buffer.from(args[4],'base64').toString()):undefined});
      if(deliveryFails)throw new Error('Connection lost');
      return {exitCode:0,stderr:'',stdout:JSON.stringify({code:201,body:''})};
    })} as unknown as IHostExecutor;
    const configs={loadMme:async()=>({rawYaml:{mme:{metrics:{server:[{address:'127.0.0.2',port:9090}]},sbcap:{server:[{address:'127.0.0.2',port:29168}]}}}})} as unknown as IConfigRepository;
    cbc=new CellBroadcastUseCase(db,host,configs);
  });
  afterEach(()=>db.close());
  function message(extra:Record<string,unknown>={}) {return {requestId:randomUUID(),text:'Maintenance test',areas:[a],zoneIds:[],messageId:4380,serialNumber:1,confirm:true,...extra};}
  it('keeps two- and three-digit MNC identities distinct',()=>{
    expect(uniqueTais([a,a,{plmn:'001001',tac:1}])).toHaveLength(2);
  });
  it('resolves multiple named zones and direct TAIs without duplicate targets',async()=>{
    const one=cbc.saveZone({name:'North',areas:[a,b]}),two=cbc.saveZone({name:'South',areas:[b]});
    await cbc.send(message({zoneIds:[one.id,two.id]}),{name:'admin'});
    expect(sent).toHaveLength(1);
    expect(sent[0].body?.scope).toEqual({scope_tais:[a,b]});
    expect(sent[0].body?.scope).not.toHaveProperty('scope_plmn');
    expect((cbc.messages()[0] as {status:string}).status).toBe('accepted');
  });
  it('rejects missing, unknown and oversized scopes without dispatch',async()=>{
    for(const input of [message({areas:[]}),message({zoneIds:[randomUUID()]}),message({areas:Array.from({length:17},(_,i)=>({plmn:'00101',tac:i}))})]) {
      await expect(cbc.send(input,{name:'admin'})).rejects.toThrow();
    }
    expect(sent).toHaveLength(0);
  });
  it('requires an explicit confirmation and bounded counts',()=>{
    expect(sendSchema.safeParse(message({confirm:false})).success).toBe(false);
    expect(sendSchema.safeParse(message({broadcasts:0})).success).toBe(false);
    expect(sendSchema.safeParse(message({text:'😀'})).success).toBe(false);
  });
  it('hashes API secrets and enforces zone scope for direct and named targets',async()=>{
    const north=cbc.saveZone({name:'North',areas:[a]}),south=cbc.saveZone({name:'South',areas:[b]});
    const key=cbc.createToken({name:'External system',zoneIds:[north.id]});
    const caller=cbc.authenticate(key.secret)!;expect(caller).not.toBeNull();
    expect(JSON.stringify(db.prepare('SELECT * FROM cbc_tokens').all())).not.toContain(key.secret);
    await expect(cbc.send(message({areas:[b]}),caller)).rejects.toThrow('not authorized');
    await expect(cbc.send(message({zoneIds:[south.id]}),caller)).rejects.toThrow('not authorized');
    await cbc.send(message({areas:[],zoneIds:[north.id]}),caller);expect(sent).toHaveLength(1);
    cbc.revokeToken(key.id);expect(cbc.authenticate(key.secret)).toBeNull();
  });
  it('does not broaden a zone after its label is removed',()=>{
    const zone=cbc.saveZone({name:'North',areas:[a]});const token=cbc.createToken({name:'External',zoneIds:[zone.id]});
    cbc.removeZone(zone.id);
    expect(()=>cbc.resolveAreas(sendSchema.parse(message()),cbc.authenticate(token.secret)!)).toThrow('not authorized');
  });
  it('does not resend when the same request ID is retried after uncertain delivery',async()=>{
    const input=message();deliveryFails=true;
    const result=await cbc.send(input,{name:'admin'}) as {status:string};expect(result.status).toBe('unknown');
    await cbc.send(input,{name:'admin'});expect(sent).toHaveLength(1);
    await expect(cbc.send({...input,text:'Changed'},{name:'admin'})).rejects.toThrow('Request ID');
  });
  it('stops by the original CBC message identity without re-resolving edited zones',async()=>{
    const input=message();await cbc.send(input,{name:'admin'});await cbc.stop(input.requestId,{name:'admin'});
    expect(sent[1]).toMatchObject({method:'DELETE',endpoint:'message/4380'});
  });
  it('does not allow a different integration to stop another key’s message',async()=>{
    const input=message();await cbc.send(input,{name:'admin'});
    await expect(cbc.stop(input.requestId,{name:'api:other',tokenId:randomUUID()})).rejects.toThrow('not found');
  });
  it('rejects a selected TAI without a connected radio',async()=>{
    await expect(cbc.send(message({areas:[{plmn:'00101',tac:999}]}),{name:'admin'})).rejects.toThrow('no connected eNodeB');
    expect(sent).toHaveLength(0);
  });
  it('protects admin reads and authenticates external requests only through scoped Bearer keys',async()=>{
    const zone=cbc.saveZone({name:'Authorized',areas:[a]});
    cbc.saveZone({name:'Other',areas:[b]});
    const key=cbc.createToken({name:'Integration',zoneIds:[zone.id]});
    const audit={log:jest.fn(async()=>{})} as unknown as IAuditLogger;
    const routers=createCellBroadcastRouters(cbc,audit),app=express();app.use(express.json());
    app.use('/admin',routers.admin);app.use('/v1',routers.external);
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
    const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    try {
      expect((await fetch(origin+'/admin/overview')).status).toBe(403);
      expect((await fetch(origin+'/v1/zones')).status).toBe(401);
      expect((await fetch(origin+'/v1/zones?api_key='+key.secret)).status).toBe(401);
      const response=await fetch(origin+'/v1/zones',{headers:{Authorization:'Bearer '+key.secret}});
      expect(response.status).toBe(200);expect(await response.json()).toEqual({zones:[zone]});
      cbc.revokeToken(key.id);
      expect((await fetch(origin+'/v1/zones',{headers:{Authorization:'Bearer '+key.secret}})).status).toBe(401);
    }finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('prepares and runs the installer through host execution, not container filesystem helpers',async()=>{
    const executeCommand=jest.fn(async()=>({exitCode:0,stdout:'CBC ready',stderr:''}));
    const installer=new CellBroadcastUseCase(db,{executeCommand} as unknown as IHostExecutor,{} as IConfigRepository);
    const job=await installer.install();
    for(let i=0;i<100&&job.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,5));
    expect(job.status).toBe('complete');expect(executeCommand).toHaveBeenCalledTimes(2);
    const calls=executeCommand.mock.calls as unknown as Array<[string,string[]]>;
    expect(calls[0][0]).toBe('python3');expect(calls[0][1][0]).toBe('-c');
    const bundle=JSON.parse(Buffer.from(calls[0][1][2],'base64').toString());
    expect(Object.keys(bundle).sort()).toEqual(['install-cbc.py','osmo-cbc-tai.patch']);
    expect(calls[1][1]).toEqual(['/var/lib/open5gs-nms/cbc-installer/install-cbc.py','--install']);
  });
});
