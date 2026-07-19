import axios from 'axios';

const api = axios.create({ baseURL: '/api/plmn-migration', withCredentials: true });

export interface PlmnMigrationPlan {
  oldMcc: string; oldMnc: string;
  newMcc: string; newMnc: string;
  oldImsDomain: string; newImsDomain: string;
  oldPubDomain: string; newPubDomain: string;
  imsInstalled: boolean;
  smsConfigured: boolean;
  vowifiInstalled: boolean;
  warnings: string[];
}

export interface PhaseResult {
  phase: 'plan' | 'A' | 'B' | 'C' | 'D' | 'E';
  success: boolean;
  details: string[];
  error?: string;
}

export interface MigrationBackupInfo {
  backupId: string;
  configBackupDir: string;
  extraFiles: string[];
}

export interface MigrationBackupListItem {
  id: string;
  createdAt: string;
}

export type PlmnMigrationPhase = 'a' | 'b' | 'c' | 'd' | 'e';

export const plmnMigrationApi = {
  getStatus: async (): Promise<{ migrated: boolean }> => {
    const { data } = await api.get('/status');
    return { migrated: data.migrated };
  },
  getPlan: async (mcc: string, mnc: string): Promise<PlmnMigrationPlan> => {
    const { data } = await api.get('/plan', { params: { mcc, mnc } });
    return data.plan;
  },
  listBackups: async (): Promise<MigrationBackupListItem[]> => {
    const { data } = await api.get('/backups');
    return data.backups;
  },
  createBackup: async (mcc: string, mnc: string): Promise<MigrationBackupInfo & { plan: PlmnMigrationPlan }> => {
    const { data } = await api.post('/backup', { mcc, mnc });
    return data;
  },
  applyPhase: async (phase: PlmnMigrationPhase, mcc: string, mnc: string): Promise<PhaseResult> => {
    const { data } = await api.post(`/apply/${phase}`, { mcc, mnc });
    return data.result;
  },
  rollback: async (backupId: string): Promise<PhaseResult> => {
    const { data } = await api.post(`/rollback/${backupId}`);
    return data.result;
  },
};
