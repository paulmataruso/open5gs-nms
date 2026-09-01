import { Router, Request, Response } from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { createDummyInterface, deleteDummyInterface } from '../../infrastructure/network/dummy-interface';
import { classifyMajorEvent, parseOpen5gsTimestamp, describeBearerCause } from '../../application/use-cases/major-event-classifier';
import {
  SRSRAN_IMAGE, SRSRAN_BUILD_CONTEXT, VAL_NICKNAME_PREFIX,
  InferredConfig,
  inferConfig, buildEnbConf, buildRrConf, buildUeConf, allocateRadioDummyIp,
  allocateImsiBlock, allocateIpBlock, makeImsi, makeSubscriber, safeDeleteTestImsi,
  dockerRun, dockerKill, dockerImageExists, dockerBuild,
  detectHostCapacity, computeResourceBudget,
} from './validation-controller';
import {
  HOST_ROOT, readImsState, ImsState, TestIdentity,
  provisionPyhssTestSubscriber, deprovisionPyhssTestSubscriber, setScscfTestAuthMode,
  ensureLinphoneInstalled, startLinphoneSession, LinphoneSession, linphonerc,
} from './volte-validation-controller';

const execFileAsync = promisify(execFile);
const moduleLogger = pino({ name: 'qci-validation-controller' });

// ── QCI / dedicated-bearer validation ───────────────────────────────────────
//
// Neither the plain UERANSIM/srsRAN validation (radio/NAS attach only, PDU sessions use
// QCI=9 — no IMS involved) nor the linphonec-only VoLTE test (pure SIP/IMS layer, no
// RRC/S1AP at all) can ever exercise a dedicated QCI=1 bearer: that only gets created when
// Kamailio's Rx interface tells PCRF about a real audio SIP call, PCRF issues a Gx RAR, and
// SMF/MME send a real S1AP E-RABSetupRequest to a real, NAS-attached UE's eNB. Neither
// existing test has a NAS-attached UE context to hang a dedicated bearer off of. This is
// exactly the gap the real Nokia VoLTE investigation exposed (see CLAUDE.md pattern #13 and
// PROJECT_STATE.md) — a regression in either the core's own Rx/Gx/S1AP wiring, OR the
// physical radio's own QCI admission config, would sail through every other test untouched.
//
// This test closes that gap without needing a real phone: it reuses validation-controller.ts's
// srsue+srsenb (ZMQ RF loopback — a real, protocol-correct software eNB+UE pair, not a real
// radio) to get a real NAS/S1AP-attached UE with a default bearer, on the "ims" APN, using
// the SAME IMSI/Ki for both the real Mongo/NAS subscriber AND a PyHSS IMS identity (Digest-MD5
// test auth mode, same as the existing VoLTE test) — then places a real SIP call from
// `linphonec` running INSIDE that UE's own network namespace (so its SIP/RTP genuinely rides
// the PDU session, not the host's default route) to a second, ordinary PyHSS-only test
// subscriber on the host, exactly like the existing VoLTE test's B leg.
//
// This validates the CORE's own dedicated-bearer request logic end-to-end (Rx -> Gx -> S1AP).
// It does NOT validate any specific physical radio's own admission-control config — srsenb is
// a generic, well-behaved eNB simulator, not a stand-in for e.g. a Nokia radio's own LMT
// settings. See CLAUDE.md / PROJECT_STATE.md for that distinction and why both matter.
//
// Pass/fail signal: MME only logs a SUCCESSFUL E-RABSetupResponse at ogs_debug level (not
// visible in this deployment's real log verbosity — see s1ap_handle_e_rab_setup_response in
// open5gs's own src/mme/s1ap-handler.c), so there's no positive log line to key off. The
// primary signal is therefore the same ground-truth signal the existing VoLTE test already
// uses — does linphonec confirm real bidirectional RTP bandwidth — and the new
// bearer_setup_failure Major Event category (major-event-classifier.ts) is used as a
// time-window-correlated diagnostic explaining *why* when it fails (e.g. surfacing cause 37
// automatically), not as the primary detector.

