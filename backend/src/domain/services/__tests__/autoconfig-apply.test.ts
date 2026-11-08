import * as fs from 'fs';
import * as path from 'path';
import {
  netplanDropIn, ipPlanEntriesFor, SERVICE_TO_IP_PLAN,
  buildManifest, canReuseManifest, planFromManifest, addressesToBind,
  AUTOCONFIG_MANIFEST_REV, AutoconfigManifest, AUTOCONFIG_NETPLAN_FILE,
} from '../autoconfig-apply';
import {
  buildAutoconfigContext, allocateAddresses, AUTOCONFIG_SERVICES, AutoconfigPlan,
} from '../autoconfig-plan';

const ENV = {
  AUTOCONFIG_ENABLED: 'true',
  AUTOCONFIG_START_IP: '172.16.0.100',
  AUTOCONFIG_GW: '172.16.0.1',
  AUTOCONFIG_SUBNET: '255.255.255.0',
};

function planFor(taken: string[] = []): AutoconfigPlan {
  const ctx = buildAutoconfigContext({
    enabled: true, interfaceName: 'eth0',
    startIp: ENV.AUTOCONFIG_START_IP, gateway: ENV.AUTOCONFIG_GW,
    subnet: ENV.AUTOCONFIG_SUBNET, secgwPoolSize: 8, skipIpCheck: false,
  });
  if (!ctx.ok) throw new Error('context failed: ' + JSON.stringify(ctx.errors));
  const res = allocateAddresses(ctx.context, ip => taken.includes(ip));
  if (!res.ok) throw new Error('allocation failed: ' + JSON.stringify(res.errors));
  return res.plan;
}

const REQUEST = { startIp: '172.16.0.100', gateway: '172.16.0.1', prefix: 24, secgwPoolSize: 8 };

