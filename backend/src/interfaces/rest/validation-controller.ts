import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as jsyaml from 'js-yaml';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { Subscriber } from '../../domain/entities/subscriber';
import { requireAdmin } from './middleware/auth-middleware';
import { convertRepeatedMapKeysToArray } from '../../infrastructure/yaml/yaml-config-repository';
import { createDummyInterface, deleteDummyInterface, nsenter, dummyNetdevPath, dummyNetworkPath } from '../../infrastructure/network/dummy-interface';
import { ipToNum, numToIp, cidrRange } from '../../domain/services/ip-utils';

const moduleLogger = pino({ name: 'validation-controller' });

const execFileAsync = promisify(execFile);

const VALIDATION_DIR = '/tmp/ue-validation';
const UERANSIM_IMAGE = 'free5gc/ueransim:latest';
const SRSRAN_IMAGE = 'srsran4g-noavx:latest';
const GNB_BASE = '127.0.3';
const ENB_BASE = '127.0.4';
const OPEN5GS_DIR = '/etc/open5gs';

// Dedicated host-local address block for validation-radio control-plane IPs
// (S1AP/NGAP bind addresses) — separate from the real NF range (10.0.1.x)
// and from GNB_BASE/ENB_BASE above (those stay loopback aliases for GTP/link
// IPs only). See allocateRadioDummyIp() for why these need to be distinct
// per radio instead of reusing the AMF/MME's own address.
// One eNB per 4G UE (see the eNB config-writing loop below), so this needs
// to cover the UI's worst case (enbCount x enbUeCount, up to 10x10=100).
// gNBs are one-per-gNB (max 20), sized identically here for headroom.
const VAL_ENB_DUMMY_BASE = 10;  // 10.0.9.10  .. 10.0.9.109
const VAL_GNB_DUMMY_BASE = 110; // 10.0.9.110 .. 10.0.9.209

// Each simulated eNB/gNB used to bind its S1AP/NGAP control-plane socket to
// either 0.0.0.0 (resolves to the host's real IP) or literally the AMF's own
// address — on this single-host deployment both collapse to the SAME IP the
// MME/AMF themselves listen on. Open5GS keys eNB/gNB identity by peer IP
// (mme_enb_find_by_addr / amf_gnb_find_by_addr) and rejects a second
// connection from an IP that already has a context ("gNB context duplicated
// with IP-address [...]!!! N2 Socket Closed"). Giving each radio its own
// dummy /32 avoids the collision. Host-local only — not persisted, not
// advertised into FRR/EIGRP, torn down when the session stops.
function allocateRadioDummyIp(sessionId: string, kind: '4g' | '5g', idx: number): { name: string; ip: string } {
  const shortId = sessionId.slice(0, 6);
  if (kind === '4g') {
    return { name: `v4-${shortId}-${idx}`, ip: `10.0.9.${VAL_ENB_DUMMY_BASE + idx}` };
  }
  return { name: `v5-${shortId}-${idx}`, ip: `10.0.9.${VAL_GNB_DUMMY_BASE + idx}` };
}

// Matches exactly the naming convention allocateRadioDummyIp() produces (v4-/v5- + 6 hex
// chars + index) — this pattern isn't used anywhere else on the host, so it's safe to sweep
// unconditionally regardless of whether a session directory still exists for it.
const VAL_DUMMY_IFACE_RE = /^v[45]-[0-9a-f]{6}-\d+$/;

// Finds every host network interface left over from validation sessions, whether or not a
// corresponding session directory/record still exists — used both by force-cleanup and by
// reconcileOrphanedSessions() for sessions whose containers already died before a restart.
//
// Belt-and-suspenders on top of the name pattern: real Open5GS/FRR-managed dummy interfaces
// (dummy-amf, dummy-upf, or any admin-created VSI from the "Dummy Interfaces" tab) are
// ALWAYS created with persist=true (frr-controller.ts), which always writes a systemd-networkd
// .netdev/.network file for that name. Validation-session interfaces are ALWAYS created with
// persist=false and never have those files. So even in the hypothetical case where someone
// names an FRR-managed interface to coincidentally match the v4-/v5- pattern, it's still
// never touched here — only interfaces with no persisted config are ever candidates.
async function listOrphanedValidationDummyInterfaces(): Promise<string[]> {
  try {
    const { stdout } = await nsenter('ip', ['-br', 'link', 'show']);
    return stdout.split('\n')
      .map(line => line.trim().split(/\s+/)[0])
      .filter(name => name && VAL_DUMMY_IFACE_RE.test(name))
      .filter(name => !fs.existsSync(dummyNetdevPath(name)) && !fs.existsSync(dummyNetworkPath(name)));
  } catch {
    return [];
  }
}

// Safety invariant: NEVER delete a subscriber whose nickname doesn't start
// with VAL-TEST-.  This is enforced in safeDeleteTestImsi().
const VAL_NICKNAME_PREFIX = 'VAL-TEST-';

// ─── Types ────────────────────────────────────────────────────────────────────

interface UeStatus {
  imsi: string;
  type: '5g' | '4g';
  nodeId: string;  // e.g. 'gnb-1' or 'enb-2'
  state: 'starting' | 'registered' | 'session_established' | 'failed' | 'stopped';
  ip?: string;
  error?: string;
}

// Ordering for the monotonic-state guard in startPolling() — see its comment.
const STATE_RANK: Record<UeStatus['state'], number> = {
  starting: 0, registered: 1, session_established: 2, failed: 3, stopped: 3,
};

interface Session {
  id: string;
  startedAt: Date;
  status: 'provisioning' | 'running' | 'stopping' | 'stopped' | 'failed';
  containers: string[];
  dummyInterfaces: string[];  // per-radio host-local control-plane IPs — see allocateRadioDummyIp()
  imsis: string[];
  ueStatuses: Record<string, UeStatus>;
  logs: string[];    // step-by-step progress log shown in UI
  error?: string;    // last fatal error message
}

interface DnnSubnet {
  dnn: string;
  cidr: string;    // e.g. "10.45.0.0/24"
  gateway: string; // excluded from pool
}

interface InferredConfig {
  plmn: { mcc: string; mnc: string };
  amfIp: string;
  upfIp: string;
  tac5g: number;
  slices: Array<{ sst: number; sd?: string }>;
  dnns: string[];
  subnets: DnnSubnet[];
  mmeIp: string;
  tac4g: number;
  mmeGroupId: number;
  mmeCode: number;
  apns: string[];
}

// ─── In-memory session state ───────────────────────────────────────────────

const sessions = new Map<string, Session>();
const sseClients = new Set<Response>();

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch { sseClients.delete(res); } });
}

const SESSION_FILE = 'session.json';

// Serializable snapshot of a session, written to disk on every meaningful
// change. Validation containers run detached (`docker run -d`, no lifecycle
// tie to the NMS process), so a backend restart while a session is active
// otherwise orphans them — they keep running but vanish from
// /api/validation/sessions with no way to see or stop them. See
// reconcileOrphanedSessions() below, which reads these snapshots back on
// startup. Best-effort: a failed write must never break the live session.
function persistSession(session: Session): void {
  try {
    const dir = path.join(VALIDATION_DIR, session.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SESSION_FILE), JSON.stringify(session, null, 2));
  } catch { /* best-effort */ }
}

function step(session: Session, msg: string, logger: pino.Logger) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  session.logs.push(line);
  logger.info({ sessionId: session.id }, msg);
  persistSession(session);
  broadcast('log', { id: session.id, line });
}

// ─── Host capacity / resource budgeting ────────────────────────────────────
//
// The validation containers used to have hardcoded --cpus/--memory limits,
// hand-tuned for one specific 4-core host. Compute them instead so a bigger
// host gets proportionally more (faster, more reliable radio simulation) and
// a smaller one doesn't get overcommitted. Always reserve a floor for the
// OS, Docker itself, and the rest of the NMS/core stack that shares this box.

export interface HostCapacity {
  cores: number;
  totalMemGB: number;
}

export function detectHostCapacity(): HostCapacity {
  return {
    cores: os.cpus().length,
    totalMemGB: os.totalmem() / 1024 ** 3,
  };
}

