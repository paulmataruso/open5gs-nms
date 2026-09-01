/**
 * Get Interface Status Use Case
 *
 * Returns live RAN interface status by querying the Open5GS internal APIs
 * directly — no netstat, conntrack, or tshark required.
 *
 * S1-MME / S1-U  → MME  /enb-info  (s1.sctp.peer)
 * N2             → AMF  /gnb-info  (ng.sctp.peer)
 * N3             → SMF  /pdu-info  (n3.gnb.addr)
 * Active 4G UEs  → ActiveSessionsUseCase
 * Active 5G UEs  → ActiveSessionsUseCase
 *
 * All interface IPs are extracted from the NF YAML configs (metrics.server)
 * so they always match what the user has configured in the WebUI.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../../domain/interfaces/config-repository';
import { ActiveSessionsUseCase, ActiveUE } from '../active-sessions';
import { Open5gsApiClient, parsePeerIP } from '../open5gs-api-client';
import { BaicellsUeCountsUseCase } from '../baicells-ue-counts';

// ── Exported types ────────────────────────────────────────────────────────────

export interface ConnectedRadio {
  ip: string;
  numConnectedUes: number;
  setupSuccess: boolean;
  plmn?: string;
  // numConnectedUes is ECM/CM-CONNECTED only — confirmed against Open5GS's real source
  // (src/mme/enb-info.c walks the eNB's own live enb_ue_list, which is emptied the instant a
  // UE goes idle) — it can never include idle UEs. The frontend derives a separate "total UEs
  // (idle+connected)" stat per radio from the actual matched activeUEs4G/5G list instead,
  // since each UE there (idle or not) still carries a valid radioIp — see RANPage.tsx's
  // buildRadioRows. Fixed live 2026-08-30 after a real bug: radio cards under-reported UE
  // count whenever any UE on that radio was idle.
  //
  // Baicells-only — the radio's own TR-069-reported RRC-connected count, shown as a secondary
  // annotation alongside numConnectedUes since the two can legitimately disagree — see
  // baicells-ue-counts.ts. Undefined for non-Baicells radios/gNodeBs.
  selfReportedUeCount?: number | null;
}

export interface InterfaceStatus {
  s1mme: { active: boolean; connectedEnodebs: ConnectedRadio[] };
  s1u:   { active: boolean; connectedEnodebs: ConnectedRadio[] };
  n2:    { active: boolean; connectedGnodebs: ConnectedRadio[] };
  n3:    { active: boolean; connectedGnodebs: ConnectedRadio[] };
  activeUEs4G: ActiveUE[];
  activeUEs5G: ActiveUE[];
}

// ── Use case ─────────────────────────────────────────────────────────────────

export class GetInterfaceStatus {
  private readonly apiClient: Open5gsApiClient;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
    private readonly activeSessionsUseCase: ActiveSessionsUseCase,
    private readonly configRepo: IConfigRepository,
    private readonly baicellsUeCounts: BaicellsUeCountsUseCase,
  ) {
    this.apiClient = new Open5gsApiClient(hostExecutor, configRepo, logger);
  }

  // Keyed by mmePeerIp (pool address if SecGW-tunneled, else the radio's
  // real IP) — exactly what ConnectedRadio.ip already is for S1-MME/S1-U
  // entries, so this can be looked up directly with no further translation.
  private async getBaicellsSelfReportedByPeerIp(): Promise<Map<string, number | null>> {
    const entries = await this.baicellsUeCounts.getAll().catch(err => {
      this.logger.error({ err: String(err) }, 'Error getting Baicells self-reported UE counts');
      return [];
    });
    return new Map(entries.map(e => [e.mmePeerIp, e.selfReportedUeCount]));
  }

  async execute(): Promise<InterfaceStatus> {
    // Run N2/N3/S1 checks and 5G UE fetch in parallel
    const [s1mme, s1u, n2, n3, activeUEs5G] = await Promise.all([
      this.checkS1MME(),
      this.checkS1U(),
      this.checkN2(),
      this.checkN3(),
      this.activeSessionsUseCase.getActive5GUEs().catch(err => {
        this.logger.error({ err: String(err) }, 'Error getting 5G UE sessions');
        return [] as ActiveUE[];
      }),
    ]);

    // Pass 5G IMSI set to 4G lookup — avoids redundant getActive5GUEs() call
    // and short-circuits immediately on 5G-only deployments (MME not running)
    const imsi5GSet = new Set(activeUEs5G.map(ue => ue.imsi));
    const activeUEs4G = await this.activeSessionsUseCase.getActive4GUEs(imsi5GSet).catch(err => {
      this.logger.error({ err: String(err) }, 'Error getting 4G UE sessions');
      return [] as ActiveUE[];
    });

    return { s1mme, s1u, n2, n3, activeUEs4G, activeUEs5G };
  }

  // ── S1-MME (MME ↔ eNodeB, control plane) ─────────────────────────────────

  private async checkS1MME(): Promise<{ active: boolean; connectedEnodebs: ConnectedRadio[] }> {
    try {
      const enbs = await this.apiClient.getMmeEnbInfo();

      // Fallback: use Prometheus metrics if JSON API not available (< v2.7.7)
      if (enbs.length === 0) {
        const counts = await this.apiClient.getMmeCountsFromMetrics();
        if (counts.enbCount > 0) {
          this.logger.info({ enbCount: counts.enbCount }, 'S1-MME: using Prometheus fallback');
          const syntheticRadios: ConnectedRadio[] = Array.from({ length: counts.enbCount }, (_, i) => ({
            ip: `eNodeB ${i + 1} (upgrade to v2.7.7 for details)`,
            numConnectedUes: Math.round(counts.ueCount / counts.enbCount),
            setupSuccess: true,
            plmn: undefined,
          }));
          return { active: true, connectedEnodebs: syntheticRadios };
        }
      }

      const selfReportedByPeerIp = await this.getBaicellsSelfReportedByPeerIp();
      const radios: ConnectedRadio[] = enbs.map(enb => {
        const ip = parsePeerIP(enb.s1.sctp.peer);
        return {
          ip,
          numConnectedUes:  enb.num_connected_ues,
          setupSuccess:     enb.s1.setup_success,
          plmn:             enb.plmn,
          selfReportedUeCount: selfReportedByPeerIp.get(ip),
        };
      });

      this.logger.info({ count: radios.length, radios: radios.map(r => r.ip) }, 'S1-MME check complete');
      return { active: radios.some(r => r.setupSuccess), connectedEnodebs: radios };
    } catch (err) {
      this.logger.error({ err: String(err) }, 'S1-MME check failed');
      return { active: false, connectedEnodebs: [] };
    }
  }

  // ── S1-U (SGW-U ↔ eNodeB, user plane) ───────────────────────────────────
  //
  // The S1-U eNodeBs are the same physical radios as S1-MME.
  // We use the same enb-info source — if the eNodeB is connected on S1-MME
  // it has an S1-U bearer capable connection too.

  private async checkS1U(): Promise<{ active: boolean; connectedEnodebs: ConnectedRadio[] }> {
    try {
      const enbs = await this.apiClient.getMmeEnbInfo();

      // Fallback: same as S1MME - same source data
      if (enbs.length === 0) {
        const counts = await this.apiClient.getMmeCountsFromMetrics();
        if (counts.enbCount > 0) {
          const syntheticRadios: ConnectedRadio[] = Array.from({ length: counts.enbCount }, (_, i) => ({
            ip: `eNodeB ${i + 1} (upgrade to v2.7.7 for details)`,
            numConnectedUes: i === 0 ? counts.ueCount : 0,
            setupSuccess: true,
            plmn: undefined,
          }));
          return { active: true, connectedEnodebs: syntheticRadios };
        }
      }

      const selfReportedByPeerIp = await this.getBaicellsSelfReportedByPeerIp();
      const radios: ConnectedRadio[] = enbs.map(enb => {
        const ip = parsePeerIP(enb.s1.sctp.peer);
        return {
          ip,
          numConnectedUes:  enb.num_connected_ues,
          setupSuccess:     enb.s1.setup_success,
          plmn:             enb.plmn,
          selfReportedUeCount: selfReportedByPeerIp.get(ip),
        };
      });

      this.logger.info({ count: radios.length }, 'S1-U check complete');
      return { active: radios.some(r => r.setupSuccess), connectedEnodebs: radios };
    } catch (err) {
      this.logger.error({ err: String(err) }, 'S1-U check failed');
      return { active: false, connectedEnodebs: [] };
    }
  }

  // ── N2 (AMF ↔ gNodeB, control plane) ────────────────────────────────────

  private async checkN2(): Promise<{ active: boolean; connectedGnodebs: ConnectedRadio[] }> {
    try {
      const gnbs = await this.apiClient.getAmfGnbInfo();

      // Fallback: use Prometheus metrics if JSON API not available (< v2.7.7)
      if (gnbs.length === 0) {
        const counts = await this.apiClient.getAmfCountsFromMetrics();
        if (counts.gnbCount > 0) {
          this.logger.info({ gnbCount: counts.gnbCount }, 'N2: using Prometheus fallback');
          const syntheticRadios: ConnectedRadio[] = Array.from({ length: counts.gnbCount }, (_, i) => ({
            ip: `gNodeB ${i + 1} (upgrade to v2.7.7 for details)`,
            numConnectedUes: i === 0 ? counts.ueCount : 0,
            setupSuccess: true,
            plmn: undefined,
          }));
          return { active: true, connectedGnodebs: syntheticRadios };
        }
      }

      const radios: ConnectedRadio[] = gnbs.map(gnb => ({
        ip:               parsePeerIP(gnb.ng.sctp.peer),
        numConnectedUes:  gnb.num_connected_ues,
        setupSuccess:     gnb.ng.setup_success,
        plmn:             gnb.plmn,
      }));

      this.logger.info({ count: radios.length, radios: radios.map(r => r.ip) }, 'N2 check complete');
      return { active: radios.some(r => r.setupSuccess), connectedGnodebs: radios };
    } catch (err) {
      this.logger.error({ err: String(err) }, 'N2 check failed');
      return { active: false, connectedGnodebs: [] };
    }
  }

  // ── N3 (UPF ↔ gNodeB, user plane) ───────────────────────────────────────
  //
  // N3 gNodeB IPs come from SMF /pdu-info — only active 5G PDU sessions
  // have an n3 block. Each n3.gnb.addr is the gNodeB's GTP-U transport IP.
  //
  // Cross-referenced against N2 (AMF gnb-info) — if a gNodeB IP appears in
  // N3 PDU sessions but has no active N2 SCTP connection, the PDU session is
  // stale (gNodeB disconnected without proper teardown) and is filtered out.

  private async checkN3(): Promise<{ active: boolean; connectedGnodebs: ConnectedRadio[] }> {
    try {
      const [pduSessions, gnbs] = await Promise.all([
        this.apiClient.getSmfPduInfo(),
        this.apiClient.getAmfGnbInfo().catch(() => []),
      ]);

      // Metrics fallback for N3 when JSON APIs not available
      if (pduSessions.length === 0) {
        const upfCounts = await this.apiClient.getUpfCountsFromMetrics();
        if (upfCounts.sessionsActive > 0) {
          this.logger.info({ sessions: upfCounts.sessionsActive }, 'N3: using UPF metrics fallback');
          return {
            active: true,
            connectedGnodebs: [{
              ip: `N3 active (${upfCounts.sessionsActive} sessions — upgrade to v2.7.7 for details)`,
              numConnectedUes: upfCounts.sessionsActive,
              setupSuccess: true,
            }],
          };
        }
        return { active: false, connectedGnodebs: [] };
      }

      // Build set of gNodeB IPs that have an active N2 SCTP connection
      const liveN2Ips = new Set(
        gnbs
          .filter(gnb => gnb.ng?.setup_success)
          .map(gnb => parsePeerIP(gnb.ng.sctp.peer)),
      );

      // Collect unique gNodeB IPs from active 5G PDU sessions
      const gnbMap = new Map<string, ConnectedRadio>();

      for (const session of pduSessions) {
        for (const pdu of session.pdu) {
          if (!pdu.n3?.gnb?.addr) continue;

          const ip = parsePeerIP(pdu.n3.gnb.addr);

          // Skip if this gNodeB has no live N2 connection — stale PDU session
          if (liveN2Ips.size > 0 && !liveN2Ips.has(ip)) {
            this.logger.debug({ ip }, 'N3: skipping stale gNodeB IP (no N2 SCTP connection)');
            continue;
          }

          if (!gnbMap.has(ip)) {
            gnbMap.set(ip, { ip, numConnectedUes: 0, setupSuccess: true });
          }
          gnbMap.get(ip)!.numConnectedUes += 1;
        }
      }

      const radios = Array.from(gnbMap.values());
      this.logger.info({ count: radios.length, radios: radios.map(r => r.ip) }, 'N3 check complete');
      return { active: radios.length > 0, connectedGnodebs: radios };
    } catch (err) {
      this.logger.error({ err: String(err) }, 'N3 check failed');
      return { active: false, connectedGnodebs: [] };
    }
  }
}
