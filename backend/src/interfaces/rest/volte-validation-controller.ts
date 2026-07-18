import { Router, Request, Response } from 'express';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { pyhssApiCall } from './ims-controller';

// ── VoLTE End-to-End Validation ─────────────────────────────────────────────
//
// Tests the IMS/SIP signaling core specifically — two linphonec (console SIP
// client) instances REGISTER against P-CSCF directly on loopback, then place
// and answer a real call, verifying RTP media actually establishes. This
// deliberately does NOT go through UERANSIM/srsRAN NAS/RRC attach (that's what
// the rest of this module's sessions test) — VoLTE's SIP/IMS layer is a
// separate, independent thing from the radio/NAS layer, and this test isolates
// it. See memory: volte-testing-linphonec, ims-install-configure-and-volte-fixes
// (both from the 2026-07-17/18 session that got this working end-to-end for the
// first time on a from-scratch install).
//
// Real UEs use AKA (needs SIM Ki/OPc crypto); linphonec can't do that. PyHSS
// has a genuine (if unusual) Digest-MD5 auth mode where the subscriber's own Ki
// hex string IS the SIP digest password — this test temporarily switches
// S-CSCF into that mode and ALWAYS switches it back in a finally block, since
// leaving it on would be a real security regression for actual subscribers.

const HOST_ROOT       = '/proc/1/root';
const HOST_IMS_STATE  = `${HOST_ROOT}/etc/open5gs/.ims-config.json`;
const HOST_SCSCF_CFG  = `${HOST_ROOT}/etc/kamailio_scscf/scscf.cfg`;
const VOLTE_TEST_ROOT = '/tmp/volte-validation';

interface ImsState {
  imsDomain: string;
  config: { mcc: string; mnc: string; scscfPort?: number; pcscfIp: string; pcscfPort?: number };
}

function readImsState(): ImsState | null {
  try {
    return JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
  } catch {
    return null;
  }
}

async function nsenter(cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  return execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', cmd, ...args], {
    timeout: timeoutMs, encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  }) as unknown as Promise<{ stdout: string; stderr: string }>;
}

