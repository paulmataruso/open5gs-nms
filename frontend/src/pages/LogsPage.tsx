import { useState, useMemo, useEffect } from 'react';
import { RotateCw, Trash2, CheckSquare, Square, Circle, Server, Box, Download, Radio } from 'lucide-react';
import { useLogStream, LogEntry } from '../hooks/useLogStream';
import { LogDownloadModal } from '../components/logs/LogDownloadModal';
import axios from 'axios';

const ALL_SERVICES = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];
const GENIEACS_SERVICES = ['genieacs-cwmp-access', 'genieacs-nbi-access'];
const SAS_CONTAINER = 'open5gs-nms-backend'; // SAS logs live here

interface GenieDevice {
  _id:    string;
  serial: string;
  label:  string;
  ip:     string; // IP address for sorting
}

export const LogsPage: React.FC = () => {
  const [logSource, setLogSource] = useState<'open5gs' | 'docker' | 'genieacs'>('open5gs');
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [logFilter, setLogFilter] = useState<string | undefined>(undefined); // server-side content filter
  const [dockerContainers, setDockerContainers] = useState<string[]>([]);
  const [maxLines, setMaxLines] = useState(1000);
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [genieDevices, setGenieDevices] = useState<GenieDevice[]>([]);
  const [radioFilter, setRadioFilter] = useState<string>('');  // device _id to filter logs
  const [radioSort, setRadioSort]     = useState<'label' | 'ip'>('label');
  const [showTaskQueue, setShowTaskQueue] = useState(false);
  const [taskQueueDevice, setTaskQueueDevice] = useState<string>('');
  const [tasks, setTasks]             = useState<any[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  // Fetch Docker containers on mount and whenever source changes
  useEffect(() => {
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    axios.get(`${API_URL}/docker/containers`)
      .then(res => setDockerContainers(res.data.containers || []))
      .catch(err => {
        console.error('Failed to fetch Docker containers:', err);
        setDockerContainers([]);
      });
  }, []);

  // Fetch GenieACS registered devices for the radio filter dropdown
  useEffect(() => {
    if (logSource !== 'genieacs') return;
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    // Fetch both Baicells and Sercomm devices
    Promise.all([
      axios.get(`${API_URL}/genieacs/devices`),
      axios.get(`${API_URL}/genieacs/devices/sercomm`),
    ]).then(([baicellsRes, sercommRes]) => {
      const baicells = (baicellsRes.data?.devices || []).map((d: any) => ({
        _id:    d.id || d.serial,
        serial: d.serial || '',
        label:  d.serial || d.id,
        ip:     d.ip || '',
      }));
      const sercomm = (sercommRes.data?.devices || []).map((d: any) => ({
        _id:    d.id || d.serial,
        serial: d.serial || '',
        label:  d.serial || d.id,
        ip:     d.ip || '',
      }));
      const all: GenieDevice[] = [...baicells, ...sercomm];
      // Sort by label or IP depending on radioSort
      all.sort((a, b) => a.label.localeCompare(b.label));
      setGenieDevices(all);
    }).catch(() => setGenieDevices([]));
  }, [logSource]);

  // Clear selection and filter when switching sources
  useEffect(() => {
    setSelectedServices(new Set());
    setLogFilter(undefined);
    setRadioFilter('');
  }, [logSource]);

  // When radioFilter changes, update the server-side content filter
  // GenieACS logs contain the device serial number in every line
  // Extract serial from _id (last segment after final '-') for reliable matching
  useEffect(() => {
    if (logSource !== 'genieacs') return;
    if (!radioFilter) { setLogFilter(undefined); return; }
    // _id format: OUI-ProductClass-Serial e.g. 000E8F-HeNB-TDD-Enterprise-2112CW5000195
    // GenieACS logs the full _id, try full _id first, fall back to serial suffix
    const device = genieDevices.find(d => d._id === radioFilter);
    // Use serial if available, otherwise last segment of _id, otherwise full _id
    const filterValue = device?.serial || radioFilter.split('-').pop() || radioFilter;
    setLogFilter(filterValue);
  }, [radioFilter, logSource, genieDevices]);

  // Sorted device list for dropdown
  const sortedDevices = useMemo(() => {
    const copy = [...genieDevices];
    if (radioSort === 'ip') {
      // Sort by IP octets numerically
      copy.sort((a, b) => {
        const toNum = (ip: string) => ip.split('.').reduce((acc, oct) => acc * 256 + parseInt(oct || '0'), 0);
        return toNum(a.ip) - toNum(b.ip);
      });
    } else {
      copy.sort((a, b) => a.label.localeCompare(b.label));
    }
    return copy;
  }, [genieDevices, radioSort]);

  // Fetch task queue for selected device
  const fetchTasks = async (deviceId: string) => {
    if (!deviceId) { setTasks([]); return; }
    setTasksLoading(true);
    try {
      const API_URL = import.meta.env.VITE_API_URL || '/api';
      const res = await axios.get(`${API_URL}/genieacs/tasks/${encodeURIComponent(deviceId)}`);
      setTasks(res.data?.tasks || []);
    } catch { setTasks([]); }
    finally { setTasksLoading(false); }
  };

  useEffect(() => {
    if (!showTaskQueue || !taskQueueDevice) return;
    fetchTasks(taskQueueDevice);
    const interval = setInterval(() => fetchTasks(taskQueueDevice), 5000);
    return () => clearInterval(interval);
  }, [showTaskQueue, taskQueueDevice]);

  // Determine available services based on source
  const availableServices = logSource === 'docker' ? dockerContainers : logSource === 'genieacs' ? GENIEACS_SERVICES : ALL_SERVICES;

  // Memoize services array to prevent re-subscription on every render
  const servicesArray = useMemo(() => Array.from(selectedServices), [selectedServices]);

  const { logs, connected, clearLogs, logContainerRef } = useLogStream({
    source: logSource,
    services: servicesArray,
    maxLines,
    autoScroll,
    paused,
    filter: logFilter,
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

  const selectAllServices = () => setSelectedServices(new Set(availableServices));
  const deselectAllServices = () => setSelectedServices(new Set());

  const getServiceColor = (service: string) => {
    if (logSource === 'docker') {
      return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
    }
    if (logSource === 'genieacs') {
      return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
    }
    
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
            onClick={() => setShowDownloadModal(true)}
            className="nms-btn-ghost text-sm flex items-center gap-1.5"
            title="Download logs"
          >
            <Download className="w-4 h-4" /> Download
          </button>
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

      {showDownloadModal && (
        <LogDownloadModal
          onClose={() => setShowDownloadModal(false)}
          initialServices={Array.from(selectedServices)}
          initialSource={logSource}
          dockerContainers={dockerContainers}
        />
      )}

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
        {/* Log Source Selector */}
        <div className="mb-3">
          <label className="nms-label mb-2">Log Source</label>
          <div className="flex gap-2">
            <button
              onClick={() => setLogSource('open5gs')}
              className={`flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                logSource === 'open5gs'
                  ? 'bg-nms-accent text-white'
                  : 'bg-nms-bg text-nms-text-dim hover:text-nms-text border border-nms-border hover:border-nms-accent/50'
              }`}
            >
              <Server className="w-4 h-4" />
              Open5GS Services
            </button>
            <button
              onClick={() => setLogSource('docker')}
              className={`flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                logSource === 'docker'
                  ? 'bg-nms-accent text-white'
                  : 'bg-nms-bg text-nms-text-dim hover:text-nms-text border border-nms-border hover:border-nms-accent/50'
              }`}
            >
              <Box className="w-4 h-4" />
              Docker Containers
            </button>
            {/* SAS quick-select — jumps to Docker + selects backend container + filters to SAS lines only */}
            <button
              onClick={() => {
                setLogSource('docker');
                setSelectedServices(new Set([SAS_CONTAINER]));
                setLogFilter('sas');
              }}
              className={`flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                logFilter === 'sas'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                  : 'bg-nms-bg text-purple-400 hover:text-purple-300 border border-purple-500/30 hover:border-purple-400/50'
              }`}
            >
              <Box className="w-4 h-4" />
              SAS Logs
            </button>
            <button
              onClick={() => setLogSource('genieacs')}
              className={`flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                logSource === 'genieacs'
                  ? 'bg-nms-accent text-white'
                  : 'bg-nms-bg text-nms-text-dim hover:text-nms-text border border-nms-border hover:border-nms-accent/50'
              }`}
            >
              <Server className="w-4 h-4" />
              GenieACS
            </button>
          </div>
        </div>

        {/* Services */}
        <div className="mb-3">
          <label className="nms-label mb-2">
            {logSource === 'docker' ? 'Containers' : 'Services'}
            {logSource === 'docker' && dockerContainers.length === 0 && (
              <span className="ml-2 text-xs text-nms-text-dim">(Loading...)</span>
            )}
          </label>
          <div className="flex flex-wrap gap-2">
            {availableServices.map((service) => {
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
                  <span className="font-mono">{logSource === 'docker' ? service : logSource === 'genieacs' ? service : service.toUpperCase()}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* GenieACS radio filter dropdown */}
        {logSource === 'genieacs' && (
          <div className="mb-3 space-y-2">
            {/* Filter + Sort row */}
            <div className="flex items-center gap-3 flex-wrap">
              <Radio className="w-4 h-4 text-purple-400 shrink-0" />
              <label className="text-xs text-nms-text-dim shrink-0">Filter by Radio:</label>
              <select
                value={radioFilter}
                onChange={e => setRadioFilter(e.target.value)}
                className="bg-nms-bg border border-nms-border rounded px-2 py-1 text-xs text-nms-text min-w-[260px] focus:border-purple-400/60 focus:outline-none"
              >
                <option value="">— All Radios —</option>
                {sortedDevices.map(d => (
                  <option key={d._id} value={d._id}>
                    {radioSort === 'ip' && d.ip ? `${d.ip} — ` : ''}{d.label}
                  </option>
                ))}
              </select>
              {/* Sort toggle */}
              <div className="flex items-center gap-1 border border-nms-border rounded overflow-hidden">
                <button
                  onClick={() => setRadioSort('label')}
                  className={`px-2 py-1 text-xs transition-colors ${ radioSort === 'label' ? 'bg-purple-500/20 text-purple-300' : 'text-nms-text-dim hover:text-nms-text' }`}
                >Name</button>
                <button
                  onClick={() => setRadioSort('ip')}
                  className={`px-2 py-1 text-xs transition-colors ${ radioSort === 'ip' ? 'bg-purple-500/20 text-purple-300' : 'text-nms-text-dim hover:text-nms-text' }`}
                >IP</button>
              </div>
              {radioFilter && (
                <button onClick={() => setRadioFilter('')} className="text-xs text-purple-400 hover:text-purple-300 border border-purple-500/30 rounded px-2 py-1">Clear</button>
              )}
              {genieDevices.length === 0 && <span className="text-xs text-nms-text-dim">No radios registered</span>}
              {/* Task queue toggle */}
              <button
                onClick={() => {
                  setShowTaskQueue(v => !v);
                  if (!taskQueueDevice && genieDevices.length > 0) setTaskQueueDevice(genieDevices[0]._id);
                }}
                className={`ml-auto flex items-center gap-1.5 px-3 py-1 rounded text-xs border transition-colors ${
                  showTaskQueue
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'text-nms-text-dim border-nms-border hover:text-nms-text hover:border-nms-accent/40'
                }`}
              >
                <span>Task Queue</span>
                {tasks.length > 0 && <span className="bg-amber-500/30 text-amber-300 rounded-full px-1.5 py-0.5 text-xs">{tasks.length}</span>}
              </button>
            </div>

            {/* Task queue panel */}
            {showTaskQueue && (
              <div className="border border-amber-500/30 rounded bg-nms-bg p-3 space-y-2">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-xs font-semibold text-amber-300">GenieACS Task Queue</span>
                  <select
                    value={taskQueueDevice}
                    onChange={e => setTaskQueueDevice(e.target.value)}
                    className="bg-nms-surface border border-nms-border rounded px-2 py-0.5 text-xs text-nms-text min-w-[220px]"
                  >
                    <option value="">— Select Radio —</option>
                    {sortedDevices.map(d => (
                      <option key={d._id} value={d._id}>
                        {radioSort === 'ip' && d.ip ? `${d.ip} — ` : ''}{d.label}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => fetchTasks(taskQueueDevice)} className="text-xs text-nms-text-dim hover:text-nms-text border border-nms-border rounded px-2 py-0.5">
                    {tasksLoading ? 'Loading…' : 'Refresh'}
                  </button>
                  <span className="text-xs text-nms-text-dim ml-auto">Auto-refreshes every 5s</span>
                </div>
                {tasks.length === 0 && !tasksLoading && (
                  <p className="text-xs text-nms-text-dim">No pending tasks</p>
                )}
                {tasks.map((t: any, i: number) => {
                  const isPending  = !t._completed;
                  const isFault    = !!t._faults?.length;
                  const statusColor = isFault ? 'text-red-400' : isPending ? 'text-amber-400' : 'text-green-400';
                  const statusLabel = isFault ? 'Fault' : isPending ? 'Pending' : 'Sent';
                  return (
                    <div key={t._id ?? i} className={`flex items-start gap-3 px-2 py-1.5 rounded text-xs font-mono border ${ isFault ? 'border-red-500/20 bg-red-500/5' : isPending ? 'border-amber-500/20 bg-amber-500/5' : 'border-green-500/20 bg-green-500/5' }`}>
                      <span className={`shrink-0 font-semibold w-12 ${statusColor}`}>{statusLabel}</span>
                      <span className="text-nms-text font-semibold shrink-0">{t.name}</span>
                      {t.parameterValues && (
                        <div className="flex-1 space-y-0.5">
                          {(t.parameterValues as [string,string,string][]).map(([k, v], pi) => (
                            <div key={pi} className="text-nms-text-dim">
                              <span className="text-nms-text/70">{k.split('.').slice(-2).join('.')}</span>
                              <span className="text-nms-text-dim mx-1">=</span>
                              <span className="text-amber-300/80">{v}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {t.name === 'reboot' && <span className="text-orange-400">Reboot</span>}
                      {isFault && <span className="text-red-400 ml-auto">{JSON.stringify(t._faults)}</span>}
                      <span className="text-nms-text-dim/50 shrink-0 ml-auto">{t._timestamp ? new Date(t._timestamp).toLocaleTimeString() : ''}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex gap-2">
            <button onClick={selectAllServices} className="nms-btn-ghost text-xs">
              {logSource === 'docker' ? 'All Containers' : 'All Services'}
            </button>
            <button onClick={deselectAllServices} className="nms-btn-ghost text-xs">
              {logSource === 'docker' ? 'Clear Containers' : 'Clear Services'}
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