// Must live under /tmp/ue-validation, NOT a sibling /tmp path — this backend container talks
// to the HOST's own dockerd via the bind-mounted docker.sock to launch the srsRAN container
// (docker-outside-of-docker), so every `-v hostPath:containerPath` argument passed to `docker
// run` is resolved by the daemon against the REAL HOST filesystem, not this container's own
// view. docker-compose.yml bind-mounts /tmp/ue-validation:/tmp/ue-validation at an identical
// path on both sides specifically so that trick works — any other /tmp path (this file
// originally used a sibling /tmp/qci-validation, which has no such mount) resolves to nothing
// on the real host, so the new container's /config mount silently ends up empty and its
// entrypoint fails with "No such file or directory" for a script that verifiably exists right
// here on the backend's own side. Confirmed live 2026-08-29 — see PROJECT_STATE.md.
const QCI_TEST_ROOT = '/tmp/ue-validation/qci';
// On failure, the session dir (config + srsenb/srsue logs) is preserved here instead of being
// deleted, so a crash can actually be diagnosed afterward instead of only if someone is
// watching live — the container itself can already be gone (its entrypoint exits once
// srsenb/srsue both exit) by the time anyone looks, taking `docker logs` with it. Only the
// single most recent failure is kept (pruned at the start of each run) so repeated failed
// attempts don't accumulate disk usage indefinitely.
const FAILURE_ARCHIVE_DIR = '/tmp/ue-validation/qci-last-failure';
const MME_LOG_PATH = '/var/log/open5gs/mme.log';
// Bounded tail read for the post-call bearer-failure check — this test checks its own log
// window (a few seconds, right after placing the call) immediately, not hours later, so a
// much smaller window than major-event-classifier.ts's own 300MB (built for a live, possibly
// long-idle UI view) is plenty here.
const MME_LOG_TAIL_BYTES = 8 * 1024 * 1024;
const CALL_HOLD_MS = 8000;
const ATTACH_TIMEOUT_MS = 90_000;

export interface QciTestStep {
  name: string;
  ok: boolean;
  detail?: string;
  logExcerpt?: string;
  durationMs: number;
}

export interface QciTestResult {
  success: boolean;
  steps: QciTestStep[];
  error?: string;
}

const LOG_EXCERPT_MAX = 20000;

