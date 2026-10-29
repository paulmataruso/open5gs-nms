import { Db } from 'mongodb';
import pino from 'pino';
import { HepCollector } from './hep-collector';
import { CallScopeFilter, DialogScope, normaliseParty } from './call-scope';
import { ResolvedParty, readImsPool, readinessNote, resolveParties } from './call-debug-resolve';
import {
  CallDebugSession,
  countSessionMessages,
  getRunningSession,
  getSession,
  insertSession,
  listSessions,
  snapshotSession,
  updateSession,
} from './call-debug-store';
import { CallCaptureScope, PcapManifest, PcapUseCase } from '../pcap';
import { safeNsenter } from '../../../infrastructure/system/safe-nsenter';

// ── Call Debug session orchestration ─────────────────────────────────────────
//
// Ties three independent things together for the length of one debugging
// session: the HEP collector's write scope, a real packet capture, and the
// global SIP tracing switch. Everything that can be got wrong here is a
// half-applied state, so the ordering and the unwinds are the substance of
// this file.

/** Defaults chosen to bound a session an operator might walk away from. */
export const DEFAULT_AUTOSTOP_SECONDS = 600;        // 10 minutes
export const DEFAULT_AUTOSTOP_FILESIZE_KB = 512 * 1024; // 512 MB
export const MAX_AUTOSTOP_SECONDS = 3600;
export const MAX_AUTOSTOP_FILESIZE_KB = 4 * 1024 * 1024; // 4 GB

export interface StartCallDebugInput {
  caller: string;
  callee: string;
  label?: string;
  dialogScope?: DialogScope;
  /** true keeps storing non-matching traffic, merely tagging matches. */
  tagOnly?: boolean;
  interfaces?: string[];
  autostopSeconds?: number;
  autostopFilesizeKb?: number;
  startedBy: string;
}

export interface ImsAddresses {
  pcscfIp?: string;
  icscfIp?: string;
  scscfIp?: string;
  rtpEngineIp?: string;
}

/**
 * Everything this orchestrator needs from other modules, injected rather than
 * imported.
 *
 * This is the shape that keeps the import graph acyclic. pcap.ts already
 * statically imports ims-controller, sms-controller and vowifi-controller; if
 * this file imported those controllers AND pcap.ts imported this file's
 * resolver, there would be a genuine load-time cycle. Passing the few values
 * in as functions means the only real import here is PcapUseCase, which
 * imports nothing back.
 */
export interface CallDebugDeps {
  imsAddresses: () => ImsAddresses;
  asteriskAddress: () => string | undefined;
  externalTrunk: () => { providerHost?: string; bindIp?: string } | undefined;
  tracingEnabled: () => boolean;
  setTracingEnabled: (on: boolean) => Promise<{ needsConfigure: boolean; instances: { role: string; action: string; detail?: string }[] }>;
}

export class CallDebugSessionManager {
  constructor(
    private readonly db: Db,
    private readonly collector: HepCollector,
    private readonly pcap: PcapUseCase,
    private readonly deps: CallDebugDeps,
    private readonly logger: pino.Logger,
  ) {}

  // ── Scope construction ────────────────────────────────────────────────────

