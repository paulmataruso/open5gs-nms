import { useState, useEffect } from 'react';
import { X, Download, Bug, CheckSquare, Square, AlertTriangle, Loader2 } from 'lucide-react';
import axios from 'axios';
import { useEscapeKey } from '../../hooks/useKeyboardA11y';

const ALL_OPEN5GS_SERVICES = [
  'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr',
  'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu',
];

const GENIEACS_LOG_SERVICES = ['genieacs-cwmp-access', 'genieacs-nbi-access'];

interface Props {
  onClose: () => void;
  initialServices?: string[];
  initialSource?: 'open5gs' | 'docker' | 'genieacs';
  dockerContainers?: string[];
}

type RangeType = 'lines' | 'date' | 'all';
type DownloadState = 'idle' | 'loading' | 'error';

export const LogDownloadModal: React.FC<Props> = ({
  onClose,
  initialServices = [],
  initialSource = 'open5gs',
  dockerContainers = [],
}) => {
  // Escape closes this dialog. Its backdrop already closes on click, which
  // has no keyboard equivalent -- and a focusable backdrop would be worse.
  useEscapeKey(onClose);

  const API_URL = import.meta.env.VITE_API_URL || '/api';

  const [source, setSource] = useState<'open5gs' | 'docker' | 'genieacs'>(initialSource);
  const [allDockerContainers, setAllDockerContainers] = useState<string[]>(dockerContainers);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set(initialServices.length > 0 ? initialServices : ALL_OPEN5GS_SERVICES),
  );

  // Fetch containers on mount — don't rely on parent passing them
  useEffect(() => {
    axios.get(`${API_URL}/docker/containers`)
      .then(res => setAllDockerContainers(res.data.containers || []))
      .catch(() => {});
  }, [API_URL]);
  const [rangeType, setRangeType] = useState<RangeType>('lines');
  const [lines, setLines] = useState(500);
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 16));
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [debugState, setDebugState] = useState<DownloadState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const availableServices = source === 'open5gs' ? ALL_OPEN5GS_SERVICES : source === 'genieacs' ? GENIEACS_LOG_SERVICES : allDockerContainers;
  const allSelected = availableServices.length > 0 && availableServices.every(s => selectedServices.has(s));

  const toggleService = (svc: string) => {
    const next = new Set(selectedServices);
    if (next.has(svc)) next.delete(svc);
    else next.add(svc);
    setSelectedServices(next);
  };

  const toggleAll = () => {
    if (allSelected) setSelectedServices(new Set());
    else setSelectedServices(new Set(availableServices));
  };

  const triggerFileDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownload = async () => {
    if (selectedServices.size === 0) return;
    setDownloadState('loading');
    setErrorMessage('');
    try {
      const range: Record<string, unknown> = { type: rangeType };
      if (rangeType === 'lines') range.lines = lines;
      if (rangeType === 'date') {
        range.from = new Date(dateFrom).toISOString();
        range.to = new Date(dateTo).toISOString();
      }
      const response = await axios.post(
        `${API_URL}/logs/download`,
        { services: Array.from(selectedServices), source, range },
        { responseType: 'blob' },
      );
      const cd = response.headers['content-disposition'] || '';
      const match = cd.match(/filename="(.+?)"/);
      const filename = match ? match[1] : 'open5gs-logs.tar.gz';
      triggerFileDownload(new Blob([response.data]), filename);
      setDownloadState('idle');
    } catch {
      setDownloadState('error');
      setErrorMessage('Download failed. Check that the selected services have log files.');
    }
  };

  const handleDebugBundle = async () => {
    setDebugState('loading');
    setErrorMessage('');
    try {
      const response = await axios.get(`${API_URL}/logs/debug-bundle`, { responseType: 'blob' });
      const cd = response.headers['content-disposition'] || '';
      const match = cd.match(/filename="(.+?)"/);
      const filename = match ? match[1] : 'open5gs-debug-bundle.tar.gz';
      triggerFileDownload(new Blob([response.data]), filename);
      setDebugState('idle');
    } catch {
      setDebugState('error');
      setErrorMessage('Debug bundle generation failed. Check server logs for details.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border">
          <h2 className="text-lg font-semibold font-display text-nms-text flex items-center gap-2">
            <Download className="w-5 h-5 text-nms-accent" />
            Download Logs
          </h2>
          <button aria-label="Close" onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">

          {/* ── Custom Download ── */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-nms-text uppercase tracking-wider">Custom Download</h3>

            {/* Source */}
            <div>
              <label className="nms-label mb-2">Log Source</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setSource('open5gs')}
                  className={`px-3 py-1.5 rounded text-sm transition-colors border ${
                    source === 'open5gs'
                      ? 'bg-nms-accent/10 text-nms-accent border-nms-accent/30'
                      : 'text-nms-text-dim border-nms-border hover:text-nms-text'
                  }`}
                >
                  Open5GS Services
                </button>
                <button
                  onClick={() => { setSource('docker'); setSelectedServices(new Set()); }}
                  className={`px-3 py-1.5 rounded text-sm transition-colors border ${
                    source === 'docker'
                      ? 'bg-nms-accent/10 text-nms-accent border-nms-accent/30'
                      : 'text-nms-text-dim border-nms-border hover:text-nms-text'
                  }`}
                >
                  Docker Containers
                  {allDockerContainers.length > 0 && (
                    <span className="ml-1.5 text-xs opacity-70">({allDockerContainers.length})</span>
                  )}
                </button>
                <button
                  onClick={() => { setSource('genieacs'); setSelectedServices(new Set(GENIEACS_LOG_SERVICES)); }}
                  className={`px-3 py-1.5 rounded text-sm transition-colors border ${
                    source === 'genieacs'
                      ? 'bg-nms-accent/10 text-nms-accent border-nms-accent/30'
                      : 'text-nms-text-dim border-nms-border hover:text-nms-text'
                  }`}
                >
                  GenieACS
                </button>
              </div>
            </div>

            {/* Services */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="nms-label">Services</label>
                <button onClick={toggleAll} className="text-xs text-nms-accent hover:underline">
                  {allSelected ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {availableServices.map(svc => {
                  const selected = selectedServices.has(svc);
                  return (
                    <button aria-label={`${selected ? 'Deselect' : 'Select'} ${svc} logs`}
                      key={svc}
                      onClick={() => toggleService(svc)}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors border font-mono ${
                        selected
                          ? 'bg-nms-accent/10 text-nms-accent border-nms-accent/30'
                          : 'text-nms-text-dim border-nms-border hover:text-nms-text'
                      }`}
                    >
                      {selected ? <CheckSquare className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                      {svc.toUpperCase()}
                    </button>
                  );
                })}
                {availableServices.length === 0 && source === 'docker' && (
                  <p className="text-xs text-nms-text-dim">No Docker containers detected</p>
                )}
              </div>
            </div>

            {/* Range */}
            <div>
              <label className="nms-label mb-2">Log Range</label>
              <div className="space-y-2">
                <label className="flex items-center gap-3 cursor-pointer p-2 rounded border border-nms-border hover:border-nms-accent/30 transition-colors">
                  <input type="radio" checked={rangeType === 'lines'} onChange={() => setRangeType('lines')} className="accent-nms-accent" />
                  <span className="text-sm text-nms-text flex items-center gap-2">
                    Last
                    <input
                      type="number"
                      value={lines}
                      onChange={e => setLines(Math.max(1, parseInt(e.target.value) || 500))}
                      onClick={() => setRangeType('lines')}
                      className="nms-input w-24 py-0.5 text-center font-mono"
                      min={1}
                      max={100000}
                    />
                    lines per service
                  </span>
                </label>

                <label className="flex items-start gap-3 cursor-pointer p-2 rounded border border-nms-border hover:border-nms-accent/30 transition-colors">
                  <input type="radio" checked={rangeType === 'date'} onChange={() => setRangeType('date')} className="accent-nms-accent mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <span className="text-sm text-nms-text">Date / Time range</span>
                    {rangeType === 'date' && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-nms-text-dim mb-1 block">From</label>
                          <input aria-label="From" type="datetime-local" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="nms-input text-xs w-full" />
                        </div>
                        <div>
                          <label className="text-xs text-nms-text-dim mb-1 block">To</label>
                          <input aria-label="To" type="datetime-local" value={dateTo} onChange={e => setDateTo(e.target.value)} className="nms-input text-xs w-full" />
                        </div>
                      </div>
                    )}
                  </div>
                </label>

                <label className="flex items-center gap-3 cursor-pointer p-2 rounded border border-nms-border hover:border-nms-accent/30 transition-colors">
                  <input type="radio" checked={rangeType === 'all'} onChange={() => setRangeType('all')} className="accent-nms-accent" />
                  <span className="text-sm text-nms-text">
                    All lines <span className="text-nms-text-dim text-xs">(may be large)</span>
                  </span>
                </label>
              </div>
            </div>

            <p className="text-xs text-nms-text-dim">
              {selectedServices.size <= 1
                ? 'Single service → downloads as .log file'
                : `${selectedServices.size} services → downloads as .tar.gz`}
            </p>

            {downloadState === 'error' && (
              <div className="flex items-center gap-2 text-xs text-nms-red">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {errorMessage}
              </div>
            )}

            <button
              onClick={handleDownload}
              disabled={selectedServices.size === 0 || downloadState === 'loading'}
              className="nms-btn-primary w-full flex items-center justify-center gap-2"
            >
              {downloadState === 'loading'
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Preparing Download...</>
                : <><Download className="w-4 h-4" /> Download Selected Logs</>}
            </button>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-nms-border" />
            <span className="text-xs text-nms-text-dim uppercase tracking-wider">or</span>
            <div className="flex-1 h-px bg-nms-border" />
          </div>

          {/* ── Debug Bundle ── */}
          <div className="p-4 rounded-lg border border-amber-500/20 bg-amber-500/5 space-y-3">
            <div className="flex items-start gap-3">
              <Bug className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold text-nms-text">Debug Bundle</h3>
                <p className="text-xs text-nms-text-dim mt-1">
                  Everything needed for a bug report in one file — all Open5GS logs, NMS logs,
                  all NF configs, OS info, network interfaces, routes, service status, and iptables NAT rules.
                </p>
                <p className="text-xs text-amber-400/80 mt-1 font-medium">
                  Attach this to GitHub issues when reporting problems. May take 15–30 seconds.
                </p>
              </div>
            </div>

            {debugState === 'error' && (
              <div className="flex items-center gap-2 text-xs text-nms-red">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {errorMessage}
              </div>
            )}

            <button
              onClick={handleDebugBundle}
              disabled={debugState === 'loading'}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
                bg-amber-500/10 text-amber-400 border border-amber-500/30
                hover:bg-amber-500/20 transition-colors font-semibold text-sm
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {debugState === 'loading'
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating Bundle...</>
                : <><Bug className="w-4 h-4" /> Download Debug Bundle</>}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
};
