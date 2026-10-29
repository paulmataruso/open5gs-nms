import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { ChevronRight, Loader2, RefreshCw, Search } from 'lucide-react';
import {
  CallFlow, CallSummary, FlowHop, SipTraceMessage, SipTraceSource, SipTraceStatus, sipTraceApi,
} from '../../api/sipTrace';
import { CallFlowLadder } from './CallFlowLadder';
import { FullCallsCard } from './FullCallsCard';
import { TraceStatusCard } from './TraceStatusCard';
import { HopDetailCard } from './HopDetailCard';
import { CallDebugCard } from './CallDebugCard';
import { Crosshair, Radio } from 'lucide-react';
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

// The ladder itself lives in CallFlowLadder.tsx. The earlier version here was
// a non-interactive SVG drawn straight from the raw rows: it repeated each
// message once per CSCF that mirrored it, and nothing in it could be clicked.
// It is superseded rather than kept beside the new one -- two near-identical
// diagrams disagreeing about how many messages a call had is worse than one.

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
  /**
   * Call Debug is the default view, not Live Trace. An operator opening this
   * page is overwhelmingly here about one specific call, and the unscoped list
   * is dominated by traffic they did not come for.
   */
  const [view, setView] = useState<'debug' | 'live'>('debug');
  /** Set while a Call Debug session is scoping the write path. */
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
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
        // Narrowed to one Call Debug session when the operator arrived from
        // it. Queried by session id rather than by re-searching the numbers:
        // re-deriving would re-run the suffix and short-code rules at read
        // time and could disagree with what was actually captured, which is
        // the one answer a diagnostic must never give.
        sessionId: sessionFilter || undefined,
        // Otherwise deliberately the unfiltered view -- every dialog,
        // registrations included. Actual calls get their own card above, so
        // neither view has to compromise for the other.
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
  }, [search, method, source, page, sessionFilter]);

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
      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {([
            { id: 'debug' as const, label: 'Call Debug', Icon: Crosshair },
            { id: 'live' as const, label: 'Live Trace', Icon: Radio },
          ]).map(t => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              aria-current={view === t.id ? 'page' : undefined}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                view === t.id
                  ? 'bg-nms-accent text-nms-accent-fg shadow-sm'
                  : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
              )}
            >
              <t.Icon className="w-4 h-4" aria-hidden="true" /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'debug' && (
        <CallDebugCard
          active={status?.callDebug?.active ?? null}
          onChanged={() => { void loadStatus(); void loadCalls(); setRefreshKey(k => k + 1); }}
          onOpenSession={id => {
            // Jump to the trace list already narrowed to that session, rather
            // than making the operator retype the numbers into the search box
            // and hope the suffix rules agree with what was captured.
            setSessionFilter(id);
            setView('live');
            setPage(1);
          }}
        />
      )}

      {view === 'live' && sessionFilter && (
        <div className="rounded-lg border border-nms-accent/40 bg-nms-accent/10 p-3 flex items-start justify-between gap-3 flex-wrap">
          <p className="text-xs text-nms-text">
            Showing only the dialogs captured by session <span className="font-mono">{sessionFilter}</span>.
          </p>
          <button onClick={() => { setSessionFilter(null); setPage(1); }} className="nms-btn-ghost text-xs px-2.5 py-1">
            Show all dialogs
          </button>
        </div>
      )}

      {view === 'live' && !sessionFilter && status?.callDebug?.active && !status.callDebug.active.tagOnly && (
        <div className="rounded-lg border border-nms-amber/40 bg-nms-amber/10 p-3 flex items-start justify-between gap-3 flex-wrap">
          <p className="text-xs text-nms-text">
            A Call Debug session is scoping the capture to{' '}
            <span className="font-mono">{status.callDebug.active.parties.map(p => p.input).join(' ↔ ')}</span>, so SIP
            traffic for other parties is <span className="font-medium">not being stored</span>. This list will not grow
            for anyone else until it stops.
          </p>
          <button onClick={() => setView('debug')} className="nms-btn-ghost text-xs px-2.5 py-1 shrink-0">
            Go to session
          </button>
        </div>
      )}

      {view === 'live' && <TraceStatusCard
        status={status}
        onChanged={() => { void loadStatus(); void loadCalls(); setRefreshKey(k => k + 1); }}
        busy={busy}
        setBusy={setBusy}
      />}

      {view === 'live' && <FullCallsCard
        onOpen={id => void openCall(id, includeRelated)}
        selectedCallId={selected}
        tracingEnabled={status?.enabled ?? false}
        refreshKey={refreshKey}
      />}

      {view === 'live' && <div className="nms-card space-y-4">
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
      </div>}

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

              {hop && flow && <HopDetailCard flow={flow} hop={hop} onClose={() => setHop(null)} />}
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
