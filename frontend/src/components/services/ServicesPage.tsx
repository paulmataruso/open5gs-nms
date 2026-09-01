import { useState, useEffect } from 'react';
import {
  Play, Square, RotateCw, Zap, Radio, Wifi, Container, AlertCircle,
  Power, PowerOff, Gauge, Settings2,
} from 'lucide-react';
import { useServiceStore } from '../../stores';
import { serviceApi } from '../../api';
import { vowifiApi, type VowifiStatus } from '../../api/vowifi';
import { mmsApi, type MmsStatus } from '../../api/mms';
import { vectorcoreSmscApi, type VectorcoreSmscStatus } from '../../api/vectorcoreSmsc';
import { SpeedTestServerModal } from '../trafficHistory/SpeedTestServerModal';
import type { ServiceStatus } from '../../types';
import axios from 'axios';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

// In Open5GS 2.7+, SMF absorbed PGW-c and UPF absorbed PGW-u.
// SMF and UPF are shared between 4G and 5G — do NOT include them in the 5G-only group.
// Stopping "5G" should only stop the 5G-specific NFs, leaving SMF/UPF running for 4G.
const SERVICES_5G     = ['nrf', 'scp', 'amf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'sepp1'];
const SERVICES_4G     = ['mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
const SERVICES_SHARED = ['mongodb', 'smf', 'upf'];
const SERVICES_OSMO   = ['osmo-stp', 'osmo-hlr', 'osmo-msc'];

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === 0) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatUptime(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  try {
    const start = new Date(timestamp);
    const diff = Date.now() - start.getTime();
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h`;
    }
    return `${hours}h ${mins}m`;
  } catch {
    return '—';
  }
}

// Where an operator actually manages each of these, beyond the inline
// start/stop/restart this table already offers — the core-17 NFs' config
// lives on the Config page, Osmocom's on the SMS page (SMS via SGs tab),
// mongodb has no config page of its own but its backups are managed on
// Backup.
function serviceManageTarget(name: string): { label: string; target: string } {
  if (SERVICES_OSMO.includes(name)) return { label: 'SMS', target: 'sms' };
  if (name === 'mongodb') return { label: 'Backup', target: 'backup' };
  return { label: 'Config', target: 'config' };
}

// ── Shared row shape ─────────────────────────────────────────────────────
// One flexible row renderer for every kind of thing this page shows —
// systemd-unit NFs with full detail (PID/uptime/mem/restarts + boot-enable),
// Chrony and OpenSpeedTest with partial detail, and VectorCore's paired
// units with only a status dot (their lifecycle is controlled elsewhere —
// see the comment on VECTORCORE ROWS below for why). '—' fills in whatever
// a given row's data source doesn't provide, rather than omitting columns
// per-row, so the table stays a single consistent grid.

interface RowBadge { label: string; icon?: React.ReactNode; color: string }

interface ServiceRowData {
  key: string;
  name: string;
  unitName?: string;
  badge?: RowBadge;
  subtitle?: string; // e.g. chrony's sync source, speedtest's bind address
  active: boolean | 'loading';
  stateLabel?: string; // overrides the default active/inactive pill text
  installed?: boolean; // false = "not installed" pill instead of active/inactive
  enabled?: boolean; // undefined = no boot-enable control for this row
  onToggleEnabled?: () => void;
  pid?: number | null;
  uptime?: string | null;
  memoryBytes?: number | null;
  restartCount?: number | null;
  acting?: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
  manageLabel?: string;
  onManage?: () => void;
  extraAction?: { icon: React.ReactNode; label: string; onClick: () => void };
}

function ServiceRow({ row }: { row: ServiceRowData }): JSX.Element {
  const loading = row.active === 'loading';
  const active = row.active === true;
  return (
    <tr className="border-b border-nms-border/50 hover:bg-nms-surface-2/40 transition-colors">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className={loading ? 'status-dot-inactive opacity-40' : active ? 'status-dot-active' : 'status-dot-inactive'} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold font-display text-nms-text">{row.name}</span>
              {row.badge && (
                <span className={clsx('inline-flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 font-semibold border', row.badge.color)}>
                  {row.badge.icon}{row.badge.label}
                </span>
              )}
            </div>
            {row.unitName && <p className="text-xs text-nms-text-dim font-mono truncate">{row.unitName}</p>}
            {row.subtitle && <p className="text-xs text-nms-text-dim truncate">{row.subtitle}</p>}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={clsx('text-xs px-2 py-1 rounded-full whitespace-nowrap',
          loading ? 'bg-nms-surface text-nms-text-dim'
            : row.installed === false ? 'bg-amber-500/10 text-amber-400'
            : active ? 'bg-nms-green/10 text-nms-green' : 'bg-nms-red/10 text-nms-red')}>
          {loading ? '…' : row.installed === false ? 'not installed' : (row.stateLabel ?? (active ? 'active' : 'inactive'))}
        </span>
      </td>
      <td className="px-3 py-2.5 text-xs text-nms-text-dim font-mono">{row.pid ?? '—'}</td>
      <td className="px-3 py-2.5 text-xs text-nms-text-dim font-mono whitespace-nowrap">{row.uptime ?? '—'}</td>
      <td className="px-3 py-2.5 text-xs text-nms-text-dim font-mono whitespace-nowrap">{formatBytes(row.memoryBytes)}</td>
      <td className="px-3 py-2.5 text-xs text-nms-text-dim font-mono">{row.restartCount ?? '—'}</td>
      <td className="px-3 py-2.5">
        {row.enabled !== undefined ? (
          <button
            onClick={row.onToggleEnabled}
            disabled={row.acting}
            className={clsx('p-1 rounded-full', row.enabled ? 'bg-nms-accent/10 text-nms-accent' : 'bg-gray-500/10 text-gray-500')}
            title={row.enabled ? 'Disable at boot' : 'Enable at boot'}
          >
            {row.enabled ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
          </button>
        ) : <span className="text-xs text-nms-text-dim">—</span>}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1.5 flex-wrap">
          {row.onStart && (
            <button onClick={row.onStart} disabled={row.acting || active} className="nms-btn-ghost text-xs flex items-center gap-1 px-2 py-1">
              <Play className="w-3 h-3" /> Start
            </button>
          )}
          {row.onStop && (
            <button onClick={row.onStop} disabled={row.acting || !active} className="nms-btn-ghost text-xs flex items-center gap-1 px-2 py-1 text-red-400">
              <Square className="w-3 h-3" /> Stop
            </button>
          )}
          {row.onRestart && (
            <button onClick={row.onRestart} disabled={row.acting} className="nms-btn-ghost text-xs flex items-center gap-1 px-2 py-1">
              <RotateCw className="w-3 h-3" /> Restart
            </button>
          )}
          {row.extraAction && (
            <button onClick={row.extraAction.onClick} className="nms-btn-ghost text-xs flex items-center gap-1 px-2 py-1" title={row.extraAction.label}>
              {row.extraAction.icon}
            </button>
          )}
          {row.onManage && (
            <button onClick={row.onManage} className="text-xs text-nms-accent hover:underline px-1">
              {row.manageLabel ?? 'Manage'} →
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function ServiceTable({ rows }: { rows: ServiceRowData[] }): JSX.Element {
  return (
    <div className="nms-card p-0 overflow-hidden overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider bg-nms-surface-2 border-b border-nms-border">
            <th className="px-3 py-2.5">Service</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">PID</th>
            <th className="px-3 py-2.5">Uptime</th>
            <th className="px-3 py-2.5">Memory</th>
            <th className="px-3 py-2.5">Restarts</th>
            <th className="px-3 py-2.5">Boot</th>
            <th className="px-3 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => <ServiceRow key={row.key} row={row} />)}
        </tbody>
      </table>
    </div>
  );
}

function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <div className={`flex items-center gap-3 pb-1 border-b border-nms-border mb-4`}>
      <span className={`text-xs font-semibold uppercase tracking-widest ${color}`}>{label}</span>
      <div className="flex-1" />
    </div>
  );
}

interface SpeedTestStatus {
  running: boolean;
  settings: { bindIp: string; httpPort: number; httpsPort: number; enableHttps: boolean };
}
interface SnmpServiceStatus { installed: boolean; active: boolean; enabled: boolean; port: number }

export function ServicesPage({ onNavigate }: { onNavigate?: (tab: string) => void }): JSX.Element {
  const statuses = useServiceStore((s) => s.statuses);
  const fetchStatuses = useServiceStore((s) => s.fetchStatuses);
  const [bulkActing, setBulkActing] = useState(false);
  const [acting4G, setActing4G] = useState(false);
  const [acting5G, setActing5G] = useState(false);
  const [actingByName, setActingByName] = useState<Record<string, boolean>>({});
  const [chrony, setChrony] = useState<{ installed: boolean; active: boolean; refSource?: string } | null>(null);
  const [chronyActing, setChronyActing] = useState(false);
  const [vowifiStatus, setVowifiStatus] = useState<VowifiStatus | null>(null);
  const [mmsStatus, setMmsStatus] = useState<MmsStatus | null>(null);
  const [vectorcoreSmscStatus, setVectorcoreSmscStatus] = useState<VectorcoreSmscStatus | null>(null);
  const [speedtest, setSpeedtest] = useState<SpeedTestStatus | null>(null);
  const [speedtestActing, setSpeedtestActing] = useState(false);
  const [showSpeedtestModal, setShowSpeedtestModal] = useState(false);
  const [snmp, setSnmp] = useState<SnmpServiceStatus | null>(null);
  const [snmpActing, setSnmpActing] = useState(false);

  const API = import.meta.env.VITE_API_URL || '/api';

  const fetchChrony = () => {
    axios.get(`${API}/chrony/status`)
      .then(r => setChrony({ installed: r.data.installed, active: r.data.active, refSource: r.data.tracking?.refSource || '' }))
      .catch(() => {});
  };

  const fetchSpeedtest = () => {
    axios.get(`${API}/speedtest/status`)
      .then(r => setSpeedtest({ running: r.data.running, settings: r.data.settings }))
      .catch(() => {});
  };
  const fetchSnmp = () => axios.get(`${API}/snmp/status`).then(r => setSnmp(r.data)).catch(() => {});

  useEffect(() => {
    fetchChrony();
    fetchSpeedtest();
    fetchSnmp();
    // VectorCore (VoWiFi ePDG/AAA, MMS MMSC/MM1 proxy) status for the
    // VectorCore section below — see the VECTORCORE ROWS comment for why
    // these are read-only here rather than independently start/stop/restart-able.
    vowifiApi.getStatus().then(setVowifiStatus).catch(() => {});
    mmsApi.getStatus().then(setMmsStatus).catch(() => {});
    vectorcoreSmscApi.getStatus().then(setVectorcoreSmscStatus).catch(() => {});
  }, []);

  const handleChronyAction = async (action: 'start' | 'stop' | 'restart') => {
    setChronyActing(true);
    try {
      await axios.post(`${API}/chrony/${action}`);
      toast.success(`Chrony ${action} successful`);
      setTimeout(fetchChrony, 2000);
    } catch (err: any) {
      toast.error(`Chrony ${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setChronyActing(false);
    }
  };

  // Quick start/stop from the table uses whatever settings were last saved
  // (defaults to all-interfaces on first run) — the modal (via "Configure")
  // is where an operator picks a specific bind IP, e.g. a DNN gateway.
  const handleSpeedtestAction = async (action: 'start' | 'stop') => {
    setSpeedtestActing(true);
    try {
      if (action === 'start') {
        const { data } = await axios.post(`${API}/speedtest/start`, speedtest?.settings ?? {});
        if (data.success) {
          toast.success(`OpenSpeedTest started on ${data.settings.bindIp}:${data.settings.httpPort}`);
          setSpeedtest({ running: true, settings: data.settings });
        } else {
          toast.error(data.error || 'Failed to start OpenSpeedTest');
        }
      } else {
        await axios.post(`${API}/speedtest/stop`);
        toast.success('OpenSpeedTest stopped');
        setSpeedtest(s => s ? { ...s, running: false } : s);
      }
    } catch (err: any) {
      toast.error(`OpenSpeedTest ${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSpeedtestActing(false);
    }
  };

  // Derive running state for 4G and 5G groups
  const is5GAnyRunning = statuses.some(s => SERVICES_5G.includes(s.name) && s.active);
  const is4GAnyRunning = statuses.some(s => SERVICES_4G.includes(s.name) && s.active);

  const doBulkAction = async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
    if (!confirm(`Are you sure you want to ${action} ALL services?`)) return;
    setBulkActing(true);
    try {
      const result = await serviceApi.bulkAction(action);
      if (result.success) toast.success(`All services ${action} successful`);
      else toast.error(result.message);
      await fetchStatuses();
    } catch { toast.error(`Failed to ${action} all services`); }
    finally { setBulkActing(false); }
  };

  const doGroupToggle = async (group: '4g' | '5g'): Promise<void> => {
    const services = group === '5g' ? SERVICES_5G : SERVICES_4G;
    const anyRunning = group === '5g' ? is5GAnyRunning : is4GAnyRunning;
    const action = anyRunning ? 'stop' : 'start';
    const label = group.toUpperCase();

    if (!confirm(`${anyRunning ? 'Stop' : 'Start'} all ${label} services?`)) return;

    if (group === '5g') setActing5G(true);
    else setActing4G(true);

    try {
      const result = await serviceApi.bulkAction(action, services);
      if (result.success) toast.success(`${label} services ${action} successful`);
      else toast.error(result.message);
      await fetchStatuses();
    } catch { toast.error(`Failed to ${action} ${label} services`); }
    finally {
      if (group === '5g') setActing5G(false);
      else setActing4G(false);
    }
  };

  const doServiceAction = async (name: string, action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'): Promise<void> => {
    setActingByName(a => ({ ...a, [name]: true }));
    try {
      const result = await serviceApi.action(name, action);
      if (result.success) {
        toast.success(`${name.toUpperCase()} ${action} successful`);
        await fetchStatuses();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error(`Failed to ${action} ${name}`);
    } finally {
      setActingByName(a => ({ ...a, [name]: false }));
    }
  };

  // Systemd-unit-backed rows (core-17 NFs + Osmocom) — full detail, start/
  // stop/restart, boot-enable toggle, and a link to wherever this service
  // is actually configured.
  const serviceRow = (s: ServiceStatus): ServiceRowData => {
    const { label, target } = serviceManageTarget(s.name);
    return {
      key: s.name,
      name: s.name.toUpperCase(),
      unitName: s.unitName,
      badge: s.source === 'docker' ? { label: 'docker', icon: <Container className="w-2.5 h-2.5" />, color: 'bg-blue-500/10 text-blue-400 border-blue-500/20' } : undefined,
      active: s.active,
      stateLabel: `${s.state}/${s.subState}`,
      enabled: s.enabled,
      onToggleEnabled: () => doServiceAction(s.name, s.enabled ? 'disable' : 'enable'),
      pid: s.pid,
      uptime: formatUptime(s.uptime),
      memoryBytes: s.memoryBytes,
      restartCount: s.restartCount,
      acting: !!actingByName[s.name],
      onStart: () => doServiceAction(s.name, 'start'),
      onStop: () => doServiceAction(s.name, 'stop'),
      onRestart: () => doServiceAction(s.name, 'restart'),
      manageLabel: label,
      onManage: () => onNavigate?.(target),
    };
  };

  const chronyRow: ServiceRowData = {
    key: 'chrony',
    name: 'CHRONY',
    unitName: 'chrony.service',
    badge: { label: 'ntp', color: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
    subtitle: chrony?.refSource ? `Synced to: ${chrony.refSource}` : (chrony && !chrony.installed ? 'Not installed — click to install' : undefined),
    active: !chrony ? 'loading' : chrony.active,
    installed: chrony?.installed,
    acting: chronyActing,
    onStart: () => handleChronyAction('start'),
    onStop: () => handleChronyAction('stop'),
    onRestart: () => handleChronyAction('restart'),
    manageLabel: 'Time Server',
    onManage: () => onNavigate?.('time-server'),
  };

  // VECTORCORE ROWS — VectorCore's four systemd units (VoWiFi's ePDG+AAA,
  // MMS's MMSC+MM1 proxy) aren't in SERVICE_UNIT_MAP — they're only
  // independently controllable as pairs via VoWiFi/MMS's own module-level
  // start/stop/restart (which acts on both units in each pair together, not
  // one at a time), so per-row start/stop/restart here would misleadingly
  // imply a control this page can't actually offer independently. Read-only
  // status + a link to the module that actually owns lifecycle control.
  const vectorCoreRow = (name: string, unitName: string, active: boolean, loading: boolean, module: string, navTarget: string): ServiceRowData => ({
    key: unitName,
    name,
    unitName,
    active: loading ? 'loading' : active,
    manageLabel: module,
    onManage: () => onNavigate?.(navTarget),
  });

  const speedtestRow: ServiceRowData = {
    key: 'speedtest',
    name: 'OPENSPEEDTEST',
    badge: { label: 'tool', icon: <Gauge className="w-2.5 h-2.5" />, color: 'bg-pink-500/10 text-pink-400 border-pink-500/20' },
    subtitle: speedtest?.running ? `${speedtest.settings.bindIp}:${speedtest.settings.httpPort}` : 'Temporary throughput-test container',
    active: !speedtest ? 'loading' : speedtest.running,
    acting: speedtestActing,
    onStart: () => handleSpeedtestAction('start'),
    onStop: () => handleSpeedtestAction('stop'),
    extraAction: { icon: <Settings2 className="w-3 h-3" />, label: 'Configure bind IP / ports', onClick: () => setShowSpeedtestModal(true) },
  };
  const snmpAction = async (action: 'start'|'stop'|'restart') => {
    setSnmpActing(true); try { await axios.post(`${API}/snmp/${action}`); toast.success(`SNMP ${action} successful`); await fetchSnmp(); }
    catch { toast.error(`SNMP ${action} failed`); } finally { setSnmpActing(false); }
  };
  const snmpRow: ServiceRowData = {
    key:'snmpd', name:'SNMPD', unitName:'snmpd.service', badge:{label:'monitoring',color:'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'},
    subtitle: snmp?.installed ? `Net-SNMP agent · UDP/${snmp.port}` : 'Install from SNMP Monitoring', active: !snmp?'loading':snmp.active,
    installed:snmp?.installed, enabled:snmp?.installed?snmp.enabled:undefined, acting:snmpActing,
    onStart:snmp?.installed?()=>snmpAction('start'):undefined, onStop:snmp?.installed?()=>snmpAction('stop'):undefined, onRestart:snmp?.installed?()=>snmpAction('restart'):undefined,
    manageLabel:'SNMP Monitoring', onManage:()=>onNavigate?.('snmp'),
  };

  return (
    <div className="p-6 space-y-6">
      {showSpeedtestModal && (
        <SpeedTestServerModal onClose={() => { setShowSpeedtestModal(false); fetchSpeedtest(); }} />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-display">Services</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Manage Open5GS network function services
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* 5G group toggle */}
          <button
            onClick={() => doGroupToggle('5g')}
            disabled={acting5G || bulkActing}
            className={clsx(
              'flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border transition-all',
              is5GAnyRunning
                ? 'bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20'
                : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text',
            )}
            title={is5GAnyRunning ? 'Stop all 5G services' : 'Start all 5G services'}
          >
            <Wifi className="w-4 h-4" />
            {acting5G ? '...' : is5GAnyRunning ? 'Stop 5G' : 'Start 5G'}
          </button>

          {/* 4G group toggle */}
          <button
            onClick={() => doGroupToggle('4g')}
            disabled={acting4G || bulkActing}
            className={clsx(
              'flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border transition-all',
              is4GAnyRunning
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20'
                : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text',
            )}
            title={is4GAnyRunning ? 'Stop all 4G services' : 'Start all 4G services'}
          >
            <Radio className="w-4 h-4" />
            {acting4G ? '...' : is4GAnyRunning ? 'Stop 4G' : 'Start 4G'}
          </button>

          <div className="w-px bg-nms-border mx-1" />

          <button
            onClick={() => doBulkAction('start')}
            disabled={bulkActing}
            className="nms-btn-ghost flex items-center gap-2"
          >
            <Play className="w-4 h-4" /> Start All
          </button>
          <button
            onClick={() => doBulkAction('stop')}
            disabled={bulkActing}
            className="nms-btn-danger flex items-center gap-2"
          >
            <Square className="w-4 h-4" /> Stop All
          </button>
          <button
            onClick={() => doBulkAction('restart')}
            disabled={bulkActing}
            className="nms-btn-primary flex items-center gap-2"
          >
            <Zap className="w-4 h-4" /> Restart All
          </button>
        </div>
      </div>

      {/* Loading skeleton */}
      {statuses.length === 0 && (
        <div className="nms-card animate-pulse">
          <div className="h-32 flex items-center justify-center text-nms-text-dim text-sm">
            Loading services...
          </div>
        </div>
      )}

      {/* 5G Core */}
      {statuses.some(s => SERVICES_5G.includes(s.name)) && (
        <div>
          <SectionHeader label="5G Core" color="text-blue-400" />
          <ServiceTable rows={statuses.filter(s => SERVICES_5G.includes(s.name)).map(serviceRow)} />
        </div>
      )}

      {/* 4G EPC */}
      {statuses.some(s => SERVICES_4G.includes(s.name)) && (
        <div>
          <SectionHeader label="4G EPC" color="text-amber-400" />
          <ServiceTable rows={statuses.filter(s => SERVICES_4G.includes(s.name)).map(serviceRow)} />
        </div>
      )}

      {/* Shared 4G + 5G */}
      {statuses.some(s => SERVICES_SHARED.includes(s.name)) && (
        <div>
          <SectionHeader label="Shared 4G + 5G" color="text-purple-400" />
          <ServiceTable rows={statuses.filter(s => SERVICES_SHARED.includes(s.name)).map(serviceRow)} />
        </div>
      )}

      {/* Osmocom + Chrony */}
      <div>
        <SectionHeader label="Osmocom" color="text-cyan-400" />
        <ServiceTable rows={[
          chronyRow,
          ...statuses.filter(s => SERVICES_OSMO.includes(s.name)).map(serviceRow),
        ]} />
        {!chrony?.installed && (
          <button
            onClick={() => onNavigate?.('time-server')}
            className="flex items-center gap-2 text-xs text-amber-400 hover:text-amber-300 mt-2"
          >
            <AlertCircle className="w-3.5 h-3.5" />
            Chrony not installed — click to install
          </button>
        )}
      </div>

      {/* VectorCore */}
      <div>
        <SectionHeader label="VectorCore" color="text-pink-400" />
        <ServiceTable rows={[
          vectorCoreRow('EPDG', 'vowifi-vectorcore-epdg', !!vowifiStatus?.services?.['vowifi-vectorcore-epdg'], !vowifiStatus, 'VoWiFi', 'vowifi'),
          vectorCoreRow('AAA', 'vowifi-vectorcore-aaa', !!vowifiStatus?.services?.['vowifi-vectorcore-aaa'], !vowifiStatus, 'VoWiFi', 'vowifi'),
          vectorCoreRow('MMSC', 'vectorcore-mmsc', !!mmsStatus?.serviceActive, !mmsStatus, 'SMS/MMS', 'sms'),
          vectorCoreRow('MM1 PROXY', 'vectorcore-mm1-proxy', !!mmsStatus?.proxyActive, !mmsStatus, 'SMS/MMS', 'sms'),
          vectorCoreRow('SMSC', 'vectorcore-smsc', !!vectorcoreSmscStatus?.serviceActive, !vectorcoreSmscStatus, 'SMS/MMS', 'sms'),
        ]} />
      </div>

      {/* Tools */}
      <div>
        <SectionHeader label="Tools" color="text-pink-400" />
        <ServiceTable rows={[snmpRow, speedtestRow]} />
      </div>
    </div>
  );
}
