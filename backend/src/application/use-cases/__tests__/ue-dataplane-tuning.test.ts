import {
  parseCpuList, cpuMaskHex, cpusExcluding, formatCpuList, irqHotCpus,
  ueTunUdevRuleContent, upfCpuDropInContent,
  UE_TUN_TXQUEUELEN, UPF_NICE, applyUeDataPlaneTuning,
  splitCpuSets, nfCpuDropInContent, nfCpuDropIn, USER_PLANE_UNITS,
} from '../host-tuning';

// ── Queue depth and CPU placement for the UE data plane ─────────────────────
//
// Measured on this deployment (a Proxmox guest) 2026-11-07:
//  * 25,651 downlink packets dropped at ogstun's TX queue — the KERNEL unable
//    to hand them to upfd, with the tun default txqueuelen of 500;
//  * all ens20 receive processing on ONE core (1.39M interrupts on cpu2),
//    because the virtio NIC reports Pre-set maximum Combined: 1, so hardware
//    multiqueue is unavailable to the guest and rps_cpus was 0 everywhere;
//  * upfd's forwarding is a single thread (one of its two threads had burned
//    723.75s of CPU, the other 0.14s), sharing a core with that softirq by luck.
//
// None of this makes the UPF multi-core — it cannot be. These tests pin the
// arithmetic that decides WHICH cores, because getting a CPU mask wrong fails
// silently: the kernel accepts a mask that steers onto the very core you were
// trying to avoid.

describe('parseCpuList', () => {
  test('reads the formats /proc/irq/N/smp_affinity_list actually emits', () => {
    expect(parseCpuList('2')).toEqual([2]);
    expect(parseCpuList('0-3')).toEqual([0, 1, 2, 3]);
    expect(parseCpuList('0-1,4-5')).toEqual([0, 1, 4, 5]);
    expect(parseCpuList('3,1,2')).toEqual([1, 2, 3]);
  });

  test('junk and empties yield nothing rather than NaN entries', () => {
    // A NaN in the exclude set silently poisons the complement, so this has to
    // drop rather than propagate.
    expect(parseCpuList('')).toEqual([]);
    expect(parseCpuList('  ')).toEqual([]);
    expect(parseCpuList('x,,-')).toEqual([]);
    expect(parseCpuList(undefined as any)).toEqual([]);
  });

  test('a reversed or absurd range is rejected, not looped over', () => {
    expect(parseCpuList('5-2')).toEqual([]);
    expect(parseCpuList('0-99999')).toEqual([]);
  });
});

describe('cpuMaskHex', () => {
  test('this deployment: 8 CPUs, cpu2 and cpu4 serving NIC IRQs', () => {
    // 0,1,3,5,6,7 -> bits 0,1,3,5,6,7 -> 0xeb
    expect(cpuMaskHex([0, 1, 3, 5, 6, 7], 8)).toBe('eb');
  });

  test('single CPU masks', () => {
    expect(cpuMaskHex([0], 8)).toBe('1');
    expect(cpuMaskHex([3], 8)).toBe('8');
  });

  test('empty set is a valid "RPS off" mask, not a crash', () => {
    expect(cpuMaskHex([], 8)).toBe('0');
  });

  test('above 32 CPUs it emits comma-separated 32-bit words, high word first', () => {
    // The load-bearing case. sysfs rps_cpus is NOT a single hex number beyond
    // 32 CPUs; a single over-long word is rejected outright and RPS stays off.
    expect(cpuMaskHex([0], 64)).toBe('0,1');
    expect(cpuMaskHex([32], 64)).toBe('1,0');
    expect(cpuMaskHex([0, 32], 64)).toBe('1,1');
    expect(cpuMaskHex([31], 64)).toBe('0,80000000');
  });

  test('a CPU beyond the mask width is dropped, not wrapped onto cpu0', () => {
    // Wrapping would steer onto exactly the core we are excluding.
    expect(cpuMaskHex([64], 64)).toBe('0,0');
  });

  test('output always matches the shape the writer validates', () => {
    // applyUeDataPlaneTuning refuses to write a mask failing this regex,
    // because it goes into a shell redirect (sysfs cannot take writeFile's
    // temp-file-and-rename). Every mask this function can produce must pass.
    const cases: Array<[number[], number]> = [
      [[0, 1], 8], [[5], 8], [[0, 33], 64], [[], 8], [[31], 64], [[64], 64],
    ];
    for (const [cpus, total] of cases) {
      expect(cpuMaskHex(cpus, total)).toMatch(/^[0-9a-f]+(,[0-9a-f]+)*$/);
    }
  });
});

