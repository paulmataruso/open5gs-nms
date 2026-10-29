import { useState } from 'react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { AlertTriangle, Antenna, Loader2, Play, Square } from 'lucide-react';
import { SipTraceSource, SipTraceStatus, sipTraceApi } from '../../api/sipTrace';

// Extracted from SipTraceTab.tsx unchanged. It owns the GLOBAL tracing switch
// and the collector's own health counters -- a separate concern from reading a
// captured call, and separate again from scoping a Call Debug session, which
// is why the three now live in three files.

const SOURCE_LABEL: Record<SipTraceSource, string> = {
  pcscf: 'P-CSCF', icscf: 'I-CSCF', scscf: 'S-CSCF', unknown: 'Unknown',
};

// ── Status + control ─────────────────────────────────────────────────────────
export function TraceStatusCard({
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
  const [savingSettings, setSavingSettings] = useState(false);

  // Retention is sent back unchanged alongside it: the settings endpoint takes
  // the whole object, and omitting the hours would reset retention to its
  // default as a side effect of toggling keepalives.
  const saveKeepalives = async (on: boolean) => {
    setSavingSettings(true);
    try {
      await sipTraceApi.setRetention(status?.settings.retentionHours ?? 24, on);
      toast.success(on ? 'Keepalives will be stored' : 'Keepalives suppressed');
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setSavingSettings(false);
    }
  };

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
        <div className="rounded-lg border border-nms-border bg-nms-surface-2/40 px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
          <label htmlFor="trace-keepalives" className="flex items-start gap-2 text-xs text-nms-text min-w-0">
            <input
              id="trace-keepalives"
              type="checkbox"
              className="nms-checkbox mt-0.5"
              checked={status?.settings.storeKeepalives === true}
              disabled={savingSettings}
              onChange={e => void saveKeepalives(e.target.checked)}
            />
            <span>
              Store OPTIONS keepalives
              <span className="block text-xs text-nms-text-dim">
                Off by default. The dispatcher and NAT-keepalive pings are each their own dialog and repeat forever —
                on this deployment they were 68% of everything stored and almost all of the dialog list. Turn this on
                only when a keepalive itself is what you are investigating.
              </span>
            </span>
          </label>
          <span className="text-xs text-nms-text-dim font-mono shrink-0">retention {status?.settings.retentionHours ?? '—'}h</span>
        </div>
      )}

      {c && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { k: 'Collector', v: c.running ? `listening on ${c.bind}` : 'not running', tone: c.running ? 'ok' : 'bad' },
            { k: 'Messages stored', v: status?.messages?.toLocaleString() ?? '—' },
            { k: 'Packets received', v: c.packetsReceived.toLocaleString() },
            { k: 'Keepalives dropped', v: c.keepalivesIgnored?.toLocaleString() ?? '—' },
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
