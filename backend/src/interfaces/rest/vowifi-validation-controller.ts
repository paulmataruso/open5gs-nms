import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import {
  HOST_ROOT, readImsState, ImsState, ensureLinphoneInstalled,
  TestIdentity, makeTestIdentity, provisionPyhssTestSubscriber, deprovisionPyhssTestSubscriber,
  setScscfTestAuthMode, LinphoneSession, startLinphoneSession, linphonerc,
} from './volte-validation-controller';
import { SWU_NETNS, startSwuTestTunnel, stopSwuTestTunnel, loadSwuState } from './swu-emulator-controller';

// ── VoWiFi End-to-End Validation ─────────────────────────────────────────────
//
// Same idea as the VoLTE E2E test, but the "A" leg runs over a real IPsec tunnel
// instead of loopback — reuses the SWu-IKEv2 emulator (already proven for ping
// tests, see memory: vowifi-architecture) to do a genuine IKEv2/EAP-AKA handshake
// against the configured ePDG in an isolated network namespace, then spawns
// linphonec *inside that same namespace* so its SIP traffic actually transits the
// encrypted tunnel — exactly the path a real VoWiFi-capable phone takes, not a
// shortcut. "B" is a plain local test subscriber, same as the VoLTE test's
// counterpart, so a call across two genuinely different access paths (IPsec
// tunnel vs. direct) still proves signaling + RTP end-to-end.

const VOWIFI_TEST_ROOT = '/tmp/vowifi-validation';

async function nsenter(cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  return execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', cmd, ...args], {
    timeout: timeoutMs, encoding: 'utf-8',
  }) as unknown as Promise<{ stdout: string; stderr: string }>;
}