interface ResourceBudget {
  cpus5G: number; mem5GGB: number;
  cpus4G: number; mem4GGB: number;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

// srsRAN (4G) does real-time DSP/PHY simulation and is far more CPU-hungry
// than UERANSIM (5G), which doesn't do real over-the-air signal processing —
// weighted 60/40 when both run. Floors: never let validation eat into more
// than 75% of total cores, and always leave enough RAM for this host's own
// baseline (OS + Docker + the rest of the NMS/core stack) — 40% or 2.5GB,
// whichever is bigger, since a flat 20% left this host with too little
// headroom against its own observed steady-state usage.
export function computeResourceBudget(
  capacity: HostCapacity,
  enable5G: boolean,
  enable4G: boolean,
): ResourceBudget {
  const floorCores = Math.max(1, capacity.cores * 0.25);
  const floorMemGB = Math.max(2.5, capacity.totalMemGB * 0.4);
  const availCores = Math.max(0.5, capacity.cores - floorCores);
  const availMemGB = Math.max(0.5, capacity.totalMemGB - floorMemGB);
  const capCores   = capacity.cores * 0.75;

  const budget: ResourceBudget = { cpus5G: 0, mem5GGB: 0, cpus4G: 0, mem4GGB: 0 };

  if (enable5G && enable4G) {
    budget.cpus4G  = round1(Math.min(availCores, capCores) * 0.6);
    budget.cpus5G  = round1(Math.min(availCores, capCores) * 0.4);
    budget.mem4GGB = round1(availMemGB * 0.6);
    budget.mem5GGB = round1(availMemGB * 0.4);
  } else if (enable4G) {
    budget.cpus4G  = round1(Math.min(availCores, capCores));
    budget.mem4GGB = round1(availMemGB);
  } else if (enable5G) {
    budget.cpus5G  = round1(Math.min(availCores, capCores));
    budget.mem5GGB = round1(availMemGB);
  }

  // Sane floor per enabled container so a very small host still gets
  // something workable rather than a near-zero limit.
  if (enable5G) { budget.cpus5G = Math.max(budget.cpus5G, 0.5); budget.mem5GGB = Math.max(budget.mem5GGB, 0.5); }
  if (enable4G) { budget.cpus4G = Math.max(budget.cpus4G, 0.5); budget.mem4GGB = Math.max(budget.mem4GGB, 0.5); }

  return budget;
}

// ─── Log file helpers ──────────────────────────────────────────────────────
//
// srsRAN/UERANSIM's PHY-layer logging grows ue.log extremely fast — ~1.4MB/s
// observed, ~1GB after ~30 min of a single UE sitting idle. Reading the
// whole file on every poll tick (or on every raw-logs request) eventually
// exceeds Node's max string length (~536MB) and throws, which is fatal to
// the whole backend process when it happens inside a setInterval callback,
// not just this feature.
const LOG_TAIL_BYTES = 4 * 1024 * 1024; // 4MB

// Bounded tail read — always cheap and safe, used for the human-facing
// raw-logs endpoint where "show recent activity" is all that's needed.
function readLogTail(filePath: string, maxBytes: number = LOG_TAIL_BYTES): string {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const readSize = Math.min(size, maxBytes);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== -1) try { fs.closeSync(fd); } catch { /* ok */ }
  }
}

// Incremental read — only the bytes appended since the last call for this
// path. A fixed-size tail (readLogTail above) is NOT safe for the state
// poller: at ~1.4MB/s growth, a one-time line like "Network attach
// successful" can scroll past a several-MB tail window before the next
// 3s poll tick ever reads it — permanently missing it, since these lines
// are written exactly once. Tracking a per-file read cursor means every
// byte is scanned exactly once, so nothing gets missed regardless of growth
// rate. The first read for a given path is still bounded to LOG_TAIL_BYTES
// (not the whole file) — matters after a backend restart, where
// reconcileOrphanedSessions() resumes polling an already-large file with no
// prior cursor.
const logReadOffsets = new Map<string, number>();

function readLogSince(filePath: string, maxChunkBytes = 16 * 1024 * 1024): string {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    let start = logReadOffsets.get(filePath);
    if (start === undefined || start > size) start = Math.max(0, size - LOG_TAIL_BYTES);
    const readSize = Math.min(size - start, maxChunkBytes);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, start);
    logReadOffsets.set(filePath, start + readSize);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== -1) try { fs.closeSync(fd); } catch { /* ok */ }
  }
}

function clearLogReadOffsets(sessionDir: string): void {
  for (const key of logReadOffsets.keys()) {
    if (key.startsWith(sessionDir)) logReadOffsets.delete(key);
  }
}

// ─── Docker helpers ────────────────────────────────────────────────────────

async function dockerRun(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { timeout: 30_000 });
  return stdout.trim();
}

async function dockerKill(name: string): Promise<void> {
  try { await execFileAsync('docker', ['kill', name], { timeout: 10_000 }); } catch { /* already gone */ }
  try { await execFileAsync('docker', ['rm', '-f', name], { timeout: 10_000 }); } catch { /* already gone */ }
}

async function dockerLogs(name: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', '500', name], { timeout: 10_000 });
    return stdout + stderr;
  } catch { return ''; }
}

async function dockerPull(image: string): Promise<void> {
  await execFileAsync('docker', ['pull', image], { timeout: 300_000 });
}

// ─── Config inference ──────────────────────────────────────────────────────

function readYaml(file: string): Record<string, any> | null {
  try {
    let content = fs.readFileSync(file, 'utf8');
    // mme.yaml uses duplicate `map:` keys (Open5GS's own non-standard extension
    // for expressing multiple TAI→LAI mappings under sgsap.client) — invalid
    // per the YAML spec, which js-yaml correctly rejects. Without this, a
    // config with >1 PLMN mapped for SGs/CSFB throws here, silently loses the
    // ENTIRE mme: block (not just sgsap), and every MME-derived value below
    // falls back to its hardcoded default — including mmeIp, which broke 4G
    // UE validation by pointing simulated eNBs at the wrong address. See the
    // same transform in yaml-config-repository.ts (the canonical fix).
    if (file.endsWith('mme.yaml')) content = convertRepeatedMapKeysToArray(content);
    return jsyaml.load(content) as Record<string, any>;
  } catch (err) {
    moduleLogger.warn({ file, err: String(err) }, 'Config file not found or failed to parse — falling back to defaults for this file');
    return null;
  }
}

function inferConfig(): InferredConfig {
  const amf  = readYaml(path.join(OPEN5GS_DIR, 'amf.yaml'))?.amf   ?? {};
  const mme  = readYaml(path.join(OPEN5GS_DIR, 'mme.yaml'))?.mme   ?? {};
  const smf  = readYaml(path.join(OPEN5GS_DIR, 'smf.yaml'))?.smf   ?? {};
  const upf  = readYaml(path.join(OPEN5GS_DIR, 'upf.yaml'))?.upf   ?? {};
  const pgwu = readYaml(path.join(OPEN5GS_DIR, 'pgwu.yaml'))?.pgwu ?? {};
  const pgwc = readYaml(path.join(OPEN5GS_DIR, 'pgwc.yaml'))?.pgwc
            ?? readYaml(path.join(OPEN5GS_DIR, 'smf.yaml'))?.smf
            ?? {};

  // ── PLMN ──
  const plmnRaw = amf.plmn_support?.[0]?.plmn_id
               ?? mme.tai?.[0]?.plmn_id
               ?? mme.gummei?.[0]?.plmn_id
               ?? { mcc: '999', mnc: '70' };
  const plmn = {
    mcc: String(plmnRaw.mcc),
    mnc: String(plmnRaw.mnc).padStart(2, '0'),
  };

  // ── 5G AMF ──
  const ngapServers = amf.ngap?.server ?? [];
  const amfIp = ngapServers[0]?.address ?? '127.0.0.5';

  // ── UPF (5G) / PGWU (4G) ──
  const upfGtpu = upf.gtpu?.server ?? upf.gtpu ?? [];
  const pgwuGtpu = pgwu.gtpu?.server ?? pgwu.gtpu ?? [];
  const upfIp = (Array.isArray(upfGtpu) ? upfGtpu[0]?.address : null)
             ?? (Array.isArray(pgwuGtpu) ? pgwuGtpu[0]?.address : null)
             ?? '127.0.0.7';

  const tai5g = amf.tai?.[0] ?? amf.tai ?? {};
  const tac5g = Number(tai5g.tac ?? 1);

  const nssaiRaw = amf.plmn_support?.[0]?.s_nssai ?? amf.slice ?? [{ sst: 1 }];
  const slices: Array<{ sst: number; sd?: string }> = nssaiRaw.map((s: any) => ({
    sst: Number(s.sst ?? 1),
    sd: s.sd !== undefined && s.sd !== null
      ? String(s.sd).padStart(6, '0')
      : undefined,
  }));

  const smfSessions = smf.session ?? smf.subnet ?? [];
  const dnns: string[] = smfSessions.length > 0
    ? [...new Set<string>(smfSessions.map((s: any) => s.dnn ?? s.apn ?? s.name).filter(Boolean))]
    : ['internet'];

  const subnets: DnnSubnet[] = smfSessions
    .filter((s: any) => s.subnet)
    .map((s: any) => ({
      dnn: s.dnn ?? s.apn ?? s.name ?? 'internet',
      cidr: s.subnet as string,
      gateway: s.gateway ?? s.subnet.split('/')[0].replace(/\.\d+$/, '.1'),
    }));

  // ── 4G MME ──
  const s1apServers = mme.s1ap?.server ?? [];
  const mmeIp = s1apServers[0]?.address ?? '127.0.0.2';

  const tai4g = mme.tai?.[0] ?? {};
  const tac4g = Number(tai4g.tac ?? 1);

  const gummei = mme.gummei?.[0] ?? {};
  const mmeGroupId = Number(gummei.mme_gid ?? 2);
  const mmeCode = Number(gummei.mme_code ?? 1);

  const pgwSessions = pgwc.session ?? pgwc.subnet ?? smfSessions;
  const apns: string[] = pgwSessions.length > 0
    ? [...new Set<string>(pgwSessions.map((s: any) => s.apn ?? s.dnn ?? s.name).filter(Boolean))]
    : dnns;

  return { plmn, amfIp, upfIp, tac5g, slices, dnns, subnets, mmeIp, tac4g, mmeGroupId, mmeCode, apns };
}

