import {
  dataplaneMemorySysctlContent, nfMemoryDropInContent, nfMemoryDropIn, nfMemoryDropInDir,
  applyNfMemoryPolicy, NO_SWAP_UNITS, DATAPLANE_SWAPPINESS, DATAPLANE_MEMORY_SYSCTL_PATH,
} from '../host-tuning';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';

// ── Keeping the Open5GS user plane out of swap ──────────────────────────────
//
// Measured on this deployment 2026-11-07, before the policy existed:
//   open5gs-upfd   VmRSS 20,956 kB   VmSwap 24,096 kB   (54% paged out)
//   open5gs-sgwud  VmRSS 11,048 kB   VmSwap 23,104 kB   (68%)
//   open5gs-sgwcd  VmRSS 12,828 kB   VmSwap 25,044 kB   (66%)
// ...while the hypervisor sat on 14.3 GB of RAM it had never touched.
//
// The UPF forwards on ONE thread, so a major fault on a cold session-table
// page stalls the whole data plane for an SSD round trip. These tests mostly
// pin NEGATIVE behaviour: this function must not reclaim and must not restart,
// because both of those would be a real outage dressed up as a tuning pass.

const MEMINFO = (totalKb: number, freeKb: number) => [
  'MemTotal:       15238232 kB',
  'MemFree:         2095104 kB',
  `SwapTotal:      ${String(totalKb).padStart(9)} kB`,
  `SwapFree:       ${String(freeKb).padStart(9)} kB`,
].join('\n');

interface Call { cmd: string; args: string[] }

function harness(opts: {
  meminfo?: string;
  swapMax?: string;
  sysctlApplyFails?: boolean;
  cgroupMissing?: boolean;
} = {}) {
  const calls: Call[] = [];
  const writes = new Map<string, string>();
  const ok = { stdout: '', stderr: '', exitCode: 0 };

  const hostExecutor = {
    async executeCommand(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      if (cmd === 'sysctl' && args[0] === '-n') return { ...ok, stdout: `${DATAPLANE_SWAPPINESS}\n` };
      if (cmd === 'sysctl' && args[0] === '-p') {
        return opts.sysctlApplyFails
          ? { stdout: '', stderr: 'cannot stat /proc/sys/vm/swappiness', exitCode: 1 }
          : ok;
      }
      if (cmd === 'cat' && args[0] === '/proc/meminfo') {
        return { ...ok, stdout: opts.meminfo ?? MEMINFO(4194300, 4194300) };
      }
      if (cmd === 'cat' && args[0].includes('memory.swap.max')) {
        return opts.cgroupMissing
          ? { stdout: '', stderr: 'No such file or directory', exitCode: 1 }
          : { ...ok, stdout: `${opts.swapMax ?? '0'}\n` };
      }
      return ok;
    },
    async writeFile(path: string, content: string) { writes.set(path, content); },
  } as unknown as IHostExecutor;

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  return { hostExecutor, logger, calls, writes };
}

describe('dataplaneMemorySysctlContent', () => {
  test('sets swappiness to the chosen value', () => {
    expect(dataplaneMemorySysctlContent()).toMatch(
      new RegExp(`^vm\\.swappiness = ${DATAPLANE_SWAPPINESS}$`, 'm'));
  });

  test('does NOT set swappiness to 0', () => {
    // 10 is deliberate: swap stays reachable as a last resort before the OOM
    // killer. A future edit to 0 should have to change this test on purpose.
    expect(DATAPLANE_SWAPPINESS).toBe(10);
    expect(dataplaneMemorySysctlContent()).not.toMatch(/^vm\.swappiness = 0$/m);
  });

  test('touches nothing but swappiness', () => {
    // It shares /etc/sysctl.d with the GTP-U buffer file; a stray net.core
    // line here would fight that file depending on lexical filename order.
    const settings = dataplaneMemorySysctlContent()
      .split('\n').filter(l => l.trim() && !l.startsWith('#'));
    expect(settings).toEqual([`vm.swappiness = ${DATAPLANE_SWAPPINESS}`]);
  });
});

