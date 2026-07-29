import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Phone, CheckCircle, XCircle, AlertCircle, RefreshCw,
  Terminal, RotateCw, Settings, Power, BookOpen, ChevronDown, Plus, Trash2, PhoneCall,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { pstnApi } from '../api/pstn';
import type { PstnStatus, PstnExtension } from '../api/pstn';
import { subscriberApi } from '../api';
import type { SubscriberListItem } from '../types';

function LogTerminal({ lines }: { lines: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-48 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-2">
      {lines}
    </pre>
  );
}

function SvcBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border ${
      active ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30'
    }`}>
      {active ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label}
    </div>
  );
}

function OverviewCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="nms-card">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-nms-accent shrink-0" />
          <span className="text-sm font-semibold text-nms-text">How the PSTN Gateway Works</span>
          <span className="text-xs text-nms-text-dim">— architecture overview</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-5 space-y-5 text-sm">
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Overview</h3>
            <p className="text-nms-text-dim leading-relaxed">
              Kamailio's S-CSCF already has BGCF/MGCF-style PSTN breakout routing built in
              (a Kamailio <span className="text-nms-text font-medium">dispatcher</span> group that
              catches any dialed number that looks like a real phone number and isn't a local
              subscriber). This module wires <span className="text-nms-text font-medium">Asterisk</span>{' '}
              into that dispatcher as the gateway — Asterisk handles the AMR-WB↔G.711 transcoding
              real VoLTE calls need, and either bridges to a real SIP trunk provider (once you have
              one configured) or, for internal testing, looks up the dialed number in the extension
              table below and calls the mapped subscriber directly back through the core.
            </p>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">Signal path (internal extension test)</h3>
            <div className="space-y-2">
              {[
                { step: '1', label: 'Subscriber A dials an extension', detail: 'e.g. 1002 — any length, no "+" needed. S-CSCF checks the real registrar first, and since no subscriber is registered under that exact number, it routes to the PSTN dispatcher instead' },
                { step: '2', label: 'S-CSCF → Asterisk', detail: 'The dispatcher forwards the INVITE to Asterisk over the trunk transport' },
                { step: '3', label: 'Asterisk looks up the extension', detail: 'Finds the subscriber mapped to 1002 in the table below' },
                { step: '4', label: 'Asterisk → I-CSCF', detail: 'Originates a fresh INVITE to the mapped subscriber\'s real identity — the same Cx-LIR + S-CSCF termination flow that delivers every other call' },
                { step: '5', label: 'Subscriber B\'s phone rings', detail: 'Real AMR-WB/EVS media is transcoded through Asterisk on the way — the exact same path a real external caller would take' },
              ].map(({ step, label, detail }) => (
                <div key={step} className="flex items-start gap-3 bg-nms-bg border border-nms-border rounded-xl p-3">
                  <div className="w-7 h-7 rounded-lg bg-nms-accent/10 border border-nms-accent/20 flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-nms-accent">{step}</span>
                  </div>
                  <div>
                    <p className="font-semibold text-nms-text text-xs">{label}</p>
                    <p className="text-xs text-nms-text-dim mt-0.5 leading-relaxed">{detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Important notes</h3>
            <ul className="space-y-1.5 text-xs text-nms-text-dim">
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">No real SIP trunk provider yet:</span> this module only wires the internal extension-to-subscriber path. Connecting to a real provider (Twilio, Telnyx, etc.) for actual outside calls is a separate, not-yet-built step.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Any digits, any length, no "+" needed</span> — S-CSCF routes a dialed number to the PSTN gateway whenever it ISN'T a currently-registered subscriber, not based on the number's format. Pick whatever extension scheme you like (e.g. short 4-digit codes).</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Don't reuse a real subscriber's own number as an extension</span> — if that subscriber ever registers, S-CSCF would find them directly and never reach the dispatcher/Asterisk at all for that number.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Real subscribers only</span> — dialing an extension mapped to a subscriber who isn't currently registered gets a normal "404 Not Found," exactly like calling an offline subscriber directly would.</span></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function ExtensionsCard({ imsConfigured }: { imsConfigured: boolean }) {
  const [extensions, setExtensions] = useState<PstnExtension[]>([]);
  const [subscribers, setSubscribers] = useState<SubscriberListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newExtension, setNewExtension] = useState('');
  const [newImsi, setNewImsi] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [extRes, subRes] = await Promise.all([
        pstnApi.listExtensions(),
        subscriberApi.list(0, 500),
      ]);
      setExtensions(extRes.extensions);
      setSubscribers(subRes.subscribers);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newExtension || !newImsi) return;
    setAdding(true);
    try {
      await pstnApi.addExtension(newExtension, newImsi, newLabel || undefined);
      toast.success(`${newExtension} mapped`);
      setNewExtension(''); setNewImsi(''); setNewLabel('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (extension: string) => {
    try {
      await pstnApi.removeExtension(extension);
      toast.success(`${extension} removed`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    }
  };

  return (
    <div className="nms-card">
      <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
        <PhoneCall className="w-4 h-4 text-nms-accent" /> Extensions
      </h2>
      <p className="text-xs text-nms-text-dim mb-4">
        Assign a PSTN-looking number to a subscriber so other subscribers can dial them through
        Asterisk — a real end-to-end test of the exact signaling path a live SIP trunk would use.
      </p>

      {!imsConfigured ? (
        <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
          Configure IMS before assigning extensions — the dialplan needs the IMS domain.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            <div>
              <label className="nms-label">Extension</label>
              <input value={newExtension} onChange={e => setNewExtension(e.target.value)}
                placeholder="1001" className="nms-input font-mono text-xs mt-1" />
              <p className="text-xs text-nms-text-dim mt-1">Any digits, any length — no "+" needed</p>
            </div>
            <div>
              <label className="nms-label">Subscriber</label>
              <select value={newImsi} onChange={e => setNewImsi(e.target.value)} className="nms-input text-xs mt-1">
                <option value="">Select subscriber…</option>
                {subscribers.map(s => (
                  <option key={s.imsi} value={s.imsi}>
                    {s.nickname ? `${s.nickname} (${s.imsi})` : s.imsi}{s.msisdn?.[0] ? ` — ${s.msisdn[0]}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="nms-label">Label <span className="text-nms-text-dim font-normal">(optional)</span></label>
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
                placeholder="e.g. Test Phone A" className="nms-input text-xs mt-1" />
            </div>
            <div className="flex items-end">
              <button onClick={handleAdd} disabled={adding || !newExtension || !newImsi}
                className="nms-btn-primary flex items-center gap-2 text-sm w-full justify-center">
                <Plus className="w-4 h-4" /> {adding ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6 text-nms-text-dim text-sm">
              <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          ) : extensions.length === 0 ? (
            <p className="text-xs text-nms-text-dim text-center py-6">No extensions assigned yet.</p>
          ) : (
            <div className="border border-nms-border rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-nms-surface-2 text-nms-text-dim">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Extension</th>
                    <th className="text-left px-3 py-2 font-medium">Subscriber</th>
                    <th className="text-left px-3 py-2 font-medium">Label</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {extensions.map(e => (
                    <tr key={e.extension} className="border-t border-nms-border">
                      <td className="px-3 py-2 font-mono text-nms-text">{e.extension}</td>
                      <td className="px-3 py-2 text-nms-text-dim">
                        {e.subscriberNickname ? `${e.subscriberNickname} ` : ''}
                        <span className="font-mono">{e.subscriberImsi}</span>
                        {e.subscriberMsisdn ? ` (${e.subscriberMsisdn})` : ''}
                      </td>
                      <td className="px-3 py-2 text-nms-text-dim">{e.label ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => handleRemove(e.extension)} className="text-red-400 hover:text-red-300">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function PstnGatewayPage() {
  const [status, setStatus] = useState<PstnStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [streamLog, setStreamLog] = useState('');
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallLog, setUninstallLog] = useState('');
  const [asteriskIp, setAsteriskIp] = useState('127.0.1.4');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const s = await pstnApi.getStatus();
      setStatus(s);
      if (s.currentConfig?.asteriskIp) setAsteriskIp(s.currentConfig.asteriskIp);
    } catch (err: any) {
      if (!silent) toast.error(`Status fetch failed: ${err.message}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(() => load(true), 10_000);
    return () => clearInterval(iv);
  }, [load]);

  const handleInstall = async () => {
    setActing(true);
    setStreamLog('');
    try {
      const resp = await pstnApi.install();
      const reader = resp.body?.getReader();
      const dec = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setStreamLog(prev => prev + dec.decode(value));
        }
      }
      await load(true);
    } catch (err: any) {
      toast.error(`Install failed: ${err.message}`);
    } finally {
      setActing(false);
    }
  };

  const handleUninstall = async () => {
    setShowUninstallConfirm(false);
    setUninstalling(true);
    setUninstallLog('');
    try {
      const resp = await pstnApi.uninstall();
      const reader = resp.body?.getReader();
      const dec = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setUninstallLog(prev => prev + dec.decode(value, { stream: true }));
        }
      }
      toast.success('PSTN Gateway removed');
      await load(true);
    } catch (err: any) {
      toast.error(`Uninstall failed: ${err.message}`);
    } finally {
      setUninstalling(false);
    }
  };

  const handleConfigure = async () => {
    setActing(true);
    try {
      await pstnApi.configure(asteriskIp);
      toast.success('Asterisk configured and wired into S-CSCF\'s dispatcher');
      await load(true);
    } catch (err: any) {
      toast.error(`Configure failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  const handleToggle = async () => {
    setActing(true);
    try {
      if (status?.pstnEnabled) {
        await pstnApi.disable();
        toast.success('PSTN Gateway disabled — S-CSCF no longer routes to Asterisk');
      } else {
        await pstnApi.enable();
        toast.success('PSTN Gateway enabled');
      }
      await load(true);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setActing(false);
    }
  };

  const handleSvcAction = async (action: 'start' | 'stop' | 'restart') => {
    setActing(true);
    try {
      await pstnApi[action]();
      toast.success(`Asterisk ${action}ed`);
      await load(true);
    } catch (err: any) {
      toast.error(`${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  if (loading) return (
    <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
      <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading PSTN Gateway status…
    </div>
  );

  const installed = status?.installed ?? false;
  const svcs = status?.services;
  const allUp = svcs?.asterisk && svcs?.['kamailio-scscf'];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold font-display">PSTN Gateway</h1>
            <span className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full text-amber-400 bg-amber-500/10 border border-amber-500/30">Beta</span>
          </div>
          <p className="text-sm text-nms-text-dim mt-1">Asterisk-based PSTN interconnect for the IMS core</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {installed && status?.hasSavedConfig && (
            <button
              onClick={handleToggle}
              disabled={acting}
              className={`flex items-center gap-2 text-sm px-4 py-2 rounded-lg border transition-all ${
                status?.pstnEnabled
                  ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
                  : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text'
              }`}
            >
              <Power className="w-4 h-4" />
              {acting ? '…' : status?.pstnEnabled ? 'Gateway Enabled' : 'Gateway Disabled'}
            </button>
          )}
          {installed && (
            <>
              <div className="w-px h-6 bg-nms-border" />
              <button onClick={() => handleSvcAction('start')} disabled={acting}
                className="nms-btn-ghost flex items-center gap-2 text-sm text-green-400 border-green-500/20 hover:border-green-500/40">
                <CheckCircle className="w-4 h-4" /> Start
              </button>
              <button onClick={() => handleSvcAction('stop')} disabled={acting}
                className="nms-btn-ghost flex items-center gap-2 text-sm text-red-400 border-red-500/20 hover:border-red-500/40">
                <XCircle className="w-4 h-4" /> Stop
              </button>
              <button onClick={() => handleSvcAction('restart')} disabled={acting}
                className="nms-btn-ghost flex items-center gap-2 text-sm text-amber-400 border-amber-500/20 hover:border-amber-500/40">
                <RotateCw className={`w-4 h-4 ${acting ? 'animate-spin' : ''}`} /> Restart
              </button>
              <button onClick={() => setShowUninstallConfirm(true)} disabled={acting || uninstalling}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50">
                <Trash2 className="w-4 h-4" /> Uninstall
              </button>
              <div className="w-px h-6 bg-nms-border" />
            </>
          )}
          <button onClick={() => load()} className="nms-btn-ghost flex items-center gap-2 text-sm">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200 leading-relaxed">
          <span className="font-semibold text-amber-400">Beta feature.</span>{' '}
          This wires Asterisk into an internal extension-to-subscriber test path only — there is{' '}
          <span className="font-semibold">no public SIP trunk connectivity yet</span>. Real-world
          calls to/from the public phone network (via a provider like Twilio or Telnyx) are not
          supported in this release.
        </p>
      </div>

      {status?.configStale && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-200 leading-relaxed">
              <span className="font-semibold text-blue-400">Configuration out of date.</span>{' '}
              This deployment was last configured by
              {status.configuredWithVersion ? ` v${status.configuredWithVersion}` : ' an older version'},
              but this server is running v{status.appVersion}. Click Configure to redeploy with
              any fixes shipped since then — this briefly restarts Asterisk.
            </p>
          </div>
          <button
            onClick={handleConfigure}
            disabled={acting || !status?.imsConfigured}
            className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border text-blue-300 bg-blue-500/15 border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
          >
            Configure
          </button>
        </div>
      )}

      {showUninstallConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="w-5 h-5 text-red-400 shrink-0" />
              <h2 className="text-base font-semibold text-nms-text">Uninstall PSTN Gateway</h2>
            </div>
            <p className="text-sm text-nms-text-dim mb-3 leading-relaxed">This completely removes the PSTN Gateway:</p>
            <ul className="text-xs text-nms-text-dim space-y-1 mb-4 pl-4 list-disc">
              <li>Remove S-CSCF's dispatcher entry and restart kamailio-scscf</li>
              <li>Stop and disable Asterisk</li>
              <li>Delete all extension→subscriber mappings</li>
              <li>Purge the asterisk/asterisk-modules packages</li>
            </ul>
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-5">
              This does not touch IMS, subscribers, or any other module. Cannot be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowUninstallConfirm(false)} className="flex-1 nms-btn-ghost text-sm py-2">Cancel</button>
              <button onClick={handleUninstall} className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition-colors">
                <Trash2 className="w-3.5 h-3.5" /> Uninstall
              </button>
            </div>
          </div>
        </div>
      )}

      {(uninstalling || uninstallLog) && (
        <div className="nms-card">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-400" />
              <span className="text-sm font-semibold text-nms-text">Uninstall Log</span>
              {uninstalling && <span className="text-xs text-amber-400 animate-pulse">running…</span>}
            </div>
            {!uninstalling && <button onClick={() => setUninstallLog('')} className="nms-btn-ghost text-xs">Clear</button>}
          </div>
          <LogTerminal lines={uninstallLog} />
        </div>
      )}

      <OverviewCard />

      <div className={`nms-card ${!installed ? 'border-amber-500/30 bg-amber-500/5' : allUp ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            {!installed
              ? <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
              : allUp
                ? <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
                : <XCircle className="w-5 h-5 text-red-400 shrink-0" />
            }
            <div>
              <p className="text-sm font-semibold">
                {!installed ? 'Asterisk not installed' : allUp ? 'All services running' : 'Services partially stopped'}
              </p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                Dispatcher wired: {status?.dispatcherWired ? 'yes' : 'no'} ·{' '}
                AMR codec: {status?.codecAmrLoaded ? 'loaded' : 'not loaded'} ·{' '}
                Extensions: {status?.extensionCount ?? 0}
              </p>
            </div>
          </div>
          {installed && svcs && (
            <div className="flex items-center gap-2 flex-wrap">
              <SvcBadge label="asterisk" active={svcs.asterisk} />
              <SvcBadge label="kamailio-scscf" active={svcs['kamailio-scscf']} />
            </div>
          )}
        </div>
      </div>

      {!installed && (
        <div className="nms-card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <Terminal className="w-4 h-4 text-nms-accent" /> Install Asterisk
              </h2>
              <p className="text-xs text-nms-text-dim mt-1">
                Installs <span className="font-mono">asterisk asterisk-modules</span> on the host via apt,
                disables the deprecated chan_sip module, and verifies AMR-WB codec support.
              </p>
            </div>
            <button onClick={handleInstall} disabled={acting} className="nms-btn-primary flex items-center gap-2 text-sm shrink-0">
              <Terminal className="w-4 h-4" /> {acting ? 'Installing…' : 'Install Asterisk'}
            </button>
          </div>
          {streamLog && <LogTerminal lines={streamLog} />}
        </div>
      )}

      {installed && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
            <Settings className="w-4 h-4 text-nms-accent" /> Configure
          </h2>
          <p className="text-xs text-nms-text-dim mb-4">
            Wires Asterisk into S-CSCF's dispatcher for PSTN-bound calls. Requires IMS to already be configured.
          </p>
          {!status?.imsConfigured && (
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-4">
              IMS is not configured yet — configure IMS first.
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div>
              <label className="nms-label">Asterisk trunk IP</label>
              <input value={asteriskIp} onChange={e => setAsteriskIp(e.target.value)}
                placeholder="127.0.1.4" className="nms-input font-mono text-xs mt-1" />
              <p className="text-xs text-nms-text-dim mt-1">A dedicated loopback alias, following this project's per-component convention</p>
            </div>
          </div>
          <button onClick={handleConfigure} disabled={acting || !status?.imsConfigured} className="nms-btn-primary flex items-center gap-2 text-sm">
            <Settings className="w-4 h-4" /> {acting ? 'Configuring…' : 'Configure'}
          </button>
        </div>
      )}

      {installed && <ExtensionsCard imsConfigured={!!status?.imsConfigured} />}

      {!installed && !streamLog && (
        <div className="nms-card border-dashed border-nms-border text-center py-10">
          <Phone className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
          <p className="text-sm text-nms-text-dim">Asterisk is not installed on this host.</p>
          <p className="text-xs text-nms-text-dim mt-1">
            Click <strong>Install Asterisk</strong> above to get started.
          </p>
        </div>
      )}
    </div>
  );
}