describe('cpusExcluding / formatCpuList', () => {
  test('excludes the NIC interrupt cores measured on this host', () => {
    expect(cpusExcluding(8, [2, 4])).toEqual([0, 1, 3, 5, 6, 7]);
  });

  test('excluding nothing keeps every core', () => {
    expect(cpusExcluding(4, [])).toEqual([0, 1, 2, 3]);
  });

  test('collapses back into the ranges taskset and systemd accept', () => {
    expect(formatCpuList([0, 1, 3, 5, 6, 7])).toBe('0-1,3,5-7');
    expect(formatCpuList([2])).toBe('2');
    expect(formatCpuList([0, 1, 2, 3])).toBe('0-3');
    expect(formatCpuList([])).toBe('');
  });

  test('a list round-trips through parse and format unchanged', () => {
    const cpus = cpusExcluding(8, [2, 4]);
    expect(parseCpuList(formatCpuList(cpus))).toEqual(cpus);
  });
});

describe('ueTunUdevRuleContent', () => {
  const rule = ueTunUdevRuleContent(['ogstun', 'ogstun2'], UE_TUN_TXQUEUELEN, 'eb');

  test('sets queue depth and steering for each tun device', () => {
    // udev rather than a one-shot `ip link set`, because upfd recreates ogstun
    // on every restart with default attributes — a live apply alone lapses.
    expect(rule).toContain('KERNEL=="ogstun", ATTR{tx_queue_len}="10000"');
    expect(rule).toContain('KERNEL=="ogstun2", ATTR{tx_queue_len}="10000"');
    expect(rule).toContain('KERNEL=="ogstun", ATTR{queues/rx-0/rps_cpus}="eb"');
    expect(rule).toContain('KERNEL=="ogstun2", ATTR{queues/rx-0/rps_cpus}="eb"');
  });

  test('matches the tun exactly, never as a prefix', () => {
    // KERNEL=="ogstun*" would also match ogstun2 and apply the wrong rule
    // twice; the device names differ only by suffix.
    expect(rule).not.toContain('ogstun*');
  });

  test('no devices yields a comment-only rule, not a malformed match', () => {
    const empty = ueTunUdevRuleContent([], UE_TUN_TXQUEUELEN, 'eb');
    expect(empty).not.toContain('KERNEL==');
    expect(empty.trimEnd().split('\n').every(l => l.startsWith('#'))).toBe(true);
  });
});

describe('upfCpuDropInContent', () => {
  const dropin = upfCpuDropInContent('0-1,3,5-7', UPF_NICE);

  test('is a valid systemd [Service] override', () => {
    expect(dropin).toContain('[Service]');
    expect(dropin).toContain('CPUAffinity=0-1,3,5-7');
    expect(dropin).toContain('Nice=-10');
  });

  test('is an exclusion, never a pin to a single core', () => {
    // Hard-pinning a process that may gain threads later is worse than leaving
    // the scheduler a choice; the goal is only to avoid the softirq cores.
    expect(dropin).toContain('CPUAffinity=0-1,3,5-7');
    expect(dropin).not.toMatch(/CPUAffinity=\d+$/m);
  });

  test('does not use realtime scheduling', () => {
    // A runaway SCHED_FIFO dataplane can wedge the whole box, and this one
    // shares its host with ~30 other services.
    // Match the DIRECTIVE, not loose substrings: a bare /rr/ alternative here
    // matched the word "interrupts" in the file's own comment.
    expect(dropin).not.toMatch(/^CPUSchedulingPolicy=/m);
    expect(dropin).not.toMatch(/^IOSchedulingClass=realtime/m);
    expect(UPF_NICE).toBeGreaterThan(-20);
  });
});

