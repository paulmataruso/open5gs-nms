// Generic config for any Open5GS service
export interface GenericServiceConfig {
  sbi?: { addr: string | string[]; port?: number };
  pfcp?: { addr: string; port?: number };
  gtpu?: { addr: string; port?: number };
  gtpc?: { addr: string };
  ngap?: { addr: string | string[]; port?: number };
  nrf?: { sbi: { addr: string | string[]; port?: number } };
  logger?: { file?: string; level?: string };
  // Store the raw YAML for round-trip editing
  rawYaml?: Record<string, unknown>;
}
