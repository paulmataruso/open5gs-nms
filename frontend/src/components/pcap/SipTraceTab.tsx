import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Antenna, ChevronRight, Loader2, Play, RefreshCw, Search, Square,
} from 'lucide-react';
import {
  CallSummary, SipTraceMessage, SipTraceSource, SipTraceStatus, sipTraceApi,
} from '../../api/sipTrace';
import { activateOnKey } from '../../hooks/useKeyboardA11y';

// ── SIP Capture ──────────────────────────────────────────────────────────────
//
// Reads the HEP stream Kamailio's own siptrace module duplicates to the NMS,
// rather than sniffing packets. On this deployment that is the only thing that
// works for the UE leg: UE<->P-CSCF SIP travels inside IPsec ESP, so a sniffer
// on the radio-facing interface sees ESP, not SIP. siptrace taps inside the
// proxy, after decryption.

const SOURCE_LABEL: Record<SipTraceSource, string> = {
  pcscf: 'P-CSCF', icscf: 'I-CSCF', scscf: 'S-CSCF', unknown: 'Unknown',
};

const METHODS = ['INVITE', 'REGISTER', 'BYE', 'MESSAGE', 'SUBSCRIBE', 'NOTIFY', 'OPTIONS', 'CANCEL', 'ACK', 'UPDATE', 'PRACK'];

/** Theme-token colour for a message, by SIP semantics. */
function toneVar(m: SipTraceMessage): string {
  if (m.statusCode === undefined) return '--nms-accent-rgb';
  if (m.statusCode < 200) return '--nms-amber-rgb';
  if (m.statusCode < 300) return '--nms-green-rgb';
  if (m.statusCode < 400) return '--nms-amber-rgb';
  return '--nms-red-rgb';
}

const label = (m: SipTraceMessage): string =>
  m.method ?? `${m.statusCode ?? '?'} ${m.statusReason ?? ''}${m.cseqMethod ? ` (${m.cseqMethod})` : ''}`.trim();

const peer = (ip: string, port: number) => `${ip}:${port}`;
const hhmmss = (iso: string) => new Date(iso).toLocaleTimeString();
const ms = (a: string, b: string) => new Date(b).getTime() - new Date(a).getTime();

