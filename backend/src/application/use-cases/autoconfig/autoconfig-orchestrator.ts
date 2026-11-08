/**
 * Auto-Configuration: the execution half.
 *
 * The operator sets an address range in `.env`, enables the feature, and runs
 * `docker compose up`. This drives everything from there — probing each
 * candidate address, binding the free ones on the single L2 interface,
 * pushing them into every module's own config, installing the modules, and
 * migrating the core onto FQDNs.
 *
 * It deliberately OWNS very little. Two use-cases already do the hard parts
 * and are driven here rather than reimplemented:
 *
 *   - `IpPlanApplyUseCase` already knows how to push an address into each
 *     module's live config in dependency order (IMS before PSTN/MMS, which
 *     both depend on it).
 *   - `FreshHostBootstrapUseCase` already knows the install order, including
 *     the one real install-time cross-module dependency (GSM's
 *     osmo-sip-connector must exist before Asterisk-2G's install begins).
 *
 * A second copy of either would drift from the original and be wrong in a way
 * nobody notices until a deployment fails.
 */

import * as fs from 'fs';
import * as path from 'path';
import type pino from 'pino';
import type { IAuditLogger } from '../../../domain/interfaces/audit-logger';
import type { IpPlanApplyUseCase } from '../ip-plan-apply-usecase';
import type { FreshHostBootstrapUseCase } from '../fresh-host-bootstrap-usecase';
import type { DnsMigrationUseCase } from '../dns-migration-usecase';
import {
  readAutoconfigEnv, buildAutoconfigContext, allocateAddresses, describePlan, netmaskToPrefix,
  AutoconfigPlan, PlanError,
} from '../../../domain/services/autoconfig-plan';
import { probeAddresses, describeProbe, LivenessProbeResult } from '../../../domain/services/address-liveness';
import {
  ipPlanEntriesFor, buildManifest, canReuseManifest, planFromManifest,
  addressesToBind, modulesToInstall, unknownModuleNames, awaitRunStatus,
  allocateWithLazyProbe, excludeKnownAddresses, articleForNumber, canSkipBootRun,
  AUTOCONFIG_MANIFEST_PATH, AutoconfigManifest,
} from '../../../domain/services/autoconfig-apply';
import {
  HostLivenessRunner, listBoundAddresses, bindSecondaryAddress, unbindAddress, persistNetplan,
  readNetplanDropInAddresses,
} from '../../../infrastructure/network/secondary-address';
import { detectMainInterface } from '../../../infrastructure/network/main-interface';
import { nsenter } from '../../../infrastructure/network/dummy-interface';
import {
  writeListenOn, readListenOn, readForwarders, writeForwarders,
} from '../../../interfaces/rest/bind-controller';
import { discoverUpstreamResolvers } from '../../../infrastructure/network/host-resolvers';
import {
  configureInstalledModules, describeModuleConfig, servicesAlreadyConfigured,
} from './module-initial-config';
import { parseMccMncFromMmeYaml } from '../../../domain/services/read-plmn';
import type { ISubscriberRepository } from '../../../domain/interfaces/subscriber-repository';
import type { IHostExecutor } from '../../../domain/interfaces/host-executor';

const HOST_MANIFEST_PATH = `/proc/1/root${AUTOCONFIG_MANIFEST_PATH}`;

const CORE17_KEYS = new Set(['amf-ngap', 'upf-n3', 'mme-s1mme', 'sgwu-s1u']);

/** How long to let a delegated async use-case run before giving up on it. */
const IP_PLAN_TIMEOUT_MS = 20 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 3000;

export interface AutoconfigPhase {
  name: string;
  ok: boolean;
  detail?: string;
  skipped?: boolean;
}

export interface AutoconfigRunState {
  status: 'idle' | 'disabled' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  currentPhase?: string;
  phases: AutoconfigPhase[];
  plan?: AutoconfigPlan;
  /** Human-readable allocation + probe report, for the status endpoint. */
  report?: string;
  errors: string[];
}

/**
 * The live run state of whichever delegated use-case a phase is driving.
 *
 * `install-modules` is by far the longest phase -- a full module set on a host
 * that builds from source runs for over an hour -- and without this the status
 * endpoint says only "install-modules" for that whole time, which is
 * indistinguishable from being stuck. The sub-state names the module actually
 * being installed.
 */
export interface AutoconfigSubState {
  bootstrap?: unknown;
  ipPlan?: unknown;
}

export function readManifest(): AutoconfigManifest | null {
  try {
    if (!fs.existsSync(HOST_MANIFEST_PATH)) return null;
    return JSON.parse(fs.readFileSync(HOST_MANIFEST_PATH, 'utf-8')) as AutoconfigManifest;
  } catch {
    return null;
  }
}

