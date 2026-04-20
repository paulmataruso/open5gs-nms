import { LoggerConfig, PlmnId, GtpcConfig } from './base-config';

export interface MmeGummei {
  plmn_id: PlmnId | PlmnId[];
  mme_gid: number | number[];
  mme_code: number | number[];
}

export interface MmeTai {
  plmn_id: PlmnId;
  tac: number | number[];
}

export interface MmeConfig {
  freeDiameter: string;
  logger?: LoggerConfig;
  s1ap: {
    server: Array<{
      address: string;
      port?: number;
      dev?: string;
    }>;
  };
  gtpc: {
    server: Array<{
      address: string;
      port?: number;
    }>;
    client: {
      sgwc?: Array<{
        address: string;
        tac?: number | number[];
        e_cell_id?: string | string[];
      }>;
      smf?: Array<{
        address: string;
        apn?: string | string[];
        tac?: number | number[];
        e_cell_id?: string | string[];
      }>;
    };
  };
  metrics?: {
    server: Array<{
      address: string;
      port: number;
    }>;
  };
  gummei: MmeGummei[];
  tai: MmeTai[];
  security?: {
    integrity_order?: string[];
    ciphering_order?: string[];
  };
  network_name?: {
    full?: string;
    short?: string;
  };
  mme_name?: string;
  sgsap?: {
    client?: Array<{
      address: string | string[];
      local_address?: string | string[];
      map?: {
        tai: {
          plmn_id: { mcc: string; mnc: string };
          tac: number;
        };
        lai: {
          plmn_id: { mcc: string; mnc: string };
          lac: number;
        };
      };
    }>;
  };
  time?: {
    t3402?: { value: number };
    t3412?: { value: number };
    t3423?: { value: number };
  };
  rawYaml?: Record<string, unknown>;
}
