import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Antenna, ChevronRight, Loader2, Play, RefreshCw, Search, Square,
} from 'lucide-react';
import {
  CallFlow, CallSummary, FlowHop, SipTraceMessage, SipTraceSource, SipTraceStatus, sipTraceApi,
} from '../../api/sipTrace';
import { CallFlowLadder } from './CallFlowLadder';
import { FullCallsCard } from './FullCallsCard';
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
const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);
const hhmmss = (iso: string) => new Date(iso).toLocaleTimeString();

// The ladder itself lives in CallFlowLadder.tsx. The earlier version here was
// a non-interactive SVG drawn straight from the raw rows: it repeated each
// message once per CSCF that mirrored it, and nothing in it could be clicked.
// It is superseded rather than kept beside the new one -- two near-identical
// diagrams disagreeing about how many messages a call had is worse than one.

// ── Status + control ─────────────────────────────────────────────────────────
function StatusCard({
  status, onChanged, busy, setBusy,
}: {
  status: SipTraceStatus | null;
  onChanged: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}): JSX.Element {
  // Which instances the last apply could not reach because siptrace is not
  // loaded there. Kept in state rather than inferred from status, because the
  // remedy (run an IMS Configure) is advice about an action the operator takes
  // elsewhere, and it should stay on screen after the toast has gone.
  const [notLoaded, setNotLoaded] = useState<string[]>([]);

  const enable = async () => {
    setBusy(true);
    try {
      const r = await sipTraceApi.enable();
      const failed = r.instances.filter(i => i.action === 'failed');
      const missing = r.instances.filter(i => i.action === 'not-loaded').map(i => i.role);
      setNotLoaded(missing);
      if (failed.length) {
        toast.error(`Tracing enabled with problems: ${failed.map(f => `${f.role} (${f.detail})`).join('; ')}`);
      } else if (r.needsConfigure) {
        toast.error(`Capture is not loaded on ${missing.join(', ').toUpperCase()} — run Configure on the IMS page.`, { duration: 9000 });
      } else {
        toast.success('SIP tracing started. No restart, no effect on registrations.');
      }
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
      setNotLoaded([]);
      toast.success('SIP tracing stopped. No restart, no effect on registrations.');
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to disable SIP tracing');
    } finally {
      setBusy(false);
    }
  };

  const c = status?.collector;
  const dropped = c ? Object.entries(c.dropped) : [];

  // Show the "run Configure" advice whenever tracing is meant to be on but an
  // instance has no module, not only in the moment after a click — otherwise
  // the one actionable explanation for an empty trace disappears on refresh.
  const unloadedNow = (status?.runtime ?? []).filter(r => !r.loaded).map(r => r.role);
  const needsConfigure = notLoaded.length > 0 ? notLoaded : (status?.enabled ? unloadedNow : []);

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
          <p className="text-xs text-nms-text-dim mt-1 max-w-3xl">
            The capture module is loaded on all three CSCFs by IMS Configure and stays loaded, so starting and
            stopping is instant and never restarts anything — no handset loses its IPsec security association,
            and the setting survives an IMS restart.
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
            <button onClick={enable} disabled={busy} className="nms-btn-primary text-xs flex items-center gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Start tracing
            </button>
          )}
        </div>
      </div>

      {needsConfigure.length > 0 && (
        <div className="rounded-lg border border-nms-amber/40 bg-nms-amber/10 p-3 space-y-2">
          <p className="text-xs text-nms-amber font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Capture is not loaded on {needsConfigure.join(', ').toUpperCase()}
          </p>
          <p className="text-xs text-nms-text">
            Those instances are running a config from before capture was loaded as standard, and Kamailio only
            loads modules at startup. Run <strong>Configure</strong> on the IMS page once — it restarts the CSCFs
            as it always has — and capture is then permanently available with no further restarts.
          </p>
          <p className="text-xs text-nms-text-dim">
            Nothing was restarted for you: restarting P-CSCF drops every registered handset's IPsec security
            association, so that is left to a deliberate Configure rather than done as a side effect of
            opening a trace.
          </p>
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
                        {/* Loaded is now the normal state on every instance, so "no"
                            means a stale config rather than "tracing is just off".
                            The module being loaded and tracing being on are two
                            different things here, and siptrace's own RPC answers
                            with the tracing state ("Enabled"/"Disabled") -- printing
                            that raw under a "Module loaded" heading reads as though
                            the MODULE were disabled, which is the one distinction
                            this column exists to make. So say both. */}
                        <span className={rt?.loaded ? 'text-nms-green' : 'text-nms-amber'}>
                          {rt?.loaded ? 'yes' : 'no — run IMS Configure'}
                          {rt?.loaded && (
                            <span className="text-nms-text-dim">
                              {rt.status === 'Enabled' ? ' — tracing on'
                                : rt.status === 'Disabled' ? ' — tracing off'
                                : rt.status ? ` — ${rt.status}` : ''}
                            </span>
                          )}
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

      {/* The one failure this page has to name out loud: the tap is working --
          datagrams are arriving on the collector port -- but not one of them
          could be turned into a message. A thin "dropped" line underneath the
          stats is too quiet for that, because the rest of the page looks
          entirely healthy (module loaded, tracing enabled, packets counting
          up) while the capture stays empty. That is exactly how a HEP version
          mismatch went unnoticed: siptrace defaults to HEPv1, the collector
          briefly required HEPv3, and every real message landed in a drop
          counter nobody was reading. */}
      {c && c.packetsReceived > 0 && c.messagesStored === 0 && (
        <div className="rounded-lg border border-nms-red/40 bg-nms-red/10 p-3 space-y-2">
          <p className="text-xs text-nms-red font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Receiving packets but storing none
          </p>
          <p className="text-xs text-nms-text">
            The CSCFs are mirroring SIP to this collector — {c.packetsReceived.toLocaleString()} datagram
            {c.packetsReceived === 1 ? '' : 's'} so far — but none could be decoded, so the capture below
            stays empty. The tap is fine; the collector cannot read what is arriving.
            {dropped.length > 0 && <> Reason{dropped.length === 1 ? '' : 's'}: <span className="font-mono">{dropped.map(([k, v]) => `${k} ×${v}`).join(', ')}</span>.</>}
          </p>
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

// ── Detail for one selected hop ──────────────────────────────────────────────
//
// Opened by clicking an arrow in the ladder. Shows the parsed headers plus the
// verbatim message -- and, when both the sending and the receiving CSCF
// mirrored the same message, each tap's own copy. Those copies are normally
// byte-identical; where they are NOT, that difference is itself the finding
// (a proxy rewrote something in flight), so they are shown separately rather
// than silently de-duplicated here.
function HopDetail({
  flow, hop, onClose,
}: { flow: CallFlow; hop: FlowHop; onClose: () => void }): JSX.Element {
  const ep = (id: string) => flow.endpoints.find(e => e.id === id);
  const observations = hop.messageRefs.map(r => flow.messages[r]).filter(Boolean);
  const identical = observations.length > 1
    && observations.every(o => o.raw === observations[0].raw);

  const facts: { k: string; v: string }[] = [
    { k: 'Message', v: hop.label },
    { k: 'From', v: `${ep(hop.from)?.label ?? hop.from}  (${hop.from})` },
    { k: 'To', v: `${ep(hop.to)?.label ?? hop.to}  (${hop.to})` },
    { k: 'Time', v: `${new Date(hop.timestamp).toLocaleTimeString()}  (${fmtMs(hop.offsetMs)} into the call)` },
    { k: 'Since previous', v: fmtMs(hop.deltaMs) },
    { k: 'CSeq', v: hop.cseqNumber !== undefined ? `${hop.cseqNumber} ${hop.cseqMethod ?? ''}`.trim() : '—' },
    { k: 'Observed by', v: hop.sources.map(x => SOURCE_LABEL[x]).join(', ') },
    { k: 'Call-ID', v: hop.callId },
  ];
  if (hop.retransmission) {
    facts.splice(1, 0, { k: 'Retransmission', v: 'yes — identical bytes sent again' });
  }

  return (
    <div className="rounded-lg border border-nms-accent/40 bg-nms-surface-2/40 p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xs font-semibold" style={{ color: `rgb(var(--nms-accent-rgb))` }}>
          {hop.label}
          <span className="text-nms-text-dim font-normal">
            {' '}· {ep(hop.from)?.label} → {ep(hop.to)?.label}
          </span>
        </h3>
        <button onClick={onClose} className="nms-btn-ghost text-[11px] px-2 py-0.5 shrink-0">Close</button>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        {facts.map(f => (
          <div key={f.k} className="flex gap-2 text-xs min-w-0">
            <dt className="text-nms-text-dim shrink-0 w-28">{f.k}</dt>
            <dd className="font-mono text-nms-text break-all min-w-0">{f.v}</dd>
          </div>
        ))}
      </dl>

      {observations.map((o, i) => (
        <div key={i} className="space-y-1">
          {observations.length > 1 && (
            <p className="text-[11px] text-nms-text-dim">
              As captured by {SOURCE_LABEL[o.source]}
              {i === 0 && identical && ' (all copies identical)'}
            </p>
          )}
          {(i === 0 || !identical) && (
            <pre className="text-[11px] font-mono text-nms-text whitespace-pre-wrap break-all max-h-96 overflow-y-auto bg-nms-bg/40 rounded p-2">
              {o.raw}
            </pre>
          )}
        </div>
      ))}
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
  // Bumped whenever tracing is toggled, so the Calls card refetches too.
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<SipTraceMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [rawOpen, setRawOpen] = useState<number | null>(null);
  const [flow, setFlow] = useState<CallFlow | null>(null);
  const [relatedIds, setRelatedIds] = useState<string[]>([]);
  const [includeRelated, setIncludeRelated] = useState(false);
  const [hop, setHop] = useState<FlowHop | null>(null);
  const [rowsOpen, setRowsOpen] = useState(false);
  // Selecting a call should land the operator ON the flow. The card renders
  // below a potentially long list, so without this a click looks like it did
  // nothing at all.
  const flowRef = useRef<HTMLDivElement | null>(null);

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
        // This card is deliberately the unfiltered view -- every dialog,
        // keepalives and registrations included. Actual calls get their own
        // card above, so neither view has to compromise for the other.
        kind: 'all',
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

  const openCall = useCallback(async (callId: string, withRelated: boolean) => {
    setSelected(callId);
    setRawOpen(null);
    setHop(null);
    setLoadingMessages(true);
    try {
      const r = await sipTraceApi.getCallFlow(callId, withRelated);
      setFlow(r.flow);
      // The flow response carries the rows it was built from, so the raw table
      // below is always exactly what the ladder was derived from -- no second
      // fetch that could disagree with it.
      setMessages(r.flow.messages);
      setRelatedIds(r.related);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to load that dialog');
      setFlow(null);
      setMessages([]);
      setRelatedIds([]);
    } finally {
      setLoadingMessages(false);
      // After paint, so the card exists to scroll to. Honours the global
      // reduced-motion preference rather than always smooth-scrolling.
      requestAnimationFrame(() => {
        const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        flowRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
      });
    }
  }, []);

  // Re-fetch when the operator folds related dialogs in or out.
  useEffect(() => {
    if (selected) void openCall(selected, includeRelated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeRelated]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <StatusCard
        status={status}
        onChanged={() => { void loadStatus(); void loadCalls(); setRefreshKey(k => k + 1); }}
        busy={busy}
        setBusy={setBusy}
      />

      <FullCallsCard
        onOpen={id => void openCall(id, includeRelated)}
        selectedCallId={selected}
        tracingEnabled={status?.enabled ?? false}
        refreshKey={refreshKey}
      />

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
                        onClick={() => void openCall(c.callId, includeRelated)}
                        onKeyDown={activateOnKey(() => void openCall(c.callId, includeRelated))}
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
        <div ref={flowRef} className="nms-card space-y-4 scroll-mt-4">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-nms-accent">Call flow</h2>
              <p className="text-xs text-nms-text-dim mt-1 font-mono break-all">
                {(flow?.dialogs ?? [selected]).join('  +  ')}
              </p>
              {flow && (
                <p className="text-xs text-nms-text-dim mt-1">
                  {flow.hops.length} message{flow.hops.length === 1 ? '' : 's'} across{' '}
                  {flow.endpoints.length} endpoint{flow.endpoints.length === 1 ? '' : 's'}
                  {flow.mergedDuplicates > 0 && (
                    <>
                      {' · '}
                      <span title="The same message is mirrored by both the sending and the receiving CSCF; those pairs are shown once.">
                        {flow.mergedDuplicates} duplicate observation
                        {flow.mergedDuplicates === 1 ? '' : 's'} merged
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {relatedIds.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-nms-text cursor-pointer">
                  <input
                    type="checkbox"
                    className="nms-checkbox"
                    checked={includeRelated}
                    onChange={e => setIncludeRelated(e.target.checked)}
                  />
                  {/* A B2BUA (PSTN Gateway, Asterisk-2G, Cross-RAN) terminates one
                      dialog and originates another, so one real call is genuinely
                      two Call-IDs with no SIP-level link. Folding them in is the
                      only way to see such a call end to end -- but the link is
                      matched on shared party and time, so it is opt-in. */}
                  Include {relatedIds.length} related dialog{relatedIds.length === 1 ? '' : 's'}
                </label>
              )}
              <button onClick={() => setSelected(null)} className="nms-btn-ghost text-xs">Close</button>
            </div>
          </div>

          {loadingMessages ? (
            <p className="text-xs text-nms-text-dim flex items-center gap-2 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading dialog…
            </p>
          ) : (
            <>
              {flow && (
                <CallFlowLadder
                  flow={flow}
                  selected={hop?.index ?? null}
                  onSelect={h => setHop(prev => (prev?.index === h.index ? null : h))}
                />
              )}

              {hop && flow && <HopDetail flow={flow} hop={hop} onClose={() => setHop(null)} />}
              {!hop && flow && flow.hops.length > 0 && (
                <p className="text-xs text-nms-text-dim">
                  Select any message in the flow above to see its headers and full SIP body.
                </p>
              )}

              <div>
                <button
                  onClick={() => setRowsOpen(o => !o)}
                  aria-expanded={rowsOpen}
                  className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2 py-1"
                >
                  <ChevronRight className={clsx('w-3 h-3 transition-transform', rowsOpen && 'rotate-90')} />
                  {rowsOpen ? 'Hide' : 'Show'} all {messages.length} captured row
                  {messages.length === 1 ? '' : 's'}
                </button>
                {/* Kept alongside the ladder, not replaced by it: the ladder shows
                    one row per message on the wire, this shows every row actually
                    stored -- including each CSCF's own copy of the same message.
                    When the two disagree, this is the one that is literally true. */}
                <p className="text-xs text-nms-text-dim mt-1">
                  Every row as captured, including each CSCF's separate copy of the same message.
                </p>
              </div>

              <div className={clsx('nms-table-wrap', !rowsOpen && 'hidden')}>
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
