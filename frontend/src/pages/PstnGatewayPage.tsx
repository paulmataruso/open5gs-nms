import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import {
  Phone, CheckCircle, XCircle, AlertCircle, RefreshCw,
  Terminal, RotateCw, Settings, Power, BookOpen, ChevronDown, Plus, Trash2, PhoneCall, FileText, Signal, ArrowRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { pstnApi } from '../api/pstn';
import type { PstnStatus, PstnExtension } from '../api/pstn';
import { asterisk2gApi } from '../api/asterisk-2g';
import type { Asterisk2gStatus, Asterisk2gExtension } from '../api/asterisk-2g';
import { gsmApi } from '../api/gsm';
import type { HlrSubscriberStatus } from '../api/gsm';
import { subscriberApi } from '../api';
import type { SubscriberListItem } from '../types';
import { FEATURES } from '../config/features';

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
        <PhoneCall className="w-4 h-4 text-nms-accent" /> 4G/5G Short Codes
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

// The entire user-facing surface of the Cross-RAN Calling feature — one
// toggle, nothing else. Everything it takes to actually work (the new
// inter-Asterisk PJSIP trunk on both instances, dialplan forwarding blocks
// on both sides for the other side's short codes, transcoding-capable codec
// lists) is generated server-side by setCrossRanCalling() in
// pstn-controller.ts. Only rendered once both instances are installed AND
// configured (see the gating at this component's call site) — a button that
// would just 400 immediately isn't worth showing.
function CrossRanToggleCard({ status, onChanged }: { status: PstnStatus | null; onChanged: () => void }) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collisions, setCollisions] = useState<string[]>([]);
  const enabled = !!status?.crossRanEnabled;

  const handleToggle = async () => {
    setActing(true);
    setError(null);
    setCollisions([]);
    try {
      if (enabled) {
        await pstnApi.disableCrossRan();
        toast.success('Cross-RAN Calling disabled');
      } else {
        await pstnApi.enableCrossRan();
        toast.success('Cross-RAN Calling enabled');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err.message);
      setCollisions(err?.response?.data?.collisions ?? []);
    } finally {
      setActing(false);
      onChanged();
    }
  };

  return (
    <div className="nms-card">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="max-w-xl">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
            <ArrowRight className="w-4 h-4 text-nms-accent" /> Cross-RAN Calling
          </h2>
          <p className="text-xs text-nms-text-dim">
            Lets a 4G/5G short code reach a 2G subscriber's short code, and vice versa — both Asterisk
            instances peer directly and transcode audio automatically. Nothing else to configure.
          </p>
        </div>
        <button
          onClick={handleToggle}
          disabled={acting}
          className={clsx(
            'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition-all shrink-0',
            enabled
              ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
              : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text',
          )}
        >
          <Power className="w-3 h-3" />
          {acting ? '…' : enabled ? 'Cross-RAN Calling Enabled' : 'Enable Cross-RAN Calling'}
        </button>
      </div>
      {error && (
        <div className="mt-3 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
          {collisions.length > 0 && <div className="mt-1 font-mono">{collisions.join(', ')}</div>}
        </div>
      )}
    </div>
  );
}