describe('irqHotCpus — where interrupts LAND, not where they are permitted', () => {
  // Verbatim from this host. Every NIC IRQ here lists smp_affinity_list 0-7,
  // so reading the permitted set would mark all 8 CPUs "hot", exclude every
  // core, and silently do nothing — which is exactly the bug that shipped on
  // the first attempt. Each single-queue virtio vector in fact lands on one
  // CPU and stays there.
  const PROC = [
    '            CPU0       CPU1       CPU2       CPU3       CPU4       CPU5       CPU6       CPU7       ',
    '  39:          0          0          0          0          0          0          0          0  PCI-MSIX-0000:00:12.0   0-edge      virtio2-config',
    '  40:          0          0          0  103279117          0          0          0          0  PCI-MSIX-0000:00:12.0   1-edge      virtio2-input.0',
    '  41:          0          0          0          0   46220680          0          0          0  PCI-MSIX-0000:00:12.0   2-edge      virtio2-output.0',
    '  46:          0  110402764          0          0          0          0          0          0  PCI-MSIX-0000:00:14.0   1-edge      virtio4-input.0',
    '  47:          0          0   95695040          0          0          0          0          0  PCI-MSIX-0000:00:14.0   2-edge      virtio4-output.0',
  ].join('\n');

  test('ens20 (virtio4) resolves to cpu1 and cpu2', () => {
    expect(irqHotCpus(PROC, ['45', '46', '47'])).toEqual([1, 2]);
  });

  test('ens18 (virtio2) resolves to cpu3 and cpu4', () => {
    expect(irqHotCpus(PROC, ['39', '40', '41'])).toEqual([3, 4]);
  });

  test('both NICs together leave 0,5,6,7 free for the forwarding thread', () => {
    const hot = [...new Set([...irqHotCpus(PROC, ['39','40','41']), ...irqHotCpus(PROC, ['45','46','47'])])].sort();
    expect(hot).toEqual([1, 2, 3, 4]);
    const free = cpusExcluding(8, hot);
    expect(free).toEqual([0, 5, 6, 7]);
    // bits 0,5,6,7 = 1+32+64+128 = 225 = 0xe1
    expect(cpuMaskHex(free, 8)).toBe('e1');
    expect(formatCpuList(free)).toBe('0,5-7');
  });

  test('an idle link does not cost the forwarding thread a core', () => {
    // Real case: ens19 carries no traffic and its single output vector had
    // taken 830 interrupts, all on cpu7. Judged against its OWN total that is
    // a 100% share and cpu7 got excluded, leaving upfd three cores instead of
    // four. Judged against total NIC load it is noise.
    const withIdle = PROC + '\n'
      + '  44:          0          0          0          0          0          0          0        830  PCI-MSIX-0000:00:13.0   2-edge      virtio3-output.0';
    const all = ['39','40','41','44','45','46','47'];
    expect(irqHotCpus(withIdle, all, 0.02)).toEqual([1, 2, 3, 4]);
    expect(cpusExcluding(8, irqHotCpus(withIdle, all, 0.02))).toEqual([0, 5, 6, 7]);
    // Per-interface it would have looked hot, which is the bug:
    expect(irqHotCpus(withIdle, ['44'], 0.02)).toEqual([7]);
  });

  test('an all-zero IRQ contributes nothing', () => {
    expect(irqHotCpus(PROC, ['39'])).toEqual([]);
  });

  test('reads exactly as many columns as the header declares CPUs', () => {
    // Replaces an earlier assertion that proved nothing: a mutation swapping
    // the non-numeric `break` for `continue` passed, because the `c < nCpu`
    // bound already stops before the descriptive columns. THIS is the real
    // boundary — a row carrying numeric-looking fields past the CPU columns
    // must not have them counted as a ninth CPU.
    const p = [
      '            CPU0       CPU1  ',
      '  10:        100        200        999   IR-PCI-MSI  eth0-rx',
    ].join('\n');
    // 999 sits beyond CPU1 and must be ignored entirely: with it counted the
    // total becomes 1299 and cpu0's share drops below where it belongs.
    expect(irqHotCpus(p, ['10'])).toEqual([0, 1]);
    // 100/300 = 0.33 and 200/300 = 0.67, so a 0.4 threshold keeps only cpu1.
    expect(irqHotCpus(p, ['10'], 0.4)).toEqual([1]);
  });

  test('unknown IRQs, no header, or empty input yield nothing', () => {
    expect(irqHotCpus(PROC, ['999'])).toEqual([]);
    expect(irqHotCpus('no header here\n  1:  5  5', ['1'])).toEqual([]);
    expect(irqHotCpus('', ['1'])).toEqual([]);
    expect(irqHotCpus(undefined as any, ['1'])).toEqual([]);
  });

  test('a negligible share is not counted as hot', () => {
    // virtio1-virtqueues had 14 interrupts on cpu4 against millions elsewhere;
    // calling that core "hot" would needlessly shrink the usable set.
    const p = [
      '            CPU0       CPU1  ',
      '  10:    1000000         14  x-edge  nic-input.0',
    ].join('\n');
    expect(irqHotCpus(p, ['10'])).toEqual([0]);
  });
});

