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
};
