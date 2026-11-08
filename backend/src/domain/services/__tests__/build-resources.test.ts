import {
  parseMemInfo, checkBuildMemory, canResetBuildState, otherActiveSourceBuilds,
  BUILD_MIN_AVAILABLE_MB, BUILD_RECOMMENDED_AVAILABLE_MB, BUILD_STALE_AFTER_MS,
  SOURCE_BUILD_STATE_FILES,
} from '../build-resources';

// Guards the pre-flight added after a real, fully silent failure on a clean
// host 2026-11-08: the Kamailio 6.0.8 build ran ~5 minutes then stopped dead,
// its log ending mid-word at `CC (gcc) [M cdp.so]  receiver.o` with no
// compiler error and no make error — a SIGKILL for memory. The host had
// 1967 MB available and NO swap while running the full stack. The endpoint
// reported only "Build script exited unexpectedly", which took two build
// cycles to attribute.

const MEMINFO = (availKb: number, swapFreeKb: number | null) => [
  'MemTotal:        8131584 kB',
  'MemFree:          329184 kB',
  `MemAvailable:    ${availKb} kB`,
  'Buffers:           71680 kB',
  'Cached:          2166784 kB',
  'SwapTotal:             0 kB',
  ...(swapFreeKb === null ? [] : [`SwapFree:        ${swapFreeKb} kB`]),
].join('\n');

describe('parseMemInfo', () => {
  it('reads MemAvailable and SwapFree in MB', () => {
    expect(parseMemInfo(MEMINFO(2014208, 0))).toEqual({ availableMb: 1967, swapFreeMb: 0 });
  });

  it('uses MemAvailable, not MemFree', () => {
    // MemFree is always alarmingly low on a healthy Linux box because the page
    // cache holds the rest; MemAvailable is the kernel's own reclaimable
    // estimate and is the number that predicts an allocation succeeding.
    const info = parseMemInfo(MEMINFO(5056512, 0));
    expect(info.availableMb).toBe(4938);
    expect(info.availableMb).not.toBe(321);
  });

  it('returns null for a missing SwapFree line rather than assuming zero', () => {
    expect(parseMemInfo(MEMINFO(5056512, null)).swapFreeMb).toBeNull();
  });

  it('returns nulls for unparsable input instead of throwing', () => {
    expect(parseMemInfo('')).toEqual({ availableMb: null, swapFreeMb: null });
  });
});

describe('checkBuildMemory', () => {
  it('REFUSES the exact condition that killed the real build', () => {
    // 1967 MB available, no swap — the measured failure.
    const v = checkBuildMemory({ availableMb: 1967, swapFreeMb: 0 });
    expect(v.ok).toBe(false);
    expect(v.message).toContain('1967 MB available');
  });

  it('allows the condition under which the retry actually succeeded', () => {
    const v = checkBuildMemory({ availableMb: 4938, swapFreeMb: 0 });
    expect(v.ok).toBe(true);
    expect(v.degraded).toBe(false);
  });

  it('allows a low-RAM host that has swap, flagged degraded', () => {
    // A build that swaps is slow but finishes; a build with neither is killed
    // with no diagnostic. That difference is the whole point of this check.
    const v = checkBuildMemory({ availableMb: 1200, swapFreeMb: 4096 });
    expect(v.ok).toBe(true);
    expect(v.degraded).toBe(true);
    expect(v.message).toMatch(/swap can cover/);
  });

  it('refuses when RAM plus swap still falls short', () => {
    expect(checkBuildMemory({ availableMb: 500, swapFreeMb: 256 }).ok).toBe(false);
  });

  it('does not block when /proc/meminfo could not be read', () => {
    // Never fail an operator's build on our own inability to measure.
    const v = checkBuildMemory({ availableMb: null, swapFreeMb: null });
    expect(v.ok).toBe(true);
    expect(v.degraded).toBe(false);
  });

  it('treats absent swap information as no swap, not infinite swap', () => {
    expect(checkBuildMemory({ availableMb: 1000, swapFreeMb: null }).ok).toBe(false);
  });

  it('passes exactly at the threshold', () => {
    expect(checkBuildMemory({ availableMb: BUILD_MIN_AVAILABLE_MB, swapFreeMb: 0 }).ok).toBe(true);
    expect(checkBuildMemory({ availableMb: BUILD_MIN_AVAILABLE_MB - 1, swapFreeMb: 0 }).ok).toBe(false);
  });

  it('honours a caller-supplied requirement', () => {
    expect(checkBuildMemory({ availableMb: 3000, swapFreeMb: 0 }, 6000).ok).toBe(false);
  });

  it('tells the operator what to actually do about it', () => {
    const m = checkBuildMemory({ availableMb: 1967, swapFreeMb: 0 }).message ?? '';
    expect(m).toMatch(/kamailio-pcscf/);        // the ~3 GB the CSCFs hold
    expect(m).toMatch(/swap/);                  // the durable fix
    expect(m).toMatch(/force=true/);            // the deliberate override
    expect(m).toMatch(/NO error in its log/);   // why it is refused up front
  });

  it('keeps the threshold below the recommended figure', () => {
    expect(BUILD_MIN_AVAILABLE_MB).toBeLessThanOrEqual(BUILD_RECOMMENDED_AVAILABLE_MB);
    // And above the measured kill point, or the check would not have caught it.
    expect(BUILD_MIN_AVAILABLE_MB).toBeGreaterThan(1967);
  });
});

