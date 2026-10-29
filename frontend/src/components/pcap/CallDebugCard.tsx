import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, Loader2,
  Play, ShieldCheck, ShieldOff, Square, Trash2, Users,
} from 'lucide-react';
import {
  ActiveCallDebugSession, CallDebugSession, DialogScope, ResolvedParty, sipTraceApi,
} from '../../api/sipTrace';
import { pcapApi } from '../../api/pcap';
import { activateOnKey } from '../../hooks/useKeyboardA11y';

// ── Call Debug ───────────────────────────────────────────────────────────────
//
// Scope one debugging session to two numbers: the SIP trace stores only those
// parties' call dialogs, and a real packet capture runs alongside it over the
// same window.
//
// The packet capture is not a nice-to-have here. For a call out to the PSTN the
// SIP trace physically CANNOT see the far leg: Asterisk is a B2BUA, its second
// dialog carries a different Call-ID, and that dialog never traverses a CSCF,
// so no HEP tap ever receives it. The pcap is the only view of it.

const SCOPE_LABEL: Record<DialogScope, string> = {
  calls: 'Call dialogs only',
  callsAndRegistration: 'Calls + registration',
  all: 'Everything for these parties',
};

const SCOPE_HELP: Record<DialogScope, string> = {
  calls:
    'INVITE dialogs and everything in them. Excludes the reg-event SUBSCRIBE/NOTIFY dialog, which carries the subscriber’s own number and runs continuously — it has been measured at over 200 messages in a single dialog.',
  callsAndRegistration:
    'Also keeps REGISTER and its 401/200. Worth it when the complaint is that a call never arrived: registration uses a different SIP identity from dialling, so it is absent from the call dialog entirely.',
  all: 'Every dialog involving these parties. Keepalives are still suppressed.',
};

const DURATIONS = [
  { s: 120, label: '2 min' },
  { s: 300, label: '5 min' },
  { s: 600, label: '10 min' },
  { s: 1800, label: '30 min' },
  { s: 3600, label: '1 hour' },
];

