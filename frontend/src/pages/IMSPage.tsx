import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import {
  CheckCircle, XCircle, RefreshCw,
  RotateCw, Settings, Users, Network, Power, BookOpen, ChevronDown,
  Play, Square, Globe, Shield, Database, Terminal, Trash2, Plus, X,
  AlertTriangle, Pencil,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { imsApi, ImsConfigureInput } from '../api/ims';
import type { ImsStatus, ValidationCheck, ImsConfigFile } from '../api/ims';

// ── Shared sub-components ─────────────────────────────────────────────────────

function LogTerminal({ lines }: { lines: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-96 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-2">
      {lines || 'Waiting for output...'}
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

function IpInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <label className="block text-xs text-nms-text-dim mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="nms-input w-full font-mono text-sm"
        spellCheck={false}
      />
      {hint && <p className="text-[10px] text-nms-text-dim mt-1 leading-relaxed">{hint}</p>}
    </div>
  );
}

function PortInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="block text-xs text-nms-text-dim mb-1">{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(parseInt(e.target.value) || 5060)}
        className="nms-input w-full font-mono text-sm"
        min={1}
        max={65535}
      />
    </div>
  );
}

// ── Overview card ─────────────────────────────────────────────────────────────

function OverviewCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="nms-card">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-nms-accent shrink-0" />
          <span className="text-sm font-semibold text-nms-text">How IMS / VoLTE Works</span>
          <span className="text-xs text-nms-text-dim">— architecture overview</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-5 space-y-5 text-sm">
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Overview</h3>
            <p className="text-nms-text-dim leading-relaxed">
              IMS (IP Multimedia Subsystem) is the SIP-based service layer that enables VoLTE (Voice over LTE).
              Instead of falling back to 2G/3G for calls, the UE registers with the IMS core over the LTE data plane
              and places calls as SIP sessions. This module deploys Kamailio as P-CSCF, I-CSCF, and S-CSCF,
              with RTPengine for media anchoring and BIND9 for IMS DNS resolution.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">Component roles</h3>
            <div className="grid grid-cols-1 gap-2">
              {[
                { label: 'P-CSCF (Proxy)',        color: 'text-blue-400',   desc: 'UE-facing SIP proxy. The UE registers with P-CSCF IP. Anchors RTP media via RTPengine. Must be reachable by the UE through the data plane.' },
                { label: 'I-CSCF (Interrogating)', color: 'text-amber-400',  desc: 'Selects the serving S-CSCF from the database. Routes initial REGISTER from P-CSCF to the chosen S-CSCF. Can be on a loopback.' },
                { label: 'S-CSCF (Serving)',       color: 'text-green-400',  desc: 'Handles AKA authentication, stores UE registrations, routes calls to registered contacts. Queries MariaDB for subscriber keys.' },
                { label: 'RTPengine',              color: 'text-purple-400', desc: 'Media relay — transcodes and forwards RTP audio between UEs. Runs alongside P-CSCF, typically on the same IP.' },
                { label: 'BIND9 DNS',              color: 'text-cyan-400',   desc: 'Serves IMS SRV/NAPTR/A records for pcscf/icscf/scscf FQDNs. UEs and SMF look up P-CSCF via DNS.' },
                { label: 'PyHSS',                  color: 'text-orange-400', desc: 'Home Subscriber Server — handles Diameter Cx from S-CSCF, providing IMS-AKA auth vectors (RAND/AUTN) from K/OPc/SQN. Python-based, installs via pip, REST API on port 8080.' },
                { label: 'MariaDB',                color: 'text-red-400',    desc: 'Stores IMS subscriber data (AUC, subscriber, IMS subscriber records) and S-CSCF runtime bindings in ims_scscf.' },
              ].map(({ label, color, desc }) => (
                <div key={label} className="flex items-start gap-3 bg-nms-bg border border-nms-border rounded-xl p-3">
                  <div className="w-2 h-2 rounded-full bg-current mt-2 shrink-0" style={{ color: 'currentcolor' }}>
                    <div className={`w-2 h-2 rounded-full ${color.replace('text-', 'bg-')}`} />
                  </div>
                  <div>
                    <p className={`font-semibold text-xs ${color}`}>{label}</p>
                    <p className="text-xs text-nms-text-dim mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">VoLTE call signal path</h3>
            <div className="space-y-2">
              {[
                { step: '1', label: 'UE attaches to LTE', detail: 'Open5GS MME/AMF assigns LTE bearer. SMF provides IMS APN with P-CSCF address via PCO (Protocol Configuration Options).' },
                { step: '2', label: 'IMS Registration', detail: 'UE sends REGISTER to P-CSCF IP. P-CSCF forwards to I-CSCF (port 4060) → I-CSCF selects S-CSCF via DB → S-CSCF performs IMS-AKA: sends MAR to PyHSS via Diameter Cx → PyHSS returns RAND/AUTN from K/OPc/SQN → S-CSCF challenges UE → 200 OK.' },
                { step: '3', label: 'Outgoing call (INVITE)', detail: 'UE sends INVITE to P-CSCF. P-CSCF anchors RTP via RTPengine, routes to S-CSCF via I-CSCF. S-CSCF looks up callee binding and routes to destination.' },
                { step: '4', label: 'Media (RTP)', detail: 'Audio flows UE ↔ RTPengine ↔ UE. RTPengine handles NAT traversal, SRTP, and codec negotiation.' },
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
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">MSISDN required:</span> Every subscriber must have an MSISDN assigned in Open5GS and synced to MariaDB before they can register with IMS.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">P-CSCF must be reachable by UEs:</span> Assign the P-CSCF IP to an interface reachable from the UPF data plane. For L3 routing setups, create the dummy interface in the L3 Routing page first.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">IMS APN:</span> Open5GS SMF is automatically updated with the IMS DNN and P-CSCF address. UEs must have the IMS APN provisioned in their SIM or device settings.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">DNS bootstrap:</span> The SMF delivers the DNS server IP to UEs via PCO. That DNS server (BIND9) must resolve the IMS domain and serve NAPTR/SRV/A records for P-CSCF discovery.</span></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Configure card ────────────────────────────────────────────────────────────

function ConfigureCard({ status, onDone }: {
  status: ImsStatus;
  onDone: () => void;
}) {
  const cfgSeeded = useRef(false);
  const [cfg, setCfg] = useState<ImsConfigureInput>({
    pcscfIp: '10.0.1.178', pcscfPort: 5060,
    icscfIp: '127.0.1.1',  icscfPort: 4060,
    scscfIp: '127.0.1.2',  scscfPort: 6060,
    rtpEngineIp: '10.0.1.178', rtpPortMin: 20000, rtpPortMax: 40000,
    dnsIp: '10.0.1.178',
    mcc: '', mnc: '',
    additionalPlmns: [],
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (cfgSeeded.current) return;
    if (status.currentConfig) {
      setCfg({ additionalPlmns: [], mcc: '', mnc: '', ...(status.currentConfig as ImsConfigureInput) });
    }
    cfgSeeded.current = true;
  }, [status]);

  const addPlmn    = () => setCfg(c => ({ ...c, additionalPlmns: [...(c.additionalPlmns ?? []), { mcc: '', mnc: '' }] }));
  const removePlmn = (i: number) => setCfg(c => ({ ...c, additionalPlmns: (c.additionalPlmns ?? []).filter((_, idx) => idx !== i) }));
  const updatePlmn = (i: number, field: 'mcc' | 'mnc', val: string) =>
    setCfg(c => ({ ...c, additionalPlmns: (c.additionalPlmns ?? []).map((p, idx) => idx === i ? { ...p, [field]: val } : p) }));

  // Derive what domain will be used (blank = auto from mme.yaml)
  const primaryDomain = useMemo(() => {
    if (cfg.mcc && cfg.mnc) return `ims.mnc${cfg.mnc.padStart(3, '0')}.mcc${cfg.mcc}.3gppnetwork.org`;
    return status.imsDomain ?? '(auto from mme.yaml)';
  }, [cfg.mcc, cfg.mnc, status.imsDomain]);

  const handleApply = async () => {
    setSaving(true);
    try {
      await imsApi.configure({
        ...cfg,
        mcc: cfg.mcc || undefined,
        mnc: cfg.mnc || undefined,
        additionalPlmns: (cfg.additionalPlmns ?? []).filter(p => p.mcc && p.mnc),
      });
      toast.success('IMS configured and services started.');
      onDone();
    } catch (err: any) {
      toast.error(err.response?.data?.error ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="nms-card space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <Settings className="w-4 h-4 text-nms-accent" />
        <span className="text-sm font-semibold text-nms-text">Configure IMS</span>
      </div>

      <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
        Interface creation is managed via the L3 Routing page. Enter any IP already assigned to an interface on this host.
      </div>

      <div className="bg-nms-bg border border-nms-border rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider">P-CSCF (Proxy)</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <IpInput label="Bind IP" value={cfg.pcscfIp} onChange={v => setCfg(c => ({ ...c, pcscfIp: v }))}
              hint="Must be reachable by UEs through the data plane (assign to a physical/dummy interface — NOT loopback)" />
          </div>
          <PortInput label="SIP Port" value={cfg.pcscfPort} onChange={v => setCfg(c => ({ ...c, pcscfPort: v }))} />
        </div>
      </div>

      <div className="bg-nms-bg border border-nms-border rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">I-CSCF (Interrogating)</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <IpInput label="Bind IP" value={cfg.icscfIp} onChange={v => setCfg(c => ({ ...c, icscfIp: v }))}
              hint="Internal only — loopback is fine (e.g. 127.0.1.1)" />
          </div>
          <PortInput label="SIP Port" value={cfg.icscfPort} onChange={v => setCfg(c => ({ ...c, icscfPort: v }))} />
        </div>
      </div>

      <div className="bg-nms-bg border border-nms-border rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-green-400 uppercase tracking-wider">S-CSCF (Serving)</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <IpInput label="Bind IP" value={cfg.scscfIp} onChange={v => setCfg(c => ({ ...c, scscfIp: v }))}
              hint="Internal only — loopback is fine (e.g. 127.0.1.2)" />
          </div>
          <PortInput label="SIP Port" value={cfg.scscfPort} onChange={v => setCfg(c => ({ ...c, scscfPort: v }))} />
        </div>
      </div>

      <div className="bg-nms-bg border border-nms-border rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Media / RTPengine</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-1">
            <IpInput label="Bind IP" value={cfg.rtpEngineIp} onChange={v => setCfg(c => ({ ...c, rtpEngineIp: v }))}
              hint="Must be reachable by UEs for media relay — use same IP as P-CSCF" />
          </div>
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">RTP Port Min</label>
            <input type="number" value={cfg.rtpPortMin}
              onChange={e => setCfg(c => ({ ...c, rtpPortMin: parseInt(e.target.value) || 20000 }))}
              className="nms-input w-full font-mono text-sm" min={1024} max={65534} />
          </div>
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">RTP Port Max</label>
            <input type="number" value={cfg.rtpPortMax}
              onChange={e => setCfg(c => ({ ...c, rtpPortMax: parseInt(e.target.value) || 30000 }))}
              className="nms-input w-full font-mono text-sm" min={1025} max={65535} />
          </div>
        </div>
      </div>

      <div className="bg-nms-bg border border-nms-border rounded-xl p-4">
        <p className="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-3">DNS (BIND9)</p>
        <div className="w-1/2">
          <IpInput label="Listen IP" value={cfg.dnsIp} onChange={v => setCfg(c => ({ ...c, dnsIp: v }))}
            hint="Served to UEs via SMF PCO — must be reachable by UEs; use same IP as P-CSCF" />
        </div>
      </div>

      {/* PLMN Configuration */}
      <div className="bg-nms-bg border border-nms-border rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-orange-400 uppercase tracking-wider">PLMN / IMS Domain</p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">Primary MCC <span className="text-nms-text-dim font-normal">(blank = auto)</span></label>
            <input className="nms-input font-mono" placeholder="e.g. 999" maxLength={3}
              value={cfg.mcc ?? ''} onChange={e => setCfg(c => ({ ...c, mcc: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">Primary MNC <span className="text-nms-text-dim font-normal">(blank = auto)</span></label>
            <input className="nms-input font-mono" placeholder="e.g. 70" maxLength={3}
              value={cfg.mnc ?? ''} onChange={e => setCfg(c => ({ ...c, mnc: e.target.value }))} />
          </div>
        </div>
        <p className="text-xs text-nms-text-dim font-mono">
          Domain: <span className="text-nms-text">{primaryDomain}</span>
        </p>

        {/* Additional PLMNs */}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between">
            <p className="text-xs text-nms-text-dim">Additional PLMNs</p>
            <button onClick={addPlmn} className="flex items-center gap-1 text-xs text-nms-accent hover:text-nms-text transition-colors">
              <Plus className="w-3 h-3" /> Add PLMN
            </button>
          </div>
          {(cfg.additionalPlmns ?? []).length === 0 && (
            <p className="text-xs text-nms-text-dim italic">None — Kamailio will only serve the primary domain.</p>
          )}
          {(cfg.additionalPlmns ?? []).map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="nms-input font-mono w-24" placeholder="MCC" maxLength={3}
                value={p.mcc} onChange={e => updatePlmn(i, 'mcc', e.target.value)} />
              <input className="nms-input font-mono w-24" placeholder="MNC" maxLength={3}
                value={p.mnc} onChange={e => updatePlmn(i, 'mnc', e.target.value)} />
              {p.mcc && p.mnc && (
                <span className="text-xs font-mono text-nms-text-dim flex-1">
                  ims.mnc{p.mnc.padStart(3, '0')}.mcc{p.mcc}.3gppnetwork.org
                </span>
              )}
              <button onClick={() => removePlmn(i)} className="text-nms-text-dim hover:text-nms-red transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {(cfg.additionalPlmns ?? []).length > 0 && (
            <p className="text-xs text-nms-text-dim">
              Each additional PLMN gets its own BIND9 zone and Kamailio aliases pointing to the same IMS servers.
            </p>
          )}
        </div>
      </div>

      <button onClick={handleApply} disabled={saving} className="nms-btn w-full">
        {saving ? 'Applying…' : 'Apply Changes & Restart IMS'}
      </button>
    </div>
  );
}

// ── DNS Records card ──────────────────────────────────────────────────────────

function DnsRecordsCard() {
  const [expanded, setExpanded] = useState(false);
  const [records, setRecords] = useState<{ name: string; type: string; value: string }[]>([]);
  const [raw, setRaw] = useState('');
  const [loading, setLoading] = useState(false);

  // Manual zone file editor — edits the primary zone file directly via the same
  // config-file save/restart endpoints the Config Files tab uses, so there's only
  // one code path for "write a file on the host and restart bind9".
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);

  const fetchRecords = async () => {
    setLoading(true);
    try {
      const data = await imsApi.getDnsRecords();
      setRecords(data.records ?? []);
      setRaw(data.raw ?? '');
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const handleToggle = () => {
    if (!expanded) fetchRecords();
    setExpanded(e => !e);
  };

  const openEditor = async () => {
    setEditorLoading(true);
    setEditorOpen(true);
    try {
      const { files } = await imsApi.getConfigs();
      const zoneFile = files.find(f => f.group === 'DNS / BIND9' && f.label.endsWith('.zone'));
      if (!zoneFile) {
        toast.error('No zone file found — run Configure first.');
        setEditorOpen(false);
        return;
      }
      setEditorPath(zoneFile.path);
      const { content } = await imsApi.getConfigContent(zoneFile.path);
      setEditorContent(content);
    } catch (err: any) {
      toast.error(err.response?.data?.error ?? String(err));
      setEditorOpen(false);
    } finally {
      setEditorLoading(false);
    }
  };

  const saveEditor = async () => {
    if (!editorPath) return;
    setEditorSaving(true);
    try {
      await imsApi.saveConfigContent(editorPath, editorContent);
      await imsApi.restartServices(['bind9']);
      toast.success('Zone file saved — BIND9 reloaded');
      setEditorOpen(false);
      await fetchRecords();
    } catch (err: any) {
      toast.error(err.response?.data?.error ?? String(err));
    } finally {
      setEditorSaving(false);
    }
  };

  return (
    <div className="nms-card">
      <div className="flex items-center justify-between gap-3">
        <button onClick={handleToggle} className="flex-1 flex items-center justify-between gap-3 text-left">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-nms-accent shrink-0" />
            <span className="text-sm font-semibold text-nms-text">DNS Zone Records</span>
          </div>
          <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', expanded && 'rotate-180')} />
        </button>
        <button
          onClick={openEditor}
          className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5 shrink-0"
          title="Edit zone file by hand"
        >
          <Pencil className="w-3.5 h-3.5" /> Edit
        </button>
      </div>
      {expanded && (
        <div className="mt-4">
          {loading ? (
            <p className="text-xs text-nms-text-dim">Loading…</p>
          ) : records.length === 0 ? (
            <p className="text-xs text-nms-text-dim">No zone file found. Run Configure first.</p>
          ) : (
            <pre className="bg-nms-bg border border-nms-border rounded-lg p-3 text-xs font-mono text-nms-text overflow-x-auto whitespace-pre-wrap max-h-64">
              {raw}
            </pre>
          )}
        </div>
      )}

      {editorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border shrink-0">
              <h2 className="text-lg font-semibold font-display text-nms-text flex items-center gap-2">
                <Pencil className="w-4 h-4 text-nms-accent" /> Edit Zone File
              </h2>
              <button onClick={() => setEditorOpen(false)} className="text-nms-text-dim hover:text-nms-text transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-4 overflow-y-auto flex-1 space-y-3">
              {editorPath && <p className="font-mono text-xs text-nms-text-dim">{editorPath}</p>}
              <div className="flex items-start gap-2 text-xs text-amber-300 p-2 rounded border border-amber-500/30 bg-amber-500/5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Manual edits here are overwritten if you run <strong>Configure</strong> / "Apply Changes &amp; Restart IMS" again — that regenerates this file from the form above.</span>
              </div>
              {editorLoading ? (
                <p className="text-xs text-nms-text-dim">Loading…</p>
              ) : (
                <textarea
                  value={editorContent}
                  onChange={e => setEditorContent(e.target.value)}
                  spellCheck={false}
                  className="w-full h-96 bg-nms-bg border border-nms-border rounded-lg p-3 text-xs font-mono text-nms-text resize-y focus:outline-none focus:ring-1 focus:ring-nms-accent"
                />
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-nms-border shrink-0">
              <button onClick={() => setEditorOpen(false)} className="nms-btn-ghost text-sm">Cancel</button>
              <button onClick={saveEditor} disabled={editorSaving || editorLoading} className="nms-btn-primary text-sm">
                {editorSaving ? 'Saving…' : 'Save & Reload BIND9'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Validation card ───────────────────────────────────────────────────────────

function ValidationCard() {
  const [running, setRunning] = useState(false);
  const [checks, setChecks] = useState<ValidationCheck[] | null>(null);
  const [allPass, setAllPass] = useState<boolean | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const data = await imsApi.validate();
      setChecks(data.checks ?? []);
      setAllPass(data.allPass ?? false);
    } catch (err: any) {
      toast.error(err.response?.data?.error ?? String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="nms-card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-nms-accent" />
          <span className="text-sm font-semibold text-nms-text">Validation</span>
          {allPass !== null && (
            <span className={`text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full border ${
              allPass ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30'
            }`}>
              {allPass ? 'All Pass' : 'Issues Found'}
            </span>
          )}
        </div>
        <button onClick={run} disabled={running} className="nms-btn-ghost text-xs flex items-center gap-1.5">
          {running ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
          {running ? 'Running…' : 'Run Validation'}
        </button>
      </div>

      {checks && (
        <div className="space-y-2">
          {checks.map((check, i) => (
            <div key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${
              check.pass ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'
            }`}>
              {check.pass
                ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                : <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              }
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-nms-text">{check.name}</p>
                <p className="text-xs text-nms-text-dim font-mono mt-0.5">{check.detail}</p>
                {!check.pass && check.remediation && (
                  <p className="text-xs text-amber-400 mt-1">{check.remediation}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!checks && (
        <p className="text-xs text-nms-text-dim">Click "Run Validation" to check DNS, MariaDB, Kamailio, RTPengine, and SMF IMS configuration.</p>
      )}
    </div>
  );
}

// ── Install card ──────────────────────────────────────────────────────────────

function InstallCard({
  onDone, status, installing, setInstalling, setInstallLog,
}: {
  onDone: () => void;
  status: ImsStatus | null;
  installing: boolean;
  setInstalling: (v: boolean) => void;
  setInstallLog: (fn: (prev: string) => string) => void;
}) {
  const handleInstall = async () => {
    setInstalling(true);
    setInstallLog(() => '');
    try {
      const response = await imsApi.install();
      if (!response.body) { setInstalling(false); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        setInstallLog(prev => prev + decoder.decode(value));
      }
    } catch (err) {
      setInstallLog(prev => prev + '\n❌ Install error: ' + String(err));
    } finally {
      setInstalling(false);
      onDone();
    }
  };

  const hssOnly = !!(status?.installed && !status?.pyhssInstalled);
  const installTitle = hssOnly ? 'Install PyHSS' : 'Install IMS Software';
  const installDesc = hssOnly
    ? 'Kamailio is already installed. This will install redis-server + pip dependencies and clone PyHSS from source. Takes about a minute.'
    : 'Installs: kamailio + IMS/MySQL/TLS modules, rtpengine, mariadb-server, bind9, redis-server, python3-pip via apt-get. Then clones PyHSS and installs pip dependencies. Fast — no build step required.';

  return (
    <div className="nms-card">
      <div className="flex items-center gap-2 mb-3">
        <Database className="w-4 h-4 text-nms-accent" />
        <span className="text-sm font-semibold text-nms-text">{installTitle}</span>
      </div>
      <p className="text-xs text-nms-text-dim mb-3">{installDesc}</p>
      <button onClick={handleInstall} disabled={installing} className="nms-btn w-full">
        {installing ? 'Installing…' : installTitle}
      </button>
    </div>
  );
}

// ── Config File Editor Tab ────────────────────────────────────────────────────

function ConfigEditorTab() {
  const [manifest, setManifest]             = useState<ImsConfigFile[]>([]);
  const [selectedPath, setSelectedPath]     = useState<string | null>(null);
  const [content, setContent]               = useState('');
  const [originalContent, setOriginal]      = useState('');
  const [loading, setLoading]               = useState(false);
  const [saving, setSaving]                 = useState(false);
  const [restarting, setRestarting]         = useState(false);
  const [restartResults, setRestartResults] = useState<string[]>([]);

  const isDirty = content !== originalContent;
  const [manifestLoading, setManifestLoading] = useState(false);

  const loadManifest = useCallback(async () => {
    setManifestLoading(true);
    try {
      const d = await imsApi.getConfigs();
      setManifest(d.files);
    } catch { /* ignore */ }
    finally { setManifestLoading(false); }
  }, []);

  useEffect(() => { loadManifest(); }, [loadManifest]);

  const selectFile = async (filePath: string) => {
    if (isDirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    setSelectedPath(filePath);
    setLoading(true);
    setContent('');
    setOriginal('');
    setRestartResults([]);
    try {
      const { content: c } = await imsApi.getConfigContent(filePath);
      setContent(c);
      setOriginal(c);
    } catch (err: any) {
      toast.error('Failed to load file: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (andRestart = false) => {
    if (!selectedPath) return;
    setSaving(true);
    try {
      await imsApi.saveConfigContent(selectedPath, content);
      setOriginal(content);
      setManifest(m => m.map(f => f.path === selectedPath ? { ...f, exists: true } : f));
      toast.success('Saved.');
      if (andRestart) {
        const svcs = manifest.find(f => f.path === selectedPath)?.restartServices ?? [];
        if (svcs.length > 0) {
          setRestarting(true);
          setRestartResults([]);
          try {
            const r = await imsApi.restartServices(svcs);
            setRestartResults(r.results);
            toast.success(`Restarted: ${svcs.join(', ')}`);
          } catch (err: any) {
            toast.error('Restart failed: ' + String(err));
          } finally {
            setRestarting(false);
          }
        }
      }
    } catch (err: any) {
      toast.error('Save failed: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const groups = manifest.reduce<Record<string, ImsConfigFile[]>>((acc, f) => {
    (acc[f.group] ??= []).push(f);
    return acc;
  }, {});

  const selectedFile = manifest.find(f => f.path === selectedPath);

  return (
    <div
      className="flex border border-nms-border rounded-xl overflow-hidden"
      style={{ height: 'calc(100vh - 220px)', minHeight: '500px' }}
    >
      {/* Left sidebar */}
      <div className="w-52 shrink-0 bg-nms-bg border-r border-nms-border overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-nms-border shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-nms-text-dim">Files</span>
          <button onClick={loadManifest} disabled={manifestLoading} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <RefreshCw className={clsx('w-3 h-3', manifestLoading && 'animate-spin')} />
          </button>
        </div>
        {manifest.length === 0 && !manifestLoading && (
          <p className="px-3 py-4 text-xs text-nms-text-dim">IMS not configured yet.</p>
        )}
        {Object.entries(groups).map(([group, files]) => (
          <div key={group}>
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-nms-text-dim">
              {group}
            </div>
            {files.map(f => (
              <button
                key={f.path}
                onClick={() => selectFile(f.path)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  selectedPath === f.path
                    ? 'bg-nms-accent/10 text-nms-accent'
                    : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
                )}
              >
                <span className={clsx(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  selectedPath === f.path && isDirty ? 'bg-amber-400'
                    : f.exists ? 'bg-green-500'
                    : 'bg-nms-border',
                )} />
                <span className="truncate font-mono">{f.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Editor pane */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#1e1e1e]">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-nms-surface border-b border-nms-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {selectedPath ? (
              <>
                <span className="font-mono text-xs text-nms-text-dim truncate">{selectedPath}</span>
                {isDirty && <span className="text-amber-400 text-xs shrink-0">● unsaved</span>}
                {!selectedFile?.exists && <span className="text-nms-text-dim text-xs shrink-0">(new file)</span>}
              </>
            ) : (
              <span className="text-xs text-nms-text-dim">Select a file from the left panel</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {restartResults.length > 0 && (
              <button onClick={() => setRestartResults([])} className="text-xs text-nms-text-dim hover:text-nms-text">
                Clear
              </button>
            )}
            <button
              onClick={() => handleSave(false)}
              disabled={!selectedPath || saving || !isDirty}
              className="nms-btn-ghost text-xs px-3 py-1.5 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {selectedFile && selectedFile.restartServices.length > 0 && (
              <button
                onClick={() => handleSave(true)}
                disabled={!selectedPath || saving || restarting}
                className="nms-btn text-xs px-3 py-1.5 disabled:opacity-40"
              >
                {saving ? 'Saving…' : restarting ? 'Restarting…' : 'Save & Restart'}
              </button>
            )}
          </div>
        </div>

        {/* Restart results */}
        {restartResults.length > 0 && (
          <div className="px-4 py-2 bg-nms-surface border-b border-nms-border shrink-0">
            {restartResults.map((r, i) => (
              <p key={i} className="font-mono text-xs text-nms-text-dim">{r}</p>
            ))}
          </div>
        )}

        {/* Monaco */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <RefreshCw className="w-5 h-5 text-nms-accent animate-spin" />
          </div>
        ) : !selectedPath ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-nms-text-dim">Select a config file to edit</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              language={selectedFile?.language ?? 'plaintext'}
              theme="vs-dark"
              value={content}
              onChange={v => setContent(v ?? '')}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                wordWrap: 'off',
                scrollBeyondLastLine: false,
                lineNumbers: 'on',
                renderWhitespace: 'selection',
                tabSize: 2,
                automaticLayout: true,
                padding: { top: 8, bottom: 8 },
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function IMSPage() {
  const [status,     setStatus]     = useState<ImsStatus | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [acting,     setActing]     = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: string[]; removed: number } | null>(null);
  const [installLog,        setInstallLog]        = useState('');
  const [installing,        setInstalling]        = useState(false);
  const [removeLog,         setRemoveLog]         = useState('');
  const [removing,          setRemoving]          = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [activeTab,  setActiveTab]  = useState<'overview' | 'configs'>('overview');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const s = await imsApi.getStatus();
      setStatus(s);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async () => {
    if (!status) return;
    setActing(true);
    try {
      if (status.imsEnabled) {
        await imsApi.disable();
        toast.success('IMS disabled.');
      } else {
        await imsApi.enable();
        toast.success('IMS enabled.');
      }
      await load(true);
    } catch (err: any) {
      toast.error(err.response?.data?.error ?? String(err));
    } finally {
      setActing(false);
    }
  };

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setActing(true);
    try {
      await imsApi[action === 'start' ? 'enable' : action === 'stop' ? 'disable' : 'restart']();
      toast.success(`IMS ${action}ed.`);
      await load(true);
    } catch (err: any) {
      toast.error(err.response?.data?.error ?? String(err));
    } finally {
      setActing(false);
    }
  };

  const handleSync = async () => {
    setActing(true);
    try {
      const r = await imsApi.syncSubscribers();
      setSyncResult({ synced: r.synced, failed: r.failed ?? [], removed: r.removed ?? 0 });
      toast.success(`Synced ${r.synced} subscribers.${r.removed ? ` Removed ${r.removed} stale entries.` : ''}`);
      await load(true);
    } catch (err: any) {
      toast.error(err.response?.data?.error ?? String(err));
    } finally {
      setActing(false);
    }
  };

  const handleRemove = async () => {
    setShowRemoveConfirm(false);
    setRemoving(true);
    setRemoveLog('');
    try {
      const response = await imsApi.remove();
      if (!response.body) { setRemoving(false); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        setRemoveLog(prev => prev + decoder.decode(value));
      }
    } catch (err) {
      setRemoveLog(prev => prev + '\n❌ Remove error: ' + String(err));
    } finally {
      setRemoving(false);
      await load(true);
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <RefreshCw className="w-5 h-5 text-nms-accent animate-spin" />
      </div>
    );
  }

  const s = status;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">IMS / VoLTE</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            {s?.imsDomain
              ? <span className="font-mono">{s.imsDomain}</span>
              : 'Kamailio IMS stack — P-CSCF · I-CSCF · S-CSCF · RTPengine · BIND9'}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {s?.installed && (
            <>
              <button
                onClick={handleToggle}
                disabled={acting}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all',
                  s.imsEnabled
                    ? 'text-green-400 bg-green-500/10 border-green-500/30 hover:bg-green-500/20'
                    : 'text-nms-text-dim bg-nms-surface border-nms-border hover:bg-nms-surface-2',
                )}
              >
                <Power className="w-3.5 h-3.5" />
                {s.imsEnabled ? 'IMS Enabled' : 'IMS Disabled'}
              </button>

              <div className="h-5 w-px bg-nms-border" />

              <button onClick={() => handleServiceAction('start')} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <Play className="w-3 h-3" /> Start
              </button>
              <button onClick={() => handleServiceAction('stop')} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <Square className="w-3 h-3" /> Stop
              </button>
              <button onClick={() => handleServiceAction('restart')} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <RotateCw className="w-3 h-3" /> Restart
              </button>

              <div className="h-5 w-px bg-nms-border" />

              {s.pyhssInstalled && (
                <a
                  href={`http://${window.location.hostname}:8080/docs`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5"
                >
                  <Globe className="w-3 h-3" /> PyHSS API
                </a>
              )}

              <button
                onClick={() => setShowRemoveConfirm(true)}
                disabled={acting || removing}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" /> Remove IMS
              </button>

              <div className="h-5 w-px bg-nms-border" />
            </>
          )}

          <button onClick={() => load()} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Alpha warning — IMS is not production-ready */}
      <div className="flex items-start gap-3 p-4 rounded-lg border border-amber-500/40 bg-amber-500/5">
        <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-amber-300">Alpha — not production-ready</p>
          <p className="text-xs text-nms-text-dim mt-0.5">
            The goal is a 100% automated deployment — today, expect to do manual configuration beyond what this
            wizard automates. This module is in early alpha testing. Server-side IMS signaling has been verified
            with a third-party SIP client, but end-to-end VoLTE on real phones is not confirmed working and will
            likely require manual device/carrier-specific IMS provisioning, auth scheme adjustments, etc. Do not
            rely on this for a production voice deployment.
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-nms-border">
        {(['overview', 'configs'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={clsx(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === tab
                ? 'border-nms-accent text-nms-accent'
                : 'border-transparent text-nms-text-dim hover:text-nms-text',
            )}
          >
            {tab === 'overview' ? 'Overview' : 'Config Files'}
          </button>
        ))}
      </div>

      {activeTab === 'overview' ? (
        <>
          {/* Remove confirmation modal */}
          {showRemoveConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
                <div className="flex items-center gap-3 mb-4">
                  <Trash2 className="w-5 h-5 text-red-400 shrink-0" />
                  <h2 className="text-base font-semibold text-nms-text">Remove IMS</h2>
                </div>
                <p className="text-sm text-nms-text-dim mb-3 leading-relaxed">
                  This will completely remove all IMS components:
                </p>
                <ul className="text-xs text-nms-text-dim space-y-1 mb-4 pl-4 list-disc">
                  <li>Stop and uninstall Kamailio, PyHSS + Redis, RTPengine, MariaDB, BIND9</li>
                  <li>Delete all IMS configuration files and databases</li>
                  <li>Remove the IMS APN from all subscriber profiles</li>
                  <li>Remove the IMS DNN from the SMF config</li>
                </ul>
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-5">
                  The L3 IP address will not be changed. This cannot be undone.
                </p>
                <div className="flex gap-3">
                  <button onClick={() => setShowRemoveConfirm(false)} className="flex-1 nms-btn-ghost text-sm py-2">
                    Cancel
                  </button>
                  <button
                    onClick={handleRemove}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove IMS
                  </button>
                </div>
              </div>
            </div>
          )}

          <OverviewCard />

          {/* Service status */}
          {s && (
            <div className="nms-card">
              <div className="flex items-center gap-2 mb-3">
                <Network className="w-4 h-4 text-nms-accent" />
                <span className="text-sm font-semibold text-nms-text">Service Status</span>
                {!s.installed && (
                  <span className="text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full border text-amber-400 bg-amber-500/10 border-amber-500/30">
                    Not Installed
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <SvcBadge label="P-CSCF"     active={s.services.pcscf} />
                <SvcBadge label="I-CSCF"     active={s.services.icscf} />
                <SvcBadge label="S-CSCF"     active={s.services.scscf} />
                <SvcBadge label="SMSC"        active={s.services.smsc} />
                <SvcBadge label="PyHSS-Diam" active={s.services['pyhss-diameter']} />
                <SvcBadge label="PyHSS-HSS"  active={s.services['pyhss-hss']} />
                <SvcBadge label="PyHSS-API"  active={s.services['pyhss-api']} />
                <SvcBadge label="Redis"       active={s.services.redis} />
                <SvcBadge label="RTPengine"  active={s.services.rtpengine} />
                <SvcBadge label="BIND9 DNS"  active={s.services.bind9} />
                <SvcBadge label="MariaDB"    active={s.services.mariadb} />
              </div>
              {!s.pyhssInstalled && (
                <div className="mt-3 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  PyHSS not yet installed — run Install to clone PyHSS and install dependencies.
                </div>
              )}
              <div className="flex gap-4 mt-3 pt-3 border-t border-nms-border text-xs text-nms-text-dim">
                <span className={s.smfImsConfigured ? 'text-green-400' : ''}>
                  {s.smfImsConfigured ? '✓' : '○'} SMF IMS DNN
                </span>
                <span className={s.dnsConfigured ? 'text-green-400' : ''}>
                  {s.dnsConfigured ? '✓' : '○'} DNS zone
                </span>
                <span>{s.imsSubscribers} HSS subscribers</span>
                <span>{s.open5gsSubscribers} Open5GS subscribers with MSISDN</span>
              </div>
            </div>
          )}

          {s && (!s.installed || !s.pyhssInstalled) && (
            <InstallCard
              onDone={() => load(true)}
              status={s}
              installing={installing}
              setInstalling={setInstalling}
              setInstallLog={setInstallLog}
            />
          )}

          {installLog && (
            <div className="nms-card">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-nms-accent" />
                  <span className="text-sm font-semibold text-nms-text">Install Log</span>
                  {installing && <span className="text-xs text-amber-400 animate-pulse">running…</span>}
                </div>
                {!installing && (
                  <button onClick={() => setInstallLog('')} className="nms-btn-ghost text-xs">Clear</button>
                )}
              </div>
              <LogTerminal lines={installLog} />
            </div>
          )}

          {removeLog && (
            <div className="nms-card">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Trash2 className="w-4 h-4 text-red-400" />
                  <span className="text-sm font-semibold text-nms-text">Removal Log</span>
                  {removing && <span className="text-xs text-amber-400 animate-pulse">running…</span>}
                </div>
                {!removing && (
                  <button onClick={() => setRemoveLog('')} className="nms-btn-ghost text-xs">Clear</button>
                )}
              </div>
              <LogTerminal lines={removeLog} />
            </div>
          )}

          {s && s.installed && (
            <ConfigureCard
              status={s}
              onDone={() => load(true)}
            />
          )}

          {s && s.installed && (
            <div className="nms-card">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-nms-accent" />
                  <span className="text-sm font-semibold text-nms-text">Subscriber Sync</span>
                </div>
                <button onClick={handleSync} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5">
                  <RotateCw className={clsx('w-3 h-3', acting && 'animate-spin')} />
                  Sync Now
                </button>
              </div>
              <p className="text-xs text-nms-text-dim mb-2">
                Copies subscriber auth keys (K, OPc, SQN) and IMPU mappings from Open5GS MongoDB into PyHSS via REST API for IMS-AKA authentication via Diameter Cx.
                Only subscribers with an MSISDN assigned are synced.
              </p>
              {syncResult && (
                <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ${
                  syncResult.failed.length === 0 ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                }`}>
                  <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                  Synced {syncResult.synced} subscribers
                  {syncResult.removed > 0 && ` • ${syncResult.removed} stale removed`}
                  {syncResult.failed.length > 0 && ` • ${syncResult.failed.length} failed`}
                </div>
              )}
            </div>
          )}

          {s && s.installed && <DnsRecordsCard />}
          {s && s.installed && <ValidationCard />}
        </>
      ) : (
        <ConfigEditorTab />
      )}
    </div>
  );
}
