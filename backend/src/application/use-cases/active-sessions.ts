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

export interface ActiveUE {
  ip: string;
  imsi: string;
  cmState?: 'connected' | 'idle' | string;
  dnn?: string;
  apn?: string;
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
          ip: '', imsi: '', dnn: primaryDnn, cmState: 'connected', metricsOnly: true,
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
      const seenImsi = new Set<string>();

      for (const session of pduSessions) {
        for (const pdu of session.pdu) {
          // 5G: must have an N3 block (GTP-U tunnel to gNodeB)
          if (!pdu.n3 || !pdu.ipv4) continue;

          const imsi = session.supi.replace(/^imsi-/, '');
          if (seenImsi.has(imsi)) continue;
          seenImsi.add(imsi);

          const amfUe = amfByImsi.get(imsi);

          // Resolve gNodeB IP from gnb_id (N2 SCTP control-plane IP)
          const gnbId = amfUe?.gnb?.gnb_id;
          const radioIp = gnbId !== undefined ? gnbIpById.get(gnbId) : undefined;

          // Only skip if we have gNodeB data AND none are live
          const hasGnbData = amfGnbs.length > 0;
          if (hasGnbData && liveGnbIps.size === 0) {
            this.logger.debug({ imsi }, '[5G Sessions] skipped — no live gNodeBs');
            continue;
          }
          if (radioIp && liveGnbIps.size > 0 && !liveGnbIps.has(radioIp)) {
            this.logger.debug({ imsi, radioIp }, '[5G Sessions] skipped — gNodeB not live');
            continue;
          }

          // Fall back to N3 GTP-U gNB address when gnb_id → N2 IP lookup fails.
          // For most small cells, the N2 SCTP and N3 GTP-U IPs are the same interface,
          // so this fallback keeps UEs visible under their radio card when AMF UE info
          // lacks gnb or gnb_id (e.g. some firmware versions, or after idle→active transition).
          const displayRadioIp = radioIp ?? (pdu.n3?.gnb?.addr ? parsePeerIP(pdu.n3.gnb.addr) : undefined);

          const ue: ActiveUE = {
            ip:          pdu.ipv4,
            imsi,
            cmState:     amfUe?.cm_state,
            dnn:         pdu.dnn,
            sliceSst:    pdu.snssai?.sst,
            sliceSd:     pdu.snssai?.sd,
            securityEnc: amfUe?.security?.enc,
            securityInt: amfUe?.security?.int,
            ambrDownlink: amfUe?.ambr?.downlink,
            ambrUplink:   amfUe?.ambr?.uplink,
            radioIp:     displayRadioIp,
          };

          activeUEs.push(ue);
          this.logger.info({ imsi, ip: pdu.ipv4, cm_state: amfUe?.cm_state }, '[5G Sessions] ✓ active UE');
        }
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
          ip: '', imsi: '', apn: 'internet', cmState: 'connected', metricsOnly: true,
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

      // Build PDU IP lookup by IMSI (4G sessions have no n3 block)
      const ipByImsi = new Map<string, string>();
      for (const session of pduSessions) {
        if (!session.supi) continue;
        const imsi = String(session.supi).replace(/^imsi-/, '');
        for (const pdu of session.pdu) {
          if (pdu.ipv4 && !pdu.n3) {
            ipByImsi.set(imsi, pdu.ipv4);
            break;
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

        // Deduplicate against 5G list
        if (known5G.has(imsi)) {
          this.logger.debug({ imsi }, '[4G Sessions] skipped — already in 5G list');
          continue;
        }

        if (seenImsi.has(imsi)) continue;
        seenImsi.add(imsi);

        const ip  = ipByImsi.get(imsi) || '';
        const apn = mmeUe.pdn?.[0]?.apn ?? '';

        // Resolve eNodeB IP from enb_id
        const enbId = mmeUe.enb?.enb_id;
        const radioIp = enbId !== undefined ? enbIpById.get(enbId) : undefined;

        // Only skip UEs if we have eNodeB data AND none are live
        // If liveEnbIps is empty but we have eNodeBs (all setup_success=false),
        // still show UEs — the MME knows about them even if S1 isn't fully up
        const hasEnbData = mmeEnbs.length > 0;
        if (hasEnbData && liveEnbIps.size === 0) {
          this.logger.debug({ imsi }, '[4G Sessions] skipped — no live eNodeBs');
          continue;
        }
        if (radioIp && liveEnbIps.size > 0 && !liveEnbIps.has(radioIp)) {
          this.logger.debug({ imsi, radioIp }, '[4G Sessions] skipped — eNodeB not live');
          continue;
        }

        const ue: ActiveUE = {
          ip,
          imsi,
          cmState:     mmeUe.cm_state,
          apn,
          ambrDownlink: mmeUe.ambr?.downlink,
          ambrUplink:   mmeUe.ambr?.uplink,
          radioIp,
        };

        activeUEs.push(ue);
        this.logger.info({ imsi, ip, cm_state: mmeUe.cm_state }, '[4G Sessions] ✓ active UE');
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
