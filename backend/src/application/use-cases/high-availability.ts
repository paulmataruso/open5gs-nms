import { randomUUID } from 'crypto';
import { BlockList, isIP } from 'net';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import type { IHostExecutor } from '../../domain/interfaces/host-executor';
import type { IConfigRepository } from '../../domain/interfaces/config-repository';
import { parsePeerIP } from './open5gs-api-client';

const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const hostname = z.string().max(253).refine(v => isIP(v) !== 0 ||
  v.split('.').every(p => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(p)), 'Invalid host');
const baseUrl = z.string().url().max(300).refine(value => {
  const u = new URL(value);
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password &&
    !u.search && !u.hash && u.pathname === '/';
}, 'Use an HTTP(S) origin without credentials, path, query or fragment');
export const haNodeSchema = z.object({
  name: z.string().trim().min(1).max(80), mmeUrl: baseUrl, smfUrl: baseUrl.optional(),
  sshHost: hostname.optional(), sshUser: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default('root'),
}).strict();
const haIdentitySchema = z.object({plmn:z.string().regex(/^\d{5,6}$/),mme_gid:z.number().int().min(0).max(65535),mme_code:z.number().int().min(0).max(255)}).strict();
export type HaIdentity = z.infer<typeof haIdentitySchema>;
export interface HaNode extends z.infer<typeof haNodeSchema> { id: string; }
export interface HaRadio { id: number; name: string; reportedName: string; ip: string; sctpPeer: string; plmn: string; areas: Array<{ tac: string; plmn: string }>; connected: boolean; connectedUes: number | null; }
export interface HaUe { imsi: string; cmState: string; mmState: string; radioId?: number; radioName: string; radioIp: string; sessions: Array<{ apn: string; ip: string }>; pdns: unknown[]; }
export interface HaSnapshot { node: HaNode; available: boolean; error?: string; radios: HaRadio[]; ues: HaUe[]; anchorBindings: Array<{ imsi: string; apn: string; ip: string }>; sessionDataAvailable: boolean; control: { available: boolean; pdnBindings: boolean; identity: HaIdentity | null; relativeCapacity: number | null; reason: string }; sampledAt: string; }
interface HaJob { id: string; imsi: string; source: string; target: string; createdAt: number; status: 'requested' | 'completed' | 'failed' | 'timed_out' | 'unknown'; detail: string; baseline: { sessions: Array<{ apn: string; ip: string }>; context: string }; }

/* Runs in the host namespace; the socket is private, authenticated with Linux
 * credentials. Requests never execute code supplied by the browser. */
export const MME_OPERATOR_CLIENT = `import base64,json,os,socket,sys,tempfile
request=json.loads(base64.b64decode(sys.argv[1]))
path='/run/open5gs-mme-operator/control.sock'
with tempfile.TemporaryDirectory(prefix='nms-mme-operator-') as d:
 s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
 s.settimeout(3)
 s.bind(d+'/client.sock')
 try:
  s.connect(path)
  s.send(json.dumps(request,separators=(',',':')).encode())
  response=json.loads(s.recv(4096))
  if request.get('request_id') and response.get('request_id')!=request['request_id']:raise ValueError('Request ID mismatch')
  print(json.dumps(response))
 finally:s.close()
`;
const quote = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
function sshCommand(node: HaNode, command: string, args: string[]): {command:string;args:string[]} {
  if (!node.sshHost) throw new Error('SSH control is not configured for this core');
  return { command:'ssh',args:['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=3','--',
    `${node.sshUser}@${node.sshHost}`,[command,...args].map(quote).join(' ')] };
}
export function operatorCommand(node: HaNode, request: unknown): { command: string; args: string[] } {
  const payload = Buffer.from(JSON.stringify(request)).toString('base64');
  if (node.id === 'local') return { command: 'python3', args: ['-c', MME_OPERATOR_CLIENT, payload] };
  return sshCommand(node,'python3',['-c',MME_OPERATOR_CLIENT,payload]);
}
const sessionKey = (sessions: HaUe['sessions']) => sessions.map(s => `${s.apn}\0${s.ip}`).sort().join('\n');
export class NativeMmeRejection extends Error {}