async function waitForTunnelEstablished(timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastOut = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const { stdout } = await nsenter('swanctl', ['--list-sas'], 5000);
      lastOut = stdout;
      if (/ESTABLISHED/.test(stdout)) return stdout;
    } catch { /* charon not reachable yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`IPsec SA did not reach ESTABLISHED within ${timeoutMs}ms. Last swanctl output:\n${lastOut}`);
}

export interface VowifiTestStep {
  name: string;
  ok: boolean;
  detail?: string;
  logExcerpt?: string;
  durationMs: number;
}

export interface VowifiTestResult {
  success: boolean;
  steps: VowifiTestStep[];
  error?: string;
}

const LOG_EXCERPT_MAX = 20000;

async function runStep<T>(steps: VowifiTestStep[], name: string, fn: () => Promise<T>): Promise<T> {
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

export async function runVowifiE2ETest(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  onStep?: (step: VowifiTestStep) => void,
): Promise<VowifiTestResult> {
  const steps: VowifiTestStep[] = [];
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

  const runId = Math.random().toString(36).slice(2, 10);
  const dirTunnel = `${VOWIFI_TEST_ROOT}/${runId}-tunnel`;
  const dirLocal = `${VOWIFI_TEST_ROOT}/${runId}-local`;
  let sessionTunnel: LinphoneSession | undefined;
  let sessionLocal: LinphoneSession | undefined;
  let identityTunnel: TestIdentity | undefined;
  let identityLocal: TestIdentity | undefined;
  let testAuthModeEnabled = false;
  let tunnelStarted = false;

  const markOf = (s?: LinphoneSession) => s?.buffer.length ?? 0;
  const diffOf = (s: LinphoneSession | undefined, from: number) => (s?.buffer.slice(from) ?? '').trim();
  const combinedDiff = (tFrom: number, lFrom: number): string => {
    const t = diffOf(sessionTunnel, tFrom);
    const l = diffOf(sessionLocal, lFrom);
    const parts: string[] = [];
    if (t) parts.push(`── Tunnel UE (${identityTunnel?.imsi}) ──\n${t}`);
    if (l) parts.push(`── Local B (${identityLocal?.imsi}) ──\n${l}`);
    return parts.join('\n\n');
  };

  try {
    let ims: ImsState | null = null;
    const state = await wrap('Check IMS is configured', async () => {
      ims = readImsState();
      if (!ims) throw new Error('IMS is not configured — run the IMS Configure wizard first.');
      return ims;
    }, { detail: () => `Domain ${ims!.imsDomain}, P-CSCF ${ims!.config.pcscfIp}:${ims!.config.pcscfPort ?? 5060}` });

    const { mcc, mnc, scscfPort = 6060, pcscfIp, pcscfPort = 5060 } = state.config;

    let tunnelInfo: { imsi: string; k: string; opc: string; staticIp: string; autoCreated: boolean } | undefined;
    await wrap('Establish VoWiFi IPsec tunnel (SWu-IKEv2)', async () => {
      tunnelInfo = await startSwuTestTunnel(subscriberRepo);
      tunnelStarted = true;
    }, { detail: () => `IMSI ${tunnelInfo!.imsi}, assigned IP ${tunnelInfo!.staticIp} (auto-created Open5GS subscriber)` });

    let sasOutput = '';
    await wrap('Wait for IPsec SA to reach ESTABLISHED', async () => { sasOutput = await waitForTunnelEstablished(30000); },
      { logExcerpt: () => sasOutput });

    identityTunnel = { imsi: tunnelInfo!.imsi, msisdn: '9' + Math.floor(Math.random() * 1e10).toString().padStart(10, '0'), ki: tunnelInfo!.k, opc: tunnelInfo!.opc };
    identityLocal = makeTestIdentity(mcc, mnc, 2);

    await wrap('Ensure linphonec is installed', ensureLinphoneInstalled);

    await wrap('Provision tunnel UE IMS identity in PyHSS', () => provisionPyhssTestSubscriber(identityTunnel!, state.imsDomain, scscfPort),
      { detail: () => `IMSI ${identityTunnel!.imsi} (same IMSI as the IPsec tunnel's own Open5GS subscriber)` });
    await wrap('Provision local test subscriber B in PyHSS', () => provisionPyhssTestSubscriber(identityLocal!, state.imsDomain, scscfPort),
      { detail: () => `IMSI ${identityLocal!.imsi}, MSISDN ${identityLocal!.msisdn}` });

    await wrap('Enable S-CSCF test auth mode (Digest-MD5)', async () => {
      await setScscfTestAuthMode(true);
      testAuthModeEnabled = true;
    }, { detail: () => 'REG_AUTH_DEFAULT_ALG set to "MD5" in scscf.cfg, kamailio-scscf restarted' });

    fs.mkdirSync(`${HOST_ROOT}${dirTunnel}`, { recursive: true });
    fs.mkdirSync(`${HOST_ROOT}${dirLocal}`, { recursive: true });
    const configTunnel = `${dirTunnel}/linphonerc`;
    const configLocal = `${dirLocal}/linphonerc`;
    fs.writeFileSync(`${HOST_ROOT}${configTunnel}`, linphonerc(identityTunnel, state.imsDomain, 15080, pcscfIp, pcscfPort));
    fs.writeFileSync(`${HOST_ROOT}${configLocal}`, linphonerc(identityLocal, state.imsDomain, 15081, pcscfIp, pcscfPort));

    await wrap('Register tunnel UE over VoWiFi (via IPsec)', async () => {
      sessionTunnel = startLinphoneSession(configTunnel, dirTunnel, SWU_NETNS);
      await sessionTunnel.waitFor(/Register refresher \[200\]|registered, identity=/, 25000);
    }, {
      detail: () => `sip:${identityTunnel!.imsi}@${state.imsDomain} registered via TCP to ${pcscfIp}:${pcscfPort}, routed through the IPsec tunnel netns (${SWU_NETNS})`,
      logExcerpt: () => diffOf(sessionTunnel, 0),
    });

    await wrap('Register local test subscriber B', async () => {
      sessionLocal = startLinphoneSession(configLocal, dirLocal);
      await sessionLocal.waitFor(/Register refresher \[200\]|registered, identity=/, 20000);
    }, {
      detail: () => `sip:${identityLocal!.imsi}@${state.imsDomain} registered via TCP to ${pcscfIp}:${pcscfPort} (loopback, not tunneled)`,
      logExcerpt: () => diffOf(sessionLocal, 0),
    });

    let markT = markOf(sessionTunnel), markL = markOf(sessionLocal);
    await wrap('Place call: tunnel UE → local B', async () => {
      sessionTunnel!.send(`call sip:${identityLocal!.imsi}@${state.imsDomain}`);
      await sessionLocal!.waitFor(/Incoming call ringing/, 15000);
    }, {
      detail: () => `INVITE sent over the tunnel → sip:${identityLocal!.imsi}@${state.imsDomain}, ringing on B`,
      logExcerpt: () => combinedDiff(markT, markL),
    });

    markT = markOf(sessionTunnel); markL = markOf(sessionLocal);
    await wrap('Answer call on B', async () => {
      sessionLocal!.send('answer');
      await Promise.all([
        sessionTunnel!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
        sessionLocal!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
      ]);
    }, {
      detail: () => '200 OK sent from B, both legs report media streams established',
      logExcerpt: () => combinedDiff(markT, markL),
    });

    markT = markOf(sessionTunnel); markL = markOf(sessionLocal);
    await wrap('Verify bidirectional RTP media (through the IPsec tunnel)', async () => {
      await Promise.all([
        sessionTunnel!.waitFor(/Bandwidth usage for CallSession/, 10000),
        sessionLocal!.waitFor(/Bandwidth usage for CallSession/, 10000),
      ]);
    }, {
      detail: () => 'Bandwidth usage confirmed on both legs — RTP is actually flowing through the ESP-encapsulated tunnel, not just signaling',
      logExcerpt: () => combinedDiff(markT, markL),
    });

    markT = markOf(sessionTunnel); markL = markOf(sessionLocal);
    await wrap('Hang up cleanly', async () => {
      sessionTunnel!.send('terminate');
      await sessionTunnel!.waitFor(/LinphoneCallEnd|LinphoneCallReleased/, 10000);
    }, {
      detail: () => 'BYE sent from tunnel UE, call released cleanly',
      logExcerpt: () => combinedDiff(markT, markL),
    });

    return { success: true, steps };
  } catch (err) {
    return { success: false, steps, error: String(err) };
  } finally {
    // Best-effort cleanup, regardless of where the test failed — mirrors the VoLTE
    // test's own finally block. Order matters: stop the SIP clients before tearing
    // down the IPsec tunnel (a clean BYE/de-register can't reach anywhere once the
    // tunnel netns is gone), revert S-CSCF's auth mode before deprovisioning (either
    // order is actually safe here, but this matches the VoLTE test's convention).
    try { sessionTunnel?.stop(); } catch { /* ok */ }
    try { sessionLocal?.stop(); } catch { /* ok */ }
    if (testAuthModeEnabled) {
      try { await setScscfTestAuthMode(false); } catch { /* logged via step failure if this matters */ }
    }
    if (identityTunnel) { try { await deprovisionPyhssTestSubscriber(identityTunnel.imsi); } catch { /* ok */ } }
    if (identityLocal) { try { await deprovisionPyhssTestSubscriber(identityLocal.imsi); } catch { /* ok */ } }
    if (tunnelStarted) {
      try { await stopSwuTestTunnel(subscriberRepo, logger); } catch { /* ok */ }
    }
    try { fs.rmSync(`${HOST_ROOT}${dirTunnel}`, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.rmSync(`${HOST_ROOT}${dirLocal}`, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

let testRunning = false;

export function createVowifiValidationRouter(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    const state = readImsState();
    const swu = loadSwuState();
    res.json({
      success: true,
      imsConfigured: !!state,
      imsDomain: state?.imsDomain ?? null,
      running: testRunning,
      tunnelAlreadyRunning: swu.running,
    });
  });

  router.post('/run', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (testRunning) {
      return res.status(409).json({ success: false, error: 'A VoWiFi validation test is already running.' });
    }
    testRunning = true;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    try {
      const result = await runVowifiE2ETest(subscriberRepo, logger, step => {
        res.write(JSON.stringify({ type: 'step', ...step }) + '\n');
      });
      res.write(JSON.stringify({ type: 'result', success: result.success, error: result.error }) + '\n');
      await auditLogger.log({
        action: 'volte_validation_test', user,
        details: `vowifi success=${result.success} steps=${result.steps.length}${result.error ? ` error=${result.error}` : ''}`,
        success: result.success,
      });
    } catch (err) {
      res.write(JSON.stringify({ type: 'result', success: false, error: String(err) }) + '\n');
      await auditLogger.log({ action: 'volte_validation_test', user, details: `vowifi ${String(err)}`, success: false });
      logger.error({ err: String(err) }, 'vowifi validation test crashed');
    } finally {
      testRunning = false;
      res.end();
    }
  });

  return router;
}
