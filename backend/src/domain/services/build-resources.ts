/**
 * Memory pre-flight for the from-source build features.
 *
 * Why this exists — a real, fully silent failure on a clean host 2026-11-08.
 * The Kamailio 6.0.8 build ran for ~5 minutes and then simply stopped: the log
 * ends mid-word at `CC (gcc) [M cdp.so]  receiver.o`, with no compiler error,
 * no `make: *** Error`, nothing. That is the signature of a SIGKILL, and the
 * host had **1967 MB available and no swap at all** while running the full
 * stack (17 Open5GS NFs, the three IMS CSCFs, PyHSS, MariaDB, Redis, two
 * Asterisk instances, nine Osmocom daemons, SigScale OCS's Erlang node,
 * VectorCore MMSC/SMSC, strongSwan, plus eight Docker containers).
 *
 * The build endpoints reported only "Build script exited unexpectedly", which
 * cost two full build cycles to attribute. Stopping the three CSCFs freed
 * ~3 GB instantly (they hold a large shared-memory segment each) and the same
 * build then proceeded — which is also what the build itself does before
 * `make install`, so doing it up front costs nothing.
 *
 * `bootstrap-fresh-host.sh` creates no swap, so on an 8 GB host there is no
 * headroom to absorb a gcc peak. Hence: check before starting, say what to do
 * about it, and let an operator override deliberately rather than guess.
 */

/** Available memory a from-source build needs, measured against the real failure. */
export const BUILD_MIN_AVAILABLE_MB = 2560;

/** What to aim for — the retry that succeeded had ~4.9 GB available. */
export const BUILD_RECOMMENDED_AVAILABLE_MB = 3072;

export interface MemInfo {
  availableMb: number | null;
  swapFreeMb: number | null;
}

/**
 * Parses `MemAvailable` and `SwapFree` out of /proc/meminfo.
 *
 * `MemAvailable` specifically, not `MemFree`: free memory looks alarmingly low
 * on any healthy Linux box because the page cache holds the rest, and the
 * kernel's own estimate of what is reclaimable is the number that predicts
 * whether an allocation will succeed.
 */
export function parseMemInfo(meminfo: string): MemInfo {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(meminfo);
    return m ? Number(m[1]) : null;
  };
  const avail = kb('MemAvailable');
  const swapFree = kb('SwapFree');
  return {
    availableMb: avail === null ? null : Math.floor(avail / 1024),
    swapFreeMb: swapFree === null ? null : Math.floor(swapFree / 1024),
  };
}

export interface BuildMemoryVerdict {
  ok: boolean;
  /** True when it only passes by counting swap — it will work, but slowly. */
  degraded: boolean;
  availableMb: number | null;
  swapFreeMb: number | null;
  requiredMb: number;
  message?: string;
}

/**
 * Decides whether there is enough memory to start a from-source build.
 *
 * Swap counts toward the budget deliberately: a build that swaps is slow but
 * it finishes, whereas a build with neither free RAM nor swap is killed with
 * no diagnostic. That distinction is the whole point of this check, so a host
 * WITH swap is allowed through (flagged `degraded`) rather than blocked.
 */
export function checkBuildMemory(
  info: MemInfo,
  requiredMb: number = BUILD_MIN_AVAILABLE_MB,
): BuildMemoryVerdict {
  const { availableMb, swapFreeMb } = info;

  // Could not read /proc/meminfo — do not block the operator on our own
  // inability to measure. The build's own failure is still the backstop.
  if (availableMb === null) {
    return { ok: true, degraded: false, availableMb, swapFreeMb, requiredMb };
  }

  if (availableMb >= requiredMb) {
    return { ok: true, degraded: false, availableMb, swapFreeMb, requiredMb };
  }

  const withSwap = availableMb + (swapFreeMb ?? 0);
  if (withSwap >= requiredMb) {
    return {
      ok: true,
      degraded: true,
      availableMb, swapFreeMb, requiredMb,
      message:
        `Only ${availableMb} MB of memory is available, below the ${requiredMb} MB ` +
        `this build wants, but ${swapFreeMb} MB of swap can cover the shortfall. ` +
        `The build will run and should finish, just slowly.`,
    };
  }

  return {
    ok: false,
    degraded: false,
    availableMb, swapFreeMb, requiredMb,
    message:
      `Not enough memory to build from source: ${availableMb} MB available ` +
      `(${requiredMb} MB needed, ${BUILD_RECOMMENDED_AVAILABLE_MB} MB comfortable) and ` +
      `${swapFreeMb === null ? 'no swap information' : `${swapFreeMb} MB of swap`}. ` +
      `A build killed for memory leaves NO error in its log — it just stops mid-compile — ` +
      `so this is refused up front rather than failing silently 10 minutes in. ` +
      `Free some memory first: stopping the three IMS CSCFs ` +
      `(systemctl stop kamailio-pcscf kamailio-icscf kamailio-scscf) releases roughly 3 GB, ` +
      `and the build stops them anyway before installing. Stopping any running UE Validation ` +
      `session also helps. Adding swap is the durable fix on a host this size. ` +
      `Pass force=true to start anyway.`,
  };
}