async function runStep<T>(steps: QciTestStep[], name: string, fn: () => Promise<T>): Promise<T> {
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

// ── Container-side linphonec ─────────────────────────────────────────────────
// Mirrors startLinphoneSession() in volte-validation-controller.ts, but that one only works
// for a netns visible from the HOST's own mount namespace (nsenter -t 1) — the srsue-created
// ue4g_0 netns lives inside the srsRAN docker container's OWN mount namespace (created by
// RUN_4G_QCI's `ip netns add`, run as a process inside that container, with no host
// bind-mount for /run/netns), so it's only reachable via `docker exec <container> ip netns
// exec <netns> ...`, not via nsenter -t 1 from here.
function startLinphoneSessionInContainer(containerName: string, netns: string, configPath: string, homeDir: string): LinphoneSession {
  // -i is required here: without it, `docker exec` never forwards the piped stdin through to
  // the in-container process at all (it gets an already-closed stdin), so linphonec's own
  // readline loop immediately fails with "Error in input stream" before it can accept any
  // commands. -t is deliberately omitted — a pseudo-TTY would inject control sequences into
  // the buffer this code parses with plain regexes.
  const proc = spawn('docker', [
    'exec', '-i', containerName, 'ip', 'netns', 'exec', netns,
    'env', `HOME=${homeDir}`, 'linphonec', '-c', configPath, '-d', '3',
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
        check();
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

async function dockerExec(containerName: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', ['exec', containerName, ...args], { timeout: timeoutMs, encoding: 'utf-8' }) as unknown as Promise<{ stdout: string; stderr: string }>;
}

// linphone-cli is installed by RUN_4G_QCI itself now (bundled into the same apt-get call as
// iproute2 — see its own comment for why: running a second, independent `apt-get install`
// here via `docker exec` used to race RUN_4G_QCI's own install for the same
// /var/lib/apt/lists/lock, since `docker run -d` returns as soon as the container starts, not
// when its entrypoint script finishes — confirmed live 2026-08-29, "Could not get lock...
// held by process 7 (apt-get)"). This just waits for that install to finish; the actual
// `apt-get install` fallback only fires if something is genuinely wrong (e.g. a base image
// that predates this change), not as the normal path.
async function ensureLinphoneInstalledInContainer(containerName: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await dockerExec(containerName, ['which', 'linphonec']);
      return;
    } catch { /* not there yet */ }
    if (Date.now() > deadline) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  // Fallback: RUN_4G_QCI's own install never completed within the deadline. Safe to run our
  // own `apt-get install` at this point — 120s is far longer than iproute2+linphone-cli ever
  // take on this host, so RUN_4G_QCI's apt-get has certainly released the lock by now either
  // way (succeeded or failed).
  await dockerExec(containerName, [
    'bash', '-c',
    'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends linphone-cli',
  ], 180000);
  await dockerExec(containerName, ['which', 'linphonec']);
}

// Reads the last MME_LOG_TAIL_BYTES of mme.log and returns any bearer_setup_failure events
// whose timestamp falls at/after `sinceIso` — this deployment's mme.log is directly
// bind-mounted into this container (same as log-download-controller.ts's LOG_BASE), so a
// plain read is enough, no nsenter needed. Correlated by time window rather than IMSI because
// MME doesn't log IMSI on this specific line (see major-event-classifier.ts's own comment) —
// safe in practice since only one QCI validation test can run at a time (testRunning below).
async function findBearerFailuresSince(sinceIso: string): Promise<{ causeGroup?: number; causeValue?: number; line: string }[]> {
  try {
    const { size } = fs.statSync(MME_LOG_PATH);
    const start = Math.max(0, size - MME_LOG_TAIL_BYTES);
    const fd = fs.openSync(MME_LOG_PATH, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const sinceMs = new Date(sinceIso).getTime();
    const lines = buf.toString('utf8').split('\n');

    const found: { causeGroup?: number; causeValue?: number; line: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.includes('Cause[Group:')) continue;
      // "Cause[Group:%d Cause:%d]" is NOT unique to E-RAB bearer setup failures — Open5GS's
      // MME reuses this exact log line shape in at least one other, unrelated handler (a
      // routine eNB-initiated UEContextReleaseRequest, s1ap-handler.c ~line 2105). Confirmed
      // live 2026-08-30 on this shared, real production MME: a genuinely unrelated cause-20
      // release from other real subscriber traffic got misreported as this test's own
      // dedicated-bearer rejection. Real E-RAB failures always follow an
      // "E_RABFailedToSetupListBearerSURes" marker line within a few lines beforehand (see
      // s1ap-handler.c) — require it, rather than trusting the Cause line in isolation.
      const windowStart = Math.max(0, i - 6);
      if (!lines.slice(windowStart, i).some(l => l.includes('E_RABFailedToSetupListBearerSURes'))) continue;
      const ts = parseOpen5gsTimestamp(raw);
      if (!ts || new Date(ts).getTime() < sinceMs) continue;
      const message = raw.replace(/^\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}:\s*/, '');
      const event = classifyMajorEvent(message, 'mme');
      if (event?.type === 'bearer_setup_failure') {
        found.push({ causeGroup: event.causeGroup, causeValue: event.causeValue, line: raw.trim() });
      }
    }
    return found;
  } catch (err) {
    moduleLogger.warn({ err: String(err) }, 'Failed to read mme.log for bearer-failure check');
    return [];
  }
}

const RUN_4G_QCI = `#!/bin/bash
set -e
echo "[QCI-VALIDATION] Starting"
> /logs/gnb.log
> /logs/ue.log
apt-get update -qq && apt-get install -y -qq --no-install-recommends iproute2 linphone-cli >> /logs/gnb.log 2>&1 \\
    || echo "[QCI-VALIDATION] WARNING: iproute2/linphone-cli install failed" >> /logs/gnb.log
mkdir -p /run/netns
for cfg in /config/enb*.conf; do
    nice -n 10 srsenb "$cfg" >> /logs/gnb.log 2>&1 &
done
sleep 5
for cfg in $(ls /config/ue*.conf 2>/dev/null | sort); do
    ns=$(grep 'netns' "$cfg" | awk -F= '{print $2}' | tr -d ' ')
    if [ -n "$ns" ]; then
        ip netns del "$ns" 2>/dev/null || true
        ip netns add "$ns" 2>/dev/null || true
    fi
    nice -n 10 srsue "$cfg" >> /logs/ue.log 2>&1 &
done
echo "[QCI-VALIDATION] All instances started, monitoring..."
wait
`;

// ── The test itself ──────────────────────────────────────────────────────────

export async function runQciE2ETest(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  onStep?: (step: QciTestStep) => void,
): Promise<QciTestResult> {
  const steps: QciTestStep[] = [];
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

  try { fs.rmSync(FAILURE_ARCHIVE_DIR, { recursive: true, force: true }); } catch { /* ok */ }

  const sessionId = crypto.randomBytes(6).toString('hex');
  const sessionDir = path.join(QCI_TEST_ROOT, sessionId);
  const containerName = `ue-val-4g-qci-${sessionId}`;
  const dirB = `${QCI_TEST_ROOT}/${sessionId}-b`; // real HOST path — see startLinphoneSession's own note

  let failed = false;
  let imsi: string | undefined;
  let dummyIfaceName: string | undefined;
  let containerStarted = false;
  let scscfTestAuthEnabled = false;
  let identityB: TestIdentity | undefined;
  let sessionA: LinphoneSession | undefined;
  let sessionB: LinphoneSession | undefined;

  const markOf = (s?: LinphoneSession) => s?.buffer.length ?? 0;
  const diffOf = (s: LinphoneSession | undefined, from: number) => (s?.buffer.slice(from) ?? '').trim();
  const combinedDiff = (aFrom: number, bFrom: number): string => {
    const a = diffOf(sessionA, aFrom);
    const b = diffOf(sessionB, bFrom);
    const parts: string[] = [];
    if (a) parts.push(`── A (srsue, IMSI ${imsi}) ──\n${a}`);
    if (b) parts.push(`── B (${identityB?.imsi}) ──\n${b}`);
    return parts.join('\n\n');
  };

  try {
    let imsForDetail: ImsState | undefined;
    const ims = await wrap('Check IMS is configured', async () => {
      const state = readImsState();
      if (!state) throw new Error('IMS is not configured — run the IMS Configure wizard first.');
      imsForDetail = state;
      return state;
    }, { detail: () => `Domain ${imsForDetail!.imsDomain}` });

    const { mcc, mnc, scscfPort = 6060, pcscfIp, pcscfPort = 5060 } = ims.config;

    let cfg!: InferredConfig;
    let imsApn!: string;
    await wrap('Read Open5GS config + locate IMS APN', async () => {
      cfg = inferConfig();
      const found = cfg.apns.find(a => a.toLowerCase() === 'ims');
      if (!found) {
        throw new Error(
          `No "ims" APN found in pgwc/smf config (APNs seen: ${cfg.apns.join(', ') || '(none)'}) — ` +
          'IMS must be installed and configured (its own dedicated APN/session pool) before this test can run.',
        );
      }
      imsApn = found;
    }, { detail: () => `PLMN ${cfg.plmn.mcc}-${cfg.plmn.mnc}, MME ${cfg.mmeIp}, IMS APN "${imsApn}"` });

    let baseImsi!: string;
    await wrap('Allocate test IMSI', async () => {
      baseImsi = await allocateImsiBlock(1, subscriberRepo, cfg.plmn.mcc + cfg.plmn.mnc);
      imsi = makeImsi(baseImsi, 0);
    }, { detail: () => `IMSI ${imsi}` });

    let ueIp!: string;
    await wrap('Allocate UE IP in IMS APN subnet', async () => {
      ueIp = await allocateIpBlock(1, imsApn, cfg.subnets, subscriberRepo, logger);
    }, { detail: () => `UE IP ${ueIp}` });

    const k = crypto.randomBytes(16).toString('hex').toUpperCase();
    const opc = crypto.randomBytes(16).toString('hex').toUpperCase();

    await wrap('Create real Mongo/NAS subscriber', async () => {
      await subscriberRepo.create(makeSubscriber(imsi!, k, opc, sessionId, 0, ueIp, cfg, { apn: imsApn }));
    }, { detail: () => `${VAL_NICKNAME_PREFIX}${sessionId.slice(0, 6)}-QCI, default bearer QCI=9 (the dedicated QCI=1 bearer is created dynamically by the call below)` });

    const identityA: TestIdentity = { imsi: imsi!, msisdn: '9' + crypto.randomInt(0, 10000000000).toString().padStart(10, '0'), ki: k, opc };
    identityB = {
      imsi: `${mcc}${mnc.padStart(3, '0')}900${crypto.randomInt(0, 100000).toString().padStart(5, '0')}`.slice(0, 15).padEnd(15, '2'),
      msisdn: '9' + crypto.randomInt(0, 10000000000).toString().padStart(10, '0'),
      ki: crypto.randomBytes(16).toString('hex').toUpperCase(),
      opc: crypto.randomBytes(16).toString('hex').toUpperCase(),
    };

    await wrap('Provision same IMSI as PyHSS IMS identity (A)', async () => {
      await provisionPyhssTestSubscriber(identityA, ims.imsDomain, scscfPort);
    }, { detail: () => `sip:${identityA.imsi}@${ims.imsDomain} — same IMSI/Ki as the NAS subscriber above` });

    await wrap('Provision second, PyHSS-only IMS identity (B)', async () => {
      await provisionPyhssTestSubscriber(identityB!, ims.imsDomain, scscfPort);
    }, { detail: () => `sip:${identityB!.imsi}@${ims.imsDomain} — no radio/NAS involved, same as the existing VoLTE test` });

    await wrap('Enable S-CSCF test auth mode (Digest-MD5)', async () => {
      await setScscfTestAuthMode(true);
      scscfTestAuthEnabled = true;
    }, { detail: () => 'REG_AUTH_DEFAULT_ALG set to "MD5" in scscf.cfg, kamailio-scscf restarted' });

    await wrap('Ensure linphonec is installed on host (for leg B)', async () => {
      await ensureLinphoneInstalled();
    });

    await wrap('Write srsue/srsenb + linphonec config', async () => {
      fs.mkdirSync(path.join(sessionDir, '4g'), { recursive: true });
      fs.mkdirSync(path.join(sessionDir, 'logs4g'), { recursive: true });
      fs.mkdirSync(path.join(sessionDir, 'linphoneA', 'home', '.local', 'share', 'linphone'), { recursive: true });
      fs.mkdirSync(`${HOST_ROOT}${dirB}`, { recursive: true });

      const { name, ip } = allocateRadioDummyIp(sessionId, '4g', 0);
      dummyIfaceName = name;
      await createDummyInterface(name, ip, 32, false);

      fs.writeFileSync(path.join(sessionDir, '4g', 'enb000.conf'), buildEnbConf(0, cfg, { apn: imsApn }, ip));
      fs.writeFileSync(path.join(sessionDir, '4g', 'ue0000.conf'), buildUeConf(imsi!, k.toLowerCase(), opc.toLowerCase(), 0, cfg, { apn: imsApn }));
      fs.writeFileSync(path.join(sessionDir, '4g', 'rr.conf'), buildRrConf(cfg));
      fs.writeFileSync(path.join(sessionDir, '4g', 'run.sh'), RUN_4G_QCI);
      fs.chmodSync(path.join(sessionDir, '4g', 'run.sh'), 0o755);
      fs.writeFileSync(path.join(sessionDir, 'linphoneA', 'linphonerc'), linphonerc(identityA, ims.imsDomain, 15070, pcscfIp, pcscfPort));
      fs.writeFileSync(`${HOST_ROOT}${dirB}/linphonerc`, linphonerc(identityB!, ims.imsDomain, 15071, pcscfIp, pcscfPort));
    }, { detail: () => `APN "${imsApn}", eNB TAC=${cfg.tac4g}, UE IP ${ueIp}` });

    if (!(await dockerImageExists(SRSRAN_IMAGE))) {
      await wrap('Build srsRAN image (first run only, can take 20+ minutes)', async () => {
        await dockerBuild(SRSRAN_IMAGE, SRSRAN_BUILD_CONTEXT);
      });
    }

    await wrap('Start srsenb + srsue container', async () => {
      const capacity = detectHostCapacity();
      const budget = computeResourceBudget(capacity, false, true);
      await dockerRun([
        'run', '-d', '--name', containerName,
        '--network=host', '--privileged',
        '--cap-add=NET_ADMIN', '--cap-add=SYS_ADMIN',
        `--cpus=${budget.cpus4G}`, `--memory=${budget.mem4GGB}g`,
        '-v', `${path.join(sessionDir, '4g')}:/config:ro`,
        '-v', `${path.join(sessionDir, 'logs4g')}:/logs`,
        '-v', `${path.join(sessionDir, 'linphoneA')}:/linphoneA`,
        '--entrypoint', '/bin/bash',
        SRSRAN_IMAGE, '/config/run.sh',
      ]);
      containerStarted = true;
    });

    await wrap('Install linphonec inside container (for leg A)', async () => {
      await ensureLinphoneInstalledInContainer(containerName);
    });

    const ueLogPath = path.join(sessionDir, 'logs4g', 'ue.log');
    await wrap('Wait for real NAS/S1AP attach on the IMS APN', async () => {
      const deadline = Date.now() + ATTACH_TIMEOUT_MS;
      for (;;) {
        const content = fs.existsSync(ueLogPath) ? fs.readFileSync(ueLogPath, 'utf8') : '';
        if (/Network attach successful.*?IP[:\s]+([\d.]+)/is.test(content) || /PDN connection established.*IP[:\s]+([\d.]+)/is.test(content)) return;
        if (Date.now() > deadline) throw new Error(`Timed out after ${ATTACH_TIMEOUT_MS / 1000}s waiting for attach. Last log:\n${content.slice(-2000)}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }, { detail: () => `UE attached with default (QCI=9) bearer on "${imsApn}", IP ${ueIp}` });

    // srsue's `[gw] netns=` mechanism only sets up the TUN device's own connected /24 route —
    // it does NOT add a default route the way a real UE's PDN connection would (confirmed
    // live 2026-08-30 via the diagnostic capture below: `ip route show` inside ue4g_0 showed
    // only `10.46.0.0/24 dev tun_srsue`, nothing else — no route to the P-CSCF's 10.0.1.x
    // subnet at all, which is exactly "Cannot assign requested address": the kernel can't
    // find any route, so it can't pick a source address for the connect()). The netns's own
    // `lo` is also DOWN (every fresh network namespace starts that way — not specific to
    // srsue). Neither of these matters for the existing 4G/5G validation test, which only
    // pings the UE's IP FROM THE HOST (opposite direction, doesn't touch anything inside the
    // netns) — this is the first code in this project to run a process *inside* a UE's own
    // netns making an outbound connection, so it's the first place either gap has mattered.
    await wrap('Configure UE netns routing (default route + lo up)', async () => {
      const gateway = cfg.subnets.find(s => s.dnn === imsApn)?.gateway;
      if (!gateway) throw new Error(`No gateway found for DNN "${imsApn}" in inferred subnets`);
      await dockerExec(containerName, ['ip', 'netns', 'exec', 'ue4g_0', 'ip', 'link', 'set', 'lo', 'up']);
      await dockerExec(containerName, ['ip', 'netns', 'exec', 'ue4g_0', 'ip', 'route', 'add', 'default', 'via', gateway, 'dev', 'tun_srsue']);
    }, { detail: () => `default route via ${cfg.subnets.find(s => s.dnn === imsApn)?.gateway} dev tun_srsue` });

    // Diagnostic — confirms the fix above actually took, and rides along with the rest of
    // the failure archive automatically if a later step still fails for some other reason.
    await wrap('Capture UE netns network state (diagnostic)', async () => {
      const [addr, route] = await Promise.all([
        dockerExec(containerName, ['ip', 'netns', 'exec', 'ue4g_0', 'ip', 'addr', 'show']).catch(e => ({ stdout: '', stderr: String(e) })),
        dockerExec(containerName, ['ip', 'netns', 'exec', 'ue4g_0', 'ip', 'route', 'show']).catch(e => ({ stdout: '', stderr: String(e) })),
      ]);
      fs.writeFileSync(
        path.join(sessionDir, 'logs4g', 'ue-netns-state.log'),
        `=== ip addr show (ue4g_0) ===\n${addr.stdout}${addr.stderr}\n\n=== ip route show (ue4g_0) ===\n${route.stdout}${route.stderr}\n`,
      );
    }, { logExcerpt: () => fs.readFileSync(path.join(sessionDir, 'logs4g', 'ue-netns-state.log'), 'utf8').slice(-LOG_EXCERPT_MAX) });

    await wrap('Register subscriber A (inside UE netns) and B (host)', async () => {
      sessionA = startLinphoneSessionInContainer(containerName, 'ue4g_0', '/linphoneA/linphonerc', '/linphoneA/home');
      sessionB = startLinphoneSession(`${dirB}/linphonerc`, dirB);
      await Promise.all([
        sessionA.waitFor(/Register refresher \[200\]|registered, identity=/, 30000),
        sessionB.waitFor(/Register refresher \[200\]|registered, identity=/, 20000),
      ]);
    }, {
      detail: () => `A via UE netns ue4g_0 -> ${pcscfIp}:${pcscfPort}; B directly from host`,
      logExcerpt: () => combinedDiff(0, 0),
    });

    let markA = markOf(sessionA), markB = markOf(sessionB);
    const callWindowStart = new Date().toISOString();
    await wrap('Place call A → B (triggers Rx → Gx → S1AP dedicated bearer request)', async () => {
      sessionA!.send(`call sip:${identityB!.imsi}@${ims.imsDomain}`);
      await sessionB!.waitFor(/Incoming call ringing/, 20000);
    }, {
      detail: () => `INVITE sent from the NAS-attached UE (A) → sip:${identityB!.imsi}@${ims.imsDomain}, ringing on B`,
      logExcerpt: () => combinedDiff(markA, markB),
    });

    markA = markOf(sessionA); markB = markOf(sessionB);
    let rtpConfirmed = false;
    try {
      await wrap('Answer call on B, verify bidirectional RTP media', async () => {
        sessionB!.send('answer');
        await Promise.all([
          sessionA!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
          sessionB!.waitFor(/LinphoneCallStreamsRunning|Media streams established/, 15000),
        ]);
        await Promise.all([
          sessionA!.waitFor(/Bandwidth usage for CallSession/, 10000),
          sessionB!.waitFor(/Bandwidth usage for CallSession/, 10000),
        ]);
        rtpConfirmed = true;
      }, {
        detail: () => 'Both legs report media streams established and RTP bandwidth confirmed',
        logExcerpt: () => combinedDiff(markA, markB),
      });
      await new Promise(resolve => setTimeout(resolve, CALL_HOLD_MS));
    } catch { /* fall through to the bearer-cause check below regardless of call outcome */ }

    markA = markOf(sessionA); markB = markOf(sessionB);
    await wrap('Hang up', async () => {
      try { sessionA!.send('terminate'); } catch { /* ok */ }
      // Best-effort only — a real, working call (confirmed by the RTP-bandwidth check above)
      // should not be reported as a test FAILURE just because hangup confirmation is slow or
      // one leg doesn't see it. The previous `Promise.race([Promise.all([...]), timeout])`
      // was meant to cap this at 8s either way, but both individual waitFor() calls used that
      // SAME 8000ms timeout, so their own internal rejection could win the race against the
      // outer fallback's resolve() at the same instant — confirmed live 2026-08-29, a fully
      // working call (real RTP audio confirmed both directions) still got reported as a
      // failed test purely because of this. .catch() each one individually instead so neither
      // can ever reject the whole step.
      await Promise.all([
        sessionA!.waitFor(/LinphoneCallEnd|LinphoneCallReleased/, 8000).catch(() => {}),
        sessionB!.waitFor(/LinphoneCallEnd|LinphoneCallReleased/, 8000).catch(() => {}),
      ]);
    }, { logExcerpt: () => combinedDiff(markA, markB) });

    const bearerFailures = await findBearerFailuresSince(callWindowStart);
    const primaryFailure = bearerFailures[0];

    if (primaryFailure && primaryFailure.causeGroup !== undefined && primaryFailure.causeValue !== undefined) {
      const label = describeBearerCause(primaryFailure.causeGroup, primaryFailure.causeValue);
      await wrap('Check MME S1AP log for dedicated bearer rejection', async () => {
        throw new Error(
          `MME's S1AP log shows a bearer setup failure during this call: ${label} ` +
          `(Group:${primaryFailure.causeGroup} Cause:${primaryFailure.causeValue}). ` +
          'This is the network (eNB admission-control or MME/SMF policy) rejecting the dedicated ' +
          'bearer request itself, not a signaling/SIP problem.',
        );
      }, { logExcerpt: () => primaryFailure.line });
      failed = true;
      return { success: false, steps, error: `Dedicated bearer request rejected: ${label}` };
    }

    await runStep(steps, 'Check MME S1AP log for dedicated bearer rejection', async () => {});
    steps[steps.length - 1].detail = 'No bearer_setup_failure logged by MME during the call window';
    if (onStep) onStep(steps[steps.length - 1]);

    if (!rtpConfirmed) {
      failed = true;
      return { success: false, steps, error: 'Call did not establish confirmed RTP media, and MME logged no bearer rejection — likely a SIP/IMS-layer issue, not QCI/bearer admission. Check the step log above.' };
    }

    return { success: true, steps };
  } catch (err) {
    failed = true;
    return { success: false, steps, error: String(err) };
  } finally {
    try { sessionA?.stop(); } catch { /* ok */ }
    try { sessionB?.stop(); } catch { /* ok */ }
    if (scscfTestAuthEnabled) { try { await setScscfTestAuthMode(false); } catch { /* ok */ } }
    if (imsi) {
      try { await deprovisionPyhssTestSubscriber(imsi); } catch { /* ok */ }
      try { await safeDeleteTestImsi(imsi, subscriberRepo, logger); } catch { /* ok */ }
    }
    if (identityB) { try { await deprovisionPyhssTestSubscriber(identityB.imsi); } catch { /* ok */ } }
    // Grab `docker logs` (the container's own entrypoint stdout — apt-get output, the "All
    // instances started" marker, any shell error before srsenb/srsue even started) BEFORE
    // killing it — this is the one thing that isn't already captured in the bind-mounted
    // sessionDir/logs4g files, and it disappears the instant the container is removed.
    if (containerStarted) {
      if (failed) {
        try {
          const { stdout, stderr } = await execFileAsync('docker', ['logs', containerName], { timeout: 10_000 }) as unknown as { stdout: string; stderr: string };
          fs.writeFileSync(path.join(sessionDir, 'container-stdout.log'), stdout + stderr);
        } catch { /* container may already be gone (e.g. entrypoint exited on its own) */ }
      }
      try { await dockerKill(containerName); } catch { /* ok */ }
    }
    if (dummyIfaceName) { try { await deleteDummyInterface(dummyIfaceName); } catch { /* ok */ } }
    if (failed) {
      try {
        fs.mkdirSync(FAILURE_ARCHIVE_DIR, { recursive: true });
        fs.renameSync(sessionDir, path.join(FAILURE_ARCHIVE_DIR, sessionId));
        try { fs.renameSync(`${HOST_ROOT}${dirB}`, path.join(FAILURE_ARCHIVE_DIR, `${sessionId}-b`)); } catch { /* ok */ }
      } catch {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ok */ }
        try { fs.rmSync(`${HOST_ROOT}${dirB}`, { recursive: true, force: true }); } catch { /* ok */ }
      }
    } else {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ok */ }
      try { fs.rmSync(`${HOST_ROOT}${dirB}`, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

let testRunning = false;

export function createQciValidationRouter(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    const state = readImsState();
    res.json({ success: true, imsConfigured: !!state, imsDomain: state?.imsDomain ?? null, running: testRunning });
  });

  // POST /api/validation/qci/run — streamed: one line per step as it completes, same
  // ndjson-over-chunked-transfer pattern as /api/validation/volte/run.
  router.post('/run', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (testRunning) {
      return res.status(409).json({ success: false, error: 'A QCI/dedicated-bearer validation test is already running.' });
    }
    testRunning = true;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    try {
      const result = await runQciE2ETest(subscriberRepo, logger, step => {
        res.write(JSON.stringify({ type: 'step', ...step }) + '\n');
      });
      res.write(JSON.stringify({ type: 'result', success: result.success, error: result.error }) + '\n');
      await auditLogger.log({
        action: 'qci_validation_test', user,
        details: `success=${result.success} steps=${result.steps.length}${result.error ? ` error=${result.error}` : ''}`,
        success: result.success,
      });
    } catch (err) {
      res.write(JSON.stringify({ type: 'result', success: false, error: String(err) }) + '\n');
      await auditLogger.log({ action: 'qci_validation_test', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'qci validation test crashed');
    } finally {
      testRunning = false;
      res.end();
    }
  });

  return router;
}
