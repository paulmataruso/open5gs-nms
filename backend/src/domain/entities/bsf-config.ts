import { BaseNfConfig, SbiConfig } from './base-config';

export interface BsfConfig extends BaseNfConfig {
  sbi: SbiConfig;
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
