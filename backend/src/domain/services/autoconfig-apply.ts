/**
 * Turning an allocation plan into the changes that actually make it live.
 *
 * Pure functions only — the orchestrator owns the I/O. Everything here is the
 * part worth pinning with tests: the netplan drop-in text, the mapping from
 * this feature's own service keys onto the keys `IpPlanApplyUseCase` already
 * understands, and the manifest that decides whether a second `docker compose
 * up` re-allocates or reuses what is already bound.
 */

import type { AutoconfigPlan } from './autoconfig-plan';

/**
 * Netplan drop-in filename.
 *
 * Deliberately NOT an edit to `50-cloud-init.yaml`: cloud-init owns that file
 * and rewrites it, which would silently discard these addresses on a rebuild.
 * A higher-numbered drop-in merges over it per-interface, and netplan keeps
 * the keys this file does not mention — so an interface on DHCP stays on
 * DHCP and simply gains static secondary addresses.
 */
export const AUTOCONFIG_NETPLAN_FILE = '99-nms-autoconfig.yaml';

/** Where the manifest lives on the host (under /proc/1/root from the container). */
export const AUTOCONFIG_MANIFEST_PATH = '/etc/open5gs-nms/autoconfig-manifest.json';

/**
 * The netplan drop-in that persists the allocated addresses across a reboot.
 *
 * `dhcp4` is deliberately absent rather than set either way: the management
 * address is whatever the operator already had (DHCP on a cloud image, static
 * on a hand-built host), and asserting it here would override that. Netplan
 * merges per key, so omitting it keeps theirs.
 */
export function netplanDropIn(iface: string, addresses: string[], prefix: number): string {
  const addrLines = addresses.map(a => `      - "${a}/${prefix}"`).join('\n');
  return `# Managed by open5gs-nms Auto-Configuration — do not edit manually.
#
# Secondary service addresses for the single L2 interface. The management
# address is NOT declared here; whatever configures it (DHCP lease or another
# netplan file) still owns it, and netplan merges these keys over that.
network:
  version: 2
  ethernets:
    ${iface}:
      addresses:
${addrLines}
`;
}

/**
 * Maps this feature's service keys onto `IpPlanApplyUseCase`'s own.
 *
 * That use-case already knows how to push an address into each module's live
 * config in dependency order (IMS before PSTN/MMS, which both depend on it),
 * so Auto-Configuration delegates rather than growing a second apply layer
 * that would drift from it.
 *
 * `dns` has no entry on purpose: IP Plan treats `bind-dns` as registry-only,
 * and BIND's listen address has its own safe targeted-upsert path
 * (`writeListenOn`, the sole owner of `named.conf.options` per the BIND
 * sharing rule), so the orchestrator applies that one itself.
 */
export const SERVICE_TO_IP_PLAN: Readonly<Record<string, readonly string[]>> = {
  amfNgap: ['amf-ngap'],
  upfGtpu: ['upf-n3'],
  mmeS1ap: ['mme-s1mme'],
  sgwuGtpu: ['sgwu-s1u'],
  // P-CSCF and rtpengine share one address — matching how a real deployment
  // binds them (measured on the live host: both on the same service IP).
  pcscf: ['ims-pcscf', 'ims-rtpengine'],
  mmsc: ['mms-mm1'],
  epdg: ['vowifi-epdg'],
  secgw: ['secgw-gateway'],
  pstnTrunk: ['pstn-external-trunk'],
  dns: [],
} as const;

export interface IpPlanEntry { service: string; ip: string; }

/**
 * The IP Plan apply entries for a plan, in `AUTOCONFIG_SERVICES` order.
 *
 * A service with no IP Plan counterpart yields nothing rather than an error —
 * `dns` is handled separately and a future service key may be too.
 */
export function ipPlanEntriesFor(plan: AutoconfigPlan): IpPlanEntry[] {
  const out: IpPlanEntry[] = [];
  for (const svc of plan.services) {
    for (const service of SERVICE_TO_IP_PLAN[svc.key] ?? []) {
      out.push({ service, ip: svc.ip });
    }
  }
  return out;
}