// ─── Config file generators ────────────────────────────────────────────────

function buildGnbYaml(idx: number, cfg: InferredConfig, params: any, ngapBindIp: string): string {
  const { mcc, mnc } = cfg.plmn;
  // linkIp = gtpIp: loopback alias (127.0.3.x).
  //   All of 127.0.0.0/8 routes to lo on Linux — bindable without aliases.
  //   Nothing in Open5GS uses 127.0.3.x so port 2152 is free here.
  //   The UPF is on the same host and can route back to 127.0.3.x.
  //   ngapIp MUST be a real, routable, PER-GNB address — SCTP can't route
  //   from a loopback source, and reusing the AMF's own address makes every
  //   gNB indistinguishable to Open5GS (which keys gNB identity by peer IP
  //   and rejects a second connection from a duplicate IP). ngapBindIp is
  //   this radio's dedicated dummy /32 — see allocateRadioDummyIp().
  const linkIp = `${GNB_BASE}.${idx + 1}`;
  const amfAddr = params.amfIp ?? cfg.amfIp;
  const slice = cfg.slices[0];
  const nci = `0x${(idx + 1).toString(16).padStart(9, '0')}`;

  const sliceEntry: Record<string, any> = { sst: slice.sst };
  if (slice.sd) sliceEntry.sd = parseInt(slice.sd, 16);

  return jsyaml.dump({
    mcc, mnc,
    nci,
    idLength: 32,
    tac: cfg.tac5g,
    linkIp,
    ngapIp: ngapBindIp,
    gtpIp: linkIp,
    amfConfigs: [{ address: amfAddr, port: 38412 }],
    slices: [sliceEntry],
    ignoreStreamIds: true,
  });
}

function buildUeYaml(
  imsi: string, k: string, opc: string,
  gnbIp: string, cfg: InferredConfig, params: any,
): string {
  const { mcc, mnc } = cfg.plmn;
  const slice = cfg.slices[0];
  const dnn = params.dnn ?? cfg.dnns[0] ?? 'internet';
  const imei = '35' + String(Math.floor(Math.random() * 1e13)).padStart(13, '0');

  const sliceEntry: Record<string, any> = { sst: slice.sst };
  if (slice.sd) sliceEntry.sd = parseInt(slice.sd, 16);

  const sessionEntry: Record<string, any> = { type: 'IPv4', apn: dnn, slice: { ...sliceEntry } };

  return jsyaml.dump({
    supi: `imsi-${imsi}`,
    mcc, mnc,
    key: k,
    op: opc,
    opType: 'OPC',
    amf: '8000',
    imei,
    imeiSv: '4370816125816151',
    gnbSearchList: [gnbIp],
    uacAic: { mps: false, mcs: false },
    uacAcc: { normalClass: 0, class11: false, class12: false, class13: false, class14: false, class15: false },
    initialSel: { ...sliceEntry },
    sessions: [sessionEntry],
    'configured-nssai': [{ ...sliceEntry }],
    'default-nssai': [{ ...sliceEntry }],
    integrity: { IA1: true, IA2: true, IA3: true },
    ciphering: { EA1: true, EA2: true, EA3: true },
    integrityMaxRate: { uplink: 'full', downlink: 'full' },
  });
}

// Each 4G UE gets its own dedicated eNB (1:1 pairing).
// srsRAN ZMQ uses point-to-point I/Q streams; nof_ports=1 (TM1) is the only
// valid antenna config when serving a single UE per eNB via ZMQ loopback.
// Port allocation: eNB N uses tcp ports (2000+N*2) tx and (2001+N*2) rx.
// s1c_bind_addr=0.0.0.0: 127.0.4.x can't make SCTP connections to the MME's
// dummy-interface IP (loopback→non-loopback routing is blocked by the kernel).
function buildEnbConf(ueRelIdx: number, cfg: InferredConfig, params: any, s1cBindIp: string): string {
  const gtpIp  = `${ENB_BASE}.${ueRelIdx + 1}`;
  const enbId = (ueRelIdx + 1).toString(16).padStart(3, '0').toUpperCase();
  const txPort = 2000 + ueRelIdx * 2;
  const rxPort = txPort + 1;

  // n_prb=25 (5 MHz, 5.76 MS/s). This used to be 6 (1.4 MHz, 1.92 MS/s) on
  // the assumption that attach validation only needs enough PRBs for NAS to
  // complete, not real bandwidth. That assumption missed idle-mode paging:
  // a 6-PRB cell's PDCCH/PUCCH is so narrow the scheduler can't fit a Paging
  // message at all ("Could not allocate Paging ... No space available in
  // PUCCH or PDCCH" — reproduced live, MME retried S1AP Paging 3x and gave
  // up every time). 25 PRB is the next standard srsRAN step up and gives
  // enough control-channel capacity for paging to actually go out over the
  // air, at ~3x the CPU cost of 6 PRB rather than 50's ~10x.
  //
  // s1c_bind_addr used to be 0.0.0.0, which the kernel resolves to the
  // host's one real IP for an outbound connection — the SAME IP the MME
  // itself listens on. Open5GS keys eNB identity by peer IP and rejects a
  // second connection from a duplicate IP ("gNB context duplicated..." /
  // mirrored for eNB in mme-sm.c), so multiple simulated eNBs collided with
  // each other and with the MME. s1cBindIp is this eNB's own dedicated
  // dummy /32 instead — see allocateRadioDummyIp().
  return `
[enb_files]
rr_config = /config/rr.conf

[enb]
enb_id = 0x${enbId}
name = TestENB${ueRelIdx + 1}
mcc = ${cfg.plmn.mcc}
mnc = ${cfg.plmn.mnc}
mme_addr = ${cfg.mmeIp}
gtp_bind_addr = ${gtpIp}
s1c_bind_addr = ${s1cBindIp}
s1c_bind_port = 0
n_prb = 25
nof_ports = 1

[rf]
device_name = zmq
device_args = tx_port=tcp://*:${txPort},rx_port=tcp://localhost:${rxPort},id=enb,base_srate=5.76e6

[pcap]
enable = false

[log]
all_level = info
filename = stdout

[scheduler]
max_aggr_level = 3

[expert]
nof_phy_threads = 1
metrics_period_secs = 2
`.trim();
}

// Minimal rr.conf with the correct TAC for the MME.
// Only the cell_list tac field is customized; all other radio params stay at defaults.
function buildRrConf(cfg: InferredConfig): string {
  const tac = `0x${cfg.tac4g.toString(16).padStart(4, '0')}`;
  return `
mac_cnfg =
{
  phr_cnfg = { dl_pathloss_change = "dB3"; periodic_phr_timer = 50; prohibit_phr_timer = 0; };
  ulsch_cnfg = { max_harq_tx = 4; periodic_bsr_timer = 20; retx_bsr_timer = 320; };
  time_alignment_timer = -1;
};

phy_cnfg =
{
  phich_cnfg = { duration = "Normal"; resources = "1/6"; };
  pusch_cnfg_ded = { beta_offset_ack_idx = 6; beta_offset_ri_idx = 6; beta_offset_cqi_idx = 6; };
  sched_request_cnfg = { dsr_trans_max = 64; period = 20; nof_prb = 1; };
  cqi_report_cnfg = { mode = "periodic"; simultaneousAckCQI = true; period = 40; m_ri = 8; };
};

cell_list =
(
  {
    cell_id = 0x01;
    tac = ${tac};
    pci = 1;
    dl_earfcn = 3350;
    ho_active = false;
    scell_list = ();
    meas_cell_list = ();
    meas_report_desc = ();
    meas_quant_desc = { rsrq_config = 4; rsrp_config = 4; };
  }
);

nr_cell_list = ();
`.trim();
}

