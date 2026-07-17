import axios from 'axios';

const api = axios.create({ baseURL: '/api/bind', withCredentials: true });

export interface BindStatus {
  success: boolean;
  installed: boolean;
  running: boolean;
  fileCount: number;
}

export interface BindFile {
  path: string;
  label: string;
}

export const bindApi = {
  getStatus: async (): Promise<BindStatus> => { const { data } = await api.get('/status'); return data; },
  install: () => fetch('/api/bind/install', { method: 'POST', credentials: 'include' }),
  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },

  getFiles: async (): Promise<{ files: BindFile[] }> => { const { data } = await api.get('/files'); return data; },
  getFileContent: async (filePath: string): Promise<{ content: string }> => {
    const { data } = await api.get('/files/content', { params: { path: filePath } });
    return data;
  },
  saveFileContent: async (filePath: string, content: string, restart: boolean): Promise<{ success: boolean }> => {
    const { data } = await api.put('/files/content', { path: filePath, content, restart });
    return data;
  },
  deleteFile: async (filePath: string): Promise<{ success: boolean }> => {
    const { data } = await api.delete('/files', { params: { path: filePath } });
    return data;
  },

  getForwarders: async (): Promise<{ forwarders: string[] }> => { const { data } = await api.get('/forwarders'); return data; },
  saveForwarders: async (forwarders: string[]): Promise<{ success: boolean }> => {
    const { data } = await api.put('/forwarders', { forwarders });
    return data;
  },
};
