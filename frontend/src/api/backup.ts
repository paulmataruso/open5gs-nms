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

export type BackupCategory =
  | 'subscribers'
  | 'core-configs'
  | 'suci-keys'
  | 'secgw-pki'
  | 'optional-modules'
  | 'l3-network'
  | 'dns'
  | 'genieacs'
  | 'auth'
  | 'ui-modules'
  | 'ocs-data'
  | 'radio-backups';

export interface BackupCategoryInfo {
  id: BackupCategory;
  label: string;
  description: string;
  present: boolean;
  itemCount: number;
}

export interface FullBackupUploadResponse {
  success: boolean;
  uploadId?: string;
  categories?: BackupCategoryInfo[];
  createdAt?: string;
  presentModules?: string[];
  error?: string;
}

export interface FullBackupRestoreResponse {
  success: boolean;
  restored?: BackupCategory[];
  error?: string;
}

export interface BootstrapModuleResult {
  moduleId: string;
  label: string;
  installed: boolean;
  skipped: boolean;
  error?: string;
  log: string[];
}

export interface FreshHostBootstrapRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  currentModule?: string;
  results: BootstrapModuleResult[];
}

export interface RestartStepResult {
  step: string;
  label: string;
  success: boolean;
  skipped: boolean;
  error?: string;
}

export interface BackupRestartRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  currentStep?: string;
  results: RestartStepResult[];
}

export interface FullRestoreOrchestratorState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  phase?: 'bootstrap' | 'restoring' | 'restart';
  startedAt?: string;
  completedAt?: string;
  bootstrap?: FreshHostBootstrapRunState;
  restoredCategories?: BackupCategory[];
  restoreError?: string;
  restart?: BackupRestartRunState;
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

  // Starts the bootstrap(optional)->restore->restart pipeline — returns
  // immediately, poll getFullRestoreStatus() for progress.
  startFullRestore: async (
    uploadId: string, categories: BackupCategory[], freshHostBootstrap: boolean, presentModules: string[],
  ): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post<{ success: boolean; error?: string }>('/backup/full/restore', {
      uploadId, categories, freshHostBootstrap, presentModules,
    });
    return data;
  },

  getFullRestoreStatus: async (): Promise<{ success: boolean; run: FullRestoreOrchestratorState }> => {
    const { data } = await api.get<{ success: boolean; run: FullRestoreOrchestratorState }>('/backup/full/restore/status');
    return data;
  },
};