function buildUeConf(imsi: string, k: string, opc: string, ueRelIdx: number, cfg: InferredConfig, params: any): string {
  // UE N pairs with eNB N: swap tx/rx relative to eNB's ports
  const enbTxPort = 2000 + ueRelIdx * 2;
  const enbRxPort = enbTxPort + 1;
  const apn  = params.apn ?? cfg.apns[0] ?? 'internet';
  const netns = `ue4g_${ueRelIdx}`;
  const imei = '35' + String(Math.floor(Math.random() * 1e13)).padStart(13, '0');

  // release=15 (the srsue default) advertises the full modern UE-EUTRA-
  // Capability IE set (CA, LAA, eMTC, NB-IoT, ...). srsue's ASN.1 encoder
  // for that IE is broken in this image — encoding it throws ~25 repeated
  // "condition lb <= n <= ub (1 <= 0 <= 1024) was not met" / "Encoding
  // failure" errors (uecap.cc) and "Error packing EUTRA capabilities", so
  // it silently never sends ueCapabilityInformation back to the eNB.
  // That's not fatal for the very first attach, but it IS fatal for
  // idle-mode paging: on a paging-triggered re-establishment, the eNB's
  // InitialContextSetupRequest handling waits on
  // ueCapabilityEnquiry/-Information before it will reply with
  // InitialContextSetupResponse. With the UE never able to answer, the
  // eNB just hangs — MME never gets a response, never sends the GTPv2
  // Downlink Data Notification Ack to SGW-C, and the whole idle-wake chain
  // times out (reproduced live: ping to an idle UE always 100% loss
  // despite paging + Service Request succeeding). release=8 advertises a
  // far smaller, simpler capability set that avoids the buggy encoding
  // path entirely. NOTE: this file is srsue's own INI-style config format —
  // it does NOT support `//` comments (breaks the parser: "unrecognised
  // option"), only `;`/`#`, so this explanation has to live here in the TS
  // source rather than inline in the template below.

  return `
[rf]
device_name = zmq
device_args = tx_port=tcp://*:${enbRxPort},rx_port=tcp://localhost:${enbTxPort},id=ue,base_srate=5.76e6

[usim]
mode = soft
algo = milenage
opc  = ${opc}
k    = ${k}
imsi = ${imsi}
imei = ${imei}

[rrc]
release  = 8
ue_category = 4

[nas]
apn = ${apn}
apn_protocol = ipv4

[gw]
netns = ${netns}

[log]
all_level = info
filename = stdout
`.trim();
}

// ─── Run scripts ────────────────────────────────────────────────────────────

const RUN_5G = `#!/bin/bash
set -e
export PATH=/ueransim:$PATH
echo "[VALIDATION] Starting 5G simulation"
> /logs/gnb.log
> /logs/ue.log
mkdir -p /run/netns /tmp/moved-tun
for cfg in /config/gnb*.yaml; do
    echo "[VALIDATION] Starting gNB: $cfg"
    /ueransim/nr-gnb -c "$cfg" >> /logs/gnb.log 2>&1 &
done
sleep 3

# UERANSIM has no per-interface netns option (unlike srsue's [gw] netns= —
# see buildEnbConf/RUN_4G below). nr-ue always creates its uesimtunN TUN
# device in the process's own namespace, which here is the shared host root
# namespace (--network=host). Left there, the UE's assigned IP becomes a
# "local" route on the host, so a validation ping to it resolves via
# loopback instead of the real N3/UPF path — a false-positive self-answer
# that never touches the core network — and it litters the host route table
# besides. This watcher relocates each uesimtunN into its own netns as soon
# as it appears (created once the PDU session comes up); moving a device
# only changes which namespace it's visible in, so nr-ue's already-open file
# descriptor to it keeps working with no cooperation needed from nr-ue itself.
# IMPORTANT: \`ip link set dev netns\` strips the device's IPv4 address as
# part of the move (only the IPv6 link-local address survives, regenerated
# fresh in the new namespace) — reproduced live: after the move,
# \`uesimtun0\` had only an fe80:: address, no IPv4 at all, so the UE was
# simply unreachable by either path. Capture the address before moving and
# re-add it inside the target namespace afterward.
(
    while true; do
        for ifc in $(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep '^uesimtun'); do
            if [ ! -e "/tmp/moved-tun/$ifc" ]; then
                idx=$(echo "$ifc" | sed 's/uesimtun//')
                ns="v5ue-$idx"
                addr=$(ip -4 -o addr show dev "$ifc" 2>/dev/null | awk '{print $4}')
                ip netns add "$ns" 2>/dev/null || true
                if ip link set "$ifc" netns "$ns" 2>/dev/null; then
                    ip netns exec "$ns" ip link set "$ifc" up 2>/dev/null || true
                    if [ -n "$addr" ]; then
                        ip netns exec "$ns" ip addr add "$addr" dev "$ifc" 2>/dev/null || true
                    fi
                    echo "[VALIDATION] Isolated $ifc ($addr) into netns $ns" >> /logs/gnb.log
                    touch "/tmp/moved-tun/$ifc"
                fi
            fi
        done
        sleep 1
    done
) &

for cfg in $(ls /config/ue*.yaml 2>/dev/null | sort); do
    echo "[VALIDATION] Starting UE: $cfg"
    /ueransim/nr-ue -c "$cfg" >> /logs/ue.log 2>&1 &
    sleep 0.3
done
echo "[VALIDATION] All instances started, monitoring..."
wait
`;

const RUN_4G = `#!/bin/bash
set -e
echo "[VALIDATION] Starting 4G simulation"
> /logs/gnb.log
> /logs/ue.log

# srsue's [gw] netns=... (see buildUeConf) is supposed to isolate its TUN
# device into its own namespace, but the srsran4g-noavx image ships with no
# iproute2 at all — \`ip netns add\` below was silently no-opping every run
# (guarded by \`|| true\`), so that namespace never actually existed. Without
# it, srsue's gw/TUN setup can't complete: downlink data still gets
# decrypted fine at RLC/PDCP (confirmed live via packet capture — GTP-U
# packets reach the eNB and get forwarded over the air), but never reaches
# a working kernel IP stack to generate a reply, so ping to a UE that's
# just been successfully paged and re-attached still always failed. Installing
# it here (once per container start, ~few seconds) fixes that without needing
# to touch the externally-maintained base image.
apt-get update -qq && apt-get install -y -qq --no-install-recommends iproute2 >> /logs/gnb.log 2>&1 \\
    || echo "[VALIDATION] WARNING: iproute2 install failed — UE netns isolation (and its downlink reply path) will not work" >> /logs/gnb.log

mkdir -p /run/netns
for cfg in /config/enb*.conf; do
    echo "[VALIDATION] Starting eNB: $cfg"
    nice -n 10 srsenb "$cfg" >> /logs/gnb.log 2>&1 &
done
sleep 5
for cfg in $(ls /config/ue*.conf 2>/dev/null | sort); do
    echo "[VALIDATION] Starting UE: $cfg"
    ns=$(grep 'netns' "$cfg" | awk -F= '{print $2}' | tr -d ' ')
    if [ -n "$ns" ]; then
        ip netns del "$ns" 2>/dev/null || true
        ip netns add "$ns" 2>/dev/null || true
    fi
    nice -n 10 srsue "$cfg" >> /logs/ue.log 2>&1 &
    sleep 0.5
done
echo "[VALIDATION] All instances started, monitoring..."
wait
`;

// ─── IMSI / subscriber helpers ────────────────────────────────────────────

// Find the highest numeric IMSI currently in MongoDB, then allocate a
// contiguous block above it for this test session.
// Scan all subscriber records and collect every assigned UE IPv4 as a numeric set.
async function collectUsedIps(subscriberRepo: ISubscriberRepository): Promise<Set<number>> {
  const used = new Set<number>();
  const all  = await subscriberRepo.findAllFull();
  for (const sub of all) {
    for (const slice of sub.slice ?? []) {
      for (const session of slice.session ?? []) {
        if (session.ue?.ipv4) used.add(ipToNum(session.ue.ipv4));
      }
    }
  }
  return used;
}

// Find the first contiguous block of `count` free IPs within the DNN's subnet.
// Excludes the gateway address.  Throws if no block is found.
async function allocateIpBlock(
  count: number,
  dnn: string,
  subnets: DnnSubnet[],
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
): Promise<string> {
  // Pick the subnet for the requested DNN, fall back to first available.
  const sub = subnets.find(s => s.dnn === dnn) ?? subnets[0];
  if (!sub) throw new Error(`No subnet configured in smf.yaml for DNN "${dnn}"`);

  const { first, last } = cidrRange(sub.cidr);
  const gw   = ipToNum(sub.gateway);
  const used = await collectUsedIps(subscriberRepo);

  logger.info({ dnn, cidr: sub.cidr, gateway: sub.gateway, usedCount: used.size },
    'Scanning for free IP block');

  let blockStart = -1;
  let consecutive = 0;

  for (let ip = first; ip <= last; ip++) {
    if (ip === gw || used.has(ip)) {
      blockStart  = -1;
      consecutive = 0;
    } else {
      if (consecutive === 0) blockStart = ip;
      consecutive++;
      if (consecutive >= count) return numToIp(blockStart);
    }
  }

  throw new Error(
    `No contiguous block of ${count} free IPs in ${sub.cidr} (${used.size} already assigned)`
  );
}

// ─── IMSI / subscriber helpers ────────────────────────────────────────────

// Safety invariant: we ONLY ever delete subscribers whose nickname starts
// with VAL_NICKNAME_PREFIX — this is enforced in safeDeleteTestImsi().
async function allocateImsiBlock(
  count: number,
  subscriberRepo: ISubscriberRepository,
): Promise<string> {
  const top = await subscriberRepo.findAll(0, 1, 'desc', 'imsi');
  const highestImsi = top[0]?.imsi ?? '000000000000000';
  const base = BigInt(highestImsi) + 1n;
  return base.toString().padStart(15, '0');
}

function makeImsi(baseImsi: string, idx: number): string {
  return (BigInt(baseImsi) + BigInt(idx)).toString().padStart(15, '0');
}

