import axios from 'axios';

const api = axios.create({ baseURL: '/api/secgw', withCredentials: true });

export type SecGwInstallStatus = 'idle' | 'installing' | 'complete' | 'failed';
export type SecGwRadioType = '4g' | '5g';
export type SecGwRadioStatus = 'pending' | 'active' | 'revoked';

// Mirrors Baicells' own IPsec config page fields/labels — see the identical option
// tables + comments in backend/src/interfaces/rest/secgw-controller.ts (duplicated
// here rather than shared, matching this codebase's existing frontend/backend type
// duplication convention — there's no shared-types package anywhere in this project).
export type SecGwAuthMode = 'psk' | 'cert';
// Superset covering both Baicells' and Nokia's algorithm vocabularies (Nokia added
// 2026-08-14) — each vendor's own *_OPTIONS list below exposes only its own subset.
export type SecGwIkeEncryption = 'aes128' | 'aes192' | 'aes256' | '3des' | 'des' | 'aes128gcm16' | 'aes256gcm16';
export type SecGwEspEncryption = 'aes128' | 'aes192' | 'aes256' | '3des' | 'des' | 'aes128gcm16' | 'aes256gcm16' | 'aes128gmac' | 'aes256gmac';
export type SecGwIkeIntegrity = 'sha256' | 'sha256_96' | 'sha1_96' | 'sha1' | 'aesxcbc';
export type SecGwEspIntegrity = 'sha1' | 'sha256' | 'sha1_160' | 'sha256_96' | 'aesxcbc';
export type SecGwDhGroup = 'modp1024' | 'modp2048' | 'ecp256' | 'ecp384';
export type SecGwRadioVendor = 'baicells' | 'nokia';
export type SecGwIkeSaMode = 'initiator_responder' | 'responder';

export const IKE_ENCRYPTION_OPTIONS: { label: string; value: SecGwIkeEncryption }[] = [
  { label: 'AES128', value: 'aes128' },
  { label: 'AES256', value: 'aes256' },
  { label: '3DES', value: '3des' },
  { label: 'DES', value: 'des' },
];
export const ESP_ENCRYPTION_OPTIONS: { label: string; value: SecGwEspEncryption }[] = [
  { label: 'AES128', value: 'aes128' },
  { label: 'AES256', value: 'aes256' },
  { label: '3DES', value: '3des' },
  { label: 'DES', value: 'des' },
];
export const IKE_INTEGRITY_OPTIONS: { label: string; value: SecGwIkeIntegrity }[] = [
  { label: 'SHA256', value: 'sha256' },
  { label: 'SHA256_96', value: 'sha256_96' },
  { label: 'SHA1_60', value: 'sha1_96' },
  { label: 'SHA1', value: 'sha1' },
];
export const ESP_INTEGRITY_OPTIONS: { label: string; value: SecGwEspIntegrity }[] = [
  { label: 'SHA1', value: 'sha1' },
  { label: 'SHA256', value: 'sha256' },
  { label: 'SHA1_160', value: 'sha1_160' },
  { label: 'SHA256_96', value: 'sha256_96' },
];
export const IKE_DH_GROUP_OPTIONS: { label: string; value: SecGwDhGroup }[] = [
  { label: 'MODP1024', value: 'modp1024' },
  { label: 'MODP2048', value: 'modp2048' },
];
export const ESP_DH_GROUP_OPTIONS: { label: string; value: SecGwDhGroup }[] = [
  { label: 'MODP1024', value: 'modp1024' },
  { label: 'MODP2048', value: 'modp2048' },
];

