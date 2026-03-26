import { BaseNfConfig, SbiConfig } from './base-config';

export interface NrfConfig extends BaseNfConfig {
  sbi: SbiConfig;
  servingScope?: string[];
}
