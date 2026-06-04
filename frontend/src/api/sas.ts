import axios from 'axios';

const api = axios.create({ baseURL: '/api/sas', withCredentials: true });

export const sasApi = {
  getStats: async () => {
    const { data } = await api.get('/admin/stats');
    return data;
  },
  getCbsds: async () => {
    const { data } = await api.get('/admin/cbsds');
    return data;
  },
  getConfig: async () => {
    const { data } = await api.get('/admin/config');
    return data.config;
  },
  deleteGrant: async (grantId: string) => {
    const { data } = await api.delete(`/admin/grants/${grantId}`);
    return data;
  },
  deleteCbsd: async (cbsdId: string) => {
    const { data } = await api.delete(`/admin/cbsds/${cbsdId}`);
    return data;
  },
  getLogs: async (lines = 200) => {
    const { data } = await api.get(`/admin/logs?lines=${lines}`);
    return data.logs as string;
  },
  updateConfig: async (patch: Record<string, any>) => {
    const { data } = await api.put('/admin/config', patch);
    return data.config;
  },
  getSlots: async () => {
    const { data } = await api.get('/admin/slots');
    return data as {
      bands: Array<{
        bandLow: number; bandHigh: number; label: string; slotWidthHz: number;
        bandId: string; assignedGroupIds: string[];
        slots: Array<{ low: number; high: number; earfcn: number; cbsdId?: string; serial?: string; fccId?: string; state?: string; groupId?: string }>;
      }>;
      bandLow: number; bandHigh: number; slotWidthHz: number;
      slots: Array<{ low: number; high: number; earfcn: number; cbsdId?: string; serial?: string; fccId?: string; state?: string }>;
    };
  },
  reset: async () => {
    const { data } = await api.post('/admin/reset');
    return data as { success: boolean; deletedGrants: number; deletedCbsds: number };
  },
  pause: async () => { const { data } = await api.post('/admin/pause');  return data; },
  resume: async () => { const { data } = await api.post('/admin/resume'); return data; },
  getStatus: async () => { const { data } = await api.get('/admin/status'); return data as { paused: boolean }; },
  getCert: async () => { const { data } = await api.get('/admin/cert'); return data as { exists: boolean; size?: number; modified?: string; message?: string }; },
  getVerbose: async () => { const { data } = await api.get('/admin/verbose'); return data as { verbose: boolean }; },
  setVerbose: async (verbose: boolean) => { const { data } = await api.post('/admin/verbose', { verbose }); return data as { verbose: boolean }; },
  getLastRequests: async () => { const { data } = await api.get('/admin/last-requests'); return data.requests as Array<{ cbsdId: string; serial: string; fccId: string; ip: string; lowFrequency: number; highFrequency: number; type: string; ts: string }>; },

  // ── Band Policy ──────────────────────────────────────────────────────────────
  listGroupPolicies:  async () => { const { data } = await api.get('/admin/policies/groups');  return data.policies as Array<{ _id: string; bandId: string; notes?: string; customSlots?: Array<{low:number;high:number;label?:string}>; updatedAt: string }>; },
  setGroupPolicy:     async (groupId: string, bandId: string, notes?: string, customSlots?: Array<{low:number;high:number;label?:string}>) => { const { data } = await api.put(`/admin/policies/groups/${encodeURIComponent(groupId)}`, { bandId, notes, customSlots }); return data.policy; },
  deleteGroupPolicy:  async (groupId: string) => { const { data } = await api.delete(`/admin/policies/groups/${encodeURIComponent(groupId)}`); return data; },
  listCbsdPolicies:   async () => { const { data } = await api.get('/admin/policies/cbsds');   return data.policies as Array<{ _id: string; fccId: string; serial: string; bandId: string; notes?: string; updatedAt: string }>; },
  setCbsdPolicy:      async (fccId: string, serial: string, bandId: string, notes?: string) => { const { data } = await api.put(`/admin/policies/cbsds/${encodeURIComponent(fccId)}/${encodeURIComponent(serial)}`, { bandId, notes }); return data.policy; },
  deleteCbsdPolicy:   async (fccId: string, serial: string) => { const { data } = await api.delete(`/admin/policies/cbsds/${encodeURIComponent(fccId)}/${encodeURIComponent(serial)}`); return data; },
};
