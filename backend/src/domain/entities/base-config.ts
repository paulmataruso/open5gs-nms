import { YamlDocumentCommon } from './open5gs-yaml';

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

/**
 * `TDoc` is the shape of the whole parsed YAML file this config came from --
 * see open5gs-yaml.ts, and Open5gsConfigDocuments in
 * domain/interfaces/config-repository.ts for the service-name -> document map.
 * It defaults to the loose form so an entity that has no document type yet
 * still compiles; naming the real one is what makes `rawYaml` reads checked.
 */
export interface BaseNfConfig<TDoc extends YamlDocumentCommon = YamlDocumentCommon> {
  logger?: LoggerConfig;
  metrics?: MetricsConfig;
  rawYaml?: TDoc;
}
