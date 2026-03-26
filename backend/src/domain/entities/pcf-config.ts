import { LoggerConfig, SbiConfig, Snssai, PlmnId } from './base-config';

export interface PcfPolicySession {
  name: string;
  type: number;
  ambr?: {
    downlink: { value: number; unit: number };
    uplink: { value: number; unit: number };
  };
  qos?: {
    index: number;
    arp?: {
      priority_level: number;
      pre_emption_vulnerability: number;
      pre_emption_capability: number;
    };
  };
  pcc_rule?: Array<{
    qos: {
      index: number;
      arp: {
        priority_level: number;
        pre_emption_vulnerability: number;
        pre_emption_capability: number;
      };
      mbr?: {
        downlink: { value: number; unit: number };
        uplink: { value: number; unit: number };
      };
      gbr?: {
        downlink: { value: number; unit: number };
        uplink: { value: number; unit: number };
      };
    };
    flow?: Array<{
      direction: number;
      description: string;
    }>;
  }>;
}

export interface PcfPolicySlice {
  sst: number;
  sd?: string;
  default_indicator?: boolean;
  session: PcfPolicySession[];
}

export interface PcfPolicy {
  supi_range?: string[];
  plmn_id?: PlmnId;
  slice: PcfPolicySlice[];
}

export interface PcfConfig {
  sbi: SbiConfig;
  logger?: LoggerConfig;
  metrics?: {
    server: Array<{
      address: string;
      port: number;
    }>;
  };
  policy?: PcfPolicy[];
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
  rawYaml?: Record<string, unknown>;
}
