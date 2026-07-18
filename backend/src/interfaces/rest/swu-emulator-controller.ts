import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { Subscriber } from '../../domain/entities/subscriber';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { nsenter } from '../../infrastructure/network/dummy-interface';
import { ipToNum, numToIp, cidrRange } from '../../domain/services/ip-utils';

// ─── Host paths / constants ─────────────────────────────────────────────────
const SWU_DIR           = '/opt/swu-emulator';
const HOST_SWU_DIR      = `/proc/1/root${SWU_DIR}`;
export const SWU_NETNS  = 'swu-test';
const VETH_HOST         = 'veth-swu';
const VETH_NS           = 'veth-ue';
const HOST_VETH_CIDR    = '192.168.250.1/30';
const NS_VETH_IP        = '192.168.250.2';
const NS_VETH_CIDR      = '192.168.250.2/30';

const HOST_STATE_FILE   = '/proc/1/root/etc/open5gs-nms/.swu-emulator-state.json';
const HOST_VOWIFI_STATE = '/proc/1/root/etc/open5gs-nms/.vowifi-state.json';
const HOST_MME_YAML     = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_SMF_YAML     = '/proc/1/root/etc/open5gs/smf.yaml';
const LOG_FILE          = '/var/log/open5gs-nms/swu-emulator.log';

// Safety invariant: only ever auto-delete subscribers this feature itself created —
// same pattern as VAL_NICKNAME_PREFIX in validation-controller.ts.
const TEST_NICKNAME_PREFIX = 'SWU-TEST-';

// ─── State ──────────────────────────────────────────────────────────────────
export interface SwuState {
  running: boolean;
  imsi: string | null;
  k: string | null;
  opc: string | null;
  staticIp: string | null;
  autoCreatedSubscriber: boolean;
  startedAt: string | null;
}

function defaultState(): SwuState {
  return { running: false, imsi: null, k: null, opc: null, staticIp: null, autoCreatedSubscriber: false, startedAt: null };
}

