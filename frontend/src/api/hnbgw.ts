import axios from 'axios';

const api = axios.create({ baseURL: '/api/hnbgw', withCredentials: true });

export interface HnbgwStatus {
  success: boolean;
  installedOnDisk: boolean;
  version: string;
  configured: boolean;
  services: Record<string, boolean>;
  rncId: number;
  iuhLocalIp: string;
  iuhLocalPort: number;
  hnbgwPointCode: string;
  mscPointCode: string;
  sgsnIuPsPointCode: string;
  mgwBindIp: string;
  mgwRtpBindIp: string;
  virtualHnbInstalled: boolean;
  virtualHnbDeployed: boolean;
  // Raw `show hnb all` VTY output — parsed client-side by parseHnbList()
  // below rather than adding a second backend endpoint just for this.
  hnbListRaw: string;
}

// One registered HNB, parsed from `show hnb all`'s real text format
// (confirmed live 2026-09-13 against the real running osmo-hnbgw):
//   HNB (r=<remote-ip>:<remote-port><->l=<local-ip>:<local-port>) "<identity>"
//       MCC <mcc> MNC <mnc> LAC <lac> RAC <rac> SAC <sac> CID <cid> SCTP-stream:...
export interface RegisteredHnb {
  identity: string;
  remoteAddr: string;
  mcc: number; mnc: number; lac: number; rac: number; sac: number; cid: number;
}

export function parseHnbList(raw: string): RegisteredHnb[] {
  const out: RegisteredHnb[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^HNB \(r=([^<]+)<->l=[^)]+\)\s+"([^"]*)"/);
    if (!head) continue;
    const detail = (lines[i + 1] || '').match(
      /MCC\s+(\d+)\s+MNC\s+(\d+)\s+LAC\s+(\d+)\s+RAC\s+(\d+)\s+SAC\s+(\d+)\s+CID\s+(\d+)/,
    );
    if (!detail) continue;
    out.push({
      remoteAddr: head[1], identity: head[2],
      mcc: Number(detail[1]), mnc: Number(detail[2]), lac: Number(detail[3]),
      rac: Number(detail[4]), sac: Number(detail[5]), cid: Number(detail[6]),
    });
  }
  return out;
}

export const hnbgwApi = {
  getStatus: async (): Promise<HnbgwStatus> => {
    const { data } = await api.get('/status');
    return data;
  },
  install: (): Promise<Response> =>
    fetch('/api/hnbgw/install', { method: 'POST', credentials: 'include' }),
  uninstall: (): Promise<Response> =>
    fetch('/api/hnbgw/uninstall', { method: 'POST', credentials: 'include' }),
  configure: async (input: {
    rncId?: number; iuhLocalIp?: string; iuhLocalPort?: number;
    hnbgwPointCode?: string; mscPointCode?: string; sgsnIuPsPointCode?: string;
    mgwBindIp?: string; mgwRtpBindIp?: string;
  }) => {
    const { data } = await api.post('/configure', input);
    return data;
  },
  start:   async () => { const { data } = await api.post('/start');   return data; },
  stop:    async () => { const { data } = await api.post('/stop');    return data; },
  restart: async () => { const { data } = await api.post('/restart'); return data; },
  deployVirtualHnb: (): Promise<Response> =>
    fetch('/api/hnbgw/virtual-hnb/deploy', { method: 'POST', credentials: 'include' }),
  removeVirtualHnb: async () => {
    const { data } = await api.post('/virtual-hnb/remove');
    return data;
  },
};
