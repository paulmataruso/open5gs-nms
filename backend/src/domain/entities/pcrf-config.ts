import { LoggerConfig } from './base-config';

// PCRF uses Diameter, not SBI
export interface PcrfPolicySession {
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

export interface PcrfPolicy {
  supi_range?: string[];
  session: PcrfPolicySession[];
}

export interface PcrfConfig {
  freeDiameter: string;
  logger?: LoggerConfig;
  metrics?: {
    server: Array<{
      address: string;
      port: number;
    }>;
  };
  policy?: PcrfPolicy[];
  rawYaml?: Record<string, unknown>;
}
