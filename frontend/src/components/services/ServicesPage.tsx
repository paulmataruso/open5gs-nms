import { useState, useEffect } from 'react';
import {
  Play, Square, RotateCw, HardDrive, Clock, Hash,
  RefreshCcw, Power, PowerOff, Zap, Radio, Wifi, Container, AlertCircle,
} from 'lucide-react';
import { useServiceStore } from '../../stores';
import { serviceApi } from '../../api';
import type { ServiceStatus } from '../../types';
import axios from 'axios';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

// In Open5GS 2.7+, SMF absorbed PGW-c and UPF absorbed PGW-u.
// SMF and UPF are shared between 4G and 5G — do NOT include them in the 5G-only group.
// Stopping "5G" should only stop the 5G-specific NFs, leaving SMF/UPF running for 4G.
const SERVICES_5G = ['nrf', 'scp', 'amf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf'];
const SERVICES_4G = ['mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatUptime(timestamp: string | null): string {
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

function ServiceCard({ status }: { status: ServiceStatus }): JSX.Element {
  const [acting, setActing] = useState(false);
  const fetchStatuses = useServiceStore((s) => s.fetchStatuses);

  const doAction = async (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'): Promise<void> => {
    setActing(true);
    try {
      const result = await serviceApi.action(status.name, action);
      if (result.success) {
        toast.success(`${status.name.toUpperCase()} ${action} successful`);
        await fetchStatuses();
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(`Failed to ${action} ${status.name}`);
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="nms-card animate-fade-in">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={status.active ? 'status-dot-active' : 'status-dot-inactive'} />
          <div>
            <h3 className="text-base font-semibold font-display flex items-center gap-2">
              {status.name.toUpperCase()}
              {status.source === 'docker' && (
                <span className="inline-flex items-center gap-1 text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded px-1.5 py-0.5 font-semibold">
                  <Container className="w-2.5 h-2.5" /> docker
                </span>
              )}
            </h3>
            <p className="text-xs text-nms-text-dim font-mono">{status.unitName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2 py-1 rounded-full ${
              status.active
                ? 'bg-nms-green/10 text-nms-green'
                : 'bg-nms-red/10 text-nms-red'
            }`}
          >
            {status.state}/{status.subState}
          </span>
          <button
            onClick={() => doAction(status.enabled ? 'disable' : 'enable')}
            disabled={acting}
            className={`text-xs px-2 py-1 rounded-full ${
              status.enabled
                ? 'bg-nms-accent/10 text-nms-accent'
                : 'bg-gray-500/10 text-gray-500'
            }`}
            title={status.enabled ? 'Disable at boot' : 'Enable at boot'}
          >
            {status.enabled ? <Power className="w-3 h-3" /> : <PowerOff className="w-3 h-3" />}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="flex items-center gap-2 text-xs text-nms-text-dim">
          <Hash className="w-3.5 h-3.5" />
          <span>PID: {status.pid ?? '—'}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-nms-text-dim">
          <Clock className="w-3.5 h-3.5" />
          <span>Up: {formatUptime(status.uptime)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-nms-text-dim">
          <HardDrive className="w-3.5 h-3.5" />
          <span>Mem: {formatBytes(status.memoryBytes)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-nms-text-dim">
          <RefreshCcw className="w-3.5 h-3.5" />
          <span>Restarts: {status.restartCount}</span>
        </div>
      </div>

      <div className="flex gap-2 pt-3 border-t border-nms-border">
        <button
          onClick={() => doAction('start')}
          disabled={acting || status.active}
          className="nms-btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center"
        >
          <Play className="w-3.5 h-3.5" /> Start
        </button>
        <button
          onClick={() => doAction('stop')}
          disabled={acting || !status.active}
          className="nms-btn-danger flex items-center gap-1.5 text-xs flex-1 justify-center"
        >
          <Square className="w-3.5 h-3.5" /> Stop
        </button>
        <button
          onClick={() => doAction('restart')}
          disabled={acting}
          className="nms-btn-primary flex items-center gap-1.5 text-xs flex-1 justify-center"
        >
          <RotateCw className="w-3.5 h-3.5" /> Restart
        </button>
      </div>
    </div>
  );
}

export function ServicesPage({ onNavigate }: { onNavigate?: (tab: string) => void }): JSX.Element {
  const statuses = useServiceStore((s) => s.statuses);
  const fetchStatuses = useServiceStore((s) => s.fetchStatuses);
  const [bulkActing, setBulkActing] = useState(false);
  const [acting4G, setActing4G] = useState(false);
  const [acting5G, setActing5G] = useState(false);
  const [chrony, setChrony] = useState<{ installed: boolean; active: boolean; refSource?: string } | null>(null);
  const [chronyActing, setChronyActing] = useState(false);

  const API = import.meta.env.VITE_API_URL || '/api';

  const fetchChrony = () => {
    axios.get(`${API}/chrony/status`)
      .then(r => setChrony({ installed: r.data.installed, active: r.data.active, refSource: r.data.tracking?.refSource || '' }))
      .catch(() => {});
  };

  useEffect(() => { fetchChrony(); }, []);

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

  return (
    <div className="p-6 space-y-6">
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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* Chrony / Time Server card */}
        <div className="nms-card animate-fade-in">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className={chrony?.active ? 'status-dot-active' : 'status-dot-inactive'} />
              <div>
                <h3 className="text-base font-semibold font-display flex items-center gap-2">
                  CHRONY
                  <span className="inline-flex items-center gap-1 text-[10px] bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 rounded px-1.5 py-0.5 font-semibold">
                    <Clock className="w-2.5 h-2.5" /> ntp
                  </span>
                </h3>
                <p className="text-xs text-nms-text-dim font-mono">chrony.service</p>
              </div>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full ${
              !chrony ? 'bg-nms-surface text-nms-text-dim' :
              !chrony.installed ? 'bg-amber-500/10 text-amber-400' :
              chrony.active ? 'bg-nms-green/10 text-nms-green' : 'bg-nms-red/10 text-nms-red'
            }`}>
              {!chrony ? '…' : !chrony.installed ? 'not installed' : chrony.active ? 'active/running' : 'inactive/dead'}
            </span>
          </div>
          {!chrony?.installed && (
            <div className="flex items-center gap-2 text-xs text-amber-400 mb-3 cursor-pointer hover:text-amber-300" onClick={() => onNavigate?.('time-server')}>
              <AlertCircle className="w-3.5 h-3.5" />
              Not installed — click to install
            </div>
          )}
          {chrony?.refSource && (
            <p className="text-xs text-nms-text-dim font-mono mb-3">
              Synced to: <span className="text-nms-text">{chrony.refSource}</span>
            </p>
          )}
          <div className="flex gap-2 pt-3 border-t border-nms-border">
            <button onClick={() => handleChronyAction('start')} disabled={chronyActing || chrony?.active || !chrony?.installed}
              className="nms-btn-ghost flex items-center gap-1.5 text-xs flex-1 justify-center">
              <Play className="w-3.5 h-3.5" /> Start
            </button>
            <button onClick={() => handleChronyAction('stop')} disabled={chronyActing || !chrony?.active}
              className="nms-btn-danger flex items-center gap-1.5 text-xs flex-1 justify-center">
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
            <button onClick={() => handleChronyAction('restart')} disabled={chronyActing || !chrony?.installed}
              className="nms-btn-primary flex items-center gap-1.5 text-xs flex-1 justify-center">
              <RotateCw className="w-3.5 h-3.5" /> Restart
            </button>
          </div>
        </div>

        {statuses.map((s) => (
          <ServiceCard key={s.name} status={s} />
        ))}
        {statuses.length === 0 &&
          ['NRF', 'AMF', 'SMF', 'UPF', 'AUSF'].map((name) => (
            <div key={name} className="nms-card animate-pulse">
              <div className="h-32 flex items-center justify-center text-nms-text-dim text-sm">
                Loading {name}...
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
