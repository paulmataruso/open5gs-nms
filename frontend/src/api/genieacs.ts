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
  ip:            string;
  mcc:           string;
  mnc:           string;
  tac:           string;
  mmeIp:         string;
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
}

export interface SercommProvisionInput {
  mcc: string; mnc: string; tac: string;
  mmeIp: string;
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
  sasServerUrl?: string;
  latitude: string;
  longitude: string;
  cipheringAlgorithmList:  string;
  integrityAlgorithmList:  string;
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
