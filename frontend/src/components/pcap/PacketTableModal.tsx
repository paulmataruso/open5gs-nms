import { useState, useEffect, useMemo } from 'react';
import { X, RefreshCw, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { pcapApi, PcapManifest, DecodePreset, PacketRow, PacketTreeNode } from '../../api/pcap';
import { PacketDetailTree } from './PacketDetailTree';

type SortKey = 'frameNumber' | 'timeEpoch' | 'src' | 'dst' | 'protocol' | 'length';

export function PacketTableModal({ capture, presets, onClose }: {
  capture: PcapManifest;
  presets: DecodePreset[];
  onClose: () => void;
}): JSX.Element {
  const [presetId, setPresetId] = useState(presets[0]?.id ?? 'none');
  const [customFilter, setCustomFilter] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [summary, setSummary] = useState('');
  const [rows, setRows] = useState<PacketRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('frameNumber');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [detailTree, setDetailTree] = useState<PacketTreeNode[]>([]);
  const [detailHex, setDetailHex] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const activeFilter = useCustom ? customFilter : (presets.find(p => p.id === presetId)?.filter ?? '');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [summaryText, packetResult] = await Promise.all([
        pcapApi.getSummary(capture.id),
        pcapApi.getPackets(capture.id, activeFilter),
      ]);
      setSummary(summaryText);
      setRows(packetResult.rows);
      setTruncated(packetResult.truncated);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const selectRow = (frameNumber: number) => {
    if (selectedFrame === frameNumber) { setSelectedFrame(null); return; }
    setSelectedFrame(frameNumber);
    setDetailTree([]);
    setDetailHex('');
    setDetailError('');
    setDetailLoading(true);
    pcapApi.getPacketDetail(capture.id, frameNumber)
      .then(({ tree, hex }) => { setDetailTree(tree); setDetailHex(hex); })
      .catch((err: any) => setDetailError(err?.response?.data?.error ?? err.message))
      .finally(() => setDetailLoading(false));
  };

  const sorted = useMemo(() => {
    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, sortKey, sortOrder]);

  const columns: { key: SortKey; label: string }[] = [
    { key: 'frameNumber', label: '#' },
    { key: 'timeEpoch', label: 'Time' },
    { key: 'src', label: 'Source' },
    { key: 'dst', label: 'Destination' },
    { key: 'protocol', label: 'Protocol' },
    { key: 'length', label: 'Length' },
  ];

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="nms-card w-[95vw] max-w-[1600px] h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold font-display">Capture: {capture.label}</h3>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-end gap-3 flex-wrap mb-3">
          <div>
            <label className="nms-label">Decode filter preset</label>
            <select
              className="nms-input text-sm"
              value={presetId}
              disabled={useCustom}
              onChange={e => setPresetId(e.target.value)}
            >
              {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-nms-text-dim mb-2">
            <input type="checkbox" checked={useCustom} onChange={e => setUseCustom(e.target.checked)} />
            Custom
          </label>
          {useCustom && (
            <input
              className="nms-input font-mono text-sm flex-1 min-w-[240px]"
              placeholder='e.g. sip || diameter'
              value={customFilter}
              onChange={e => setCustomFilter(e.target.value)}
            />
          )}
          <button onClick={load} disabled={loading} className="nms-btn-primary flex items-center gap-2 text-sm">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} /> Apply
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/5 text-xs text-red-400 mb-3 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
          </div>
        )}

        {summary && (
          <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-nms-text-dim max-h-32 overflow-y-auto border border-nms-border mb-3 whitespace-pre-wrap">
            {summary}
          </pre>
        )}

        {truncated && (
          <div className="p-2 rounded-lg border border-amber-500/30 bg-amber-500/5 text-xs text-amber-300 mb-3">
            Showing the first 20,000 matching packets — narrow the filter to see more precisely.
          </div>
        )}

        <div className={clsx('overflow-auto border border-nms-border rounded-lg min-h-0', selectedFrame !== null ? 'shrink-0 h-52' : 'flex-1')}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-nms-surface-2">
              <tr>
                {columns.map(({ key, label }) => (
                  <th key={key} className="text-left px-3 py-2 font-semibold text-nms-text-dim uppercase tracking-wider">
                    <button
                      onClick={() => {
                        const newOrder = sortKey === key && sortOrder === 'asc' ? 'desc' : 'asc';
                        setSortKey(key); setSortOrder(newOrder);
                      }}
                      className="flex items-center gap-1 hover:text-nms-text transition-colors"
                    >
                      {label}
                      {sortKey === key
                        ? (sortOrder === 'asc' ? <ArrowUp className="w-3 h-3 text-nms-accent" /> : <ArrowDown className="w-3 h-3 text-nms-accent" />)
                        : <span className="w-3 h-3 opacity-20">↕</span>}
                    </button>
                  </th>
                ))}
                <th className="text-left px-3 py-2 font-semibold text-nms-text-dim uppercase tracking-wider">Info</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => (
                <tr
                  key={row.frameNumber}
                  onClick={() => selectRow(row.frameNumber)}
                  className={clsx(
                    'border-t border-nms-border cursor-pointer',
                    selectedFrame === row.frameNumber ? 'bg-nms-accent/15' : 'hover:bg-nms-surface-2/50',
                  )}
                >
                  <td className="px-3 py-1.5 font-mono">{row.frameNumber}</td>
                  <td className="px-3 py-1.5 font-mono">{row.timeEpoch.toFixed(6)}</td>
                  <td className="px-3 py-1.5 font-mono">{row.src}</td>
                  <td className="px-3 py-1.5 font-mono">{row.dst}</td>
                  <td className="px-3 py-1.5"><span className="px-1.5 py-0.5 rounded bg-nms-accent/10 text-nms-accent">{row.protocol}</span></td>
                  <td className="px-3 py-1.5 font-mono">{row.length}</td>
                  <td className="px-3 py-1.5 font-mono text-nms-text-dim truncate max-w-md">{row.info}</td>
                </tr>
              ))}
              {sorted.length === 0 && !loading && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-nms-text-dim">No packets match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedFrame !== null && (
          <div className="flex-1 flex flex-col mt-3 min-h-0">
            <div className="flex items-center justify-between mb-1.5 shrink-0">
              <h4 className="text-sm font-semibold text-nms-text-dim uppercase tracking-wider">Frame {selectedFrame} details</h4>
              <button onClick={() => setSelectedFrame(null)} className="text-nms-text-dim hover:text-nms-text">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto border border-nms-border rounded-lg bg-nms-bg p-4 min-h-0">
              {detailLoading && (
                <div className="flex items-center gap-2 text-sm text-nms-text-dim">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Decoding frame {selectedFrame}…
                </div>
              )}
              {detailError && (
                <div className="text-sm text-red-400 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {detailError}
                </div>
              )}
              {!detailLoading && !detailError && (
                <>
                  <PacketDetailTree tree={detailTree} />
                  {detailHex && (
                    <details className="mt-4">
                      <summary className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider cursor-pointer hover:text-nms-text">
                        Bytes
                      </summary>
                      <pre className="text-xs font-mono text-nms-text-dim whitespace-pre mt-1.5 overflow-x-auto">{detailHex}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