  /**
   * Build the packet-capture scope from resolved parties.
   *
   * Host-only clauses throughout: this is explicitly a full capture, so no
   * proto/port narrowing. Three deliberate choices:
   *
   *  - Only the IMS-APN UE address is included. The internet-APN address
   *    (10.45.x here) carries no SIP or RTP at all, and capturing it with no
   *    protocol filter would record the subscriber's entire data session.
   *  - When a party is a subscriber but has no static IMS address, the IMS
   *    POOL is used instead. Bounded, stable, and survives re-addressing.
   *  - The external trunk contributes the PROVIDER's address, not this host's
   *    trunk bind address. The provider IP is the packet's destination and is
   *    never source-NATed away, whereas our own 10.0.1.200 may be SNATed to
   *    the physical interface address on egress and would then match nothing.
   */
  private buildCallScope(parties: ResolvedParty[], imsPool: string | undefined): CallCaptureScope {
    const hosts = new Set<string>();
    const nets = new Set<string>();
    const notes: string[] = [];

    let anyExternal = false;
    for (const p of parties) {
      if (p.imsIp) {
        hosts.add(p.imsIp);
        notes.push(`${p.input} → UE ${p.imsIp}`);
      } else if (p.kind === 'subscriber') {
        if (imsPool) {
          nets.add(imsPool);
          notes.push(`${p.input} → IMS pool ${imsPool} (no static address)`);
        }
      } else {
        anyExternal = true;
        notes.push(`${p.input} → external`);
      }
    }

    const ims = this.deps.imsAddresses();
    for (const ip of [ims.pcscfIp, ims.icscfIp, ims.scscfIp, ims.rtpEngineIp]) {
      if (ip) hosts.add(ip);
    }
    const ast = this.deps.asteriskAddress();
    if (ast) hosts.add(ast);

    if (anyExternal) {
      const trunk = this.deps.externalTrunk();
      if (trunk?.providerHost) {
        hosts.add(trunk.providerHost);
        notes.push(`external trunk peer ${trunk.providerHost}`);
      }
    }

    return {
      hosts: [...hosts],
      nets: [...nets],
      description: `Call debug: ${notes.join(', ')}`,
    };
  }

