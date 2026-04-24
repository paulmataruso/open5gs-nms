/**
 * Open5GS Internal API Client
 *
 * Calls the Open5GS metrics/API endpoints that are exposed on loopback
 * addresses by each NF. These are only reachable from the host network
 * namespace, so all calls go through hostExecutor (curl).
 *
 * IP/port for each NF is read from the NF's YAML config (metrics.server[0])
 * so it always matches what the user has configured in the WebUI.
 *
 * Fallback defaults (Open5GS install defaults):
 *   AMF → 127.0.0.5:9090
 *   MME → 127.0.0.2:9090
 *   SMF → 127.0.0.4:9090
 */

import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';

// ── Response types ────────────────────────────────────────────────────────────

export interface AmfGnbInfo {
  gnb_id: number;
  plmn: string;
  network?: { amf_name?: string; ngap_port?: number };
  ng: {
    sctp: { peer: string; max_out_streams?: number };
    setup_success: boolean;
  };
  supported_ta_list?: Array<{
    tac: string;
    bplmns?: Array<{ plmn: string; snssai?: Array<{ sst: number; sd?: string }> }>;
  }>;
  num_connected_ues: number;
}

export interface AmfUeInfo {
  supi: string;                 // "imsi-999702959493689"
  suci?: string;
  cm_state: string;             // "connected" | "idle"
  guti?: string;
  gnb?: { gnb_id?: number; cell_id?: number };
  location?: {
    nr_tai?: { plmn: string; tac: number };
    nr_cgi?: { plmn: string; nci: number };
  };
  security?: { valid?: number; enc?: string; int?: string };
  ambr?: { downlink: number; uplink: number };
  pdu_sessions?: Array<{
    psi: number;
    dnn: string;
    snssai?: { sst: number; sd?: string };
    resource_status?: number;
  }>;
  pdu_sessions_count?: number;
  requested_slices?: Array<{ sst: number; sd?: string }>;
  allowed_slices?: Array<{ sst: number; sd?: string }>;
}

export interface MmeEnbInfo {
  enb_id: number;
  plmn: string;
  network?: { mme_name?: string };
  s1: {
    sctp: { peer: string; max_out_streams?: number };
    setup_success: boolean;
  };
  supported_ta_list?: Array<{ tac: string; plmn: string }>;
  num_connected_ues: number;
}

export interface MmeUeInfo {
  supi: string;                 // bare IMSI e.g. "999700000053555"
  domain?: string;              // "EPS"
  rat?: string;                 // "E-UTRA"
  cm_state: string;
  enb?: { enb_id?: number; cell_id?: number };
  location?: { tai?: { plmn: string; tac: number } };
  ambr?: { downlink: number; uplink: number };
  pdn?: Array<{
    apn: string;
    ebi: number;
    qci?: number;
    bearer_count?: number;
    pdu_state?: string;
  }>;
  pdn_count?: number;
}

export interface SmfPduSession {
  psi?: number;                 // 5G PDU session ID
  ebi?: number;                 // 4G EPS bearer ID
  dnn?: string;                 // 5G data network name
  apn?: string;                 // 4G APN
  ipv4?: string;
  ipv6?: string;
  snssai?: { sst: number; sd?: string };
  n3?: {
    gnb: { teid: number; addr: string };   // "[172.16.1.67]:2152"
    upf: { teid: number; addr: string; pdr_id?: number };
  };
  pdu_state: string;            // "active" | "unknown"
}

export interface SmfPduInfo {
  supi: string;                 // "imsi-999702959493689" or bare IMSI
  ue_activity: string;          // "active" | "unknown"
  pdu: SmfPduSession[];
}

// ── Parsed peer address helper ─────────────────────────────────────────────

/**
 * Extract plain IP from Open5GS SCTP/GTP peer strings.
 * "[172.16.1.67]:2152"  → "172.16.1.67"
 * "[10.0.1.101]:36412"  → "10.0.1.101"
 * "10.0.1.101:36412"    → "10.0.1.101"  (no brackets)
 */