describe('netplanDropIn', () => {
  it('declares the addresses on the named interface', () => {
    const out = netplanDropIn('eth0', ['172.16.0.101', '172.16.0.102'], 24);
    expect(out).toMatch(/^\s{4}eth0:$/m);
    expect(out).toContain('- "172.16.0.101/24"');
    expect(out).toContain('- "172.16.0.102/24"');
  });

  it('does NOT declare dhcp4, so it cannot override how the mgmt address is obtained', () => {
    // Netplan merges per key. Asserting dhcp4 either way here would override
    // the operator's own management addressing — a DHCP cloud image and a
    // hand-built static host must both survive this drop-in.
    expect(netplanDropIn('eth0', ['10.0.0.5'], 24)).not.toMatch(/dhcp4/);
  });

  it('does not declare a gateway or nameservers — it owns addresses only', () => {
    const out = netplanDropIn('eth0', ['10.0.0.5'], 24);
    expect(out).not.toMatch(/gateway4|routes:|nameservers/);
  });

  it('targets a drop-in filename that sorts AFTER cloud-init, never the cloud-init file itself', () => {
    // cloud-init rewrites 50-cloud-init.yaml, which would discard these.
    expect(AUTOCONFIG_NETPLAN_FILE).toMatch(/^9\d-/);
    expect(AUTOCONFIG_NETPLAN_FILE).not.toContain('cloud-init');
  });

  it('is valid YAML shape for a single interface with many addresses', () => {
    const addrs = Array.from({ length: 11 }, (_, i) => `172.16.0.${101 + i}`);
    const out = netplanDropIn('ens18', addrs, 25);
    expect(out.match(/^\s+- "/gm)).toHaveLength(11);
    expect(out).toContain('/25"');
  });
});

describe('SERVICE_TO_IP_PLAN', () => {
  it('covers every allocated service key, so none is silently never applied', () => {
    for (const svc of AUTOCONFIG_SERVICES) {
      expect(SERVICE_TO_IP_PLAN[svc.key]).toBeDefined();
    }
  });

  it('maps dns to nothing, because BIND listen-on has its own owner', () => {
    expect(SERVICE_TO_IP_PLAN.dns).toEqual([]);
  });

  it('gives P-CSCF and rtpengine the same address', () => {
    expect(SERVICE_TO_IP_PLAN.pcscf).toEqual(['ims-pcscf', 'ims-rtpengine']);
  });
});

describe('ipPlanEntriesFor', () => {
  it('emits one entry per IP Plan service, carrying the allocated address', () => {
    const entries = ipPlanEntriesFor(planFor());
    const byService = new Map(entries.map(e => [e.service, e.ip]));
    expect(byService.get('amf-ngap')).toBe('172.16.0.100');
    expect(byService.get('upf-n3')).toBe('172.16.0.101');
    expect(byService.get('mme-s1mme')).toBe('172.16.0.102');
  });

  it('gives ims-pcscf and ims-rtpengine the SAME allocated address', () => {
    const entries = ipPlanEntriesFor(planFor());
    const pcscf = entries.find(e => e.service === 'ims-pcscf')!;
    const rtp = entries.find(e => e.service === 'ims-rtpengine')!;
    expect(rtp.ip).toBe(pcscf.ip);
  });

  it('emits no entry for dns', () => {
    expect(ipPlanEntriesFor(planFor()).some(e => e.service === 'bind-dns')).toBe(false);
  });

  it('carries skipped-over addresses through correctly', () => {
    // .100 (the start address) is taken -- this is the real case on this
    // network, where .100 is a third-party device -- so AMF skips to .101
    // and every later service shifts with it.
    const entries = ipPlanEntriesFor(planFor(['172.16.0.100']));
    const byService = new Map(entries.map(e => [e.service, e.ip]));
    expect(byService.get('amf-ngap')).toBe('172.16.0.101');
    expect(byService.get('upf-n3')).toBe('172.16.0.102');
  });

  it('produces entries IpPlanApplyUseCase actually recognises', () => {
    // Guards against a typo'd key silently applying nothing at all.
    const KNOWN = new Set([
      'amf-ngap', 'upf-n3', 'mme-s1mme', 'sgwu-s1u', 'sgwc', 'smf-pfcp', 'local-upf-pfcp',
      'ims-pcscf', 'ims-rtpengine', 'mms-mm1', 'vowifi-epdg', 'secgw-gateway',
      'pstn-external-trunk', 'gsm-bsc-mgw', 'gsm-sgsn-gb',
      'sepp-sbi', 'sepp-n32c', 'sepp-n32f', 'bind-dns',
    ]);
    for (const e of ipPlanEntriesFor(planFor())) expect(KNOWN.has(e.service)).toBe(true);
  });
});

describe('canReuseManifest', () => {
  const manifest = (over: Partial<AutoconfigManifest> = {}): AutoconfigManifest => ({
    ...buildManifest(planFor(), REQUEST, [], new Date('2026-11-08T00:00:00Z')),
    ...over,
  });

  it('reuses an unchanged request on the same interface', () => {
    expect(canReuseManifest(manifest(), REQUEST, 'eth0')).toEqual({ reuse: true });
  });

  it('does not reuse when nothing was recorded', () => {
    const r = canReuseManifest(null, REQUEST, 'eth0');
    expect(r.reuse).toBe(false);
  });

  it('PINS the allocation so a reboot cannot re-address a working deployment', () => {
    // The point of the manifest: a transient host answering one probe must
    // never be able to move a service onto a different address.
    const m = manifest();
    expect(canReuseManifest(m, REQUEST, 'eth0').reuse).toBe(true);
    expect(planFromManifest(m).services.find(s => s.key === 'amfNgap')!.ip).toBe('172.16.0.100');
  });

  it('re-allocates when the operator changes the start address', () => {
    const r = canReuseManifest(manifest(), { ...REQUEST, startIp: '172.16.0.200' }, 'eth0');
    expect(r.reuse).toBe(false);
    if (!r.reuse) expect(r.reason).toMatch(/AUTOCONFIG_START_IP changed/);
  });

  it('re-allocates when the gateway changes', () => {
    const r = canReuseManifest(manifest(), { ...REQUEST, gateway: '172.16.0.254' }, 'eth0');
    expect(r.reuse).toBe(false);
    if (!r.reuse) expect(r.reason).toMatch(/AUTOCONFIG_GW changed/);
  });

  it('re-allocates when the mask changes', () => {
    const r = canReuseManifest(manifest(), { ...REQUEST, prefix: 25 }, 'eth0');
    expect(r.reuse).toBe(false);
    if (!r.reuse) expect(r.reason).toMatch(/AUTOCONFIG_SUBNET changed/);
  });

  it('re-allocates when the SecGW pool size changes', () => {
    const r = canReuseManifest(manifest(), { ...REQUEST, secgwPoolSize: 16 }, 'eth0');
    expect(r.reuse).toBe(false);
    if (!r.reuse) expect(r.reason).toMatch(/POOL_SIZE changed/);
  });

  it('re-allocates when the interface changed under it', () => {
    const r = canReuseManifest(manifest(), REQUEST, 'ens18');
    expect(r.reuse).toBe(false);
    if (!r.reuse) expect(r.reason).toMatch(/interface changed/);
  });

  it('re-allocates an older manifest revision rather than misreading it', () => {
    const r = canReuseManifest(manifest({ rev: AUTOCONFIG_MANIFEST_REV - 1 }), REQUEST, 'eth0');
    expect(r.reuse).toBe(false);
    if (!r.reuse) expect(r.reason).toMatch(/revision/);
  });

  it('re-allocates an empty recorded manifest', () => {
    const r = canReuseManifest(manifest({ services: [] }), REQUEST, 'eth0');
    expect(r.reuse).toBe(false);
  });
});

describe('buildManifest / planFromManifest', () => {
  it('round-trips every address of the plan', () => {
    const plan = planFor(['172.16.0.105']);
    const back = planFromManifest(buildManifest(plan, REQUEST, [], new Date()));
    expect(back.services.map(s => s.ip)).toEqual(plan.services.map(s => s.ip));
    expect(back.secgwPool).toEqual(plan.secgwPool);
    expect(back.secgwPoolCidr).toBe(plan.secgwPoolCidr);
    expect(back.allAddresses).toEqual(plan.allAddresses);
  });

  it('records which addresses were skipped, for the operator-facing report', () => {
    const m = buildManifest(planFor(['172.16.0.101', '172.16.0.102']), REQUEST, [], new Date());
    expect(m.skipped).toEqual(['172.16.0.101', '172.16.0.102']);
  });

  it('records the phase outcomes', () => {
    const phases = [{ name: 'bind-addresses', ok: true }, { name: 'ims', ok: false, detail: 'apt failed' }];
    expect(buildManifest(planFor(), REQUEST, phases, new Date()).phases).toEqual(phases);
  });

  it('stamps the time it was applied', () => {
    const m = buildManifest(planFor(), REQUEST, [], new Date('2026-11-08T12:34:56Z'));
    expect(m.appliedAt).toBe('2026-11-08T12:34:56.000Z');
  });

  it('does not alias the plan arrays, so a later mutation cannot corrupt the manifest', () => {
    const plan = planFor();
    const m = buildManifest(plan, REQUEST, [], new Date());
    plan.secgwPool.push('10.0.0.99');
    plan.allAddresses.push('10.0.0.99');
    expect(m.secgwPool).not.toContain('10.0.0.99');
    expect(m.allAddresses).not.toContain('10.0.0.99');
  });
});

describe('addressesToBind', () => {
  it('returns only what is missing, so re-running binds nothing new', () => {
    expect(addressesToBind(['10.0.0.1', '10.0.0.2'], ['10.0.0.1'])).toEqual(['10.0.0.2']);
  });

  it('returns nothing when everything is already bound', () => {
    expect(addressesToBind(['10.0.0.1'], ['10.0.0.1', '172.16.0.173'])).toEqual([]);
  });

  it('DIFFS rather than flushing — the mgmt address must survive', () => {
    // `ip addr flush` on a real NIC drops the address this host is reached
    // on; at boot that means losing the NMS itself.
    const bound = ['172.16.0.173', '172.16.0.101'];
    expect(addressesToBind(['172.16.0.101', '172.16.0.102'], bound)).toEqual(['172.16.0.102']);
  });

  it('preserves planned order', () => {
    expect(addressesToBind(['10.0.0.3', '10.0.0.1', '10.0.0.2'], [])).toEqual(['10.0.0.3', '10.0.0.1', '10.0.0.2']);
  });
});

import { modulesToInstall, unknownModuleNames, MODULE_ENABLE_FLAGS, awaitRunStatus } from '../autoconfig-apply';

describe('modulesToInstall', () => {
  it('respects the ENABLE_* flags by default, not "install everything"', () => {
    // Those flags are the operator's own expressed intent; a module set to
    // false is hidden from the UI, so installing it anyway would bind ports
    // and start services for a feature they chose not to run.
    const mods = modulesToInstall({ ENABLE_GSM_MODULE: 'false', ENABLE_OCS_MODULE: 'true' });
    expect(mods).not.toContain('gsm');
    expect(mods).toContain('ocs');
  });

  it('applies each flag\'s own default when the flag is absent', () => {
    const mods = modulesToInstall({});
    expect(mods).toContain('ims');          // defaults on
    expect(mods).toContain('vowifi');       // defaults on
    expect(mods).not.toContain('gsm');      // defaults off
    expect(mods).not.toContain('pstn');     // defaults off
  });

  it('treats an empty flag value as absent rather than as false', () => {
    expect(modulesToInstall({ ENABLE_IMS_MODULE: '' })).toContain('ims');
    expect(modulesToInstall({ ENABLE_IMS_MODULE: '   ' })).toContain('ims');
  });

  it('treats anything other than "true" as off for a flag that is set', () => {
    for (const v of ['false', '0', 'no', 'TRUE_ISH', 'yes']) {
      expect(modulesToInstall({ ENABLE_IMS_MODULE: v })).not.toContain('ims');
    }
    expect(modulesToInstall({ ENABLE_IMS_MODULE: 'TRUE' })).toContain('ims');
  });

  it('installs everything on AUTOCONFIG_MODULES=all, overriding the flags', () => {
    const mods = modulesToInstall({ AUTOCONFIG_MODULES: 'all', ENABLE_GSM_MODULE: 'false' });
    expect(mods).toHaveLength(MODULE_ENABLE_FLAGS.length);
    expect(mods).toContain('gsm');
  });

  it('accepts an explicit list', () => {
    expect(modulesToInstall({ AUTOCONFIG_MODULES: 'ims,ocs' })).toEqual(['ims', 'ocs']);
  });

  it('keeps the canonical install ORDER regardless of how the list was typed', () => {
    // The order encodes real cross-module install dependencies -- GSM's
    // osmo-sip-connector must exist before Asterisk-2G's install begins --
    // so honouring the operator's typing order would break the install.
    expect(modulesToInstall({ AUTOCONFIG_MODULES: 'asterisk2g,gsm' })).toEqual(['gsm', 'asterisk2g']);
    expect(modulesToInstall({ AUTOCONFIG_MODULES: 'pstn,ims' })).toEqual(['ims', 'pstn']);
  });

  it('tolerates whitespace and empty items in the list', () => {
    expect(modulesToInstall({ AUTOCONFIG_MODULES: ' ims , , ocs ,' })).toEqual(['ims', 'ocs']);
  });

  it('falls back to the flags for the literal value "enabled"', () => {
    expect(modulesToInstall({ AUTOCONFIG_MODULES: 'enabled', ENABLE_GSM_MODULE: 'true' })).toContain('gsm');
  });

  it('is case-insensitive about all/enabled', () => {
    expect(modulesToInstall({ AUTOCONFIG_MODULES: 'ALL' })).toHaveLength(MODULE_ENABLE_FLAGS.length);
    expect(modulesToInstall({ AUTOCONFIG_MODULES: 'Enabled' })).toContain('ims');
  });
});

describe('unknownModuleNames', () => {
  it('reports a typo rather than silently installing nothing for it', () => {
    expect(unknownModuleNames({ AUTOCONFIG_MODULES: 'ims,imss,ocs' })).toEqual(['imss']);
  });

  it('reports nothing for all/enabled/absent', () => {
    expect(unknownModuleNames({})).toEqual([]);
    expect(unknownModuleNames({ AUTOCONFIG_MODULES: 'all' })).toEqual([]);
    expect(unknownModuleNames({ AUTOCONFIG_MODULES: 'enabled' })).toEqual([]);
  });

  it('reports nothing for a fully valid list', () => {
    expect(unknownModuleNames({ AUTOCONFIG_MODULES: 'ims,gsm,secgw' })).toEqual([]);
  });
});

describe('awaitRunStatus', () => {
  const noSleep = async () => {};

  it('returns ok on complete', async () => {
    const r = await awaitRunStatus(() => ({ status: 'complete' }), () => 'all good',
      { timeoutMs: 1000, pollMs: 1, sleep: noSleep });
    expect(r).toEqual({ ok: true, detail: 'all good' });
  });

  it('returns not-ok on failed, carrying the summary', async () => {
    const r = await awaitRunStatus(() => ({ status: 'failed' }), () => 'ims: failed',
      { timeoutMs: 1000, pollMs: 1, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('ims: failed');
  });

  it('reports "reported failed" when the summary is empty', async () => {
    const r = await awaitRunStatus(() => ({ status: 'failed' }), () => '',
      { timeoutMs: 1000, pollMs: 1, sleep: noSleep });
    expect(r.detail).toBe('reported failed');
  });

  it('treats idle as never-started, because the caller already started it', async () => {
    const r = await awaitRunStatus(() => ({ status: 'idle' }), () => '',
      { timeoutMs: 1000, pollMs: 1, sleep: noSleep });
    expect(r).toEqual({ ok: false, detail: 'never started' });
  });

  it('polls until the status changes', async () => {
    let n = 0;
    const r = await awaitRunStatus(
      () => ({ status: ++n < 4 ? 'running' : 'complete' }), () => `after ${n}`,
      { timeoutMs: 10000, pollMs: 1, sleep: noSleep },
    );
    expect(r.ok).toBe(true);
    expect(n).toBe(4);
  });

  it('decides on STATUS, not on how many results arrived', async () => {
    // A use-case that fails partway reports fewer results than it was asked
    // for; a count-based wait would hang on exactly the runs that most need
    // reporting, then blame the timeout instead of the real failure.
    const state = { status: 'failed', results: [{ service: 'a' }] };
    const r = await awaitRunStatus(() => state, s => `${s.results.length} of 5 done`,
      { timeoutMs: 1000, pollMs: 1, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('1 of 5 done');
  });

  it('times out rather than polling forever, and says what it last saw', async () => {
    let t = 0;
    const r = await awaitRunStatus(
      () => ({ status: 'running' }), () => 'still installing ims',
      { timeoutMs: 120000, pollMs: 1, now: () => (t += 30000), sleep: noSleep },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/timed out after 2 min/);
    expect(r.detail).toMatch(/still installing ims/);
  });
});

import { probeWindowSize, allocateWithLazyProbe, PROBE_MAX_ATTEMPTS } from '../autoconfig-apply';
import { readAutoconfigEnv } from '../autoconfig-plan';

describe('probeWindowSize', () => {
  it('starts just above what a clean run needs, not at the whole subnet', () => {
    // Probing all 154 candidates of a /24 from .100 takes over a minute,
    // floods the segment with ARP, and brushes the proxy's own timeout.
    expect(probeWindowSize(18, 0)).toBe(26);
  });

  it('widens on each attempt', () => {
    const sizes = [0, 1, 2, 3].map(a => probeWindowSize(18, a));
    expect(sizes).toEqual([26, 50, 90, 146]);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });

  it('is only a schedule — full coverage is guaranteed by the final attempt', () => {
    // This function alone does NOT reach the end of a /24 host range within
    // the attempt budget (146 < 154), which is why allocateWithLazyProbe
    // widens the last attempt to the whole candidate list. Asserting a
    // threshold here instead is what hid that gap.
    expect(probeWindowSize(18, PROBE_MAX_ATTEMPTS - 1)).toBeLessThan(154);
  });
});

describe('allocateWithLazyProbe', () => {
  const candidates = Array.from({ length: 154 }, (_, i) => `172.16.0.${100 + i}`);

  /** Succeeds once it has N confirmed-free addresses. */
  const allocatorNeeding = (n: number) => (isTaken: (ip: string) => boolean) => {
    const free = candidates.filter(ip => !isTaken(ip));
    return free.length >= n ? { ok: true as const, picked: free.slice(0, n) } : { ok: false as const, picked: [] };
  };

  it('probes only a small window when nothing is occupied', async () => {
    const seen: string[] = [];
    const out = await allocateWithLazyProbe(candidates, 18, {
      probe: async ips => { seen.push(...ips); return { taken: new Set<string>(), results: ips }; },
      allocate: allocatorNeeding(18),
      ok: r => r.ok,
    });
    expect(out.result.ok).toBe(true);
    expect(out.attempts).toBe(1);
    expect(seen).toHaveLength(26);
    expect(seen.length).toBeLessThan(candidates.length);
  });

  it('NEVER allocates an address it has not probed', async () => {
    // The load-bearing property: an un-probed address is reported as taken,
    // so the allocator cannot hand out an address whose freedom is unknown.
    const probedEver = new Set<string>();
    const out = await allocateWithLazyProbe(candidates, 18, {
      probe: async ips => { ips.forEach(i => probedEver.add(i)); return { taken: new Set<string>(), results: ips }; },
      allocate: allocatorNeeding(18),
      ok: r => r.ok,
    });
    for (const ip of (out.result as any).picked) expect(probedEver.has(ip)).toBe(true);
  });

  it('widens the window when occupied addresses push past it', async () => {
    // First 30 addresses all taken: the opening window of 26 cannot satisfy
    // an 18-address allocation, so it must probe further rather than fail.
    const taken = new Set(candidates.slice(0, 30));
    const out = await allocateWithLazyProbe(candidates, 18, {
      probe: async ips => ({ taken: new Set(ips.filter(i => taken.has(i))), results: ips }),
      allocate: allocatorNeeding(18),
      ok: r => r.ok,
    });
    expect(out.result.ok).toBe(true);
    expect(out.attempts).toBeGreaterThan(1);
    expect(out.windowProbed).toBeGreaterThan(26);
  });

  it('does not re-probe an address it already probed', async () => {
    const counts = new Map<string, number>();
    const taken = new Set(candidates.slice(0, 30));
    await allocateWithLazyProbe(candidates, 18, {
      probe: async ips => {
        for (const ip of ips) counts.set(ip, (counts.get(ip) ?? 0) + 1);
        return { taken: new Set(ips.filter(i => taken.has(i))), results: ips };
      },
      allocate: allocatorNeeding(18),
      ok: r => r.ok,
    });
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it('stops at the end of the candidate list and returns the honest failure', async () => {
    // Everything is taken -- it must stop rather than loop, and the final
    // result is the allocator's real error, not a timeout.
    const out = await allocateWithLazyProbe(candidates, 18, {
      probe: async ips => ({ taken: new Set(ips), results: ips }),
      allocate: allocatorNeeding(18),
      ok: r => r.ok,
    });
    expect(out.result.ok).toBe(false);
    expect(out.windowProbed).toBe(candidates.length);
  });

  it('respects the attempt budget rather than widening forever', async () => {
    let probeCalls = 0;
    const out = await allocateWithLazyProbe(candidates, 18, {
      probe: async ips => { probeCalls++; return { taken: new Set(ips), results: ips }; },
      allocate: allocatorNeeding(18),
      ok: r => r.ok,
    }, 2);
    expect(out.attempts).toBeLessThanOrEqual(2);
    expect(probeCalls).toBeLessThanOrEqual(2);
  });

  it('handles a candidate list shorter than the opening window', async () => {
    const few = candidates.slice(0, 5);
    const out = await allocateWithLazyProbe(few, 18, {
      probe: async ips => ({ taken: new Set<string>(), results: ips }),
      allocate: allocatorNeeding(18),
      ok: r => r.ok,
    });
    expect(out.result.ok).toBe(false);
    expect(out.windowProbed).toBe(5);
  });

  it('merges taken addresses across attempts', async () => {
    // An address found occupied in pass 1 must still be occupied in pass 2.
    const taken = new Set(candidates.slice(0, 30));
    const asked: Array<Set<string>> = [];
    await allocateWithLazyProbe(candidates, 18, {
      probe: async ips => ({ taken: new Set(ips.filter(i => taken.has(i))), results: ips }),
      allocate: isTaken => {
        asked.push(new Set(candidates.filter(ip => isTaken(ip))));
        return allocatorNeeding(18)(isTaken);
      },
      ok: r => r.ok,
    });
    expect(asked.length).toBeGreaterThan(1);
    for (const ip of candidates.slice(0, 30)) expect(asked[asked.length - 1].has(ip)).toBe(true);
  });
});

describe('AUTOCONFIG_SKIP_IP_CHECK', () => {
  it('is off unless explicitly set to true', () => {
    // Polarity matters: defaulting this on would silently disable duplicate
    // detection for every deployment that sets nothing.
    expect(readAutoconfigEnv({}).skipIpCheck).toBe(false);
    expect(readAutoconfigEnv({ AUTOCONFIG_SKIP_IP_CHECK: '' }).skipIpCheck).toBe(false);
    expect(readAutoconfigEnv({ AUTOCONFIG_SKIP_IP_CHECK: 'false' }).skipIpCheck).toBe(false);
  });

  it('is on for true, case- and whitespace-insensitively', () => {
    for (const v of ['true', 'TRUE', ' True ']) {
      expect(readAutoconfigEnv({ AUTOCONFIG_SKIP_IP_CHECK: v }).skipIpCheck).toBe(true);
    }
  });

  it('does not treat other truthy-looking values as on', () => {
    for (const v of ['1', 'yes', 'on', 'enabled']) {
      expect(readAutoconfigEnv({ AUTOCONFIG_SKIP_IP_CHECK: v }).skipIpCheck).toBe(false);
    }
  });

  it('allocates contiguously from the start address when set', () => {
    // The whole point of the opt-out: no skipped addresses, so the service
    // list maps one-to-one onto the range from the start address upward.
    const plan = planFor();  // planFor() probes nothing -> same as skipIpCheck
    expect(plan.skipped).toEqual([]);
    expect(plan.services[0].ip).toBe('172.16.0.100');
    expect(plan.services[1].ip).toBe('172.16.0.101');
  });
});

import { excludeKnownAddresses } from '../autoconfig-apply';

describe('excludeKnownAddresses', () => {
  const ctx = { candidates: ['172.16.0.100', '172.16.0.101', '172.16.0.102'], minimumNeeded: 18 };

  it('removes the named addresses from the candidates', () => {
    expect(excludeKnownAddresses(ctx, ['172.16.0.101']).candidates)
      .toEqual(['172.16.0.100', '172.16.0.102']);
  });

  it('keeps everything else about the context', () => {
    expect(excludeKnownAddresses(ctx, ['172.16.0.101']).minimumNeeded).toBe(18);
  });

  it('does not mutate the original', () => {
    excludeKnownAddresses(ctx, ['172.16.0.101']);
    expect(ctx.candidates).toHaveLength(3);
  });

  it('is a no-op for addresses that were never candidates', () => {
    expect(excludeKnownAddresses(ctx, ['10.9.9.9']).candidates).toEqual(ctx.candidates);
  });

  it('tolerates an empty exclusion list', () => {
    expect(excludeKnownAddresses(ctx, []).candidates).toEqual(ctx.candidates);
  });

  it('excludes the management address so no NF can be handed it', () => {
    // The real case on the acceptance host: the VM's own DHCP address sits
    // inside the range the allocator walks. The probe would catch it (a host
    // answers for itself) but AUTOCONFIG_SKIP_IP_CHECK turns the probe off,
    // and this exclusion must still apply -- a network function on the
    // management address repurposes the address the NMS answers on.
    const wide = { candidates: Array.from({ length: 80 }, (_, i) => `172.16.0.${100 + i}`), minimumNeeded: 18 };
    const out = excludeKnownAddresses(wide, ['172.16.0.177']);
    expect(out.candidates).not.toContain('172.16.0.177');
    expect(out.candidates).toHaveLength(79);
  });
});

import { articleForNumber } from '../autoconfig-apply';

describe('articleForNumber', () => {
  it('uses "an" for numbers spoken with a leading vowel', () => {
    // The rule follows how the number is SPOKEN, not its first digit.
    expect(articleForNumber(8)).toBe('an');    // eight
    expect(articleForNumber(11)).toBe('an');   // eleven
    expect(articleForNumber(18)).toBe('an');   // eighteen
    expect(articleForNumber(80)).toBe('an');   // eighty
    expect(articleForNumber(88)).toBe('an');   // eighty-eight
  });

  it('uses "a" otherwise', () => {
    for (const n of [1, 2, 4, 7, 9, 10, 12, 16, 20, 32, 64, 100]) {
      expect(articleForNumber(n)).toBe('a');
    }
  });

  it('does not over-apply to longer numbers that merely start with those digits', () => {
    expect(articleForNumber(118)).toBe('a');   // one hundred eighteen
    expect(articleForNumber(812)).toBe('a');   // eight hundred twelve
  });

  it('is scoped to counts that can actually occur', () => {
    // A pool must fit inside one subnet, so 1-999 covers every real input.
    // Larger values return 'a' rather than pretending to handle magnitudes
    // this will never be asked about.
    expect(articleForNumber(8000)).toBe('a');
  });

  it('handles the realistic SecGW pool sizes', () => {
    expect(`${articleForNumber(8)} 8-address pool`).toBe('an 8-address pool');
    expect(`${articleForNumber(16)} 16-address pool`).toBe('a 16-address pool');
  });
});

describe('reusing addresses this feature already owns', () => {
  // Found live: a run interrupted after binding left 18 addresses on the NIC
  // with no manifest recording them. The next run probed them, we answered
  // (they are ours), so it treated them as somebody else's and allocated a
  // fresh set beside them -- 37 addresses on one NIC after two runs.
  const candidates = Array.from({ length: 60 }, (_, i) => `172.16.0.${100 + i}`);
  const OURS = new Set(['172.16.0.100', '172.16.0.101', '172.16.0.102']);

  it('marks a filtered-out address as probed-and-free, so it stays allocatable', async () => {
    // Load-bearing and subtle: allocateWithLazyProbe adds the whole BATCH to
    // `probed`, not just what the prober returned, so skipping our own
    // addresses leaves them free rather than unknown. An un-probed address is
    // reported as TAKEN, so if this changed, our own addresses would become
    // permanently unusable and every re-run would consume fresh ones.
    const asked: string[] = [];
    const out = await allocateWithLazyProbe(candidates, 4, {
      probe: async ips => {
        const toProbe = ips.filter(ip => !OURS.has(ip));
        asked.push(...toProbe);
        return { taken: new Set<string>(), results: toProbe };
      },
      allocate: isTaken => {
        const free = candidates.filter(ip => !isTaken(ip));
        return { ok: free.length >= 4, free: free.slice(0, 4) };
      },
      ok: r => r.ok,
    });
    // Our addresses were never probed...
    for (const ip of OURS) expect(asked).not.toContain(ip);
    // ...yet they are the ones allocated, because they are ours to reuse.
    expect((out.result as any).free.slice(0, 3)).toEqual([...OURS]);
  });

  it('still treats a genuinely un-probed address as taken', async () => {
    // The protection this must not lose: an address nobody looked at is never
    // handed out.
    const probedEver = new Set<string>();
    const out = await allocateWithLazyProbe(candidates, 4, {
      probe: async ips => { ips.forEach(i => probedEver.add(i)); return { taken: new Set<string>(), results: ips }; },
      allocate: isTaken => {
        const free = candidates.filter(ip => !isTaken(ip));
        return { ok: free.length >= 4, free: free.slice(0, 4) };
      },
      ok: r => r.ok,
    });
    for (const ip of (out.result as any).free) expect(probedEver.has(ip)).toBe(true);
  });
});

import { canSkipBootRun } from '../autoconfig-apply';

describe('canSkipBootRun', () => {
  // AUTOCONFIG_ENABLED left in .env otherwise means EVERY backend start
  // re-runs everything: a restart, a crash-restart or an NMS upgrade each
  // trigger ~30 min of re-installs and live-service reconfigures. That work
  // is idempotent but not free — reconfiguring IMS restarts the CSCFs, which
  // drops every registered UE's IPsec SA.
  const base = () => buildManifest(planFor(), REQUEST,
    [{ name: 'allocate', ok: true }, { name: 'manifest', ok: true }], new Date());

  it('skips when a previous run completed every phase with the same request', () => {
    const r = canSkipBootRun(base(), REQUEST, 'eth0');
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toMatch(/already configured by the run recorded at/);
  });

  it('does NOT skip when any phase failed', () => {
    // Something was left undone; retrying on the next start is the point.
    const m = base();
    m.phases = [{ name: 'allocate', ok: true }, { name: 'fqdn-migration', ok: false, detail: 'DNS not confirmed' }];
    expect(canSkipBootRun(m, REQUEST, 'eth0').skip).toBe(false);
  });

  it('does NOT skip when there is no manifest', () => {
    expect(canSkipBootRun(null, REQUEST, 'eth0').skip).toBe(false);
  });

  it('does NOT skip when a manifest records no phases at all', () => {
    const m = base();
    m.phases = [];
    expect(canSkipBootRun(m, REQUEST, 'eth0').skip).toBe(false);
  });

  it('does NOT skip when the operator changed a setting', () => {
    expect(canSkipBootRun(base(), { ...REQUEST, startIp: '172.16.0.200' }, 'eth0').skip).toBe(false);
    expect(canSkipBootRun(base(), { ...REQUEST, secgwPoolSize: 16 }, 'eth0').skip).toBe(false);
  });

  it('does NOT skip when the interface changed', () => {
    expect(canSkipBootRun(base(), REQUEST, 'ens18').skip).toBe(false);
  });

  it('names the manual override in the reason', () => {
    // An operator who wants a re-run should not have to guess how.
    const r = canSkipBootRun(base(), REQUEST, 'eth0');
    if (r.skip) expect(r.reason).toContain('POST /api/autoconfig/start');
  });
});

describe('an unfinished run must not look complete', () => {
  // Found live: the manifest reported "no failed phases" immediately after a
  // run that had failed, and bootRun.skip read true. Cause: the early
  // manifest write (which exists to claim the bound addresses) recorded the
  // phases completed SO FAR — three successful ones — which canSkipBootRun
  // reads as "every phase green". An interrupted run would then be mistaken
  // for a completed one and the next boot would skip work it never did.
  it('a manifest recording only in-progress is never skippable', () => {
    const m = buildManifest(planFor(), REQUEST, [{
      name: 'in-progress',
      ok: false,
      detail: 'addresses were bound but the run had not finished when this was written',
    }], new Date());
    expect(canSkipBootRun(m, REQUEST, 'eth0').skip).toBe(false);
  });

  it('but its addresses are still recorded, which is why it is written at all', () => {
    // The whole point of the early write: without it an interrupted run
    // strands its addresses because nothing says they are ours.
    const plan = planFor();
    const m = buildManifest(plan, REQUEST, [{ name: 'in-progress', ok: false }], new Date());
    expect(m.allAddresses).toEqual(plan.allAddresses);
    expect(m.services.map(s => s.ip)).toEqual(plan.services.map(s => s.ip));
    expect(canReuseManifest(m, REQUEST, 'eth0').reuse).toBe(true);
  });

  it('a completed run IS skippable', () => {
    const m = buildManifest(planFor(), REQUEST,
      [{ name: 'allocate', ok: true }, { name: 'fqdn-migration', ok: true }], new Date());
    expect(canSkipBootRun(m, REQUEST, 'eth0').skip).toBe(true);
  });

  it('the orchestrator writes the in-progress marker, not the phases so far', () => {
    const orch = fs.readFileSync(
      path.resolve(__dirname, '../../../application/use-cases/autoconfig/autoconfig-orchestrator.ts'), 'utf-8');
    // The early write must not reuse this.state.phases.
    const early = /writeManifest\(buildManifest\(plan, request, \[\{[\s\S]{0,300}?\}\]/.exec(orch);
    expect(early).not.toBeNull();
    expect(early![0]).toContain("name: 'in-progress'");
    expect(early![0]).toContain('ok: false');
  });
});