function writeManifest(manifest: AutoconfigManifest): void {
  const dir = path.dirname(HOST_MANIFEST_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOST_MANIFEST_PATH, JSON.stringify(manifest, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export class AutoconfigOrchestrator {
  private state: AutoconfigRunState = { status: 'idle', phases: [], errors: [] };

  constructor(
    private readonly ipPlanApply: IpPlanApplyUseCase,
    private readonly bootstrap: FreshHostBootstrapUseCase,
    private readonly dnsMigration: DnsMigrationUseCase,
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly hostExecutor: IHostExecutor,
    private readonly mongoUri: string,
    private readonly logger: pino.Logger,
    private readonly auditLogger: IAuditLogger,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  getRunState(): AutoconfigRunState { return this.state; }

  /**
   * What the delegated use-cases are doing right now.
   *
   * Read live rather than copied into `state`, so it cannot go stale: these
   * objects are owned by the use-cases themselves.
   */
  getSubState(): AutoconfigSubState {
    const phase = this.state.currentPhase;
    if (phase === 'install-modules' || phase === 'configure-modules') return { bootstrap: this.bootstrap.getRunState() };
    if (phase === 'core-addresses' || phase === 'module-addresses') return { ipPlan: this.ipPlanApply.getRunState() };
    return {};
  }

  /**
   * Starts a run if `AUTOCONFIG_ENABLED=true`.
   *
   * Returns immediately. The run takes well over an hour on a host that has
   * to build from source, and blocking startup would mean the NMS is
   * unreachable — and showing no status — for that entire time. Progress is
   * on `GET /api/autoconfig/status` from the first second.
   */
  /**
   * Whether a boot-time start would be a no-op, without starting anything.
   *
   * Exposed so the status endpoint can say so too, rather than leaving an
   * operator wondering why an enabled feature reports `idle`.
   */
  bootRunSkippable(): { skip: boolean; reason?: string } {
    const env = readAutoconfigEnv(this.env);
    if (!env.startIp || !env.gateway || !env.subnet) return { skip: false };
    const prefix = netmaskToPrefix(env.subnet);
    if (prefix === null) return { skip: false };
    const manifest = readManifest();
    if (!manifest) return { skip: false };
    const r = canSkipBootRun(manifest, {
      startIp: env.startIp, gateway: env.gateway, prefix, secgwPoolSize: env.secgwPoolSize,
    }, manifest.interfaceName);
    return r.skip ? { skip: true, reason: r.reason } : { skip: false };
  }

  start(user = 'autoconfig', opts: { force?: boolean } = {}): { started: boolean; reason?: string } {
    const env = readAutoconfigEnv(this.env);
    // `AUTOCONFIG_ENABLED` governs the BOOT-time run only. A manual trigger
    // passes force, so an operator who previewed with /plan can run it
    // without editing .env and restarting the backend just to flip a flag --
    // and without leaving it armed for every future boot.
    if (!env.enabled && !opts.force) {
      this.state = { status: 'disabled', phases: [], errors: [] };
      return { started: false, reason: 'AUTOCONFIG_ENABLED is not true' };
    }
    if (!env.startIp || !env.gateway || !env.subnet) {
      return {
        started: false,
        reason: 'AUTOCONFIG_START_IP, AUTOCONFIG_GW and AUTOCONFIG_SUBNET must all be set',
      };
    }
    // A boot start is skipped when a previous run already did all of this
    // with the same settings. A manual start (force) never is.
    if (!opts.force) {
      const skippable = this.bootRunSkippable();
      if (skippable.skip) {
        this.state = { status: 'complete', phases: [], errors: [], report: skippable.reason };
        return { started: false, reason: skippable.reason };
      }
    }
    if (this.state.status === 'running') {
      return { started: false, reason: 'An Auto-Configuration run is already in progress' };
    }
    this.state = { status: 'running', startedAt: new Date().toISOString(), phases: [], errors: [] };
    this.run(user).catch(err => {
      this.logger.error({ err: String(err) }, 'autoconfig: unexpected top-level failure');
      this.state.status = 'failed';
      this.state.errors.push(String(err));
      this.state.completedAt = new Date().toISOString();
    });
    return { started: true };
  }

  private phase(name: string): void {
    this.state.currentPhase = name;
    this.logger.info({ phase: name }, 'autoconfig: phase start');
  }

  private done(name: string, ok: boolean, detail?: string, skipped = false): void {
    this.state.phases.push({ name, ok, detail, skipped });
    if (!ok && detail) this.state.errors.push(`${name}: ${detail}`);
    this.logger[ok ? 'info' : 'error']({ phase: name, ok, detail, skipped }, 'autoconfig: phase end');
  }

  private failPlan(errors: PlanError[]): void {
    for (const e of errors) this.state.errors.push(`${e.field}: ${e.message}`);
  }

  private async run(user: string): Promise<void> {
    const env = readAutoconfigEnv(this.env);

    // ── Phase 1: the interface ────────────────────────────────────────────
    this.phase('detect-interface');
    let iface = env.interfaceName;
    let prefixFromHost: number | null = null;
    if (!iface) {
      const main = await detectMainInterface();
      if (!main) {
        this.done('detect-interface', false, 'No interface owns the default IPv4 route, and AUTOCONFIG_INTERFACE was not set');
        return this.finish(false);
      }
      iface = main.name;
      prefixFromHost = main.prefix;
    }
    this.done('detect-interface', true, `Using ${iface}${prefixFromHost ? ` (/${prefixFromHost} from the host)` : ' (from AUTOCONFIG_INTERFACE)'}`);

    const badModules = unknownModuleNames(this.env);
    if (badModules.length > 0) {
      this.done('module-selection', false, `AUTOCONFIG_MODULES names unknown module(s): ${badModules.join(', ')}`);
      return this.finish(false);
    }

    // ── Phase 2: allocate ─────────────────────────────────────────────────
    this.phase('allocate');
    const ctxRes = buildAutoconfigContext({ ...env, interfaceName: iface });
    if (!ctxRes.ok) {
      this.failPlan(ctxRes.errors);
      this.done('allocate', false, ctxRes.errors.map(e => `${e.field}: ${e.message}`).join('; '));
      return this.finish(false);
    }
    let ctx = ctxRes.context;
    const previous = readManifest();
    const request0 = {
      startIp: ctx.startIp, gateway: ctx.gateway, prefix: ctx.prefix, secgwPoolSize: ctx.secgwPoolSize,
    };

    // Re-allocating after the operator changed a setting? Release the
    // addresses the LAST run bound first.
    //
    // They are ours and we recorded them, so leaving them would both strand
    // them on the interface forever and make them look occupied to this run's
    // own exclusion below -- our own leftovers crowding out the range we were
    // asked to use. Only addresses the manifest recorded are touched; the
    // management address was never in it.
    if (previous && !canReuseManifest(previous, request0, iface).reuse) {
      let released = 0;
      for (const ip of previous.allAddresses) {
        try { await unbindAddress(iface, ip, previous.prefix); released++; } catch { /* already gone */ }
      }
      if (released > 0) {
        this.logger.info({ released, from: previous.appliedAt },
          'autoconfig: released addresses bound by the previous allocation');
      }
    }

    // Addresses this feature already owns, from BOTH records: the manifest,
    // and the netplan drop-in (written the moment they were bound, so it
    // survives a run interrupted before the manifest).
    //
    // They have to be treated as OURS rather than as occupied, because they
    // answer both probes -- we are the host answering. Found live: without
    // this, a re-run after an interrupted run excluded its own 18 addresses
    // as somebody else's and allocated a fresh set beside them, leaving 37 on
    // one NIC.
    const ours = new Set<string>([
      ...(previous?.allAddresses ?? []),
      ...readNetplanDropInAddresses(),
    ]);

    // Drop the interface's own remaining addresses from the candidates -- but
    // only the ones that are NOT ours. The management address lives there and
    // must never be handed to a network function, regardless of whether
    // collision checking is on.
    try {
      const alreadyOnIface = (await listBoundAddresses(iface)).filter(ip => !ours.has(ip));
      const before = ctx.candidates.length;
      ctx = excludeKnownAddresses(ctx, alreadyOnIface);
      const dropped = before - ctx.candidates.length;
      if (dropped > 0) {
        this.logger.info({ iface, dropped, addresses: alreadyOnIface },
          'autoconfig: excluded addresses already on the interface');
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'autoconfig: could not read the interface\'s own addresses');
    }
    const request = request0;
    const existing = previous;
    const reuse = canReuseManifest(existing, request, iface);
    let plan: AutoconfigPlan;

    if (reuse.reuse && existing) {
      // Pinned on purpose: re-probing could move a service onto a different
      // address because something transient answered once, silently
      // re-addressing a working deployment on nothing but a reboot.
      plan = planFromManifest(existing);
      this.state.report = `Reusing the allocation recorded at ${existing.appliedAt}.\n${describePlan(plan)}`;
      this.done('allocate', true, `Reused the recorded allocation (${plan.services.length} services)`);
    } else if (env.skipIpCheck) {
      // Explicit opt-out: allocate straight up from the start address with no
      // probing at all. Deterministic, contiguous, and entirely the
      // operator's risk -- see AUTOCONFIG_SKIP_IP_CHECK in .env.example.
      const alloc = allocateAddresses(ctx, () => false);
      if (!alloc.ok) {
        this.failPlan(alloc.errors);
        this.done('allocate', false, alloc.errors.map(e => `${e.field}: ${e.message}`).join('; '));
        return this.finish(false);
      }
      plan = alloc.plan;
      this.state.report =
        'AUTOCONFIG_SKIP_IP_CHECK=true — duplicate-address detection was SKIPPED.\n' +
        'No address was confirmed free. If any of these is already in use, both hosts will\n' +
        'answer for it and the symptom will appear on the other one.\n\n' + describePlan(plan);
      this.logger.warn({ addresses: plan.allAddresses.length },
        'autoconfig: AUTOCONFIG_SKIP_IP_CHECK=true, binding without duplicate-address detection');
      this.done('allocate', true,
        `${plan.services.length} services + ${articleForNumber(plan.secgwPool.length)} ${plan.secgwPool.length}-address SecGW pool, ` +
        `allocated consecutively WITHOUT collision checking (AUTOCONFIG_SKIP_IP_CHECK=true)`);
    } else {
      const runner = new HostLivenessRunner(iface);
      const outcome = await allocateWithLazyProbe(
        ctx.candidates,
        ctx.minimumNeeded,
        {
          probe: async ips => {
            // Don't probe our own addresses at all: we would answer, and the
            // answer would be meaningless. Reusing them is the whole point of
            // a re-run being deterministic.
            const toProbe = ips.filter(ip => !ours.has(ip));
            const results = await probeAddresses(runner, toProbe);
            return { taken: new Set([...results.values()].filter(r => r.taken).map(r => r.ip)), results };
          },
          allocate: isTaken => allocateAddresses(ctx, isTaken),
          ok: r => r.ok,
        },
      );

      let probeNote = '';
      if (runner.unavailable.size > 0) {
        probeNote = `\nNOTE: ${[...runner.unavailable].join(', ')} unavailable on this host; ` +
          `duplicate detection ran with the remaining method(s) only.`;
        this.logger.warn({ unavailable: [...runner.unavailable] }, 'autoconfig: a probe method was unavailable');
      }

      const merged = new Map<string, LivenessProbeResult>();
      for (const batch of outcome.probeResults) for (const [ip, r] of batch) merged.set(ip, r);

      const alloc = outcome.result;
      if (!alloc.ok) {
        this.failPlan(alloc.errors);
        this.state.report = describeProbe(merged) + probeNote;
        this.done('allocate', false, alloc.errors.map(e => `${e.field}: ${e.message}`).join('; '));
        return this.finish(false);
      }
      plan = alloc.plan;
      this.state.report = `${describeProbe(merged)}${probeNote}\n\n${describePlan(plan)}`;
      this.done('allocate', true,
        `${plan.services.length} services + ${articleForNumber(plan.secgwPool.length)} ${plan.secgwPool.length}-address SecGW pool; ` +
        `probed ${outcome.windowProbed} of ${ctx.candidates.length} candidate(s) in ` +
        `${outcome.attempts} pass(es); ${plan.skipped.length} address(es) skipped as already in use`);
    }
    this.state.plan = plan;

    // ── Phase 3: bind them ────────────────────────────────────────────────
    this.phase('bind-addresses');
    const newlyBound: string[] = [];
    try {
      const bound = await listBoundAddresses(iface);
      const toBind = addressesToBind(plan.allAddresses, bound);
      for (const ip of toBind) {
        await bindSecondaryAddress(iface, ip, plan.prefix);
        newlyBound.push(ip);
      }

      const persisted = await persistNetplan(iface, plan.allAddresses, plan.prefix);
      const detail = `Bound ${toBind.length} new address(es) (${plan.allAddresses.length} total) on ${iface}; ` +
        `persisted to ${persisted.path}` + (persisted.warning ? ` — ${persisted.warning}` : '');
      this.done('bind-addresses', true, detail);
      if (persisted.warning) this.state.errors.push(`bind-addresses: ${persisted.warning}`);

      // Record the allocation NOW, not only at the end of the run.
      //
      // Found live: a run interrupted after this point leaves 18 addresses on
      // the interface with nothing recording that they are ours. The next run
      // then excludes them as somebody else's (they do answer — we are
      // answering), allocates a completely fresh set alongside, and strands
      // the first. Two interrupted runs left 37 addresses on one NIC.
      //
      // The manifest is what distinguishes "ours, reusable" from "somebody
      // else's, avoid", so it has to exist from the moment the addresses are
      // real rather than from the moment the whole run succeeds. Phase 10
      // rewrites it with the full phase results.
      try {
        // Deliberately records a single NOT-OK phase rather than the phases
        // completed so far.
        //
        // This write exists only to claim the addresses (see above), and the
        // run is by definition unfinished at this point. Recording the
        // phases-so-far would list three successful ones and nothing else —
        // which `canSkipBootRun()` reads as "every phase green", so an
        // interrupted run would be mistaken for a completed one and the next
        // boot would skip the work it never did. Found by noticing a manifest
        // that reported no failed phases immediately after a failed run.
        //
        // Phase 'manifest' overwrites this with the real phase list once the
        // run actually reaches the end.
        writeManifest(buildManifest(plan, request, [{
          name: 'in-progress',
          ok: false,
          detail: 'addresses were bound but the run had not finished when this was written',
        }], new Date()));
      } catch (err) {
        // Not fatal on its own, but it does mean an interrupted run would
        // strand these, so say so rather than failing silently.
        this.state.errors.push(`bind-addresses: could not record the allocation (${String(err)}); ` +
          'an interrupted run would leave these addresses unclaimed');
      }
    } catch (err) {
      // Roll back what THIS attempt bound.
      //
      // Without this, a failure partway leaves those addresses on the
      // interface with no manifest recording them — and the next run's own
      // duplicate detection would then see our own leftovers answering,
      // treat them as somebody else's, and allocate a different set around
      // them. The stranded addresses would never be cleaned up by anything.
      let rolledBack = 0;
      for (const ip of newlyBound) {
        try { await unbindAddress(iface, ip, plan.prefix); rolledBack++; } catch { /* best effort */ }
      }
      this.done('bind-addresses', false,
        `${String(err)}${newlyBound.length > 0 ? ` — rolled back ${rolledBack} of ${newlyBound.length} address(es) bound by this attempt` : ''}`);
      return this.finish(false);
    }

    // ── Phase 4: core-17 addresses ────────────────────────────────────────
    const entries = ipPlanEntriesFor(plan);
    const coreEntries = entries.filter(e => CORE17_KEYS.has(e.service));
    const moduleEntries = entries.filter(e => !CORE17_KEYS.has(e.service));

    this.phase('core-addresses');
    const coreRes = await this.runIpPlan(coreEntries, user);
    this.done('core-addresses', coreRes.ok, coreRes.detail);
    // Deliberately NOT fatal, unlike the FQDN migration below. A failure here
    // is usually one row of four, and the modules are worth attempting
    // anyway: the run is already marked failed and names this phase, so
    // stopping would only hide whether anything else also needs fixing.
    // Phase 8 is different -- there, continuing actively breaks a working
    // deployment rather than merely leaving one row unapplied.

    // ── Phase 5: install the modules ──────────────────────────────────────
    this.phase('install-modules');
    const modules = modulesToInstall(this.env);
    let failedInstalls: string[] = [];
    if (modules.length === 0) {
      this.done('install-modules', true, 'No modules selected', true);
    } else {
      const started = this.bootstrap.startBootstrap(modules, user);
      if (!started.started) {
        this.done('install-modules', false, started.error);
      } else {
        const res = await this.awaitRunState(
          () => this.bootstrap.getRunState(),
          BOOTSTRAP_TIMEOUT_MS,
          st => st.results.map(r => r.moduleId + (r.installed ? '' : r.skipped ? ' (skipped)' : ' FAILED')).join(', '),
        );
        const failures = this.bootstrap.getRunState().results.filter(r => !r.installed && !r.skipped);
        failedInstalls = failures.map(f => f.moduleId);
        this.done('install-modules', res.ok && failures.length === 0,
          failures.length > 0
            ? `${failures.length} module(s) failed: ${failures.map(f => `${f.moduleId} (${f.error ?? 'no error reported'})`).join('; ')}`
            : res.detail);
      }
    }

    // ── Phase 6: configure what was just installed ────────────────────────
    //
    // The install step is deliberately install-only, because Configure
    // normally comes from a restore writing each module's state JSON first.
    // On a fresh host there is no such state, so without this the modules sit
    // installed and dark -- and IpPlanApply below cannot help, since with no
    // saved config it only RECORDS an address (`saved-for-later`) rather than
    // applying it. This is what turns "installed" into "online".
    this.phase('configure-modules');
    const justConfigured: string[] = [];
    if (modules.length === 0) {
      this.done('configure-modules', true, 'No modules selected', true);
    } else {
      // Only configure what actually installed. Configuring a failed install
      // just produces a second, more confusing error for the same cause.
      const installedOk = this.bootstrap.getRunState().results
        .filter(r => r.installed).map(r => r.moduleId);
      const { mcc, mnc } = await this.readPlmn();
      const results = await configureInstalledModules(plan, installedOk, {
        subscriberRepo: this.subscriberRepo,
        hostExecutor: this.hostExecutor,
        mongoUri: this.mongoUri,
        logger: this.logger,
        mcc, mnc,
        managementIp: await this.managementAddress(iface),
      });
      justConfigured.push(...results.filter(r => r.configured).map(r => r.moduleId));
      const failed = results.filter(r => !r.configured && !r.skipped);
      this.done('configure-modules', failed.length === 0, describeModuleConfig(results));
    }

    // ── Phase 7: install what needed a configure first ────────────────────
    //
    // Some installs depend on ANOTHER module being configured, not merely
    // installed. Found live on a clean host: Asterisk-2G's install refuses
    // with "osmo-sip-connector has no concrete local SIP address configured
    // yet" because `verifyGsmSipConnReady()` requires GSM's Configure to have
    // run -- and the bootstrap is install-only, so on a fresh host that
    // Configure only happens in the phase above. The module bootstrap's own
    // comment calls this the one real install-time cross-module dependency
    // across all 13 modules.
    //
    // Retried ONCE, generically, rather than special-cased: the ordering is a
    // property of the modules, and a second module with this shape should not
    // need another fix here. A module that fails twice is a real failure.
    this.phase('retry-installs');
    if (failedInstalls.length === 0) {
      this.done('retry-installs', true, 'No install needed retrying', true);
    } else {
      const started = this.bootstrap.startBootstrap(failedInstalls, user);
      if (!started.started) {
        this.done('retry-installs', false, started.error);
      } else {
        const res = await this.awaitRunState(
          () => this.bootstrap.getRunState(), BOOTSTRAP_TIMEOUT_MS,
          st => st.results.map(r => r.moduleId + (r.installed ? '' : ' FAILED')).join(', '),
        );
        // Judge ONLY the modules this phase asked to retry.
        //
        // The module bootstrap always runs bind9 first and ueValidation last,
        // regardless of the requested list, so their results appear here
        // too. Measured on a clean host: asterisk2g retried and installed
        // correctly (installed and active), but ueValidation reported a
        // failure of its own — with the srsRAN image in fact present — and
        // judging every result made this phase report FAIL. That in turn
        // stopped install-modules being amended, so the run reported failed
        // and the boot-skip stayed broken: the same end effect as the bug the
        // amendment exists to fix, reached a different way.
        const retried = new Set(failedInstalls);
        const now = this.bootstrap.getRunState().results.filter(r => retried.has(r.moduleId));
        const ok = now.filter(r => r.installed).map(r => r.moduleId);
        const stillFailed = now.filter(r => !r.installed && !r.skipped);

        // Configure whatever installed this time, or it would be left dark
        // for exactly the reason the phase above exists.
        let configured = '';
        if (ok.length > 0) {
          const { mcc, mnc } = await this.readPlmn();
          const r2 = await configureInstalledModules(plan, ok, {
            subscriberRepo: this.subscriberRepo,
            hostExecutor: this.hostExecutor,
            mongoUri: this.mongoUri,
            logger: this.logger,
            mcc, mnc,
            managementIp: await this.managementAddress(iface),
          });
          justConfigured.push(...r2.filter(x => x.configured).map(x => x.moduleId));
          configured = `; configure: ${describeModuleConfig(r2)}`;
        }
        this.done('retry-installs', stillFailed.length === 0,
          stillFailed.length > 0
            ? `still failing after a retry: ${stillFailed.map(f => `${f.moduleId} (${f.error ?? 'no error reported'})`).join('; ')}${configured}`
            : `installed on retry: ${ok.join(', ')}${configured}`);

        // Every install that failed has now succeeded, so the earlier
        // install-modules failure describes a step that was retried, not a
        // deployment that is broken. Amend it.
        //
        // This is not cosmetic. On ANY fresh host, Asterisk-2G's install
        // fails (it needs GSM configured) and this retry fixes it — so
        // leaving the phase marked failed means the manifest permanently
        // records a failed phase, `canSkipBootRun()` never skips, and every
        // backend restart re-runs the whole hour-long sequence. Measured on a
        // clean host: run reported `failed` with asterisk-2g installed and
        // active.
        //
        // The detail keeps the history rather than pretending it went
        // cleanly, so the record still shows a retry was needed.
        if (stillFailed.length === 0 && ok.length > 0) {
          const installPhase = this.state.phases.find(ph => ph.name === 'install-modules');
          if (installPhase && !installPhase.ok) {
            const was = installPhase.detail ?? '';
            installPhase.ok = true;
            installPhase.detail =
              `succeeded after retry-installs (these needed another module configured first). ` +
              `First attempt: ${was}`;
            // The run-level error list is what `status` reports, so the stale
            // entry has to go too or the run still looks failed.
            this.state.errors = this.state.errors.filter(e => !e.startsWith('install-modules:'));
            this.logger.info({ resolved: ok },
              'autoconfig: install-modules failure resolved by retry-installs; phase amended to ok');
          }
        }
      }
    }

    // ── Phase 8: module addresses ─────────────────────────────────────────
    this.phase('module-addresses');
    // Skip anything the phase above already applied from the same plan.
    // Re-applying an identical address is not merely wasted work: a second
    // IMS Configure in one run left smf.yaml with a duplicate `dnn: ims`
    // session entry, and Open5GS refuses to start on overlapping subnets.
    // What remains here is IP Plan's real job -- re-addressing a module that
    // was configured BEFORE this run, which Configure above skips.
    const covered = servicesAlreadyConfigured(justConfigured);
    const remaining = moduleEntries.filter(e => !covered.has(e.service));
    if (remaining.length === 0) {
      this.done('module-addresses', true,
        moduleEntries.length === 0
          ? 'Nothing to apply'
          : `All ${moduleEntries.length} already applied by configure-modules`, true);
    } else {
      const modRes = await this.runIpPlan(remaining, user);
      this.done('module-addresses', modRes.ok,
        `${remaining.length} of ${moduleEntries.length} not already applied by configure-modules — ${modRes.detail}`);
    }

    // ── Phase 9: DNS listen address ───────────────────────────────────────
    // AFTER the module install, not before: BIND is installed by that step
    // (it is shared infrastructure with no installer of its own), so touching
    // named.conf.options any earlier would hit a file that does not exist.
    this.phase('dns-listen');
    const dnsIp = plan.services.find(s => s.key === 'dns')?.ip;
    let dnsReady = false;
    if (!dnsIp) {
      this.done('dns-listen', false, 'No DNS address in the plan');
    } else if (!fs.existsSync('/proc/1/root/etc/bind/named.conf.options')) {
      this.done('dns-listen', false,
        'BIND is not installed on this host (no /etc/bind/named.conf.options), so there is ' +
        'nothing to point the core at. Install the IMS or VoWiFi module, or bind9 by hand, ' +
        'and re-run.');
    } else {
      try {
        // Merge into the existing listen-on list rather than replacing it —
        // BIND is shared infrastructure and this is not its sole owner.
        // (`writeListenOn` also unions in 127.0.0.1 unconditionally, which
        // matters: a fresh install has no listen-on at all, so narrowing it
        // without loopback would cut off the resolver the host itself uses.)
        const current = readListenOn();
        if (!current.includes(dnsIp)) writeListenOn([...current, dnsIp]);

        // Make sure BIND can answer for names it is not authoritative for.
        //
        // The module bootstrap has already pointed /etc/resolv.conf at BIND,
        // and Ubuntu ships `forwarders` commented out — so BIND recurses from
        // the root hints for every external name. That works until it does
        // not: on a cold cache under parallel load it SERVFAILs, and a real
        // `docker compose build` on a freshly auto-configured host died on
        // `lookup registry-1.docker.io on 127.0.0.1:53: server misbehaving`.
        //
        // Existing forwarders are left ALONE. An operator who set them chose
        // those servers, and this is not the owner of that decision.
        let fwdNote = '';
        const existingFwd = readForwarders();
        if (existingFwd.length > 0) {
          fwdNote = `; forwarders already set (${existingFwd.length}), left alone`;
        } else {
          // Exclude our own addresses as well as loopback: forwarding BIND to
          // itself stops resolution entirely.
          const { resolvers, source } = discoverUpstreamResolvers(plan.allAddresses);
          writeForwarders(resolvers);
          fwdNote = `; forwarders set from the ${source === 'host' ? "host's own resolvers" : 'public fallback'}` +
            ` (${resolvers.join(', ')})`;
        }

        // A listen-on change alters which sockets named binds, so the config
        // has to be re-read before it means anything.
        const reload = await this.reloadBind();

        // Then CONFIRM it answers, rather than trusting that a file was
        // written. This flag gates the FQDN migration below, and the whole
        // point of that gate is evidence that DNS resolves -- "we wrote a
        // config" is not that evidence.
        const onLoopback = await this.dnsAnswers('127.0.0.1');
        const onService = await this.dnsAnswers(dnsIp);
        dnsReady = onLoopback && onService;

        // External resolution is checked but NOT part of dnsReady. The gate
        // below exists to protect the FQDN migration, which only needs this
        // host's own zones; a deployment on a deliberately air-gapped network
        // should not be denied its own FQDNs because it cannot reach the
        // outside world. Reported either way, because a surprise here breaks
        // every later apt and docker pull.
        const external = await this.dnsResolvesExternally();

        this.done('dns-listen', dnsReady,
          `reload: ${reload}; answering on 127.0.0.1: ${onLoopback ? 'yes' : 'NO'}, ` +
          `on ${dnsIp}: ${onService ? 'yes' : 'NO'}; external names: ${external ? 'yes' : 'NO'}` +
          fwdNote +
          (dnsReady ? ` (merged with ${current.length} existing address(es))` : ''));
        if (!external) {
          this.state.errors.push(
            'dns-listen: BIND is answering but could not resolve an external name. ' +
            'apt and docker pulls will fail until that works — check the forwarders in ' +
            '/etc/bind/named.conf.options and this host\'s own upstream DNS.');
        }
      } catch (err) {
        this.done('dns-listen', false, String(err));
      }
    }

    // ── Phase 10: FQDN migration ──────────────────────────────────────────
    this.phase('fqdn-migration');
    if (!dnsReady) {
      // Refusing is the safe outcome, not a cop-out. Every 5GC NF resolves
      // its own advertise FQDN synchronously at startup and ABORTS if it
      // cannot (CLAUDE.md gotcha #6) -- so migrating the core onto FQDNs with
      // no resolver answering crash-loops all of them at once. Leaving the
      // core on IP addresses is a working deployment; half-migrating it is a
      // dead one.
      this.done('fqdn-migration', false,
        'Skipped: DNS is not confirmed listening, and migrating the core onto FQDNs without a ' +
        'working resolver crash-loops every network function. The deployment stays on IP ' +
        'addresses, which works. Fix the dns-listen failure above and re-run.', true);
    } else try {
      const migPlan = await this.dnsMigration.computeMigrationPlan();
      await this.dnsMigration.createMigrationBackup();
      const a = await this.dnsMigration.applyPhaseA(migPlan);
      if (!a.success) throw new Error(`Phase A (zones): ${a.error ?? a.details.join('; ')}`);
      const b = await this.dnsMigration.applyPhaseB(migPlan);
      if (!b.success) throw new Error(`Phase B (SBI URIs): ${b.error ?? b.details.join('; ')}`);
      const c = await this.dnsMigration.applyPhaseC(migPlan);
      if (!c.success) throw new Error(`Phase C (advertise FQDNs): ${c.error ?? c.details.join('; ')}`);
      this.done('fqdn-migration', true, 'Phases A, B and C applied');
    } catch (err) {
      this.done('fqdn-migration', false, String(err));
    }

    // ── Phase 11: record it ───────────────────────────────────────────────
    this.phase('manifest');
    try {
      writeManifest(buildManifest(plan, request, this.state.phases.map(p => ({
        name: p.name, ok: p.ok, detail: p.detail,
      })), new Date()));
      this.done('manifest', true, `Recorded to ${AUTOCONFIG_MANIFEST_PATH}`);
    } catch (err) {
      this.done('manifest', false, String(err));
    }

    const allOk = this.state.phases.every(p => p.ok);
    await this.auditLogger.log({
      user, action: 'autoconfig_run',
      details: `Auto-Configuration ${allOk ? 'completed' : 'completed with failures'}: ` +
        `${plan.services.length} service addresses on ${iface}, ${plan.skipped.length} skipped as in use`,
      success: allOk,
    }).catch(() => {});
    this.finish(allOk);
  }

  /**
   * Re-reads BIND's config so a listen-on change takes effect.
   *
   * `rndc reconfig` is preferred over a restart: it rebinds listening sockets
   * without dropping the resolver, which matters because the core's own NFs
   * may already be resolving through it. Falls back to a unit restart when
   * rndc is unavailable (no key configured on a fresh install, for instance).
   */
  private async reloadBind(): Promise<string> {
    try {
      await nsenter('rndc', ['reconfig'], 15000);
      return 'rndc reconfig';
    } catch {
      for (const unit of ['named', 'bind9']) {
        try {
          await nsenter('systemctl', ['restart', unit], 60000);
          return `systemctl restart ${unit}`;
        } catch { /* try the other name */ }
      }
      return 'FAILED (neither rndc reconfig nor a unit restart worked)';
    }
  }

  /**
   * Whether BIND can resolve a name it is not authoritative for.
   *
   * Uses a name that must exist for the deployment to be installable at all,
   * rather than a vanity domain: if this fails, the next apt or docker pull
   * fails too.
   */
  private async dnsResolvesExternally(): Promise<boolean> {
    for (const name of ['registry-1.docker.io', 'deb.debian.org', 'archive.ubuntu.com']) {
      try {
        const { stdout } = await nsenter(
          'dig', ['+time=3', '+tries=1', '+short', '@127.0.0.1', name, 'A'], 12000);
        if (/\d+\.\d+\.\d+\.\d+/.test(stdout)) return true;
      } catch { /* try the next one */ }
    }
    return false;
  }

  /** Whether BIND actually answers a query at this address. */
  private async dnsAnswers(server: string): Promise<boolean> {
    try {
      // `localhost` always resolves from BIND's own built-in zones, so this
      // tests the server itself rather than any zone this project manages.
      const { stdout } = await nsenter(
        'dig', ['+time=2', '+tries=1', '+short', `@${server}`, 'localhost', 'A'], 10000);
      return /\d+\.\d+\.\d+\.\d+/.test(stdout);
    } catch {
      return false;
    }
  }

  /** The live PLMN, so no module has to guess it. */
  private async readPlmn(): Promise<{ mcc: string; mnc: string }> {
    try {
      const raw = await this.hostExecutor.readFile('/etc/open5gs/mme.yaml');
      return parseMccMncFromMmeYaml(raw);
    } catch {
      return { mcc: '001', mnc: '01' };
    }
  }

  /**
   * The interface's management address — its FIRST address, which is the one
   * that was there before this feature bound anything.
   */
  private async managementAddress(iface: string): Promise<string> {
    try {
      const bound = await listBoundAddresses(iface);
      const planned = new Set(this.state.plan?.allAddresses ?? []);
      return bound.find(ip => !planned.has(ip)) ?? bound[0] ?? '127.0.0.1';
    } catch {
      return '127.0.0.1';
    }
  }

  private finish(ok: boolean): void {
    this.state.status = ok ? 'complete' : 'failed';
    this.state.completedAt = new Date().toISOString();
    this.state.currentPhase = undefined;
  }

  /** Drives IpPlanApplyUseCase and waits for it, since it is fire-and-forget. */
  private async runIpPlan(
    entries: Array<{ service: string; ip: string }>,
    user: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (entries.length === 0) return { ok: true, detail: 'Nothing to apply' };
    const started = this.ipPlanApply.startApply(entries, user);
    if (!started.started) return { ok: false, detail: started.error };

    const res = await this.awaitRunState(
      () => this.ipPlanApply.getRunState(),
      IP_PLAN_TIMEOUT_MS,
      st => st.results.map(r => `${r.service}: ${r.status}`).join(', '),
    );
    const failed = this.ipPlanApply.getRunState().results.filter(r => r.status === 'failed');
    if (failed.length > 0) {
      return {
        ok: false,
        detail: `${failed.length} of ${entries.length} failed: ` +
          failed.map(f => `${f.service} (${f.error ?? 'no error reported'})`).join('; '),
      };
    }
    return res;
  }

  private awaitRunState<T extends { status: string }>(
    get: () => T,
    timeoutMs: number,
    summarise: (state: T) => string,
  ): Promise<{ ok: boolean; detail: string }> {
    return awaitRunStatus(get, summarise, { timeoutMs, pollMs: POLL_MS });
  }
}
