import { UpfYamlDocument } from './open5gs-yaml';
import { BaseNfConfig, GtpuConfig, PfcpConfig } from './base-config';
import { YamlSession } from './open5gs-yaml';


/**
 * `upf.session` as it really appears on disk, verified against this host's
 * upf.yaml: `{ subnet, gateway, dev, dnn }`, all strings. Previously declared
 * as a nested `UpfSubnetConfig[]`, which no real file produces; see
 * SmfSessionConfig for the same mistake and how the assertion hid it.
 */
export type UpfSessionConfig = YamlSession;

export interface UpfConfig extends BaseNfConfig<UpfYamlDocument> {
  pfcp: PfcpConfig;
  gtpu: GtpuConfig;
  session?: UpfSessionConfig[];
  metrics?: {
    addr?: string;
    port?: number;
  };
}