describe('canResetBuildState', () => {
  const T0 = Date.parse('2026-11-08T02:00:00.000Z');
  const ago = (ms: number) => new Date(T0 - ms).toISOString();

  it('fixes the real deadlock: a build stuck in `preparing` can be reset', () => {
    // Reached live 2026-11-08 — the FRR build died in its apt step without
    // writing a terminal status, after which /start said "already in progress"
    // and /reset said "cannot reset while status is preparing". No API path
    // recovered it.
    const v = canResetBuildState('preparing', ago(5 * 60 * 60 * 1000), { now: T0 });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('stale');
  });

  it('still allows reset from every terminal status', () => {
    for (const s of ['idle', 'complete', 'failed', 'rolled_back']) {
      expect(canResetBuildState(s, ago(60_000), { now: T0 }).reason).toBe('terminal');
    }
  });

  it('REFUSES to reset a build that is genuinely still running', () => {
    // Kamailio 6.0.8 took ~11 min on this hardware; a reset mid-build would
    // let a second build start on top of it.
    const v = canResetBuildState('building_kamailio', ago(11 * 60 * 1000), { now: T0 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('running');
  });

  it('does not declare a slow-but-live build stale too early', () => {
    // The srsRAN validation image took ~40 min; a slow host could take hours.
    expect(canResetBuildState('preparing', ago(90 * 60 * 1000), { now: T0 }).allowed).toBe(false);
    expect(canResetBuildState('preparing', ago(3 * 60 * 60 * 1000), { now: T0 }).allowed).toBe(false);
  });

  it('allows an explicit force at any point', () => {
    const v = canResetBuildState('preparing', ago(60_000), { force: true, now: T0 });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('forced');
  });

  it('treats a missing or unparsable startedAt as stale, not permanently wedged', () => {
    // Otherwise nothing can ever age out and the deadlock returns.
    expect(canResetBuildState('preparing', null, { now: T0 }).reason).toBe('stale');
    expect(canResetBuildState('preparing', 'not-a-date', { now: T0 }).reason).toBe('stale');
  });

  it('uses the documented staleness window', () => {
    expect(BUILD_STALE_AFTER_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe('otherActiveSourceBuilds', () => {
  // Reproduced twice on clean hosts, 2026-11-08: each build controller refused
  // to start when ITS OWN build was running but knew nothing about the other
  // two, so starting several together was allowed and they collided on the apt
  // lock during their dependency step —
  //   E: Could not get lock /var/lib/apt/lists/lock. It is held by process N
  //   ==STEP:script_failed==
  // It also defeats the memory pre-flight, which is evaluated per build at
  // start: three builds can each see enough memory and then exhaust the host.

  it('names another module whose build is mid-flight', () => {
    expect(otherActiveSourceBuilds('kamailio', {
      kamailio: { status: 'idle' },
      frr: { status: 'building_frr' },
      rtpengine: { status: 'complete' },
    })).toEqual(['frr']);
  });

  it('names several', () => {
    expect(otherActiveSourceBuilds('rtpengine', {
      rtpengine: { status: 'idle' },
      frr: { status: 'preparing' },
      kamailio: { status: 'building_kamailio' },
    }).sort()).toEqual(['frr', 'kamailio']);
  });

  it('never reports the caller itself — that guard lives in the controller', () => {
    expect(otherActiveSourceBuilds('frr', {
      frr: { status: 'building_frr' },
      kamailio: { status: 'complete' },
      rtpengine: { status: 'idle' },
    })).toEqual([]);
  });

  it('treats every terminal status as not running', () => {
    for (const s of ['idle', 'complete', 'failed', 'rolled_back']) {
      expect(otherActiveSourceBuilds('frr', {
        frr: { status: 'idle' }, kamailio: { status: s }, rtpengine: { status: s },
      })).toEqual([]);
    }
  });

  it('ignores a module with no state file yet', () => {
    expect(otherActiveSourceBuilds('frr', {
      frr: { status: 'idle' }, kamailio: null, rtpengine: null,
    })).toEqual([]);
  });

  it('knows about all three modules', () => {
    expect(Object.keys(SOURCE_BUILD_STATE_FILES).sort()).toEqual(['frr', 'kamailio', 'rtpengine']);
  });
});