describe('nfMemoryDropInContent', () => {
  test('forbids swap under [Service]', () => {
    const c = nfMemoryDropInContent();
    expect(c).toMatch(/^\[Service\]$/m);
    expect(c).toMatch(/^MemorySwapMax=0$/m);
    expect(c.indexOf('[Service]')).toBeLessThan(c.indexOf('MemorySwapMax=0'));
  });

  test('sets no memory LIMIT, which would turn refused swap into an OOM kill', () => {
    // MemorySwapMax=0 with a MemoryMax means the cgroup has nowhere to go
    // under pressure and gets killed instead of reclaiming page cache.
    const c = nfMemoryDropInContent();
    expect(c).not.toMatch(/^MemoryMax=/m);
    expect(c).not.toMatch(/^MemoryHigh=/m);
    expect(c).not.toMatch(/^MemoryLimit=/m);
  });

  test('is its own file, not merged into the CPU drop-in', () => {
    // 10-nms-cpu.conf is owned by upfCpuDropInContent and rewritten on every
    // data-plane pass; sharing one file would make each overwrite the other.
    expect(nfMemoryDropIn('open5gs-upfd')).toBe(
      '/etc/systemd/system/open5gs-upfd.service.d/10-nms-memory.conf');
    expect(nfMemoryDropInDir('open5gs-upfd')).toBe(
      '/etc/systemd/system/open5gs-upfd.service.d');
  });
});

describe('NO_SWAP_UNITS', () => {
  test('covers both user-plane forwarders', () => {
    expect(NO_SWAP_UNITS).toContain('open5gs-upfd');
    expect(NO_SWAP_UNITS).toContain('open5gs-sgwud');
  });

  test('is scoped, not every open5gs unit', () => {
    // A request/response NF faulting costs one transaction's latency, not a
    // forwarding stall — pinning swap for all 17 buys nothing and holds RAM.
    for (const u of ['open5gs-nrfd', 'open5gs-udrd', 'open5gs-seppd', 'open5gs-ausfd']) {
      expect(NO_SWAP_UNITS).not.toContain(u);
    }
    expect(NO_SWAP_UNITS.length).toBeLessThan(10);
  });

  test('every entry is a real unit name with no .service suffix', () => {
    // The paths and the cgroup lookup both append .service themselves.
    for (const u of NO_SWAP_UNITS) expect(u).toMatch(/^open5gs-[a-z0-9]+$/);
    expect(new Set(NO_SWAP_UNITS).size).toBe(NO_SWAP_UNITS.length);
  });
});

