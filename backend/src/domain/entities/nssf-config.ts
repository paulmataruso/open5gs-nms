import { BaseNfConfig, SbiConfig, Snssai } from './base-config';

export interface NssfConfig extends BaseNfConfig {
  sbi: SbiConfig;
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
  nsi?: Array<{
    uri: string;
    s_nssai: Snssai;
  }>;
}