export function pdnContextSignature(pdns: unknown[]): string {
  if (!pdns.length) return '';
  const values: string[] = [];
  for (const value of pdns) {
    const p = record(value), pgw = record(p.pgw);
    if (!p.apn || !Number.isInteger(pgw.teid) || pgw.teid<=0 || pgw.teid>0xffffffff ||
        !(isIP(String(pgw.ipv4||''))===4 || isIP(String(pgw.ipv6||''))===6)) return '';
    const ipv4 = isIP(String(p.ipv4||''))===4 && p.ipv4!=='0.0.0.0' ? String(p.ipv4) : '';
    const ipv6 = isIP(String(p.ipv6_prefix||''))===6 && Number.isInteger(p.ipv6_prefix_length) && p.ipv6_prefix_length>0 && p.ipv6_prefix_length<=128
      ? `${p.ipv6_prefix}/${p.ipv6_prefix_length}` : '';
    if (!ipv4 && !ipv6) return '';
    values.push(JSON.stringify([String(p.apn),ipv4,ipv6,String(pgw.ipv4||''),String(pgw.ipv6||''),pgw.teid]));
  }
  return values.sort().join('\n');
}
function matchesPdn(session: {apn:string;ip:string}, pdns: unknown[]): boolean {
  return pdns.some(value => {
    const p=record(value);
    if (String(p.apn)!==session.apn) return false;
    if (p.ipv4===session.ip) return true;
    if (isIP(session.ip)===6 && isIP(String(p.ipv6_prefix||''))===6 && Number.isInteger(p.ipv6_prefix_length)) {
      try { const prefix=new BlockList();prefix.addSubnet(p.ipv6_prefix,p.ipv6_prefix_length,'ipv6');return prefix.check(session.ip,'ipv6'); } catch { return false; }
    }
    return false;
  });
}

