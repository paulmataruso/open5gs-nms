import { SmfYamlDocument } from './open5gs-yaml';
import { BaseNfConfig, PfcpConfig, PlmnId, SbiConfig, Snssai, GtpuConfig } from './base-config';
import { YamlSession } from './open5gs-yaml';


export interface SmfDnsConfig {
  addr?: string | string[];
}

/**
 * `smf.session` as it really appears on disk, verified against this host's
 * smf.yaml: `{ subnet: '10.45.0.0/16', gateway: '10.45.0.1', dnn: 'internet' }`
 * — a flat entry with a STRING subnet.
 *
 * This used to declare `subnet: SmfSubnetConfig[]`, a nested list that no real
 * file produces. The repository populated it with
 * `session: smf.session as SmfConfig['session']`, so the assertion hid the
 * mismatch, and dnn-dev-resolver.ts then compared `smfSess.subnet` as a CIDR
 * string — correct against the real data, impossible against the old type.
 * SmfSubnetConfig had no other reference and is gone.
 */
export type SmfSessionConfig = YamlSession;

export interface SmfInfoEntry {
  s_nssai: Snssai[];
  dnn: string[];
}

export interface SmfCtfConfig {
  enabled: 'auto' | 'yes' | 'no';
}

export interface SmfConfig extends BaseNfConfig<SmfYamlDocument> {
  sbi: SbiConfig;
  pfcp: PfcpConfig;
  /** Normalised by parseGtpc from `server[0]`, which carries a port too. */
  gtpc?: {
    addr: string;
    port?: number;
  };
  gtpu?: GtpuConfig;
  session?: SmfSessionConfig[];
  dns?: string[];
  mtu?: number;
  freeDiameter?: string;
  ctf?: SmfCtfConfig;
  info?: SmfInfoEntry[];
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
