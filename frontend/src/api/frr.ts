import axios from 'axios';

const api = axios.create({ baseURL: '/api/frr', withCredentials: true });

export const frrApi = {
  detect:     async () => { const { data } = await api.get('/detect');      return data; },
  interfaces: async () => { const { data } = await api.get('/interfaces');  return data; },
  getState:   async () => { const { data } = await api.get('/state');       return data.state; },
  resetState: async () => { const { data } = await api.post('/state/reset'); return data.state; },
  previewConfig: async () => { const { data } = await api.get('/preview-config'); return data.config as string; },

  configure: async (payload: {
    mgmtInterface: string; transitInterface: string; transitCidr: string;
    servicePlaneInterface: string; serviceMappings: Array<{ service: string; ip: string; dummyName: string }>;
    protocol: string; protocolConfig: Record<string, any>;
  }) => { const { data } = await api.post('/migration/configure', payload); return data; },

  backup:           async () => { const { data } = await api.post('/migration/backup');            return data; },
  validateNeighbor: async () => { const { data } = await api.post('/migration/validate-neighbor'); return data; },
  createDummies:    async () => { const { data } = await api.post('/migration/dummies');           return data; },
  advertise:        async () => { const { data } = await api.post('/migration/advertise');         return data; },
  confirm:          async () => { const { data } = await api.post('/migration/confirm');           return data; },

  rewind: async (phase: string) => { const { data } = await api.post('/migration/rewind', { phase }); return data; },
  saveFilters: async (filters: any[]) => { const { data } = await api.post('/route-filters', { filters }); return data; },
  rollbackFilters: async () => { const { data } = await api.post('/route-filters/rollback'); return data; },
  previewFilters: async (filters: any[]) => { const { data } = await api.post('/route-filters/preview', { filters }); return data; },
  parseRunningConfig: async () => { const { data } = await api.get('/parse-running-config'); return data.parsed; },
  reconfigure: (body: Record<string, any>) => fetch('/api/frr/reconfigure', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  installFrr: () => fetch('/api/frr/migration/install-frr', { method: 'POST', credentials: 'include' }),
  transit:    () => fetch('/api/frr/migration/transit',     { method: 'POST', credentials: 'include' }),
  neighbor:   () => fetch('/api/frr/migration/neighbor',    { method: 'POST', credentials: 'include' }),
  cutover:    () => fetch('/api/frr/migration/cutover',     { method: 'POST', credentials: 'include' }),
  rollback:   () => fetch('/api/frr/migration/rollback',    { method: 'POST', credentials: 'include' }),

  // Standalone dummy interface management
  listDummies:   async () => { const { data } = await api.get('/dummy-interfaces');             return data as { success: boolean; interfaces: DummyInterface[] }; },
  createDummy:   async (body: { name: string; ip: string; prefix: number; advertise?: boolean }) => { const { data } = await api.post('/dummy-interfaces', body); return data as { success: boolean; name: string; ip: string; prefix: number; addedToFrr: boolean }; },
  deleteDummy:   async (name: string) => { const { data } = await api.delete(`/dummy-interfaces/${name}`); return data; },

  discoverUeSubnets: async (): Promise<{ subnets: UeSubnet[]; stored: UeSubnet[] }> => {
    const { data } = await api.get('/ue-subnets');
    return data;
  },
  applyUeSubnets: (subnets: UeSubnet[]) => fetch('/api/frr/ue-subnets/apply', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subnets }),
  }),
  rollbackUeSubnets: () => fetch('/api/frr/ue-subnets/rollback', {
    method: 'POST', credentials: 'include',
  }),

  setLogLevel: async (level: FrrLogLevel) => { const { data } = await api.post('/log-level', { level }); return data; },
};

// Mirrors backend/src/interfaces/rest/frr-controller.ts FRR_LOG_LEVELS.
export const FRR_LOG_LEVELS = [
  'emergencies', 'alerts', 'critical', 'errors',
  'warnings', 'notifications', 'informational', 'debugging',
] as const;
export type FrrLogLevel = typeof FRR_LOG_LEVELS[number];

const sourceBuildApi = axios.create({ baseURL: '/api/frr/source-build', withCredentials: true });

export interface FrrBuildState {
  status: 'idle' | 'preparing' | 'building_libyang' | 'building_frr' | 'swapping'
    | 'starting_service' | 'verifying' | 'complete' | 'failed' | 'rolled_back';
  currentStepLabel: string;
  targetTag: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  backupPath: string | null;
  snapshotPath: string | null;
  log: string;
  defaultTargetTag: string;
}

export const frrSourceBuildApi = {
  getStatus: async (): Promise<FrrBuildState> => { const { data } = await sourceBuildApi.get('/status'); return data; },
  getLog:    async (): Promise<string> => { const { data } = await sourceBuildApi.get('/log', { responseType: 'text' }); return data; },
  streamLog: () => fetch('/api/frr/source-build/log/stream', { credentials: 'include' }),
  backup:    async () => { const { data } = await sourceBuildApi.post('/backup'); return data; },
  start:     async (targetTag: string) => { const { data } = await sourceBuildApi.post('/start', { targetTag }); return data; },
  rollback:  async () => { const { data } = await sourceBuildApi.post('/rollback'); return data; },
  resetState: async () => { const { data } = await sourceBuildApi.post('/state/reset'); return data; },
};

export interface DummyInterface {
  name: string;
  state: 'up' | 'down';
  managed: boolean;
  addrs: { ip: string; prefix: number }[];
}

export interface UeSubnet {
  subnet: string;
  gateway?: string;
  dnn?: string;
  dev: string;
}
