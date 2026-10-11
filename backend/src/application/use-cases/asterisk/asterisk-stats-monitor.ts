import * as fs from 'fs';
import pino from 'pino';
import { safeNsenter } from '../../../infrastructure/system/safe-nsenter';
import { A2G_RUN, A2G_CONF } from '../../../interfaces/rest/asterisk-2g-controller';

/**
 * Asterisk stats background poller — covers PSTN Gateway's own Asterisk
 * instance and the fully separate, isolated Asterisk-2G instance. Same
 * "background cache, collect() never does I/O" shape as every sibling
 * monitor in this codebase, reached via each instance's own read-only CLI
 * (`asterisk -rx "..."` / `asterisk -C <2g-conf> -rx "..."`) — the only
 * mechanism this project has ever used for either instance (both
 * controllers already do this for real operational purposes today) and
 * the only one actually usable right now: AMI is enabled in both
 * instances' manager.conf, but Asterisk-2G's has never once successfully
 * bound (confirmed live: a real, unfixed port-5038 collision with PSTN's
 * own instance, present since Asterisk-2G's very first install — PSTN's
 * instance always wins the bind) and neither instance has any real AMI
 * credentials provisioned. Fixing that is a separate, deliberate live
 * config change (new dedicated bindaddr per instance + real credentials)
 * this dashboard item does not make.
 *
 * Uses `safeNsenter` (backend/src/infrastructure/system/safe-nsenter.ts),
 * NOT a bare execFile/spawn+timeout — `nsenter -p` forks internally before
 * exec'ing the wrapped command, unconditionally, so a naive timeout only
 * kills the tracked wrapper PID and orphans the real `asterisk -rx`
 * process (confirmed live, the same mechanism found fixing OCS's own RPC
 * helper — see that file's header comment). This matters more here than
 * almost anywhere else in this codebase: Asterisk's own CLI can
 * legitimately hang (a lock-contended or wedged core), and this poller
 * runs unattended on a short interval forever.
 *
 * Real, confirmed-live landmine specific to the 2G side: `asterisk -C
 * <bad-or-stale-path> -rx "..."` does NOT fail — it silently falls back to
 * the compiled-in default config/socket (which PSTN Gateway's own instance
 * owns) and returns THAT instance's real data, exit code 0, no error
 * anywhere. A stderr-text match is a weaker guard than a structural check,
 * and version-fragile — instead, this file checks the real Asterisk-2G
 * control socket actually exists on disk (`fs.existsSync`, immune to
 * Asterisk wording changes, and cheaper than a doomed CLI round trip)
 * BEFORE ever invoking `-C`. The same structural check is applied to
 * PSTN's own default socket for the same reason/symmetry, even though a
 * missing default socket has no "silently answers as a different instance"
 * failure mode the way a bad -C path does (PSTN takes no path argument at
 * all) — it still fails fast and cleanly either way.
 *
 * Deliberately does NOT pre-gate on `isPstnInstalled()`/
 * `isAsterisk2gInstalled()` — `isPstnInstalled()` is a real, confirmed
 * misnomer (checks whether PSTN has been CONFIGURED at least once, not
 * installed — `writePstnState()` is only ever called from
 * `configurePstn()`, never `installPstn()`), so gating on it would show
 * PSTN as falsely down during the real, ordinary window between a
 * successful Install and a successful Configure. The socket-existence
 * check above is the correct, accurate gate for both instances — it
 * reflects "is there a real Asterisk core to talk to right now," which is
 * exactly what this monitor needs and neither install-state function
 * actually promises.
 */

const HOST_ROOT = '/proc/1/root';
const PSTN_SOCKET = `${HOST_ROOT}/run/asterisk/asterisk.ctl`;
const A2G_SOCKET = `${HOST_ROOT}${A2G_RUN}/asterisk.ctl`;
const POLL_INTERVAL_MS = 15_000;
const CLI_TIMEOUT_MS = 10_000;

export type AsteriskInstance = 'pstn' | '2g';
export const ASTERISK_INSTANCES: AsteriskInstance[] = ['pstn', '2g'];

export interface AsteriskPjsipEndpoint {
  name: string;
  channelsActive: number;
}

export interface AsteriskPjsipTransport {
  name: string;
  bindAddress: string;
}

export interface AsteriskInstanceStats {
  up: boolean;
  channelsActive: number;
  callsActive: number;
  callsProcessedTotal: number;
  endpoints: AsteriskPjsipEndpoint[];
  transports: AsteriskPjsipTransport[];
}

