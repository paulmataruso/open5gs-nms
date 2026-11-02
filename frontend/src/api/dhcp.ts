import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '';
const api = axios.create({ baseURL: `${API_URL}/api/dhcp`, withCredentials: true });

export interface DhcpPool { start: string; end: string }

export interface DhcpReservation {
  /** Lower-case, colon-separated. The backend normalises dashes and dots. */
  mac: string;
  ip: string;
  hostname?: string;
}

export interface DhcpSubnet {
  id: number;
  subnet: string;
  pools: DhcpPool[];
  routers: string[];
  dnsServers: string[];
  domainName?: string;
  leaseLifetime: number;
  reservations: DhcpReservation[];
  /** Pins the subnet to one local interface — directly connected clients only. */
  iface?: string;
  /**
   * Relay agent addresses that select this subnet. Normally unnecessary: Kea
   * selects a relayed subnet from the relay's own giaddr, so a relay that is
   * the remote subnet's gateway needs nothing here.
   */
  relayIps?: string[];
}

export interface DhcpConfig {
  interfaces: string[];
  subnets: DhcpSubnet[];
  defaultLeaseLifetime: number;
  reservationsOnly: boolean;
}

export interface DhcpInterface {
  name: string;
  cidr: string | null;
  isDummy: boolean;
  isLoopback: boolean;
  /** Advisory notes — shown, but do not prevent selection. */
  warnings: string[];
  /**
   * Notes that only matter if a configured subnet leases out of this
   * interface's OWN range (a /30 with one leasable address, say). Binding a
   * narrow transit interface purely to receive relayed requests is normal, so
   * these are shown only when a subnet actually covers this interface.
   */
  localPoolWarnings: string[];
  /** Selection is refused: a UE tunnel, loopback, or no IPv4 address. */
  blocked: boolean;
}

export interface DhcpStatus {
  success: boolean;
  installed: boolean;
  configured: boolean;
  running: boolean;
  enabled: boolean;
  version: string | null;
  interfaces: string[];
  subnetCount: number;
  reservationCount: number;
  /** Non-Kea processes already holding UDP/67 — the usual reason Kea won't start. */
  conflictingListeners: string[];
}

export interface DhcpLease {
  ip: string;
  mac: string;
  hostname: string | null;
  expiresAt: number;
  expiresInSeconds: number;
  subnetId: number;
  state: 'active' | 'declined' | 'expired' | 'released';
  reserved: boolean;
}

export interface DhcpSaveResult {
  success: boolean;
  config: DhcpConfig;
  /** Non-blocking advice; the config was still saved. */
  warnings: string[];
  reloaded: boolean;
  running: boolean;
}

export const DHCP_DEFAULT_LEASE_LIFETIME = 3600;

export const dhcpApi = {
  status: () => api.get<DhcpStatus>('/status').then(r => r.data),
  interfaces: () => api.get<DhcpInterface[]>('/interfaces').then(r => r.data),
  getConfig: () => api.get<{ success: boolean; config: DhcpConfig; exists: boolean }>('/config').then(r => r.data),
  saveConfig: (config: DhcpConfig) => api.put<DhcpSaveResult>('/config', { config }).then(r => r.data),
  leases: () => api.get<{ success: boolean; leases: DhcpLease[]; activeCount: number; leaseFileExists: boolean }>('/leases').then(r => r.data),
  action: (action: 'start' | 'stop' | 'restart') => api.post(`/${action}`).then(r => r.data),
  /** Streamed — consume with fetch, not axios, so output arrives live. */
  installUrl: `${API_URL}/api/dhcp/install`,
};
