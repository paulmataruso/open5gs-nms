import axios from 'axios';

const api = axios.create({ baseURL: '/api/gsm', withCredentials: true });

export type BtsBackend = 'virtual' | 'trx' | 'remote-abis-ip';

export type GprsMode = 'none' | 'gprs' | 'egprs';

export interface BtsEntry {
  id: string;
  name: string;
  backend: BtsBackend;
  unitId: number;
  band: string;
  arfcn: number;
  cellIdentity: number;
  locationAreaCode: number;
  baseStationIdCode: number;
  remoteIp?: string;
  omlRemoteIp?: string;
  gprsMode?: GprsMode;
  gprsNsvci?: number;
  gprsNsei?: number;
  gprsBvci?: number;
  // LTE neighbour EARFCNs broadcast in SI2quater (CSFB return-to-LTE).
  lteEarfcns?: number[];
}

export interface GsmStatus {
  success: boolean;
  installedOnDisk: boolean;
  btsInstalled: boolean;
  gprsInstalled: boolean;
  configured: boolean;
  services: Record<string, boolean>;
  btsEntries: BtsEntry[];
  bscMgwBindIp: string;
  mscMgwBindIp: string;
  mgwRtpBindIp: string;
  gprsEnabled: boolean;
  gprsMode: 'gprs' | 'egprs';
  sgsnGtpLocalIp: string;
  sgsnGbRemoteIp: string;
  ggsnGtpBindIp: string;
  ggsnApn: string;
  ggsnTunDevice: string;
  ggsnPoolCidr: string;
  ggsnDns1: string;
  ggsnDns2: string;
  gprsNat: boolean;
  // What the GGSN pool is doing in the dataplane right now — '' until a
  // Configure with a pool CIDR has run. Exactly one is non-empty.
  appliedGprsEigrpCidr: string;
  appliedGprsNatCidr: string;
  // Read-only here — owned and edited on the SMS (SGs) page.
  sgsShared: { hlrBindIp: string; mscBindIp: string } | null;
}

export interface GsmConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
  shared?: boolean;
  sharedWith?: string;
}

// Raw fields exactly as abisip-find -j reports them (real ip.access
// broadcast-discovery protocol response) — confirmed live against a real
// nanoBTS, not a guessed shape.
export interface DiscoveredRadio {
  macAddress: string; ipAddress: string; unitId: string;
  location1: string; location2: string;
  equipmentVersion: string; softwareVersion: string;
  unitName: string; serialNumber: string;
}

// Unified-subscriber 2G status — hlr.db itself is written only by the SMS
// module's sync-subscribers (BIND9-style single-writer convention); this is
// a read-only view of that same data exposed under /api/gsm since that's
// where a 2G operator actually looks for it.
export interface HlrSubscriberStatus {
  imsi: string;
  msisdn: string | null;
  hasAuthKeys: boolean;
  lastLuSeenCs: string | null;
  lastLuSeenPs: string | null;
}

// One RSL Measurement Report row (3GPP TS 08.58/48.058), as written by
// osmo-meas-udp2db from osmo-bsc's own meas-feed — already resolved to a
// real IMSI by osmo-bsc itself, no separate identity join needed on our end
// beyond enriching with nickname/msisdn.
export interface GsmSignalSample {
  imsi: string;
  timestamp: string;
  msPowerDbm: number | null;
  timingAdvance: number | null;
  ulRxLevDbm: number | null;
  ulRxQual: number | null;
  dlRxLevDbm: number | null;
  dlRxQual: number | null;
  bsPowerDbm: number | null;
  ulPathLossDb: number | null;
  dlPathLossDb: number | null;
  nickname?: string | null;
  msisdn?: string | null;
  // Which BTS this UE is on right now (index into the BTS list), from a
  // live `show lchan` — null if the UE is in signal history but not
  // currently on a dedicated channel.
  bts?: number | null;
}

export interface BtsLinkStatus {
  success: boolean;
  operState: string; adminState: string; availState: string;
  omlConnected: boolean; rslConnected: boolean;
}

export const BTS_BAND_OPTIONS = ['GSM900', 'DCS1800', 'GSM850', 'PCS1900'];

