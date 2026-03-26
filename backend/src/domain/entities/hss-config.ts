import { LoggerConfig } from './base-config';

export interface HssConfig {
  freeDiameter: string;
  logger?: LoggerConfig;
  metrics?: {
    server: Array<{
      address: string;
      port: number;
    }>;
  };
  sms_over_ims?: string;
  use_mongodb_change_stream?: boolean;
  rawYaml?: Record<string, unknown>;
}
