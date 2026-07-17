import axios from 'axios';

const api = axios.create({ baseURL: '/api/esim', withCredentials: true });

export interface SimlesslyGenerateAcResult {
  success: boolean;
  code: string;
  msg: string;
  obj?: {
    iccid: string;
    activationCode?: string;
    acLink?: string;
  };
}

export const esimApi = {
  generate: async (body: Record<string, unknown>): Promise<SimlesslyGenerateAcResult> => {
    const { data } = await api.post('/generate', body);
    return data.result;
  },
};
