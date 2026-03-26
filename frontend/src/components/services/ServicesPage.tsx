import { useState } from 'react';
import {
  Play,
  Square,
  RotateCw,
  HardDrive,
  Clock,
  Hash,
  RefreshCcw,
  Power,
  PowerOff,
  Zap,
} from 'lucide-react';
import { useServiceStore } from '../../stores';
import { serviceApi } from '../../api';
import type { ServiceStatus } from '../../types';
import toast from 'react-hot-toast';

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

  const doAction = async (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'): Promise<void> => {
    setActing(true);
    try {
      const result = await serviceApi.action(status.name, action);
      if (result.success) {
        toast.success(`${status.name.toUpperCase()} ${action} successful`);
        window.location.reload();
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
            <h3 className="text-base font-semibold font-display">{status.name.toUpperCase()}</h3>
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

export function ServicesPage(): JSX.Element {
  const statuses = useServiceStore((s) => s.statuses);
  const [bulkActing, setBulkActing] = useState(false);

  const doBulkAction = async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
    if (!confirm(`Are you sure you want to ${action} ALL services?`)) return;
    
    setBulkActing(true);
    try {
      const result = await serviceApi.bulkAction(action);
      if (result.success) {
        toast.success(`All services ${action} successful`);
      } else {
        toast.error(result.message);
      }
      window.location.reload();
    } catch (err) {
      toast.error(`Failed to ${action} all services`);
    } finally {
      setBulkActing(false);
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
        <div className="flex gap-2">
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
