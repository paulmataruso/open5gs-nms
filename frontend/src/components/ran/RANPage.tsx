import { useEffect, useState, useMemo, useCallback } from 'react';
import { Radio, Activity, Users, Circle, Wifi, Network, Shield, ChevronRight, ArrowUp, ArrowDown, Pencil, Check, X, Map, Server, ArrowRight } from 'lucide-react';
import { useTopologyStore } from '../../stores';
import { radioTagsApi, configApi } from '../../api';
import { imsApi } from '../../api/ims';
import { useAuth } from '../../contexts/AuthContext';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

interface RANPageProps {
  onNavigateToSubscriber?: (imsi: string) => void;
}

interface ConnectedRadio {
  ip: string;
  numConnectedUes: number;
  setupSuccess: boolean;
  plmn?: string;
}

interface ActiveUE {
  ip: string;
  imsi: string;
  cmState?: string;
  dnn?: string;
  apn?: string;
  sliceSst?: number;
  sliceSd?: string;
  securityEnc?: string;
  securityInt?: string;
  ambrDownlink?: number;
  ambrUplink?: number;
  radioIp?: string;
  metricsOnly?: boolean;
  nickname?: string;
}

function formatAmbr(bps?: number): string {
  if (!bps) return '—';
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(1)} Gbps`;
  if (bps >= 1_000_000)     return `${(bps / 1_000_000).toFixed(0)} Mbps`;
  if (bps >= 1_000)         return `${(bps / 1_000).toFixed(0)} Kbps`;
  return `${bps} bps`;
}

// ── Inline radio tag editor ───────────────────────────────────────────────────

function RadioTagCell({ ip, nickname, isAdmin, onSave }: {
  ip: string; nickname?: string; isAdmin: boolean;
  onSave: (ip: string, nickname: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue]     = useState(nickname || '');
  const handleSave = async () => { await onSave(ip, value.trim()); setEditing(false); };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') { setValue(nickname || ''); setEditing(false); }
  };
  if (editing) {
    return (
      <div className="flex items-center gap-1 mt-0.5">
        <input autoFocus className="nms-input text-xs py-0.5 px-1.5 h-6 font-mono w-32"
          value={value} onChange={e => setValue(e.target.value)} onKeyDown={handleKeyDown}
          onBlur={handleSave} placeholder="e.g. Site A gNB" maxLength={64} />
        <button onClick={handleSave} className="text-nms-green hover:text-nms-green/80"><Check className="w-3 h-3" /></button>
        <button onClick={() => { setValue(nickname || ''); setEditing(false); }} className="text-nms-text-dim hover:text-nms-red"><X className="w-3 h-3" /></button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 mt-0.5 group/tag">
      {nickname ? <span className="text-xs text-nms-text-dim font-medium">{nickname}</span>
        : isAdmin && <span className="text-xs text-nms-text-dim/40 italic hidden group-hover/tag:inline">add nickname</span>}
      {isAdmin && (
        <button onClick={() => { setValue(nickname || ''); setEditing(true); }}
          className="opacity-0 group-hover/tag:opacity-100 transition-opacity text-nms-text-dim hover:text-nms-accent ml-0.5" title="Edit radio nickname">
          <Pencil className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ── UE sub-row ────────────────────────────────────────────────────────────────

function UESubRow({ ue, gen, onNavigate }: { ue: ActiveUE; gen: '4G' | '5G'; onNavigate?: (imsi: string) => void }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-nms-border last:border-b-0 hover:bg-nms-surface-2/40 transition-colors">
      <ChevronRight className="w-3 h-3 text-nms-text-dim flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <button onClick={() => onNavigate?.(ue.imsi)} className="text-xs font-mono text-nms-accent hover:underline text-left truncate block">{ue.imsi}</button>
        {ue.nickname && <span className="text-xs text-nms-text-dim block truncate">{ue.nickname}</span>}
      </div>
      <span className="w-28 text-xs font-mono text-nms-text text-center flex-shrink-0">{ue.ip || '—'}</span>
      <span className="w-20 text-xs font-mono text-nms-text-dim text-center flex-shrink-0 truncate">{ue.dnn || ue.apn || '—'}</span>
      <div className="w-20 flex justify-end flex-shrink-0">
        <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium',
          (ue.cmState === 'connected' || !ue.cmState) ? 'bg-nms-green/10 text-nms-green' : 'bg-nms-text-dim/10 text-nms-text-dim')}>
          <Circle className="w-1.5 h-1.5 fill-current" />{ue.cmState || 'active'}
        </span>
      </div>
      {gen === '5G' && (
        <div className="w-16 flex items-center gap-1 flex-shrink-0"
          title={!ue.securityEnc ? 'Security active — algorithm not reported by AMF for CM-Idle UEs' : undefined}>
          <Shield className={clsx('w-3 h-3 flex-shrink-0', ue.securityEnc ? 'text-nms-accent' : 'text-nms-text-dim/40')} />
          <span className={clsx('text-xs font-mono', ue.securityEnc ? 'text-nms-text-dim' : 'text-nms-text-dim/40')}>
            {ue.securityEnc?.toUpperCase() ?? '?'}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Interface card ────────────────────────────────────────────────────────────

function InterfaceCard({ icon, title, subtitle, active, radios, deviceLabel, generation, ues,
  radioTags, isAdmin, onTagSave, onNavigateToSubscriber }: {
  icon: React.ReactNode; title: string; subtitle: string; active: boolean;
  radios: ConnectedRadio[]; deviceLabel: string; generation: '4G' | '5G';
  ues: ActiveUE[]; radioTags: Record<string, string>; isAdmin: boolean;
  onTagSave: (ip: string, nickname: string) => Promise<void>;
  onNavigateToSubscriber?: (imsi: string) => void;
}): JSX.Element {
  const is5G = generation === '5G';
  const accentColor = is5G ? 'text-nms-accent' : 'text-purple-400';
  const accentBg    = is5G ? 'bg-nms-accent/10' : 'bg-purple-500/10';
  return (
    <div className="nms-card">
      <div className="flex items-center gap-3 mb-4">
        <div className={clsx('p-2 rounded-lg', active ? 'bg-nms-green/10' : 'bg-nms-red/10')}>
          <div className={active ? 'text-nms-green' : 'text-nms-red'}>{icon}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold font-display text-nms-text">{title}</h2>
            <span className={clsx('text-xs font-bold px-1.5 py-0.5 rounded', accentBg, accentColor)}>{generation}</span>
          </div>
          <p className="text-xs text-nms-text-dim">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 mb-4">
        <Circle className={clsx('w-2 h-2', active ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red')} />
        <span className={clsx('text-sm font-medium', active ? 'text-nms-green' : 'text-nms-red')}>{active ? 'Active' : 'Inactive'}</span>
        <span className="text-xs text-nms-text-dim ml-auto">{radios.length} {radios.length === 1 ? deviceLabel : `${deviceLabel}s`} connected</span>
      </div>
      {radios.length > 0 ? (
        <div className="border border-nms-border rounded-md overflow-hidden">
          <div className="bg-nms-surface-2 px-3 py-2 border-b border-nms-border grid grid-cols-3 text-xs font-semibold text-nms-text uppercase tracking-wider">
            <span>IP / Nickname</span><span className="text-center">UEs</span><span className="text-right">Status</span>
          </div>
          {radios.map((radio, idx) => {
            // Synthetic metrics-fallback radios have a non-IP placeholder string for their IP.
            // When the JSON API isn't available (Open5GS < v2.7.7), pair all metricsOnly UEs
            // with the synthetic radio rather than leaving "session details pending".
            const isSyntheticIp = !/^\d+\.\d+\.\d+\.\d+$/.test(radio.ip);
            const radioUEs = ues.filter(ue =>
              ue.radioIp === radio.ip ||
              (isSyntheticIp && (ue.metricsOnly || !ue.radioIp)),
            );
            const nickname = radioTags[radio.ip];
            return (
              <div key={idx}>
                <div className="grid grid-cols-3 items-start px-3 py-2 border-b border-nms-border hover:bg-nms-surface-2/50 transition-colors bg-nms-surface-2/20">
                  <div>
                    <span className="text-sm font-mono font-semibold text-nms-text">{radio.ip}</span>
                    <RadioTagCell ip={radio.ip} nickname={nickname} isAdmin={isAdmin} onSave={onTagSave} />
                  </div>
                  <span className="text-center text-sm font-bold text-nms-accent self-center">{radio.numConnectedUes}</span>
                  <div className="flex justify-end self-center">
                    <Circle className={clsx('w-2 h-2', radio.setupSuccess ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red')} />
                  </div>
                </div>
                {radioUEs.length > 0 && (
                  <div className="bg-nms-surface-2/10">
                    {idx === 0 && (
                      <div className="flex items-center gap-2 px-3 py-1 border-b border-nms-border/50">
                        <div className="w-3 flex-shrink-0" />
                        <span className="flex-1 text-xs text-nms-text-dim">IMSI</span>
                        <span className="w-28 text-xs text-nms-text-dim text-center flex-shrink-0">UE IP</span>
                        <span className="w-20 text-xs text-nms-text-dim text-center flex-shrink-0">DNN</span>
                        <span className="w-20 text-xs text-nms-text-dim text-right flex-shrink-0">State</span>
                        {is5G && <span className="w-16 text-xs text-nms-text-dim flex-shrink-0">Enc</span>}
                      </div>
                    )}
                    {radioUEs.map((ue, ueIdx) => <UESubRow key={ueIdx} ue={ue} gen={generation} onNavigate={onNavigateToSubscriber} />)}
                  </div>
                )}
                {radioUEs.length === 0 && radio.numConnectedUes > 0 && (
                  <div className="px-6 py-1.5 border-b border-nms-border/50 last:border-b-0">
                    <span className="text-xs text-nms-text-dim italic">{radio.numConnectedUes} UE{radio.numConnectedUes > 1 ? 's' : ''} connected (session details pending)</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-8 text-nms-text-dim text-sm space-y-2">
          <p>No {deviceLabel}s connected</p>
          <p className="text-xs text-nms-text-dim/60">If your {deviceLabel}s are connected, this feature requires Open5GS ≥ v2.7.7.</p>
        </div>
      )}
    </div>
  );
}

// ── IP Plumbing types ─────────────────────────────────────────────────────────

interface IPRow {
  ip: string; service: string; interface: string; protocol: string; port: string;
  direction: 'server' | 'client'; connects_to?: string; description: string;
  group: '4G' | '5G' | 'Shared' | 'IMS'; loopback: boolean;
}

interface ConnectionPair {
  interface: string; protocol: string; port: string;
  clientService: string; clientIP: string;
  serverService: string; serverIP: string;
  description: string; group: '4G' | '5G' | 'Shared' | 'IMS';
}

// ── buildIPTable ──────────────────────────────────────────────────────────────

function buildIPTable(configs: any): IPRow[] {
  const rows: IPRow[] = [];
  const add = (r: IPRow) => rows.push(r);
  const lo = (ip: string) => !ip || ip.startsWith('127.') || ip === 'localhost';

  const sbiServers = (svc: any): string[] =>
    (svc?.sbi?.server || []).map((s: any) => s.address).filter(Boolean);

  const sbiClients = (svc: any, key: string): string[] =>
    (svc?.sbi?.client?.[key] || []).map((e: any) => {
      if (e.uri) try { return new URL(e.uri).hostname; } catch { return ''; }
      return e.address || '';
    }).filter(Boolean);

  const metricsServers = (svc: any): string[] =>
    (svc?.metrics?.server || []).map((s: any) => s.address).filter(Boolean).filter((a: string) => a !== '');

  // ── MME ──
  const mme = configs?.mme?.mme;
  if (mme) {
    const s1ap = mme?.s1ap?.server?.[0]?.address || mme?.s1ap?.server?.[0]?.dev || '127.0.0.2';
    add({ ip: s1ap, service: 'MME', interface: 'S1-MME (S1AP)', protocol: 'SCTP', port: '36412', direction: 'server', connects_to: 'eNodeB', description: 'eNodeBs dial this to register and control UE sessions — attach, detach, handover, paging', group: '4G', loopback: lo(s1ap) });
    const gtpc = mme?.gtpc?.server?.[0]?.address || '127.0.0.2';
    add({ ip: gtpc, service: 'MME', interface: 'S11 GTPv2-C', protocol: 'UDP', port: '2123', direction: 'server', connects_to: 'SGW-C', description: 'SGW-C dials this to receive bearer setup/modify/delete instructions from the MME', group: '4G', loopback: lo(gtpc) });
    const sgsap = mme?.sgsap?.server?.[0]?.address;
    add({ ip: sgsap ?? '127.0.0.2', service: 'MME', interface: sgsap ? 'SGs-AP (SMS/CSFB)' : 'SGs-AP (not configured)', protocol: 'SCTP', port: '29118', direction: 'server', connects_to: 'MSC/VLR / SMSC', description: sgsap ? 'MSC/VLR or SMSC dials this for SMS over SGs and circuit-switched fallback (CSFB) voice — configure in mme.yaml sgsap.server' : 'Not configured — add mme.sgsap.server in mme.yaml to enable 4G SMS and CSFB via an external MSC/VLR or SMSC', group: '4G', loopback: lo(sgsap ?? '127.0.0.2') });
    const mmeHss = mme?.s6a?.server?.[0]?.address;
    if (mmeHss) add({ ip: mmeHss, service: 'MME', interface: 'S6a Diameter', protocol: 'SCTP', port: '3868', direction: 'client', connects_to: 'HSS', description: 'MME dials HSS for subscriber authentication and profile download', group: '4G', loopback: lo(mmeHss) });
    metricsServers(mme).forEach(ip => add({ ip, service: 'MME', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes MME metrics — sessions, UEs, handovers', group: '4G', loopback: lo(ip) }));
  }

  // ── HSS ──
  const hss = configs?.hss?.hss;
  if (hss) {
    const addr = hss?.freeDiameter ? '127.0.0.8' : (hss?.sbi?.server?.[0]?.address || '127.0.0.8');
    add({ ip: addr, service: 'HSS', interface: 'S6a Diameter', protocol: 'SCTP', port: '3868', direction: 'server', connects_to: 'MME', description: 'MME dials this to authenticate subscribers and download profiles (IMSI, keys, subscriptions)', group: '4G', loopback: lo(addr) });
    metricsServers(hss).forEach(ip => add({ ip, service: 'HSS', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes HSS metrics', group: '4G', loopback: lo(ip) }));
  }

  // ── PCRF ──
  const pcrf = configs?.pcrf?.pcrf;
  if (pcrf) {
    const addr = pcrf?.freeDiameter ? '127.0.0.9' : (pcrf?.sbi?.server?.[0]?.address || '127.0.0.9');
    add({ ip: addr, service: 'PCRF', interface: 'Gx/Rx Diameter', protocol: 'SCTP', port: '3868', direction: 'server', connects_to: 'PGW/SMF', description: 'PGW/SMF dials this to get and install QoS policies per UE session', group: '4G', loopback: lo(addr) });
    metricsServers(pcrf).forEach(ip => add({ ip, service: 'PCRF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes PCRF metrics', group: '4G', loopback: lo(ip) }));
  }

  // ── SGW-C ──
  const sgwc = configs?.sgwc?.sgwc;
  if (sgwc) {
    const gtpc = sgwc?.gtpc?.server?.[0]?.address || '127.0.0.3';
    add({ ip: gtpc, service: 'SGW-C', interface: 'S11 GTPv2-C', protocol: 'UDP', port: '2123', direction: 'client', connects_to: 'MME', description: 'SGW-C dials MME to exchange bearer setup signaling', group: '4G', loopback: lo(gtpc) });
    const s5c = sgwc?.s5c?.server?.[0]?.address;
    if (s5c) add({ ip: s5c, service: 'SGW-C', interface: 'S5/S8 GTPv2-C', protocol: 'UDP', port: '2123', direction: 'client', connects_to: 'PGW/SMF', description: 'SGW-C dials PGW to create/modify/delete S5 bearers', group: '4G', loopback: lo(s5c) });
    (sgwc?.pfcp?.server || []).forEach((s: any) => {
      if (!s.address) return;
      add({ ip: s.address, service: 'SGW-C', interface: 'Gxc PFCP server', protocol: 'UDP', port: '8805', direction: 'server', connects_to: 'SGW-U', description: lo(s.address) ? 'Local SGW-U dials this on startup to register and receive session rules' : 'Remote SGW-U dials this over WAN — must be routable from the remote SGW-U host', group: '4G', loopback: lo(s.address) });
    });
    (sgwc?.pfcp?.client?.sgwu || []).forEach((c: any) => {
      if (!c.address) return;
      const tag = lo(c.address) ? 'local SGW-U' : `remote SGW-U${c.apn ? ` (APN: ${c.apn})` : c.tac ? ` (TAC: ${Array.isArray(c.tac) ? c.tac.join(',') : c.tac})` : c.e_cell_id ? ` (Cell: ${Array.isArray(c.e_cell_id) ? c.e_cell_id.join(',') : c.e_cell_id})` : ''}`;
      add({ ip: c.address, service: 'SGW-C', interface: 'Gxc PFCP client', protocol: 'UDP', port: '8805', direction: 'client', connects_to: tag, description: 'SGW-C programs this SGW-U with PDR/FAR session rules for each UE bearer', group: '4G', loopback: lo(c.address) });
    });
  }

  // ── SGW-U ──
  const sgwu = configs?.sgwu?.sgwu;
  if (sgwu) {
    const pfcp = sgwu?.pfcp?.server?.[0]?.address || '127.0.0.6';
    add({ ip: pfcp, service: 'SGW-U', interface: 'Gxc PFCP server', protocol: 'UDP', port: '8805', direction: 'server', connects_to: 'SGW-C', description: 'SGW-C connects here to program GTP-U session rules for each UE bearer', group: '4G', loopback: lo(pfcp) });
    const sgwcClient = sgwu?.pfcp?.client?.sgwc?.[0]?.address;
    if (sgwcClient) add({ ip: sgwcClient, service: 'SGW-U', interface: 'Gxc PFCP client', protocol: 'UDP', port: '8805', direction: 'client', connects_to: 'SGW-C', description: 'SGW-U proactively dials SGW-C on startup and re-associates after SGW-C restarts', group: '4G', loopback: lo(sgwcClient) });
    const gtpu = sgwu?.gtpu?.server?.[0]?.address || '127.0.0.6';
    add({ ip: gtpu, service: 'SGW-U', interface: 'S1-U GTP-U server', protocol: 'UDP', port: '2152', direction: 'server', connects_to: 'eNodeB', description: 'eNodeBs send UE user data packets here encapsulated in GTP — the S1-U address configured on the eNodeB', group: '4G', loopback: lo(gtpu) });
  }

  // ── AMF ──
  const amf = configs?.amf?.amf;
  if (amf) {
    (amf?.ngap?.server || []).forEach((s: any) => {
      const ip = s.address || s.dev || '127.0.0.5';
      add({ ip, service: 'AMF', interface: 'N2 NGAP', protocol: 'SCTP', port: '38412', direction: 'server', connects_to: 'gNodeB', description: 'gNodeBs dial this to register and control 5G UE sessions — registration, PDU session, handover, paging', group: '5G', loopback: lo(ip) });
    });
    sbiServers(amf).forEach(ip => add({ ip, service: 'AMF', interface: 'SBI server (N11/N8/N12/N15)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'SMF, UDM, AUSF, PCF, NRF', description: 'AMF receives calls from SMF (N11), UDM (N8), AUSF (N12), PCF (N15) for session and policy management', group: '5G', loopback: lo(ip) }));
    sbiClients(amf, 'nrf').forEach(ip => add({ ip, service: 'AMF', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'AMF registers itself with NRF and discovers other NFs (SMF, UDM, AUSF)', group: '5G', loopback: lo(ip) }));
    sbiClients(amf, 'smf').forEach(ip => add({ ip, service: 'AMF', interface: 'SBI client → SMF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'SMF', description: 'AMF calls SMF (N11) to create/modify/release PDU sessions for UEs', group: '5G', loopback: lo(ip) }));
    sbiClients(amf, 'scp').forEach(ip => add({ ip, service: 'AMF', interface: 'SBI client → SCP', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'SCP', description: 'AMF routes SBI calls through Service Communication Proxy', group: '5G', loopback: lo(ip) }));
    metricsServers(amf).forEach(ip => add({ ip, service: 'AMF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes AMF metrics — registered gNodeBs, UE sessions, PDU sessions', group: '5G', loopback: lo(ip) }));
  }

  // ── SMF ──
  const smf = configs?.smf?.smf;
  if (smf) {
    sbiServers(smf).forEach(ip => add({ ip, service: 'SMF', interface: 'SBI server (N7/N10/N11)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'AMF, PCF, UDM, NRF', description: 'AMF calls SMF (N11) for PDU sessions; PCF calls SMF (N7) for policy; UDM calls SMF (N10) for session mgmt', group: '5G', loopback: lo(ip) }));
    sbiClients(smf, 'nrf').forEach(ip => add({ ip, service: 'SMF', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'SMF registers with NRF and discovers UPF, UDM, PCF', group: '5G', loopback: lo(ip) }));
    sbiClients(smf, 'scp').forEach(ip => add({ ip, service: 'SMF', interface: 'SBI client → SCP', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'SCP', description: 'SMF routes SBI calls through Service Communication Proxy', group: '5G', loopback: lo(ip) }));
    const smfGtpc = smf?.gtpc?.server?.[0]?.address || '127.0.0.4';
    add({ ip: smfGtpc, service: 'SMF/PGW-C', interface: 'S5/S8 GTPv2-C', protocol: 'UDP', port: '2123', direction: 'server', connects_to: 'SGW-C', description: 'SGW-C dials this to create 4G EPC bearers — SMF acts as PGW-C for combined 4G/5G deployments', group: '4G', loopback: lo(smfGtpc) });
    const smfGtpu = smf?.gtpu?.server?.[0]?.address || '127.0.0.4';
    add({ ip: smfGtpu, service: 'SMF/PGW-U', interface: 'S5/S8 GTP-U', protocol: 'UDP', port: '2152', direction: 'server', connects_to: 'SGW-U', description: 'SGW-U forwards S5/S8 GTP-U packets here — PGW-U function of the combined SMF/PGW', group: '4G', loopback: lo(smfGtpu) });
    (smf?.pfcp?.server || []).forEach((s: any) => {
      if (!s.address) return;
      add({ ip: s.address, service: 'SMF', interface: 'N4 PFCP server', protocol: 'UDP', port: '8805', direction: 'server', connects_to: 'UPF', description: lo(s.address) ? 'Local UPF registers here' : 'Remote UPF dials this over WAN — must be routable from the remote UPF host', group: '5G', loopback: lo(s.address) });
    });
    (smf?.pfcp?.client?.upf || []).forEach((c: any) => {
      if (!c.address) return;
      const tag = `${lo(c.address) ? 'local' : 'remote'} UPF${c.dnn ? ` (DNN: ${c.dnn})` : c.tac ? ` (TAC: ${Array.isArray(c.tac) ? c.tac.join(',') : c.tac})` : ''}`;
      add({ ip: c.address, service: 'SMF', interface: 'N4 PFCP client', protocol: 'UDP', port: '8805', direction: 'client', connects_to: tag, description: 'SMF programs this UPF with PDR/FAR/URR session rules for every UE PDU session', group: '5G', loopback: lo(c.address) });
    });
    metricsServers(smf).forEach(ip => add({ ip, service: 'SMF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes SMF metrics — active PDU sessions, UEs, GTP tunnels per UPF', group: '5G', loopback: lo(ip) }));
  }

  // ── UPF ──
  const upf = configs?.upf?.upf;
  if (upf) {
    const pfcp = upf?.pfcp?.server?.[0]?.address || '127.0.0.7';
    add({ ip: pfcp, service: 'UPF', interface: 'N4 PFCP server', protocol: 'UDP', port: '8805', direction: 'server', connects_to: 'SMF', description: 'SMF connects here to install PDR/FAR/URR session rules — one PFCP association per SMF', group: '5G', loopback: lo(pfcp) });
    const smfClient = upf?.pfcp?.client?.smf?.[0]?.address;
    if (smfClient) add({ ip: smfClient, service: 'UPF', interface: 'N4 PFCP client', protocol: 'UDP', port: '8805', direction: 'client', connects_to: 'SMF', description: 'UPF proactively dials SMF on startup to establish PFCP association', group: '5G', loopback: lo(smfClient) });
    (upf?.gtpu?.server || []).forEach((s: any) => {
      const ip = s.address || ''; if (!ip) return;
      add({ ip, service: 'UPF', interface: 'N3/N9/S5 GTP-U server', protocol: 'UDP', port: '2152', direction: 'server', connects_to: 'gNodeB / SGW-U / UPF', description: 'gNodeBs send N3 user data here; SGW-Us send S5/S8 data here; other UPFs send N9 data here', group: 'Shared', loopback: lo(ip) });
    });
    metricsServers(upf).forEach(ip => add({ ip, service: 'UPF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes UPF metrics — active GTP sessions, bytes in/out per DNN', group: '5G', loopback: lo(ip) }));
  }

  // ── NRF ──
  const nrf = configs?.nrf?.nrf;
  if (nrf) {
    sbiServers(nrf).forEach(ip => add({ ip, service: 'NRF', interface: 'SBI server', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'All 5G NFs', description: 'All 5G NFs register here on startup and query for NF discovery (AMF, SMF, UPF, AUSF, UDM, PCF, NSSF, BSF)', group: '5G', loopback: lo(ip) }));
    metricsServers(nrf).forEach(ip => add({ ip, service: 'NRF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes NRF metrics — registered NF instances', group: '5G', loopback: lo(ip) }));
  }

  // ── AUSF ──
  const ausf = configs?.ausf?.ausf;
  if (ausf) {
    sbiServers(ausf).forEach(ip => add({ ip, service: 'AUSF', interface: 'SBI server (N12)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'AMF', description: 'AMF calls AUSF (N12) to authenticate 5G UEs using 5G-AKA or EAP-AKA', group: '5G', loopback: lo(ip) }));
    sbiClients(ausf, 'nrf').forEach(ip => add({ ip, service: 'AUSF', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'AUSF registers with NRF', group: '5G', loopback: lo(ip) }));
    sbiClients(ausf, 'scp').forEach(ip => add({ ip, service: 'AUSF', interface: 'SBI client → SCP', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'SCP', description: 'AUSF routes SBI calls through SCP', group: '5G', loopback: lo(ip) }));
    metricsServers(ausf).forEach(ip => add({ ip, service: 'AUSF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes AUSF metrics', group: '5G', loopback: lo(ip) }));
  }

  // ── UDM ──
  const udm = configs?.udm?.udm;
  if (udm) {
    sbiServers(udm).forEach(ip => add({ ip, service: 'UDM', interface: 'SBI server (N8/N10/N13)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'AMF, SMF, AUSF', description: 'AMF calls UDM (N8) for subscriber data; SMF calls UDM (N10) for session data; AUSF calls UDM (N13) for auth vectors', group: '5G', loopback: lo(ip) }));
    sbiClients(udm, 'nrf').forEach(ip => add({ ip, service: 'UDM', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'UDM registers with NRF', group: '5G', loopback: lo(ip) }));
    sbiClients(udm, 'scp').forEach(ip => add({ ip, service: 'UDM', interface: 'SBI client → SCP', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'SCP', description: 'UDM routes SBI calls through SCP', group: '5G', loopback: lo(ip) }));
    metricsServers(udm).forEach(ip => add({ ip, service: 'UDM', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes UDM metrics', group: '5G', loopback: lo(ip) }));
  }

  // ── UDR ──
  const udr = configs?.udr?.udr;
  if (udr) {
    sbiServers(udr).forEach(ip => add({ ip, service: 'UDR', interface: 'SBI server (Nudr)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'UDM, PCF, AUSF', description: 'UDM/PCF/AUSF call UDR to read/write subscriber data and policies from the database', group: '5G', loopback: lo(ip) }));
    sbiClients(udr, 'nrf').forEach(ip => add({ ip, service: 'UDR', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'UDR registers with NRF', group: '5G', loopback: lo(ip) }));
    sbiClients(udr, 'scp').forEach(ip => add({ ip, service: 'UDR', interface: 'SBI client → SCP', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'SCP', description: 'UDR routes SBI calls through SCP', group: '5G', loopback: lo(ip) }));
    metricsServers(udr).forEach(ip => add({ ip, service: 'UDR', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes UDR metrics', group: '5G', loopback: lo(ip) }));
  }

  // ── PCF ──
  const pcf = configs?.pcf?.pcf;
  if (pcf) {
    sbiServers(pcf).forEach(ip => add({ ip, service: 'PCF', interface: 'SBI server (N7/N15/N36)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'SMF, AMF, UDR', description: 'SMF calls PCF (N7) for QoS policy; AMF calls PCF (N15) for UE policy; PCF reads UDR (N36) for policy data', group: '5G', loopback: lo(ip) }));
    sbiClients(pcf, 'nrf').forEach(ip => add({ ip, service: 'PCF', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'PCF registers with NRF', group: '5G', loopback: lo(ip) }));
    sbiClients(pcf, 'scp').forEach(ip => add({ ip, service: 'PCF', interface: 'SBI client → SCP', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'SCP', description: 'PCF routes SBI calls through SCP', group: '5G', loopback: lo(ip) }));
    metricsServers(pcf).forEach(ip => add({ ip, service: 'PCF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes PCF metrics', group: '5G', loopback: lo(ip) }));
  }

  // ── NSSF ──
  const nssf = configs?.nssf?.nssf;
  if (nssf) {
    sbiServers(nssf).forEach(ip => add({ ip, service: 'NSSF', interface: 'SBI server (Nnssf)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'AMF', description: 'AMF calls NSSF to select the appropriate network slice for a UE based on requested NSSAI', group: '5G', loopback: lo(ip) }));
    sbiClients(nssf, 'nrf').forEach(ip => add({ ip, service: 'NSSF', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'NSSF registers with NRF', group: '5G', loopback: lo(ip) }));
    metricsServers(nssf).forEach(ip => add({ ip, service: 'NSSF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes NSSF metrics', group: '5G', loopback: lo(ip) }));
  }

  // ── BSF ──
  const bsf = configs?.bsf?.bsf;
  if (bsf) {
    sbiServers(bsf).forEach(ip => add({ ip, service: 'BSF', interface: 'SBI server (Nbsf)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'PCF', description: 'PCF calls BSF to register and discover PCF bindings for UE sessions', group: '5G', loopback: lo(ip) }));
    sbiClients(bsf, 'nrf').forEach(ip => add({ ip, service: 'BSF', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'BSF registers with NRF', group: '5G', loopback: lo(ip) }));
    metricsServers(bsf).forEach(ip => add({ ip, service: 'BSF', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes BSF metrics', group: '5G', loopback: lo(ip) }));
  }

  // ── SCP ──
  const scp = configs?.scp?.scp;
  if (scp) {
    sbiServers(scp).forEach(ip => add({ ip, service: 'SCP', interface: 'SBI server (Nscp)', protocol: 'HTTP/2', port: '7777', direction: 'server', connects_to: 'All NFs', description: 'All NFs route their SBI calls through SCP — handles load balancing, routing and discovery on their behalf', group: '5G', loopback: lo(ip) }));
    sbiClients(scp, 'nrf').forEach(ip => add({ ip, service: 'SCP', interface: 'SBI client → NRF', protocol: 'HTTP/2', port: '7777', direction: 'client', connects_to: 'NRF', description: 'SCP registers with NRF and discovers NFs on behalf of other NFs', group: '5G', loopback: lo(ip) }));
    metricsServers(scp).forEach(ip => add({ ip, service: 'SCP', interface: 'Metrics (Prometheus)', protocol: 'HTTP', port: '9090', direction: 'server', connects_to: 'Prometheus', description: 'Prometheus scrapes SCP metrics', group: '5G', loopback: lo(ip) }));
  }

  // ── IMS (VoLTE) ──────────────────────────────────────────────────────────────
  const ims = configs?._ims as { pcscfIp?: string; pcscfPort?: number; icscfIp?: string; icscfPort?: number; scscfIp?: string; scscfPort?: number; rtpEngineIp?: string; dnsIp?: string } | null | undefined;
  if (ims?.pcscfIp) {
    const pIp = ims.pcscfIp;
    const pPort = String(ims.pcscfPort || 5060);
    const iIp = ims.icscfIp!;
    const iPort = String(ims.icscfPort || 5060);
    const sIp = ims.scscfIp!;
    const sPort = String(ims.scscfPort || 5060);
    const hssIp = '127.0.0.1';

    add({ ip: pIp, service: 'P-CSCF', interface: 'SIP (UE→P-CSCF)', protocol: 'UDP/TCP', port: pPort, direction: 'server', connects_to: 'UE', description: 'UEs dial here first for VoLTE SIP REGISTER and INVITE — P-CSCF IP is delivered to the UE via IMS APN', group: 'IMS', loopback: lo(pIp) });
    add({ ip: pIp, service: 'P-CSCF', interface: 'SIP-TLS (UE→P-CSCF)', protocol: 'TCP/TLS', port: '5061', direction: 'server', connects_to: 'UE', description: 'Secure SIP over TLS — some UEs use TLS for signaling encryption instead of plain SIP', group: 'IMS', loopback: lo(pIp) });
    add({ ip: pIp, service: 'P-CSCF', interface: 'Rx Diameter (→PCRF)', protocol: 'TCP', port: '3871', direction: 'client', connects_to: 'PCRF', description: 'P-CSCF dials PCRF Rx interface to authorize IMS bearers and install QoS rules for voice calls', group: 'IMS', loopback: lo(pIp) });
    if (iIp) {
      add({ ip: iIp, service: 'I-CSCF', interface: 'SIP server', protocol: 'UDP/TCP', port: iPort, direction: 'server', connects_to: 'P-CSCF', description: 'P-CSCF forwards initial REGISTER/INVITE here; I-CSCF queries HSS to assign the S-CSCF', group: 'IMS', loopback: lo(iIp) });
      add({ ip: iIp, service: 'I-CSCF', interface: 'Cx Diameter (→HSS)', protocol: 'TCP', port: '3869', direction: 'client', connects_to: 'PyHSS', description: 'I-CSCF sends UAR (User-Authorization-Request) and LIR (Location-Info-Request) to HSS for S-CSCF selection', group: 'IMS', loopback: lo(iIp) });
    }
    if (sIp) {
      add({ ip: sIp, service: 'S-CSCF', interface: 'SIP server', protocol: 'UDP/TCP', port: sPort, direction: 'server', connects_to: 'I-CSCF / P-CSCF', description: 'Anchor CSCF — handles REGISTER, maintains contact bindings, routes calls for registered UEs', group: 'IMS', loopback: lo(sIp) });
      add({ ip: sIp, service: 'S-CSCF', interface: 'Cx Diameter (→HSS)', protocol: 'TCP', port: '3870', direction: 'client', connects_to: 'PyHSS', description: 'S-CSCF sends MAR (Multimedia-Auth-Request) and SAR (Server-Assignment-Request) to HSS', group: 'IMS', loopback: lo(sIp) });
    }
    add({ ip: hssIp, service: 'PyHSS', interface: 'Cx Diameter server', protocol: 'TCP', port: '3868', direction: 'server', connects_to: 'I-CSCF, S-CSCF', description: 'IMS Home Subscriber Server — responds to Cx requests from I-CSCF and S-CSCF for auth and subscriber data', group: 'IMS', loopback: lo(hssIp) });
    if (ims.rtpEngineIp) {
      add({ ip: ims.rtpEngineIp, service: 'RTPengine', interface: 'NGCP (Kamailio→RTPengine)', protocol: 'UDP', port: '2223', direction: 'server', connects_to: 'P-CSCF / S-CSCF', description: 'Kamailio instructs RTPengine to proxy RTP voice streams for NAT traversal and transcoding', group: 'IMS', loopback: lo(ims.rtpEngineIp) });
    }
    if (ims.dnsIp) {
      add({ ip: ims.dnsIp, service: 'BIND9 (IMS DNS)', interface: 'DNS', protocol: 'UDP', port: '53', direction: 'server', connects_to: 'UE / Kamailio', description: 'IMS DNS — provides SRV and NAPTR records for IMS realm routing (pcscf, icscf, scscf FQDNs)', group: 'IMS', loopback: lo(ims.dnsIp) });
    }
  }

  // deduplicate
  const seen = new Set<string>();
  return rows.filter(r => {
    const key = `${r.ip}|${r.service}|${r.interface}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── buildConnectionPairs ──────────────────────────────────────────────────────

