import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import {
  Phone, CheckCircle, XCircle, AlertCircle, RefreshCw,
  Terminal, RotateCw, Settings, Power, BookOpen, ChevronDown, Plus, Trash2, PhoneCall, PhoneIncoming, PhoneOutgoing, FileText, Signal, ArrowRight,
  Pencil, Check, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { pstnApi } from '../api/pstn';
import { ipPlanApi } from '../api/ip-plan';
import type { PstnStatus, PstnExtension, DidMapping, OutboundCallerId } from '../api/pstn';
import { asterisk2gApi } from '../api/asterisk-2g';
import type { Asterisk2gStatus, Asterisk2gExtension } from '../api/asterisk-2g';
import { gsmApi } from '../api/gsm';
import type { HlrSubscriberStatus } from '../api/gsm';
import { subscriberApi } from '../api';
import type { SubscriberListItem } from '../types';
import { FEATURES } from '../config/features';
import { useEscapeKey } from '../hooks/useKeyboardA11y';

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
          <span className="text-sm font-semibold text-nms-text">How the Voice Gateway Works</span>
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
              catches any dialed number that isn't a currently-registered local subscriber). This
              module wires <span className="text-nms-text font-medium">Asterisk</span> into that
              dispatcher as the gateway — Asterisk handles the AMR-WB/AMR↔G.711 transcoding real
              VoLTE and 2G calls need, and now supports three distinct call paths, all through this
              same Asterisk instance:
            </p>
            <ul className="mt-3 space-y-1.5 text-xs text-nms-text-dim">
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Internal short codes / MSISDN dialing</span> — looks up the dialed number in the extension table below (or a subscriber's own real MSISDN) and calls the mapped subscriber back through the core. Good for proving the signaling path end-to-end without any external dependency.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Cross-RAN Calling</span> — a second, fully isolated Asterisk instance (Asterisk-2G) peers directly with this one, so a 4G/5G short code can reach a 2G subscriber and vice versa, with automatic transcoding between the two RANs' native codecs.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Real external SIP trunk + DID/caller-ID mapping</span> — a genuine off-host trunk to a third-party SIP provider, with two independently-assignable mappings. Inbound: real numbers (DIDs) are mapped to any subscriber on any RAN tech (2G/4G/5G) — the network auto-detects which RAN to route to, no manual selection needed; a subscriber can have several DIDs. Outbound (4G/5G only so far): any dialed number that isn't a known subscriber MSISDN or internal short code is sent to the trunk — a subscriber with an outbound caller ID assigned presents that (some providers only route calls whose caller ID matches a number they recognize), everyone else presents their real MSISDN.</span></li>
            </ul>
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
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">The external trunk mechanism is built and tested, not yet pointed at a live provider on this deployment</span> — the SIP transport, firewall allowlist, DID routing, and outbound classification all work end-to-end against test values. Pointing the trunk at a real provider (bind IP, provider host/CIDR) is a deliberate, separate step from the <strong>External SIP Trunk</strong> card below.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Any digits, any length, no "+" needed</span> — S-CSCF routes a dialed number to the Voice Gateway whenever it ISN'T a currently-registered subscriber, not based on the number's format. Pick whatever extension scheme you like (e.g. short 4-digit codes).</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Don't reuse a real subscriber's own number as an extension or DID</span> — if that subscriber ever registers, S-CSCF would find them directly and never reach the dispatcher/Asterisk at all for that number.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Real subscribers only</span> — dialing an extension mapped to a subscriber who isn't currently registered gets a normal "404 Not Found," exactly like calling an offline subscriber directly would.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Inbound DID and outbound caller ID are independent</span> — mapping a DID to ring a subscriber does not, by itself, change what caller ID they present outbound (confirmed live 2026-09-19 that real operators need both set separately, e.g. several inbound DIDs ringing one subscriber but one specific number presented outbound). Set each one on its own card below; a subscriber with no outbound caller ID assigned still dials out fine, presenting their real MSISDN instead.</span></li>
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
              <input aria-label="Extension" value={newExtension} onChange={e => setNewExtension(e.target.value)}
                placeholder="1001" className="nms-input font-mono text-xs mt-1" />
              <p className="text-xs text-nms-text-dim mt-1">Any digits, any length — no "+" needed</p>
            </div>
            <div>
              <label className="nms-label">Subscriber</label>
              <select aria-label="Subscriber" value={newImsi} onChange={e => setNewImsi(e.target.value)} className="nms-input text-xs mt-1">
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
              <input aria-label="Label (optional)" value={newLabel} onChange={e => setNewLabel(e.target.value)}
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
              <div className="nms-table-scroll"><table className="w-full text-xs">
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
                        <button aria-label="Delete extension" onClick={() => handleRemove(e.extension)} className="text-red-400 hover:text-red-300">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Real external DID <-> subscriber, used both directions (inbound routing,
// outbound caller-ID substitution — see pstn-controller.ts's
// syncSubscriberDidLookupTable()). Direct copy of
// ExtensionsCard's shape (inline form + table, no modal, no confirm-on-
// delete — matches this project's established convention for a 1:1
// mapping CRUD list). The RAN-path column is read-only/informational —
// there's no manual "which path" field to set: routing is auto-derived
// from the target subscriber's own gsmEnabled flag at dialplan-generation
// time (see resolveAutoDialEntries()'s twin in pstn-controller.ts,
// externalInboundDialplanConf(), landing in Phase 4).
function DidMappingsCard({ imsConfigured }: { imsConfigured: boolean }) {
  const [mappings, setMappings] = useState<DidMapping[]>([]);
  const [subscribers, setSubscribers] = useState<SubscriberListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newDid, setNewDid] = useState('');
  const [newImsi, setNewImsi] = useState('');
  const [newLabel, setNewLabel] = useState('');

  // Inline row editor — editingDid tracks which row's key is being edited
  // (not necessarily still its own value, since the DID itself is editable
  // too); edit* holds that row's in-progress field values.
  const [editingDid, setEditingDid] = useState<string | null>(null);
  const [editDid, setEditDid] = useState('');
  const [editImsi, setEditImsi] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [didRes, subRes] = await Promise.all([
        pstnApi.listDidMappings(),
        subscriberApi.list(0, 500),
      ]);
      setMappings(didRes.didMappings);
      setSubscribers(subRes.subscribers);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newDid || !newImsi) return;
    setAdding(true);
    try {
      await pstnApi.addDidMapping(newDid, newImsi, newLabel || undefined);
      toast.success(`${newDid} mapped`);
      setNewDid(''); setNewImsi(''); setNewLabel('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (did: string) => {
    try {
      await pstnApi.removeDidMapping(did);
      toast.success(`${did} removed`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    }
  };

  const startEdit = (m: DidMapping) => {
    setEditingDid(m.did); setEditDid(m.did); setEditImsi(m.subscriberImsi); setEditLabel(m.label ?? '');
  };
  const cancelEdit = () => setEditingDid(null);
  const saveEdit = async () => {
    if (!editingDid || !editDid || !editImsi) return;
    setSavingEdit(true);
    try {
      await pstnApi.updateDidMapping(editingDid, editDid, editImsi, editLabel || undefined);
      toast.success(`${editDid} updated`);
      setEditingDid(null);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="nms-card">
      <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
        <PhoneIncoming className="w-4 h-4 text-nms-accent" /> Inbound DID Mapping
      </h2>
      <p className="text-xs text-nms-text-dim mb-4">
        Map a real external DID (a number on your real SIP trunk) to a subscriber on any RAN
        tech — inbound-only, unrelated to the short codes above. A subscriber can have several
        DIDs mapped to them; to control what caller ID that subscriber presents on outbound
        calls, use Outbound Caller ID below instead — the two are set independently.
      </p>

      {!imsConfigured ? (
        <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
          Configure IMS before assigning DID mappings — the dialplan needs the IMS domain.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            <div>
              <label className="nms-label">DID</label>
              <input aria-label="DID" value={newDid} onChange={e => setNewDid(e.target.value)}
                placeholder="15555551234" className="nms-input font-mono text-xs mt-1" />
              <p className="text-xs text-nms-text-dim mt-1">Any digits, any length — no "+" needed</p>
            </div>
            <div>
              <label className="nms-label">Subscriber</label>
              <select aria-label="Subscriber" value={newImsi} onChange={e => setNewImsi(e.target.value)} className="nms-input text-xs mt-1">
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
              <input aria-label="Label (optional)" value={newLabel} onChange={e => setNewLabel(e.target.value)}
                placeholder="e.g. Main Office Line" className="nms-input text-xs mt-1" />
            </div>
            <div className="flex items-end">
              <button onClick={handleAdd} disabled={adding || !newDid || !newImsi}
                className="nms-btn-primary flex items-center gap-2 text-sm w-full justify-center">
                <Plus className="w-4 h-4" /> {adding ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6 text-nms-text-dim text-sm">
              <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          ) : mappings.length === 0 ? (
            <p className="text-xs text-nms-text-dim text-center py-6">No DID mappings assigned yet.</p>
          ) : (
            <div className="border border-nms-border rounded-lg overflow-hidden">
              <div className="nms-table-scroll"><table className="w-full text-xs">
                <thead className="bg-nms-surface-2 text-nms-text-dim">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">DID</th>
                    <th className="text-left px-3 py-2 font-medium">Subscriber</th>
                    <th className="text-left px-3 py-2 font-medium">Routes via</th>
                    <th className="text-left px-3 py-2 font-medium">Label</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map(m => editingDid === m.did ? (
                    <tr key={m.did} className="border-t border-nms-border bg-nms-accent/5">
                      <td className="px-3 py-1.5">
                        <input aria-label="DID number" autoFocus value={editDid} onChange={e => setEditDid(e.target.value)}
                          className="nms-input font-mono text-xs py-1 px-1.5 h-7 w-28" />
                      </td>
                      <td className="px-3 py-1.5">
                        <select aria-label="Subscriber" value={editImsi} onChange={e => setEditImsi(e.target.value)} className="nms-input text-xs py-1 h-7">
                          {subscribers.map(s => (
                            <option key={s.imsi} value={s.imsi}>
                              {s.nickname ? `${s.nickname} (${s.imsi})` : s.imsi}{s.msisdn?.[0] ? ` — ${s.msisdn[0]}` : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1.5 text-nms-text-dim">—</td>
                      <td className="px-3 py-1.5">
                        <input aria-label="Label" value={editLabel} onChange={e => setEditLabel(e.target.value)}
                          className="nms-input text-xs py-1 px-1.5 h-7 w-full" placeholder="Label" />
                      </td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        <button aria-label="Save changes" onClick={saveEdit} disabled={savingEdit || !editDid || !editImsi} className="text-nms-green hover:text-nms-green/80 disabled:opacity-50 mr-2">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button aria-label="Cancel editing" onClick={cancelEdit} disabled={savingEdit} className="text-nms-text-dim hover:text-nms-text">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={m.did} className="border-t border-nms-border group/row">
                      <td className="px-3 py-2 font-mono text-nms-text">{m.did}</td>
                      <td className="px-3 py-2 text-nms-text-dim">
                        {m.subscriberNickname ? `${m.subscriberNickname} ` : ''}
                        <span className="font-mono">{m.subscriberImsi}</span>
                        {m.subscriberMsisdn ? ` (${m.subscriberMsisdn})` : ''}
                      </td>
                      <td className="px-3 py-2 text-nms-text-dim">{m.subscriberGsmEnabled ? '2G' : 'IMS (4G/5G)'}</td>
                      <td className="px-3 py-2 text-nms-text-dim">{m.label ?? '—'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button aria-label="Edit DID mapping" onClick={() => startEdit(m)} disabled={!!editingDid}
                          className="text-nms-text-dim opacity-0 group-hover/row:opacity-100 hover:text-nms-accent transition-opacity mr-2 disabled:opacity-0">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button aria-label="Delete DID mapping" onClick={() => handleRemove(m.did)} disabled={!!editingDid} className="text-red-400 hover:text-red-300 disabled:opacity-30">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The outbound counterpart to DidMappingsCard above — deliberately a
// separate collection/card, not a column on the same table, since a
// subscriber's inbound DID(s) and outbound caller ID are independent facts
// (see OutboundCallerId's own comment in pstn-controller.ts for the real
// operator need that drove this split). One entry per subscriber — setting
// a new value for a subscriber that already has one replaces it rather than
// adding a second row, so this card's "Add" also serves as "Edit".
function OutboundCallerIdCard({ imsConfigured }: { imsConfigured: boolean }) {
  const [entries, setEntries] = useState<OutboundCallerId[]>([]);
  const [subscribers, setSubscribers] = useState<SubscriberListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newCallerId, setNewCallerId] = useState('');
  const [newImsi, setNewImsi] = useState('');
  const [newLabel, setNewLabel] = useState('');

  // Inline row editor — same shape as DidMappingsCard's own. editingImsi
  // tracks which row's key is being edited (the row's ORIGINAL subscriber,
  // even though editImsi below may change it to someone else).
  const [editingImsi, setEditingImsi] = useState<string | null>(null);
  const [editCallerId, setEditCallerId] = useState('');
  const [editImsi, setEditImsi] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cidRes, subRes] = await Promise.all([
        pstnApi.listOutboundCallerIds(),
        subscriberApi.list(0, 500),
      ]);
      setEntries(cidRes.outboundCallerIds);
      setSubscribers(subRes.subscribers);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newCallerId || !newImsi) return;
    setAdding(true);
    try {
      await pstnApi.setOutboundCallerId(newImsi, newCallerId, newLabel || undefined);
      toast.success(`Outbound caller ID set to ${newCallerId}`);
      setNewCallerId(''); setNewImsi(''); setNewLabel('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (subscriberImsi: string) => {
    try {
      await pstnApi.removeOutboundCallerId(subscriberImsi);
      toast.success('Outbound caller ID removed');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    }
  };

  const startEdit = (e: OutboundCallerId) => {
    setEditingImsi(e.subscriberImsi); setEditCallerId(e.callerId); setEditImsi(e.subscriberImsi); setEditLabel(e.label ?? '');
  };
  const cancelEdit = () => setEditingImsi(null);
  const saveEdit = async () => {
    if (!editingImsi || !editCallerId || !editImsi) return;
    setSavingEdit(true);
    try {
      await pstnApi.updateOutboundCallerId(editingImsi, editImsi, editCallerId, editLabel || undefined);
      toast.success(`Outbound caller ID updated to ${editCallerId}`);
      setEditingImsi(null);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <div className="nms-card">
      <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
        <PhoneOutgoing className="w-4 h-4 text-nms-accent" /> Outbound Caller ID
      </h2>
      <p className="text-xs text-nms-text-dim mb-4">
        Set what caller ID a subscriber presents when calling out through the external trunk —
        independent of any inbound DID(s) mapped above (some providers only route an outbound
        call whose caller ID matches a number they recognize). A subscriber with nothing set
        here still dials out fine, presenting their real MSISDN instead. Currently only takes
        effect for 4G/5G (IMS) subscribers — outbound calling through the external trunk isn't
        built for 2G yet.
      </p>

      {!imsConfigured ? (
        <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
          Configure IMS before setting outbound caller IDs — the dialplan needs the IMS domain.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            <div>
              <label className="nms-label">Caller ID</label>
              <input aria-label="Caller ID" value={newCallerId} onChange={e => setNewCallerId(e.target.value)}
                placeholder="16038022223" className="nms-input font-mono text-xs mt-1" />
              <p className="text-xs text-nms-text-dim mt-1">Any digits, any length — no "+" needed</p>
            </div>
            <div>
              <label className="nms-label">Subscriber</label>
              <select aria-label="Subscriber" value={newImsi} onChange={e => setNewImsi(e.target.value)} className="nms-input text-xs mt-1">
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
              <input aria-label="Label (optional)" value={newLabel} onChange={e => setNewLabel(e.target.value)}
                placeholder="e.g. Main Office Line" className="nms-input text-xs mt-1" />
            </div>
            <div className="flex items-end">
              <button onClick={handleAdd} disabled={adding || !newCallerId || !newImsi}
                className="nms-btn-primary flex items-center gap-2 text-sm w-full justify-center">
                <Plus className="w-4 h-4" /> {adding ? 'Saving…' : 'Set'}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-6 text-nms-text-dim text-sm">
              <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          ) : entries.length === 0 ? (
            <p className="text-xs text-nms-text-dim text-center py-6">No outbound caller IDs assigned yet.</p>
          ) : (
            <div className="border border-nms-border rounded-lg overflow-hidden">
              <div className="nms-table-scroll"><table className="w-full text-xs">
                <thead className="bg-nms-surface-2 text-nms-text-dim">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Caller ID</th>
                    <th className="text-left px-3 py-2 font-medium">Subscriber</th>
                    <th className="text-left px-3 py-2 font-medium">Label</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => editingImsi === e.subscriberImsi ? (
                    <tr key={e.subscriberImsi} className="border-t border-nms-border bg-nms-accent/5">
                      <td className="px-3 py-1.5">
                        <input aria-label="Caller ID" autoFocus value={editCallerId} onChange={ev => setEditCallerId(ev.target.value)}
                          className="nms-input font-mono text-xs py-1 px-1.5 h-7 w-28" />
                      </td>
                      <td className="px-3 py-1.5">
                        <select aria-label="Subscriber" value={editImsi} onChange={ev => setEditImsi(ev.target.value)} className="nms-input text-xs py-1 h-7">
                          {subscribers.map(s => (
                            <option key={s.imsi} value={s.imsi}>
                              {s.nickname ? `${s.nickname} (${s.imsi})` : s.imsi}{s.msisdn?.[0] ? ` — ${s.msisdn[0]}` : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1.5">
                        <input aria-label="Label" value={editLabel} onChange={ev => setEditLabel(ev.target.value)}
                          className="nms-input text-xs py-1 px-1.5 h-7 w-full" placeholder="Label" />
                      </td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        <button aria-label="Save changes" onClick={saveEdit} disabled={savingEdit || !editCallerId || !editImsi} className="text-nms-green hover:text-nms-green/80 disabled:opacity-50 mr-2">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button aria-label="Cancel editing" onClick={cancelEdit} disabled={savingEdit} className="text-nms-text-dim hover:text-nms-text">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={e.subscriberImsi} className="border-t border-nms-border group/row">
                      <td className="px-3 py-2 font-mono text-nms-text">{e.callerId}</td>
                      <td className="px-3 py-2 text-nms-text-dim">
                        {e.subscriberNickname ? `${e.subscriberNickname} ` : ''}
                        <span className="font-mono">{e.subscriberImsi}</span>
                        {e.subscriberMsisdn ? ` (${e.subscriberMsisdn})` : ''}
                      </td>
                      <td className="px-3 py-2 text-nms-text-dim">{e.label ?? '—'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button aria-label="Edit caller ID mapping" onClick={() => startEdit(e)} disabled={!!editingImsi}
                          className="text-nms-text-dim opacity-0 group-hover/row:opacity-100 hover:text-nms-accent transition-opacity mr-2 disabled:opacity-0">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button aria-label="Delete caller ID mapping" onClick={() => handleRemove(e.subscriberImsi)} disabled={!!editingImsi} className="text-red-400 hover:text-red-300 disabled:opacity-30">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
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

// The real external SIP trunk to a third-party Asterisk server with real
// PSTN/DID connectivity — the actual "leave this host" piece the rest of
// this module builds toward. Two-step, deliberately: Configure only saves
// the field values (bindIp/provider host/CIDR etc.), Enable is a separate
// action that actually writes the live PJSIP config and opens the nftables
// allowlist — a real network-facing port deserves an explicit second step,
// unlike the loopback-only Cross-RAN toggle above. Values pre-fill from
// status.currentConfig?.externalTrunk so re-opening this after a save
// doesn't require re-typing everything.
function ExternalTrunkCard({ status, onChanged }: { status: PstnStatus | null; onChanged: () => void }) {
  const existing = status?.currentConfig?.externalTrunk;
  const [bindIp, setBindIp] = useState(existing?.bindIp ?? '');
  const [bindPort, setBindPort] = useState(String(existing?.bindPort ?? 5060));
  const [interfaceMode, setInterfaceMode] = useState<'dummy' | 'existing'>(existing?.interfaceMode ?? 'dummy');
  const [externalMediaAddress, setExternalMediaAddress] = useState(existing?.externalMediaAddress ?? '');
  const [providerHost, setProviderHost] = useState(existing?.providerHost ?? '');
  const [providerPort, setProviderPort] = useState(String(existing?.providerPort ?? 5060));
  const [providerCidr, setProviderCidr] = useState(existing?.providerCidr ?? '');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [frrAcknowledged, setFrrAcknowledged] = useState(false);
  const enabled = !!status?.externalTrunkEnabled;

  // Same shape as SecGW's own needsFrrAck: prompt on first-ever configure,
  // and again any time the bind IP itself changes (a different address may
  // need its own EIGRP network statement even if one was added before).
  const bindIpChanged = !!existing?.bindIp && bindIp !== existing.bindIp;
  const needsFrrAck = !existing || bindIpChanged;

  // Pre-fill from the Auto-Config page's Static IP Plan when never
  // configured here yet — same smart-default pattern as SecGWPage/VoWiFiPage.
  useEffect(() => {
    if (existing?.bindIp) return;
    ipPlanApi.get('pstn-external-trunk').then(ip => { if (ip) setBindIp(ip); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfigure = async () => {
    if (!bindIp || !providerHost) return;
    setSaving(true);
    try {
      await pstnApi.configureExternalTrunk({
        bindIp, bindPort: Number(bindPort) || 5060, interfaceMode,
        externalMediaAddress: externalMediaAddress || undefined,
        providerHost, providerPort: Number(providerPort) || 5060,
        providerCidr: providerCidr || undefined,
      });
      toast.success('External trunk configured');
      setFrrAcknowledged(false);
      onChanged();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    setToggling(true);
    try {
      if (enabled) {
        await pstnApi.disableExternalTrunk();
        toast.success('External trunk disabled');
      } else {
        await pstnApi.enableExternalTrunk();
        toast.success('External trunk enabled');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setToggling(false);
      onChanged();
    }
  };

  return (
    <div className="nms-card">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
        <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
          <Signal className="w-4 h-4 text-nms-accent" /> External SIP Trunk
        </h2>
        <button
          onClick={handleToggle}
          disabled={toggling || !status?.hasSavedConfig || !existing}
          className={clsx(
            'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition-all shrink-0 disabled:opacity-50 disabled:cursor-not-allowed',
            enabled
              ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
              : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text',
          )}
        >
          <Power className="w-3 h-3" />
          {toggling ? '…' : enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>
      <p className="text-xs text-nms-text-dim mb-4">
        A real SIP trunk to a third-party Asterisk server with real DID connectivity. Plain UDP,
        restricted to the provider's IP/CIDR via a dedicated firewall rule — configure the fields
        below, then enable once you're ready to actually open the port.
      </p>

      {needsFrrAck && (
        <div className="nms-card border-amber-500/40 bg-amber-500/5 mb-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-200 leading-relaxed">
              <p className="font-semibold text-amber-400 mb-1">Before configuring: make the bind IP reachable from the provider.</p>
              <p>
                This module never edits <span className="font-mono">frr.conf</span> automatically. If the
                provider sits behind EIGRP-carried routing, add the bind IP yourself, e.g.:
              </p>
              <pre className="bg-nms-bg border border-nms-border rounded px-2 py-1 mt-1.5 font-mono text-[11px] text-amber-100">network {bindIp || '<bind IP>'}/32</pre>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={frrAcknowledged} onChange={e => setFrrAcknowledged(e.target.checked)} />
                I've added the route (or the provider doesn't need one — e.g. same LAN segment)
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div>
          <label className="nms-label">Bind IP</label>
          <input aria-label="Bind IP" value={bindIp} onChange={e => setBindIp(e.target.value)}
            placeholder="10.0.1.50" className="nms-input font-mono text-xs mt-1" />
          <p className="text-xs text-nms-text-dim mt-1">A real, non-loopback interface the provider can reach</p>
        </div>
        <div>
          <label className="nms-label">Bind port</label>
          <input aria-label="Bind port" value={bindPort} onChange={e => setBindPort(e.target.value)}
            placeholder="5060" className="nms-input font-mono text-xs mt-1" />
        </div>
        <div>
          <label className="nms-label">Interface mode</label>
          <select aria-label="Interface mode" value={interfaceMode} onChange={e => setInterfaceMode(e.target.value as 'dummy' | 'existing')} className="nms-input text-xs mt-1">
            <option value="dummy">Create dummy interface</option>
            <option value="existing">Use existing IP</option>
          </select>
          <p className="text-xs text-nms-text-dim mt-1">Dummy mode creates and persists the Bind IP above for you</p>
        </div>
        <div>
          <label className="nms-label">External media address <span className="text-nms-text-dim font-normal">(optional)</span></label>
          <input aria-label="External media address (optional)" value={externalMediaAddress} onChange={e => setExternalMediaAddress(e.target.value)}
            placeholder="defaults to Bind IP" className="nms-input font-mono text-xs mt-1" />
          <p className="text-xs text-nms-text-dim mt-1">Only needed if this host is behind NAT relative to the provider</p>
        </div>
        <div>
          <label className="nms-label">Provider host</label>
          <input aria-label="Provider host" value={providerHost} onChange={e => setProviderHost(e.target.value)}
            placeholder="sip.provider.example.com" className="nms-input font-mono text-xs mt-1" />
        </div>
        <div>
          <label className="nms-label">Provider port</label>
          <input aria-label="Provider port" value={providerPort} onChange={e => setProviderPort(e.target.value)}
            placeholder="5060" className="nms-input font-mono text-xs mt-1" />
        </div>
        <div>
          <label className="nms-label">Provider CIDR <span className="text-nms-text-dim font-normal">(optional)</span></label>
          <input aria-label="Provider CIDR (optional)" value={providerCidr} onChange={e => setProviderCidr(e.target.value)}
            placeholder="defaults to host/32" className="nms-input font-mono text-xs mt-1" />
          <p className="text-xs text-nms-text-dim mt-1">Widen to a real CIDR block if the provider sends from a range</p>
        </div>
      </div>
      <button onClick={handleConfigure} disabled={saving || !bindIp || !providerHost || (needsFrrAck && !frrAcknowledged)} className="nms-btn-primary flex items-center gap-2 text-sm">
        <Settings className="w-4 h-4" /> {saving ? 'Saving…' : 'Configure'}
      </button>
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
          <input aria-label="Short code" value={newExtension} onChange={e => setNewExtension(e.target.value)}
            placeholder="10" className="nms-input font-mono text-xs mt-1" />
          <p className="text-xs text-nms-text-dim mt-1">Any digits, any length — no "+" needed</p>
        </div>
        <div>
          <label className="nms-label">Subscriber</label>
          <select aria-label="Subscriber" value={newImsi} onChange={e => setNewImsi(e.target.value)} className="nms-input text-xs mt-1">
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
          <input aria-label="Label (optional)" value={newLabel} onChange={e => setNewLabel(e.target.value)}
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
          <div className="nms-table-scroll"><table className="w-full text-xs">
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
                    <button aria-label="Delete extension" onClick={() => handleRemove(e.extension)} className="text-red-400 hover:text-red-300">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}

export function PstnGatewayPage({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [tab, setTab] = useState<'setup' | 'extensions' | 'did-mapping' | 'configs'>('setup');
  const [status, setStatus] = useState<PstnStatus | null>(null);
  const [a2gStatus, setA2gStatus] = useState<Asterisk2gStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [streamLog, setStreamLog] = useState('');
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  // Escape dismisses this overlay.
  useEscapeKey(() => setShowUninstallConfirm(false), showUninstallConfirm);
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
      toast.success('Voice Gateway removed');
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
        toast.success('Voice Gateway disabled — S-CSCF no longer routes to Asterisk');
      } else {
        await pstnApi.enable();
        toast.success('Voice Gateway enabled');
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
      <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading Voice Gateway status…
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
          <p className="text-sm text-nms-text-dim mt-1">Asterisk-based voice interconnect — internal cross-RAN calling (2G/4G/5G) plus a real external SIP trunk with DID mapping</p>
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
          Internal short-code/MSISDN dialing and Cross-RAN Calling are stable. The{' '}
          <span className="font-semibold">External SIP Trunk</span> mechanism below is built and
          tested end-to-end (transport, firewall allowlist, DID routing, outbound classification) —
          including a real inbound call into a 2G-routed DID, which now gets an immediate ringback
          so the caller's own server doesn't give up while the radio pages — but hasn't yet been
          pointed at a live real-world SIP provider on this deployment. Configure and enable it
          once you have real provider details on hand.
        </p>
      </div>

      {showUninstallConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="w-5 h-5 text-red-400 shrink-0" />
              <h2 className="text-base font-semibold text-nms-text">Uninstall Voice Gateway</h2>
            </div>
            <p className="text-sm text-nms-text-dim mb-3 leading-relaxed">This completely removes the Voice Gateway:</p>
            <ul className="text-xs text-nms-text-dim space-y-1 mb-4 pl-4 list-disc">
              <li>Remove S-CSCF's dispatcher entry (live reload, no restart)</li>
              <li>Stop and disable Asterisk</li>
              <li>Delete all extension→subscriber mappings and DID mappings</li>
              <li>Remove the external SIP trunk's firewall allowlist, if it was enabled</li>
              <li>Purge the asterisk/asterisk-modules packages (skipped if Asterisk-2G still needs them)</li>
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
            { id: 'setup',       label: 'Setup',        icon: <Settings className="w-4 h-4" /> },
            { id: 'extensions',  label: 'Extensions',    icon: <PhoneCall className="w-4 h-4" /> },
            { id: 'did-mapping', label: 'DID Mapping',   icon: <PhoneOutgoing className="w-4 h-4" /> },
            { id: 'configs',     label: 'Config Files',  icon: <FileText className="w-4 h-4" /> },
          ] as const).map(tabDef => (
            <button
              key={tabDef.id}
              onClick={() => setTab(tabDef.id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                tab === tabDef.id
                  ? 'bg-nms-accent text-nms-accent-fg shadow-sm'
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
                    already be installed — the Voice Gateway is built entirely on top of IMS's Kamailio signaling chain.
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
                Wires Asterisk into S-CSCF's dispatcher and sets up its internal SIP trunk — the base
                step every other capability on this page builds on (short codes, DID mapping,
                Cross-RAN Calling, and the external SIP trunk below). Requires IMS to already be configured.
              </p>
              {!status?.imsConfigured && (
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-4">
                  IMS is not configured yet — configure IMS first.
                </p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                <div>
                  <label className="nms-label">Asterisk trunk IP</label>
                  <input aria-label="Asterisk trunk IP" value={asteriskIp} onChange={e => setAsteriskIp(e.target.value)}
                    placeholder="127.0.1.4" className="nms-input font-mono text-xs mt-1" />
                  <p className="text-xs text-nms-text-dim mt-1">A dedicated loopback alias, following this project's per-component convention</p>
                </div>
                <div>
                  <label className="nms-label">Echo test number</label>
                  <input aria-label="Echo test number" value={echoTestNumber} onChange={e => setEchoTestNumber(e.target.value)}
                    placeholder="500" className="nms-input font-mono text-xs mt-1" />
                  <p className="text-xs text-nms-text-dim mt-1">Dial this from any IMS phone for a local Answer/Echo/Hangup test — no PSTN extension assignment needed</p>
                </div>
              </div>
              <button onClick={handleConfigure} disabled={acting || !status?.imsConfigured} className="nms-btn-primary flex items-center gap-2 text-sm">
                <Settings className="w-4 h-4" /> {acting ? 'Configuring…' : 'Configure'}
              </button>
            </div>
          )}

          {installed && status?.hasSavedConfig && (
            <ExternalTrunkCard status={status} onChanged={() => load(true)} />
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
                    <p className="text-xs uppercase tracking-wider text-nms-text-dim">Bind</p>
                    <p className="text-sm font-mono text-nms-text mt-0.5 truncate">{a2gStatus.bindIp}:{a2gStatus.bindPort}</p>
                  </div>
                  <div className="bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-nms-text-dim">Echo test number</p>
                    <p className="text-sm font-mono text-nms-text mt-0.5 truncate">{a2gStatus.echoTestNumber}</p>
                  </div>
                  <div className="bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
                    <p className="text-xs uppercase tracking-wider text-nms-text-dim">Codec GSM</p>
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
            <>
              <ExtensionsCard imsConfigured={!!status?.imsConfigured} />
            </>
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

      {tab === 'did-mapping' && (
        <div className="space-y-4">
          {installed ? (
            <>
              <DidMappingsCard imsConfigured={!!status?.imsConfigured} />
              <OutboundCallerIdCard imsConfigured={!!status?.imsConfigured} />
            </>
          ) : (
            <div className="nms-card border-dashed border-nms-border text-center py-10">
              <PhoneOutgoing className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
              <p className="text-sm text-nms-text-dim">Asterisk is not installed yet.</p>
              <p className="text-xs text-nms-text-dim mt-1">
                Install it from the <strong>Setup</strong> tab before mapping DIDs or outbound caller IDs.
              </p>
            </div>
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
                <span>Belongs to the Asterisk-2G instance (2G GSM module) — restarting only affects 2G-to-2G voice, not this page's own Voice Gateway.</span>
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
