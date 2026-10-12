import { useState, useEffect, useCallback } from 'react';
import { History, RefreshCw, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Phone, Info, Settings2, Power } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { cdrApi, type CdrRecord } from '../api';
import { imsApi, type ImsStatus } from '../api/ims';
import { TimeRangePicker, type TimeRangeValue } from '../components/common/TimeRangePicker';
import { activateOnKey } from '../hooks/useKeyboardA11y';

const DEFAULT_TIME_RANGE: TimeRangeValue = { type: 'relative', ms: 24 * 60 * 60 * 1000, label: 'Last 24 hours' };
const PAGE_SIZE = 50;

const SOURCE_LABEL: Record<CdrRecord['sourceSystem'], string> = { pstn: 'PSTN', '2g': '2G', ims: 'IMS (4G/5G)' };
const SOURCE_COLOR: Record<CdrRecord['sourceSystem'], string> = {
  pstn: 'bg-amber-500/10 text-amber-400',
  '2g': 'bg-purple-500/10 text-purple-400',
  ims: 'bg-nms-accent/10 text-nms-accent',
};
const DISPOSITION_COLOR: Record<CdrRecord['disposition'], string> = {
  answered: 'bg-nms-green/10 text-nms-green',
  'no-answer': 'bg-nms-text-dim/10 text-nms-text-dim',
  busy: 'bg-amber-500/10 text-amber-400',
  failed: 'bg-nms-red/10 text-nms-red',
  cancelled: 'bg-nms-text-dim/10 text-nms-text-dim',
  unknown: 'bg-nms-text-dim/10 text-nms-text-dim',
};

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function partyLabel(p: CdrRecord['caller']): string {
  return p.nickname || p.msisdn || p.imsi || p.raw;
}

function PartyCell({ party }: { party: CdrRecord['caller'] }) {
  const label = partyLabel(party);
  const showRaw = label !== party.raw;
  return (
    <div className="text-xs">
      <div className="font-mono text-nms-text">{label}</div>
      {showRaw && <div className="text-nms-text-dim">{party.raw}</div>}
    </div>
  );
}

