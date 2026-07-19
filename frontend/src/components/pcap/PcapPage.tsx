import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Radar, RefreshCw, Play, Square, Download, Trash2, ArrowUp, ArrowDown, Eye, AlertTriangle,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  pcapApi, HostInterface, NfCaptureDescriptor, DecodePreset, PcapManifest, CaptureScopeMode,
} from '../../api/pcap';
import { PacketTableModal } from './PacketTableModal';

const FUNCTION_TYPES: { id: string; label: string }[] = [
  { id: 'mme', label: 'MME' },
  { id: 'amf', label: 'AMF' },
  { id: 'upf', label: 'UPF' },
  { id: 'sgw', label: 'SGW-C/U' },
  { id: 'hss', label: 'HSS' },
  { id: 'pcrf', label: 'PCRF' },
  { id: 'core5g', label: 'Full 5G Core' },
  { id: 'core4g', label: 'Full 4G EPC' },
];

function groupInterfaces(interfaces: HostInterface[]): Record<string, HostInterface[]> {
  const groups: Record<string, HostInterface[]> = { Loopback: [], TUN: [], Dummy: [], Physical: [], Other: [] };
  for (const iface of interfaces) {
    if (iface.name === 'lo') groups.Loopback.push(iface);
    else if (/^ogstun\d*$/.test(iface.name)) groups.TUN.push(iface);
    else if (iface.name.startsWith('dummy-') || iface.name.startsWith('veth')) groups.Dummy.push(iface);
    else if (/^(eth|ens|enp|eno)/.test(iface.name)) groups.Physical.push(iface);
    else groups.Other.push(iface);
  }
  return groups;
}

