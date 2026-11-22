import Database from 'better-sqlite3';
import { HighAvailabilityUseCase, haNodeSchema, operatorCommand, NativeMmeRejection, type HaNode } from '../high-availability';
import type { IHostExecutor } from '../../../domain/interfaces/host-executor';
import type { IConfigRepository } from '../../../domain/interfaces/config-repository';

const imsi = '001010000000101';
const radio = { enb_id: 71, name: 'Baicells West', plmn: '00101', s1: { setup_success: true, sctp: { peer: '[192.0.2.71]:36412' } }, supported_ta_list: [{tac:'0001',plmn:'00101'}], num_connected_ues:1 };
const ue = { supi:imsi, domain:'EPS', mm_state:'registered', cm_state:'connected', enb:{enb_id:71}, pdn:[{apn:'internet',ebi:5,qci:9,ipv4:'10.45.0.101',pgw:{ipv4:'192.0.2.30',teid:1234}}] };
const pdn = { supi:'imsi-'+imsi,pdu:[{apn:'internet',ipv4:'10.45.0.101',ebi:5}] };
describe('High Availability real core inventory and operations',()=>{
  let db: Database.Database;
  let ha: HighAvailabilityUseCase;
  let endpoints: Record<string,unknown[]>;
  let controlReply: Record<string,unknown> | Error;
  let sent: Record<string,unknown>[];
  let remote: HaNode;
  beforeEach(()=>{
    db=new Database(':memory:', { nativeBinding: process.env.HA_SQLITE_TEST_BINDING });
    db.exec('CREATE TABLE radio_tags(ip TEXT,nickname TEXT)');
    db.prepare('INSERT INTO radio_tags VALUES(?,?)').run('192.0.2.71','Mine West BBU');
    endpoints={
      'http://192.0.2.10:9090/enb-info':[radio], 'http://192.0.2.10:9090/ue-info':[ue],
      'http://192.0.2.20:9090/enb-info':[radio], 'http://192.0.2.20:9090/ue-info':[],
      'http://192.0.2.30:9090/pdu-info':[pdn],
    };
    controlReply={ok:true,status:'requested'};sent=[];
    const host={executeCommand:jest.fn(async(command:string,args:string[])=>{
      if(command==='curl'||(command==='ssh'&&args[args.length-1].startsWith("'curl'"))){
        const raw=command==='curl'?args[args.length-1]:/'(https?:\/\/[^']+)'$/.exec(args[args.length-1])![1];
        const url=new URL(raw);const key=url.origin+url.pathname;
        if(!(key in endpoints))return{exitCode:7,stdout:'',stderr:'unavailable'};
        return{exitCode:0,stderr:'',stdout:JSON.stringify({items:endpoints[key],pager:{page:0}})};
      }
      const encoded=command==='ssh'?/'([A-Za-z0-9+/=]+)'$/.exec(args[args.length-1])![1]:args[args.length-1];
      const request=JSON.parse(Buffer.from(encoded,'base64').toString());
      if(request.operation==='capabilities')return{exitCode:0,stderr:'',stdout:JSON.stringify({ok:true,protocol:1,rebalance:true,pdn_bindings:true,identity:{plmn:'00101',mme_gid:2,mme_code:command==='ssh'?2:1},relative_capacity:255})};
      if(request.operation==='peer-check')return{exitCode:0,stderr:'',stdout:'{"ok":true,"route":true}'};
      sent.push(request);
      if(controlReply instanceof Error)throw controlReply;
      return{exitCode:0,stderr:'',stdout:JSON.stringify({...controlReply,request_id:request.request_id})};
    })} as unknown as IHostExecutor;
    const configs={loadMme:async()=>({rawYaml:{mme:{mme_name:'MME West',metrics:{server:[{address:'192.0.2.10',port:9090}]}}}}),loadSmf:async()=>({rawYaml:{smf:{metrics:{server:[{address:'192.0.2.30',port:9090}]}}}})} as unknown as IConfigRepository;
    ha=new HighAvailabilityUseCase(db,host,configs);
    remote=ha.saveNode({name:'MME East',mmeUrl:'http://192.0.2.20:9090/',smfUrl:'http://192.0.2.30:9090/',sshHost:'192.0.2.20',sshUser:'root'});
  });
  afterEach(()=>db?.close());
  it('reads reported radio names, persisted nicknames and UE PDN bindings',async()=>{
    const result=await ha.overview(true),local=result.nodes[0];
    expect(local.node.name).toBe('MME West');expect(local.radios[0]).toMatchObject({id:71,name:'Mine West BBU',reportedName:'Baicells West',ip:'192.0.2.71',plmn:'00101'});
    expect(local.ues[0].sessions).toEqual([{apn:'internet',ip:'10.45.0.101'}]);
  });
  it('reports API failure as unavailable instead of inventing an empty healthy core',async()=>{
    delete endpoints['http://192.0.2.10:9090/enb-info'];
    const result=await ha.overview(true);expect(result.nodes[0].available).toBe(false);expect(result.nodes[0].error).toContain('unavailable');expect(result.nodes[0].radios).toEqual([]);
  });
  it('requires a completed S1 association with the same global eNodeB at the target',async()=>{
    endpoints['http://192.0.2.20:9090/enb-info']=[{...radio,plmn:'001001'}];
    await expect(ha.rebalance(imsi,'local',remote.id)).rejects.toThrow('same eNodeB');expect(sent).toHaveLength(0);
  });
  it('dispatches one native request but never reports request acceptance as completion',async()=>{
    const job=await ha.rebalance(imsi,'local',remote.id);expect(job.status).toBe('requested');
    expect(sent).toEqual([{operation:'rebalance',imsi,request_id:job.id}]);
    await expect(ha.rebalance(imsi,'local',remote.id)).rejects.toThrow('pending');
    expect((await ha.overview(true)).jobs[0].status).toBe('requested');expect(sent).toHaveLength(1);
  });
  it('confirms target registration only after source removal and unchanged anchor IPs',async()=>{
    await ha.rebalance(imsi,'local',remote.id);
    endpoints['http://192.0.2.20:9090/ue-info']=[ue];
    expect((await ha.overview(true)).jobs[0].status).toBe('requested');
    endpoints['http://192.0.2.10:9090/ue-info']=[];
    const result=await ha.overview(true);expect(result.jobs[0].status).toBe('completed');
    expect(result.nodes[1].ues[0].sessions).toEqual([{apn:'internet',ip:'10.45.0.101'}]);
  });
  it('does not claim preservation when the UE receives a different IP',async()=>{
    await ha.rebalance(imsi,'local',remote.id);
    endpoints['http://192.0.2.20:9090/ue-info']=[ue];endpoints['http://192.0.2.10:9090/ue-info']=[];
    endpoints['http://192.0.2.30:9090/pdu-info']=[{...pdn,pdu:[{apn:'internet',ipv4:'10.47.0.5'}]}];
    expect((await ha.overview(true)).jobs[0].status).toBe('requested');
  });
  it('records an uncertain delivery without an automatic destructive retry',async()=>{
    controlReply=new Error('SSH connection lost');
    const job=await ha.rebalance(imsi,'local',remote.id);expect(job.status).toBe('unknown');
    await expect(ha.rebalance(imsi,'local',remote.id)).rejects.toThrow('pending');expect(sent).toHaveLength(1);
  });
  it('does not confuse a fresh session reusing the static UE IP with a retained PDN',async()=>{
    await ha.rebalance(imsi,'local',remote.id);
    endpoints['http://192.0.2.10:9090/ue-info']=[];
    endpoints['http://192.0.2.20:9090/ue-info']=[{...ue,pdn:[{...ue.pdn[0],pgw:{ipv4:'192.0.2.30',teid:9999}}]}];
    expect((await ha.overview(true)).jobs[0].status).toBe('requested');
  });
  it('records an explicit native voice/priority refusal as a failure',async()=>{
    controlReply={ok:false,reason:'Voice or priority bearer'};
    const job=await ha.rebalance(imsi,'local',remote.id);expect(job.status).toBe('failed');expect(job.detail).toContain('Voice');
  });
  it('refuses idle UEs without sending an operator request',async()=>{
    endpoints['http://192.0.2.10:9090/ue-info']=[{...ue,cm_state:'idle'}];
    await expect(ha.rebalance(imsi,'local',remote.id)).rejects.toThrow('connected UE');expect(sent).toHaveLength(0);
  });
  it('keeps node removal from invalidating a pending operation',async()=>{
    await ha.rebalance(imsi,'local',remote.id);expect(()=>ha.removeNode(remote.id)).toThrow('pending');
  });
  it('rejects URL credentials, arbitrary API paths and shell-like SSH inputs',()=>{
    for(const url of ['http://user:pass@192.0.2.20/','file:///etc/passwd','http://192.0.2.20/admin'])
      expect(haNodeSchema.safeParse({name:'node',mmeUrl:url}).success).toBe(false);
    expect(haNodeSchema.safeParse({name:'node',mmeUrl:'http://192.0.2.20/',sshHost:'-oProxyCommand=sh'}).success).toBe(false);
    const command=operatorCommand(remote,{operation:'capabilities'});expect(command.args).toContain('StrictHostKeyChecking=yes');expect(command.args).toContain('BatchMode=yes');
    expect(NativeMmeRejection.prototype).toBeInstanceOf(Error);
  });
});