export class HighAvailabilityUseCase {
  private inFlight?: Promise<{ nodes: HaSnapshot[]; jobs: HaJob[] }>;
  private cached?: { at: number; data: { nodes: HaSnapshot[]; jobs: HaJob[] } };
  constructor(private readonly db: Database, private readonly host: IHostExecutor, private readonly configs: IConfigRepository) {
    db.exec(`CREATE TABLE IF NOT EXISTS ha_nodes (id TEXT PRIMARY KEY, profile TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ha_jobs (id TEXT PRIMARY KEY, imsi TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL, baseline TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS ha_job_pending_ue ON ha_jobs(imsi) WHERE status IN ('requested','unknown');
      CREATE UNIQUE INDEX IF NOT EXISTS ha_job_pending_source ON ha_jobs(source) WHERE status IN ('requested','unknown');`);
  }
  async nodes(): Promise<HaNode[]> {
    const [mme, smf] = await Promise.all([this.configs.loadMme(), this.configs.loadSmf()]);
    const m = record(record(mme.rawYaml).mme), s = record(record(smf.rawYaml).smf);
    const url = (nf: Record<string, any>) => {
      const listener = nf.metrics?.server?.[0];
      if (!listener?.address) throw new Error('Configure a metrics listener for MME and SMF');
      const address = String(listener.address);
      if (['0.0.0.0', '::'].includes(address)) throw new Error('Use a concrete metrics listener address');
      return `http://${isIP(address) === 6 ? '[' + address + ']' : address}:${listener.port ?? 9090}/`;
    };
    const local: HaNode = { id: 'local', name: String(m.mme_name || 'Local MME'), mmeUrl: url(m), smfUrl: url(s), sshUser: 'root' };
    const saved = this.db.prepare('SELECT id, profile FROM ha_nodes ORDER BY id').all() as Array<{ id: string; profile: string }>;
    return [local, ...saved.map(n => ({ ...haNodeSchema.parse(JSON.parse(n.profile)), id: n.id }))];
  }
  saveNode(input: unknown, id?: string): HaNode {
    const profile = haNodeSchema.parse(input);
    if (id === 'local') throw new Error('Local endpoints are managed by Open5GS configuration');
    if (id && !this.db.prepare('SELECT id FROM ha_nodes WHERE id=?').get(id)) throw new Error('Core not found');
    if (!id && (this.db.prepare('SELECT COUNT(*) AS n FROM ha_nodes').get() as { n: number }).n >= 15) throw new Error('At most 15 remote cores');
    const key = id || randomUUID();
    this.db.prepare('INSERT INTO ha_nodes(id,profile) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile').run(key, JSON.stringify(profile));
    this.cached = undefined;
    return { ...profile, id: key };
  }
  removeNode(id: string): void {
    if (id === 'local') throw new Error('Cannot remove the local core');
    if (this.db.prepare("SELECT id FROM ha_jobs WHERE (source=? OR target=?) AND status IN ('requested','unknown')").get(id, id)) throw new Error('This core has a pending relocation');
    this.db.prepare('DELETE FROM ha_nodes WHERE id=?').run(id); this.cached = undefined;
  }
  private async rows(node: HaNode, base: string, endpoint: string): Promise<Record<string, any>[]> {
    baseUrl.parse(base);
    const rows: Record<string, any>[] = [];
    const started = Date.now();
    let receivedBytes = 0;
    for (let page = 0; page < 32; page++) {
      if (Date.now()-started>20000) throw new Error(`${endpoint} exceeded inventory deadline`);
      const url = new URL(`${endpoint}?page=${page}&page_size=100`, base).href;
      const args = ['--proto', '=http,https', '--noproxy', '*', '--fail', '--silent', '--show-error', '--connect-timeout', '2', '--max-time', '5', '--', url];
      const command = node.id!=='local'&&node.sshHost ? sshCommand(node,'curl',args) : {command:'curl',args};
      const result = await this.host.executeCommand(command.command, command.args, node.sshHost?10000:6500, { expectedFailure: true });
      if (result.exitCode !== 0) throw new Error(`${endpoint} is unavailable`);
      if (Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new Error(`${endpoint} response exceeds limit`);
      receivedBytes += Buffer.byteLength(result.stdout);
      if (receivedBytes > 8 * 1024 * 1024) throw new Error(`${endpoint} inventory exceeds size limit`);
      const parsed = record(JSON.parse(result.stdout));
      if (!Array.isArray(parsed.items) || parsed.items.length > 1000 || parsed.pager?.truncated) throw new Error(`${endpoint} returned incomplete or invalid data`);
      rows.push(...parsed.items.map(record));
      if (!parsed.pager?.next) return rows;
    }
    throw new Error(`${endpoint} exceeds pagination limit`);
  }
  async operator(node: HaNode, request: unknown): Promise<Record<string, any>> {
    const command = operatorCommand(node, request);
    const result = await this.host.executeCommand(command.command, command.args, 8000, { expectedFailure: true });
    if (result.exitCode || Buffer.byteLength(result.stdout) > 8192) throw new Error('Native MME operator control unavailable; verify the socket, SSH trust and installed MME');
    const reply = record(JSON.parse(result.stdout));
    if (reply.ok !== true) throw new NativeMmeRejection(String(reply.reason || 'Native MME rejected the operation'));
    return reply;
  }
  async snapshot(node: HaNode): Promise<HaSnapshot> {
    const sampledAt = new Date().toISOString();
    const [radiosResult, uesResult, pdnsResult, controlResult] = await Promise.allSettled([
      this.rows(node, node.mmeUrl, 'enb-info'), this.rows(node, node.mmeUrl, 'ue-info'),
      node.smfUrl ? this.rows(node, node.smfUrl, 'pdu-info') : Promise.reject(new Error('PGW/SMF metrics endpoint not configured')),
      this.operator(node, { operation: 'capabilities' }),
    ]);
    const identity = controlResult.status==='fulfilled' ? haIdentitySchema.safeParse(controlResult.value.identity) : null;
    const capacity = controlResult.status==='fulfilled' && Number.isInteger(controlResult.value.relative_capacity) && controlResult.value.relative_capacity>=0 && controlResult.value.relative_capacity<=255 ? Number(controlResult.value.relative_capacity) : null;
    const control = controlResult.status === 'fulfilled' && controlResult.value.protocol === 1 && controlResult.value.rebalance === true
      ? { available: true, pdnBindings: controlResult.value.pdn_bindings===true, identity:identity?.success?identity.data:null,relativeCapacity:capacity, reason: 'Native MME operator connected' }
      : { available: false, pdnBindings: false, identity:null,relativeCapacity:null, reason: controlResult.status === 'rejected' ? String(controlResult.reason.message) : 'Unsupported native operator protocol' };
    const pdns = pdnsResult.status === 'fulfilled' ? pdnsResult.value : [];
    const anchorBindings = pdns.flatMap(p => (Array.isArray(p.pdu) ? p.pdu : []).map((x: unknown) => record(x))
      .filter(x => !x.n3).flatMap(x => [x.ipv4, x.ipv6].filter(Boolean).map(ip => ({
        imsi: String(p.supi || '').replace(/^imsi-/, ''), apn: String(x.apn || x.dnn || ''), ip: String(ip),
      }))));
    if (radiosResult.status === 'rejected' || uesResult.status === 'rejected') return { node, available: false,
      error: [radiosResult, uesResult].filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason.message)).join('; '),
      radios: [], ues: [], anchorBindings, sessionDataAvailable: pdnsResult.status === 'fulfilled', control, sampledAt };
    let tags: Record<string, string> = {};
    try { tags = Object.fromEntries((this.db.prepare('SELECT ip,nickname FROM radio_tags').all() as Array<{ ip: string; nickname: string }>).map(r => [r.ip, r.nickname])); } catch { /* Optional existing radio labels. */ }
    const radios: HaRadio[] = radiosResult.value.filter(r => Number.isInteger(Number(r.enb_id)) && Number(r.enb_id)>=0 && Number(r.enb_id)<=0xffffffff).map(r => {
      const ip = parsePeerIP(String(r.s1?.sctp?.peer || ''));
      return { id: Number(r.enb_id), name: tags[ip] || String(r.name || '') || `eNodeB ${r.enb_id}`, reportedName: String(r.name || ''), ip, sctpPeer: String(r.s1?.sctp?.peer || ''),
        plmn: String(r.plmn || ''), areas: Array.isArray(r.supported_ta_list) ? r.supported_ta_list.map((a: unknown) => ({ tac: String(record(a).tac || ''), plmn: String(record(a).plmn || '') })) : [],
        connected: r.s1?.setup_success === true, connectedUes: typeof r.num_connected_ues==='number' && Number.isFinite(r.num_connected_ues) && r.num_connected_ues>=0 ? r.num_connected_ues : null };
    });
    const ues: HaUe[] = uesResult.value.filter(u => !u.domain || u.domain === 'EPS').map(u => {
      const imsi = String(u.supi || '').replace(/^imsi-/, '');
      const radio = radios.find(r => r.id === Number(u.enb?.enb_id));
      const sessions = pdns.filter(p => String(p.supi || '').replace(/^imsi-/, '') === imsi)
        .flatMap(p => (Array.isArray(p.pdu) ? p.pdu : []).map((p: unknown) => record(p)))
        .filter(p => !p.n3).flatMap(p => [p.ipv4, p.ipv6].filter(Boolean).map(ip => ({ apn: String(p.apn || p.dnn || ''), ip: String(ip) })));
      return { imsi, cmState: String(u.cm_state || 'unknown'), mmState: String(u.mm_state || 'unknown'), radioId: u.enb?.enb_id,
        radioName: radio?.name || '', radioIp: radio?.ip || '', sessions, pdns: Array.isArray(u.pdn) ? u.pdn : [] };
    }).filter(u => /^\d{5,15}$/.test(u.imsi));
    return { node, available: true, radios, ues, anchorBindings, sessionDataAvailable: pdnsResult.status === 'fulfilled', control, sampledAt };
  }
  private jobs(): HaJob[] {
    const rows = this.db.prepare('SELECT * FROM ha_jobs ORDER BY created_at DESC LIMIT 100').all() as Array<Record<string, any>>;
    return rows.map(r => ({ id: r.id, imsi: r.imsi, source: r.source, target: r.target, createdAt: r.created_at,
      status: r.status, detail: r.detail, baseline: JSON.parse(r.baseline) }));
  }
  async overview(force = false): Promise<{ nodes: HaSnapshot[]; jobs: HaJob[] }> {
    if (!force && this.cached && Date.now() - this.cached.at < 4000) return this.cached.data;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const nodes = await Promise.all((await this.nodes()).map(n => this.snapshot(n)));
      // A moved UE retains its original PGW. Correlate SMF bindings across
      // every configured anchor rather than assuming MME and PGW co-location.
      const bindings = nodes.flatMap(n => n.anchorBindings);
      for (const node of nodes) for (const ue of node.ues) {
        const sessions = bindings.filter(b => b.imsi === ue.imsi).map(({ apn, ip }) => ({ apn, ip }));
        const correlated = pdnContextSignature(ue.pdns) ? sessions.filter(s=>matchesPdn(s,ue.pdns)) : sessions;
        ue.sessions = [...new Map(correlated.map(s => [`${s.apn}\0${s.ip}`, s])).values()];
      }
      for (const job of this.jobs().filter(j => ['requested','unknown'].includes(j.status))) {
        const source = nodes.find(n => n.node.id === job.source), target = nodes.find(n => n.node.id === job.target);
        const arrived = target?.ues.find(u => u.imsi === job.imsi && u.mmState === 'registered');
        const remains = source?.ues.find(u => u.imsi === job.imsi && u.mmState === 'registered');
        if (source?.available && target?.available && nodes.every(n => n.sessionDataAvailable) && arrived && !remains &&
            job.baseline.context && pdnContextSignature(arrived.pdns)===job.baseline.context && sessionKey(arrived.sessions) === sessionKey(job.baseline.sessions)) {
          this.db.prepare("UPDATE ha_jobs SET status='completed',detail=? WHERE id=?").run('Target registration observed; allocated addresses and original PGW control bindings retained', job.id);
        } else if (Date.now() - job.createdAt > 120000) {
          this.db.prepare("UPDATE ha_jobs SET status='timed_out',detail=? WHERE id=?").run('Relocation could not be confirmed. Inspect the UE and both MMEs before another request.', job.id);
        }
      }
      const data = { nodes, jobs: this.jobs() }; this.cached = { at: Date.now(), data }; return data;
    })();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }
  async rebalance(imsi: string, sourceId: string, targetId: string): Promise<HaJob> {
    if (!/^\d{5,15}$/.test(imsi) || sourceId === targetId) throw new Error('Choose a UE and a different target core');
    const data = await this.overview(true), source = data.nodes.find(n => n.node.id === sourceId), target = data.nodes.find(n => n.node.id === targetId);
    if (!source?.available || !target?.available || !source.sessionDataAvailable || !target.sessionDataAvailable) throw new Error('Both MME and PGW/SMF data sources must be available');
    if (!source.control.available) throw new Error(source.control.reason);
    if (!source.control.pdnBindings || !target.control.pdnBindings) throw new Error('Both MMEs must export allocated PDN addresses and PGW bindings through the native operator build');
    if (!source.control.identity || !target.control.identity) throw new Error('Both MMEs must expose an unambiguous served GUMMEI');
    if (JSON.stringify(source.control.identity)===JSON.stringify(target.control.identity)) throw new Error('Source and target have the same served GUMMEI');
    if (target.control.relativeCapacity===null || target.control.relativeCapacity===0) throw new Error('Target MME is not advertising accepting capacity');
    const ue = source.ues.find(u => u.imsi === imsi);
    if (!ue || ue.cmState !== 'connected' || ue.mmState !== 'registered' || !ue.sessions.length) throw new Error('A registered, connected UE with known PDN addresses is required');
    const context = pdnContextSignature(ue.pdns);
    if (!context) throw new Error('Allocated PDN addresses and PGW control bindings are incomplete');
    const radio = source.radios.find(r => r.id === ue.radioId && r.connected);
    if (!radio || !target.radios.some(r => r.id === radio.id && r.plmn === radio.plmn && r.connected)) throw new Error('The same eNodeB must have a completed S1 association with both MMEs');
    const routes = await Promise.all([
      this.operator(source.node,{operation:'peer-check',...target.control.identity}),
      this.operator(target.node,{operation:'peer-check',...source.control.identity}),
    ]);
    if (routes.some(route=>route.route!==true)) throw new Error('Reciprocal runtime S10 routes are not confirmed');
    const id = randomUUID(), createdAt = Date.now();
    try { this.db.prepare('INSERT INTO ha_jobs VALUES(?,?,?,?,?,?,?,?)').run(id, imsi, sourceId, targetId, createdAt, 'requested', 'Submitting native MME request', JSON.stringify({sessions:ue.sessions,context})); }
    catch { throw new Error('This UE or source core already has a pending relocation'); }
    try {
      const reply = await this.operator(source.node, { operation: 'rebalance', imsi, request_id: id });
      if (reply.request_id !== id || reply.status !== 'requested') throw new Error('Invalid native MME response');
      this.db.prepare("UPDATE ha_jobs SET detail=? WHERE id=? AND status='requested'").run('MME accepted the request. Awaiting eNodeB selection and target registration.', id);
    } catch (error) {
      // Delivery may have occurred before a reply was lost. Never retry a
      // destructive operation automatically or claim that it did not happen.
      this.db.prepare("UPDATE ha_jobs SET status=?,detail=? WHERE id=? AND status='requested'").run(error instanceof NativeMmeRejection ? 'failed' : 'unknown', String(error instanceof Error ? error.message : error), id);
    }
    this.cached = undefined;
    return this.jobs().find(j => j.id === id)!;
  }
}
