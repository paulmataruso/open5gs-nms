import axios from 'axios';

const api = axios.create({ baseURL: '/api/modules', withCredentials: true });

// Mirrors backend/src/application/use-cases/module-fixall-usecase.ts's exported
// types — duplicated here rather than shared, matching this codebase's existing
// frontend/backend type-duplication convention (no shared-types package exists).
export type ModuleId = 'ims' | 'mms' | 'vectorcoreSmsc' | 'pstn' | 'vowifi' | 'secgw' | 'twamp';

export interface ModuleStaleStatus {
  moduleId: ModuleId;
  label: string;
  installStale: boolean;
  configStale: boolean;
  installedWithVersion?: string;
  configuredWithVersion?: string | number;
  canAutoFix: boolean;
  blockedReason?: string;
}

export interface FixAllModuleResult {
  moduleId: ModuleId;
  ranInstall: boolean;
  ranConfigure: boolean;
  installSuccess?: boolean;
  configureSuccess?: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  log: string[];
}

export interface FixAllRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  startedAt?: string;
  completedAt?: string;
  currentModule?: ModuleId;
  results: FixAllModuleResult[];
}

export const modulesApi = {
  getStaleStatus: async (): Promise<ModuleStaleStatus[]> => {
    const { data } = await api.get('/stale-status');
    return data.modules;
  },
  fixAll: async (): Promise<void> => {
    await api.post('/fix-all');
  },
  getFixAllStatus: async (): Promise<FixAllRunState> => {
    const { data } = await api.get('/fix-all/status');
    return data.run;
  },
};