function makeSubscriber(
  imsi: string, k: string, opc: string,
  sessionId: string, idx: number,
  ueIp: string,
  cfg: InferredConfig, params: any,
): Subscriber {
  const slice = cfg.slices[0];
  const dnn = params.dnn ?? params.apn ?? cfg.dnns[0] ?? 'internet';
  const nickname = `${VAL_NICKNAME_PREFIX}${sessionId.slice(0, 6)}-UE${String(idx + 1).padStart(3, '0')}`;
  return {
    imsi,
    nickname,
    msisdn: [],
    security: { k, opc, amf: '8000' },
    ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
    slice: [{
      sst: slice.sst,
      sd: slice.sd,
      default_indicator: true,
      session: [{
        name: dnn,
        type: 3,
        ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
        qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
        pcc_rule: [],
        ue: { ipv4: ueIp },
      }],
    }],
    subscribed_rau_tau_timer: 12,
    subscriber_status: 0,
    access_restriction_data: 32,
    network_access_mode: 0,
  };
}

// ─── Log parser for UE state ──────────────────────────────────────────────
//
// All nr-ue processes write to the same ue.log file concurrently, so output
// is fully interleaved.  The only reliable per-UE anchor is the TUN interface
// name: the kernel assigns uesimtun0, uesimtun1, … in the order processes call
// TUNSETIFF, which matches launch order (= IMSI index) since run.sh starts
// UEs sequentially with a small sleep between each.
//
// Actual log patterns (UERANSIM v3.3.0):
//   [app] [info] Connection setup for PDU session[1] is successful, TUN interface[uesimtun0, 10.45.0.2] is up.
//   [nas] [info] Initial Registration is successful
//
function parseUeStates(
  logs: string,
  type: '5g' | '4g',
  imsis: string[],
  ipToImsi: Record<string, string> = {},
): Record<string, Partial<UeStatus>> {
  const updates: Record<string, Partial<UeStatus>> = {};
  const lines = logs.split('\n');

  if (type === '5g') {
    // ── 5G (UERANSIM) ──────────────────────────────────────────────────────
    // All nr-ue processes are interleaved in one file.
    // uesimtunN index == UE launch index == IMSI index (kernel assigns sequentially).
    for (const line of lines) {
      const tunMatch = line.match(/TUN interface\[uesimtun(\d+),\s*([\d.]+)\]/i);
      if (tunMatch) {
        const idx  = Number(tunMatch[1]);
        const ip   = tunMatch[2];
        const imsi = imsis[idx];
        if (imsi) updates[imsi] = { state: 'session_established', ip };
      }
    }

    // Count-based fallback for UEs that registered but haven't got TUN yet.
    let regCount = 0;
    let pduCount = 0;
    for (const line of lines) {
      if (/Initial Registration is successful/i.test(line)) regCount++;
      if (/PDU Session establishment is successful/i.test(line)) pduCount++;
    }
    for (let i = 0; i < imsis.length; i++) {
      const imsi = imsis[i];
      if (updates[imsi]?.state === 'session_established') continue;
      if (i < pduCount)  updates[imsi] = { state: 'session_established' };
      else if (i < regCount) updates[imsi] = { state: 'registered' };
    }

  } else {
    // ── 4G (srsRAN srsue) ──────────────────────────────────────────────────
    // srsue does NOT print IMSI on every line.
    // "Network attach successful. IP: X.X.X.X" is the key success line.
    // We match the assigned IP back to the IMSI (static IPs from MongoDB).
    // Count-based fallback covers RRC-connected-but-not-attached UEs.
    for (const line of lines) {
      // Full attach with IP — matches both:
      //   "Network attach successful. IP: X.X.X.X"
      //   "Network attach successful. APN: xxx, IP: X.X.X.X"
      const attachMatch = line.match(/Network attach successful.*?IP[:\s]+([\d.]+)/i);
      if (attachMatch) {
        const ip   = attachMatch[1];
        const imsi = ipToImsi[ip];
        if (imsi) updates[imsi] = { state: 'session_established', ip };
        continue;
      }
      // PDN connected (alternative phrasing)
      const pdnMatch = line.match(/PDN connection established.*IP[:\s]+([\d.]+)/i);
      if (pdnMatch) {
        const ip   = pdnMatch[1];
        const imsi = ipToImsi[ip];
        if (imsi) updates[imsi] = { state: 'session_established', ip };
      }
    }

    // Count-based fallback for RRC-connected UEs not yet fully attached
    let rrcCount = 0;
    let attachCount = 0;
    for (const line of lines) {
      if (/RRC Connected|NAS.*EMM-REGISTERED/i.test(line)) rrcCount++;
      if (/Network attach successful/i.test(line)) attachCount++;
    }
    for (let i = 0; i < imsis.length; i++) {
      const imsi = imsis[i];
      if (updates[imsi]?.state === 'session_established') continue;
      if (i < attachCount)    updates[imsi] = { state: 'session_established' };
      else if (i < rrcCount)  updates[imsi] = { state: 'registered' };
    }
  }

  return updates;
}

// ─── Session cleanup ──────────────────────────────────────────────────────

// Only deletes a subscriber if it was created by the validation harness.
// This is the hard safety guard — a real subscriber can never be removed here.
async function safeDeleteTestImsi(
  imsi: string,
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
): Promise<boolean> {
  const existing = await subscriberRepo.findByImsi(imsi);
  if (!existing) return true; // already gone
  if (!existing.nickname?.startsWith(VAL_NICKNAME_PREFIX)) {
    logger.error({ imsi, nickname: existing.nickname },
      'SAFETY BLOCK: refusing to delete subscriber — not a VAL-TEST IMSI');
    return false;
  }
  await subscriberRepo.delete(imsi);
  return true;
}

async function stopSession(
  session: Session,
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
) {
  session.status = 'stopping';
  broadcast('session', { id: session.id, status: 'stopping' });

  // Kill containers
  for (const name of session.containers) {
    try { await dockerKill(name); } catch (e) {
      logger.warn({ name, err: String(e) }, 'Failed to kill container');
    }
  }

  // Tear down per-radio dummy interfaces (best-effort — deleteDummyInterface
  // is a no-op if the interface is already gone, so a double-stop is safe).
  for (const name of session.dummyInterfaces) {
    try { await deleteDummyInterface(name); } catch (e) {
      logger.warn({ name, err: String(e) }, 'Failed to delete dummy interface');
    }
  }

  // Remove test subscribers — safety-checked per IMSI
  let cleaned = 0;
  for (const imsi of session.imsis) {
    try {
      if (await safeDeleteTestImsi(imsi, subscriberRepo, logger)) cleaned++;
    } catch { /* ok */ }
  }
  logger.info({ sessionId: session.id, cleaned }, 'Test subscribers removed');

  // Clean up config dir
  const dir = path.join(VALIDATION_DIR, session.id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  clearLogReadOffsets(dir);

  session.status = 'stopped';
  session.containers = [];
  session.dummyInterfaces = [];
  broadcast('session', { id: session.id, status: 'stopped', ueStatuses: session.ueStatuses });
}

// ─── UE state polling ──────────────────────────────────────────────────────
//
// Watches each container's per-radio-type ue.log (see logs5g/logs4g split
// above) and updates session.ueStatuses as UEs progress through attach.
// Extracted from the /start handler so reconcileOrphanedSessions() below can
// restart polling for a session adopted after a backend restart, without
// needing the original request params — imsis are grouped by the type
// already recorded on each ueStatuses entry rather than by total5G/total4G.
function startPolling(session: Session, logger: pino.Logger): void {
  const sessionDir = path.join(VALIDATION_DIR, session.id);
  const all5gImsis = session.imsis.filter(imsi => session.ueStatuses[imsi]?.type === '5g');
  const all4gImsis = session.imsis.filter(imsi => session.ueStatuses[imsi]?.type === '4g');

  const pollInterval = setInterval(async () => {
    if (session.status !== 'running') {
      clearInterval(pollInterval);
      return;
    }

    // Build IP→IMSI map from provisioned static IPs for 4G attach matching
    const ipToImsi: Record<string, string> = {};
    for (const st of Object.values(session.ueStatuses)) {
      if (st.ip) ipToImsi[st.ip] = st.imsi;
    }

    for (const name of session.containers) {
      const type: '5g' | '4g' = name.includes('-5g-') ? '5g' : '4g';
      const imsis = type === '5g' ? all5gImsis : all4gImsis;

      // Binaries write to /logs/ue.log (not container stdout) — read the
      // per-radio-type file directly, incrementally (see readLogSince() for
      // why a fixed tail isn't safe here).
      const ueLogPath = path.join(sessionDir, type === '5g' ? 'logs5g' : 'logs4g', 'ue.log');
      const ueLogContent = readLogSince(ueLogPath);
      const updates = parseUeStates(ueLogContent, type, imsis, ipToImsi);

      let changed = false;
      for (const [imsi, update] of Object.entries(updates)) {
        const existing = session.ueStatuses[imsi];
        if (existing) {
          // The count-based fallback in parseUeStates() re-derives state from
          // how many matching lines appear in the current read. With
          // readLogSince() giving only the bytes new since the last tick
          // (not the whole history), that count is per-chunk, not
          // cumulative — for a multi-UE session, a chunk touching only a
          // later-indexed UE could otherwise compute a weaker state for an
          // earlier index and downgrade a UE that's already
          // session_established back to registered. State only ever moves
          // forward. (The primary per-UE matches — 4G by IP, 5G by TUN
          // index — aren't order-dependent and don't have this issue; this
          // guard only matters for the fallback.)
          if (update.state && STATE_RANK[update.state] < STATE_RANK[existing.state]) {
            delete update.state;
          }
          const merged = { ...existing, ...update };
          if (JSON.stringify(merged) !== JSON.stringify(existing)) {
            session.ueStatuses[imsi] = merged;
            changed = true;
          }
        }
      }

      // Check if container is still running
      try {
        const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.State.Status}}', name], { timeout: 5000 });
        if (stdout.trim() === 'exited') {
          logger.warn({ name }, 'Container exited unexpectedly');
          // Mark remaining 'starting' UEs as failed
          for (const imsi of imsis) {
            if (session.ueStatuses[imsi]?.state === 'starting') {
              session.ueStatuses[imsi] = { ...session.ueStatuses[imsi], state: 'failed', error: 'Container exited' };
              changed = true;
            }
          }
        }
      } catch { /* container gone */ }

      if (changed) {
        persistSession(session);
        broadcast('session', { id: session.id, status: session.status, ueStatuses: session.ueStatuses });
      }
    }
  }, 3000);
}