const fmtBytes = (n?: number) =>
  !n ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const elapsed = (from: string, to?: string) => {
  const secs = Math.max(0, Math.floor(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
};

/** One resolved party: what it is, and whether a call to it could even work. */
function PartyChip({ p }: { p: ResolvedParty }): JSX.Element {
  const external = p.kind === 'external';
  return (
    <div className="rounded-lg border border-nms-border bg-nms-surface-2/40 px-3 py-2 space-y-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-nms-text">{p.input}</span>
        <span className={clsx('text-[11px] px-1.5 py-0.5 rounded', external ? 'bg-nms-amber/15 text-nms-amber' : 'bg-nms-accent/15 text-nms-accent')}>
          {external ? 'external' : 'subscriber'}
        </span>
        {!external && p.registered === true && (
          <span className="text-[11px] text-nms-green flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> registered
          </span>
        )}
        {!external && p.registered === false && (
          <span className="text-[11px] text-nms-red flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" aria-hidden="true" /> not registered
          </span>
        )}
        {!external && p.ipsec === true && (
          <span className="text-[11px] text-nms-text-dim flex items-center gap-1" title="UE-side SIP and RTP appear as ESP in the packet capture">
            <ShieldCheck className="w-3 h-3" aria-hidden="true" /> IPsec
          </span>
        )}
        {!external && p.ipsec === false && (
          <span className="text-[11px] text-nms-text-dim flex items-center gap-1" title="UE-side SIP and RTP are captured in the clear">
            <ShieldOff className="w-3 h-3" aria-hidden="true" /> no IPsec
          </span>
        )}
      </div>
      <dl className="text-[11px] text-nms-text-dim space-y-0.5">
        {p.imsi && (
          <div className="flex gap-1.5">
            <dt className="shrink-0">IMSI</dt>
            <dd className="font-mono text-nms-text truncate">{p.imsi}</dd>
          </div>
        )}
        {p.imsIp && (
          <div className="flex gap-1.5">
            <dt className="shrink-0">UE (ims)</dt>
            <dd className="font-mono text-nms-text">{p.imsIp}</dd>
          </div>
        )}
        {p.dataIp && (
          <div className="flex gap-1.5">
            <dt className="shrink-0">excluded</dt>
            <dd className="font-mono">{p.dataIp} (internet APN — no SIP or RTP)</dd>
          </div>
        )}
      </dl>
      {p.note && <p className="text-xs text-nms-text-dim">{p.note}</p>}
    </div>
  );
}

export function CallDebugCard({
  active, onChanged, onOpenSession,
}: {
  active: ActiveCallDebugSession | null;
  onChanged: () => void;
  onOpenSession: (id: string) => void;
}): JSX.Element {
  const [caller, setCaller] = useState('');
  const [callee, setCallee] = useState('');
  const [scope, setScope] = useState<DialogScope>('calls');
  const [autostopSeconds, setAutostopSeconds] = useState(600);
  const [tagOnly, setTagOnly] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [preview, setPreview] = useState<{ parties: ResolvedParty[]; readiness: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<CallDebugSession[]>([]);
  const [pcapSize, setPcapSize] = useState<number | undefined>();

  const loadSessions = useCallback(async () => {
    try {
      const r = await sipTraceApi.listCallDebugSessions(25);
      setSessions(r.sessions);
    } catch { /* the card still works without history */ }
  }, []);

  useEffect(() => { void loadSessions(); }, [loadSessions, active?.id, active?.status]);

  // The pcap's own size, read from the capture list while a session runs. The
  // session's status is deliberately not the authority for the capture: it can
  // be stopped independently from the Captures tab.
  useEffect(() => {
    if (!active?.pcapId) { setPcapSize(undefined); return; }
    let alive = true;
    const read = () => pcapApi.listCaptures()
      .then(l => { if (alive) setPcapSize(l.find(c => c.id === active.pcapId)?.sizeBytes); })
      .catch(() => {});
    read();
    const t = setInterval(read, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [active?.pcapId]);

  const check = async () => {
    if (!caller.trim() && !callee.trim()) { toast.error('Enter at least one number'); return; }
    setChecking(true);
    try {
      setPreview(await sipTraceApi.resolveParties(caller, callee));
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally { setChecking(false); }
  };

  const start = async () => {
    setBusy(true);
    try {
      const s = await sipTraceApi.startCallDebug({
        caller, callee, dialogScope: scope, tagOnly, autostopSeconds,
      });
      toast.success(`Capture scoped to ${s.parties.map(p => p.input).join(' ↔ ')}`);
      setPreview(null);
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message, { duration: 9000 });
    } finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const s = await sipTraceApi.stopCallDebug();
      toast.success(`Session stopped — ${s.counters.matched} messages captured`);
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    try {
      await sipTraceApi.deleteCallDebugSession(id);
      await loadSessions();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    }
  };

  const live = active?.liveCounters;

  return (
    <div className="space-y-6">
      {/* ── Running session ── */}
      {active ? (
        <div className="nms-card space-y-4">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-nms-accent flex items-center gap-2">
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-nms-green opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-nms-green" />
                </span>
                Capturing {active.parties.map(p => p.input).join(' ↔ ')}
              </h2>
              <p className="text-xs text-nms-text-dim mt-1">
                Running {elapsed(active.startedAt)} · {SCOPE_LABEL[active.dialogScope]}
                {active.autostopSeconds ? ` · stops automatically after ${Math.round(active.autostopSeconds / 60)} min` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => onOpenSession(active.id)} className="nms-btn-ghost text-xs px-2.5 py-1.5">
                View dialogs
              </button>
              <button
                onClick={() => void stop()}
                disabled={busy}
                className="nms-btn-danger text-xs flex items-center gap-1.5 px-2.5 py-1.5"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Square className="w-3 h-3" aria-hidden="true" />}
                Stop capture
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { k: 'Captured', v: String(live?.matched ?? active.counters.matched), tone: 'good' as const },
              { k: 'Filtered out', v: String(live?.filtered ?? active.counters.filtered) },
              { k: 'Keepalives dropped', v: String(live?.keepalives ?? active.counters.keepalives) },
              { k: 'Packet capture', v: active.pcapStatus === 'running' ? fmtBytes(pcapSize) : (active.pcapStatus ?? 'none'),
                tone: active.pcapStatus && active.pcapStatus !== 'running' ? ('bad' as const) : undefined },
            ].map(s => (
              <div key={s.k} className="rounded-lg border border-nms-border bg-nms-surface-2/40 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wider text-nms-text-dim">{s.k}</div>
                <div className={clsx('text-xs font-mono mt-0.5',
                  s.tone === 'bad' ? 'text-nms-red' : s.tone === 'good' ? 'text-nms-green' : 'text-nms-text')}>
                  {s.v}
                </div>
              </div>
            ))}
          </div>

          {live?.matched === 0 && (
            <div className="rounded-lg border border-nms-amber/40 bg-nms-amber/10 p-3">
              <p className="text-xs text-nms-text">
                Nothing matched yet. If you have already placed the call, the numbers may not be what appears in
                SIP — press <span className="font-medium">Check numbers</span> below against the dialled digits.
                {(live?.filtered ?? 0) > 0 && ` ${live?.filtered} message(s) were seen and scoped out.`}
              </p>
            </div>
          )}

          {active.readiness.length > 0 && (
            <ul className="space-y-1">
              {active.readiness.map((r, i) => (
                <li key={i} className="text-xs text-nms-text-dim">{r}</li>
              ))}
            </ul>
          )}

          <p className="text-xs text-nms-text-dim">
            While this session runs, SIP traffic for other parties is <span className="font-medium">not stored</span> —
            that is what keeps the capture small. The packet capture is scoped to these UEs plus the IMS and media
            plane; a packet filter cannot match a phone number, so another call in progress may also appear in it.
          </p>
        </div>
      ) : (
        /* ── New session ── */
        <div className="nms-card space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-nms-accent flex items-center gap-2">
              <Users className="w-4 h-4" aria-hidden="true" /> New call debug session
            </h2>
            <p className="text-xs text-nms-text-dim mt-1">
              Scope both the SIP trace and a full packet capture to one call between two numbers, so neither fills up
              with unrelated traffic.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="cd-caller" className="block text-xs text-nms-text-dim mb-1">Caller</label>
              <input
                id="cd-caller"
                className="nms-input font-mono"
                placeholder="15550000001"
                value={caller}
                onChange={e => { setCaller(e.target.value); setPreview(null); }}
              />
            </div>
            <div>
              <label htmlFor="cd-callee" className="block text-xs text-nms-text-dim mb-1">Callee</label>
              <input
                id="cd-callee"
                className="nms-input font-mono"
                placeholder="6034771783"
                value={callee}
                onChange={e => { setCallee(e.target.value); setPreview(null); }}
              />
            </div>
          </div>

          <p className="text-xs text-nms-text-dim">
            Either number may be written with or without a country code — the same number dialled as
            <span className="font-mono"> 6034771783</span> or <span className="font-mono">16034771783</span> is treated
            as one party. Short codes are matched exactly. A subscriber’s registration identity is resolved and matched
            too, since handsets register under their IMSI but dial under their MSISDN.
          </p>

          {/* Options */}
          <div>
            <button
              onClick={() => setShowOptions(o => !o)}
              aria-expanded={showOptions}
              className="text-xs text-nms-text-dim hover:text-nms-text flex items-center gap-1"
            >
              {showOptions ? <ChevronDown className="w-3 h-3" aria-hidden="true" /> : <ChevronRight className="w-3 h-3" aria-hidden="true" />}
              Options
            </button>
            {showOptions && (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="cd-scope" className="block text-xs text-nms-text-dim mb-1">What to keep</label>
                  <select
                    id="cd-scope"
                    className="nms-input"
                    value={scope}
                    onChange={e => setScope(e.target.value as DialogScope)}
                  >
                    {(Object.keys(SCOPE_LABEL) as DialogScope[]).map(k => (
                      <option key={k} value={k}>{SCOPE_LABEL[k]}</option>
                    ))}
                  </select>
                  <p className="text-xs text-nms-text-dim mt-1">{SCOPE_HELP[scope]}</p>
                </div>
                <div>
                  <label htmlFor="cd-autostop" className="block text-xs text-nms-text-dim mb-1">Stop automatically after</label>
                  <select
                    id="cd-autostop"
                    className="nms-input"
                    value={autostopSeconds}
                    onChange={e => setAutostopSeconds(Number(e.target.value))}
                  >
                    {DURATIONS.map(d => <option key={d.s} value={d.s}>{d.label}</option>)}
                  </select>
                  <p className="text-xs text-nms-text-dim mt-1">
                    The packet capture records full traffic, so a session left running is bounded rather than left to
                    fill the disk. It also stops at 512 MB.
                  </p>
                </div>
                <div className="md:col-span-2">
                  <label className="flex items-start gap-2 text-xs text-nms-text">
                    <input
                      type="checkbox"
                      className="nms-checkbox mt-0.5"
                      checked={tagOnly}
                      onChange={e => setTagOnly(e.target.checked)}
                    />
                    <span>
                      Keep storing other SIP traffic as well
                      <span className="block text-xs text-nms-text-dim">
                        Tags this session’s messages without dropping anyone else’s. Leaves the Live Trace view
                        populated, at the cost of the storage saving.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Preview */}
          {preview && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {preview.parties.map(p => <PartyChip key={p.input} p={p} />)}
              </div>
              {preview.readiness.length > 0 && (
                <ul className="space-y-1">
                  {preview.readiness.map((r, i) => (
                    <li key={i} className="text-xs text-nms-text-dim">{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => void check()}
              disabled={checking}
              className="nms-btn-ghost text-xs flex items-center gap-1.5 px-3 py-2"
            >
              {checking ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : null}
              Check numbers
            </button>
            <button
              onClick={() => void start()}
              disabled={busy || (!caller.trim() && !callee.trim())}
              className="nms-btn-primary text-xs flex items-center gap-1.5 px-3 py-2"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Play className="w-3 h-3" aria-hidden="true" />}
              Start capture
            </button>
            <span className="text-xs text-nms-text-dim">
              Starting also switches SIP tracing on, and switches it back off afterwards if it was off.
            </span>
          </div>
        </div>
      )}

      {/* ── History ── */}
      {sessions.length > 0 && (
        <div className="nms-card space-y-3">
          <h2 className="text-sm font-semibold text-nms-accent">Previous sessions</h2>
          <div className="nms-table-wrap">
            <div className="nms-table-scroll">
              <table className="w-full text-xs">
                <thead className="bg-nms-surface-2 text-nms-text-dim">
                  <tr>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Started</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Parties</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Status</th>
                    <th scope="col" className="text-right px-3 py-1.5 font-medium">Messages</th>
                    <th scope="col" className="text-left px-3 py-1.5 font-medium">Duration</th>
                    <th scope="col" className="text-right px-3 py-1.5 font-medium">Capture</th>
                    <th scope="col" className="text-right px-3 py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(s => (
                    <tr
                      key={s.id}
                      tabIndex={0}
                      onClick={() => onOpenSession(s.id)}
                      onKeyDown={activateOnKey(() => onOpenSession(s.id))}
                      className="border-t border-nms-border cursor-pointer hover:bg-nms-surface-2/50 transition-colors"
                    >
                      <td className="px-3 py-1.5 font-mono text-nms-text-dim whitespace-nowrap">
                        {new Date(s.startedAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-nms-text">
                        {s.parties.map(p => p.input).join(' ↔ ')}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={clsx(
                          s.status === 'stopped' ? 'text-nms-green'
                            : s.status === 'running' ? 'text-nms-accent'
                            : s.status === 'interrupted' ? 'text-nms-amber' : 'text-nms-red',
                        )}>
                          {s.status}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-nms-text">{s.counters?.matched ?? 0}</td>
                      <td className="px-3 py-1.5 font-mono text-nms-text-dim">{elapsed(s.startedAt, s.stoppedAt)}</td>
                      <td className="px-3 py-1.5 text-right">
                        {s.pcapId ? (
                          <a
                            href={pcapApi.downloadUrl(s.pcapId)}
                            onClick={e => e.stopPropagation()}
                            className="text-nms-accent hover:underline inline-flex items-center gap-1"
                            aria-label={`Download packet capture for ${s.parties.map(p => p.input).join(' to ')}`}
                          >
                            <Download className="w-3 h-3" aria-hidden="true" /> pcap
                          </a>
                        ) : <span className="text-nms-text-dim">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {s.status !== 'running' && (
                          <button
                            onClick={e => { e.stopPropagation(); void remove(s.id); }}
                            aria-label={`Delete session for ${s.parties.map(p => p.input).join(' to ')}`}
                            className="text-nms-text-dim hover:text-nms-red transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-nms-text-dim">
            A session keeps its own copy of the messages it captured, because the live trace store expires on its
            retention window while these rows and their packet captures do not.
          </p>
        </div>
      )}
    </div>
  );
}