// ── RPS must not undo hardware multiqueue ───────────────────────────────────
//
// This deployment is a Proxmox guest whose virtio NIC reports "Pre-set maximum
// Combined: 1", so every device here has exactly ONE rx queue and RPS is the
// only way to get receive processing off a single core. Bare metal is the
// opposite: a NIC with N rx queues is already spread by RSS across the cores
// its IRQs land on, and writing this pass's narrow mask to all N of them would
// funnel them back onto a handful of cores.
//
// That regression would be completely silent — the sysfs writes all succeed —
// so the guard is pinned here rather than trusted.

interface FakeNet {
  /** rx queue count per device. 1 = single queue, >1 = hardware multiqueue. */
  rxQueues: Record<string, number>;
  /** iface -> PCI dir holding msi_irqs, and the IRQ numbers there. */
  irqs: Record<string, string[]>;
  procInterrupts: string;
  totalCpus: number;
}

function fakeHost(net: FakeNet) {
  const writes: Array<{ dev: string; queue: string; mask: string }> = [];
  const files = new Map<string, string>();
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const fail = { stdout: '', stderr: 'No such file or directory', exitCode: 1 };

  const hostExecutor = {
    async executeCommand(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      const a = args.join(' ');
      if (cmd === 'nproc') return { ...ok, stdout: `${net.totalCpus}\n` };
      if (cmd === 'cat' && a === '/proc/interrupts') return { ...ok, stdout: net.procInterrupts };
      if (cmd === 'ls' && a === '/sys/class/net') {
        return { ...ok, stdout: Object.keys(net.rxQueues).join('\n') };
      }
      if (cmd === 'readlink') {
        const iface = /\/sys\/class\/net\/([^/]+)\/device/.exec(a)?.[1] ?? '';
        return net.irqs[iface] ? { ...ok, stdout: `/sys/devices/pci0000:00/${iface}dev\n` } : fail;
      }
      if (cmd === 'ls' && a.endsWith('/msi_irqs')) {
        const iface = Object.keys(net.irqs).find(i => a.includes(`${i}dev`));
        return iface ? { ...ok, stdout: net.irqs[iface].join('\n') } : fail;
      }
      if (cmd === 'cat' && a.endsWith('/tx_queue_len')) return { ...ok, stdout: '500\n' };
      if (cmd === 'ls' && a.endsWith('/queues')) {
        const dev = /\/sys\/class\/net\/([^/]+)\/queues/.exec(a)?.[1] ?? '';
        const n = net.rxQueues[dev];
        if (n === undefined) return fail;
        return { ...ok, stdout: Array.from({ length: n }, (_, i) => `rx-${i}\ntx-${i}`).join('\n') };
      }
      if (cmd === 'bash') {
        const m = /echo (\S+) > \/sys\/class\/net\/([^/]+)\/queues\/(rx-\d+)\/rps_cpus/.exec(a);
        if (m) { writes.push({ mask: m[1], dev: m[2], queue: m[3] }); return ok; }
      }
      if (cmd === 'pgrep') return { ...ok, stdout: '4242\n' };
      return ok;
    },
    async writeFile(path: string, content: string) { files.set(path, content); },
  } as any;

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  return { hostExecutor, logger, writes, files, calls };
}

/** 8 CPUs; the listed IRQ puts all its interrupts on `hotCpus`. */
function interrupts(irq: string, hotCpus: number[], nCpu = 8): string {
  const header = '           ' + Array.from({ length: nCpu }, (_, i) => `CPU${i}`).join('       ');
  const counts = Array.from({ length: nCpu }, (_, i) => (hotCpus.includes(i) ? '1000000' : '0'));
  return `${header}\n ${irq}:  ${counts.join(' ')}   PCI-MSI  eth-rx\n`;
}