async function listRunningValContainers(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('docker', ['ps', '--filter', 'name=ue-val-', '--format', '{{.Names}}'], { timeout: 10_000 });
    return new Set(stdout.trim().split('\n').filter(Boolean));
  } catch { return new Set(); }
}

// Runs once at backend startup — see persistSession()'s comment for why this
// is needed. Any session directory whose snapshot lists a container that's
// still alive gets re-adopted into the in-memory `sessions` Map and its
// polling loop restarted. Sessions with no surviving containers are left on
// disk (their logs may still be useful) but not re-added to the live map —
// however their dummy interfaces (session.dummyInterfaces) ARE torn down here,
// since nothing else will ever do that for a session that's no longer tracked
// in memory: without this, every backend restart that catches a session
// between "containers exited" and "user clicked stop" leaks that session's
// v4-*/v5-* dummy interfaces permanently.
async function reconcileOrphanedSessions(logger: pino.Logger): Promise<void> {
  if (!fs.existsSync(VALIDATION_DIR)) return;
  const running = await listRunningValContainers();

  for (const entry of fs.readdirSync(VALIDATION_DIR)) {
    const file = path.join(VALIDATION_DIR, entry, SESSION_FILE);
    if (!fs.existsSync(file)) continue;
    try {
      const session = JSON.parse(fs.readFileSync(file, 'utf8')) as Session;
      const liveContainers = session.containers.filter(name => running.has(name));

      if (liveContainers.length === 0) {
        // Fully stopped before this restart — not re-adopted (logs stay on disk), but its
        // dummy interfaces would otherwise never get cleaned up again.
        for (const name of session.dummyInterfaces ?? []) {
          try { await deleteDummyInterface(name); } catch { /* already gone, fine */ }
        }
        continue;
      }

      session.containers = liveContainers;
      session.status = 'running';
      sessions.set(session.id, session);
      step(session, 'Backend restarted — re-adopted still-running validation session', logger);
      startPolling(session, logger);
      logger.info({ sessionId: session.id, containers: liveContainers }, 'Re-adopted orphaned validation session');
    } catch (e) {
      logger.warn({ entry, err: String(e) }, 'Failed to reconcile validation session dir');
    }
  }

  // Belt-and-suspenders: any v4-*/v5-* interface on the host that isn't accounted for by a
  // just-re-adopted live session is orphaned by definition (e.g. left over from before this
  // fix existed, or its session directory was already removed entirely) — clean it up too.
  const liveInterfaceNames = new Set(
    [...sessions.values()].flatMap(s => s.dummyInterfaces ?? []),
  );
  const leftover = (await listOrphanedValidationDummyInterfaces())
    .filter(name => !liveInterfaceNames.has(name));
  for (const name of leftover) {
    try {
      await deleteDummyInterface(name);
      logger.info({ name }, 'Removed orphaned validation dummy interface with no live session');
    } catch { /* ok */ }
  }
}

// ─── Router ───────────────────────────────────────────────────────────────