  /**
   * Which interfaces to capture on.
   *
   * `lo` is always included and is not optional: every local-to-local flow on
   * this host is delivered via loopback even when both ends are bound to
   * dummy-* addresses, so all CSCF↔CSCF, CSCF↔Asterisk and
   * Asterisk↔rtpengine traffic appears there and NOWHERE else. UE-facing
   * media and SIP cross the GTP tun device. An external party additionally
   * needs the real egress interface, discovered from the routing table rather
   * than assumed, because a trunk leg leaves this host over a physical NIC
   * that neither lo nor ogstun* covers.
   */
  private async pickInterfaces(parties: ResolvedParty[]): Promise<string[]> {
    const ifaces = new Set<string>(['lo']);
    try {
      const r = await safeNsenter('ip', ['-o', 'link', 'show'], 8000);
      for (const line of r.stdout.split('\n')) {
        const m = line.match(/^\d+:\s+([^:@]+)/);
        if (m && /^ogstun\d*$/.test(m[1].trim())) ifaces.add(m[1].trim());
      }
    } catch { ifaces.add('ogstun2'); }

    if (parties.some(p => p.kind === 'external')) {
      const trunk = this.deps.externalTrunk();
      const target = trunk?.providerHost;
      try {
        const args = target ? ['route', 'get', target] : ['route', 'get', '8.8.8.8'];
        const r = await safeNsenter('ip', args, 8000);
        const m = r.stdout.match(/\bdev\s+(\S+)/);
        if (m) ifaces.add(m[1]);
      } catch { /* leave it out rather than guess an interface name */ }
    }
    return [...ifaces];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async getActive(): Promise<(CallDebugSession & { liveCounters?: unknown; pcapStatus?: string }) | null> {
    const s = await getRunningSession(this.db);
    if (!s) return null;
    // The session's own view of "running" is not authoritative for the pcap:
    // POST /api/pcap/stop/:id can stop it from the Captures tab, after which
    // the manifest is the only thing that knows. Read it rather than trust our
    // own flag.
    let pcapStatus: string | undefined;
    if (s.pcapId) {
      pcapStatus = await this.pcap
        .listCaptures()
        .then(list => list.find(c => c.id === s.pcapId)?.status)
        .catch(() => undefined);
    }
    const stats = this.collector.getStats();
    return {
      ...s,
      pcapStatus,
      liveCounters: {
        matched: await countSessionMessages(this.db, s.id).catch(() => 0),
        filtered: stats.scopeFiltered,
        keepalives: stats.keepalivesIgnored,
        unparsedKept: stats.unparsedKept,
      },
    };
  }

  async list(limit?: number): Promise<CallDebugSession[]> {
    return listSessions(this.db, limit);
  }

  async start(input: StartCallDebugInput): Promise<CallDebugSession> {
    const inputs = [input.caller, input.callee].map(x => String(x ?? '').trim()).filter(Boolean);
    if (inputs.length === 0) throw new Error('Enter at least one number to scope the capture to');
    for (const raw of inputs) {
      if (!normaliseParty(raw).digits && !raw.includes('@')) {
        throw new Error(`"${raw}" is not a usable number or SIP identity`);
      }
    }

    const existing = await getRunningSession(this.db);
    if (existing) {
      throw new Error(
        `A Call Debug session is already running (${existing.parties.map(p => p.input).join(' ↔ ')}). Stop it first.`,
      );
    }

    const parties = await resolveParties(this.db, inputs);
    const readiness = parties.map(readinessNote).filter((x): x is string => !!x);

    const scope = this.buildCallScope(parties, readImsPool());
    const interfaces = input.interfaces?.length ? input.interfaces : await this.pickInterfaces(parties);

    const id = String(Date.now());
    const identities = parties.flatMap(p => p.identities.map(i => i.digits ?? i.raw));
    const filter: CallScopeFilter = {
      sessionId: id,
      parties: parties.flatMap(p => p.identities),
      dialogScope: input.dialogScope ?? 'calls',
      tagOnly: input.tagOnly === true,
    };

    const autostopSeconds = Math.min(
      MAX_AUTOSTOP_SECONDS,
      Math.max(30, input.autostopSeconds ?? DEFAULT_AUTOSTOP_SECONDS),
    );
    const autostopFilesizeKb = Math.min(
      MAX_AUTOSTOP_FILESIZE_KB,
      Math.max(1024, input.autostopFilesizeKb ?? DEFAULT_AUTOSTOP_FILESIZE_KB),
    );

    const tracingWasEnabled = this.deps.tracingEnabled();

    // Claim the single running slot FIRST, so two concurrent Start requests
    // cannot both proceed. The unique partial index on status:'running' makes
    // the loser's insert fail here rather than after it has already started a
    // second capture.
    const session: CallDebugSession = {
      id,
      label: input.label?.trim() || `${inputs.join(' ↔ ')}`,
      status: 'running',
      startedAt: new Date(),
      startedBy: input.startedBy,
      parties,
      identities,
      dialogScope: filter.dialogScope,
      tagOnly: filter.tagOnly,
      readiness,
      bpf: undefined,
      interfaces,
      autostopSeconds,
      autostopFilesizeKb,
      tracingWasEnabled,
      counters: { matched: 0, filtered: 0, keepalives: 0, unparsedKept: 0 },
    };
    try {
      await insertSession(this.db, session);
    } catch (err) {
      throw new Error(
        'Another Call Debug session was started at the same moment — only one can run at a time. Refresh and try again.',
      );
    }

    // From here on, every failure must unwind what already succeeded.
    const unwind = async () => {
      this.collector.setScopeFilter(null);
      if (!tracingWasEnabled) await this.deps.setTracingEnabled(false).catch(() => undefined);
      await updateSession(this.db, id, { status: 'failed', stoppedAt: new Date() });
    };

    try {
      if (!tracingWasEnabled) {
        const report = await this.deps.setTracingEnabled(true);
        // A CSCF whose live config predates capture being loaded
        // unconditionally genuinely has no siptrace.so, and a session on such
        // a deployment would report success while capturing nothing from that
        // instance -- for P-CSCF that is the entire UE leg. Refuse, and pass
        // the per-instance detail through: it already names the remedy (run
        // IMS Configure), and nothing here restarts a CSCF.
        if (report.needsConfigure) {
          const detail = report.instances
            .filter(i => i.action !== 'rpc')
            .map(i => `${i.role}: ${i.detail ?? i.action}`)
            .join('; ');
          throw new Error(
            `SIP tracing could not be enabled on every CSCF, so this session would miss part of the call flow. ` +
            `Run Configure on the IMS page, then retry. (${detail})`,
          );
        }
      }

      this.collector.setScopeFilter(filter);

      let manifest: PcapManifest;
      try {
        manifest = await this.pcap.start({
          interfaces,
          scope: { mode: 'call', call: scope },
          label: `Call debug ${session.label}`,
          autostopSeconds,
          autostopFilesizeKb,
        });
      } catch (err) {
        // Fail closed. A Call Debug session whose packet capture silently did
        // not start is the exact half-working state that wastes a real test
        // call -- and for a PSTN call the pcap is the ONLY view of the far leg,
        // because the B2BUA's second dialog never traverses a CSCF and so is
        // invisible to the SIP trace by construction.
        throw new Error(`Packet capture failed to start, so the session was not started: ${err instanceof Error ? err.message : String(err)}`);
      }

      await updateSession(this.db, id, { pcapId: manifest.id, bpf: manifest.bpf });
      this.logger.info({ id, pcapId: manifest.id, interfaces, bpf: manifest.bpf }, 'call-debug: session started');
      return { ...session, pcapId: manifest.id, bpf: manifest.bpf };
    } catch (err) {
      await unwind();
      throw err;
    }
  }

  async stop(reason: 'operator' | 'reconcile' = 'operator'): Promise<CallDebugSession | null> {
    const s = await getRunningSession(this.db);
    if (!s) return null;
    return this.finish(s, reason === 'reconcile' ? 'interrupted' : 'stopped');
  }

  private async finish(s: CallDebugSession, status: 'stopped' | 'interrupted'): Promise<CallDebugSession> {
    const stats = this.collector.getStats();
    // Only clear the filter if it is still OURS. A newer session must never
    // have its scope silently removed by a late stop of an older one.
    if (this.collector.getScopeFilter()?.sessionId === s.id) this.collector.setScopeFilter(null);

    if (s.pcapId) {
      await this.pcap.stop(s.pcapId).catch(err =>
        this.logger.warn({ err: String(err), id: s.id }, 'call-debug: pcap stop failed'),
      );
    }

    // Restore tracing only if the live state is still what we set it to. If
    // the operator turned tracing on from the Trace card mid-session, putting
    // it back to "off" would silently undo an explicit action of theirs.
    if (!s.tracingWasEnabled && this.deps.tracingEnabled()) {
      await this.deps.setTracingEnabled(false).catch(err =>
        this.logger.warn({ err: String(err) }, 'call-debug: could not restore tracing to off'),
      );
    }

    const counters = {
      matched: await countSessionMessages(this.db, s.id).catch(() => 0),
      filtered: stats.scopeFiltered,
      keepalives: stats.keepalivesIgnored,
      unparsedKept: stats.unparsedKept,
    };

    let snapshotError: string | undefined;
    try {
      await snapshotSession(this.db, s.id);
    } catch (err) {
      // Never fatal: a snapshot failure must not leave the session stuck
      // 'running' with the collector still scoped.
      snapshotError = err instanceof Error ? err.message : String(err);
    }

    await updateSession(this.db, s.id, {
      status,
      stoppedAt: new Date(),
      counters,
      ...(snapshotError ? { snapshotError } : {}),
    });
    this.logger.info({ id: s.id, status, counters }, 'call-debug: session finished');
    return { ...s, status, stoppedAt: new Date(), counters };
  }

  /**
   * Boot-time reconciliation.
   *
   * The scope filter lives in memory, but `setTracingEnabled(true)` persists
   * `sipTracingEnabled` into the host IMS state so that tracing survives a
   * restart by design. A backend restart mid-session therefore comes back with
   * tracing ON and nothing scoping it -- unbounded capture, which is precisely
   * what this feature exists to prevent. Closing the session out is not
   * enough; the tracing state has to be put back too.
   */
  async reconcile(): Promise<void> {
    try {
      const s = await getRunningSession(this.db);
      if (!s) return;
      this.logger.warn({ id: s.id }, 'call-debug: found an orphaned running session at startup, closing it out');
      await this.finish(s, 'interrupted');
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'call-debug: reconciliation failed');
    }
  }

  async get(id: string): Promise<CallDebugSession | null> {
    return getSession(this.db, id);
  }
}