export interface AutoconfigManifest {
  /** Bumped when the manifest's own shape changes incompatibly. */
  rev: number;
  appliedAt: string;
  interfaceName: string;
  prefix: number;
  gateway: string;
  /** What the env asked for, so a changed request is detected. */
  request: { startIp: string; gateway: string; prefix: number; secgwPoolSize: number };
  services: Array<{ key: string; label: string; fqdnLabel: string; ip: string }>;
  secgwPool: string[];
  secgwPoolCidr: string;
  allAddresses: string[];
  skipped: string[];
  phases: Array<{ name: string; ok: boolean; detail?: string }>;
}

export const AUTOCONFIG_MANIFEST_REV = 1;

export function buildManifest(
  plan: AutoconfigPlan,
  request: AutoconfigManifest['request'],
  phases: AutoconfigManifest['phases'],
  now: Date,
): AutoconfigManifest {
  return {
    rev: AUTOCONFIG_MANIFEST_REV,
    appliedAt: now.toISOString(),
    interfaceName: plan.interfaceName ?? '',
    prefix: plan.prefix,
    gateway: plan.gateway,
    request,
    services: plan.services.map(s => ({ key: s.key, label: s.label, fqdnLabel: s.fqdnLabel, ip: s.ip })),
    secgwPool: [...plan.secgwPool],
    secgwPoolCidr: plan.secgwPoolCidr,
    allAddresses: [...plan.allAddresses],
    skipped: [...plan.skipped],
    phases,
  };
}

/**
 * Whether a recorded manifest can be reused instead of allocating again.
 *
 * This is the whole reason the manifest exists. Re-probing on every start
 * would be actively WRONG: a transient host answering one probe would move a
 * service onto a different address, silently re-addressing a working
 * deployment on nothing more than a reboot. So once an allocation is recorded
 * and the operator has not changed the request, it is pinned — the addresses
 * are re-bound from the manifest rather than re-derived.
 *
 * A changed request (different start, gateway, mask or pool size) is a
 * deliberate operator action and does re-allocate.
 */
export function canReuseManifest(
  manifest: AutoconfigManifest | null,
  request: AutoconfigManifest['request'],
  interfaceName: string,
): { reuse: true } | { reuse: false; reason: string } {
  if (!manifest) return { reuse: false, reason: 'no previous run recorded' };
  if (manifest.rev !== AUTOCONFIG_MANIFEST_REV) {
    return { reuse: false, reason: `manifest revision ${manifest.rev} predates the current format (${AUTOCONFIG_MANIFEST_REV})` };
  }
  if (manifest.interfaceName !== interfaceName) {
    return { reuse: false, reason: `interface changed: recorded ${manifest.interfaceName || '(none)'}, now ${interfaceName}` };
  }
  const r = manifest.request;
  if (r.startIp !== request.startIp) return { reuse: false, reason: `AUTOCONFIG_START_IP changed: ${r.startIp} -> ${request.startIp}` };
  if (r.gateway !== request.gateway) return { reuse: false, reason: `AUTOCONFIG_GW changed: ${r.gateway} -> ${request.gateway}` };
  if (r.prefix !== request.prefix) return { reuse: false, reason: `AUTOCONFIG_SUBNET changed: /${r.prefix} -> /${request.prefix}` };
  if (r.secgwPoolSize !== request.secgwPoolSize) {
    return { reuse: false, reason: `AUTOCONFIG_SECGW_POOL_SIZE changed: ${r.secgwPoolSize} -> ${request.secgwPoolSize}` };
  }
  if (manifest.services.length === 0) return { reuse: false, reason: 'recorded manifest has no services' };
  return { reuse: true };
}

/** Rebuilds a plan from a manifest, so a reused allocation drives the same code path. */
export function planFromManifest(manifest: AutoconfigManifest): AutoconfigPlan {
  return {
    interfaceName: manifest.interfaceName || null,
    network: '',
    prefix: manifest.prefix,
    gateway: manifest.gateway,
    services: manifest.services.map(s => ({ key: s.key, label: s.label, ports: '', fqdnLabel: s.fqdnLabel, ip: s.ip })),
    secgwPool: [...manifest.secgwPool],
    secgwPoolCidr: manifest.secgwPoolCidr,
    allAddresses: [...manifest.allAddresses],
    skipped: [...manifest.skipped],
  };
}