// ── Ladder diagram ───────────────────────────────────────────────────────────
//
// Decorative in the accessibility sense: it carries no information the message
// table below does not, and is marked role="img" with a summary label rather
// than being made navigable. Screen-reader users get the table, which is the
// better representation anyway.
function LadderDiagram({ messages }: { messages: SipTraceMessage[] }): JSX.Element {
  const peers = useMemo(() => {
    const seen: string[] = [];
    for (const m of messages) {
      for (const p of [peer(m.srcIp, m.srcPort), peer(m.dstIp, m.dstPort)]) {
        if (!seen.includes(p)) seen.push(p);
      }
    }
    return seen;
  }, [messages]);

  if (peers.length < 2) {
    return (
      <p className="text-xs text-nms-text-dim py-4">
        Not enough endpoint information in this dialog to draw a flow.
      </p>
    );
  }

  const colW = Math.max(150, Math.min(260, 1100 / peers.length));
  const rowH = 46;
  const padTop = 54;
  const padLeft = 24;
  const width = padLeft * 2 + colW * (peers.length - 1) + 180;
  const height = padTop + rowH * messages.length + 20;
  const x = (p: string) => padLeft + 90 + peers.indexOf(p) * colW;

  return (
    <div className="overflow-x-auto">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Call flow: ${messages.length} messages between ${peers.length} endpoints. The same information is listed in the message table below.`}
        style={{ minWidth: width }}
      >
        {/* lifelines */}
        {peers.map(p => (
          <g key={p}>
            <text
              x={x(p)} y={20} textAnchor="middle"
              style={{ fill: 'rgb(var(--nms-text-rgb))', fontSize: 11, fontFamily: 'inherit' }}
            >
              {p.split(':')[0]}
            </text>
            <text
              x={x(p)} y={34} textAnchor="middle"
              style={{ fill: 'rgb(var(--nms-text-dim-rgb))', fontSize: 10, fontFamily: 'inherit' }}
            >
              :{p.split(':')[1]}
            </text>
            <line
              x1={x(p)} y1={42} x2={x(p)} y2={height - 10}
              style={{ stroke: 'rgb(var(--nms-border-strong-rgb))', strokeWidth: 1 }}
            />
          </g>
        ))}

        {messages.map((m, i) => {
          const from = x(peer(m.srcIp, m.srcPort));
          const to = x(peer(m.dstIp, m.dstPort));
          const y = padTop + i * rowH + 14;
          const rightward = to >= from;
          const color = `rgb(var(${toneVar(m)}))`;
          const selfCall = from === to;
          return (
            <g key={`${m.timestamp}-${m.seq}`}>
              <text
                x={8} y={y + 4}
                style={{ fill: 'rgb(var(--nms-text-dim-rgb))', fontSize: 10, fontFamily: 'ui-monospace, monospace' }}
              >
                {i === 0 ? '0ms' : `+${ms(messages[0].timestamp, m.timestamp)}ms`}
              </text>
              {selfCall ? (
                <path
                  d={`M ${from} ${y} q 40 10 0 20`}
                  fill="none"
                  style={{ stroke: color, strokeWidth: 1.5 }}
                />
              ) : (
                <line
                  x1={from} y1={y} x2={to} y2={y}
                  style={{ stroke: color, strokeWidth: 1.5 }}
                />
              )}
              {!selfCall && (
                <polygon
                  points={rightward ? `${to},${y} ${to - 7},${y - 4} ${to - 7},${y + 4}` : `${to},${y} ${to + 7},${y - 4} ${to + 7},${y + 4}`}
                  style={{ fill: color }}
                />
              )}
              <text
                x={selfCall ? from + 46 : (from + to) / 2}
                y={y - 6}
                textAnchor={selfCall ? 'start' : 'middle'}
                style={{ fill: color, fontSize: 11, fontFamily: 'inherit', fontWeight: 500 }}
              >
                {label(m)}
              </text>
              <text
                x={selfCall ? from + 46 : (from + to) / 2}
                y={y + 14}
                textAnchor={selfCall ? 'start' : 'middle'}
                style={{ fill: 'rgb(var(--nms-text-dim-rgb))', fontSize: 9, fontFamily: 'inherit' }}
              >
                {SOURCE_LABEL[m.source]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Status + control ─────────────────────────────────────────────────────────
function StatusCard({
  status, onChanged, busy, setBusy,
}: {
  status: SipTraceStatus | null;
  onChanged: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      const r = await sipTraceApi.enable();
      const failed = r.instances.filter(i => i.action === 'failed');
      if (failed.length) {
        toast.error(`Tracing enabled with problems: ${failed.map(f => `${f.role} (${f.detail})`).join('; ')}`);
      } else if (r.restarted) {
        toast.success('SIP tracing enabled. CSCFs restarted — registered handsets must re-register before they can call.', { duration: 9000 });
      } else {
        toast.success('SIP tracing enabled (no restart needed).');
      }
      setConfirmOpen(false);
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to enable SIP tracing');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await sipTraceApi.disable();
      toast.success('SIP tracing stopped. No restart was needed, so no registrations were affected.');
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to disable SIP tracing');
    } finally {
      setBusy(false);
    }
  };

  const c = status?.collector;
  const dropped = c ? Object.entries(c.dropped) : [];

  return (
    <div className="nms-card space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-nms-accent flex items-center gap-2">
            <Antenna className="w-4 h-4" /> SIP Tracing (HEP)
          </h2>
          <p className="text-xs text-nms-text-dim mt-1 max-w-3xl">
            Mirrors every SIP message the CSCFs handle, taken from inside Kamailio rather than off the wire —
            so it sees the UE leg even though that traffic is inside IPsec, which a packet capture cannot.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={clsx(
              'text-xs px-2 py-1 rounded-md border font-medium',
              status?.enabled
                ? 'bg-nms-green/15 text-nms-green border-nms-green/30'
                : 'bg-nms-surface-2 text-nms-text-dim border-nms-border',
            )}
          >
            {status?.enabled ? 'Tracing on' : 'Tracing off'}
          </span>
          {status?.enabled ? (
            <button onClick={disable} disabled={busy} className="nms-btn-ghost text-xs flex items-center gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />} Stop tracing
            </button>
          ) : (
            <button onClick={() => setConfirmOpen(true)} disabled={busy} className="nms-btn-primary text-xs flex items-center gap-1.5">
              <Play className="w-3.5 h-3.5" /> Start tracing
            </button>
          )}
        </div>
      </div>

      {confirmOpen && !status?.enabled && (
        <div className="rounded-lg border border-nms-amber/40 bg-nms-amber/10 p-3 space-y-2">
          <p className="text-xs text-nms-amber font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Starting tracing restarts the three CSCFs
          </p>
          <p className="text-xs text-nms-text">
            Kamailio can only load the tracing module at startup, so each CSCF is restarted once.
            Restarting P-CSCF <strong>drops every registered handset's IPsec security association</strong>:
            affected phones will still look registered but cannot place or receive a call until they
            re-register for real (toggle Airplane Mode, or restart the handset).
          </p>
          <p className="text-xs text-nms-text-dim">
            Stopping tracing again later is free — it uses Kamailio's own runtime control and needs no restart.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={enable} disabled={busy} className="nms-btn-primary text-xs flex items-center gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Restart the CSCFs and start tracing
            </button>
            <button onClick={() => setConfirmOpen(false)} disabled={busy} className="nms-btn-ghost text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      {c && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { k: 'Collector', v: c.running ? `listening on ${c.bind}` : 'not running', tone: c.running ? 'ok' : 'bad' },
            { k: 'Messages stored', v: status?.messages?.toLocaleString() ?? '—' },
            { k: 'Packets received', v: c.packetsReceived.toLocaleString() },
            { k: 'Retention', v: `${status?.settings.retentionHours ?? '—'}h` },
          ].map(s => (
            <div key={s.k} className="rounded-lg border border-nms-border bg-nms-surface-2/40 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wider text-nms-text-dim">{s.k}</div>
              <div className={clsx('text-xs font-mono mt-0.5', s.tone === 'bad' ? 'text-nms-red' : 'text-nms-text')}>
                {s.v}
              </div>
            </div>
          ))}
        </div>
      )}

      {c && (
        <div className="nms-table-wrap">
          <div className="nms-table-scroll">
            <table className="w-full text-xs">
              <thead className="bg-nms-surface-2 text-nms-text-dim">
                <tr>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">Instance</th>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">Collector port</th>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">Listening</th>
                  <th scope="col" className="text-left px-3 py-1.5 font-medium">Module loaded</th>
                  <th scope="col" className="text-right px-3 py-1.5 font-medium">Packets</th>
                </tr>
              </thead>
              <tbody>
                {c.listeners.map(l => {
                  const rt = status?.runtime.find(r => r.role === l.source);
                  return (
                    <tr key={l.port} className="border-t border-nms-border">
                      <td className="px-3 py-1.5 font-medium text-nms-text">{SOURCE_LABEL[l.source]}</td>
                      <td className="px-3 py-1.5 font-mono text-nms-text-dim">{l.port}/udp</td>
                      <td className="px-3 py-1.5">
                        <span className={l.bound ? 'text-nms-green' : 'text-nms-red'}>{l.bound ? 'yes' : 'no'}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={rt?.loaded ? 'text-nms-green' : 'text-nms-text-dim'}>
                          {rt?.loaded ? (rt.status || 'yes') : 'no'}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-nms-text-dim">
                        {(c.packetsBySource[l.source] ?? 0).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dropped.length > 0 && (
        <p className="text-xs text-nms-amber">
          Dropped datagrams: {dropped.map(([k, v]) => `${k} ×${v}`).join(', ')}
          {c?.queueOverflowDrops ? `, queue overflow ×${c.queueOverflowDrops}` : ''}
        </p>
      )}
      {c?.lastError && (
        <p className="text-xs text-nms-text-dim">
          Last collector error: <span className="font-mono text-nms-red">{c.lastError}</span>
        </p>
      )}
    </div>
  );
}

// ── Main tab ─────────────────────────────────────────────────────────────────
export function SipTraceTab(): JSX.Element {
  const [status, setStatus] = useState<SipTraceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('');
  const [source, setSource] = useState<'' | SipTraceSource>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<SipTraceMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [rawOpen, setRawOpen] = useState<number | null>(null);

  const pageSize = 25;

  const loadStatus = useCallback(async () => {
    try { setStatus(await sipTraceApi.getStatus()); } catch { /* status is best-effort */ }
  }, []);

  const loadCalls = useCallback(async () => {
    setLoadingCalls(true);
    try {
      const r = await sipTraceApi.listCalls({
        search: search || undefined,
        method: method || undefined,
        source: source || undefined,
        page,
        pageSize,
      });
      setCalls(r.rows);
      setTotal(r.total);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to load calls');
    } finally {
      setLoadingCalls(false);
    }
  }, [search, method, source, page]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => { void loadCalls(); }, [loadCalls]);
  useEffect(() => {
    const t = setInterval(() => { void loadStatus(); }, 10000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const openCall = async (callId: string) => {
    setSelected(callId);
    setRawOpen(null);
    setLoadingMessages(true);
    try {
      setMessages(await sipTraceApi.getCallMessages(callId));
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to load that dialog');
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <StatusCard status={status} onChanged={() => { void loadStatus(); void loadCalls(); }} busy={busy} setBusy={setBusy} />

      <div className="nms-card space-y-4">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <h2 className="text-sm font-semibold text-nms-accent">Dialogs</h2>
          <button
            onClick={() => { void loadCalls(); void loadStatus(); }}
            className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5"
          >
            <RefreshCw className={clsx('w-3 h-3', loadingCalls && 'animate-spin')} /> Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nms-text-dim pointer-events-none" />
            <input
              className="nms-input pl-9"
              aria-label="Search dialogs by Call-ID or party"
              placeholder="Search Call-ID, IMPU or number…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <select
            className="nms-input md:w-44"
            aria-label="Filter by method"
            value={method}
            onChange={e => { setMethod(e.target.value); setPage(1); }}
          >
            <option value="">All methods</option>
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <select
            className="nms-input md:w-40"
            aria-label="Filter by CSCF"
            value={source}
            onChange={e => { setSource(e.target.value as SipTraceSource | ''); setPage(1); }}
          >
            <option value="">All CSCFs</option>
            {(['pcscf', 'icscf', 'scscf'] as SipTraceSource[]).map(s => (
              <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
            ))}
          </select>
        </div>

        {calls.length === 0 && !loadingCalls ? (
          <p className="text-xs text-nms-text-dim py-6 text-center">
            {status?.enabled
              ? 'No SIP dialogs captured yet. Place or receive a call, or wait for a handset to re-register.'
              : 'SIP tracing is off — nothing is being captured. Start tracing above to begin.'}
          </p>
        ) : (
          <div className="nms-table-wrap">
            <div className="nms-table-scroll">
              <table className="w-full text-xs">
                <thead className="bg-nms-surface-2 text-nms-text-dim">
                  <tr>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Started</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Method</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">From</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">To</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Result</th>
                    <th scope="col" className="text-right px-3 py-1.5 font-medium">Msgs</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Call-ID</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map(c => {
                    const isSel = selected === c.callId;
                    return (
                      <tr
                        key={c.callId}
                        onClick={() => void openCall(c.callId)}
                        onKeyDown={activateOnKey(() => void openCall(c.callId))}
                        tabIndex={0}
                        aria-selected={isSel}
                        className={clsx(
                          'border-t border-nms-border cursor-pointer transition-colors',
                          isSel ? 'bg-nms-accent/10' : 'hover:bg-nms-surface-2/50',
                        )}
                      >
                        <td className="px-3 py-1.5 font-mono text-nms-text-dim whitespace-nowrap">{hhmmss(c.startTime)}</td>
                        <td className="px-3 py-1.5 font-medium text-nms-text">{c.initialMethod ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-nms-text-dim">{c.fromUser ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-nms-text-dim">{c.toUser ?? '—'}</td>
                        <td className="px-3 py-1.5">
                          {c.lastStatus === undefined ? (
                            <span className="text-nms-text-dim">—</span>
                          ) : (
                            <span
                              className="font-mono"
                              style={{
                                color: `rgb(var(${
                                  c.lastStatus < 300 ? '--nms-green-rgb' : c.lastStatus < 400 ? '--nms-amber-rgb' : '--nms-red-rgb'
                                }))`,
                              }}
                            >
                              {c.lastStatus}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-nms-text-dim">{c.messageCount}</td>
                        <td className="px-3 py-1.5 font-mono text-nms-text-dim truncate max-w-[18rem]" title={c.callId}>
                          {c.callId}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {total > pageSize && (
          <div className="flex items-center justify-between text-xs text-nms-text-dim">
            <span>{total.toLocaleString()} dialogs</span>
            <div className="flex items-center gap-2">
              <button
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                className="nms-btn-ghost text-xs px-2 py-1"
              >
                Prev
              </button>
              <span className="font-mono">{page} / {totalPages}</span>
              <button
                aria-label="Next page"
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

      {selected && (
        <div className="nms-card space-y-4">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-nms-accent">Call flow</h2>
              <p className="text-xs text-nms-text-dim mt-1 font-mono break-all">{selected}</p>
            </div>
            <button onClick={() => setSelected(null)} className="nms-btn-ghost text-xs shrink-0">Close</button>
          </div>

          {loadingMessages ? (
            <p className="text-xs text-nms-text-dim flex items-center gap-2 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading dialog…
            </p>
          ) : (
            <>
              <LadderDiagram messages={messages} />

              <div className="nms-table-wrap">
                <div className="nms-table-scroll">
                  <table className="w-full text-xs">
                    <thead className="bg-nms-surface-2 text-nms-text-dim">
                      <tr>
                        <th scope="col" className="text-left px-3 py-1.5 font-medium">Time</th>
                        <th scope="col" className="text-left px-3 py-1.5 font-medium">CSCF</th>
                        <th scope="col" className="text-left px-3 py-1.5 font-medium">Message</th>
                        <th scope="col" className="text-left px-3 py-1.5 font-medium">From → To</th>
                        <th scope="col" className="px-3 py-1.5 font-medium text-left">Raw</th>
                      </tr>
                    </thead>
                    <tbody>
                      {messages.map((m, i) => (
                        <Fragment key={`${m.timestamp}-${m.seq}`}>
                          <tr className="border-t border-nms-border">
                            <td className="px-3 py-1.5 font-mono text-nms-text-dim whitespace-nowrap">
                              {hhmmss(m.timestamp)}
                            </td>
                            <td className="px-3 py-1.5 text-nms-text-dim">{SOURCE_LABEL[m.source]}</td>
                            <td className="px-3 py-1.5 font-medium" style={{ color: `rgb(var(${toneVar(m)}))` }}>
                              {label(m)}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-nms-text-dim whitespace-nowrap">
                              {peer(m.srcIp, m.srcPort)} → {peer(m.dstIp, m.dstPort)}
                            </td>
                            <td className="px-3 py-1.5">
                              <button
                                onClick={() => setRawOpen(rawOpen === i ? null : i)}
                                aria-expanded={rawOpen === i}
                                className="nms-btn-ghost text-[11px] px-2 py-0.5 flex items-center gap-1"
                              >
                                <ChevronRight className={clsx('w-3 h-3 transition-transform', rawOpen === i && 'rotate-90')} />
                                {rawOpen === i ? 'Hide' : 'Show'}
                              </button>
                            </td>
                          </tr>
                          {rawOpen === i && (
                            <tr className="border-t border-nms-border bg-nms-bg/40">
                              <td colSpan={5} className="px-3 py-2">
                                <pre className="text-[11px] font-mono text-nms-text whitespace-pre-wrap break-all max-h-80 overflow-y-auto">
                                  {m.raw}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
