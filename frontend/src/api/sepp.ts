import axios from 'axios';

const api = axios.create({ baseURL: '/api/sepp', withCredentials: true });

export const seppApi = {
  generateCerts: async (fqdn: string): Promise<{ success: boolean; cert?: string; error?: string }> => {
    const { data } = await api.post('/generate-certs', { fqdn });
    return data;
  },
  getCert: async (): Promise<{ success: boolean; exists: boolean; cert?: string }> => {
    const { data } = await api.get('/cert');
    return data;
  },
  savePeerCert: async (cert: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post('/peer-cert', { cert });
    return data;
  },
  getPeerCert: async (): Promise<{ success: boolean; exists: boolean; cert?: string }> => {
    const { data } = await api.get('/peer-cert');
    return data;
  },
};