function buildConnectionPairs(rows: IPRow[]): ConnectionPair[] {
  // Helper: find IP for a service+interface keyword
  const ip = (service: string, ifaceKeyword: string, dir?: 'server' | 'client'): string => {
    const match = rows.find(r =>
      r.service === service &&
      r.interface.toLowerCase().includes(ifaceKeyword.toLowerCase()) &&
      (dir ? r.direction === dir : true)
    );
    return match?.ip || '—';
  };

  // Helper: find ALL matching IPs (for multi-entry clients like SMF pfcp client upf)
  const ips = (service: string, ifaceKeyword: string, dir?: 'server' | 'client'): IPRow[] =>
    rows.filter(r =>
      r.service === service &&
      r.interface.toLowerCase().includes(ifaceKeyword.toLowerCase()) &&
      (dir ? r.direction === dir : true)
    );

  const pairs: ConnectionPair[] = [];
  const add = (p: ConnectionPair) => pairs.push(p);

  // ── Helper to add a pair only when both IPs exist ──
  const pair = (
    group: '4G' | '5G' | 'Shared' | 'IMS',
    iface: string,
    proto: string,
    port: string,
    clientSvc: string,
    clientIP: string,
    serverSvc: string,
    serverIP: string,
    desc: string,
  ) => {
    if (clientIP === '—' && serverIP === '—') return;
    add({ interface: iface, protocol: proto, port, clientService: clientSvc, clientIP, serverService: serverSvc, serverIP, description: desc, group });
  };

  // ═══════════════════════════════════════════════════════════════════
  // 4G EPC
  // ═══════════════════════════════════════════════════════════════════

  // S6a: MME ←→ HSS (Diameter)
  pair('4G', 'S6a Diameter', 'SCTP', '3868',
    'MME',  ip('MME',  's6a', 'client'),
    'HSS',  ip('HSS',  's6a', 'server'),
    'MME dials HSS to authenticate subscribers and download profiles (IMSI, keys, QoS)');

  // S11: MME ←→ SGW-C (GTPv2-C)
  pair('4G', 'S11 GTPv2-C', 'UDP', '2123',
    'SGW-C', ip('SGW-C', 's11', 'client'),
    'MME',   ip('MME',   's11', 'server'),
    'SGW-C dials MME — bearer setup/modify/release signaling for UE attach and handover');

  // S1-MME: eNodeB → MME (S1AP control plane)
  pair('4G', 'S1-MME (S1AP)', 'SCTP', '36412',
    'eNodeB', '(eNodeB IP)',
    'MME',    ip('MME', 's1ap', 'server'),
    'eNodeBs dial MME to attach, register, and control UEs — all 4G control plane signaling');

  // S5/S8c: SGW-C → SMF/PGW-C (GTPv2-C for bearer creation)
  pair('4G', 'S5/S8 GTPv2-C', 'UDP', '2123',
    'SGW-C',    ip('SGW-C',    's5', 'client') || ip('SGW-C', 's11', 'client'),
    'SMF/PGW-C', ip('SMF/PGW-C', 's5', 'server'),
    'SGW-C dials PGW/SMF to create/modify/delete S5 bearers (PDN connection setup)');

  // Gx: SMF/PGW-C → PCRF (Diameter policy)
  pair('4G', 'Gx Diameter', 'SCTP', '3868',
    'SMF/PGW-C', ip('SMF/PGW-C', 'gtpc', 'server'),  // PGW-C src
    'PCRF',      ip('PCRF', 'gx', 'server'),
    'PGW/SMF dials PCRF to install QoS policies and charging rules per UE session');

  // Gxc/Sxa: SGW-C → SGW-U (PFCP)
  // Each SGW-U entry in SGW-C pfcp.client.sgwu is a separate connection
  ips('SGW-C', 'pfcp client', 'client').forEach(r => {
    const label = r.connects_to || 'SGW-U';
    const sgwuPfcpIP = r.ip;
    const sgwcPfcpIP = ip('SGW-C', 'pfcp server', 'server');
    add({
      interface: 'Gxc/Sxa PFCP', protocol: 'UDP', port: '8805',
      clientService: 'SGW-C', clientIP: sgwcPfcpIP,
      serverService: label,   serverIP: sgwuPfcpIP,
      description: `SGW-C programs ${label} with PDR/FAR session rules for each UE bearer`,
      group: '4G',
    });
  });

  // Sxa reverse: SGW-U → SGW-C (if sgwu has pfcp.client.sgwc)
  const sgwuSgwcClient = ip('SGW-U', 'pfcp client', 'client');
  if (sgwuSgwcClient && sgwuSgwcClient !== '—') {
    pair('4G', 'Gxc/Sxa PFCP (re-assoc)', 'UDP', '8805',
      'SGW-U', ip('SGW-U', 'pfcp server', 'server'),
      'SGW-C', sgwuSgwcClient,
      'SGW-U proactively dials SGW-C on startup to register and re-associate after restart');
  }

  // S1-U: eNodeB → SGW-U (GTP-U user plane)
  pair('4G', 'S1-U GTP-U', 'UDP', '2152',
    'eNodeB', '(eNodeB IP)',
    'SGW-U',  ip('SGW-U', 's1-u', 'server'),
    'eNodeBs send UE user data packets to SGW-U encapsulated in GTP — this is the S1-U endpoint on the eNodeB config');

  // S5-U: SGW-U → UPF/PGW-U (GTP-U user plane)
  pair('4G', 'S5/S8 GTP-U', 'UDP', '2152',
    'SGW-U',     ip('SGW-U',     's1-u', 'server'),
    'UPF/PGW-U', ip('SMF/PGW-U', 's5', 'server') || ip('UPF', 'gtp-u', 'server'),
    'SGW-U relays UE GTP packets to the PGW-U/UPF over the S5/S8 interface for internet breakout');

  // SGs-AP: MME → MSC/VLR (if configured)
  const sgsap = ip('MME', 'sgs', 'server');
  if (sgsap && sgsap !== '—') {
    pair('4G', 'SGs-AP', 'SCTP', '29118',
      'MSC/VLR', '(MSC IP)',
      'MME',     sgsap,
      'MSC/VLR dials MME for circuit-switched fallback (CSFB) voice call paging and location');
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5G NR Core
  // ═══════════════════════════════════════════════════════════════════

  // N2: gNodeB → AMF (NGAP)
  pair('5G', 'N2 NGAP', 'SCTP', '38412',
    'gNodeB', '(gNodeB IP)',
    'AMF',    ip('AMF', 'ngap', 'server'),
    'gNodeBs dial AMF to register and control 5G UE sessions — registration, PDU sessions, handover, paging');

  // N11: AMF ↔ SMF
  pair('5G', 'N11 SBI (AMF→SMF)', 'HTTP/2', '7777',
    'AMF', ip('AMF', 'sbi server', 'server'),
    'SMF', ip('SMF', 'sbi server', 'server'),
    'AMF calls SMF (N11) to create/modify/release PDU sessions when UEs attach or switch slices');

  // N8: AMF → UDM
  pair('5G', 'N8 SBI (AMF→UDM)', 'HTTP/2', '7777',
    'AMF', ip('AMF', 'sbi server', 'server'),
    'UDM', ip('UDM', 'sbi server', 'server'),
    'AMF calls UDM (N8) to download subscriber data and Access and Mobility Subscription data');

  // N12: AMF → AUSF
  pair('5G', 'N12 SBI (AMF→AUSF)', 'HTTP/2', '7777',
    'AMF',  ip('AMF',  'sbi server', 'server'),
    'AUSF', ip('AUSF', 'sbi server', 'server'),
    'AMF calls AUSF (N12) to authenticate 5G UEs using 5G-AKA or EAP-AKA procedures');

  // N15: AMF → PCF
  pair('5G', 'N15 SBI (AMF→PCF)', 'HTTP/2', '7777',
    'AMF', ip('AMF', 'sbi server', 'server'),
    'PCF', ip('PCF', 'sbi server', 'server'),
    'AMF calls PCF (N15) to get AM (Access and Mobility) policies for UEs');

  // N7: SMF → PCF
  pair('5G', 'N7 SBI (SMF→PCF)', 'HTTP/2', '7777',
    'SMF', ip('SMF', 'sbi server', 'server'),
    'PCF', ip('PCF', 'sbi server', 'server'),
    'SMF calls PCF (N7) to get session management policies and QoS rules per PDU session');

  // N10: SMF → UDM
  pair('5G', 'N10 SBI (SMF→UDM)', 'HTTP/2', '7777',
    'SMF', ip('SMF', 'sbi server', 'server'),
    'UDM', ip('UDM', 'sbi server', 'server'),
    'SMF calls UDM (N10) to get Session Management Subscription data for the UE');

  // N13: AUSF → UDM
  pair('5G', 'N13 SBI (AUSF→UDM)', 'HTTP/2', '7777',
    'AUSF', ip('AUSF', 'sbi server', 'server'),
    'UDM',  ip('UDM',  'sbi server', 'server'),
    'AUSF calls UDM (N13) to get authentication vectors (5G HE AV) for UE authentication');

  // N35: UDM → UDR
  pair('5G', 'N35 SBI (UDM→UDR)', 'HTTP/2', '7777',
    'UDM', ip('UDM', 'sbi server', 'server'),
    'UDR', ip('UDR', 'sbi server', 'server'),
    'UDM calls UDR (N35) to read/write subscriber data from the Unified Data Repository');

  // N36: PCF → UDR
  pair('5G', 'N36 SBI (PCF→UDR)', 'HTTP/2', '7777',
    'PCF', ip('PCF', 'sbi server', 'server'),
    'UDR', ip('UDR', 'sbi server', 'server'),
    'PCF calls UDR (N36) to read policy data and subscriber policy profiles from the repository');

  // Nnssf: AMF → NSSF
  const nssfIP = ip('NSSF', 'sbi server', 'server');
  if (nssfIP && nssfIP !== '—') {
    pair('5G', 'Nnssf SBI (AMF→NSSF)', 'HTTP/2', '7777',
      'AMF',  ip('AMF', 'sbi server', 'server'),
      'NSSF', nssfIP,
      'AMF calls NSSF (Nnssf) to select the correct network slice for a UE based on requested NSSAI');
  }

  // Nbsf: PCF → BSF
  const bsfIP = ip('BSF', 'sbi server', 'server');
  if (bsfIP && bsfIP !== '—') {
    pair('5G', 'Nbsf SBI (PCF→BSF)', 'HTTP/2', '7777',
      'PCF', ip('PCF', 'sbi server', 'server'),
      'BSF', bsfIP,
      'PCF calls BSF (Nbsf) to register PCF bindings so other NFs can discover the right PCF for a UE');
  }

  // NRF registration: each NF → NRF
  const nrfIP = ip('NRF', 'sbi server', 'server');
  if (nrfIP && nrfIP !== '—') {
    const nfsWithNrf = ['AMF','SMF','UPF','AUSF','UDM','UDR','PCF','NSSF','BSF','SCP'];
    nfsWithNrf.forEach(nf => {
      const nfIP = ip(nf, 'sbi server', 'server') || ip(nf, 'pfcp server', 'server');
      if (nfIP && nfIP !== '—') {
        add({
          interface: 'NRF Registration (Nnrf)', protocol: 'HTTP/2', port: '7777',
          clientService: nf, clientIP: nfIP,
          serverService: 'NRF', serverIP: nrfIP,
          description: `${nf} registers with NRF on startup and queries NRF to discover other NFs`,
          group: '5G',
        });
      }
    });
  }

  // N4: SMF → each UPF (PFCP)
  ips('SMF', 'pfcp client', 'client').forEach(r => {
    const label = r.connects_to || 'UPF';
    add({
      interface: 'N4 PFCP', protocol: 'UDP', port: '8805',
      clientService: 'SMF', clientIP: ip('SMF', 'pfcp server', 'server'),
      serverService: label, serverIP: r.ip,
      description: `SMF programs ${label} with PDR/FAR/URR session rules for every UE PDU session`,
      group: '5G',
    });
  });

  // N4 reverse: UPF → SMF (if upf has pfcp.client.smf)
  const upfSmfClient = ip('UPF', 'pfcp client', 'client');
  if (upfSmfClient && upfSmfClient !== '—') {
    pair('5G', 'N4 PFCP (UPF→SMF)', 'UDP', '8805',
      'UPF', ip('UPF', 'pfcp server', 'server'),
      'SMF', upfSmfClient,
      'UPF proactively dials SMF on startup to register PFCP association');
  }

  // N3: gNodeB → UPF (GTP-U user plane)
  const upfGtpuIP = ip('UPF', 'gtp-u', 'server');
  if (upfGtpuIP && upfGtpuIP !== '—') {
    pair('Shared', 'N3 GTP-U', 'UDP', '2152',
      'gNodeB', '(gNodeB IP)',
      'UPF',    upfGtpuIP,
      'gNodeBs send UE user data to UPF encapsulated in GTP-U — the N3 GTP-U address is configured on the gNodeB');
  }

  // ═══════════════════════════════════════════════════════════════════
  // IMS (VoLTE)
  // ═══════════════════════════════════════════════════════════════════

  const pCscfSipIp = ip('P-CSCF', 'sip (ue', 'server');
  if (pCscfSipIp && pCscfSipIp !== '—') {
    pair('IMS', 'SIP (UE→P-CSCF)', 'UDP/TCP', '5060',
      'UE', '(UE IMS IP)',
      'P-CSCF', pCscfSipIp,
      'UE SIP registration and call setup — first hop for all VoLTE IMS signaling');

    const pcrfAddr = ip('PCRF', 'gx', 'server');
    pair('IMS', 'Rx Diameter (P-CSCF→PCRF)', 'TCP', '3871',
      'P-CSCF', pCscfSipIp,
      'PCRF', pcrfAddr,
      'P-CSCF requests IMS bearer authorization and QoS policy from PCRF for each voice call');

    const iCscfIp = ip('I-CSCF', 'sip', 'server');
    if (iCscfIp && iCscfIp !== '—') {
      pair('IMS', 'SIP (P-CSCF→I-CSCF)', 'UDP/TCP', '5060',
        'P-CSCF', pCscfSipIp,
        'I-CSCF', iCscfIp,
        'P-CSCF forwards SIP REGISTER and initial INVITEs to I-CSCF for S-CSCF selection');

      const hssIp = ip('PyHSS', 'cx', 'server');
      pair('IMS', 'Cx Diameter (I-CSCF→HSS)', 'TCP', '3869',
        'I-CSCF', ip('I-CSCF', 'cx', 'client'),
        'PyHSS', hssIp,
        'I-CSCF queries HSS via UAR/LIR to assign and locate the S-CSCF for the subscriber');

      const sCscfIp = ip('S-CSCF', 'sip', 'server');
      if (sCscfIp && sCscfIp !== '—') {
        pair('IMS', 'SIP (I-CSCF→S-CSCF)', 'UDP/TCP', '5060',
          'I-CSCF', iCscfIp,
          'S-CSCF', sCscfIp,
          'I-CSCF routes SIP REGISTER to the assigned S-CSCF to anchor the registration');

        pair('IMS', 'Cx Diameter (S-CSCF→HSS)', 'TCP', '3870',
          'S-CSCF', ip('S-CSCF', 'cx', 'client'),
          'PyHSS', hssIp,
          'S-CSCF requests auth vectors (MAR) and confirms registration (SAR) with HSS');
      }
    }
  }

  // Metrics: each service → Prometheus
  rows.filter(r => r.interface.toLowerCase().includes('metrics') && r.direction === 'server').forEach(r => {
    add({
      interface: 'Prometheus Metrics scrape', protocol: 'HTTP', port: '9090',
      clientService: 'Prometheus', clientIP: '(Prometheus IP)',
      serverService: r.service, serverIP: r.ip,
      description: `Prometheus scrapes ${r.service} metrics endpoint — sessions, UEs, GTP tunnels, registrations`,
      group: r.group,
    });
  });

  // SCP: if configured, NFs → SCP instead of direct NRF
  const scpIP = ip('SCP', 'sbi server', 'server');
  if (scpIP && scpIP !== '—') {
    const nfsWithScp = ['AMF','SMF','AUSF','UDM','UDR','PCF','NSSF','BSF'];
    nfsWithScp.forEach(nf => {
      const nfIP = ip(nf, 'sbi server', 'server');
      if (nfIP && nfIP !== '—') {
        add({
          interface: 'SCP (indirect SBI routing)', protocol: 'HTTP/2', port: '7777',
          clientService: nf, clientIP: nfIP,
          serverService: 'SCP', serverIP: scpIP,
          description: `${nf} routes SBI calls through SCP for load balancing and NF discovery`,
          group: '5G',
        });
      }
    });
  }

  // Deduplicate by interface+clientService+serverService
  const seen = new Set<string>();
  return pairs.filter(p => {
    const key = `${p.interface}|${p.clientService}|${p.serverService}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Connections tab ───────────────────────────────────────────────────────────

function ConnectionsTab({ rows }: { rows: IPRow[] }) {
  const pairs = useMemo(() => buildConnectionPairs(rows), [rows]);
  const groups: Array<{ key: '4G' | '5G' | 'Shared' | 'IMS'; label: string; color: string; bg: string }> = [
    { key: '4G',     label: '4G EPC',       color: 'text-purple-400', bg: 'bg-purple-500/10' },
    { key: '5G',     label: '5G NR Core',   color: 'text-nms-accent', bg: 'bg-nms-accent/10' },
    { key: 'Shared', label: 'Shared 4G+5G', color: 'text-teal-400',   bg: 'bg-teal-500/10'  },
    { key: 'IMS',    label: 'IMS (VoLTE)',  color: 'text-rose-400',   bg: 'bg-rose-500/10'  },
  ];
  return (
    <div className="space-y-6">
      {groups.map(group => {
        const groupPairs = pairs.filter(p => p.group === group.key);
        if (groupPairs.length === 0) return null;
        return (
          <div key={group.key}>
            <div className="flex items-center gap-2 mb-3">
              <span className={clsx('text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded', group.bg, group.color)}>{group.label}</span>
              <div className="flex-1 h-px bg-nms-border" />
            </div>
            <div className="border border-nms-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-nms-surface-2 border-b border-nms-border">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Interface</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Proto / Port</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Client (dials out)</th>
                    <th className="px-1 py-2.5 text-center w-8"></th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Server (listens)</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-nms-border">
                  {groupPairs.map((pair, idx) => (
                    <tr key={idx} className="hover:bg-nms-surface-2/40 transition-colors">
                      <td className="px-3 py-2.5 font-medium text-nms-text">{pair.interface}</td>
                      <td className="px-3 py-2.5 font-mono text-nms-text-dim">{pair.protocol}/{pair.port}</td>
                      <td className="px-3 py-2.5">
                        <span className="font-semibold text-amber-400">{pair.clientService}</span>
                        <span className="font-mono text-nms-text ml-1.5">{pair.clientIP}</span>
                        {pair.clientIP.startsWith('127.') && <span className="ml-1 text-[10px] text-nms-text-dim/60 bg-nms-surface-2 border border-nms-border rounded px-1">lo</span>}
                      </td>
                      <td className="px-1 py-2.5 text-center"><ArrowRight className="w-3.5 h-3.5 text-nms-text-dim mx-auto" /></td>
                      <td className="px-3 py-2.5">
                        <span className="font-semibold text-green-400">{pair.serverService}</span>
                        <span className="font-mono text-nms-text ml-1.5">{pair.serverIP}</span>
                        {pair.serverIP.startsWith('127.') && <span className="ml-1 text-[10px] text-nms-text-dim/60 bg-nms-surface-2 border border-nms-border rounded px-1">lo</span>}
                      </td>
                      <td className="px-3 py-2.5 text-nms-text-dim">{pair.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-6 pt-2 text-xs text-nms-text-dim">
        <div className="flex items-center gap-1.5"><span className="text-amber-400 font-semibold">Amber</span><span>= Client (dials out to the server)</span></div>
        <div className="flex items-center gap-1.5"><span className="text-green-400 font-semibold">Green</span><span>= Server (listens for incoming connections)</span></div>
        <div className="flex items-center gap-1.5"><span className="text-[10px] text-nms-text-dim/60 bg-nms-surface-2 border border-nms-border rounded px-1">lo</span><span>= loopback, same host only</span></div>
      </div>
    </div>
  );
}

// ── All IPs tab ───────────────────────────────────────────────────────────────

function AllIPsTab({ rows }: { rows: IPRow[] }) {
  const groups: Array<{ key: '4G' | '5G' | 'Shared' | 'IMS'; label: string; color: string; bg: string }> = [
    { key: '4G',     label: '4G EPC',       color: 'text-purple-400', bg: 'bg-purple-500/10' },
    { key: '5G',     label: '5G NR Core',   color: 'text-nms-accent', bg: 'bg-nms-accent/10' },
    { key: 'Shared', label: 'Shared 4G+5G', color: 'text-teal-400',   bg: 'bg-teal-500/10'  },
    { key: 'IMS',    label: 'IMS (VoLTE)',  color: 'text-rose-400',   bg: 'bg-rose-500/10'  },
  ];
  return (
    <div className="space-y-6">
      {groups.map(group => {
        const groupRows = rows.filter(r => r.group === group.key);
        if (groupRows.length === 0) return null;
        return (
          <div key={group.key}>
            <div className="flex items-center gap-2 mb-3">
              <span className={clsx('text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded', group.bg, group.color)}>{group.label}</span>
              <div className="flex-1 h-px bg-nms-border" />
            </div>
            <div className="border border-nms-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-nms-surface-2 border-b border-nms-border">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Service</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">IP Address</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Interface</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Proto / Port</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Role</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Connects to</th>
                    <th className="px-3 py-2.5 text-left font-semibold text-nms-text uppercase tracking-wider">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-nms-border">
                  {groupRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-nms-surface-2/40 transition-colors">
                      <td className="px-3 py-2.5"><span className={clsx('font-semibold', group.color)}>{row.service}</span></td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-semibold text-nms-text">{row.ip}</span>
                          {row.loopback && <span className="text-[10px] text-nms-text-dim/60 bg-nms-surface-2 border border-nms-border rounded px-1">loopback</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-medium text-nms-text">{row.interface}</td>
                      <td className="px-3 py-2.5 font-mono text-nms-text-dim">{row.protocol}/{row.port}</td>
                      <td className="px-3 py-2.5">
                        {row.direction === 'server'
                          ? <span className="inline-flex items-center gap-1 text-green-400"><ArrowRight className="w-3 h-3 rotate-180" /><span className="font-medium">Server</span></span>
                          : <span className="inline-flex items-center gap-1 text-amber-400"><ArrowRight className="w-3 h-3" /><span className="font-medium">Client</span></span>}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-nms-text-dim">{row.connects_to || '—'}</td>
                      <td className="px-3 py-2.5 text-nms-text-dim">{row.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-6 pt-2 text-xs text-nms-text-dim">
        <div className="flex items-center gap-1.5"><ArrowRight className="w-3 h-3 rotate-180 text-green-400" /><span><span className="text-green-400 font-medium">Server</span> — this IP listens, the remote end dials in</span></div>
        <div className="flex items-center gap-1.5"><ArrowRight className="w-3 h-3 text-amber-400" /><span><span className="text-amber-400 font-medium">Client</span> — this IP dials out to a remote server</span></div>
        <div className="flex items-center gap-1.5"><span className="text-[10px] text-nms-text-dim/60 bg-nms-surface-2 border border-nms-border rounded px-1">loopback</span><span>127.x.x.x — only reachable on this host</span></div>
      </div>
    </div>
  );
}

// ── IP Plumbing Modal ─────────────────────────────────────────────────────────

function IPPlumbingModal({ onClose, configs }: { onClose: () => void; configs: any }) {
  const [activeTab, setActiveTab] = useState<'all-ips' | 'connections'>('all-ips');
  const rows = useMemo(() => buildIPTable(configs), [configs]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative z-10 bg-nms-surface border border-nms-border rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-nms-accent/10"><Server className="w-5 h-5 text-nms-accent" /></div>
            <div>
              <h2 className="text-base font-semibold font-display text-nms-text">IP Address Plumbing</h2>
              <p className="text-xs text-nms-text-dim mt-0.5">Every IP used by Open5GS — what it does, and exactly what connects to what</p>
            </div>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors p-1 rounded"><X className="w-5 h-5" /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-nms-border px-6 shrink-0">
          {(['all-ips', 'connections'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={clsx('px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
                activeTab === tab ? 'border-nms-accent text-nms-accent' : 'border-transparent text-nms-text-dim hover:text-nms-text')}>
              {tab === 'all-ips' ? 'All IPs' : 'Connections'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {activeTab === 'connections'
            ? <ConnectionsTab rows={rows} />
            : <AllIPsTab rows={rows} />}
        </div>
      </div>
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label, color }: { label: string; color: '4G' | '5G' }): JSX.Element {
  const is5G = color === '5G';
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className={clsx('text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded',
        is5G ? 'bg-nms-accent/15 text-nms-accent' : 'bg-purple-500/15 text-purple-400')}>{label}</span>
      <div className="flex-1 h-px bg-nms-border" />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export const RANPage: React.FC<RANPageProps> = ({ onNavigateToSubscriber }) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const interfaceStatus      = useTopologyStore(s => s.interfaceStatus);
  const fetchInterfaceStatus = useTopologyStore(s => s.fetchInterfaceStatus);

  const [showIPTable, setShowIPTable] = useState(false);
  const [allConfigs, setAllConfigs]   = useState<any>(null);
  const loadConfigs = useCallback(async () => {
    try {
      const [configs, imsStatus] = await Promise.all([
        configApi.getAll(),
        imsApi.getStatus().catch(() => null),
      ]);
      setAllConfigs({ ...configs, _ims: imsStatus?.currentConfig ?? null });
    } catch { /* silent */ }
  }, []);

  const [radioTags, setRadioTags] = useState<Record<string, string>>({});
  const loadTags = useCallback(async () => {
    try { setRadioTags(await radioTagsApi.getAll()); } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchInterfaceStatus(); loadTags(); loadConfigs();
    const interval = setInterval(fetchInterfaceStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchInterfaceStatus, loadTags, loadConfigs]);

  const handleTagSave = useCallback(async (ip: string, nickname: string) => {
    try {
      await radioTagsApi.set(ip, nickname);
      setRadioTags(prev => {
        if (!nickname) { const next = { ...prev }; delete next[ip]; return next; }
        return { ...prev, [ip]: nickname };
      });
      toast.success(nickname ? `Tag saved: ${nickname}` : 'Tag removed', { duration: 2000 });
    } catch { toast.error('Failed to save tag'); }
  }, []);

  const s1mmeActive = interfaceStatus?.s1mme?.active            || false;
  const s1mmeRadios = (interfaceStatus?.s1mme?.connectedEnodebs || []) as ConnectedRadio[];
  const s1uActive   = interfaceStatus?.s1u?.active               || false;
  const s1uRadios   = (interfaceStatus?.s1u?.connectedEnodebs   || []) as ConnectedRadio[];
  const n2Active    = interfaceStatus?.n2?.active                || false;
  const n2Radios    = (interfaceStatus?.n2?.connectedGnodebs    || []) as ConnectedRadio[];
  const n3Active    = interfaceStatus?.n3?.active                || false;
  const n3Radios    = (interfaceStatus?.n3?.connectedGnodebs    || []) as ConnectedRadio[];
  const activeUEs4G = (interfaceStatus?.activeUEs4G || []) as ActiveUE[];
  const activeUEs5G = (interfaceStatus?.activeUEs5G || []) as ActiveUE[];

  const [sortCol, setSortCol] = useState<'imsi' | 'ip' | 'apn'>('imsi');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const handleSort = (col: 'imsi' | 'ip' | 'apn') => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };
  const SortIcon = ({ col }: { col: 'imsi' | 'ip' | 'apn' }) => {
    if (sortCol !== col) return <span className="opacity-30">⇅</span>;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3 text-nms-accent inline" /> : <ArrowDown className="w-3 h-3 text-nms-accent inline" />;
  };

  const allSessions = useMemo(() => {
    const combined = [
      ...activeUEs4G.map(ue => ({ ...ue, gen: '4G' as const })),
      ...activeUEs5G.map(ue => ({ ...ue, gen: '5G' as const })),
    ];
    return [...combined].sort((a, b) => {
      let av = '', bv = '';
      if (sortCol === 'imsi')      { av = a.imsi || '';        bv = b.imsi || ''; }
      else if (sortCol === 'ip')   { av = a.ip || '';          bv = b.ip || ''; }
      else if (sortCol === 'apn')  { av = a.dnn || a.apn || ''; bv = b.dnn || b.apn || ''; }
      const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [activeUEs4G, activeUEs5G, sortCol, sortDir]);

  const isMetricsFallback = allSessions.some(s => s.metricsOnly);
  const sharedCardProps = { radioTags, isAdmin, onTagSave: handleTagSave, onNavigateToSubscriber };

  return (
    <div className="px-4 pt-6 max-w-[1600px] mx-auto space-y-8">

      {showIPTable && allConfigs && (
        <IPPlumbingModal configs={allConfigs} onClose={() => setShowIPTable(false)} />
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold font-display text-nms-text mb-1">RAN Network</h1>
          <p className="text-sm text-nms-text-dim">Radio Access Network — interface status, connected radios, and active UE sessions</p>
        </div>
        <button onClick={() => { loadConfigs(); setShowIPTable(true); }}
          className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:border-nms-accent/50 flex items-center gap-2 text-sm shrink-0"
          title="Show all IPs used by Open5GS and what they are for">
          <Map className="w-4 h-4" /> IP Plumbing
        </button>
      </div>

      {/* 4G EPC */}
      <div>
        <SectionHeader label="4G EPC" color="4G" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <InterfaceCard icon={<Radio className="w-5 h-5" />} title="S1-MME Interface" subtitle="Control Plane (MME ↔ eNodeB)" active={s1mmeActive} radios={s1mmeRadios} deviceLabel="eNodeB" generation="4G" ues={activeUEs4G} {...sharedCardProps} />
          <InterfaceCard icon={<Activity className="w-5 h-5" />} title="S1-U Interface" subtitle="User Plane (SGW-U ↔ eNodeB)" active={s1uActive} radios={s1uRadios} deviceLabel="eNodeB" generation="4G" ues={activeUEs4G} {...sharedCardProps} />
        </div>
      </div>

      {/* 5G NR */}
      <div>
        <SectionHeader label="5G NR" color="5G" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <InterfaceCard icon={<Wifi className="w-5 h-5" />} title="N2 Interface" subtitle="Control Plane (AMF ↔ gNodeB)" active={n2Active} radios={n2Radios} deviceLabel="gNodeB" generation="5G" ues={activeUEs5G} {...sharedCardProps} />
          <InterfaceCard icon={<Network className="w-5 h-5" />} title="N3 Interface" subtitle="User Plane (UPF ↔ gNodeB)" active={n3Active} radios={n3Radios} deviceLabel="gNodeB" generation="5G" ues={activeUEs5G} {...sharedCardProps} />
        </div>
      </div>

      {/* All Sessions */}
      <div className="nms-card">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-nms-accent/10"><Users className="w-5 h-5 text-nms-accent" /></div>
          <div>
            <h2 className="text-lg font-semibold font-display text-nms-text">All Active UE Sessions</h2>
            <p className="text-xs text-nms-text-dim">Combined 4G + 5G session summary</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {isMetricsFallback && (
              <span className="text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded flex items-center gap-1">⚠ Metrics fallback</span>
            )}
            {activeUEs4G.length > 0 && <span className="text-xs font-medium text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">{activeUEs4G.length} 4G</span>}
            {activeUEs5G.length > 0 && <span className="text-xs font-medium text-nms-accent bg-nms-accent/10 px-2 py-0.5 rounded">{activeUEs5G.length} 5G</span>}
            <span className="text-sm font-semibold text-nms-accent">{allSessions.length} {allSessions.length === 1 ? 'session' : 'sessions'}</span>
          </div>
        </div>

        {allSessions.length > 0 ? (
          <div className="border border-nms-border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-nms-surface-2 border-b border-nms-border">
                <tr>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-nms-text uppercase tracking-wider min-w-[180px]">
                    <button onClick={() => handleSort('imsi')} className="flex items-center gap-1 hover:text-nms-accent transition-colors">IMSI <SortIcon col="imsi" /></button>
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">
                    <button onClick={() => handleSort('ip')} className="flex items-center gap-1 hover:text-nms-accent transition-colors">UE IP <SortIcon col="ip" /></button>
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-nms-text uppercase tracking-wider min-w-[140px]">Radio</th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">Gen</th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">CM State</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">
                    <button onClick={() => handleSort('apn')} className="flex items-center gap-1 hover:text-nms-accent transition-colors">DNN / APN <SortIcon col="apn" /></button>
                  </th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">Security</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-nms-text uppercase tracking-wider">AMBR ↓ / ↑</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border">
                {allSessions.map((ue, idx) => (
                  <tr key={idx} className="hover:bg-nms-surface-2/50 transition-colors">
                    <td className="px-3 py-2.5 font-mono">
                      {ue.metricsOnly ? <span className="text-xs text-nms-text-dim italic">metrics only</span> : (
                        <div>
                          <button onClick={() => onNavigateToSubscriber?.(ue.imsi)} className="text-nms-accent hover:underline transition-colors block">{ue.imsi}</button>
                          {ue.nickname && <span className="text-xs text-nms-text-dim">{ue.nickname}</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-nms-text text-xs">
                      {ue.metricsOnly ? <span className="text-nms-text-dim italic">—</span> : ue.ip || <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {ue.radioIp ? (
                        <div>
                          <span className={ue.gen === '5G' ? 'text-nms-accent' : 'text-purple-400'}>{ue.radioIp}</span>
                          {radioTags[ue.radioIp] && <span className="block text-xs text-nms-text-dim">{radioTags[ue.radioIp]}</span>}
                        </div>
                      ) : <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={clsx('inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold', ue.gen === '5G' ? 'bg-nms-accent/10 text-nms-accent' : 'bg-purple-500/10 text-purple-400')}>{ue.gen}</span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {ue.cmState ? (
                        <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', ue.cmState === 'connected' ? 'bg-nms-green/10 text-nms-green' : 'bg-nms-text-dim/10 text-nms-text-dim')}>
                          <Circle className="w-1.5 h-1.5 fill-current" />{ue.cmState}
                        </span>
                      ) : <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-nms-text font-mono text-xs">{ue.dnn || ue.apn || <span className="text-nms-text-dim">—</span>}</td>
                    <td className="px-3 py-2.5 text-center">
                      {ue.securityEnc || ue.securityInt ? (
                        <span className="inline-flex items-center gap-1 text-xs text-nms-text-dim">
                          <Shield className="w-3 h-3 text-nms-accent" />
                          <span className="font-mono">{ue.securityEnc?.toUpperCase()}</span>
                          {ue.securityInt && <span className="font-mono">/{ue.securityInt?.toUpperCase()}</span>}
                        </span>
                      ) : <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs text-nms-text-dim font-mono">
                      {ue.ambrDownlink || ue.ambrUplink ? `${formatAmbr(ue.ambrDownlink)} / ${formatAmbr(ue.ambrUplink)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-12 text-nms-text-dim">
            <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No active UE sessions</p>
            <p className="text-xs mt-1">Sessions appear here when UEs connect and establish PDN/PDU bearers</p>
            <p className="text-xs mt-2 text-nms-text-dim/60">If UEs are connected, this feature requires Open5GS ≥ v2.7.7.</p>
          </div>
        )}
      </div>
    </div>
  );
};
