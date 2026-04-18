import axios from 'axios';
import type {
  AllConfigs,
  ServiceStatus,
  Subscriber,
  SubscriberListItem,
  TopologyGraph,
  ValidationResult,
  ApplyResult,
  AuditLogEntry,
} from '../types';
import type { InterfaceStatus } from '../stores';

const API_URL = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  timeout: 60000, // 60 seconds for apply operations that restart all services
  headers: { 'Content-Type': 'application/json' },
});

// ── Config ──
export const configApi = {
  getAll: () => api.get<{ success: boolean; data: AllConfigs }>('/config').then((r) => r.data.data),
  getService: (name: string) => api.get(`/config/${name}`).then((r) => r.data.data),
  validate: (configs?: AllConfigs) =>
    api.post<{ success: boolean; data: ValidationResult }>('/config/validate', configs || {}).then((r) => r.data.data),
  apply: (configs: AllConfigs) =>
    api.post<{ success: boolean; data: ApplyResult }>('/config/apply', configs).then((r) => r.data.data),
  getTopology: () =>
    api.get<{ success: boolean; data: TopologyGraph }>('/config/topology/graph').then((r) => r.data.data),
  syncSD: (sd: string, sst?: number) =>
    api.post<{ success: boolean; data: { smf_slices: number; subscribers: number } }>('/config/sync-sd', { sd, sst }).then((r) => r.data),
};

// ── Services ──
export const serviceApi = {
  getAll: () => api.get<{ success: boolean; data: ServiceStatus[] }>('/services').then((r) => r.data.data),
  getOne: (name: string) =>
    api.get<{ success: boolean; data: ServiceStatus }>(`/services/${name}`).then((r) => r.data.data),
  action: (name: string, action: 'start' | 'stop' | 'restart' | 'enable' | 'disable') =>
    api.post<{ success: boolean; message: string }>(`/services/${name}/${action}`).then((r) => r.data),
  bulkAction: (action: 'start' | 'stop' | 'restart') =>
    api.post<{ success: boolean; message: string; results: Array<{ service: string; success: boolean }> }>(`/services/all/${action}`).then((r) => r.data),
};

// ── Subscribers ──
export const subscriberApi = {
  list: (skip = 0, limit = 50, search?: string) =>
    api
      .get<{ subscribers: SubscriberListItem[]; total: number }>('/subscribers', {
        params: { skip, limit, search },
      })
      .then((r) => r.data),
  get: (imsi: string) =>
    api.get<Subscriber>(`/subscribers/${imsi}`).then((r) => r.data),
  create: (subscriber: Subscriber) =>
    api.post('/subscribers', subscriber).then((r) => r.data),
  update: (imsi: string, subscriber: Partial<Subscriber>) =>
    api.put(`/subscribers/${imsi}`, subscriber).then((r) => r.data),
  delete: (imsi: string) =>
    api.delete(`/subscribers/${imsi}`).then((r) => r.data),
  autoAssignIPs: () =>
    api.post<{ success: boolean; data: { assigned: number; skipped: number; failed: number; ipPool: string; errors?: string[] } }>('/subscribers/auto-assign-ips').then((r) => r.data),
  getIPAssignments: () =>
    api.get<{ success: boolean; data: Array<{ imsi: string; ipv4: string }> }>('/subscribers/ip-assignments').then((r) => r.data),
};

// ── Audit ──
export const auditApi = {
  getAll: (skip = 0, limit = 100, action?: string) =>
    api
      .get<{ entries: AuditLogEntry[]; total: number }>('/audit', {
        params: { skip, limit, action },
      })
      .then((r) => r.data),
};

// ── Health ──
export const healthApi = {
  check: () => api.get('/health').then((r) => r.data),
};

// ── Interface Status ──
export const interfaceApi = {
  getStatus: () => api.get<InterfaceStatus>('/interface-status').then((r) => r.data),
};

// ── Backup & Restore ──
export const backupApi = {
  restoreDefaults: () => 
    api.post<{ success: boolean; message: string; backupCreated: string }>('/backup/restore-defaults').then((r) => r.data),
};

// ── Auto Config ──
export interface PlmnConfig {
  mcc: string;
  mnc: string;
  mme_gid?: number;  // For MME
  mme_code?: number; // For MME
  tac?: number;      // TAC for this PLMN
}

export interface AutoConfigInput {
  plmn4g: PlmnConfig[];  // Multiple PLMNs for MME
  plmn5g: PlmnConfig[];  // Multiple PLMNs for AMF
  s1mmeIP: string;
  sgwuGtpIP: string;
  amfNgapIP: string;
  upfGtpIP: string;
  sessionPoolIPv4Subnet: string;
  sessionPoolIPv4Gateway: string;
  sessionPoolIPv6Subnet: string;
  sessionPoolIPv6Gateway: string;
  configureNAT: boolean;
  natInterface?: string;
}

export interface AutoConfigResult {
  success: boolean;
  message: string;
  backupCreated?: string;
  updatedFiles: string[];
  errors?: string[];
}

export const autoConfigApi = {
  preview: (input: AutoConfigInput) =>
    api.post<{ success: boolean; message?: string; diffs: Record<string, string> }>('/auto-config/preview', input).then((r) => r.data),
  apply: (input: AutoConfigInput) =>
    api.post<AutoConfigResult>('/auto-config/apply', input).then((r) => r.data),
};
