import { useEffect, useState } from 'react';
import { Activity, Users, Wifi, AlertTriangle, Play, Square, Zap } from 'lucide-react';
import { useServiceStore, useSubscriberStore } from '../../stores';
import { configApi, healthApi, serviceApi } from '../../api';
import type { ValidationResult, ServiceStatus } from '../../types';
import toast from 'react-hot-toast';

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  subValue?: string;
  color: string;
}): JSX.Element {
  return (
    <div className="nms-card animate-fade-in">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-nms-text-dim uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-semibold font-display mt-1">{value}</p>
          {subValue && <p className="text-xs text-nms-text-dim mt-1">{subValue}</p>}
        </div>
        <div className={`p-2.5 rounded-lg bg-${color}/10`}>
          <Icon className={`w-5 h-5 text-${color}`} />
        </div>
      </div>
    </div>
  );
}

function ServiceMiniCard({ status }: { status: ServiceStatus }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-2.5 px-3 rounded-md bg-nms-bg/50">
      <div className="flex items-center gap-3">
        <div className={status.active ? 'status-dot-active' : 'status-dot-inactive'} />
        <div>
          <span className="text-sm font-medium">{status.name.toUpperCase()}</span>
          <span className="text-xs text-nms-text-dim ml-2">{status.unitName}</span>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-nms-text-dim">
        {status.pid && <span>PID {status.pid}</span>}
        {status.memoryBytes && <span>{formatBytes(status.memoryBytes)}</span>}
        <span className={status.active ? 'text-nms-green' : 'text-nms-red'}>
          {status.state}
        </span>
      </div>
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const statuses = useServiceStore((s) => s.statuses) || [];
  const fetchStatuses = useServiceStore((s) => s.fetchStatuses);
  const fetchSubscribers = useSubscriberStore((s) => s.fetchSubscribers);
  const subscriberTotal = useSubscriberStore((s) => s.total);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [health, setHealth] = useState<{ status: string; wsConnections: number } | null>(null);
  const [bulkActing, setBulkActing] = useState(false);

  useEffect(() => {
    fetchStatuses();
    fetchSubscribers();
    configApi.validate().then(setValidation).catch(() => {});
    healthApi.check().then(setHealth).catch(() => {});
  }, [fetchStatuses, fetchSubscribers]);

  const activeCount = statuses.filter((s) => s.active).length;
  const totalCount = statuses.length || 5;
  const errorCount = validation?.errors?.filter((e) => e.severity === 'error').length || 0;

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-display">Dashboard</h1>
          <p className="text-sm text-nms-text-dim mt-1">Open5GS 5G Core Network Overview</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => doBulkAction('start')}
            disabled={bulkActing}
            className="nms-btn-ghost flex items-center gap-2 text-sm"
          >
            <Play className="w-4 h-4" /> Start All
          </button>
          <button
            onClick={() => doBulkAction('stop')}
            disabled={bulkActing}
            className="nms-btn-danger flex items-center gap-2 text-sm"
          >
            <Square className="w-4 h-4" /> Stop All
          </button>
          <button
            onClick={() => doBulkAction('restart')}
            disabled={bulkActing}
            className="nms-btn-primary flex items-center gap-2 text-sm"
          >
            <Zap className="w-4 h-4" /> Restart All
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Activity}
          label="Active Services"
          value={`${activeCount}/${totalCount}`}
          subValue={activeCount === totalCount ? 'All services operational' : 'Some services down'}
          color={activeCount === totalCount ? 'nms-green' : 'nms-amber'}
        />
        <StatCard
          icon={Users}
          label="Subscribers"
          value={subscriberTotal}
          subValue="Total provisioned"
          color="nms-accent"
        />
        <StatCard
          icon={AlertTriangle}
          label="Config Issues"
          value={errorCount}
          subValue={errorCount === 0 ? 'No issues found' : 'Review required'}
          color={errorCount === 0 ? 'nms-green' : 'nms-red'}
        />
        <StatCard
          icon={Wifi}
          label="WS Connections"
          value={health?.wsConnections ?? 0}
          subValue={health?.status === 'ok' ? 'Backend healthy' : 'Checking...'}
          color="nms-accent"
        />
      </div>

      {/* Service Status Table */}
      <div className="nms-card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold font-display uppercase tracking-wider text-nms-text-dim">
            Network Functions
          </h2>
          <div className="flex items-center gap-2">
            <div className="status-dot-active" />
            <span className="text-xs text-nms-text-dim">{activeCount} active</span>
          </div>
        </div>
        <div className="space-y-1">
          {statuses.length > 0 ? (
            statuses.map((s) => <ServiceMiniCard key={s.name} status={s} />)
          ) : (
            <div className="text-center py-8 text-nms-text-dim text-sm">
              Loading service statuses...
            </div>
          )}
        </div>
      </div>

      {/* Validation Warnings */}
      {validation && validation.errors && validation.errors.length > 0 && (
        <div className="nms-card border-nms-amber/30">
          <h2 className="text-sm font-semibold font-display uppercase tracking-wider text-nms-amber mb-3">
            Configuration Validation
          </h2>
          <div className="space-y-2">
            {validation.errors.slice(0, 10).map((err, i) => (
              <div
                key={i}
                className={`text-xs px-3 py-2 rounded ${
                  err.severity === 'error'
                    ? 'bg-nms-red/10 text-nms-red'
                    : 'bg-nms-amber/10 text-nms-amber'
                }`}
              >
                <span className="font-mono">{err.field}</span>: {err.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