export function loadSwuState(): SwuState {
  try {
    if (fs.existsSync(HOST_STATE_FILE)) return { ...defaultState(), ...JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf-8')) };
  } catch { /* corrupt */ }
  return defaultState();
}

function saveState(s: SwuState): void {
  const dir = path.dirname(HOST_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

function appendLog(msg: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(LOG_FILE, msg.endsWith('\n') ? msg : msg + '\n', 'utf-8');
}

function tailLog(maxLines: number): string {
  try { return fs.readFileSync(LOG_FILE, 'utf-8').split('\n').slice(-maxLines).join('\n'); }
  catch { return ''; }
}

// ─── Domain helpers ──────────────────────────────────────────────────────────

function readMccMnc(): { mcc: string; mnc: string } {
  let mcc = '001'; let mnc = '01';
  try {
    const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
  } catch { /* use defaults */ }
  return { mcc, mnc };
}

function readVowifiEpdgIp(): string | null {
  try {
    const state = JSON.parse(fs.readFileSync(HOST_VOWIFI_STATE, 'utf-8'));
    return state.configured && state.epdgIp ? state.epdgIp : null;
  } catch {
    return null;
  }
}


function readInternetSubnet(): { cidr: string; gateway: string } | null {
  try {
    const raw = fs.readFileSync(HOST_SMF_YAML, 'utf-8');
    const lines = raw.split('\n');
    const idx = lines.findIndex(l => /^\s+dnn:\s*internet\s*$/.test(l));
    if (idx < 0) return null;
    let start = idx;
    while (start > 0 && !/^\s*-\s*subnet:/.test(lines[start])) start--;
    let subnet = ''; let gateway = '';
    for (let i = start; i <= idx; i++) {
      const sM = lines[i].match(/subnet:\s*([0-9./]+)/);
      const gM = lines[i].match(/gateway:\s*([0-9.]+)/);
      if (sM) subnet = sM[1];
      if (gM) gateway = gM[1];
    }
    return subnet ? { cidr: subnet, gateway } : null;
  } catch {
    return null;
  }
}

// Picks a free IP from the TOP of the "internet" DNN's range downward — real
// subscribers in this deployment have historically been assigned from the bottom
// of the range, so this stays maximally clear of them (the exact class of bug that
// caused two real production IP collisions earlier this session).
async function findFreeTestIp(subscriberRepo: ISubscriberRepository): Promise<string> {
  const sn = readInternetSubnet();
  if (!sn) throw new Error('Could not determine the "internet" DNN subnet from smf.yaml');
  const { first, last } = cidrRange(sn.cidr);
  const gw = ipToNum(sn.gateway);
  const all = await subscriberRepo.findAllFull();
  const used = new Set<number>();
  for (const sub of all) for (const slice of sub.slice ?? []) for (const session of slice.session ?? []) {
    if (session.ue?.ipv4) used.add(ipToNum(session.ue.ipv4));
  }
  for (let ip = last; ip >= first; ip--) {
    if (ip !== gw && !used.has(ip)) return numToIp(ip);
  }
  throw new Error('No free IP found in the "internet" subnet for a test subscriber');
}

export async function ensureNetns(): Promise<void> {
  await nsenter('bash', ['-c', `
set -e
ip netns add ${SWU_NETNS} 2>/dev/null || true
ip link show ${VETH_HOST} >/dev/null 2>&1 || ip link add ${VETH_HOST} type veth peer name ${VETH_NS}
ip link show ${VETH_NS} >/dev/null 2>&1 && ip link set ${VETH_NS} netns ${SWU_NETNS} 2>/dev/null || true
ip addr add ${HOST_VETH_CIDR} dev ${VETH_HOST} 2>/dev/null || true
ip link set ${VETH_HOST} up
ip netns exec ${SWU_NETNS} ip addr add ${NS_VETH_CIDR} dev ${VETH_NS} 2>/dev/null || true
ip netns exec ${SWU_NETNS} ip link set ${VETH_NS} up
ip netns exec ${SWU_NETNS} ip link set lo up
ip netns exec ${SWU_NETNS} ip route replace default via 192.168.250.1
sysctl -w net.ipv4.ip_forward=1 >/dev/null
`], 20000);
}

export async function teardownNetns(): Promise<void> {
  await nsenter('bash', ['-c',
    `ip netns del ${SWU_NETNS} 2>/dev/null || true; ip link del ${VETH_HOST} 2>/dev/null || true`], 15000);
}

// Core tunnel start/stop logic, extracted so other test modules (VoWiFi E2E validation)
// can reuse the exact same battle-tested establish/teardown path instead of duplicating
// it — same precedent as ims-controller.ts exporting pyhssApiCall for the VoLTE test
// module. Throws on any precondition failure; callers (the HTTP route below, or another
// module) decide how to surface that.
export async function startSwuTestTunnel(
  subscriberRepo: ISubscriberRepository,
  overrides?: { imsi?: string; k?: string; opc?: string; staticIp?: string },
): Promise<{ imsi: string; k: string; opc: string; staticIp: string; autoCreated: boolean }> {
  const state = loadSwuState();
  if (state.running) throw new Error('A test session is already running — Stop it first.');
  const installed = fs.existsSync(`${HOST_SWU_DIR}/.venv/bin/python3`);
  if (!installed) throw new Error('Emulator not installed yet — run Install first.');
  const epdgIp = readVowifiEpdgIp();
  if (!epdgIp) throw new Error('VoWiFi is not configured yet — run Configure on the VoWiFi page first.');

  const { mcc, mnc } = readMccMnc();
  const mncPadded = mnc.padStart(3, '0');

  let { imsi, k, opc, staticIp } = overrides ?? {};
  let autoCreated = false;

  if (!imsi || !k || !opc) {
    const msinLen = 15 - mcc.length - mnc.length;
    const msin = crypto.randomInt(0, 10 ** msinLen).toString().padStart(msinLen, '0');
    imsi = `${mcc}${mnc}${msin}`;
    k = crypto.randomBytes(16).toString('hex').toUpperCase();
    opc = crypto.randomBytes(16).toString('hex').toUpperCase();
    staticIp = staticIp || await findFreeTestIp(subscriberRepo);
    autoCreated = true;

    const nickname = `${TEST_NICKNAME_PREFIX}${crypto.randomBytes(3).toString('hex')}`;
    await subscriberRepo.create({
      imsi, nickname, msisdn: [],
      security: { k, opc, amf: '8000' },
      ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
      slice: [{
        sst: 1, default_indicator: true,
        session: [{
          name: 'internet', type: 3,
          ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
          qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
          pcc_rule: [],
          ue: { ipv4: staticIp },
        }],
      }],
      subscribed_rau_tau_timer: 12,
      subscriber_status: 0,
      access_restriction_data: 32,
      network_access_mode: 0,
    } as Subscriber);
  } else if (!staticIp) {
    throw new Error('staticIp is required when providing your own imsi/k/opc — never test with unconstrained dynamic allocation (risk of colliding with a real subscriber\'s IP).');
  }

  await ensureNetns();

  if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
  const logFd = fs.openSync(LOG_FILE, 'a');
  const child = spawn('nsenter', [
    '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
    'ip', 'netns', 'exec', SWU_NETNS,
    `${SWU_DIR}/.venv/bin/python3`, `${SWU_DIR}/swu_emulator.py`,
    '-s', NS_VETH_IP, '-d', epdgIp, '-a', 'internet',
    '-M', mcc, '-N', mncPadded, '-K', k!, '-C', opc!, '-I', imsi!,
  ], { stdio: ['pipe', logFd, logFd], detached: true });
  child.unref();
  fs.closeSync(logFd);

  saveState({
    running: true, imsi: imsi!, k: k!, opc: opc!, staticIp: staticIp!,
    autoCreatedSubscriber: autoCreated, startedAt: new Date().toISOString(),
  });
  appendLog(`==RUN:start imsi=${imsi} staticIp=${staticIp} epdgIp=${epdgIp}==`);

  return { imsi: imsi!, k: k!, opc: opc!, staticIp: staticIp!, autoCreated };
}

export async function stopSwuTestTunnel(subscriberRepo: ISubscriberRepository, logger: pino.Logger): Promise<void> {
  const state = loadSwuState();
  await nsenter('bash', ['-c', 'pkill -9 -f swu_emulator.py || true'], 10000).catch(() => {});
  await nsenter('swanctl', ['--terminate', '--ike', 'rw'], 8000).catch(() => {});
  await teardownNetns();

  if (state.autoCreatedSubscriber && state.imsi) {
    const existing = await subscriberRepo.findByImsi(state.imsi);
    if (existing?.nickname?.startsWith(TEST_NICKNAME_PREFIX)) {
      await subscriberRepo.delete(state.imsi);
    } else if (existing) {
      logger.error({ imsi: state.imsi, nickname: existing.nickname },
        'SAFETY BLOCK: refusing to delete subscriber — not a SWU-TEST IMSI');
    }
  }

  saveState(defaultState());
  appendLog('==RUN:stopped==');
}

// ─── Router ──────────────────────────────────────────────────────────────────

export function createSwuEmulatorRouter(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    const state = loadSwuState();
    const installed = fs.existsSync(`${HOST_SWU_DIR}/.venv/bin/python3`) && fs.existsSync(`${HOST_SWU_DIR}/swu_emulator.py`);
    let tunnelEstablished = false;
    let assignedIp: string | null = null;
    try {
      const { stdout } = await nsenter('swanctl', ['--list-sas'], 10000);
      tunnelEstablished = /ESTABLISHED/.test(stdout);
      const m = stdout.match(/remote\s+([\d.]+)\/32/);
      if (m) assignedIp = m[1];
    } catch { /* charon not reachable / no SAs */ }
    res.json({
      success: true, installed, epdgIp: readVowifiEpdgIp(),
      tunnelEstablished, assignedIp, ...state,
    });
  });

  router.get('/log', (_req: Request, res: Response) => {
    res.type('text/plain').send(tailLog(100000));
  });

  router.get('/log/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(tailLog(200));
    if (!fs.existsSync(LOG_FILE)) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.writeFileSync(LOG_FILE, '');
    }
    const tail = spawn('tail', ['-f', '-n', '0', LOG_FILE]);
    tail.stdout.on('data', (d: Buffer) => res.write(d));
    tail.stderr.on('data', () => {});
    req.on('close', () => tail.kill());
    tail.on('close', () => res.end());
  });

  // POST /install — streamed, synchronous (clone + venv + pip install, no compilation, ~1-2 min)
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', '-c', bashScript],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', code => resolve(code ?? 1));
      });

    try {
      write('=== Installing SWu-IKEv2 emulator dependencies ===');
      await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv python3-pip python3-dev git pcscd libpcsclite-dev swig 2>&1');

      write('\n=== Cloning SWu-IKEv2 ===');
      await spawnStream(`[ -d ${SWU_DIR} ] && echo "Already cloned — skipping." || git clone https://github.com/fasferraz/SWu-IKEv2 ${SWU_DIR} 2>&1`);

      write('\n=== Creating venv + installing Python deps ===');
      await spawnStream(`cd ${SWU_DIR} && python3 -m venv .venv 2>&1`);
      await spawnStream(`cd ${SWU_DIR} && .venv/bin/pip install --upgrade pip 2>&1`);
      await spawnStream(`cd ${SWU_DIR} && .venv/bin/pip install -r requirements.txt 2>&1`);

      await auditLogger.log({ action: 'swu_emulator_install', user, success: true });
      write('\n✅ SWu-IKEv2 emulator installed.');
      res.end();
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      await auditLogger.log({ action: 'swu_emulator_install', user, details: String(err), success: false });
      res.end();
    }
  });

  // POST /run — starts (or restarts) a single test tunnel against the configured VoWiFi ePDG
  router.post('/run', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { imsi, k, opc, staticIp } = req.body as { imsi?: string; k?: string; opc?: string; staticIp?: string };
      const result = await startSwuTestTunnel(subscriberRepo, { imsi, k, opc, staticIp });
      await auditLogger.log({
        action: 'swu_emulator_run', user,
        details: `imsi=${result.imsi} staticIp=${result.staticIp} autoCreated=${result.autoCreated}`, success: true,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err: String(err) }, 'swu-emulator run error');
      await auditLogger.log({ action: 'swu_emulator_run', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await stopSwuTestTunnel(subscriberRepo, logger);
      await auditLogger.log({ action: 'swu_emulator_stop', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'swu_emulator_stop', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  return router;
}
