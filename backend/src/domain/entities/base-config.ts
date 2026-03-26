export interface PlmnId {
  mcc: string;
  mnc: string;
}

export interface Snssai {
  sst: number;
  sd?: string;
}

export interface SbiConfig {
  addr: string | string[];
  port: number;
}

export interface PfcpConfig {
  addr: string;
  port?: number;
}

export interface GtpuConfig {
  addr: string;
  port?: number;
}

export interface GtpcConfig {
  addr: string;
  port?: number;
}

export interface MetricsConfig {
  addr?: string;
  port?: number;
}

export interface LoggerConfig {
  file?: string;
  level?: string;
}

export interface AmbrConfig {
  uplink: string;
  downlink: string;
}

export interface BaseNfConfig {
  logger?: LoggerConfig;
  metrics?: MetricsConfig;
  rawYaml?: Record<string, unknown>;
}
