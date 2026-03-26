import { useState, useMemo } from 'react';
import { RotateCw, Trash2, CheckSquare, Square, Circle } from 'lucide-react';
import { useLogStream, LogEntry } from '../hooks/useLogStream';

const ALL_SERVICES = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];

export const LogsPage: React.FC = () => {
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [maxLines, setMaxLines] = useState(1000);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);

  // Memoize services array to prevent re-subscription on every render
  const servicesArray = useMemo(() => Array.from(selectedServices), [selectedServices]);

  const { logs, connected, clearLogs, logContainerRef } = useLogStream({
    services: servicesArray,
    maxLines,
    autoScroll,
    paused,
  });

  const toggleService = (service: string) => {
    const newSelected = new Set(selectedServices);
    if (newSelected.has(service)) {
      newSelected.delete(service);
    } else {
      newSelected.add(service);
    }
    setSelectedServices(newSelected);
  };

  const selectAllServices = () => setSelectedServices(new Set(ALL_SERVICES));
  const deselectAllServices = () => setSelectedServices(new Set());

  const getServiceColor = (service: string) => {
    // Cycle through some accent colors for service badges
    const colors = [
      'bg-blue-500/10 text-blue-400 border-blue-500/30',
      'bg-green-500/10 text-green-400 border-green-500/30',
      'bg-purple-500/10 text-purple-400 border-purple-500/30',
      'bg-pink-500/10 text-pink-400 border-pink-500/30',
      'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
      'bg-orange-500/10 text-orange-400 border-orange-500/30',
    ];
    const index = ALL_SERVICES.indexOf(service) % colors.length;
    return colors[index];
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour12: false }) + '.' + date.getMilliseconds().toString().padStart(3, '0');
  };

  const renderLogLine = (log: LogEntry, index: number) => {
    return (
      <div key={index} className="flex items-start gap-2 px-3 py-1 text-xs font-mono border-b border-nms-border/30 hover:bg-nms-surface-2/50">
        <span className="text-nms-text-dim shrink-0 w-24">{formatTimestamp(log.timestamp)}</span>
        <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase shrink-0 border ${getServiceColor(log.service)}`}>
          {log.service}
        </span>
        <span className="text-nms-text break-all">{log.message}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-nms-bg">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-nms-border bg-nms-surface">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold font-display text-nms-text">Unified Logs</h1>
          <div className="flex items-center gap-2">
            {connected ? (
              <>
                <Circle className="w-2 h-2 fill-nms-green text-nms-green animate-pulse" />
                <span className="text-xs text-nms-green">Connected</span>
              </>
            ) : (
              <>
                <Circle className="w-2 h-2 fill-nms-red text-nms-red" />
                <span className="text-xs text-nms-red">Disconnected</span>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => window.location.reload()}
            className="nms-btn-ghost text-sm"
            title="Refresh"
          >
            <RotateCw className="w-4 h-4" />
          </button>
          <button
            onClick={clearLogs}
            className="nms-btn-ghost text-sm"
            title="Clear logs"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Log Display */}
      <div
        ref={logContainerRef}
        className="flex-1 overflow-y-auto bg-nms-bg"
      >
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-nms-text-dim">
            <div className="text-center">
              <p className="mb-2">No logs to display</p>
              <p className="text-xs">Select services below to start streaming</p>
            </div>
          </div>
        ) : (
          logs.map((log, index) => renderLogLine(log, index))
        )}
      </div>

      {/* Sticky Footer - Filters */}
      <div className="border-t border-nms-border bg-nms-surface p-4">
        {/* Services */}
        <div className="mb-3">
          <label className="nms-label mb-2">Services</label>
          <div className="flex flex-wrap gap-2">
            {ALL_SERVICES.map((service) => {
              const isSelected = selectedServices.has(service);
              return (
                <button
                  key={service}
                  onClick={() => toggleService(service)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                    isSelected
                      ? 'bg-nms-accent/10 text-nms-accent border border-nms-accent/30'
                      : 'bg-nms-bg text-nms-text-dim hover:text-nms-text border border-nms-border'
                  }`}
                >
                  {isSelected ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                  <span className="font-mono uppercase">{service}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex gap-2">
            <button onClick={selectAllServices} className="nms-btn-ghost text-xs">
              All Services
            </button>
            <button onClick={deselectAllServices} className="nms-btn-ghost text-xs">
              Clear Services
            </button>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs text-nms-text-dim">Max Lines:</label>
              <select
                value={maxLines}
                onChange={(e) => setMaxLines(parseInt(e.target.value))}
                className="bg-nms-bg border border-nms-border rounded px-2 py-1 text-xs text-nms-text"
              >
                <option value={100}>100</option>
                <option value={500}>500</option>
                <option value={1000}>1000</option>
                <option value={2000}>2000</option>
              </select>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-xs text-nms-text-dim">Auto-scroll</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-xs text-nms-text-dim">Pause</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};
