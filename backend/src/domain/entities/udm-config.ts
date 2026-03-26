import { BaseNfConfig, SbiConfig } from './base-config';

export interface HnetKey {
  id: number;
  scheme: number;  // 1: ECIES scheme profile A, 2: ECIES scheme profile B
  key: string;     // Path to key file
}

export interface UdmConfig extends BaseNfConfig {
  sbi: SbiConfig;
  hnet?: HnetKey[];
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