/**
 * Addresses from the plan that are not yet on the interface.
 *
 * Binding is idempotent by diffing rather than by flushing: `ip addr flush`
 * on a real NIC would drop the management address this host is reached on,
 * which on a boot-time run means losing the NMS itself.
 */
export function addressesToBind(planned: string[], alreadyBound: string[]): string[] {
  const have = new Set(alreadyBound);
  return planned.filter(ip => !have.has(ip));
}

/**
 * Module install selection.
 *
 * Maps each bootstrap module onto the `ENABLE_*_MODULE` flag that already
 * governs whether it appears in the UI at all, with that flag's own default.
 */
export const MODULE_ENABLE_FLAGS: ReadonlyArray<{ id: string; flag: string; defaultOn: boolean }> = [
  { id: 'ims',            flag: 'ENABLE_IMS_MODULE',             defaultOn: true  },
  { id: 'smsOverSgs',     flag: 'ENABLE_SMS_MODULE',             defaultOn: true  },
  { id: 'gsm',            flag: 'ENABLE_GSM_MODULE',             defaultOn: false },
  { id: 'asterisk2g',     flag: 'ENABLE_ASTERISK_2G_MODULE',     defaultOn: false },
  { id: 'hnbgw',          flag: 'ENABLE_HNBGW_MODULE',           defaultOn: false },
  { id: 'vowifi',         flag: 'ENABLE_VOWIFI_MODULE',          defaultOn: true  },
  { id: 'secgw',          flag: 'ENABLE_SECGW_MODULE',           defaultOn: false },
  { id: 'ocs',            flag: 'ENABLE_OCS_MODULE',             defaultOn: false },
  { id: 'mms',            flag: 'ENABLE_MMS_MODULE',             defaultOn: false },
  { id: 'pstn',           flag: 'ENABLE_PSTN_MODULE',            defaultOn: false },
  { id: 'vectorcoreSmsc', flag: 'ENABLE_VECTORCORE_SMSC_MODULE', defaultOn: false },
  { id: 'twamp',          flag: 'ENABLE_TWAMP_MODULE',           defaultOn: false },
  { id: 'syslog',         flag: 'ENABLE_SYSLOG_MODULE',          defaultOn: true  },
] as const;

/**
 * Which modules Auto-Configuration installs.
 *
 * The default deliberately RESPECTS the `ENABLE_*_MODULE` flags rather than
 * installing everything: those flags are the operator's own expressed intent,
 * and a module set to `false` is hidden from the UI — installing it anyway
 * would bind ports and start services for a feature they chose not to run.
 *
 * `AUTOCONFIG_MODULES=all` overrides that for a full deployment, and an
 * explicit comma-separated list selects exactly those.
 */
export function modulesToInstall(env: Record<string, string | undefined>): string[] {
  const requested = (env.AUTOCONFIG_MODULES ?? '').trim();

  if (requested.toLowerCase() === 'all') return MODULE_ENABLE_FLAGS.map(m => m.id);

  if (requested && requested.toLowerCase() !== 'enabled') {
    const known = new Set(MODULE_ENABLE_FLAGS.map(m => m.id));
    const wanted = new Set(requested.split(',').map(s => s.trim()).filter(Boolean));
    // Keep install ORDER from the canonical list, not from how the operator
    // typed it — the order encodes real cross-module install dependencies.
    return MODULE_ENABLE_FLAGS.filter(m => wanted.has(m.id) && known.has(m.id)).map(m => m.id);
  }

  return MODULE_ENABLE_FLAGS
    .filter(m => {
      const raw = env[m.flag];
      if (raw === undefined || raw.trim() === '') return m.defaultOn;
      return raw.trim().toLowerCase() === 'true';
    })
    .map(m => m.id);
}

/** Module names in `AUTOCONFIG_MODULES` that match nothing, so a typo is reported. */
export function unknownModuleNames(env: Record<string, string | undefined>): string[] {
  const requested = (env.AUTOCONFIG_MODULES ?? '').trim();
  if (!requested || ['all', 'enabled'].includes(requested.toLowerCase())) return [];
  const known = new Set(MODULE_ENABLE_FLAGS.map(m => m.id));
  return requested.split(',').map(s => s.trim()).filter(s => s && !known.has(s));
}