describe('applyUeDataPlaneTuning receive steering', () => {
  test('single-queue device gets the mask (this deployment)', async () => {
    const { hostExecutor, logger, writes } = fakeHost({
      totalCpus: 8,
      rxQueues: { ens18: 1, ogstun: 1 },
      irqs: { ens18: ['30'] },
      procInterrupts: interrupts('30', [1, 2]),
    });
    const r = await applyUeDataPlaneTuning(hostExecutor, ['ogstun'], logger);

    expect(r.nicCpus).toEqual([1, 2]);
    expect(r.rpsSkipped).toEqual([]);
    expect(writes.map(w => `${w.dev}/${w.queue}`).sort()).toEqual(['ens18/rx-0', 'ogstun/rx-0']);
    // cpus 1,2 excluded -> 0,3,4,5,6,7 -> 0xf9
    expect(new Set(writes.map(w => w.mask))).toEqual(new Set(['f9']));
  });

  test('a multiqueue NIC is left alone, not funnelled onto the quiet cores', async () => {
    // 4 rx queues with IRQs spread over cpus 0-3: RSS is already doing the
    // spreading. Writing mask 0xf0 to all four would undo exactly that.
    const { hostExecutor, logger, writes } = fakeHost({
      totalCpus: 8,
      rxQueues: { eth0: 4, ogstun: 1 },
      irqs: { eth0: ['30'] },
      procInterrupts: interrupts('30', [0, 1, 2, 3]),
    });
    const r = await applyUeDataPlaneTuning(hostExecutor, ['ogstun'], logger);

    expect(r.rpsSkipped).toEqual([{ dev: 'eth0', rxQueues: 4 }]);
    expect(writes.some(w => w.dev === 'eth0')).toBe(false);
    // The tun is still steered — it is genuinely single-queue on every host.
    expect(writes.map(w => `${w.dev}/${w.queue}`)).toEqual(['ogstun/rx-0']);
    expect(r.rps?.devs).toEqual(['ogstun']);
  });

  test('no rps_cpus write ever carries a mask of every CPU', async () => {
    // An all-CPUs mask is what a silently-failed IRQ discovery produces, and
    // it would steer onto the very cores the pass exists to avoid. It is also
    // indistinguishable from success in the sysfs exit code.
    const { hostExecutor, logger, writes } = fakeHost({
      totalCpus: 8,
      rxQueues: { ens18: 1, ogstun: 1 },
      irqs: { ens18: ['30'] },
      procInterrupts: interrupts('30', [3]),
    });
    await applyUeDataPlaneTuning(hostExecutor, ['ogstun'], logger);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.mask).not.toBe('ff');
  });
});

// ── Disjoint CPU shares for the two user-plane forwarders ───────────────────
//
// Measured 2026-11-07: upfd and sgwud have the SAME single-threaded shape (of
// each one's two threads, the signal handler had 0.14 s and one worker had
// everything — upfd 815 s, sgwud 471 s). A 4G downlink crosses BOTH on this
// host, because the S5-U endpoints 10.0.1.176 and 10.0.1.156 are two local
// /32s and `ip route get` resolves the hop `dev lo`. Before this, only upfd
// had an affinity drop-in, so the two single threads could land on the same
// CPU and serialise two hops that should pipeline.

describe('splitCpuSets', () => {
  test('this deployment: 4 non-NIC CPUs across 2 forwarders', () => {
    expect(splitCpuSets([0, 5, 6, 7], 2)).toEqual([[0, 5], [6, 7]]);
  });

  test('shares are always disjoint — the whole point', () => {
    for (const [cpus, n] of [[[0, 5, 6, 7], 2], [[1, 2, 3, 4, 5], 2], [[0, 1, 2], 3]] as Array<[number[], number]>) {
      const groups = splitCpuSets(cpus, n);
      const flat = groups.flat();
      expect(new Set(flat).size).toBe(flat.length);
    }
  });

  test('an uneven split gives the remainder to the EARLIER group', () => {
    // USER_PLANE_UNITS is ordered heaviest-first, so the busier forwarder
    // must get the bigger share, not the smaller one.
    expect(splitCpuSets([0, 5, 6], 2)).toEqual([[0, 5], [6]]);
    expect(splitCpuSets([0, 1, 2, 3, 4], 2)).toEqual([[0, 1, 2], [3, 4]]);
  });

  test('never returns an empty group — taskset rejects an empty mask', () => {
    for (const g of splitCpuSets([0, 5], 2)) expect(g.length).toBeGreaterThan(0);
    for (const g of splitCpuSets([3], 2)) expect(g.length).toBeGreaterThan(0);
    expect(splitCpuSets([3], 2)).toEqual([[3]]);
  });

  test('degenerate inputs yield nothing rather than throwing', () => {
    expect(splitCpuSets([], 2)).toEqual([]);
    expect(splitCpuSets([0, 1], 0)).toEqual([]);
    expect(splitCpuSets([0, 1], -1)).toEqual([]);
  });

  test('duplicates collapse, so a repeated CPU cannot appear in two shares', () => {
    expect(splitCpuSets([5, 0, 5, 6, 7, 0], 2)).toEqual([[0, 5], [6, 7]]);
  });
});

