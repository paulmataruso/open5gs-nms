export interface HnetKey {
  id: number;
  scheme: 1 | 2;
  keyFile: string;
  fileExists: boolean;
  publicKeyHex: string | null;
  profile: 'A' | 'B';
  schemeLabel: string;
  algorithm: string;
}

export interface SuciKeysResult {
  keys: HnetKey[];
  hnetDir: string;
}

export interface GenerateKeyInput {
  id: number;
  scheme: 1 | 2;
}

// Extended SIM data with SUCI fields
export interface SuciConfig {
  enabled: boolean;
  profile: 'A' | 'B' | null;
  pki_id: number | null;
  home_network_public_key: string | null;
  routing_indicator: string;  // Default "0000"
}
