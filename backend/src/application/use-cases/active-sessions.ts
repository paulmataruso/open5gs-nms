/**
 * Active Sessions Use Case
 *
 * Detects active UE sessions using the Open5GS internal APIs instead of
 * conntrack / tshark. Data is sourced directly from the core NF state
 * so it is always accurate and does not require packet capture.
 *
 * 5G UEs  → SMF /pdu-info  (entries that have an n3 block)
 * 4G UEs  → MME /ue-info   (domain: "EPS") + SMF /pdu-info for IP
 *
 * Deduplication: any IMSI already in the 5G list is excluded from 4G.
 */

import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { Open5gsApiClient, parsePeerIP } from './open5gs-api-client';

// One PDU/PDN connection — a UE can hold several at once (e.g. "internet" +
// "ims" for VoLTE registration/SIP signaling), each with its own IP.
export interface UeApnSession {
  apn: string;
  ip: string;
}

export interface ActiveUE {
  // Primary session's IP/APN — kept for backward compatibility with any
  // single-value display. `sessions` below is the authoritative full list;
  // ip/dnn/apn always mirror sessions[0].
  ip: string;
  imsi: string;
  cmState?: 'connected' | 'idle' | string;
  dnn?: string;
  apn?: string;
  // Every concurrent PDU/PDN connection this UE currently holds, one entry
  // per APN. Always has at least one entry (mirroring ip/dnn/apn above) —
  // a UE with a second APN (e.g. VoLTE's "ims" alongside "internet") shows
  // up here as a second entry on the SAME row, not as a second row.
  sessions: UeApnSession[];
  sliceSst?: number;
  sliceSd?: string;
  securityEnc?: string;
  securityInt?: string;
  ambrDownlink?: number;
  ambrUplink?: number;
  radioIp?: string;
  // true when sourced from Prometheus metrics only (JSON API unavailable)
  metricsOnly?: boolean;
  nickname?: string;  // from subscriber record in MongoDB
}