function emptyInstanceStats(): AsteriskInstanceStats {
  return { up: false, channelsActive: 0, callsActive: 0, callsProcessedTotal: 0, endpoints: [], transports: [] };
}

function parseChannelsCount(stdout: string): Pick<AsteriskInstanceStats, 'channelsActive' | 'callsActive' | 'callsProcessedTotal'> | null {
  const ch = /^(\d+)\s+active channels?$/m.exec(stdout);
  const ca = /^(\d+)\s+active calls?$/m.exec(stdout);
  const cp = /^(\d+)\s+calls processed$/m.exec(stdout);
  if (!ch || !ca || !cp) return null;
  return { channelsActive: Number(ch[1]), callsActive: Number(ca[1]), callsProcessedTotal: Number(cp[1]) };
}

// Matches real per-endpoint lines like:
//   " Endpoint:  asterisk2g_trunk                                     Not in use    0 of inf"
// The header/placeholder row (" Endpoint:  <Endpoint/CID...>  <State...>  <Channels.>") never
// matches — it has no real "N of inf|N" figure for the trailing group to anchor on.
function parseEndpoints(stdout: string): AsteriskPjsipEndpoint[] {
  const out: AsteriskPjsipEndpoint[] = [];
  const re = /^\s*Endpoint:\s+(\S+)\s+.+?\s+(\d+)\s+of\s+(?:inf|\d+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    out.push({ name: m[1], channelsActive: Number(m[2]) });
  }
  return out;
}

// Matches real transport lines like:
//   "Transport:  transport-external        udp      0      0  10.0.1.200:5060"
// The header/placeholder row never matches — <cos>/<tos> aren't digits.
function parseTransports(stdout: string): AsteriskPjsipTransport[] {
  const out: AsteriskPjsipTransport[] = [];
  const re = /^Transport:\s+(\S+)\s+\S+\s+\d+\s+\d+\s+(\S+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    out.push({ name: m[1], bindAddress: m[2] });
  }
  return out;
}

async function queryInstance(instance: AsteriskInstance): Promise<AsteriskInstanceStats> {
  const socketPath = instance === '2g' ? A2G_SOCKET : PSTN_SOCKET;
  if (!fs.existsSync(socketPath)) return emptyInstanceStats();

  const cArgs = instance === '2g' ? ['-C', A2G_CONF] : [];
  const run = (cmd: string) => safeNsenter('asterisk', [...cArgs, '-rx', cmd], CLI_TIMEOUT_MS);

  const [countsRes, endpointsRes, transportsRes] = await Promise.all([
    run('core show channels count'),
    run('pjsip show endpoints'),
    run('pjsip show transports'),
  ]);
  const counts = parseChannelsCount(countsRes.stdout);
  if (!counts) throw new Error(`asterisk (${instance}): unrecognized 'core show channels count' output`);

  return {
    up: true,
    ...counts,
    endpoints: parseEndpoints(endpointsRes.stdout),
    transports: parseTransports(transportsRes.stdout),
  };
}

export class AsteriskStatsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private latest = new Map<AsteriskInstance, AsteriskInstanceStats>(
    ASTERISK_INSTANCES.map(i => [i, emptyInstanceStats()]),
  );

  constructor(private readonly logger: pino.Logger) {}

  start(): void {
    if (this.timer) return;
    this.sample().catch(err => this.logger.debug({ err: String(err) }, 'Asterisk stats: initial sample failed'));
    this.timer = setInterval(() => {
      this.sample().catch(err => this.logger.debug({ err: String(err) }, 'Asterisk stats: sample failed'));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getLatest(): Map<AsteriskInstance, AsteriskInstanceStats> {
    return this.latest;
  }

  private async sample(): Promise<void> {
    if (this.sampling) return; // previous poll still in flight — skip rather than stack a second round trip
    this.sampling = true;
    try {
      const next = new Map<AsteriskInstance, AsteriskInstanceStats>();
      // Independent per instance — an outage/hang on one never blanks the other's data.
      await Promise.all(ASTERISK_INSTANCES.map(async instance => {
        try {
          next.set(instance, await queryInstance(instance));
        } catch {
          next.set(instance, emptyInstanceStats()); // never stale-serve
        }
      }));
      this.latest = next;
    } finally {
      this.sampling = false;
    }
  }
}