// ─── Nokia option tables — mirrors the identical tables + comments in
// backend/src/interfaces/rest/secgw-controller.ts (see there for the full reasoning on
// each mapping, including the AEAD/GCM/GMAC combined-mode special cases). PSK-only.
export const NOKIA_IKE_DH_GROUP_OPTIONS: { label: string; value: SecGwDhGroup }[] = [
  { label: 'DH2 - 1024 Bits', value: 'modp1024' },
  { label: 'DH14 - 2048 Bits', value: 'modp2048' },
  { label: 'DH19 - 256 Bits elliptic curve', value: 'ecp256' },
  { label: 'DH20 - 384 Bits elliptic curve', value: 'ecp384' },
];
export const NOKIA_PFS_DH_GROUP_OPTIONS = NOKIA_IKE_DH_GROUP_OPTIONS;
export const NOKIA_IKE_ENCRYPTION_OPTIONS: { label: string; value: SecGwIkeEncryption }[] = [
  { label: 'AES_128_CBC', value: 'aes128' },
  { label: '3DES_192_CBC', value: '3des' },
  { label: 'AES_192_CBC', value: 'aes192' },
  { label: 'AES_256_CBC', value: 'aes256' },
  { label: 'AES_GCM_ICV16_128', value: 'aes128gcm16' },
  { label: 'AES_GCM_ICV16_256', value: 'aes256gcm16' },
];
export const NOKIA_IKE_INTEGRITY_OPTIONS: { label: string; value: SecGwIkeIntegrity }[] = [
  { label: 'HMAC_SHA_96', value: 'sha1_96' },
  { label: 'HMAC_SHA2_256_128', value: 'sha256' },
  { label: 'AES_XCBC_MAC_96', value: 'aesxcbc' },
  { label: 'AES_GCM_ICV_16_128', value: 'sha256' },
  { label: 'AES_GCM_ICV16_256', value: 'sha256' },
];
export const NOKIA_ESP_ENCRYPTION_OPTIONS: { label: string; value: SecGwEspEncryption }[] = [
  { label: 'AES_128_CBC', value: 'aes128' },
  { label: '3DES_192_CBC', value: '3des' },
  { label: 'AES_GMAC_128', value: 'aes128gmac' },
  { label: 'AES_GMAC_256', value: 'aes256gmac' },
  { label: 'AES_192_CBC', value: 'aes192' },
  { label: 'AES_256_CBC', value: 'aes256' },
  { label: 'AES_GCM_ICV_16_128', value: 'aes128gcm16' },
  { label: 'AES_GCM_ICV16_256', value: 'aes256gcm16' },
];
export const NOKIA_ESP_INTEGRITY_OPTIONS: { label: string; value: SecGwEspIntegrity }[] = [
  { label: 'HMAC_SHA1_96', value: 'sha1' },
  { label: 'HMAC_SHA2_256_128', value: 'sha256' },
  { label: 'AES_GMAC_128', value: 'sha256' },
  { label: 'AES_GMAC_256', value: 'sha256' },
  { label: 'AES_XCBC_MAC_96', value: 'aesxcbc' },
  { label: 'AES_GCM_ICV_16_128', value: 'sha256' },
  { label: 'AES_GCM_ICV16_256', value: 'sha256' },
];

export interface SecGwStatus {
  success: boolean;
  installedOnDisk: boolean;
  builtWithPatchRev: number | null;
  currentPatchRev: number;
  buildStale: boolean;
  installStatus: SecGwInstallStatus;
  installStartedAt: string | null;
  installCompletedAt: string | null;
  installError: string | null;
  configured: boolean;
  configuredAt: string | null;
  configuredWithVersion: number | null;
  currentConfigGenVersion: number;
  configStale: boolean;
  gatewayIp: string | null;
  interfaceMode: 'dummy' | 'existing' | null;
  gatewayFqdn: string | null;
  poolCidr: string | null;
  dummyInterfaceUp: boolean;
  serviceActive: boolean;
  bindZoneExists: boolean;
  dnsRecordPresent: boolean;
  radioCount: number;
  pendingRadioCount: number;
  activeTunnelCount: number;
}

export interface SecGwConfigureInput {
  gatewayIp?: string;
  // 'dummy' (default): create+own a new dummy-secgw interface with gatewayIp assigned.
  // 'existing': skip interface creation — gatewayIp must already be bound elsewhere.
  interfaceMode?: 'dummy' | 'existing';
  // Virtual IP pool (CIDR) for radios that request one via IKEv2 Configuration Payload —
  // confirmed live against real Baicells hardware, which requests %any rather than doing
  // classic site-to-site fixed-subnet IPsec. Only needs to be reachable from this host —
  // never advertised into EIGRP (unlike gatewayIp itself).
  poolCidr?: string;
}

export interface SecGwRadio {
  id: string;
  name: string;
  vendor: SecGwRadioVendor;
  radioType: SecGwRadioType;
  genieacsDeviceId: string | null;
  manualIdentifier: string | null;
  peerIdentity: string;
  destination: 'mme_sgwu' | 'amf_upf';
  // localTs = the auto-derived core NF pair PLUS extraLocalCidrs below, combined.
  localTs: string;
  // Extra destinations reachable through this radio's tunnel, beyond the core NF pair —
  // e.g. the BIND DNS server, for a radio whose own IPsec page can't do a plaintext
  // "Bypass" policy and needs it added as a real "Protect" traffic selector instead.
  extraLocalCidrs: string[];
  remoteTs: string;
  // The specific /32 auto-allocated for this radio from the pool CIDR — every radio gets
  // its own dedicated address, never a shared range (see the matching backend comment on
  // allocatePoolAddress() for the real outage this fixes).
  poolAddress: string | null;
  authMode: SecGwAuthMode;
  psk: string | null;
  ikeEncryption: SecGwIkeEncryption;
  ikeIntegrity: SecGwIkeIntegrity;
  ikeDhGroup: SecGwDhGroup;
  espEncryption: SecGwEspEncryption;
  espIntegrity: SecGwEspIntegrity;
  espDhGroup: SecGwDhGroup;
  certIssuedAt: string | null;
  certExpiresAt: string | null;
  certSerial: string | null;
  status: SecGwRadioStatus;
  // ─── Nokia-only fields (undefined/null for Baicells radios) ───
  ikeSaMode: SecGwIkeSaMode | null;
  ikeReauthEnabled: boolean | null;
  pfsEnabled: boolean | null;
  pfsDhGroup: SecGwDhGroup | null;
  antiReplayEnabled: boolean | null;
  antiReplayWindowSize: number | null;
  dpdDelaySeconds: number | null;
  ikeSaLifetimeSeconds: number | null;
  childSaLifetimeSeconds: number | null;
  localIpAddress: string | null;
}

