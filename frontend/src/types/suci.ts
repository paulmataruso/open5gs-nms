export interface HnetKey {
  id: number;
  scheme: 1 | 2;
  keyFile: string;
  fileExists: boolean;
  // Open5GS UDM format (udm.yaml hnet block)
  //   Profile A: raw 32-byte key, no prefix — 64 hex chars
  //   Profile B: compressed point 02/03||X  — 66 hex chars
  publicKeyHex: string | null;
  // SIM provisioning tools format (pySIM, sysmoUSIM, etc.)
  //   Profile A: raw 32-byte key, no prefix — 64 hex chars (same as UDM — X25519 has no point compression)
  //   Profile B: uncompressed point 04||X||Y — 130 hex chars
  publicKeyUncompressed: string | null;
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