function CdrRow({ record }: { record: CdrRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr
        className="border-b border-nms-border/50 hover:bg-nms-surface-2/50 transition-colors cursor-pointer"
        onClick={() => setExpanded(e => !e)}
        onKeyDown={activateOnKey(() => setExpanded(e => !e))}
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td className="px-4 py-3 text-xs text-nms-text-dim whitespace-nowrap">
          {new Date(record.startTime).toLocaleString()}
        </td>
        <td className="px-4 py-3"><PartyCell party={record.caller} /></td>
        <td className="px-4 py-3"><PartyCell party={record.callee} /></td>
        <td className="px-4 py-3 text-xs font-mono text-nms-text-dim">{formatDuration(record.durationSeconds)}</td>
        <td className="px-4 py-3">
          <span className={clsx('text-xs px-2 py-0.5 rounded-full capitalize', DISPOSITION_COLOR[record.disposition])}>
            {record.disposition.replace('-', ' ')}
          </span>
        </td>
        <td className="px-4 py-3">
          <span className={clsx('text-xs px-2 py-0.5 rounded-full', SOURCE_COLOR[record.sourceSystem])}>
            {SOURCE_LABEL[record.sourceSystem]}
          </span>
        </td>
        <td className="px-4 py-3 text-right">
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-nms-text-dim inline" /> : <ChevronDown className="w-3.5 h-3.5 text-nms-text-dim inline" />}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-nms-border/50 bg-nms-surface-2/30">
          <td colSpan={7} className="px-4 py-3">
            <pre className="text-[11px] font-mono text-nms-text-dim whitespace-pre-wrap break-all">
              {JSON.stringify(record.raw, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

// Mirrors ChargingPlansPage.tsx's VoiceChargingCard — same confirm-dialog
// pattern for a toggle that restarts the live S-CSCF. Unlike voice charging,
// there's no external-service availability gate (no SigScale OCS dependency)
// — this only touches the already-running scscf MySQL database.
function KamailioAccCard({ imsStatus, onChanged }: { imsStatus: ImsStatus | null; onChanged: () => void }) {
  const [toggling, setToggling] = useState(false);
  if (!imsStatus?.hasSavedConfig) return null; // IMS isn't set up at all — nothing to toggle yet

  const enabled = imsStatus.cdrAccountingEnabled;

  const handleToggle = async () => {
    if (!enabled && !window.confirm(
      "Enable direct IMS call recording?\n\nThis restarts the live S-CSCF (Kamailio) to load the accounting " +
      "module. The restart takes a few seconds — in-progress call signaling may briefly hiccup, but active " +
      "call audio (handled by rtpengine, a separate process) is not affected.",
    )) {
      return;
    }
    setToggling(true);
    try {
      const result = await cdrApi.setKamailioAcc(!enabled);
      if (result.success) {
        toast.success(!enabled ? 'IMS call recording enabled — S-CSCF restarted' : 'IMS call recording disabled — S-CSCF restarted');
        onChanged();
      } else {
        toast.error(result.error || 'Failed to update setting');
      }
    } catch (err: any) {
      toast.error(`Failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="flex items-center justify-between flex-wrap gap-3 pt-3 border-t border-nms-border">
      <div>
        <p className="text-sm font-semibold text-nms-text">Direct IMS Call Recording</p>
        <p className="text-xs text-nms-text-dim mt-0.5">
          {enabled
            ? 'Live — direct 4G/5G IMS-to-IMS calls (no PSTN/2G leg) are captured via Kamailio\'s own acc module.'
            : 'Off — only Voice Gateway and Asterisk-2G calls are captured. Direct IMS-to-IMS calls are missing from history.'}
        </p>
      </div>
      <button
        onClick={handleToggle}
        disabled={toggling}
        className={clsx(
          'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0',
          enabled
            ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
            : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text',
        )}
      >
        <Power className="w-3 h-3" />
        {toggling ? '…' : enabled ? 'Enabled' : 'Disabled'}
      </button>
    </div>
  );
}

export function CallHistoryPage() {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(DEFAULT_TIME_RANGE);
  const [sourceSystem, setSourceSystem] = useState<string>('');
  const [imsi, setImsi] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<CdrRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);
  const [imsStatus, setImsStatus] = useState<ImsStatus | null>(null);
  const loadImsStatus = useCallback(() => {
    imsApi.getStatus().then(setImsStatus).catch(() => {});
  }, []);

  const resolveRange = useCallback((): { from: Date; to: Date } => {
    if (timeRange.type === 'absolute') return { from: timeRange.from, to: timeRange.to };
    const to = new Date();
    return { from: new Date(to.getTime() - timeRange.ms), to };
  }, [timeRange]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = resolveRange();
      const result = await cdrApi.list({
        from: from.toISOString(),
        to: to.toISOString(),
        sourceSystem: sourceSystem || undefined,
        imsi: imsi || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(result.rows);
      setTotal(result.total);
    } catch {
      toast.error('Failed to load call history');
    } finally {
      setLoading(false);
    }
  }, [resolveRange, sourceSystem, imsi, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [timeRange, sourceSystem, imsi]);

  useEffect(() => {
    cdrApi.getSettings().then(r => setRetentionDays(r.retentionDays)).catch(() => {});
  }, []);
  useEffect(() => { loadImsStatus(); }, [loadImsStatus]);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      await cdrApi.syncNow();
      toast.success('Sync triggered');
      await load();
    } catch (err: any) {
      toast.error(`Sync failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveRetention = async () => {
    if (retentionDays === null) return;
    setSavingRetention(true);
    try {
      const result = await cdrApi.updateSettings(retentionDays);
      if (result.success) toast.success(`Retention set to ${retentionDays} days`);
      else toast.error(result.error || 'Failed to update retention');
    } catch (err: any) {
      toast.error(`Failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSavingRetention(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
            <History className="w-6 h-6 text-nms-accent" />
            Call History
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Unified call detail records across PSTN, 2G, and 4G/5G IMS.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button onClick={() => setSettingsOpen(o => !o)} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
            <Settings2 className="w-3.5 h-3.5" /> Settings
          </button>
          <button onClick={handleSyncNow} disabled={syncing} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
            <RefreshCw className={clsx('w-3 h-3', syncing && 'animate-spin')} /> Sync Now
          </button>
        </div>
      </div>

      {settingsOpen && (
        <div className="nms-card space-y-3">
          <div className="flex items-end gap-4 flex-wrap">
            <div>
              <label className="nms-label">Retention (days)</label>
              <input aria-label="Retention (days)"
                type="number"
                min={1}
                max={3650}
                className="nms-input w-32"
                value={retentionDays ?? ''}
                onChange={e => setRetentionDays(Number(e.target.value))}
              />
            </div>
            <button onClick={handleSaveRetention} disabled={savingRetention || retentionDays === null} className="nms-btn-primary text-sm">
              {savingRetention ? 'Saving…' : 'Save'}
            </button>
            <p className="text-xs text-nms-text-dim">
              Records older than this are automatically removed. Default is 180 days.
            </p>
          </div>
          <KamailioAccCard imsStatus={imsStatus} onChanged={loadImsStatus} />
        </div>
      )}

      <div className="flex items-start gap-2 p-3 rounded-lg border border-dashed border-nms-border text-xs text-nms-text-dim">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          A call that crosses between systems (e.g. PSTN ↔ 2G via Cross-RAN Calling, or PSTN/2G ↔ IMS) shows
          as two separate records, one per leg — they aren't stitched into a single row. Direct 4G/5G
          IMS-to-IMS calls only appear once "Direct IMS Call Recording" is enabled (Settings, top right). A call
          that rings and then falls through to voicemail is indistinguishable from a normally-answered call —
          voicemail pickup is a real SIP-level answer.
        </span>
      </div>

      <div className="nms-card flex flex-wrap items-end gap-4">
        <TimeRangePicker value={timeRange} onChange={setTimeRange} align="left" />
        <div>
          <label className="nms-label">Source</label>
          <select aria-label="Source" className="nms-input" value={sourceSystem} onChange={e => setSourceSystem(e.target.value)}>
            <option value="">All sources</option>
            <option value="pstn">PSTN</option>
            <option value="2g">2G</option>
            <option value="ims">IMS (4G/5G)</option>
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="nms-label">Subscriber IMSI</label>
          <input aria-label="Subscriber IMSI" className="nms-input font-mono" placeholder="Filter by IMSI" value={imsi} onChange={e => setImsi(e.target.value)} />
        </div>
        <button onClick={load} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5" title="Refresh">
          <RefreshCw className={clsx('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="nms-card overflow-hidden p-0">
        {loading ? (
          <div className="p-12 text-center text-nms-text-dim text-sm">Loading call history…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-nms-text-dim text-sm flex flex-col items-center gap-2">
            <Phone className="w-6 h-6 opacity-40" />
            No calls found for this range/filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-nms-border">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Time</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Caller</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Callee</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Duration</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Disposition</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Source</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => <CdrRow key={r._id} record={r} />)}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-3 border-t border-nms-border">
          <span className="text-xs text-nms-text-dim">{total} record{total !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-2">
            <button aria-label="Previous page" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="nms-btn-ghost text-xs p-1.5 disabled:opacity-40">
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs text-nms-text-dim">Page {page} of {totalPages}</span>
            <button aria-label="Next page" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="nms-btn-ghost text-xs p-1.5 disabled:opacity-40">
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