export class ActiveSessionsUseCase {
  private readonly apiClient: Open5gsApiClient;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly logger: pino.Logger = pino({ level: 'info' }),
  ) {
    this.apiClient = new Open5gsApiClient(hostExecutor, configRepo, logger);
  }

  /**
   * Active 5G UEs — sourced from SMF /pdu-info.
   *
   * A session is 5G if it has an n3 block (N3 = UPF↔gNodeB GTP-U tunnel).
   * SUPI from the core is authoritative — no MongoDB correlation needed.
   * AMBR and security come from AMF /ue-info, joined on SUPI.
   */
  async getActive5GUEs(): Promise<ActiveUE[]> {
    try {
      const [pduSessions, amfUes, amfGnbs] = await Promise.all([
        this.apiClient.getSmfPduInfo(),
        this.apiClient.getAmfUeInfo(),
        this.apiClient.getAmfGnbInfo(),
      ]);

      // ─ Metrics fallback ────────────────────────────────────────────────────
      if (pduSessions.length === 0 && amfUes.length === 0) {
        const [amfCounts, upfCounts, smfCounts] = await Promise.all([
          this.apiClient.getAmfCountsFromMetrics(),
          this.apiClient.getUpfCountsFromMetrics(),
          this.apiClient.getSmfCountsFromMetrics(),
        ]);
        // SMF ues_active and UPF session count reflect the data-plane truth.
        // AMF ran_ue can be stale — it survives service restarts and isn't
        // decremented when a UE loses radio without a clean deregistration.
        // Prefer data-plane counts; fall back to AMF only if SMF/UPF are silent.
        const dataPlaneCount = Math.max(smfCounts.activeUeCount, upfCounts.sessionsActive);
        const ueCount = dataPlaneCount > 0 ? dataPlaneCount : amfCounts.ueCount;
        if (ueCount <= 0) return [];
        this.logger.info({ ueCount, upfCounts, smfCounts, amfCounts }, '[5G Sessions] using Prometheus metrics fallback');
        const dnns = Object.keys(upfCounts.dnnFlows);
        const primaryDnn = dnns[0] || 'internet';
        return Array.from({ length: ueCount }, () => ({
          ip: '', imsi: '', dnn: primaryDnn, sessions: [{ apn: primaryDnn, ip: '' }], cmState: 'connected', metricsOnly: true,
        }));
      }

      // Build AMF UE lookup by IMSI for enrichment.
      // Skip entries that have only suci (unauthenticated UEs mid-registration — no supi yet).
      const amfByImsi = new Map<string, typeof amfUes[0]>();
      for (const ue of amfUes) {
        if (!ue.supi) continue;
        const imsi = ue.supi.replace(/^imsi-/, '');
        amfByImsi.set(imsi, ue);
      }

      // Build gNodeB lookup by gnb_id → IP
      const gnbIpById = new Map<number, string>();
      for (const gnb of amfGnbs) {
        gnbIpById.set(gnb.gnb_id, parsePeerIP(gnb.ng.sctp.peer));
      }

      // Build set of live gNodeB IPs (setup_success = true)
      const liveGnbIps = new Set(
        amfGnbs
          .filter(gnb => gnb.ng?.setup_success)
          .map(gnb => parsePeerIP(gnb.ng.sctp.peer)),
      );

      const activeUEs: ActiveUE[] = [];
      // Keyed by imsi — one row per UE. A UE can hold several concurrent
      // PDU sessions to different DNNs at once (e.g. "internet" + "ims" for
      // VoLTE); those are gathered into that UE's own `sessions[]` array
      // below, not emitted as separate rows.
      const seenImsi = new Set<string>();

      for (const session of pduSessions) {
        if (!session.supi) continue;
        const imsi = session.supi.replace(/^imsi-/, '');
        if (seenImsi.has(imsi)) continue;

        // Gather every concurrent 5G PDU session (one per DNN) for this UE.
        // 5G: must have an N3 block (GTP-U tunnel to gNodeB) to count.
        const sessions: UeApnSession[] = [];
        const seenDnn = new Set<string>();
        for (const pdu of session.pdu) {
          if (!pdu.n3 || !pdu.ipv4) continue;
          const dnn = pdu.dnn ?? '';
          if (seenDnn.has(dnn)) continue;
          seenDnn.add(dnn);
          sessions.push({ apn: dnn, ip: pdu.ipv4 });
        }
        if (sessions.length === 0) continue; // no valid 5G PDU session at all

        seenImsi.add(imsi);

        const amfUe = amfByImsi.get(imsi);

        // Resolve gNodeB IP from gnb_id (N2 SCTP control-plane IP)
        const gnbId = amfUe?.gnb?.gnb_id;
        const radioIp = gnbId !== undefined ? gnbIpById.get(gnbId) : undefined;

        // Skip ONLY when we can positively show this UE's own gNodeB isn't
        // live (i.e. we know its radioIp AND at least one other gNodeB IS
        // live to compare against). If every known gNodeB has
        // setup_success=false, that's not positive evidence any specific
        // UE is gone — AMF still knows about it even if S1/N2 setup isn't
        // fully confirmed — so those UEs must still show, not vanish.
        if (radioIp && liveGnbIps.size > 0 && !liveGnbIps.has(radioIp)) {
          this.logger.debug({ imsi, radioIp }, '[5G Sessions] skipped — gNodeB not live');
          continue;
        }

        // Fall back to N3 GTP-U gNB address when gnb_id → N2 IP lookup fails.
        // For most small cells, the N2 SCTP and N3 GTP-U IPs are the same interface,
        // so this fallback keeps UEs visible under their radio card when AMF UE info
        // lacks gnb or gnb_id (e.g. some firmware versions, or after idle→active transition).
        const firstN3Addr = session.pdu.find(p => p.n3?.gnb?.addr)?.n3?.gnb?.addr;
        const displayRadioIp = radioIp ?? (firstN3Addr ? parsePeerIP(firstN3Addr) : undefined);
        const firstPduWithSlice = session.pdu.find(p => p.n3);

        const ue: ActiveUE = {
          ip:          sessions[0].ip,
          imsi,
          cmState:     amfUe?.cm_state,
          dnn:         sessions[0].apn,
          sessions,
          sliceSst:    firstPduWithSlice?.snssai?.sst,
          sliceSd:     firstPduWithSlice?.snssai?.sd,
          securityEnc: amfUe?.security?.enc,
          securityInt: amfUe?.security?.int,
          ambrDownlink: amfUe?.ambr?.downlink,
          ambrUplink:   amfUe?.ambr?.uplink,
          radioIp:     displayRadioIp,
        };

        activeUEs.push(ue);
        this.logger.info({ imsi, sessions, cm_state: amfUe?.cm_state }, '[5G Sessions] ✓ active UE');
      }

      this.logger.info({ count: activeUEs.length }, '[5G Sessions] complete');

      // Enrich with subscriber nicknames from MongoDB
      const nicknames = await this.subscriberRepo.getNicknamesByImsi(activeUEs.map(u => u.imsi));
      return activeUEs.map(u => ({ ...u, nickname: nicknames[u.imsi] }));
    } catch (err) {
      this.logger.error({ err: String(err) }, '[5G Sessions] error');
      return [];
    }
  }

  /**
   * Active 4G UEs — sourced from MME /ue-info (domain: "EPS").
   * IP is cross-referenced from SMF /pdu-info by SUPI.
   * Any IMSI already in the 5G list is excluded (deduplication).
   *
   * @param imsi5GSet — optional pre-computed set of 5G IMSIs to avoid a
   * redundant getActive5GUEs() call when the caller already has the 5G list.
   */
  async getActive4GUEs(imsi5GSet?: Set<string>): Promise<ActiveUE[]> {
    try {
      const [mmeUes, mmeEnbs] = await Promise.all([
        this.apiClient.getMmeUeInfo(),
        this.apiClient.getMmeEnbInfo(),
      ]);

      // ─ Short-circuit: MME not running (5G-only deployment) ────────────────
      // If both MME UE list and eNB list are empty, skip all 4G logic entirely.
      // This avoids a redundant SMF PDU query and a redundant 5G dedup call.
      if (mmeUes.length === 0 && mmeEnbs.length === 0) {
        // Still try Prometheus metrics fallback
        const [mmeCounts, smfCounts] = await Promise.all([
          this.apiClient.getMmeCountsFromMetrics(),
          this.apiClient.getSmfCountsFromMetrics(),
        ]);

        const already5G = imsi5GSet?.size ?? 0;
        const rawCount  = mmeCounts.ueCount > 0
          ? mmeCounts.ueCount
          : mmeCounts.sessionCount > 0
            ? mmeCounts.sessionCount
            : smfCounts.activeUeCount;
        const ueCount = Math.max(0, rawCount - already5G);

        if (ueCount <= 0) {
          this.logger.info('[4G Sessions] metrics fallback: no active UEs');
          return [];
        }

        this.logger.info({ ueCount, mmeCounts }, '[4G Sessions] using Prometheus metrics fallback');
        const syntheticUEs: ActiveUE[] = Array.from({ length: ueCount }, () => ({
          ip: '', imsi: '', apn: 'internet', sessions: [{ apn: 'internet', ip: '' }], cmState: 'connected', metricsOnly: true,
        }));
        this.logger.info({ count: syntheticUEs.length }, '[4G Sessions] metrics fallback complete');
        return syntheticUEs;
      }

      // MME is running — fetch PDU sessions and build full UE list
      const [pduSessions, active5G] = await Promise.all([
        this.apiClient.getSmfPduInfo(),
        imsi5GSet ? Promise.resolve([] as ActiveUE[]) : this.getActive5GUEs(),
      ]);

      const known5G = imsi5GSet ?? new Set(active5G.map((ue: ActiveUE) => ue.imsi));

      // Build PDU IP lookup by (IMSI, APN) — not just IMSI (4G sessions have
      // no n3 block). A UE can hold several concurrent 4G PDN connections at
      // once (e.g. "internet" + "ims" for VoLTE), each with its own IP; the
      // old imsi-only map only ever kept the first one it saw.
      const ipByImsiApn = new Map<string, Map<string, string>>();
      for (const session of pduSessions) {
        if (!session.supi) continue;
        const imsi = String(session.supi).replace(/^imsi-/, '');
        for (const pdu of session.pdu) {
          if (pdu.ipv4 && !pdu.n3) {
            if (!ipByImsiApn.has(imsi)) ipByImsiApn.set(imsi, new Map());
            ipByImsiApn.get(imsi)!.set(pdu.apn ?? pdu.dnn ?? '', pdu.ipv4);
          }
        }
      }

      // Build eNodeB lookup by enb_id → IP
      const enbIpById = new Map<number, string>();
      for (const enb of mmeEnbs) {
        enbIpById.set(enb.enb_id, parsePeerIP(enb.s1.sctp.peer));
      }

      // Build set of live eNodeB IPs (setup_success = true)
      const liveEnbIps = new Set(
        mmeEnbs
          .filter(enb => enb.s1?.setup_success)
          .map(enb => parsePeerIP(enb.s1.sctp.peer)),
      );

      const activeUEs: ActiveUE[] = [];
      // Keyed by imsi — one row per UE, matching the 5G function. A UE's
      // several concurrent 4G PDN connections (e.g. "internet" + "ims" for
      // VoLTE) are gathered into that UE's own `sessions[]` array below.
      const seenImsi = new Set<string>();

      for (const mmeUe of mmeUes) {
        // Only 4G EPS UEs
        if (mmeUe.domain !== 'EPS') continue;

        // Guard against missing supi — some Open5GS versions use 'imsi' field
        const rawId = (mmeUe as any).supi ?? (mmeUe as any).imsi;
        if (!rawId) {
          this.logger.warn({ mmeUe }, '[4G Sessions] skipped — no supi/imsi field');
          continue;
        }
        const imsi = String(rawId).replace(/^imsi-/, '');
        if (seenImsi.has(imsi)) continue;

        // Deduplicate against 5G list
        if (known5G.has(imsi)) {
          this.logger.debug({ imsi }, '[4G Sessions] skipped — already in 5G list');
          continue;
        }

        // Resolve eNodeB IP from enb_id
        const enbId = mmeUe.enb?.enb_id;
        const radioIp = enbId !== undefined ? enbIpById.get(enbId) : undefined;

        // Skip ONLY when we can positively show this UE's own eNodeB isn't
        // live (i.e. we know its radioIp AND at least one other eNodeB IS
        // live to compare against). If every known eNodeB has
        // setup_success=false, that's not positive evidence any specific UE
        // is gone — MME still knows about it even if S1 isn't fully
        // confirmed — so those UEs must still show, not vanish.
        if (radioIp && liveEnbIps.size > 0 && !liveEnbIps.has(radioIp)) {
          this.logger.debug({ imsi, radioIp }, '[4G Sessions] skipped — eNodeB not live');
          continue;
        }

        seenImsi.add(imsi);

        // Gather every concurrent 4G PDN connection (one per APN) for this
        // UE, not just pdn[0] — a UE can hold several at once (e.g.
        // "internet" + "ims" for VoLTE registration/SIP signaling); the old
        // code only ever surfaced the first and silently dropped the rest.
        // Falls back to a single apn-less session if the MME response has
        // no pdn array at all, matching the previous behavior for that case.
        const pdns = mmeUe.pdn && mmeUe.pdn.length > 0 ? mmeUe.pdn : [{ apn: '' }];
        const apnIps = ipByImsiApn.get(imsi);
        const sessions: UeApnSession[] = [];
        const seenApn = new Set<string>();
        for (const pdn of pdns) {
          const apn = pdn.apn ?? '';
          if (seenApn.has(apn)) continue;
          seenApn.add(apn);
          const ip = apnIps?.get(apn) ?? apnIps?.values().next().value ?? '';
          sessions.push({ apn, ip });
        }

        const ue: ActiveUE = {
          ip:          sessions[0].ip,
          imsi,
          cmState:     mmeUe.cm_state,
          apn:         sessions[0].apn,
          sessions,
          ambrDownlink: mmeUe.ambr?.downlink,
          ambrUplink:   mmeUe.ambr?.uplink,
          radioIp,
        };

        activeUEs.push(ue);
        this.logger.info({ imsi, sessions, cm_state: mmeUe.cm_state }, '[4G Sessions] ✓ active UE');
      }

      this.logger.info({ count: activeUEs.length }, '[4G Sessions] complete');

      // Enrich with subscriber nicknames from MongoDB
      const nicknames4G = await this.subscriberRepo.getNicknamesByImsi(activeUEs.map(u => u.imsi));
      return activeUEs.map(u => ({ ...u, nickname: nicknames4G[u.imsi] }));
    } catch (err) {
      this.logger.error({ err: String(err) }, '[4G Sessions] error');
      return [];
    }
  }
}
