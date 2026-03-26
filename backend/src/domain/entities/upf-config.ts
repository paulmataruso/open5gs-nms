import { BaseNfConfig, GtpuConfig, PfcpConfig } from './base-config';

export interface UpfSubnetConfig {
  addr: string;
  dnn?: string;
  dev?: string;
}

export interface UpfSessionConfig {
  subnet: UpfSubnetConfig[];
}

export interface UpfConfig extends BaseNfConfig {
  pfcp: PfcpConfig;
  gtpu: GtpuConfig;
  session?: UpfSessionConfig[];
  metrics?: {
    addr?: string;
    port?: number;
  };
}
