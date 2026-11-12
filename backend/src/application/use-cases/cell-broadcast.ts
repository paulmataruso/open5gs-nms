import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { readFile } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import type { IHostExecutor } from '../../domain/interfaces/host-executor';
import type { IConfigRepository } from '../../domain/interfaces/config-repository';

export const taiSchema = z.object({ plmn: z.string().regex(/^\d{5,6}$/), tac: z.number().int().min(0).max(65535) }).strict();
export type BroadcastTai = z.infer<typeof taiSchema>;
export const zoneSchema = z.object({ name: z.string().trim().min(1).max(80), areas: z.array(taiSchema).min(1).max(16) }).strict();
export const sendSchema = z.object({
  requestId: z.string().uuid(), text: z.string().trim().min(1).max(615).refine(v => !/[\uD800-\uDFFF]/.test(v), 'Use UCS-2 characters'),
  zoneIds: z.array(z.string().uuid()).max(16).default([]), areas: z.array(taiSchema).max(16).default([]),
  messageId: z.number().int().min(0).max(65535), serialNumber: z.number().int().min(0).max(65535),
  repetitionPeriod: z.number().int().min(1).max(4095).default(30), broadcasts: z.number().int().min(1).max(100).default(3),
  confirm: z.literal(true),
}).strict();
export interface BroadcastZone { id: string; name: string; areas: BroadcastTai[]; }
interface TokenRow { id: string; name: string; zone_ids: string; hash: string; revoked: number; }
export interface BroadcastCaller { name: string; tokenId?: string; allowedZones?: string[]; }
export function uniqueTais(areas: BroadcastTai[]): BroadcastTai[] {
  return [...new Map(areas.map(a => [a.plmn + ':' + a.tac, a])).values()];
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const CLIENT = `import json,sys,urllib.request,urllib.error,base64
method,endpoint=sys.argv[1:3]
payload=base64.b64decode(sys.argv[3]) if len(sys.argv)>3 else None
req=urllib.request.Request('http://127.0.0.1:12345/api/ecbe/v1/'+endpoint,data=payload,method=method,headers={'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(req,timeout=15) as r:
  body=r.read(65537)
  if len(body)>65536: raise ValueError('CBC response too large')
  print(json.dumps({'code':r.status,'body':body.decode('utf8','replace')}))
except urllib.error.HTTPError as e:
 print(json.dumps({'code':e.code,'body':e.read(1024).decode('utf8','replace')}))
`;
const SERVICE = 'open5gs-nms-cbc.service';
// executeCommand enters the host mount namespace; filesystem helpers operate
// inside the NMS container. Prepare the installer in the same namespace as Python.
export const CBC_INSTALLER_PREPARE = `import base64,json,os,pathlib,stat,sys
if os.geteuid()!=0:raise RuntimeError('Host root is required')
files=json.loads(base64.b64decode(sys.argv[1]))
if set(files)!={'install-cbc.py','osmo-cbc-tai.patch'}:raise ValueError('Invalid installer bundle')
root=pathlib.Path('/var/lib/open5gs-nms/cbc-installer')
root.mkdir(parents=True,exist_ok=True,mode=0o700)
st=root.lstat()
if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0:raise RuntimeError('Unsafe installer directory')
root.chmod(0o700)
for name,content in files.items():
 target=root/name
 tmp=root/(name+'.tmp.'+str(os.getpid()))
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:
  f.write(content);f.flush();os.fsync(f.fileno())
 os.replace(tmp,target)
print('Installer prepared in host filesystem')
`;

export class CellBroadcastUseCase {
  private installation: { id: string; status: string; detail: string } | null = null;
  constructor(private db: Database, private host: IHostExecutor, private configs: IConfigRepository) {
    db.exec(`CREATE TABLE IF NOT EXISTS cbc_zones(id TEXT PRIMARY KEY,name TEXT NOT NULL,areas TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cbc_tokens(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,zone_ids TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cbc_messages(id TEXT PRIMARY KEY,actor TEXT NOT NULL,token_id TEXT,payload_hash TEXT NOT NULL,message_id INTEGER NOT NULL,serial INTEGER NOT NULL,text TEXT NOT NULL,areas TEXT NOT NULL,zone_names TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS cbc_live_message_id ON cbc_messages(message_id) WHERE status IN ('submitting','accepted','unknown','stopping');`);
    db.prepare("UPDATE cbc_messages SET status='unknown',detail='NMS restarted during dispatch; do not retry without checking CBC' WHERE status IN ('submitting','stopping')").run();
  }
  zones(): BroadcastZone[] {
    return (this.db.prepare('SELECT * FROM cbc_zones ORDER BY name').all() as Array<{id:string;name:string;areas:string}>).map(z => ({...z,areas:JSON.parse(z.areas)}));
  }
  saveZone(raw: unknown, id: string = randomUUID()): BroadcastZone {
    const z = zoneSchema.parse(raw); const areas=uniqueTais(z.areas);
    this.db.prepare('INSERT INTO cbc_zones VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,areas=excluded.areas').run(id,z.name,JSON.stringify(areas));
    return {id,name:z.name,areas};
  }
  removeZone(id: string): void { this.db.prepare('DELETE FROM cbc_zones WHERE id=?').run(id); }
  tokens() { return (this.db.prepare('SELECT id,name,zone_ids,revoked FROM cbc_tokens ORDER BY name').all() as Omit<TokenRow,'hash'>[]).map(t=>({id:t.id,name:t.name,zoneIds:JSON.parse(t.zone_ids),revoked:!!t.revoked})); }
  createToken(raw: unknown) {
    const input=z.object({name:z.string().trim().min(1).max(80),zoneIds:z.array(z.string().uuid()).min(1).max(16)}).strict().parse(raw);
    if(input.zoneIds.some(id=>!this.zones().some(z=>z.id===id))) throw new Error('Unknown zone');
    const secret='cbc_'+randomBytes(32).toString('base64url'),id=randomUUID();
    this.db.prepare('INSERT INTO cbc_tokens(id,name,hash,zone_ids) VALUES(?,?,?,?)').run(id,input.name,digest(secret),JSON.stringify([...new Set(input.zoneIds)]));
    return {id,secret};
  }
  revokeToken(id:string) { this.db.prepare('UPDATE cbc_tokens SET revoked=1 WHERE id=?').run(id); }
  authenticate(secret:string):BroadcastCaller|null {
    if(!/^cbc_[A-Za-z0-9_-]{43}$/.test(secret))return null;
    const t=this.db.prepare('SELECT * FROM cbc_tokens WHERE hash=? AND revoked=0').get(digest(secret)) as TokenRow|undefined;
    return t?{name:'api:'+t.name,tokenId:t.id,allowedZones:JSON.parse(t.zone_ids)}:null;
  }
  messages(caller?:BroadcastCaller) {
    return this.db.prepare('SELECT * FROM cbc_messages '+(caller?.tokenId?'WHERE token_id=? ':'')+'ORDER BY created_at DESC LIMIT 100').all(...(caller?.tokenId?[caller.tokenId]:[]));
  }
  private async cbc(method:string,endpoint:string,payload?:unknown) {
    const args=['-c',CLIENT,method,endpoint];if(payload!==undefined)args.push(Buffer.from(JSON.stringify(payload)).toString('base64'));
    const r=await this.host.executeCommand('python3',args,20000,{expectedFailure:true});
    if(r.exitCode || Buffer.byteLength(r.stdout)>70000)throw new Error('CBC response unavailable; delivery may be uncertain');
    return JSON.parse(r.stdout) as {code:number;body:string};
  }
  async capabilities() {
    try { const r=await this.cbc('GET','nms-capabilities');const c=JSON.parse(r.body);return r.code===200&&c.protocol===1&&c.scope_tais===true; } catch {return false;}
  }
  async mmeSupported():Promise<boolean> {
    const r=await this.host.executeCommand('python3',['-c',`import subprocess,sys
p=subprocess.check_output(['systemctl','show','open5gs-mmed.service','--property=MainPID','--value'],text=True).strip()
if not p.isdigit() or int(p)<1:sys.exit(1)
with open('/proc/'+p+'/exe','rb') as f:
 sys.exit(0 if b'SBc-AP explicit TAI routing v1' in f.read(67108864) else 1)
`],5000,{expectedFailure:true});
    if(r.exitCode)return false;
    const config=await this.configs.loadMme();
    const mme=(config.rawYaml as {mme?:{sbcap?:{server?:Array<{address?:string;port?:number}>}}}).mme;
    return !!mme?.sbcap?.server?.some(s=>s.address==='127.0.0.2'&&(s.port||29168)===29168);
  }
  async inventory() {
    const config=await this.configs.loadMme();
    const mme=(config.rawYaml as {mme?:{metrics?:{server?:Array<{address?:string;port?:number}>}}}).mme;
    const listener=mme?.metrics?.server?.[0];if(!listener?.address)throw new Error('MME inventory listener not configured');
    const address=listener.address==='0.0.0.0'?'127.0.0.1':listener.address==='::'?'::1':listener.address;
    const origin=`http://${address.includes(':')?'['+address+']':address}:${listener.port||9090}`;
    const radios:Array<{id:number;name:string;plmn:string;areas:BroadcastTai[];connected:boolean}>=[];
    const labels:Record<string,string>={};
    try { for(const r of this.db.prepare('SELECT ip,nickname FROM radio_tags').all() as Array<{ip:string;nickname:string}>)labels[r.ip]=r.nickname; }catch{/* optional radio labels */}
    for(let page=0;page<32;page++) {
      const r=await this.host.executeCommand('curl',['--fail','--silent','--show-error','--noproxy','*','--max-time','4','--max-filesize','2097152',`${origin}/enb-info?page=${page}&page_size=100`],6000,{expectedFailure:true});
      if(r.exitCode)throw new Error('MME radio inventory unavailable');
      const data=JSON.parse(r.stdout) as {items?:Array<{enb_id:number;name?:string;plmn?:string;s1?:{setup_success?:boolean;sctp?:{peer?:string}};supported_ta_list?:Array<{plmn?:string;tac?:string}>}>;pager?:{next?:number}};
      if(!Array.isArray(data.items))throw new Error('Invalid MME inventory');
      for(const enb of data.items) {
        const ip=enb.s1?.sctp?.peer?.replace(/^\[/,'').replace(/\]:\d+$/,'')||'';
        radios.push({id:enb.enb_id,name:labels[ip]||enb.name||`eNodeB ${enb.enb_id}`,plmn:enb.plmn||'',connected:enb.s1?.setup_success===true,
          areas:(enb.supported_ta_list||[]).map(a=>({plmn:a.plmn||'',tac:parseInt(a.tac||'',16)})).filter(a=>taiSchema.safeParse(a).success)});
      }
      if(data.pager?.next===undefined || data.pager.next===null)return radios;
      if(data.pager.next!==page+1)throw new Error('Unexpected inventory page');
    }
    throw new Error('MME inventory exceeds page limit');
  }
  async status() {
    const [service,targeting,inventory,mme]=await Promise.allSettled([
      this.host.executeCommand('systemctl',['show',SERVICE,'--property=LoadState,ActiveState'],5000,{expectedFailure:true}),this.capabilities(),this.inventory(),this.mmeSupported(),
    ]);
    return {service:service.status==='fulfilled'?service.value.stdout:'Unavailable',targeting:targeting.status==='fulfilled'&&targeting.value,mmeSupported:mme.status==='fulfilled'&&mme.value,
      radios:inventory.status==='fulfilled'?inventory.value:[],inventoryError:inventory.status==='rejected'?String(inventory.reason.message):null,
      installation:this.installation,zones:this.zones(),messages:this.messages(),tokens:this.tokens()};
  }
  resolveAreas(input:z.infer<typeof sendSchema>,caller:BroadcastCaller) {
    const zones=this.zones();const selected=input.zoneIds.map(id=>{const zone=zones.find(z=>z.id===id);if(!zone)throw new Error('Unknown zone');
      if(caller.allowedZones&&!caller.allowedZones.includes(id))throw new Error('Zone not authorized for this key');return zone;});
    const permitted=caller.allowedZones?uniqueTais(zones.filter(z=>caller.allowedZones!.includes(z.id)).flatMap(z=>z.areas)):null;
    if(permitted && input.areas.some(a=>!permitted.some(p=>p.plmn===a.plmn&&p.tac===a.tac)))throw new Error('TAI not authorized for this key');
    const areas=uniqueTais([...selected.flatMap(z=>z.areas),...input.areas]);
    if(areas.length<1||areas.length>16)throw new Error('Select between 1 and 16 distinct PLMN/TAC pairs');
    return {areas,names:selected.map(z=>z.name)};
  }
  async send(raw:unknown,caller:BroadcastCaller) {
    const input=sendSchema.parse(raw),resolved=this.resolveAreas(input,caller);
    const hash=digest(JSON.stringify({...input,areas:resolved.areas}));
    const existing=this.db.prepare('SELECT * FROM cbc_messages WHERE id=?').get(input.requestId) as {payload_hash:string;actor:string}|undefined;
    if(existing) {if(existing.payload_hash!==hash||existing.actor!==caller.name)throw new Error('Request ID already used for another message');return existing;}
    if(!await this.capabilities())throw new Error('Install/start a TAI-capable CBC before sending');
    if(!await this.mmeSupported())throw new Error('Configure and run a compatible MME with explicit TAI routing before sending');
    const radios=await this.inventory();
    if(resolved.areas.some(a=>!radios.some(r=>r.connected&&r.areas.some(t=>t.plmn===a.plmn&&t.tac===a.tac))))throw new Error('A selected TAI has no connected eNodeB in the current MME inventory');
    this.db.prepare('INSERT INTO cbc_messages(id,actor,token_id,payload_hash,message_id,serial,text,areas,zone_names,status,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(input.requestId,caller.name,caller.tokenId||null,hash,input.messageId,input.serialNumber,input.text,JSON.stringify(resolved.areas),JSON.stringify(resolved.names),'submitting','Submitting to CBC',Date.now());
    let status='unknown',detail='CBC delivery uncertain; inspect before retrying';
    try {
      const r=await this.cbc('POST','message',{cbe_name:'open5gs-nms',category:'normal',repetition_period:input.repetitionPeriod,num_of_bcast:input.broadcasts,
        scope:{scope_tais:resolved.areas},smscb_message:{message_id:input.messageId,serial_nr:{serial_nr_encoded:input.serialNumber},payload:{payload_decoded:{character_set:'ucs2',data_utf8:input.text}}}});
      status=r.code>=200&&r.code<300?'accepted':r.code>=400&&r.code<500?'rejected':'unknown';
      detail=status==='accepted'?'Accepted by CBC; handset reception is not confirmed':`CBC HTTP ${r.code}; ${status==='unknown'?'delivery uncertain':'request rejected'}`;
    }catch{/* Keep the operation locked if network delivery is uncertain. */}
    this.db.prepare('UPDATE cbc_messages SET status=?,detail=? WHERE id=?').run(status,detail,input.requestId);
    return this.db.prepare('SELECT * FROM cbc_messages WHERE id=?').get(input.requestId);
  }
  async stop(id:string,caller:BroadcastCaller) {
    const m=this.db.prepare('SELECT * FROM cbc_messages WHERE id=?').get(id) as {message_id:number;token_id:string|null;status:string}|undefined;
    if(!m||caller.tokenId&&m.token_id!==caller.tokenId)throw new Error('Message not found');
    if(!['accepted','unknown'].includes(m.status))throw new Error('Message cannot be stopped in its current state');
    this.db.prepare("UPDATE cbc_messages SET status='stopping' WHERE id=?").run(id);
    let status='unknown',detail='Stop delivery uncertain';
    try {const r=await this.cbc('DELETE','message/'+m.message_id);if(r.code>=200&&r.code<300){status='stopped';detail='CBC accepted stop request; handset state is not confirmed';}else detail=`CBC stop HTTP ${r.code}; check CBC before retrying`; }catch{/* no automatic retry */}
    this.db.prepare('UPDATE cbc_messages SET status=?,detail=? WHERE id=?').run(status,detail,id);return {status,detail};
  }
  async install() {
    if(this.installation?.status==='running')return this.installation;
    const job=this.installation={id:randomUUID(),status:'running',detail:'Preparing OsmoCBC installer'};
    void (async()=>{try {
      const dir='/var/lib/open5gs-nms/cbc-installer';
      const files=Object.fromEntries(await Promise.all(['install-cbc.py','osmo-cbc-tai.patch'].map(async file=>[file,await readFile(path.resolve(__dirname,'../../../tools/cbc',file),'utf8')])));
      const prepared=await this.host.executeCommand('python3',['-c',CBC_INSTALLER_PREPARE,Buffer.from(JSON.stringify(files)).toString('base64')],10000);
      if(prepared.exitCode)throw new Error('Cannot prepare installer on the host: '+prepared.stderr.slice(-1000));
      job.detail='Checking installed CBC and host dependencies';
      const result=await this.host.executeCommand('python3',[dir+'/install-cbc.py','--install'],1800000);
      job.status=result.exitCode?'failed':'complete';job.detail=(result.exitCode?result.stderr:result.stdout).slice(-4000);
    }catch(e){job.status='failed';job.detail=e instanceof Error?e.message:String(e);}})();return job;
  }
  async service(action:string) {
    if(!['start','stop','restart'].includes(action))throw new Error('Invalid service action');
    const r=await this.host.executeCommand('systemctl',[action,SERVICE],20000);if(r.exitCode)throw new Error('CBC service action failed');return {success:true};
  }
}
