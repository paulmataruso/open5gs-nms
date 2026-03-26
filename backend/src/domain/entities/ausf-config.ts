import { BaseNfConfig, SbiConfig } from './base-config';

export interface AusfConfig extends BaseNfConfig {
  sbi: SbiConfig;
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
