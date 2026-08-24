import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api/apn-profiles`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

export interface ApnProfileQos {
  index: number;
  arp: { priority_level: number; pre_emption_capability: number; pre_emption_vulnerability: number };
}

export interface ApnProfile {
  id: string;
  dnn: string;
  dev: string;
  subnet: string;
  gateway: string;
  subnetV6?: string;
  gatewayV6?: string;
  qos: ApnProfileQos;
  staticRangeStart: string | null;
  staticRangeEnd: string | null;
  dynamicRangeStart: string | null;
  dynamicRangeEnd: string | null;
  createdAt: string;
  updatedAt: string;
  persisted: true;
}

export interface DerivedApnProfile {
  persisted: false;
  dnn: string;
  dev: string;
  subnet: string;
  gateway: string | null;
}

export type ApnProfileListEntry = ApnProfile | DerivedApnProfile;

export interface ApnProfileInput {
  dnn: string;
  dev: string;
  subnet: string;
  gateway: string;
  subnetV6?: string;
  gatewayV6?: string;
  qos: ApnProfileQos;
  staticRangeStart: string | null;
  staticRangeEnd: string | null;
  dynamicRangeStart: string | null;
  dynamicRangeEnd: string | null;
}

export const apnProfilesApi = {
  list: async (): Promise<ApnProfileListEntry[]> => {
    const { data } = await api.get('/');
    return data.profiles;
  },
  create: async (input: ApnProfileInput): Promise<ApnProfile> => {
    const { data } = await api.post('/', input);
    return data.profile;
  },
  update: async (id: string, input: ApnProfileInput): Promise<ApnProfile> => {
    const { data } = await api.put(`/${id}`, input);
    return data.profile;
  },
  remove: async (id: string): Promise<void> => {
    await api.delete(`/${id}`);
  },
  promote: async (dnn: string): Promise<ApnProfile> => {
    const { data } = await api.post(`/${encodeURIComponent(dnn)}/promote`);
    return data.profile;
  },
};