function formatBytes(n?: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(startedAt: string, stoppedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = stoppedAt ? new Date(stoppedAt).getTime() : Date.now();
  const secs = Math.max(0, Math.floor((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

type SortKey = 'id' | 'label' | 'sizeBytes' | 'status';

export function PcapPage(): JSX.Element {
  const [interfaces, setInterfaces] = useState<HostInterface[]>([]);
  const [nfs, setNfs] = useState<NfCaptureDescriptor[]>([]);
  const [presets, setPresets] = useState<DecodePreset[]>([]);
  const [captures, setCaptures] = useState<PcapManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingCapture, setViewingCapture] = useState<PcapManifest | null>(null);

  // New-capture form state
  const [selectedIfaces, setSelectedIfaces] = useState<string[]>([]);
  const [scopeMode, setScopeMode] = useState<CaptureScopeMode>('all');
  const [selectedNfs, setSelectedNfs] = useState<string[]>([]);
  const [functionType, setFunctionType] = useState(FUNCTION_TYPES[0].id);
  const [customBpf, setCustomBpf] = useState('');
  const [label, setLabel] = useState('');
  const [starting, setStarting] = useState(false);
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const hasRunning = captures.some(c => c.status === 'running' || c.status === 'starting');

  const loadAll = useCallback(async () => {
    try {
      const [ifaceList, nfList, presetList, captureList] = await Promise.all([
        pcapApi.listInterfaces(), pcapApi.listNfs(), pcapApi.listPresets(), pcapApi.listCaptures(),
      ]);
      setInterfaces(ifaceList);
      setNfs(nfList);
      setPresets(presetList);
      setCaptures(captureList);
    } catch (err: any) {
      toast.error(`Failed to load: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Poll while any capture is active, so byte counts/elapsed time stay current.
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => { pcapApi.listCaptures().then(setCaptures).catch(() => {}); }, 3000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  const ifaceGroups = useMemo(() => groupInterfaces(interfaces), [interfaces]);

  const toggleIface = (name: string) => {
    setSelectedIfaces(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  };
  const toggleNf = (nf: string) => {
    setSelectedNfs(prev => prev.includes(nf) ? prev.filter(n => n !== nf) : [...prev, nf]);
  };

  const handleStart = async () => {
    if (selectedIfaces.length === 0) { toast.error('Select at least one interface'); return; }
    setStarting(true);
    try {
      const scope = scopeMode === 'nf' ? { mode: scopeMode, nfs: selectedNfs }
        : scopeMode === 'functionType' ? { mode: scopeMode, functionType }
        : scopeMode === 'custom' ? { mode: scopeMode, customBpf }
        : { mode: scopeMode };
      const capture = await pcapApi.start({ interfaces: selectedIfaces, scope, label: label || undefined });
      toast.success(`Capture ${capture.id} started`);
      setLabel('');
      await loadAll();
    } catch (err: any) {
      toast.error(`Failed to start capture: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async (id: string) => {
    setStoppingId(id);
    try {
      await pcapApi.stop(id);
      toast.success('Capture stopped');
      await loadAll();
    } catch (err: any) {
      toast.error(`Failed to stop: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setStoppingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete capture ${id}? This removes the pcap file permanently.`)) return;
    try {
      await pcapApi.delete(id);
      toast.success('Capture deleted');
      await loadAll();
    } catch (err: any) {
      toast.error(`Failed to delete: ${err?.response?.data?.error ?? err.message}`);
    }
  };

  const running = captures.filter(c => c.status === 'running' || c.status === 'starting' || c.status === 'stopping');
  const history = captures.filter(c => c.status === 'stopped' || c.status === 'failed');

  const sortedHistory = useMemo(() => {
    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...history].sort((a, b) => {
      if (sortKey === 'sizeBytes') return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * dir;
      const av = String(a[sortKey] ?? '');
      const bv = String(b[sortKey] ?? '');
      return av.localeCompare(bv) * dir;
    });
  }, [history, sortKey, sortOrder]);

  const groupedNfs = useMemo(() => {
    const groups: Record<string, NfCaptureDescriptor[]> = {};
    for (const nf of nfs) { (groups[nf.group] ??= []).push(nf); }
    return groups;
  }, [nfs]);

  const columns: { key: SortKey; label: string }[] = [
    { key: 'id', label: 'Created' },
    { key: 'label', label: 'Label' },
    { key: 'sizeBytes', label: 'Size' },
    { key: 'status', label: 'Status' },
  ];

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading packet capture module…
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
            <Radar className="w-6 h-6 text-nms-accent" /> Packet Capture
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Capture real core/radio traffic on any host interface — scope by NF or function type at capture time, decode with protocol filters afterward.
          </p>
        </div>
        <button onClick={loadAll} className="nms-btn-ghost flex items-center gap-2 text-sm">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {/* New capture form */}
      <div className="nms-card space-y-4">
        <h2 className="text-sm font-semibold text-nms-accent">New Capture</h2>

        <div>
          <label className="nms-label">Interfaces</label>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mt-1">
            {Object.entries(ifaceGroups).filter(([, list]) => list.length > 0).map(([group, list]) => (
              <div key={group} className="border border-nms-border rounded-lg p-2">
                <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1">{group}</div>
                {list.map(iface => (
                  <label key={iface.name} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
                    <input type="checkbox" checked={selectedIfaces.includes(iface.name)} onChange={() => toggleIface(iface.name)} />
                    <span className="font-mono">{iface.name}</span>
                    {iface.ip && <span className="text-nms-text-dim">{iface.ip}</span>}
                    <span className={clsx('w-1.5 h-1.5 rounded-full', iface.state === 'up' ? 'bg-green-400' : 'bg-nms-text-dim/40')} />
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="nms-label">Capture scope</label>
          <div className="flex flex-wrap gap-4 mt-1 text-sm">
            {([
              ['all', 'Everything'], ['nf', 'By NF'], ['functionType', 'By Function Type'],
              ['gtpAll', 'All GTP Traffic'], ['custom', 'Custom BPF'],
            ] as [CaptureScopeMode, string][]).map(([mode, label2]) => (
              <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="scopeMode" checked={scopeMode === mode} onChange={() => setScopeMode(mode)} />
                {label2}
              </label>
            ))}
          </div>

          {scopeMode === 'nf' && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
              {Object.entries(groupedNfs).map(([group, list]) => (
                <div key={group} className="border border-nms-border rounded-lg p-2">
                  <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1">{group}</div>
                  {list.map(nf => (
                    <label key={nf.nf} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
                      <input type="checkbox" checked={selectedNfs.includes(nf.nf)} onChange={() => toggleNf(nf.nf)} />
                      {nf.label}
                    </label>
                  ))}
                </div>
              ))}
              {nfs.length === 0 && <p className="text-xs text-nms-text-dim">No live NF descriptors available yet.</p>}
            </div>
          )}

          {scopeMode === 'functionType' && (
            <select className="nms-input text-sm mt-2 max-w-xs" value={functionType} onChange={e => setFunctionType(e.target.value)}>
              {FUNCTION_TYPES.map(ft => <option key={ft.id} value={ft.id}>{ft.label}</option>)}
            </select>
          )}

          {scopeMode === 'custom' && (
            <input
              className="nms-input font-mono text-sm mt-2 w-full"
              placeholder="e.g. host 127.0.0.5 and tcp port 7777"
              value={customBpf}
              onChange={e => setCustomBpf(e.target.value)}
            />
          )}
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="nms-label">Label (optional)</label>
            <input className="nms-input text-sm w-full" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. AMF registration debug" />
          </div>
          <button onClick={handleStart} disabled={starting} className="nms-btn-primary flex items-center gap-2 text-sm">
            <Play className="w-4 h-4" /> {starting ? 'Starting…' : 'Start Capture'}
          </button>
        </div>
      </div>

      {/* Active captures */}
      {running.length > 0 && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-accent mb-3">Active Captures</h2>
          <div className="space-y-2">
            {running.map(c => (
              <div key={c.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-green-500/20 bg-green-500/5 flex-wrap">
                <div className="text-xs">
                  <div className="font-semibold text-nms-text">{c.label} <span className="text-nms-text-dim font-normal">({c.status})</span></div>
                  <div className="text-nms-text-dim mt-0.5">
                    {c.interfaces.join(', ')} — {c.scopeDescription} — {formatDuration(c.startedAt)} elapsed — {formatBytes(c.sizeBytes)}
                  </div>
                </div>
                <button
                  onClick={() => handleStop(c.id)}
                  disabled={stoppingId === c.id || c.status !== 'running'}
                  className="nms-btn-ghost text-red-400 border-red-500/30 hover:border-red-500/60 flex items-center gap-2 text-xs shrink-0"
                >
                  <Square className="w-3.5 h-3.5" /> {stoppingId === c.id ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Previous captures */}
      <div className="nms-card">
        <h2 className="text-sm font-semibold text-nms-accent mb-3">Previous Captures</h2>
        {history.length === 0 ? (
          <p className="text-xs text-nms-text-dim">No completed captures yet.</p>
        ) : (
          <div className="border border-nms-border rounded-lg overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-nms-surface-2 text-left text-xs text-nms-text-dim uppercase tracking-wider">
                  {columns.map(({ key, label: colLabel }) => (
                    <th key={key} className="px-4 py-2 font-semibold">
                      <button
                        onClick={() => {
                          const newOrder = sortKey === key && sortOrder === 'asc' ? 'desc' : 'asc';
                          setSortKey(key); setSortOrder(newOrder);
                        }}
                        className="flex items-center gap-1 hover:text-nms-text transition-colors"
                      >
                        {colLabel}
                        {sortKey === key
                          ? (sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-nms-accent" /> : <ArrowDown className="w-3 h-3 text-nms-accent" />)
                          : <span className="w-3 h-3 opacity-20">↕</span>}
                      </button>
                    </th>
                  ))}
                  <th className="px-4 py-2 font-semibold">Interfaces</th>
                  <th className="px-4 py-2 font-semibold">Scope</th>
                  <th className="px-4 py-2 font-semibold">Duration</th>
                  <th className="px-4 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedHistory.map(c => (
                  <tr key={c.id} className="border-t border-nms-border">
                    <td className="px-4 py-2 text-xs font-mono">{new Date(parseInt(c.id)).toLocaleString()}</td>
                    <td className="px-4 py-2 text-xs">{c.label}</td>
                    <td className="px-4 py-2 text-xs font-mono">{formatBytes(c.sizeBytes)}</td>
                    <td className="px-4 py-2 text-xs">
                      <span className={clsx('flex items-center gap-1', c.status === 'failed' && 'text-red-400')}>
                        {c.status === 'failed' && <AlertTriangle className="w-3 h-3" />} {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs font-mono">{c.interfaces.join(', ')}</td>
                    <td className="px-4 py-2 text-xs">{c.scopeDescription}</td>
                    <td className="px-4 py-2 text-xs font-mono">{formatDuration(c.startedAt, c.stoppedAt)}</td>
                    <td className="px-4 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <button onClick={() => setViewingCapture(c)} className="text-nms-accent hover:underline flex items-center gap-1">
                          <Eye className="w-3.5 h-3.5" /> View
                        </button>
                        <a href={pcapApi.downloadUrl(c.id)} className="text-nms-accent hover:underline flex items-center gap-1">
                          <Download className="w-3.5 h-3.5" /> Download
                        </a>
                        <button onClick={() => handleDelete(c.id)} className="text-red-400 hover:underline flex items-center gap-1">
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewingCapture && (
        <PacketTableModal capture={viewingCapture} presets={presets} onClose={() => setViewingCapture(null)} />
      )}
    </div>
  );
}
