import { BaseNfConfig, GtpcConfig, PfcpConfig } from './base-config';

export interface SgwcConfig extends BaseNfConfig {
  gtpc: {
    server: Array<{
      address: string;
      port?: number;
    }>;
  };
  pfcp: {
    server: Array<{
      address: string;
      port?: number;
      dev?: string;
      advertise?: string;
    }>;
    client: {
      sgwu: Array<{
        address: string;
        tac?: number | number[];
        e_cell_id?: string | string[];
        apn?: string | string[];
      }>;
    };
  };
}