export function parsePeerIP(peer: string): string {
  // bracketed IPv6-style: [IP]:port
  const bracketMatch = peer.match(/^\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1];
  // plain: IP:port
  return peer.split(':')[0];
}

// ── Client class ──────────────────────────────────────────────────────────────

export class Open5gsApiClient {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  // ── Address resolution ──────────────────────────────────────────────────

  /**
   * Read the metrics server address + port from a NF's YAML config.
   * Falls back to the Open5GS install defaults if not configured.
   */
  private async getApiBase(nf: 'amf' | 'mme' | 'smf'): Promise<string> {
    const defaults: Record<string, string> = {
      amf: 'http://127.0.0.5:9090',
      mme: 'http://127.0.0.2:9090',
      smf: 'http://127.0.0.4:9090',
    };

    try {
      let raw: any;
      if (nf === 'amf') {
        const cfg = await this.configRepo.loadAmf();
        raw = (cfg as any).rawYaml?.amf;
      } else if (nf === 'smf') {
        const cfg = await this.configRepo.loadSmf();
        raw = (cfg as any).rawYaml?.smf;
      } else {
        // MME is loaded via loadGeneric
        const cfg = await (this.configRepo as any).loadMme();
        raw = (cfg as any).rawYaml?.mme;
      }

      const server = raw?.metrics?.server;
      const entry = Array.isArray(server) ? server[0] : server;
      if (entry?.address) {
        const port = entry.port || 9090;
        const base = `http://${entry.address}:${port}`;
        this.logger.debug({ nf, base }, 'Resolved Open5GS API base from config');
        return base;
      }
    } catch (err) {
      this.logger.warn({ nf, err: String(err) }, 'Could not read metrics config, using default');
    }

    this.logger.debug({ nf, base: defaults[nf] }, 'Using default Open5GS API base');
    return defaults[nf];
  }

  // ── HTTP via curl ───────────────────────────────────────────────────────

  private async httpGet<T>(url: string): Promise<T[]> {
    try {
      const result = await this.hostExecutor.executeCommand(
        'curl',
        ['-s', '--connect-timeout', '3', '--max-time', '5', url],
        8000,
      );

      if (result.exitCode !== 0 || !result.stdout.trim()) {
        this.logger.warn({ url, exitCode: result.exitCode }, 'Open5GS API call returned no data');
        return [];
      }

      const parsed = JSON.parse(result.stdout);
      return (parsed?.items as T[]) || [];
    } catch (err) {
      this.logger.warn({ url, err: String(err) }, 'Open5GS API call failed');
      return [];
    }
  }

  // ── Public API methods ──────────────────────────────────────────────────

  /** AMF: connected gNodeBs with SCTP peer IP and UE count */
  async getAmfGnbInfo(): Promise<AmfGnbInfo[]> {
    const base = await this.getApiBase('amf');
    return this.httpGet<AmfGnbInfo>(`${base}/gnb-info`);
  }

  /** AMF: registered 5G UEs with cm_state, security, slices, AMBR */
  async getAmfUeInfo(): Promise<AmfUeInfo[]> {
    const base = await this.getApiBase('amf');
    return this.httpGet<AmfUeInfo>(`${base}/ue-info`);
  }

  /** MME: connected eNodeBs with SCTP peer IP and UE count */
  async getMmeEnbInfo(): Promise<MmeEnbInfo[]> {
    const base = await this.getApiBase('mme');
    return this.httpGet<MmeEnbInfo>(`${base}/enb-info`);
  }

  /** MME: registered 4G UEs with cm_state, RAT, APN */
  async getMmeUeInfo(): Promise<MmeUeInfo[]> {
    const base = await this.getApiBase('mme');
    return this.httpGet<MmeUeInfo>(`${base}/ue-info`);
  }

  /** SMF: active PDU/PDN sessions with UE IP, N3 gNodeB address, activity */
  async getSmfPduInfo(): Promise<SmfPduInfo[]> {
    const base = await this.getApiBase('smf');
    return this.httpGet<SmfPduInfo>(`${base}/pdu-info`);
  }
}
