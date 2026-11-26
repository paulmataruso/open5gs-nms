import { AusfYamlDocument } from './open5gs-yaml';
import { BaseNfConfig, SbiConfig } from './base-config';

export interface AusfConfig extends BaseNfConfig<AusfYamlDocument> {
  sbi: SbiConfig;
  nrf?: {
    sbi: {
      addr: string | string[];
      port?: number;
    };
  };
}
