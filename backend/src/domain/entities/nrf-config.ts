import { NrfYamlDocument } from './open5gs-yaml';
import { BaseNfConfig, SbiConfig } from './base-config';

export interface NrfConfig extends BaseNfConfig<NrfYamlDocument> {
  sbi: SbiConfig;
  servingScope?: string[];
}