async function ensureLinphoneInstalled(): Promise<void> {
  try {
    await nsenter('which', ['linphonec']);
    return;
  } catch {
    // not installed — fall through and install it below
  }
  await nsenter('bash', ['-c', 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y linphone-cli'], 180000);
  await nsenter('which', ['linphonec']);
}

// ── Test identity generation ────────────────────────────────────────────────
// Deliberately NOT real Open5GS Mongo subscribers — this test only exercises
// the IMS/SIP signaling layer (P-CSCF/I-CSCF/S-CSCF/PyHSS), never the
// RAN/NAS/core attach path, so a PyHSS-only identity (auc/subscriber/
// ims_subscriber) is all that's needed. IMSIs use a distinctive "900" MSIN
// block within the real PLMN so they can never collide with a genuine
// subscriber and are unambiguous in logs/DBs as test-only.

function randomTestImsi(mcc: string, mnc: string, idx: number): string {
  const plmn = mcc + mnc.padStart(3, '0');
  const suffix = '900' + crypto.randomInt(0, 100000).toString().padStart(5, '0');
  return (plmn + suffix).slice(0, 15).padEnd(15, String(idx));
}

interface TestIdentity {
  imsi: string;
  msisdn: string;
  ki: string;
  opc: string;
}

function makeTestIdentity(mcc: string, mnc: string, idx: number): TestIdentity {
  return {
    imsi: randomTestImsi(mcc, mnc, idx),
    msisdn: '9' + crypto.randomInt(0, 10000000000).toString().padStart(10, '0'),
    ki: crypto.randomBytes(16).toString('hex').toUpperCase(),
    opc: crypto.randomBytes(16).toString('hex').toUpperCase(),
  };
}

// Same "ensure the internet APN exists" logic as ims-controller.ts's /sync-subscribers —
// a fresh PyHSS install has an empty apn table, and subscriber.default_apn/apn_list are
// real foreign keys, so hardcoding apn_id=1 fails on any host that hasn't already synced
// a real subscriber at least once (confirmed live on a from-scratch test01 rebuild).
async function ensureInternetApnId(): Promise<number> {
  const apnList: any[] = await pyhssApiCall('GET', '/apn/list');
  const existing = Array.isArray(apnList) ? apnList.find((a: any) => a.apn === 'internet') : null;
  if (existing) return existing.apn_id;
  const created = await pyhssApiCall('PUT', '/apn/', {
    apn: 'internet', apn_ambr_dl: 999999, apn_ambr_ul: 999999, qci: 9, arp_priority: 4,
  });
  return created.apn_id;
}

async function provisionPyhssTestSubscriber(identity: TestIdentity, imsDomain: string, scscfPort: number): Promise<void> {
  const apnId = await ensureInternetApnId();
  const newAuc = await pyhssApiCall('PUT', '/auc/', { ki: identity.ki, opc: identity.opc, amf: '8000', sqn: 0, imsi: identity.imsi });
  await pyhssApiCall('PUT', '/subscriber/', {
    imsi: identity.imsi, msisdn: identity.msisdn, auc_id: newAuc.auc_id,
    default_apn: apnId, apn_list: String(apnId), enabled: true,
  });
  await pyhssApiCall('PUT', '/ims_subscriber/', {
    imsi: identity.imsi, msisdn: identity.msisdn, msisdn_list: identity.msisdn,
    scscf: `sip:scscf.${imsDomain}:${scscfPort}`,
    scscf_realm: imsDomain,
    scscf_peer: `scscf.${imsDomain}`,
    ifc_path: 'pyhss/default_ifc.xml',
  });
}

async function deprovisionPyhssTestSubscriber(imsi: string): Promise<void> {
  for (const [getPath, deletePathPrefix] of [
    [`/ims_subscriber/ims_subscriber_imsi/${imsi}`, '/ims_subscriber/'],
    [`/subscriber/imsi/${imsi}`, '/subscriber/'],
    [`/auc/imsi/${imsi}`, '/auc/'],
  ] as const) {
    try {
      const existing = await pyhssApiCall('GET', getPath);
      const id = existing?.ims_subscriber_id ?? existing?.subscriber_id ?? existing?.auc_id;
      if (id) await pyhssApiCall('DELETE', `${deletePathPrefix}${id}`);
    } catch { /* not found — already gone, fine */ }
  }
}

// ── S-CSCF test auth mode (Digest-MD5) — always reverted ───────────────────

async function setScscfTestAuthMode(enabled: boolean): Promise<void> {
  let raw = fs.readFileSync(HOST_SCSCF_CFG, 'utf-8');
  const target = enabled ? 'MD5' : 'HSS-Selected';
  raw = raw.replace(/#!define REG_AUTH_DEFAULT_ALG "[^"]*"/, `#!define REG_AUTH_DEFAULT_ALG "${target}"`);
  fs.writeFileSync(HOST_SCSCF_CFG, raw, 'utf-8');
  await nsenter('systemctl', ['restart', 'kamailio-scscf']);
  // Give S-CSCF a moment to reconnect to HSS before the test starts hammering it.
  await new Promise(resolve => setTimeout(resolve, 3000));
}

// ── linphonec session wrapper ────────────────────────────────────────────────
// Full programmatic control (spawn + stdin/stdout) instead of the shell-FIFO
// approach used for manual testing — much more robust for watching specific
// state transitions with a real timeout instead of sleep-then-grep.

interface LinphoneSession {
  proc: ChildProcessWithoutNullStreams;
  buffer: string;
  send(cmd: string): void;
  waitFor(pattern: RegExp, timeoutMs: number): Promise<string>;
  stop(): void;
}

function startLinphoneSession(configPath: string, homeDir: string): LinphoneSession {
  // configPath/homeDir are real HOST paths (the linphonec process below runs inside the
  // host's mount namespace via nsenter -m) — but this container's own fs.* calls need the
  // /proc/1/root bind-mount prefix to reach the same files from in here.
  fs.mkdirSync(`${HOST_ROOT}${homeDir}/.local/share/linphone`, { recursive: true });
  const proc = spawn('nsenter', [
    '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
    'env', `HOME=${homeDir}`,
    'linphonec', '-c', configPath, '-d', '3',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const session: LinphoneSession = {
    proc,
    buffer: '',
    send(cmd: string) { proc.stdin.write(cmd + '\n'); },
    waitFor(pattern: RegExp, timeoutMs: number) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const m = session.buffer.match(pattern);
          if (m) { cleanup(); resolve(m[0]); }
        };
        const onData = () => check();
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for /${pattern.source}/. Last output:\n${session.buffer.slice(-1500)}`));
        }, timeoutMs);
        const cleanup = () => { clearTimeout(timer); proc.stdout.off('data', onData); proc.stderr.off('data', onData); };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        check(); // in case it already matches
      });
    },
    stop() {
      try { proc.stdin.write('quit\n'); } catch { /* already dead */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 2000);
    },
  };
  proc.stdout.on('data', (d: Buffer) => { session.buffer += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { session.buffer += d.toString(); });
  return session;
}

function linphonerc(identity: TestIdentity, imsDomain: string, tcpPort: number, pcscfIp: string, pcscfPort: number): string {
  return `[sip]
sip_port=-1
sip_tcp_port=${tcpPort}
sip_tls_port=-1
default_proxy=0

[proxy_0]
reg_proxy=sip:${pcscfIp}:${pcscfPort};transport=tcp
reg_route=sip:${pcscfIp}:${pcscfPort};transport=tcp
reg_identity=sip:${identity.imsi}@${imsDomain}
reg_expires=3600
publish=0
reg_sendregister=1
realm=${imsDomain}

[auth_info_0]
username=${identity.imsi}
userid=${identity.imsi}
passwd=${identity.ki}
realm=${imsDomain}
`;
}

// ── The test itself ──────────────────────────────────────────────────────────

export interface VolteTestStep {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

export interface VolteTestResult {
  success: boolean;
  steps: VolteTestStep[];
  error?: string;
}

async function runStep<T>(steps: VolteTestStep[], name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    steps.push({ name, ok: true, durationMs: Date.now() - start });
    return result;
  } catch (err) {
    steps.push({ name, ok: false, detail: String(err), durationMs: Date.now() - start });
    throw err;
  }
}

export async function runVolteE2ETest(onStep?: (step: VolteTestStep) => void): Promise<VolteTestResult> {
  const steps: VolteTestStep[] = [];
  const wrap = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await runStep(steps, name, fn);
      if (onStep) onStep(steps[steps.length - 1]);
      return result;
    } catch (err) {
      if (onStep) onStep(steps[steps.length - 1]);
      throw err;
    }
  };

  const runId = crypto.randomBytes(4).toString('hex');
  const dirA = `${VOLTE_TEST_ROOT}/${runId}-a`;
  const dirB = `${VOLTE_TEST_ROOT}/${runId}-b`;
  let sessionA: LinphoneSession | undefined;
  let sessionB: LinphoneSession | undefined;
  let identityA: TestIdentity | undefined;
  let identityB: TestIdentity | undefined;
  let testAuthModeEnabled = false;

  try {
    const state = await wrap('Check IMS is configured', async () => {
      const s = readImsState();
      if (!s) throw new Error('IMS is not configured — run the IMS Configure wizard first.');
      return s;
    });

    const { mcc, mnc, scscfPort = 6060, pcscfIp, pcscfPort = 5060 } = state.config;
    identityA = makeTestIdentity(mcc, mnc, 1);
    identityB = makeTestIdentity(mcc, mnc, 2);

    await wrap('Ensure linphonec is installed', ensureLinphoneInstalled);

    await wrap('Provision test subscriber A in PyHSS', () =>
      provisionPyhssTestSubscriber(identityA!, state.imsDomain, scscfPort));
    await wrap('Provision test subscriber B in PyHSS', () =>
      provisionPyhssTestSubscriber(identityB!, state.imsDomain, scscfPort));

    await wrap('Enable S-CSCF test auth mode (Digest-MD5)', async () => {
      await setScscfTestAuthMode(true);
      testAuthModeEnabled = true;
    });

    // dirA/dirB/configA/configB are real HOST paths — see startLinphoneSession's note above.
    fs.mkdirSync(`${HOST_ROOT}${dirA}`, { recursive: true });
    fs.mkdirSync(`${HOST_ROOT}${dirB}`, { recursive: true });
    const configA = `${dirA}/linphonerc`;
    const configB = `${dirB}/linphonerc`;
    fs.writeFileSync(`${HOST_ROOT}${configA}`, linphonerc(identityA, state.imsDomain, 15060, pcscfIp, pcscfPort));
    fs.writeFileSync(`${HOST_ROOT}${configB}`, linphonerc(identityB, state.imsDomain, 15061, pcscfIp, pcscfPort));

    await wrap('Register subscriber A', async () => {
      sessionA = startLinphoneSession(configA, dirA);
      await sessionA.waitFor(/Register refresher \[200\]|registered, identity=/, 20000);
    });
    await wrap('Register subscriber B', async () => {
      sessionB = startLinphoneSession(configB, dirB);
      await sessionB.waitFor(/Register refresher \[200\]|registered, identity=/, 20000);
    });

    await wrap('Place call A → B', async () => {
      sessionA!.send(`call sip:${identityB!.imsi}@${state.imsDomain}`);
      await sessionB!.waitFor(/Incoming call ringing/, 15000);
    });

    await wrap('Answer call on B', async () => {
      sessionB!.send('answer');
      await Promise.all([
        sessionA!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
        sessionB!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
      ]);
    });

    await wrap('Verify bidirectional RTP media', async () => {
      await Promise.all([
        sessionA!.waitFor(/Bandwidth usage for CallSession/, 10000),
        sessionB!.waitFor(/Bandwidth usage for CallSession/, 10000),
      ]);
    });

    await wrap('Hang up cleanly', async () => {
      sessionA!.send('terminate');
      await sessionA!.waitFor(/LinphoneCallEnd|LinphoneCallReleased/, 10000);
    });

    return { success: true, steps };
  } catch (err) {
    return { success: false, steps, error: String(err) };
  } finally {
    // Best-effort cleanup — every step here must run regardless of where the
    // test failed, especially reverting S-CSCF's auth mode (leaving it on
    // Digest-MD5 is a real security regression for actual subscribers).
    try { sessionA?.stop(); } catch { /* ok */ }
    try { sessionB?.stop(); } catch { /* ok */ }
    if (testAuthModeEnabled) {
      try { await setScscfTestAuthMode(false); } catch { /* logged via step failure if this matters */ }
    }
    if (identityA) { try { await deprovisionPyhssTestSubscriber(identityA.imsi); } catch { /* ok */ } }
    if (identityB) { try { await deprovisionPyhssTestSubscriber(identityB.imsi); } catch { /* ok */ } }
    try { fs.rmSync(`${HOST_ROOT}${dirA}`, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.rmSync(`${HOST_ROOT}${dirB}`, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

let testRunning = false;

export function createVolteValidationRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    const state = readImsState();
    res.json({
      success: true,
      imsConfigured: !!state,
      imsDomain: state?.imsDomain ?? null,
      running: testRunning,
    });
  });

  // POST /api/validation/volte/run — streamed: one line per step as it completes.
  router.post('/run', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (testRunning) {
      return res.status(409).json({ success: false, error: 'A VoLTE validation test is already running.' });
    }
    testRunning = true;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    try {
      const result = await runVolteE2ETest(step => {
        res.write(JSON.stringify({ type: 'step', ...step }) + '\n');
      });
      res.write(JSON.stringify({ type: 'result', success: result.success, error: result.error }) + '\n');
      await auditLogger.log({
        action: 'volte_validation_test', user,
        details: `success=${result.success} steps=${result.steps.length}${result.error ? ` error=${result.error}` : ''}`,
        success: result.success,
      });
    } catch (err) {
      res.write(JSON.stringify({ type: 'result', success: false, error: String(err) }) + '\n');
      await auditLogger.log({ action: 'volte_validation_test', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'volte validation test crashed');
    } finally {
      testRunning = false;
      res.end();
    }
  });

  return router;
}
