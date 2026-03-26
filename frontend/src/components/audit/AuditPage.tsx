import { useEffect, useState } from 'react';
import { RefreshCw, Check, X } from 'lucide-react';
import { auditApi } from '../../api';
import type { AuditLogEntry } from '../../types';

export function AuditPage(): JSX.Element {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');

  const fetchLogs = async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await auditApi.getAll(0, 200, filter || undefined);
      setEntries(data.entries);
      setTotal(data.total);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [filter]);

  const actionColors: Record<string, string> = {
    config_apply: 'text-nms-accent bg-nms-accent/10',
    config_rollback: 'text-nms-red bg-nms-red/10',
    config_load: 'text-nms-text-dim bg-nms-surface-2',
    service_restart: 'text-nms-amber bg-nms-amber/10',
    service_start: 'text-nms-green bg-nms-green/10',
    service_stop: 'text-nms-red bg-nms-red/10',
    subscriber_create: 'text-nms-green bg-nms-green/10',
    subscriber_update: 'text-nms-accent bg-nms-accent/10',
    subscriber_delete: 'text-nms-red bg-nms-red/10',
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-display">Audit Log</h1>
          <p className="text-sm text-nms-text-dim mt-1">{total} entries</p>
        </div>
        <button onClick={fetchLogs} className="nms-btn-ghost flex items-center gap-2">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
        {['', 'config_apply', 'config_rollback', 'service_restart', 'subscriber_create', 'subscriber_delete'].map(
          (f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                filter === f
                  ? 'bg-nms-accent/20 text-nms-accent'
                  : 'bg-nms-surface-2 text-nms-text-dim hover:text-nms-text'
              }`}
            >
              {f || 'All'}
            </button>
          ),
        )}
      </div>

      {/* Log entries */}
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="nms-card flex items-start gap-4 animate-fade-in">
            <div className="mt-0.5">
              {entry.success ? (
                <div className="w-6 h-6 rounded-full bg-nms-green/10 flex items-center justify-center">
                  <Check className="w-3.5 h-3.5 text-nms-green" />
                </div>
              ) : (
                <div className="w-6 h-6 rounded-full bg-nms-red/10 flex items-center justify-center">
                  <X className="w-3.5 h-3.5 text-nms-red" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                    actionColors[entry.action] || 'text-nms-text-dim bg-nms-surface-2'
                  }`}
                >
                  {entry.action}
                </span>
                {entry.target && (
                  <span className="text-xs text-nms-text-dim font-mono">{entry.target}</span>
                )}
              </div>
              {entry.details && (
                <p className="text-xs text-nms-text-dim truncate">{entry.details}</p>
              )}
            </div>
            <div className="text-[10px] text-nms-text-dim/60 font-mono whitespace-nowrap">
              {new Date(entry.timestamp).toLocaleString()}
            </div>
          </div>
        ))}

        {entries.length === 0 && !loading && (
          <div className="text-center py-12 text-nms-text-dim">No audit log entries found</div>
        )}

        {loading && (
          <div className="text-center py-12 text-nms-text-dim">Loading...</div>
        )}
      </div>
    </div>
  );
}
