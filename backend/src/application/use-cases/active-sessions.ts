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
  // Enriched fields from Open5GS API
  cmState?: 'connected' | 'idle' | string;
  dnn?: string;              // 5G data network name
  apn?: string;              // 4G APN
  sliceSst?: number;
  sliceSd?: string;
  securityEnc?: string;      // 5G only: e.g. "nea2"
  securityInt?: string;      // 5G only: e.g. "nia2"
  ambrDownlink?: number;     // bps
  ambrUplink?: number;       // bps
  radioIp?: string;          // IP of the eNodeB/gNodeB this UE is connected to
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

      // Build AMF UE lookup by IMSI for enrichment
      const amfByImsi = new Map<string, typeof amfUes[0]>();
      for (const ue of amfUes) {
        const imsi = ue.supi.replace(/^imsi-/, '');
        amfByImsi.set(imsi, ue);
      }

      // Build gNodeB lookup by gnb_id → IP
      const gnbIpById = new Map<number, string>();
      for (const gnb of amfGnbs) {
        gnbIpById.set(gnb.gnb_id, parsePeerIP(gnb.ng.sctp.peer));
      }

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

          // Resolve gNodeB IP from gnb_id
          const gnbId = amfUe?.gnb?.gnb_id;
          const radioIp = gnbId !== undefined ? gnbIpById.get(gnbId) : undefined;

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
            radioIp,
          };

          activeUEs.push(ue);
          this.logger.info({ imsi, ip: pdu.ipv4, cm_state: amfUe?.cm_state }, '[5G Sessions] ✓ active UE');
        }
      }

      this.logger.info({ count: activeUEs.length }, '[5G Sessions] complete');
      return activeUEs;
    } catch (err) {
      this.logger.error({ err: String(err) }, '[5G Sessions] error');
      return [];
    }
  }

  /**
   * Active 4G UEs — sourced from MME /ue-info (domain: "EPS").
   * IP is cross-referenced from SMF /pdu-info by SUPI.
   * Any IMSI already in the 5G list is excluded (deduplication).
   */
  async getActive4GUEs(): Promise<ActiveUE[]> {
    try {
      const [mmeUes, pduSessions, active5G, mmeEnbs] = await Promise.all([
        this.apiClient.getMmeUeInfo(),
        this.apiClient.getSmfPduInfo(),
        this.getActive5GUEs(),
        this.apiClient.getMmeEnbInfo(),
      ]);

      // Build PDU IP lookup by IMSI (4G sessions have no n3 block)
      const ipByImsi = new Map<string, string>();
      for (const session of pduSessions) {
        const imsi = session.supi.replace(/^imsi-/, '');
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

      const imsi5GSet = new Set(active5G.map(ue => ue.imsi));
      const activeUEs: ActiveUE[] = [];
      const seenImsi = new Set<string>();

      for (const mmeUe of mmeUes) {
        // Only 4G EPS UEs
        if (mmeUe.domain !== 'EPS') continue;

        const imsi = mmeUe.supi.replace(/^imsi-/, '');

        // Deduplicate against 5G list
        if (imsi5GSet.has(imsi)) {
          this.logger.debug({ imsi }, '[4G Sessions] skipped — already in 5G list');
          continue;
        }

        if (seenImsi.has(imsi)) continue;
        seenImsi.add(imsi);

        const ip = ipByImsi.get(imsi) || '';
        const apn = mmeUe.pdn?.[0]?.apn;

        // Resolve eNodeB IP from enb_id
        const enbId = mmeUe.enb?.enb_id;
        const radioIp = enbId !== undefined ? enbIpById.get(enbId) : undefined;

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
      return activeUEs;
    } catch (err) {
      this.logger.error({ err: String(err) }, '[4G Sessions] error');
      return [];
    }
  }
}