describe('user-plane CPU placement', () => {
  test('both forwarders get a drop-in, with disjoint masks', async () => {
    const { hostExecutor, logger, files } = fakeHost({
      totalCpus: 8,
      rxQueues: { ens18: 1, ogstun: 1 },
      irqs: { ens18: ['30'] },
      procInterrupts: interrupts('30', [1, 2, 3, 4]),
    });
    const r = await applyUeDataPlaneTuning(hostExecutor, ['ogstun'], logger);

    expect(r.nicCpus).toEqual([1, 2, 3, 4]);
    expect(r.userPlaneCpus.map(u => u.unit)).toEqual(['open5gs-upfd', 'open5gs-sgwud']);
    // candidates 0,5,6,7 -> upfd 0,5 / sgwud 6-7
    expect(r.userPlaneCpus[0].cpuList).toBe('0,5');
    expect(r.userPlaneCpus[1].cpuList).toBe('6-7');

    // The masks must not overlap, or 4G's two hops can share a CPU.
    const a = parseCpuList(r.userPlaneCpus[0].cpuList);
    const b = parseCpuList(r.userPlaneCpus[1].cpuList);
    expect(a.filter(c => b.includes(c))).toEqual([]);

    for (const u of USER_PLANE_UNITS) {
      expect(files.get(`/proc/1/root${nfCpuDropIn(u)}`)).toContain('CPUAffinity=');
    }
  });

  test('.upf stays populated for existing callers', async () => {
    const { hostExecutor, logger } = fakeHost({
      totalCpus: 8,
      rxQueues: { ens18: 1, ogstun: 1 },
      irqs: { ens18: ['30'] },
      procInterrupts: interrupts('30', [1, 2, 3, 4]),
    });
    const r = await applyUeDataPlaneTuning(hostExecutor, ['ogstun'], logger);
    expect(r.upf).not.toBeNull();
    expect(r.upf!.cpuList).toBe(r.userPlaneCpus[0].cpuList);
  });

  test('neither forwarder is ever restarted', async () => {
    // Restarting either one desyncs every established session and does not
    // self-heal — strictly worse than leaving a suboptimal affinity in place.
    const { hostExecutor, logger, calls } = fakeHost({
      totalCpus: 8,
      rxQueues: { ens18: 1, ogstun: 1 },
      irqs: { ens18: ['30'] },
      procInterrupts: interrupts('30', [1, 2]),
    });
    await applyUeDataPlaneTuning(hostExecutor, ['ogstun'], logger);
    const systemctl = calls.filter(c => c.cmd === 'systemctl').map(c => c.args[0]);
    expect(systemctl).toEqual(['daemon-reload']);
  });
});

describe('nfCpuDropInContent', () => {
  test('names the unit it belongs to, so two drop-ins are not confusable', () => {
    expect(nfCpuDropInContent('open5gs-sgwud', '6-7', UPF_NICE))
      .toMatch(/^# open5gs-sgwud CPU placement/m);
    expect(nfCpuDropIn('open5gs-sgwud'))
      .toBe('/etc/systemd/system/open5gs-sgwud.service.d/10-nms-cpu.conf');
  });

  test('is a separate file from the memory drop-in', () => {
    // 10-nms-cpu.conf and 10-nms-memory.conf are written by different passes;
    // sharing one filename would make each overwrite the other.
    expect(nfCpuDropIn('open5gs-upfd')).not.toContain('memory');
  });

  test('sets no realtime scheduling', () => {
    const c = nfCpuDropInContent('open5gs-upfd', '0,5', UPF_NICE);
    expect(c).not.toMatch(/^CPUSchedulingPolicy=/m);
    expect(c).toMatch(/^Nice=-10$/m);
  });
});