describe('applyNfMemoryPolicy', () => {
  test('writes the sysctl and one drop-in per unit, then reloads systemd', async () => {
    const { hostExecutor, logger, calls, writes } = harness();
    const r = await applyNfMemoryPolicy(hostExecutor, logger);

    expect(writes.get(`/proc/1/root${DATAPLANE_MEMORY_SYSCTL_PATH}`))
      .toContain(`vm.swappiness = ${DATAPLANE_SWAPPINESS}`);
    for (const u of NO_SWAP_UNITS) {
      expect(writes.get(`/proc/1/root${nfMemoryDropIn(u)}`)).toContain('MemorySwapMax=0');
    }
    expect(calls).toContainEqual({ cmd: 'systemctl', args: ['daemon-reload'] });
    expect(r.error).toBeUndefined();
    expect(r.units).toHaveLength(NO_SWAP_UNITS.length);
    expect(r.units.every(u => u.swapMax === '0')).toBe(true);
  });

  test('never runs a swap cycle', async () => {
    // The whole reason this is policy-only. swapoff -a took 90s and ~2 GB of
    // read I/O on this host; running it on every backend start and every
    // Apply Config would be a recurring self-inflicted I/O storm.
    const { hostExecutor, logger, calls } = harness({ meminfo: MEMINFO(4194300, 2140636) });
    await applyNfMemoryPolicy(hostExecutor, logger);
    expect(calls.map(c => c.cmd)).not.toContain('swapoff');
    expect(calls.map(c => c.cmd)).not.toContain('swapon');
  });

  test('never restarts or stops an NF', async () => {
    // Restarting upfd desynchronises every established PDU session and does
    // not self-heal — strictly worse than leaving pages in swap.
    const { hostExecutor, logger, calls } = harness();
    await applyNfMemoryPolicy(hostExecutor, logger);
    const systemctl = calls.filter(c => c.cmd === 'systemctl').map(c => c.args[0]);
    expect(systemctl).toEqual(['daemon-reload']);
    for (const verb of ['restart', 'stop', 'try-restart', 'reload-or-restart', 'kill']) {
      expect(systemctl).not.toContain(verb);
    }
  });

  test('verifies against the cgroup, not systemctl show', async () => {
    // `systemctl show -p MemorySwapMax` echoes back the drop-in whether or not
    // it ever reached a running unit's cgroup, so it cannot confirm anything.
    const { hostExecutor, logger, calls } = harness();
    await applyNfMemoryPolicy(hostExecutor, logger);
    const reads = calls.filter(c => c.cmd === 'cat').map(c => c.args[0]);
    for (const u of NO_SWAP_UNITS) {
      expect(reads).toContain(`/sys/fs/cgroup/system.slice/${u}.service/memory.swap.max`);
    }
    expect(calls.filter(c => c.cmd === 'systemctl' && c.args.includes('show'))).toHaveLength(0);
  });

  test('reports a reclaim hint while pages are still parked in swap', async () => {
    // 4194300 - 2140636 = 2053664 kB, the real figure measured on this host.
    const { hostExecutor, logger } = harness({ meminfo: MEMINFO(4194300, 2140636) });
    const r = await applyNfMemoryPolicy(hostExecutor, logger);
    expect(r.stillSwappedKb).toBe(2053664);
    expect(r.reclaimHint).toMatch(/2006 MB/);  // 2053664 / 1024 = 2005.5, rounded
    expect(r.reclaimHint).toMatch(/swapoff -a && swapon -a/);
    expect(r.reclaimHint).toMatch(/not restart an NF/);
  });

  test('no hint once swap is empty, so a healthy host stays quiet', async () => {
    const { hostExecutor, logger } = harness({ meminfo: MEMINFO(4194300, 4194300) });
    const r = await applyNfMemoryPolicy(hostExecutor, logger);
    expect(r.stillSwappedKb).toBe(0);
    expect(r.reclaimHint).toBeUndefined();
  });

  test('a host with swap disabled entirely reports 0, not NaN', async () => {
    const { hostExecutor, logger } = harness({ meminfo: 'MemTotal: 15238232 kB' });
    const r = await applyNfMemoryPolicy(hostExecutor, logger);
    expect(r.stillSwappedKb).toBe(0);
    expect(r.reclaimHint).toBeUndefined();
  });

  test('a failed sysctl -p is surfaced, not swallowed', async () => {
    const { hostExecutor, logger } = harness({ sysctlApplyFails: true });
    const r = await applyNfMemoryPolicy(hostExecutor, logger);
    expect(r.error).toMatch(/cannot stat/);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a drop-in that did not reach the cgroup is warned about, not reported clean', async () => {
    // The failure that matters: files written, daemon-reload returned 0, and
    // the kernel limit never changed. Silence here would read as success.
    const { hostExecutor, logger } = harness({ swapMax: 'max' });
    const r = await applyNfMemoryPolicy(hostExecutor, logger);
    expect(r.units.every(u => u.swapMax === 'max')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ units: expect.arrayContaining(['open5gs-upfd']) }),
      expect.stringMatching(/did not reach the cgroup/),
    );
  });

  test('an absent cgroup (NF not running) yields null, not a thrown error', async () => {
    const { hostExecutor, logger } = harness({ cgroupMissing: true });
    const r = await applyNfMemoryPolicy(hostExecutor, logger);
    expect(r.error).toBeUndefined();
    expect(r.units.every(u => u.swapMax === null)).toBe(true);
  });
});