// Direct analog of ExtensionsCard above, adapted for the 2G trunk — dials by
// MSISDN (osmo-sip-connector's own routing unit) rather than IMSI over the
// scscf_trunk, and only offers subscribers that are actually 2G-auth-enabled
// (gsmApi.listSubscribers() already filters to gsmEnabled && present in
// hlr.db — the exact same filter the GSM page's own subscriber views use).
function Gsm2gExtensionsCard() {
  const [extensions, setExtensions] = useState<Asterisk2gExtension[]>([]);
  const [subscribers, setSubscribers] = useState<(HlrSubscriberStatus & { nickname?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newExtension, setNewExtension] = useState('');
  const [newImsi, setNewImsi] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [extRes, subRes, allSubsRes] = await Promise.all([
        asterisk2gApi.listExtensions(),
        gsmApi.listSubscribers(),
        subscriberApi.list(0, 500),
      ]);
      setExtensions(extRes.extensions);
      // gsmApi.listSubscribers() is the authoritative "is this subscriber
      // actually 2G-enabled and present in hlr.db" source but only carries
      // imsi/msisdn — join in nicknames from the general subscriber list so
      // this dropdown reads the same way ExtensionsCard's own does.
      const nicknameByImsi = new Map(allSubsRes.subscribers.map(s => [s.imsi, s.nickname]));
      setSubscribers(subRes.subscribers.map(s => ({ ...s, nickname: nicknameByImsi.get(s.imsi) })));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newExtension || !newImsi) return;
    setAdding(true);
    try {
      await asterisk2gApi.addExtension(newExtension, newImsi, newLabel || undefined);
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
      await asterisk2gApi.removeExtension(extension);
      toast.success(`${extension} removed`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    }
  };

  return (
    <div className="nms-card">
      <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
        <Signal className="w-4 h-4 text-nms-accent" /> 2G Short Codes
      </h2>
      <p className="text-xs text-nms-text-dim mb-4">
        Assign a short code to a 2G-enabled subscriber so other 2G phones can dial them without the
        full MSISDN — a shortcut through the same osmo-sip-connector re-dial path any 2G call already uses.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <div>
          <label className="nms-label">Short code</label>
          <input value={newExtension} onChange={e => setNewExtension(e.target.value)}
            placeholder="10" className="nms-input font-mono text-xs mt-1" />
          <p className="text-xs text-nms-text-dim mt-1">Any digits, any length — no "+" needed</p>
        </div>
        <div>
          <label className="nms-label">Subscriber</label>
          <select value={newImsi} onChange={e => setNewImsi(e.target.value)} className="nms-input text-xs mt-1">
            <option value="">Select subscriber…</option>
            {subscribers.map(s => (
              <option key={s.imsi} value={s.imsi}>
                {s.nickname ? `${s.nickname} (${s.imsi})` : s.imsi}{s.msisdn ? ` — ${s.msisdn}` : ''}
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
        <p className="text-xs text-nms-text-dim text-center py-6">
          {subscribers.length === 0
            ? 'No 2G-enabled subscribers yet — enable "2G/3G Auth" for a subscriber on the Subscribers page first.'
            : 'No short codes assigned yet.'}
        </p>
      ) : (
        <div className="border border-nms-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-nms-surface-2 text-nms-text-dim">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Short code</th>
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
    </div>
  );
}

export function PstnGatewayPage({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [tab, setTab] = useState<'setup' | 'extensions' | 'configs'>('setup');
  const [status, setStatus] = useState<PstnStatus | null>(null);
  const [a2gStatus, setA2gStatus] = useState<Asterisk2gStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [streamLog, setStreamLog] = useState('');
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallLog, setUninstallLog] = useState('');
  const [asteriskIp, setAsteriskIp] = useState('127.0.1.4');
  const [echoTestNumber, setEchoTestNumber] = useState('500');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const s = await pstnApi.getStatus();
      setStatus(s);
      if (s.currentConfig?.asteriskIp) setAsteriskIp(s.currentConfig.asteriskIp);
      if (s.currentConfig?.echoTestNumber) setEchoTestNumber(s.currentConfig.echoTestNumber);
    } catch (err: any) {
      if (!silent) toast.error(`Status fetch failed: ${err.message}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!FEATURES.asterisk2g) return;
    const loadA2g = () => asterisk2gApi.getStatus().then(setA2gStatus).catch(() => {});
    loadA2g();
    const iv = setInterval(loadA2g, 10_000);
    return () => clearInterval(iv);
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
      await pstnApi.configure(asteriskIp, echoTestNumber);
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

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold font-display">Voice Gateway</h1>
            <span className="text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full text-amber-400 bg-amber-500/10 border border-amber-500/30">Beta</span>
          </div>
          <p className="text-sm text-nms-text-dim mt-1">Asterisk-based PSTN interconnect for the IMS core</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {installed && svcs && (
            <>
              <SvcBadge label="asterisk" active={svcs.asterisk} />
              <SvcBadge label="kamailio-scscf" active={svcs['kamailio-scscf']} />
              <div className="h-5 w-px bg-nms-border" />
            </>
          )}
          {installed && status?.hasSavedConfig && (
            <button
              onClick={handleToggle}
              disabled={acting}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition-all ${
                status?.pstnEnabled
                  ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
                  : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text'
              }`}
            >
              <Power className="w-3 h-3" />
              {acting ? '…' : status?.pstnEnabled ? 'Gateway Enabled' : 'Gateway Disabled'}
            </button>
          )}
          {installed && (
            <>
              <div className="h-5 w-px bg-nms-border" />
              <button onClick={() => handleSvcAction('start')} disabled={acting}
                className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5 text-green-400 border-green-500/20 hover:border-green-500/40">
                <CheckCircle className="w-3 h-3" /> Start
              </button>
              <button onClick={() => handleSvcAction('stop')} disabled={acting}
                className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5 text-red-400 border-red-500/20 hover:border-red-500/40">
                <XCircle className="w-3 h-3" /> Stop
              </button>
              <button onClick={() => handleSvcAction('restart')} disabled={acting}
                className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5 text-amber-400 border-amber-500/20 hover:border-amber-500/40">
                <RotateCw className={`w-3 h-3 ${acting ? 'animate-spin' : ''}`} /> Restart
              </button>
              <button onClick={() => setShowUninstallConfirm(true)} disabled={acting || uninstalling}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50">
                <Trash2 className="w-3 h-3" /> Uninstall
              </button>
              <div className="h-5 w-px bg-nms-border" />
            </>
          )}
          <button onClick={() => load()} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
            <RefreshCw className="w-3 h-3" /> Refresh
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

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {([
            { id: 'setup',      label: 'Setup',        icon: <Settings className="w-4 h-4" /> },
            { id: 'extensions', label: 'Extensions',    icon: <PhoneCall className="w-4 h-4" /> },
            { id: 'configs',    label: 'Config Files',  icon: <FileText className="w-4 h-4" /> },
          ] as const).map(tabDef => (
            <button
              key={tabDef.id}
              onClick={() => setTab(tabDef.id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                tab === tabDef.id
                  ? 'bg-nms-accent text-white shadow-sm'
                  : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
              )}
            >
              {tabDef.icon}
              {tabDef.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'setup' && (
        <>
          <OverviewCard />

          {installed && (
            <p className="text-xs text-nms-text-dim">
              Dispatcher wired: {status?.dispatcherWired ? 'yes' : 'no'} ·{' '}
              AMR codec: {status?.codecAmrLoaded ? 'loaded' : 'not loaded'} ·{' '}
              Extensions: {status?.extensionCount ?? 0}
            </p>
          )}

          {!installed && (
            <div className="nms-card">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-nms-accent" /> Install Asterisk
                  </h2>
                  <p className="text-xs text-nms-text-dim mt-1">
                    Installs <span className="font-mono">asterisk asterisk-modules</span> on the host via apt,
                    disables the deprecated chan_sip module, and verifies AMR-WB codec support. Requires IMS to
                    already be installed — PSTN Gateway is built entirely on top of IMS's Kamailio signaling chain.
                  </p>
                </div>
                <button onClick={handleInstall} disabled={acting || !status?.imsInstalled} className="nms-btn-primary flex items-center gap-2 text-sm shrink-0">
                  <Terminal className="w-4 h-4" /> {acting ? 'Installing…' : 'Install Asterisk'}
                </button>
              </div>
              {!status?.imsInstalled && (
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
                  IMS is not installed yet — install IMS on the IMS page first.
                </p>
              )}
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
                <div>
                  <label className="nms-label">Echo test number</label>
                  <input value={echoTestNumber} onChange={e => setEchoTestNumber(e.target.value)}
                    placeholder="500" className="nms-input font-mono text-xs mt-1" />
                  <p className="text-xs text-nms-text-dim mt-1">Dial this from any IMS phone for a local Answer/Echo/Hangup test — no PSTN extension assignment needed</p>
                </div>
              </div>
              <button onClick={handleConfigure} disabled={acting || !status?.imsConfigured} className="nms-btn-primary flex items-center gap-2 text-sm">
                <Settings className="w-4 h-4" /> {acting ? 'Configuring…' : 'Configure'}
              </button>
            </div>
          )}

          {FEATURES.asterisk2g && (
            <div className="nms-card">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <Signal className="w-4 h-4 text-nms-accent" />
                  <div>
                    <p className="text-sm font-semibold text-nms-text">Other Asterisk instances on this host</p>
                    <p className="text-xs text-nms-text-dim mt-0.5">Asterisk-2G — 2G-to-2G internal voice, fully isolated from this instance</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {a2gStatus && <SvcBadge label="asterisk-2g" active={a2gStatus.serviceActive} />}
                  <button onClick={() => onNavigate?.('gsm')} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                    Manage on the 2G GSM page <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
              {a2gStatus && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-3">
                  <div className="bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-nms-text-dim">Bind</p>
                    <p className="text-sm font-mono text-nms-text mt-0.5 truncate">{a2gStatus.bindIp}:{a2gStatus.bindPort}</p>
                  </div>
                  <div className="bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-nms-text-dim">Echo test number</p>
                    <p className="text-sm font-mono text-nms-text mt-0.5 truncate">{a2gStatus.echoTestNumber}</p>
                  </div>
                  <div className="bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-nms-text-dim">Codec GSM</p>
                    <p className="text-sm font-mono text-nms-text mt-0.5 truncate">{a2gStatus.codecGsmLoaded ? 'loaded' : 'not loaded'}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!installed && !streamLog && (
            <div className="nms-card border-dashed border-nms-border text-center py-10">
              <Phone className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
              <p className="text-sm text-nms-text-dim">Asterisk is not installed on this host.</p>
              <p className="text-xs text-nms-text-dim mt-1">
                Click <strong>Install Asterisk</strong> above to get started.
              </p>
            </div>
          )}
        </>
      )}

      {tab === 'extensions' && (
        <div className="space-y-4">
          {installed ? (
            <ExtensionsCard imsConfigured={!!status?.imsConfigured} />
          ) : (
            <div className="nms-card border-dashed border-nms-border text-center py-10">
              <PhoneCall className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
              <p className="text-sm text-nms-text-dim">Asterisk is not installed yet.</p>
              <p className="text-xs text-nms-text-dim mt-1">
                Install it from the <strong>Setup</strong> tab before assigning 4G/5G short codes.
              </p>
            </div>
          )}

          {FEATURES.asterisk2g && installed && status?.hasSavedConfig && a2gStatus?.installed && a2gStatus?.hasSavedConfig && (
            <CrossRanToggleCard status={status} onChanged={() => load(true)} />
          )}

          {FEATURES.asterisk2g && (
            a2gStatus?.installed ? (
              <Gsm2gExtensionsCard />
            ) : (
              <div className="nms-card border-dashed border-nms-border text-center py-10">
                <Signal className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
                <p className="text-sm text-nms-text-dim">Asterisk-2G is not installed yet.</p>
                <p className="text-xs text-nms-text-dim mt-1">
                  Install it from the 2G GSM page's <strong>2G Voice</strong> tab before assigning 2G short codes.
                </p>
              </div>
            )
          )}
        </div>
      )}

      {tab === 'configs' && <VoiceConfigFilesTab />}
    </div>
  );
}

// Merges both instances' raw config files into one grouped browser — each
// entry is tagged with the API it came from (pstnApi vs asterisk2gApi) so
// Save & Restart routes to the right backend regardless of which group the
// selected file is in. Mirrors gsm-controller.ts's own convention of showing
// a foreign module's files alongside this page's own (its Config Files tab
// already shows sms-controller.ts-owned osmo-stp/osmo-hlr/osmo-msc under a
// "Shared with SMS over SGs" group) — same idea here, just for a second
// Asterisk instance instead of a second Osmocom daemon.
interface VoiceConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean; source: 'pstn' | 'asterisk2g';
}

function VoiceConfigFilesTab() {
  const [files, setFiles] = useState<VoiceConfigFile[]>([]);
  const [selected, setSelected] = useState<VoiceConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    const sources: Promise<VoiceConfigFile[]>[] = [
      pstnApi.getConfigs().then(r => r.files.map(f => ({ ...f, source: 'pstn' as const }))),
    ];
    if (FEATURES.asterisk2g) {
      sources.push(asterisk2gApi.getConfigs().then(r => r.files.map(f => ({ ...f, source: 'asterisk2g' as const }))));
    }
    Promise.all(sources).then(lists => setFiles(lists.flat())).catch(() => {});
  }, []);
  useEffect(() => { load(); setSelected(null); }, [load]);

  const openFile = async (f: VoiceConfigFile) => {
    setSelected(f);
    const api = f.source === 'pstn' ? pstnApi : asterisk2gApi;
    const r = await api.getConfigContent(f.path);
    setContent(r.content);
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const api = selected.source === 'pstn' ? pstnApi : asterisk2gApi;
      await api.saveConfigContent(selected.path, content);
      await api.restartServices(selected.restartServices);
      toast.success(`Saved — restarted ${selected.restartServices.join(', ')}`);
      load();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const groups = [...new Set(files.map(f => f.group))];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="nms-card lg:col-span-1">
        {groups.map(g => (
          <div key={g} className="mb-3">
            <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              {g}
              {g !== '4G/5G Voice Gateway' && <Signal className="w-3 h-3 text-nms-accent" />}
            </h3>
            {files.filter(f => f.group === g).map(f => (
              <button
                key={f.path}
                onClick={() => openFile(f)}
                className={clsx(
                  'w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono mb-1 flex items-center justify-between',
                  selected?.path === f.path ? 'bg-nms-accent/15 text-nms-accent' : 'text-nms-text-dim hover:bg-nms-bg',
                )}
              >
                {f.label}
                {!f.exists && <span className="text-red-400 text-[10px]">missing</span>}
              </button>
            ))}
          </div>
        ))}
        {files.length === 0 && (
          <p className="text-xs text-nms-text-dim py-4 text-center">No config files yet — install and configure first.</p>
        )}
      </div>
      <div className="nms-card lg:col-span-2">
        {selected ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-mono text-nms-text">{selected.path}</span>
              <button className="nms-btn-primary" disabled={saving} onClick={handleSave}>
                {saving ? <RotateCw className="w-4 h-4 animate-spin" /> : null} Save &amp; Restart
              </button>
            </div>
            {selected.source === 'asterisk2g' && (
              <div className="flex items-start gap-2 bg-nms-accent/5 border border-nms-accent/20 rounded-lg p-2.5 text-xs text-nms-text-dim mb-2">
                <Signal className="w-4 h-4 shrink-0 mt-0.5 text-nms-accent" />
                <span>Belongs to the Asterisk-2G instance (2G GSM module) — restarting only affects 2G-to-2G voice, not this page's own PSTN Gateway.</span>
              </div>
            )}
            <div className="border border-nms-border rounded-lg overflow-hidden">
              <Editor
                height="500px"
                language={selected.language}
                theme="vs-dark"
                value={content}
                onChange={v => setContent(v ?? '')}
                options={{ minimap: { enabled: false }, fontSize: 13 }}
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-nms-text-dim py-10 text-center">Select a config file to view/edit.</p>
        )}
      </div>
    </div>
  );
}