export function createValidationRouter(subscriberRepo: ISubscriberRepository, logger: pino.Logger): Router {
  const router = Router();

  // GET /api/validation/infer — read Open5GS config and return defaults
  router.get('/infer', (req: Request, res: Response) => {
    try {
      const cfg = inferConfig();
      res.json({ ok: true, config: cfg });
    } catch (err) {
      logger.error({ err }, 'Config inference failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // GET /api/validation/capacity — detected host specs + a rough suggested
  // ceiling for eNB/gNB counts, so the UI can warn (not block) before a
  // session is started. costPerEnbPair/costPerGnb below are ballpark
  // estimates for real-time DSP load at n_prb=25 on non-AVX hardware — not a
  // precise model, just enough to catch grossly oversized requests.
  router.get('/capacity', (_req: Request, res: Response) => {
    try {
      const capacity = detectHostCapacity();
      const budget = computeResourceBudget(capacity, true, true);
      const costPerEnbPair = 0.9; // CPU-equivalent per 4G eNB+UE pair (n_prb=25, ~3x the old n_prb=6 estimate)
      const costPerGnb     = 0.15; // CPU-equivalent per 5G gNB
      res.json({
        ok: true,
        cores: capacity.cores,
        totalMemGB: Math.round(capacity.totalMemGB * 10) / 10,
        recommended4G: { enb: Math.max(1, Math.floor(budget.cpus4G / costPerEnbPair)), uePerEnb: 1 },
        recommended5G: { gnb: Math.max(1, Math.floor(budget.cpus5G / costPerGnb)), uePerGnb: 5 },
      });
    } catch (err) {
      logger.error({ err }, 'Capacity detection failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // GET /api/validation/sessions — list active sessions
  router.get('/sessions', (req: Request, res: Response) => {
    const list = Array.from(sessions.values()).map(s => ({
      id: s.id,
      startedAt: s.startedAt,
      status: s.status,
      imsiCount: s.imsis.length,
      containerCount: s.containers.length,
      ueStatuses: s.ueStatuses,
      error: s.error,
      logs: s.logs,
    }));
    res.json({ ok: true, sessions: list });
  });

  // GET /api/validation/logs/:id — full step log for a session
  router.get('/logs/:id', (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return void res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, logs: session.logs, error: session.error });
  });

  // GET /api/validation/events — SSE stream
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);

    // Send current state immediately including logs for any active/failed sessions
    const list = Array.from(sessions.values()).map(s => ({
      id: s.id, startedAt: s.startedAt, status: s.status,
      ueStatuses: s.ueStatuses, error: s.error, logs: s.logs,
    }));
    res.write(`event: init\ndata: ${JSON.stringify(list)}\n\n`);

    req.on('close', () => sseClients.delete(res));
  });

  // POST /api/validation/start — create and start a test session
  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const {
      enable5G = true, enable4G = false,
      gnbCount = 1, gnbUeCount = 5,
      enbCount = 1, enbUeCount = 5,
      sliceOverride, dnnOverride, apnOverride,
      amfIpOverride, upfIpOverride,
    } = req.body as {
      enable5G?: boolean; enable4G?: boolean;
      gnbCount?: number; gnbUeCount?: number;
      enbCount?: number; enbUeCount?: number;
      sliceOverride?: { sst: number; sd?: string };
      dnnOverride?: string; apnOverride?: string;
      amfIpOverride?: string; upfIpOverride?: string;
    };

    const sessionId = crypto.randomBytes(6).toString('hex');
    const sessionDir = path.join(VALIDATION_DIR, sessionId);

    const session: Session = {
      id: sessionId,
      startedAt: new Date(),
      status: 'provisioning',
      containers: [],
      dummyInterfaces: [],
      imsis: [],
      ueStatuses: {},
      logs: [],
    };
    sessions.set(sessionId, session);
    broadcast('session', { id: sessionId, status: 'provisioning', ueStatuses: {}, logs: [] });

    res.json({ ok: true, sessionId });

    // Run async — each step logs to session.logs so the UI can show progress
    (async () => {
      try {
        step(session, `Session ${sessionId} starting provisioning`, logger);

        // ── Step 1: Read Open5GS config ──
        step(session, 'Reading Open5GS config files (amf.yaml, mme.yaml, smf.yaml)...', logger);
        let cfg: ReturnType<typeof inferConfig>;
        try {
          cfg = inferConfig();
          if (sliceOverride) cfg.slices = [sliceOverride];
          step(session, `Config OK — PLMN ${cfg.plmn.mcc}-${cfg.plmn.mnc}, AMF ${cfg.amfIp}, MME ${cfg.mmeIp}`, logger);
          step(session, `Subnets: ${cfg.subnets.map(s => `${s.dnn}=${s.cidr}`).join(', ') || '(none found in smf.yaml)'}`, logger);
          step(session, `DNNs: ${cfg.dnns.join(', ')} | APNs: ${cfg.apns.join(', ')}`, logger);
        } catch (e) {
          throw new Error(`Failed to read Open5GS config: ${e}`);
        }

        // ── Step 2: Create working dirs ──
        step(session, `Creating session dir ${sessionDir}`, logger);
        try {
          fs.mkdirSync(path.join(sessionDir, '5g'), { recursive: true });
          fs.mkdirSync(path.join(sessionDir, '4g'), { recursive: true });
          // Separate log dirs per radio type — the 5G and 4G containers used
          // to share one /logs mount, and each run script truncates its own
          // gnb.log/ue.log on startup (`> /logs/gnb.log`). With a shared
          // mount, whichever container started second wiped the other's log,
          // and both processes then appended into the same inode concurrently,
          // corrupting/interleaving output (e.g. NGAP lines from the 5G gNB
          // showing up inside what looked like the 4G eNB's log). Each
          // container now gets its own private log dir.
          fs.mkdirSync(path.join(sessionDir, 'logs5g'), { recursive: true });
          fs.mkdirSync(path.join(sessionDir, 'logs4g'), { recursive: true });
        } catch (e) {
          throw new Error(`Failed to create session directory ${sessionDir}: ${e}`);
        }

        const total5G = enable5G ? Number(gnbCount) * Number(gnbUeCount) : 0;
        const total4G = enable4G ? Number(enbCount) * Number(enbUeCount) : 0;
        const totalUes = total5G + total4G;
        step(session, `Planning ${totalUes} UEs — 5G: ${total5G} (${gnbCount} gNBs × ${gnbUeCount}), 4G: ${total4G} (${enbCount} eNBs × ${enbUeCount})`, logger);

        const dnn5g = dnnOverride ?? cfg.dnns[0] ?? 'internet';
        const apn4g = apnOverride ?? cfg.apns[0] ?? 'internet';
        const resolvedAmfIp = amfIpOverride ?? cfg.amfIp;
        if (amfIpOverride) cfg.amfIp = amfIpOverride;
        const params5g = { dnn: dnn5g, amfIp: resolvedAmfIp };
        const params4g = { apn: apn4g };
        step(session, `AMF: ${resolvedAmfIp} | UPF GTP-U: ${cfg.upfIp} (gNB will bind GTP on 127.0.3.x)`, logger);

        // ── Step 3: Allocate IMSI block ──
        step(session, 'Querying MongoDB for highest IMSI to allocate test block above it...', logger);
        let baseImsi: string;
        try {
          baseImsi = await allocateImsiBlock(totalUes, subscriberRepo);
          step(session, `IMSI block: ${baseImsi} → ${makeImsi(baseImsi, totalUes - 1)}`, logger);
        } catch (e) {
          throw new Error(`IMSI allocation failed: ${e}`);
        }

        // ── Step 4: Allocate IP block ──
        const primaryDnn = enable5G ? dnn5g : apn4g;
        step(session, `Scanning all subscriber UE IPs to find free block in DNN "${primaryDnn}" subnet...`, logger);
        let baseIpStr: string;
        let baseIpNum: number;
        try {
          baseIpStr = await allocateIpBlock(totalUes, primaryDnn, cfg.subnets, subscriberRepo, logger);
          baseIpNum = ipToNum(baseIpStr);
          step(session, `IP block: ${baseIpStr} → ${numToIp(baseIpNum + totalUes - 1)}`, logger);
        } catch (e) {
          throw new Error(`IP allocation failed: ${e}`);
        }

        // ── Step 5: Create subscribers in MongoDB ──
        step(session, `Creating ${totalUes} test subscribers in MongoDB...`, logger);
        for (let i = 0; i < totalUes; i++) {
          const imsi  = makeImsi(baseImsi, i);
          const ueIp  = numToIp(baseIpNum + i);
          const k     = crypto.randomBytes(16).toString('hex').toUpperCase();
          const opc   = crypto.randomBytes(16).toString('hex').toUpperCase();

          const type   = i < total5G ? '5g' : '4g';
          const params = type === '5g' ? params5g : params4g;

          try {
            await subscriberRepo.create(makeSubscriber(imsi, k, opc, sessionId, i, ueIp, cfg, params));
          } catch (e) {
            throw new Error(`Failed to create subscriber ${imsi} (UE ${i + 1}/${totalUes}): ${e}`);
          }
          session.imsis.push(imsi);

          let nodeId: string;
          if (type === '5g') {
            nodeId = `gnb-${Math.floor(i / gnbUeCount) + 1}`;
          } else {
            nodeId = `enb-${(i - total5G) + 1}`;  // 1 eNB per UE
          }
          session.ueStatuses[imsi] = { imsi, type, nodeId, state: 'starting', ip: ueIp };

          const k_lower   = k.toLowerCase();
          const opc_lower = opc.toLowerCase();

          if (type === '5g') {
            const gnbIp = `${GNB_BASE}.${Math.floor(i / gnbUeCount) + 1}`;
            fs.writeFileSync(
              path.join(sessionDir, '5g', `ue${String(i).padStart(4, '0')}.yaml`),
              buildUeYaml(imsi, k_lower, opc_lower, gnbIp, cfg, params5g),
            );
          } else {
            const relIdx = i - total5G;  // 0-based index within 4G UEs
            fs.writeFileSync(
              path.join(sessionDir, '4g', `ue${String(relIdx).padStart(4, '0')}.conf`),
              buildUeConf(imsi, k_lower, opc_lower, relIdx, cfg, params4g),
            );
          }
        }
        step(session, `All ${totalUes} subscribers created successfully`, logger);
        broadcast('session', { id: sessionId, status: 'provisioning', ueStatuses: session.ueStatuses, logs: session.logs });

        // ── Step 6: Write radio node configs ──
        // Each radio gets its own dedicated dummy /32 for its S1AP/NGAP bind
        // address, so Open5GS can tell them apart (see allocateRadioDummyIp).
        step(session, 'Writing radio node config files...', logger);
        if (enable5G) {
          for (let i = 0; i < gnbCount; i++) {
            const { name, ip } = allocateRadioDummyIp(sessionId, '5g', i);
            await createDummyInterface(name, ip, 32, false);
            session.dummyInterfaces.push(name);
            fs.writeFileSync(path.join(sessionDir, '5g', `gnb${String(i).padStart(3, '0')}.yaml`), buildGnbYaml(i, cfg, params5g, ip));
          }
          fs.writeFileSync(path.join(sessionDir, '5g', 'run.sh'), RUN_5G);
          fs.chmodSync(path.join(sessionDir, '5g', 'run.sh'), 0o755);
          step(session, `Wrote ${gnbCount} gNB config(s) to ${sessionDir}/5g/`, logger);
        }
        if (enable4G) {
          // One eNB per 4G UE (1:1 pairing required for ZMQ TM1 loopback)
          for (let i = 0; i < total4G; i++) {
            const { name, ip } = allocateRadioDummyIp(sessionId, '4g', i);
            await createDummyInterface(name, ip, 32, false);
            session.dummyInterfaces.push(name);
            fs.writeFileSync(path.join(sessionDir, '4g', `enb${String(i).padStart(3, '0')}.conf`), buildEnbConf(i, cfg, params4g, ip));
          }
          fs.writeFileSync(path.join(sessionDir, '4g', 'rr.conf'), buildRrConf(cfg));
          fs.writeFileSync(path.join(sessionDir, '4g', 'run.sh'), RUN_4G);
          fs.chmodSync(path.join(sessionDir, '4g', 'run.sh'), 0o755);
          step(session, `Wrote ${total4G} eNB config(s) + rr.conf (TAC=${cfg.tac4g}) to ${sessionDir}/4g/`, logger);
        }

        // ── Step 7: Pull Docker images ──
        if (enable5G) {
          step(session, `Pulling UERANSIM image ${UERANSIM_IMAGE}...`, logger);
          try { await dockerPull(UERANSIM_IMAGE); step(session, 'UERANSIM image ready', logger); }
          catch (e) { step(session, `WARN: image pull failed (${e}), will try docker run anyway`, logger); }
        }
        if (enable4G) {
          step(session, `Pulling srsRAN image ${SRSRAN_IMAGE}...`, logger);
          try { await dockerPull(SRSRAN_IMAGE); step(session, 'srsRAN image ready', logger); }
          catch (e) { step(session, `WARN: image pull failed (${e}), will try docker run anyway`, logger); }
        }

        // ── Step 8: Start containers ──
        const logs5gDir = path.join(sessionDir, 'logs5g');
        const logs4gDir = path.join(sessionDir, 'logs4g');
        const capacity = detectHostCapacity();
        const budget   = computeResourceBudget(capacity, enable5G, enable4G);
        step(session, `Host capacity: ${capacity.cores} cores / ${capacity.totalMemGB.toFixed(1)}GB RAM — ` +
          `budget 5G=${budget.cpus5G}cpu/${budget.mem5GGB}GB, 4G=${budget.cpus4G}cpu/${budget.mem4GGB}GB`, logger);

        if (enable5G) {
          const name = `ue-val-5g-${sessionId}`;
          step(session, `Starting 5G container: ${name}`, logger);
          try {
            await dockerRun([
              'run', '-d', '--name', name,
              '--network=host', '--privileged',
              '--cap-add=NET_ADMIN', '--cap-add=SYS_ADMIN',
              // Autoscaled to this host's detected capacity — see
              // computeResourceBudget(). Always leaves headroom for the OS
              // and the rest of the NMS/core stack, no matter the host size.
              `--cpus=${budget.cpus5G}`, `--memory=${budget.mem5GGB}g`,
              '-v', `${sessionDir}/5g:/config:ro`,
              '-v', `${logs5gDir}:/logs`,
              '--entrypoint', '/bin/bash',
              UERANSIM_IMAGE, '/config/run.sh',
            ]);
            session.containers.push(name);
            step(session, `5G container started: ${name}`, logger);
          } catch (e) {
            throw new Error(`Failed to start UERANSIM container: ${e}`);
          }
        }

        if (enable4G) {
          const name = `ue-val-4g-${sessionId}`;
          step(session, `Starting 4G container: ${name}`, logger);
          try {
            await dockerRun([
              'run', '-d', '--name', name,
              '--network=host', '--privileged',
              '--cap-add=NET_ADMIN', '--cap-add=SYS_ADMIN',
              // Autoscaled — see computeResourceBudget(). Weighted higher
              // than 5G since srsRAN's real-time ZMQ DSP is the
              // timing-sensitive, CPU-hungry half of the two containers.
              `--cpus=${budget.cpus4G}`, `--memory=${budget.mem4GGB}g`,
              '-v', `${sessionDir}/4g:/config:ro`,
              '-v', `${logs4gDir}:/logs`,
              '--entrypoint', '/bin/bash',
              SRSRAN_IMAGE, '/config/run.sh',
            ]);
            session.containers.push(name);
            step(session, `4G container started: ${name}`, logger);
          } catch (e) {
            throw new Error(`Failed to start srsRAN container: ${e}`);
          }
        }

        session.status = 'running';
        step(session, 'All containers running — monitoring UE attach...', logger);
        persistSession(session);
        broadcast('session', { id: sessionId, status: 'running', ueStatuses: session.ueStatuses, logs: session.logs });

        startPolling(session, logger);

      } catch (err) {
        const msg = String(err);
        session.status = 'failed';
        session.error  = msg;
        session.logs.push(`[${new Date().toISOString()}] FATAL: ${msg}`);
        logger.error({ sessionId, err }, 'Session start failed');
        broadcast('session', { id: sessionId, status: 'failed', error: msg, logs: session.logs });
        for (const imsi of session.imsis) {
          try { await safeDeleteTestImsi(imsi, subscriberRepo, logger); } catch { /* ok */ }
        }
        for (const name of session.containers) {
          try { await dockerKill(name); } catch { /* ok */ }
        }
        for (const name of session.dummyInterfaces) {
          try { await deleteDummyInterface(name); } catch { /* ok */ }
        }
      }
    })();
  });

  // POST /api/validation/stop/:id — stop a specific session
  // POST /api/validation/ping/:id?ip=10.45.0.8 — verify a UE's reachability
  // by pinging it from the NMS backend itself. This host has a working,
  // non-NATed route to the UE session subnet (it's the UPF's own locally-
  // connected route via ogstun) — the operator's own machine generally does
  // not, since 10.45.0.0/24 is MASQUERADEd on any other egress and nothing
  // outside this host has a route to it. This proves the session is alive
  // end-to-end without needing any change to routing/NAT.
  router.post('/ping/:id', requireAdmin, async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return void res.status(404).json({ ok: false, error: 'Session not found' });

    const ip = String(req.query.ip ?? '');
    const knownUe = Object.values(session.ueStatuses).find(u => u.ip === ip);
    if (!knownUe) return void res.status(400).json({ ok: false, error: 'IP does not belong to a UE in this session' });

    try {
      // Runs via nsenter (host mount namespace) rather than execFileAsync
      // directly — the backend image doesn't bundle a `ping` binary, but the
      // host always has one, and --network=host means the route we need
      // (the UPF's own connected route to the UE subnet) is already shared.
      const { stdout } = await nsenter('ping', ['-c', '3', '-W', '2', ip], 10_000);
      const lossMatch = stdout.match(/(\d+)% packet loss/);
      const rttMatch  = stdout.match(/= [\d.]+\/([\d.]+)\/[\d.]+/); // rtt min/avg/max
      const lossPct = lossMatch ? Number(lossMatch[1]) : 100;
      res.json({
        ok: true,
        reachable: lossPct < 100,
        lossPct,
        avgRttMs: rttMatch ? Number(rttMatch[1]) : undefined,
        raw: stdout,
      });
    } catch (err: any) {
      // ping exits non-zero on 100% loss — still a valid (negative) result
      res.json({ ok: true, reachable: false, lossPct: 100, raw: String(err?.stdout ?? err) });
    }
  });

  router.post('/stop/:id', requireAdmin, async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return void res.status(404).json({ ok: false, error: 'Session not found' });

    try {
      await stopSession(session, subscriberRepo, logger);
      sessions.delete(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Stop session failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // POST /api/validation/stop-all — stop all sessions
  router.post('/stop-all', requireAdmin, async (req: Request, res: Response) => {
    try {
      for (const session of sessions.values()) {
        await stopSession(session, subscriberRepo, logger);
      }
      sessions.clear();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // GET /api/validation/status/:id — snapshot status (polled by frontend every second)
  router.get('/status/:id', (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return void res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, session: {
      id: session.id,
      startedAt: session.startedAt,
      status: session.status,
      imsiCount: session.imsis.length,
      containerCount: session.containers.length,
      ueStatuses: session.ueStatuses,
      logs: session.logs,
      error: session.error,
    }});
  });

  // GET /api/validation/raw-logs/:id — raw gNB/eNB and 5G/4G UE log files written
  // by the containers, kept as four separate streams (not merged) — the UI
  // renders each in its own tab. 5G and 4G each write to their own
  // logs5g/logs4g dir (see the split above), so there's no interleaving risk.
  router.get('/raw-logs/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const readLog = (rel: string): string[] =>
      readLogTail(path.join(VALIDATION_DIR, id, rel)).split('\n').filter(Boolean);
    res.json({
      ok: true,
      gnb:  readLog('logs5g/gnb.log'),
      enb:  readLog('logs4g/gnb.log'),
      ue5g: readLog('logs5g/ue.log'),
      ue4g: readLog('logs4g/ue.log'),
    });
  });

  // POST /api/validation/force-cleanup — nuke all VAL-TEST-* subscribers and ue-val-* containers
  // Works even after a backend restart (no session state required).
  router.post('/force-cleanup', requireAdmin, async (req: Request, res: Response) => {
    const results: string[] = [];
    try {
      // Kill all ue-val-* containers
      const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', 'name=ue-val-', '--format', '{{.Names}}'], { timeout: 10_000 });
      const names = stdout.trim().split('\n').filter(Boolean);
      for (const name of names) {
        try {
          await execFileAsync('docker', ['rm', '-f', name], { timeout: 15_000 });
          results.push(`Removed container: ${name}`);
        } catch (e) { results.push(`Failed to remove ${name}: ${e}`); }
      }

      // Delete all VAL-TEST-* subscribers directly from MongoDB
      const all = await subscriberRepo.findAllFull();
      let deleted = 0;
      for (const sub of all) {
        if (sub.nickname?.startsWith(VAL_NICKNAME_PREFIX)) {
          try {
            await subscriberRepo.delete(sub.imsi);
            deleted++;
          } catch (e) { results.push(`Failed to delete ${sub.imsi}: ${e}`); }
        }
      }
      results.push(`Deleted ${deleted} test subscribers`);

      // Remove all session dirs
      try {
        if (fs.existsSync(VALIDATION_DIR)) {
          for (const entry of fs.readdirSync(VALIDATION_DIR)) {
            fs.rmSync(path.join(VALIDATION_DIR, entry), { recursive: true, force: true });
          }
          results.push('Removed session config dirs');
        }
      } catch { /* ok */ }

      // Tear down every leftover v4-*/v5-* dummy interface on the host, not just ones
      // tied to a currently-known session — this is the one place a user can reach for
      // regardless of how a session got orphaned (crashed backend, force-killed containers,
      // a session dir removed without going through stop, etc).
      const orphanedIfaces = await listOrphanedValidationDummyInterfaces();
      for (const name of orphanedIfaces) {
        try {
          await deleteDummyInterface(name);
          results.push(`Removed dummy interface: ${name}`);
        } catch (e) { results.push(`Failed to remove interface ${name}: ${e}`); }
      }

      // Clear in-memory sessions
      sessions.clear();
      broadcast('session', { type: 'clear' });

      res.json({ ok: true, results });
    } catch (err) {
      logger.error({ err }, 'Force cleanup failed');
      res.status(500).json({ ok: false, error: String(err), results });
    }
  });

  reconcileOrphanedSessions(logger).catch(err =>
    logger.error({ err: String(err) }, 'Validation session reconciliation failed'));

  return router;
}
