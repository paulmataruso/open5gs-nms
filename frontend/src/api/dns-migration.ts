import axios from 'axios';

const api = axios.create({ baseURL: '/api/dns-migration', withCredentials: true });

export interface DnsEntry { fqdn: string; ip: string; zone: '5gc' | 'epc'; }
export interface SbiChange { service: string; field: string; oldUri: string; newUri: string; }
export interface FreeDiameterPeerChange { peer: string; identityOld: string; identityNew: string; droppedConnectTo: string | null; }
export interface FreeDiameterChange {
  file: string;
  identityOld: string; identityNew: string;
  realmOld: string; realmNew: string;
  peers: FreeDiameterPeerChange[];
}

export interface AdvertiseChange { service: string; oldAdvertise: string | null; newAdvertise: string; }

export interface DnsMigrationPlan {
  mcc: string; mnc: string;
  sgcDomain: string; epcDomain: string;
  dnsEntries: DnsEntry[];
  freeDiameterChanges: FreeDiameterChange[];
  sbiChanges: SbiChange[];
  advertiseChanges: AdvertiseChange[];
  warnings: string[];
}

export interface PhaseResult {
  phase: 'A' | 'B' | 'C';
  success: boolean;
  details: string[];
  error?: string;
}

export interface MigrationBackupInfo {
  backupId: string;
  configBackupDir: string;
  freeDiameterFiles: string[];
  bindFiles: string[];
}

export interface MigrationBackupListItem {
  id: string;
  createdAt: string;
}

export const dnsMigrationApi = {
  getStatus: async (): Promise<{ migrated: boolean }> => {
    const { data } = await api.get('/status');
    return { migrated: data.migrated };
  },
  getPlan: async (): Promise<DnsMigrationPlan> => {
    const { data } = await api.get('/plan');
    return data.plan;
  },
  listBackups: async (): Promise<MigrationBackupListItem[]> => {
    const { data } = await api.get('/backups');
    return data.backups;
  },
  createBackup: async (): Promise<MigrationBackupInfo> => {
    const { data } = await api.post('/backup');
    return data;
  },
  applyPhase: async (phase: 'a' | 'b' | 'c'): Promise<PhaseResult> => {
    const { data } = await api.post(`/apply/${phase}`);
    return data.result;
  },
  rollback: async (backupId: string): Promise<PhaseResult> => {
    const { data } = await api.post(`/rollback/${backupId}`);
    return data.result;
  },
};