export interface RunStatusLike { status: string }
export interface AwaitOutcome { ok: boolean; detail: string }

/**
 * Polls a fire-and-forget use-case's run state to completion.
 *
 * Reads `status` rather than inferring completion from how many results have
 * arrived. A use-case that fails partway reports FEWER results than it was
 * asked for, so a count-based wait would never stop waiting on exactly the
 * runs that need reporting — it would hang until the timeout and blame the
 * timeout instead of the real failure.
 *
 * `idle` is treated as a failure, not as "not started yet": the caller has
 * already started the run before polling, so observing idle means it never
 * actually began.
 */
export async function awaitRunStatus<T extends RunStatusLike>(
  get: () => T,
  summarise: (state: T) => string,
  opts: { timeoutMs: number; pollMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<AwaitOutcome> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  for (;;) {
    const st = get();
    if (st.status === 'complete') return { ok: true, detail: summarise(st) };
    if (st.status === 'failed') return { ok: false, detail: summarise(st) || 'reported failed' };
    if (st.status === 'idle') return { ok: false, detail: 'never started' };
    if (now() > deadline) {
      return { ok: false, detail: `timed out after ${Math.round(opts.timeoutMs / 60000)} min; last state: ${summarise(st)}` };
    }
    await sleep(opts.pollMs);
  }
}

/**
 * How many candidates to probe on a given attempt.
 *
 * Probing every candidate is not an option: on a /24 starting at .100 that is
 * 154 addresses, which at a realistic per-probe timeout takes well over a
 * minute, floods the segment the deployment is about to live on with ARP, and
 * brushes the reverse proxy's own request timeout — all to confirm ~18.
 *
 * So the window starts just above what a clean run needs and widens only if
 * occupied addresses actually push the allocation past it.
 */
export function probeWindowSize(minimumNeeded: number, attempt: number): number {
  const margin = 8;
  return minimumNeeded + margin * (attempt + 1) * (attempt + 1);
}

export const PROBE_MAX_ATTEMPTS = 4;

export interface LazyAllocateDeps<P, A> {
  /** Probes exactly these addresses and reports which are taken. */
  probe: (ips: string[]) => Promise<{ taken: Set<string>; results: P }>;
  /** The pure allocator, given a predicate. */
  allocate: (isTaken: (ip: string) => boolean) => A;
  /** Whether the allocator succeeded. */
  ok: (result: A) => boolean;
}

export interface LazyAllocateOutcome<P, A> {
  result: A;
  /** Everything probed across all attempts, merged. */
  probeResults: P[];
  attempts: number;
  windowProbed: number;
}

/**
 * Allocates while probing as few addresses as possible.
 *
 * The predicate reports an UN-PROBED address as taken. That is the load-bearing
 * part: it means the allocator can never hand out an address whose freedom was
 * not confirmed. When that makes the allocation fail, the window widens and it
 * tries again — a failure from "ran out of confirmed-free addresses" and a
 * failure from "the range is genuinely too small" are then the same code path,
 * and the last attempt's error is the real one.
 */
export async function allocateWithLazyProbe<P, A>(
  candidates: string[],
  minimumNeeded: number,
  deps: LazyAllocateDeps<P, A>,
  maxAttempts = PROBE_MAX_ATTEMPTS,
): Promise<LazyAllocateOutcome<P, A>> {
  const probed = new Set<string>();
  const taken = new Set<string>();
  const probeResults: P[] = [];
  let result!: A;
  let attempt = 0;

  for (; attempt < maxAttempts; attempt++) {
    // The FINAL attempt always covers every remaining candidate. Without
    // this, the widening schedule can run out of attempts before reaching the
    // end of the range -- so a heavily-occupied subnet would report "not
    // enough free addresses" while addresses it never looked at were free.
    // Reporting that failure is only honest if everything was actually seen.
    const isLast = attempt === maxAttempts - 1;
    const want = isLast
      ? candidates.length
      : Math.min(probeWindowSize(minimumNeeded, attempt), candidates.length);
    const batch = candidates.slice(0, want).filter(ip => !probed.has(ip));
    if (batch.length > 0) {
      const r = await deps.probe(batch);
      probeResults.push(r.results);
      for (const ip of batch) probed.add(ip);
      for (const ip of r.taken) taken.add(ip);
    }

    result = deps.allocate(ip => !probed.has(ip) || taken.has(ip));
    if (deps.ok(result)) break;

    // Nothing left to widen into — the last result is the honest answer.
    if (want >= candidates.length) break;
  }

  return { result, probeResults, attempts: Math.min(attempt + 1, maxAttempts), windowProbed: probed.size };
}

/**
 * Removes addresses that are already a KNOWN conflict from a context's
 * candidate list.
 *
 * This is deliberately separate from duplicate-address detection, and applies
 * even when `AUTOCONFIG_SKIP_IP_CHECK` has turned that off: the interface's
 * own existing addresses — above all the management address this host is
 * reached on — are conflicts the host already told us about, not ones that
 * have to be discovered. Handing the management address to a network function
 * would repurpose the address the NMS itself answers on.
 *
 * The gateway is excluded earlier for the same reason, by the planner.
 */
export function excludeKnownAddresses<T extends { candidates: string[] }>(ctx: T, exclude: string[]): T {
  const drop = new Set(exclude);
  return { ...ctx, candidates: ctx.candidates.filter(ip => !drop.has(ip)) };
}

/**
 * "a" or "an" for a count read aloud in English.
 *
 * Needed because the SecGW pool size appears in operator-facing text, where
 * "a 8-address pool" reads badly. The vowel rule follows how the number is
 * SPOKEN, not its first digit: 8 ("eight"), 11 ("eleven"), 18 ("eighteen")
 * and the eighties all take "an".
 *
 * Scoped deliberately to 1-999, which is every pool size this can produce (a
 * pool must fit inside one subnet). Generalising to arbitrary magnitudes
 * means deciding that 118 is "one hundred eighteen" ("a") while 11000 is
 * "eleven thousand" ("an") — real English, but far more machinery than a
 * count of addresses justifies. Anything outside the range gets "a", which
 * is wrong only for inputs that cannot occur.
 */
export function articleForNumber(n: number): 'a' | 'an' {
  const v = Math.abs(Math.trunc(n));
  if (v === 8 || v === 11 || v === 18) return 'an';
  if (v >= 80 && v <= 89) return 'an';
  return 'a';
}

/**
 * Whether a boot-time run can be skipped because the deployment is already
 * configured the way the current settings ask for.
 *
 * `AUTOCONFIG_ENABLED=true` left in `.env` otherwise means EVERY backend
 * start re-runs the whole thing: a `docker compose restart backend`, a
 * container crash-restart or an NMS upgrade each trigger ~30 minutes of
 * re-installs and live-service reconfigures. The work is idempotent, but it
 * is not free — reconfiguring IMS restarts the CSCFs, and that drops every
 * registered UE's IPsec SA.
 *
 * So the flag means "ensure this deployment is configured", not "reconfigure
 * on every start", which is what an operator leaving it set would expect.
 * A deliberate re-run is still one call to `POST /api/autoconfig/start`.
 *
 * Only a FULLY successful previous run counts. A manifest with any failed
 * phase means something was left undone, and retrying that on the next start
 * is exactly what should happen.
 */
export function canSkipBootRun(
  manifest: AutoconfigManifest | null,
  request: AutoconfigManifest['request'],
  interfaceName: string,
): { skip: true; reason: string } | { skip: false } {
  if (!manifest) return { skip: false };
  const reuse = canReuseManifest(manifest, request, interfaceName);
  if (!reuse.reuse) return { skip: false };
  if (manifest.phases.length === 0) return { skip: false };
  const failed = manifest.phases.filter(p => !p.ok);
  if (failed.length > 0) return { skip: false };
  return {
    skip: true,
    reason:
      `already configured by the run recorded at ${manifest.appliedAt} ` +
      `(${manifest.services.length} services on ${manifest.interfaceName}, all ${manifest.phases.length} phases ok). ` +
      `POST /api/autoconfig/start to run it again anyway.`,
  };
}
