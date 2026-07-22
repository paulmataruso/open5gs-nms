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

export const HOST_ROOT = '/proc/1/root';
const HOST_IMS_STATE  = `${HOST_ROOT}/etc/open5gs/.ims-config.json`;
const HOST_SCSCF_CFG  = `${HOST_ROOT}/etc/kamailio_scscf/scscf.cfg`;
const VOLTE_TEST_ROOT = '/tmp/volte-validation';
// How long to hold the call up (RTP actively flowing) after confirming bidirectional
// media, before hanging up. Was previously ~0 — the test moved straight from
// "bandwidth confirmed" to "hang up," so a packet capture taken during the test only
// ever caught ~1 second of real media. 15s gives a capture enough real audio to
// meaningfully inspect (RTP sequence continuity, jitter, codec behavior over time).
const CALL_HOLD_MS = 15000;

export interface ImsState {
  imsDomain: string;
  config: { mcc: string; mnc: string; scscfPort?: number; pcscfIp: string; pcscfPort?: number };
}

export function readImsState(): ImsState | null {
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

export async function ensureLinphoneInstalled(): Promise<void> {
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

export interface TestIdentity {
  imsi: string;
  msisdn: string;
  ki: string;
  opc: string;
}

export function makeTestIdentity(mcc: string, mnc: string, idx: number): TestIdentity {
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

export async function provisionPyhssTestSubscriber(
  identity: TestIdentity, imsDomain: string, scscfPort: number,
): Promise<{ apnId: number; aucId: number }> {
  const apnId = await ensureInternetApnId();
  const newAuc = await pyhssApiCall('PUT', '/auc/', { ki: identity.ki, opc: identity.opc, amf: '8000', sqn: 0, imsi: identity.imsi });
  await pyhssApiCall('PUT', '/subscriber/', {
    imsi: identity.imsi, msisdn: identity.msisdn, auc_id: newAuc.auc_id,
    default_apn: apnId, apn_list: String(apnId), enabled: true,
  });
  const scscfUri = `sip:scscf.${imsDomain}:${scscfPort}`;
  await pyhssApiCall('PUT', '/ims_subscriber/', {
    imsi: identity.imsi, msisdn: identity.msisdn, msisdn_list: identity.msisdn,
    scscf: scscfUri,
    scscf_realm: imsDomain,
    scscf_peer: `scscf.${imsDomain}`,
    ifc_path: 'pyhss/default_ifc.xml',
  });
  return { apnId, aucId: newAuc.auc_id };
}

export async function deprovisionPyhssTestSubscriber(imsi: string): Promise<void> {
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

export async function setScscfTestAuthMode(enabled: boolean): Promise<void> {
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

export interface LinphoneSession {
  proc: ChildProcessWithoutNullStreams;
  buffer: string;
  send(cmd: string): void;
  waitFor(pattern: RegExp, timeoutMs: number): Promise<string>;
  stop(): void;
}

export function startLinphoneSession(configPath: string, homeDir: string, netns?: string): LinphoneSession {
  // configPath/homeDir are real HOST paths (the linphonec process below runs inside the
  // host's mount namespace via nsenter -m) — but this container's own fs.* calls need the
  // /proc/1/root bind-mount prefix to reach the same files from in here.
  fs.mkdirSync(`${HOST_ROOT}${homeDir}/.local/share/linphone`, { recursive: true });
  // `netns`, when given, routes linphonec's traffic through a pre-established network
  // namespace (e.g. the SWu-IKEv2 emulator's IPsec tunnel netns for VoWiFi testing) — same
  // pattern swu-emulator-controller.ts itself uses to launch the emulator inside that netns.
  const target = netns ? ['ip', 'netns', 'exec', netns, 'env', `HOME=${homeDir}`, 'linphonec', '-c', configPath, '-d', '3']
                       : ['env', `HOME=${homeDir}`, 'linphonec', '-c', configPath, '-d', '3'];
  const proc = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', ...target], { stdio: ['pipe', 'pipe', 'pipe'] });

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

export function linphonerc(identity: TestIdentity, imsDomain: string, tcpPort: number, pcscfIp: string, pcscfPort: number): string {
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
  logExcerpt?: string;
  durationMs: number;
}

export interface VolteTestResult {
  success: boolean;
  steps: VolteTestStep[];
  error?: string;
}

// A single step's raw log transcript can be tens of KB of belle-sip/liblinphone debug
// noise — cap it generously (this is a debugging tool, verbosity is the point) rather
// than truncate to a one-line summary like the old timeout-only snippet did.
const LOG_EXCERPT_MAX = 20000;

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
  // `extra.detail` overrides/sets the human-readable summary on success (e.g. which
  // IMSI/auc_id/apn_id got created); `extra.logExcerpt` attaches a raw transcript
  // (evaluated via a closure so it can read session buffers captured at call time) —
  // both are evaluated here, before onStep fires, since by the time `wrap()` returns to
  // its caller the step has already been streamed to the client.
  const wrap = async <T,>(
    name: string, fn: () => Promise<T>,
    extra?: { detail?: () => string; logExcerpt?: () => string },
  ): Promise<T> => {
    try {
      const result = await runStep(steps, name, fn);
      const step = steps[steps.length - 1];
      if (extra?.detail) step.detail = extra.detail();
      if (extra?.logExcerpt) step.logExcerpt = extra.logExcerpt().slice(-LOG_EXCERPT_MAX);
      if (onStep) onStep(step);
      return result;
    } catch (err) {
      const step = steps[steps.length - 1];
      if (extra?.logExcerpt) {
        try { step.logExcerpt = extra.logExcerpt().slice(-LOG_EXCERPT_MAX); } catch { /* best-effort */ }
      }
      if (onStep) onStep(step);
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
  let ims: ImsState | null = null;
  let provA: { apnId: number; aucId: number } | undefined;
  let provB: { apnId: number; aucId: number } | undefined;
  let linphoneWasAlreadyInstalled = false;

  // Raw per-step transcript helpers — sessions accumulate everything (including verbose
  // belle-sip/liblinphone debug noise) in `.buffer`; these let each step attach only the
  // slice that happened during that step, not the other session's or a prior step's.
  const markOf = (s?: LinphoneSession) => s?.buffer.length ?? 0;
  const diffOf = (s: LinphoneSession | undefined, from: number) => (s?.buffer.slice(from) ?? '').trim();
  const combinedDiff = (aFrom: number, bFrom: number): string => {
    const a = diffOf(sessionA, aFrom);
    const b = diffOf(sessionB, bFrom);
    const parts: string[] = [];
    if (a) parts.push(`── A (${identityA?.imsi}) ──\n${a}`);
    if (b) parts.push(`── B (${identityB?.imsi}) ──\n${b}`);
    return parts.join('\n\n');
  };

  try {
    const state = await wrap('Check IMS is configured', async () => {
      ims = readImsState();
      if (!ims) throw new Error('IMS is not configured — run the IMS Configure wizard first.');
      return ims;
    }, { detail: () => `Domain ${ims!.imsDomain}, P-CSCF ${ims!.config.pcscfIp}:${ims!.config.pcscfPort ?? 5060}, S-CSCF port ${ims!.config.scscfPort ?? 6060}` });

    const { mcc, mnc, scscfPort = 6060, pcscfIp, pcscfPort = 5060 } = state.config;
    identityA = makeTestIdentity(mcc, mnc, 1);
    identityB = makeTestIdentity(mcc, mnc, 2);

    await wrap('Ensure linphonec is installed', async () => {
      try {
        await nsenter('which', ['linphonec']);
        linphoneWasAlreadyInstalled = true;
      } catch { /* not installed — ensureLinphoneInstalled will apt-get it */ }
      await ensureLinphoneInstalled();
    }, { detail: () => linphoneWasAlreadyInstalled ? 'Already installed' : 'Installed via apt-get (linphone-cli)' });

    await wrap('Provision test subscriber A in PyHSS', async () => { provA = await provisionPyhssTestSubscriber(identityA!, state.imsDomain, scscfPort); },
      { detail: () => `IMSI ${identityA!.imsi}, MSISDN ${identityA!.msisdn}, auc_id=${provA!.aucId}, apn_id=${provA!.apnId}` });
    await wrap('Provision test subscriber B in PyHSS', async () => { provB = await provisionPyhssTestSubscriber(identityB!, state.imsDomain, scscfPort); },
      { detail: () => `IMSI ${identityB!.imsi}, MSISDN ${identityB!.msisdn}, auc_id=${provB!.aucId}, apn_id=${provB!.apnId}` });

    await wrap('Enable S-CSCF test auth mode (Digest-MD5)', async () => {
      await setScscfTestAuthMode(true);
      testAuthModeEnabled = true;
    }, { detail: () => 'REG_AUTH_DEFAULT_ALG set to "MD5" in scscf.cfg, kamailio-scscf restarted (subscriber\'s Ki hex used directly as the SIP digest password)' });

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
    }, {
      detail: () => `sip:${identityA!.imsi}@${state.imsDomain} registered via TCP to ${pcscfIp}:${pcscfPort}`,
      logExcerpt: () => diffOf(sessionA, 0),
    });
    await wrap('Register subscriber B', async () => {
      sessionB = startLinphoneSession(configB, dirB);
      await sessionB.waitFor(/Register refresher \[200\]|registered, identity=/, 20000);
    }, {
      detail: () => `sip:${identityB!.imsi}@${state.imsDomain} registered via TCP to ${pcscfIp}:${pcscfPort}`,
      logExcerpt: () => diffOf(sessionB, 0),
    });

    let markA = markOf(sessionA), markB = markOf(sessionB);
    await wrap('Place call A → B', async () => {
      sessionA!.send(`call sip:${identityB!.imsi}@${state.imsDomain}`);
      await sessionB!.waitFor(/Incoming call ringing/, 15000);
    }, {
      detail: () => `INVITE sent A → sip:${identityB!.imsi}@${state.imsDomain}, ringing on B`,
      logExcerpt: () => combinedDiff(markA, markB),
    });

    markA = markOf(sessionA); markB = markOf(sessionB);
    await wrap('Answer call on B', async () => {
      sessionB!.send('answer');
      await Promise.all([
        sessionA!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
        sessionB!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
      ]);
    }, {
      detail: () => '200 OK sent from B, both legs report media streams established',
      logExcerpt: () => combinedDiff(markA, markB),
    });

    markA = markOf(sessionA); markB = markOf(sessionB);
    await wrap('Verify bidirectional RTP media', async () => {
      await Promise.all([
        sessionA!.waitFor(/Bandwidth usage for CallSession/, 10000),
        sessionB!.waitFor(/Bandwidth usage for CallSession/, 10000),
      ]);
    }, {
      detail: () => 'Bandwidth usage confirmed on both legs — RTP is actually flowing, not just signaling',
      logExcerpt: () => combinedDiff(markA, markB),
    });

    await wrap(`Hold call (${CALL_HOLD_MS / 1000}s)`, async () => {
      await new Promise(resolve => setTimeout(resolve, CALL_HOLD_MS));
    }, {
      detail: () => `Kept the call up for ${CALL_HOLD_MS / 1000}s with RTP actively flowing before hangup`,
    });

    markA = markOf(sessionA); markB = markOf(sessionB);
    await wrap('Hang up cleanly', async () => {
      sessionA!.send('terminate');
      await sessionA!.waitFor(/LinphoneCallEnd|LinphoneCallReleased/, 10000);
    }, {
      detail: () => 'BYE sent from A, call released cleanly',
      logExcerpt: () => combinedDiff(markA, markB),
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