export interface AddSecGwRadioInput {
  name: string;
  vendor?: SecGwRadioVendor;
  radioType: SecGwRadioType;
  genieacsDeviceId?: string;
  manualIdentifier?: string;
  // No remoteTs input — the backend always auto-allocates a dedicated /32 per radio from
  // the pool CIDR now (see SecGwRadio.poolAddress). A shared/manually-entered remote_ts
  // caused a real outage (2026-08-13): multiple radios with the same selector collide on
  // one kernel XFRM policy slot.
  authMode?: SecGwAuthMode;
  psk?: string;
  ikeEncryption?: SecGwIkeEncryption;
  ikeIntegrity?: SecGwIkeIntegrity;
  ikeDhGroup?: SecGwDhGroup;
  espEncryption?: SecGwEspEncryption;
  espIntegrity?: SecGwEspIntegrity;
  espDhGroup?: SecGwDhGroup;
  // Comma-separated IPv4 addresses/CIDRs — applies to either vendor. See SecGwRadio.extraLocalCidrs.
  extraLocalCidrs?: string;
  // ─── Nokia-only fields — ignored/forced by the backend for Baicells radios ───
  ikeSaMode?: SecGwIkeSaMode;
  ikeReauthEnabled?: boolean;
  pfsEnabled?: boolean;
  pfsDhGroup?: SecGwDhGroup;
  antiReplayEnabled?: boolean;
  antiReplayWindowSize?: number;
  dpdDelaySeconds?: number;
  ikeSaLifetimeSeconds?: number;
  childSaLifetimeSeconds?: number;
  localIpAddress?: string;
}

export interface SecGwSession {
  radioId: string;
  radioName: string;
  connectionName: string;
  ikeState: string;
  established: boolean;
  remoteAddr: string | null;
  childState: string | null;
  localTs: string | null;
  remoteTs: string | null;
  bytesIn: number | null;
  bytesOut: number | null;
}

export interface SecGwConfigFile {
  path: string;
  label: string;
  group: string;
  language: string;
  exists: boolean;
}

export const secgwApi = {
  getStatus: async (): Promise<SecGwStatus> => { const { data } = await api.get('/status'); return data; },

  install: () => fetch('/api/secgw/install', { method: 'POST', credentials: 'include' }),

  configure: async (input: SecGwConfigureInput) => { const { data } = await api.post('/configure', input); return data; },
  addDnsRecord: async (): Promise<{ success: boolean; added?: boolean; error?: string }> => {
    const { data } = await api.post('/dns-record');
    return data;
  },

  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },

  getRadios: async (): Promise<{ success: boolean; radios: SecGwRadio[] }> => { const { data } = await api.get('/radios'); return data; },
  addRadio: async (input: AddSecGwRadioInput): Promise<{ success: boolean; radio?: SecGwRadio; error?: string }> => {
    const { data } = await api.post('/radios', input);
    return data;
  },
  updateRadio: async (id: string, input: AddSecGwRadioInput): Promise<{ success: boolean; radio?: SecGwRadio; error?: string }> => {
    const { data } = await api.put(`/radios/${id}`, input);
    return data;
  },
  removeRadio: async (id: string): Promise<{ success: boolean; radio?: SecGwRadio; error?: string }> => {
    const { data } = await api.delete(`/radios/${id}`);
    return data;
  },
  deleteRadioPermanently: async (id: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.delete(`/radios/${id}/permanent`);
    return data;
  },
  rotateCredential: async (id: string): Promise<{ success: boolean; radio?: SecGwRadio; error?: string }> => {
    const { data } = await api.post(`/radios/${id}/rotate-credential`);
    return data;
  },
  testTunnel: async (id: string): Promise<{ success: boolean; established: boolean; sessions: SecGwSession[] }> => {
    const { data } = await api.post(`/radios/${id}/test-tunnel`);
    return data;
  },
  downloadBundleUrl: (id: string) => `/api/secgw/radios/${id}/bundle`,

  getSessions: async (): Promise<{ success: boolean; sessions: SecGwSession[] }> => { const { data } = await api.get('/sessions'); return data; },

  getConfigs:        async (): Promise<{ success: boolean; configs: SecGwConfigFile[] }> => { const { data } = await api.get('/configs'); return data; },
  getConfigContent:  async (filePath: string): Promise<{ success: boolean; content: string }> => {
    const { data } = await api.get('/configs/content', { params: { path: filePath } });
    return data;
  },
  saveConfigContent: async (filePath: string, content: string): Promise<{ success: boolean }> => {
    const { data } = await api.put('/configs/content', { path: filePath, content });
    return data;
  },

  uninstall: () => fetch('/api/secgw/uninstall', { method: 'POST', credentials: 'include' }),
};