/**
 * How long a from-source build may sit in a non-terminal status before its
 * state is treated as stale.
 *
 * Generous on purpose: Kamailio 6.0.8 took ~11 minutes on a 4-core 2009 Xeon
 * and the srsRAN validation image ~40, so a slow host must not have a running
 * build declared dead underneath it.
 */
export const BUILD_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

/**
 * Whether a `/state/reset` should be allowed.
 *
 * Fixes a real deadlock reached on a clean host 2026-11-08. The FRR build died
 * in its apt step without ever writing a terminal status, leaving
 * `status: 'preparing'` forever — and then:
 *
 *   POST /source-build/start        -> 409 "A build is already in progress (status: preparing)"
 *   POST /source-build/state/reset  -> 409 "Cannot reset while status is preparing"
 *
 * so no API path could recover it. Guarding reset against the one state where
 * reset is the thing you need is backwards; but a blind reset while a build is
 * genuinely running would let a second build start on top of it, which is
 * worse. So: terminal status always resettable, a stale start resettable, and
 * an explicit force for everything else.
 */
export function canResetBuildState(
  status: string,
  startedAt: string | null,
  opts: { force?: boolean; now?: number } = {},
): { allowed: boolean; reason: 'terminal' | 'stale' | 'forced' | 'running' } {
  if (['idle', 'complete', 'failed', 'rolled_back'].includes(status)) {
    return { allowed: true, reason: 'terminal' };
  }
  if (opts.force) return { allowed: true, reason: 'forced' };
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const now = opts.now ?? Date.now();
  if (!Number.isNaN(started) && now - started > BUILD_STALE_AFTER_MS) {
    return { allowed: true, reason: 'stale' };
  }
  // No usable timestamp at all means nothing can ever age out, so treat it as
  // stale rather than permanently wedged.
  if (Number.isNaN(started)) return { allowed: true, reason: 'stale' };
  return { allowed: false, reason: 'running' };
}

/** The three from-source build modules and where each keeps its state. */
export const SOURCE_BUILD_STATE_FILES: Record<string, string> = {
  frr: '/etc/open5gs-nms/frr-source-build-state.json',
  kamailio: '/etc/open5gs-nms/kamailio-source-build-state.json',
  rtpengine: '/etc/open5gs-nms/rtpengine-source-build-state.json',
};

/**
 * Which OTHER from-source builds are currently running.
 *
 * Each build controller already refuses to start when ITS OWN build is in
 * progress, but none of them knew about the other two — so starting several
 * together was allowed and they then collided on
 * `/var/lib/apt/lists/lock` during their dependency step:
 *
 *   E: Could not get lock /var/lib/apt/lists/lock. It is held by process N (apt-get)
 *   ==STEP:script_failed==
 *
 * Reproduced twice on clean hosts (2026-11-08). It also defeats the memory
 * pre-flight, which is evaluated per build at start: three builds can each see
 * enough memory individually and then exhaust the host together.
 *
 * `states` maps module name -> its recorded status, so this stays pure and the
 * caller owns the file reads.
 */
export function otherActiveSourceBuilds(
  self: string,
  states: Record<string, { status: string } | null>,
): string[] {
  const terminal = ['idle', 'complete', 'failed', 'rolled_back'];
  return Object.entries(states)
    .filter(([name, st]) => name !== self && st != null && !terminal.includes(st.status))
    .map(([name]) => name);
}
