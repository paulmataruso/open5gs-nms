import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' },
});

export interface BackupListItem {
  name: string;
  timestamp: string;
  type: 'config' | 'mongodb';
}

export interface BackupSettings {
  configBackupsToKeep: number;
  mongoBackupsToKeep: number;
}

export interface CreateBackupResponse {
  success: boolean;
  backupName: string;
  error?: string;
}

export interface RestoreBackupResponse {
  success: boolean;
  error?: string;
}

export interface RestoreBothResponse {
  success: boolean;
  errors: string[];
}

export interface BackupListResponse {
  mongoBackups: BackupListItem[];
  configBackups: BackupListItem[];
}

export interface ConfigDiffFile {
  current: string;
  backup: string;
  hasDiff: boolean;
}

export interface ConfigDiffResponse {
  success: boolean;
  files?: Record<string, ConfigDiffFile>;
  error?: string;
}

export interface SelectiveRestoreResponse {
  success: boolean;
  restored: string[];
  errors: Record<string, string>;
}

export const backupApi = {
  createMongoBackup: async (): Promise<CreateBackupResponse> => {
    const { data } = await api.post<CreateBackupResponse>('/backup/mongo');
    return data;
  },

  createConfigBackup: async (): Promise<CreateBackupResponse> => {
    const { data } = await api.post<CreateBackupResponse>('/backup/config');
    return data;
  },

  restoreMongoBackup: async (backupName: string): Promise<RestoreBackupResponse> => {
    const { data } = await api.post<RestoreBackupResponse>('/backup/restore/mongo', { backupName });
    return data;
  },

  restoreConfigBackup: async (backupName: string): Promise<RestoreBackupResponse> => {
    const { data } = await api.post<RestoreBackupResponse>('/backup/restore/config', { backupName });
    return data;
  },

  restoreBoth: async (configBackupName: string, mongoBackupName: string): Promise<RestoreBothResponse> => {
    const { data } = await api.post<RestoreBothResponse>('/backup/restore/both', {
      configBackupName,
      mongoBackupName,
    });
    return data;
  },

  listBackups: async (): Promise<BackupListResponse> => {
    const { data } = await api.get<BackupListResponse>('/backup/list');
    return data;
  },

  getSettings: async (): Promise<BackupSettings> => {
    const { data } = await api.get<BackupSettings>('/backup/settings');
    return data;
  },

  updateSettings: async (settings: BackupSettings): Promise<BackupSettings> => {
    const { data } = await api.put<BackupSettings>('/backup/settings', settings);
    return data;
  },

  cleanup: async (settings: BackupSettings): Promise<{ success: boolean }> => {
    const { data } = await api.post<{ success: boolean }>('/backup/cleanup', settings);
    return data;
  },

  getLastConfigBackup: async (): Promise<{ backupName: string | null }> => {
    const { data } = await api.get<{ backupName: string | null }>('/backup/last-config');
    return data;
  },

  getConfigDiff: async (backupName: string): Promise<ConfigDiffResponse> => {
    const { data } = await api.post<ConfigDiffResponse>('/backup/diff', { backupName });
    return data;
  },

  restoreSelectedConfigs: async (backupName: string, services: string[]): Promise<SelectiveRestoreResponse> => {
    const { data } = await api.post<SelectiveRestoreResponse>('/backup/restore/selective', {
      backupName,
      services,
    });
    return data;
  },
};
