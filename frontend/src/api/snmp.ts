import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';
const api = axios.create({ baseURL: `${API_URL}/api/snmp`, withCredentials: true });

export interface SnmpStatus { installed: boolean; active: boolean; enabled: boolean; port: number; mibInstalled: boolean }
export interface SnmpInterface { name: string; state: string; mtu: number; rxBytes: number; txBytes: number }
export interface SnmpStats { cpuPercent: number; memoryPercent: number; ue4g: number; ue5g: number; enb: number; gnb: number; interfaces: SnmpInterface[] }

export const snmpApi = {
  status: () => api.get<SnmpStatus>('/status').then(r => r.data),
  stats: () => api.get<SnmpStats>('/stats').then(r => r.data),
  install: (community: string, network: string) => api.post('/install', { community, network }).then(r => r.data),
  action: (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable') => api.post(`/${action}`).then(r => r.data),
  mibUrl: `${API_URL}/api/snmp/mib`,
};
