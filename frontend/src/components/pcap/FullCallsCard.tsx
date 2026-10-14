import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { PhoneCall, RefreshCw, Search } from 'lucide-react';
import { CallSummary, sipTraceApi } from '../../api/sipTrace';
import { activateOnKey } from '../../hooks/useKeyboardA11y';

// ── Full calls ───────────────────────────────────────────────────────────────
//
// Just the calls, by who called whom. Separate from the Dialogs card rather
// than a filter on it, because the two answer different questions and each
// would otherwise compromise the other: Dialogs is the complete record of
// everything captured, and on a live IMS that is overwhelmingly keepalives
// and re-REGISTERs (measured here: 187 dialogs, of which 1 was a call).
// Hunting a call in that list is the thing this card removes.
//
// "Full call" means a dialog containing an INVITE -- the server decides that,
// via kind: 'calls'.

const PAGE_SIZE = 15;

/** Plain words for the outcomes that actually come up, code otherwise. */
const OUTCOME: Record<number, string> = {
  200: 'Answered',
  404: 'Not found',
  408: 'Timed out',
  480: 'Unavailable',
  486: 'Busy',
  487: 'Cancelled',
  603: 'Declined',
};

function outcome(status?: number): { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' } {
  if (status === undefined) return { text: 'In progress', tone: 'dim' };
  const text = OUTCOME[status] ?? String(status);
  if (status < 200) return { text, tone: 'dim' };
  if (status < 300) return { text, tone: 'ok' };
  if (status < 400) return { text, tone: 'warn' };
  return { text, tone: 'bad' };
}

function duration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function FullCallsCard({
  onOpen,
  selectedCallId,
  tracingEnabled,
  refreshKey,
}: {
  onOpen: (callId: string) => void;
  selectedCallId: string | null;
  tracingEnabled: boolean;
  refreshKey: number;
}): JSX.Element {
  const [rows, setRows] = useState<CallSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await sipTraceApi.listCalls({
        kind: 'calls',
        search: search || undefined,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(r.rows);
      setTotal(r.total);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to load calls');
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="nms-card space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-nms-accent flex items-center gap-1.5">
            <PhoneCall className="w-3.5 h-3.5" /> Calls
          </h2>
          <p className="text-xs text-nms-text-dim mt-1">
            Who called whom. Select a call for its end-to-end flow.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5"
        >
          <RefreshCw className={clsx('w-3 h-3', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nms-text-dim pointer-events-none" />
        <input
          className="nms-input pl-9"
          aria-label="Search calls by number"
          placeholder="Search by number…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {rows.length === 0 && !loading ? (
        <p className="text-xs text-nms-text-dim py-6 text-center">
          {tracingEnabled
            ? 'No calls captured yet. Place a call — every dialog captured, including registrations and keepalives, is listed under Dialogs below.'
            : 'SIP tracing is off — nothing is being captured. Start tracing above to begin.'}
        </p>
      ) : (
        <div className="nms-table-wrap">
          <div className="nms-table-scroll">
            <table className="w-full text-xs">
              <thead className="bg-nms-surface-2 text-nms-text-dim">
                <tr>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">Started</th>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">From</th>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">To</th>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">Duration</th>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">Result</th>
                  <th scope="col" className="text-right px-3 py-1.5 font-medium">Messages</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(c => {
                  const o = outcome(c.lastStatus);
                  const isSel = selectedCallId === c.callId;
                  return (
                    <tr
                      key={c.callId}
                      tabIndex={0}
                      aria-selected={isSel}
                      onClick={() => onOpen(c.callId)}
                      onKeyDown={activateOnKey(() => onOpen(c.callId))}
                      title={c.callId}
                      className={clsx(
                        'border-t border-nms-border cursor-pointer',
                        isSel ? 'bg-nms-accent/10' : 'hover:bg-nms-surface-2/60',
                      )}
                    >
                      <td className="px-3 py-1.5 font-mono text-nms-text-dim whitespace-nowrap">
                        {new Date(c.startTime).toLocaleTimeString()}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-nms-text whitespace-nowrap">
                        {c.fromUser ?? '—'}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-nms-text whitespace-nowrap">
                        {c.toUser ?? '—'}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-nms-text-dim whitespace-nowrap">
                        {duration(c.startTime, c.endTime)}
                      </td>
                      <td
                        className={clsx(
                          'px-3 py-1.5 whitespace-nowrap',
                          o.tone === 'ok' && 'text-nms-green',
                          o.tone === 'warn' && 'text-nms-amber',
                          o.tone === 'bad' && 'text-nms-red',
                          o.tone === 'dim' && 'text-nms-text-dim',
                        )}
                      >
                        {o.text}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-nms-text-dim">
                        {c.messageCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-nms-text-dim">
          <span>{total.toLocaleString()} calls</span>
          <div className="flex items-center gap-2">
            <button
              aria-label="Previous page of calls"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="nms-btn-ghost text-xs px-2 py-1"
            >
              Prev
            </button>
            <span className="font-mono">{page} / {totalPages}</span>
            <button
              aria-label="Next page of calls"
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              className="nms-btn-ghost text-xs px-2 py-1"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
