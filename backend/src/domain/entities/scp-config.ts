import { BaseNfConfig, SbiConfig } from './base-config';

export interface ScpConfig extends BaseNfConfig {
  sbi: SbiConfig;
  info?: {
    port?: {
      http?: number;
      https?: number;
    };
    domain?: Array<{
      name: string;
      fqdn: string;
      port?: {
        http?: number;
        https?: number;
      };
    }>;
  };
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
