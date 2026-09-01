import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api/genieacs`,
  timeout: 35000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

export interface BaicellsRadio {
  id:           string;
  serial:       string;
  lastInform:   string | null;
  ip:           string;
  rfStatus:     'on' | 'off' | 'offline';
  plmnMismatch: boolean;
  // Populated whenever the radio's own PLMNList/MmePoolConfigParam tables
  // have a duplicate entry (same PLMN enabled twice, or same PLMN+MME-IP
  // pair populated twice) — real bug found live 2026-08-19, confuses the
  // radio's own GUI and cell/PLMN broadcast, not just a stale-cache artifact.
  duplicatePlmnEntries: string[];
  mcc:          string;
  mnc:          string;
  tac:          string;
  mmeIp:        string;
  bandwidthMhz: string;
  earfcn:       string;
  cellId:       string;
  pci:          string;
  band:         string;
  txPower:      string;
  // Live status (from full parameter tree — only populated after bootstrap)
  mmeStatus:   string;
  // Radio's own TR-069-reported RRC-connected count. Distinct from
  // mmeUeCount below on purpose — confirmed live (2026-08-28) these can
  // legitimately disagree, since this only counts UEs currently on the
  // radio link, not ones MME still holds an S1/EPS context for while idle.
  ueCount:     string;
  // MME's own /enb-info count for this radio (includes RRC-idle UEs).
  // null means this radio isn't currently associated with MME at all —
  // distinct from a genuine 0.
  mmeUeCount:  number | null;
  gpsStatus:   string;
  gpsSatCount: string;
  uptime:      string;
  latitude:    string;
  longitude:   string;
  hwVersion:   string;
  swVersion:   string;
  // SAS
  sasEnable:           string;
  sasServerUrl:        string;
  sasUserId:           string;
  sasFccId:            string;
  sasCallSign:         string;
  sasGroupType:        string;
  sasGroupId:          string;
  sasLegacyMode:       string;
  sasRegistrationType: string;
  sasReqLowFrequency:  string;
  sasReqHighFrequency: string;
  sasPreferredFrequency:      string;
  sasPreferredBandwidth:      string;
  sasPreferredPower:          string;
  sasFrequencySelectionLogic: string;
  sasMaxEIRP:          string;
  sasEirpCapability:   string;
  sasEnableMode:       string;
  // LTE Freq/Cell neighbor tables — only rows with Enable=true on the device
  // are included (an unconfigured slot 1-8 simply isn't in this array at all).
  neighborFreqTable: NeighborFreqEntry[];
  neighborCellTable: NeighborCellEntry[];
  // MME Pool table (PLMN + MME IP pairs) — only populated slots (PLMNID not
  // the device's blank sentinel "000000") are included, up to 16 rows.
  mmePoolTable: MmePoolEntry[];
  // MME Pool Config (X_COM_MmePool) — a DIFFERENT, singleton object: binds
  // an MME pool LIST to a named IPsec tunnel. Not the same feature as
  // mmePoolTable above despite the similar name.
  mmePoolConfig: MmePoolConfig;
}

export interface MmePoolConfig {
  enable: string;      // 'true' | 'false'
  pool1List: string;   // '' means unset (device's own blank sentinel "|")
  pool2List: string;
  ipsecTunnelMap: string; // e.g. "tunnel1:LTE_POOL_MME_LIST1"
  pool1Status: string;    // device-reported, read-only
  pool2Status: string;    // device-reported, read-only
}

// MME Pool table — up to 16 rows, each bound to one of the radio's
// MmePoolConfigParam.{index} instances. The same PLMN+MME-IP pair can never
// appear in two rows at once (enforced server-side) — the same PLMN with a
// different MME IP is a legitimate multi-MME pool and is allowed.
export interface MmePoolEntry {
  index: number; // 1-16
  plmn: string;
  mmeIp: string;
  mmeStatus: string; // device-reported, read-only — not sent back on save
}

// Cell Neighbor Freq Table — up to 8 rows, each bound to one of the radio's
// 8 InterFreq.Carrier.{index} instances. `index` is which of the 8 device
// slots this row occupies — assigned once (on load, or on Add) and never
// changed by editing the row's other fields.
export interface NeighborFreqEntry {
  index: number; // 1-8
  earfcn: string;
  qRxLevMin: string;
  qOffsetRange: string;
  reselectionTimer: string;
  reselectionPrior: string;
  reselectionThreshHigh: string;
  reselectionThreshLow: string;
  pMax: string;
}

// Cell Neighbor Cell Table — up to 8 rows, each bound to one of the radio's
// 8 NeighborList.LTECell.{index} instances.
export interface NeighborCellEntry {
  index: number; // 1-8
  plmn: string;
  cellId: string;
  earfcn: string;
  pci: string;
  qOffset: string;
  cio: string;
  tac: string;
  enbType: string; // enum — only confirmed mapping so far: 1 = Home
  x2Flag: string;  // enum — only confirmed mapping so far: 0 = SON
}

export interface ProvisionInput {
  mcc: string; mnc: string; tac: number; mmeIp: string;
  bandwidthMhz: number; earfcn: number; cellId: number; pci: number; band: number;
  txPower: number;
  // SAS
  sasEnableMode:              string;
  sasServerUrl:               string;
  sasUserId:                  string;
  sasFccId:                   string;
  sasCallSign:                string;
  sasGroupType:               string;
  sasGroupId:                 string;
  sasLegacyMode:              boolean;
  sasRegistrationType:        string;
  sasReqLowFrequency:         string;
  sasReqHighFrequency:        string;
  sasPreferredFrequency:      string;
  sasPreferredBandwidth:      string;
  sasPreferredPower:          string;
  sasFrequencySelectionLogic: string;
  sasMaxEIRP:                 string;
  sasEirpCapability:          string;
}

export interface SercommRadio {
  id:            string;
  serial:        string;
  lastInform:    string | null;
  rfStatus:      'on' | 'off' | 'offline';
  plmnMismatch:  boolean;
  ip:            string;
  mcc:           string;
  mnc:           string;
  tac:           string;
  mmeIp:         string;
  mmeCfgIdList:  string;
  earfcn:        string;
  earfcn2:       string;
  bandwidth:     string;
  pci:           string;
  band:          string;
  cellIdentity:  string;
  cellIdentity2: string;
  txPower:       string;
  syncSource:    string;
  caEnable:      string;
  cellNumber:    string;
  contiguousCC:  string;
  sasEnable:     string;
  sasLocation:   string;
  sasUserId:     string;
  icgGroupId:    string;
  latitude:      string;
  longitude:     string;
  enable256QAM:  string;
  s1Status:      string;
  ueCount:       string;
}

export interface SercommProvisionInput {
  mcc: string; mnc: string; tac: string;
  mmeIp: string; mmeCfgIdList: string;
  earfcn: string; earfcn2: string;
  pci: string;
  cellIdentity: string; cellIdentity2: string;
  txPower: string;
  bandwidth: string;
  freqBand: string;
  syncSource: string;
  carrierNumber: string;
  caEnable: boolean;
  contiguousCC: boolean;
  sasEnable: boolean;
  sasMethod: string;
  sasManufacturerPrefix: boolean;
  sasInstallMethod: string;
  sasCpiEnable: boolean;
  sasCategory: string;
  sasChannelType: string;
  sasLocation: string;
  sasLocationSource: string;
  sasHeightType: string;
  sasUserId: string;
  sasIcgGroupId: string;
  sasPeerCertVerify: boolean;
  sasGrantMethod: string;
  sasServerUrl?: string;
  latitude: string;
  longitude: string;
  enable256QAM: boolean;
}

export interface NbiTask {
  url:  string;
  body: Record<string, any>;
}

export interface RadioBackup {
  filename: string;
  deviceId: string;
}

export const genieacsApi = {
  getDevices: async (): Promise<BaicellsRadio[]> => {
    const { data } = await api.get('/devices');
    return data.devices;
  },

  getSercommDevices: async (): Promise<SercommRadio[]> => {
    const { data } = await api.get('/devices/sercomm');
    return data.devices;
  },

  preview: async (deviceId: string, input: ProvisionInput): Promise<{ deviceId: string; tasks: NbiTask[] }> => {
    const { data } = await api.post(`/preview/${encodeURIComponent(deviceId)}`, input);
    return data;
  },

  previewSercomm: async (deviceId: string, input: SercommProvisionInput): Promise<{ deviceId: string; tasks: NbiTask[] }> => {
    const { data } = await api.post(`/preview-sercomm/${encodeURIComponent(deviceId)}`, input);
    return data;
  },

  executeTasks: async (deviceId: string, tasks: NbiTask[]): Promise<{ success: boolean; results: any[] }> => {
    const { data } = await api.post('/execute-tasks', { deviceId, tasks });
    return data;
  },

  forceRefresh: async (deviceId: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post(`/refresh/${encodeURIComponent(deviceId)}`);
    return data;
  },

  refreshSercomm: async (deviceId: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post(`/refresh-sercomm/${encodeURIComponent(deviceId)}`);
    return data;
  },

  reboot: async (deviceId: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post(`/reboot/${encodeURIComponent(deviceId)}`);
    return data;
  },

  saveMmePool: async (
    deviceId: string,
    entries: MmePoolEntry[],
    originalEntries: MmePoolEntry[],
  ): Promise<{ success: boolean; results: Array<{ index: number; ok: boolean; error?: string; skipped?: boolean }> }> => {
    const { data } = await api.post(`/mme-pool/${encodeURIComponent(deviceId)}`, { entries, originalEntries });
    return data;
  },

  saveMmePoolConfig: async (deviceId: string, cfg: MmePoolConfig): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post(`/mme-pool-config/${encodeURIComponent(deviceId)}`, cfg);
    return data;
  },

  rebootAll: async (): Promise<{ success: boolean; rebooted: number; failures: string[] }> => {
    const { data } = await api.post('/reboot-all');
    return data;
  },

  setRf: async (deviceId: string, enable: boolean): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post(`/rf/${encodeURIComponent(deviceId)}`, { enable });
    return data;
  },

  setRfSercomm: async (deviceId: string, enable: boolean): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post(`/rf-sercomm/${encodeURIComponent(deviceId)}`, { enable });
    return data;
  },

  setRfAll: async (enable: boolean): Promise<{ success: boolean; affected: number; failures: string[] }> => {
    const { data } = await api.post('/rf-all', { enable });
    return data;
  },

  setRfSercommAll: async (enable: boolean): Promise<{ success: boolean; affected: number; failures: string[] }> => {
    const { data } = await api.post('/rf-sercomm-all', { enable });
    return data;
  },

  listBackups: async (deviceId: string): Promise<RadioBackup[]> => {
    const { data } = await api.get(`/backups/${encodeURIComponent(deviceId)}`);
    return data.backups;
  },

  triggerBackup: async (deviceId: string): Promise<{ success: boolean; filename: string }> => {
    const { data } = await api.post(`/backup/${encodeURIComponent(deviceId)}`);
    return data;
  },

  getBackupDownloadUrl: (deviceId: string, filename: string): string => {
    return `${API_URL}/api/genieacs/backups/${encodeURIComponent(deviceId)}/${encodeURIComponent(filename)}`;
  },
};
