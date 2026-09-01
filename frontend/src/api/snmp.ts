import axios from 'axios';
const API = import.meta.env.VITE_API_URL || '/api';

export interface SnmpStatus { installed: boolean; active: boolean; enabled: boolean; port: number; mibInstalled: boolean }
export interface SnmpInterface { name: string; state: string; mtu: number; rxBytes: number; txBytes: number }
export interface SnmpStats { cpuPercent: number; memoryPercent: number; ue4g: number; ue5g: number; enb: number; gnb: number; interfaces: SnmpInterface[] }

export const snmpApi = {
  status: () => axios.get<SnmpStatus>(`${API}/snmp/status`).then(r => r.data),
  stats: () => axios.get<SnmpStats>(`${API}/snmp/stats`).then(r => r.data),
  install: (community: string, network: string) => axios.post(`${API}/snmp/install`, { community, network }).then(r => r.data),
  action: (action: 'start'|'stop'|'restart') => axios.post(`${API}/snmp/${action}`).then(r => r.data),
  mibUrl: `${API}/snmp/mib`,
};
