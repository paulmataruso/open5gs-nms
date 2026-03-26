import { BaseNfConfig, PfcpConfig, PlmnId, SbiConfig, Snssai, GtpuConfig } from './base-config';

export interface SmfSubnetConfig {
  addr: string;
  dnn?: string;
}

export interface SmfDnsConfig {
  addr?: string | string[];
}

export interface SmfSessionConfig {
  subnet: SmfSubnetConfig[];
  dns?: SmfDnsConfig[];
}

export interface SmfInfoEntry {
  s_nssai: Snssai[];
  dnn: string[];
}

export interface SmfConfig extends BaseNfConfig {
  sbi: SbiConfig;
  pfcp: PfcpConfig;
  gtpc?: {
    addr: string | string[];
  };
  gtpu?: GtpuConfig;
  session?: SmfSessionConfig[];
  dns?: string[];
  mtu?: number;
  freeDiameter?: string;
  info?: SmfInfoEntry[];
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