// Verified against libosmocore's own gsm_arfcn2band_rc() range table (not
// guessed) — each band's ARFCN numbering is a separate, non-contiguous
// range, and DCS1800/PCS1900 even overlap numerically (512-885 vs
// 512-810), disambiguated only by the separate `band` directive. Picking
// an ARFCN outside the selected band's range is a real, easy mistake —
// e.g. this module's own default of 871 is valid for DCS1800 but NOT for
// PCS1900. Values below are a safe mid-range default per band, not
// specification-mandated.
export const BTS_BAND_ARFCN_RANGE: Record<string, { min: number; max: number; default: number }> = {
  GSM900:  { min: 1,   max: 124, default: 20 },
  GSM850:  { min: 128, max: 251, default: 190 },
  DCS1800: { min: 512, max: 885, default: 700 },
  PCS1900: { min: 512, max: 810, default: 661 },
};

export const gsmApi = {
  getStatus: async (): Promise<GsmStatus> => {
    const { data } = await api.get('/status');
    return data;
  },
  install: (): Promise<Response> =>
    fetch('/api/gsm/install', { method: 'POST', credentials: 'include' }),
  uninstall: (): Promise<Response> =>
    fetch('/api/gsm/uninstall', { method: 'POST', credentials: 'include' }),
  configure: async (input: {
    bscMgwBindIp?: string; mscMgwBindIp?: string; mgwRtpBindIp?: string;
    gprsEnabled?: boolean; gprsMode?: 'gprs' | 'egprs'; sgsnGtpLocalIp?: string; sgsnGbRemoteIp?: string; ggsnGtpBindIp?: string;
    ggsnApn?: string; ggsnTunDevice?: string; ggsnPoolCidr?: string; ggsnDns1?: string; ggsnDns2?: string; gprsNat?: boolean;
  }): Promise<{ success: boolean; eigrpApplied: string | null }> => {
    const { data } = await api.post('/configure', input);
    return data;
  },
  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },
  listBts: async (): Promise<{ success: boolean; btsEntries: BtsEntry[] }> => {
    const { data } = await api.get('/bts');
    return data;
  },
  listSubscribers: async (): Promise<{ success: boolean; subscribers: HlrSubscriberStatus[] }> => {
    const { data } = await api.get('/subscribers');
    return data;
  },
  getSignalOverview: async (): Promise<{ success: boolean; samples: GsmSignalSample[] }> => {
    const { data } = await api.get('/signal/overview');
    return data;
  },
  getSignalHistory: async (imsi: string): Promise<{ success: boolean; samples: GsmSignalSample[] }> => {
    const { data } = await api.get('/signal/history', { params: { imsi } });
    return data;
  },
  addBts: async (input: Omit<BtsEntry, 'id' | 'unitId'> & { unitId?: number }): Promise<{ success: boolean; bts: BtsEntry; provisionWarning?: string }> => {
    const { data } = await api.post('/bts', input);
    return data;
  },
  updateBts: async (id: string, input: Partial<Omit<BtsEntry, 'id'>>): Promise<{ success: boolean; bts: BtsEntry; provisionWarning?: string }> => {
    const { data } = await api.put(`/bts/${id}`, input);
    return data;
  },
  removeBts: async (id: string) => {
    const { data } = await api.delete(`/bts/${id}`);
    return data;
  },
  discover: async (input: { cidr: string; timeoutSeconds?: number }): Promise<{ success: boolean; radios: DiscoveredRadio[] }> => {
    const { data } = await api.post('/discover', input);
    return data;
  },
  provisionBts: async (id: string) => {
    const { data } = await api.post(`/bts/${id}/provision`);
    return data;
  },
  restartBts: async (id: string) => {
    const { data } = await api.post(`/bts/${id}/restart`);
    return data;
  },
  getBtsLinkStatus: async (id: string): Promise<BtsLinkStatus> => {
    const { data } = await api.get(`/bts/${id}/link-status`);
    return data;
  },
  getConfigs: async (): Promise<{ success: boolean; files: GsmConfigFile[] }> => {
    const { data } = await api.get('/configs');
    return data;
  },
  getConfigContent: async (path: string): Promise<{ success: boolean; content: string }> => {
    const { data } = await api.get('/configs/content', { params: { path } });
    return data;
  },
  saveConfigContent: async (path: string, content: string) => {
    const { data } = await api.put('/configs/content', { path, content });
    return data;
  },
  restartServices: async (services: string[]) => {
    const { data } = await api.post('/configs/restart', { services });
    return data;
  },
};
