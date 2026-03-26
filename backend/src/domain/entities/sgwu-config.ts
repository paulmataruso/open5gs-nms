import { BaseNfConfig, PfcpConfig, GtpuConfig } from './base-config';

export interface SgwuSessionSubnet {
  subnet: string;
  gateway?: string;
  dev?: string;
}

export interface SgwuConfig extends BaseNfConfig {
  pfcp: {
    server: Array<{
      address: string;
      port?: number;
      dev?: string;
      advertise?: string;
    }>;
    client?: {
      sgwc?: Array<{
        address: string;
      }>;
    };
  };
  gtpu: {
    server: Array<{
      address: string;
      port?: number;
      dev?: string;
      advertise?: string;
      teid_range_indication?: number;
      teid_range?: number;
      network_instance?: string;
      source_interface?: number;
    }>;
  };
  session?: SgwuSessionSubnet[];
}
