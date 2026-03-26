import { BaseNfConfig, SbiConfig } from './base-config';

export interface UdrConfig extends BaseNfConfig {
  sbi: SbiConfig;
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
