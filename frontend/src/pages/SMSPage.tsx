import { useState, useEffect, useRef, useCallback } from 'react';
import {
  MessageSquare, CheckCircle, XCircle, AlertCircle, RefreshCw,
  Terminal, RotateCw, Settings, Users, Network, Power, BookOpen, ChevronDown, Send, Trash2,
  Image, ExternalLink, Link2, Smartphone, Download,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import Editor from '@monaco-editor/react';
import { smsApi, SmsConfigureInput } from '../api/sms';
import type { SmsStatus, SmsConfigFile } from '../api/sms';
import { mmsApi } from '../api/mms';
import type { MmsStatus } from '../api/mms';
import { imsApi } from '../api/ims';
import type { ImsStatus } from '../api/ims';
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
          <span className="text-sm font-semibold text-nms-text">How SMS over SGsAP Works</span>
          <span className="text-xs text-nms-text-dim">— architecture overview</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-5 space-y-5 text-sm">
          <img
            src="/images/osmo-sgsap.png"
            alt="SMS over SGsAP architecture diagram"
            className="w-full rounded-lg border border-nms-border"
          />

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Overview</h3>
            <p className="text-nms-text-dim leading-relaxed">
              SMS over SGsAP allows LTE UEs to exchange text messages without a separate IMS stack.
              The Open5GS MME connects to OsmoMSC over the <span className="text-nms-text font-medium">SGs interface</span> — an SCTP
              association on port 29118 that carries SGsAP messages. When a UE performs a
              <span className="text-nms-text font-medium"> combined EPS/IMSI attach</span>, the MME sends a Location Update Request
              to OsmoMSC, which registers the UE in OsmoHLR. From that point on, the MSC can page
              the UE for incoming SMS and the UE can submit outgoing SMS through the MME.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">Signal path</h3>
            <div className="space-y-2">
              {[
                { step: '1', label: 'UE → MME', detail: 'UE attaches with combined EPS/IMSI attach request (NAS over S1-MME)' },
                { step: '2', label: 'MME → OsmoMSC', detail: 'MME sends SGsAP Location Update Request over SCTP (port 29118)' },
                { step: '3', label: 'OsmoMSC → OsmoSTP', detail: 'MSC routes SCCP/BSSAP messages via the Signalling Transfer Point (M3UA, port 2905)' },
                { step: '4', label: 'OsmoMSC → OsmoHLR', detail: 'MSC looks up subscriber by IMSI and retrieves MSISDN over GSUP (port 4222)' },
                { step: '5', label: 'SMS delivery', detail: 'Outgoing: UE submits RP-DATA to MSC via MME. Incoming: MSC pages UE via MME, then delivers RP-DATA' },
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
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Combined attach required:</span> The UE must register with "Combined EPS/IMSI attach" mode. Most Android devices do this automatically; iPhones may require setting network mode to LTE/3G/2G (auto) and cycling airplane mode.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">MSISDN required:</span> Each subscriber must have an MSISDN assigned in Open5GS and synced to OsmoHLR before they can send or receive SMS.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">SCTP not TCP:</span> The SGs link uses SCTP. Verify with <span className="font-mono bg-nms-surface px-1 rounded">ss -Sanlp | grep 29118</span> on the host — it will not appear in <span className="font-mono bg-nms-surface px-1 rounded">ss -tlnp</span>.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">No IMS needed:</span> SGsAP SMS is entirely circuit-switched domain fallback — no VoLTE, no P-CSCF, no IMS registration required.</span></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── SMS Config File Editor ────────────────────────────────────────────────────
function SmsConfigEditor() {
  const [manifest, setManifest]         = useState<SmsConfigFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent]           = useState('');
  const [originalContent, setOriginal]  = useState('');
  const [loading, setLoading]           = useState(false);
  const [saving, setSaving]             = useState(false);
  const [restarting, setRestarting]     = useState(false);
  const [restartResults, setRestartResults] = useState<string[]>([]);
  const [manifestLoading, setManifestLoading] = useState(false);

  const isDirty = content !== originalContent;

  const loadManifest = useCallback(async () => {
    setManifestLoading(true);
    try { const d = await smsApi.getConfigs(); setManifest(d.files); }
    catch { /* ignore */ }
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
      const { content: c } = await smsApi.getConfigContent(filePath);
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
      await smsApi.saveConfigContent(selectedPath, content);
      setOriginal(content);
      setManifest(m => m.map(f => f.path === selectedPath ? { ...f, exists: true } : f));
      toast.success('Saved.');
      if (andRestart) {
        const svcs = manifest.find(f => f.path === selectedPath)?.restartServices ?? [];
        if (svcs.length > 0) {
          setRestarting(true);
          setRestartResults([]);
          try {
            const r = await smsApi.restartServices(svcs);
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

  const groups = manifest.reduce<Record<string, SmsConfigFile[]>>((acc, f) => {
    (acc[f.group] ??= []).push(f);
    return acc;
  }, {});

  const selectedFile = manifest.find(f => f.path === selectedPath);

  return (
    <div className="flex border border-nms-border rounded-xl overflow-hidden"
      style={{ height: 'calc(100vh - 220px)', minHeight: '500px' }}>
      {/* Sidebar */}
      <div className="w-52 shrink-0 bg-nms-bg border-r border-nms-border overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-nms-border shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-nms-text-dim">Files</span>
          <button onClick={loadManifest} disabled={manifestLoading} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <RefreshCw className={clsx('w-3 h-3', manifestLoading && 'animate-spin')} />
          </button>
        </div>
        {manifest.length === 0 && !manifestLoading && (
          <p className="px-3 py-4 text-xs text-nms-text-dim">SMS not configured yet.</p>
        )}
        {Object.entries(groups).map(([group, files]) => (
          <div key={group}>
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-nms-text-dim">{group}</div>
            {files.map(f => (
              <button key={f.path} onClick={() => selectFile(f.path)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  selectedPath === f.path
                    ? 'bg-nms-accent/10 text-nms-accent'
                    : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
                )}>
                <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0',
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
              <button onClick={() => setRestartResults([])} className="text-xs text-nms-text-dim hover:text-nms-text">Clear</button>
            )}
            <button onClick={() => handleSave(false)} disabled={!selectedPath || saving || !isDirty}
              className="nms-btn-ghost text-xs px-3 py-1.5 disabled:opacity-40">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {selectedFile && selectedFile.restartServices.length > 0 && (
              <button onClick={() => handleSave(true)} disabled={!selectedPath || saving || restarting}
                className="nms-btn text-xs px-3 py-1.5 disabled:opacity-40">
                {saving ? 'Saving…' : restarting ? 'Restarting…' : 'Save & Restart'}
              </button>
            )}
          </div>
        </div>
        {restartResults.length > 0 && (
          <div className="px-4 py-2 bg-nms-surface border-b border-nms-border shrink-0">
            {restartResults.map((r, i) => <p key={i} className="font-mono text-xs text-nms-text-dim">{r}</p>)}
          </div>
        )}
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
              value={content}
              onChange={v => setContent(v ?? '')}
              theme="vs-dark"
              options={{ fontSize: 13, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// VectorCore's own admin API has zero auth of its own (confirmed live) — the
// backend proxies its JSON endpoints read-only at /api/mms/admin/*. Its
// embedded web UI is a full SPA though, and reverse-proxying a third-party
// SPA under an nginx subpath is its own can of worms (asset/router paths
// baked in absolute at build time) — same reasoning this project already
// applies to Grafana/Prometheus (MetricsPage.tsx links directly to
// http://<host>:<port> rather than proxying them), so this does the same:
// direct link to the host's own port, not a proxied path.
const VC_ADMIN_PORT = 8090; // matches mms-controller.ts's API_PORT

function VectorCoreAdminLinks() {
  const links: Array<{ label: string; href: string; desc: string }> = [
    { label: 'Admin Web UI (VectorCore\'s own)', href: `http://${window.location.hostname}:${VC_ADMIN_PORT}/`, desc: 'Full embedded SPA — messages, peers, VASPs, SMPP upstreams, adaptation classes' },
    { label: 'Messages API', href: '/api/mms/admin/api/v1/messages', desc: 'GET /api/v1/messages' },
    { label: 'SMPP Upstreams API', href: '/api/mms/admin/api/v1/smpp/upstreams', desc: 'GET /api/v1/smpp/upstreams' },
    { label: 'Health', href: '/api/mms/admin/healthz', desc: 'GET /healthz' },
    { label: 'Metrics (Prometheus)', href: '/api/mms/admin/metrics', desc: 'GET /metrics' },
  ];
  return (
    <div className="nms-card">
      <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
        <Link2 className="w-4 h-4 text-nms-accent" /> VectorCore MMSC — Direct Links
      </h2>
      <p className="text-xs text-nms-text-dim mb-4">
        VectorCore MMSC has its own real admin UI and JSON API — this page doesn't reimplement them, it links straight out.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {links.map(l => (
          <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
            className="flex items-start justify-between gap-2 px-3 py-2 rounded-lg border border-nms-border bg-nms-bg/50 hover:border-nms-accent/40 transition-colors group">
            <div>
              <p className="text-sm font-medium text-nms-text group-hover:text-nms-accent transition-colors">{l.label}</p>
              <p className="text-xs text-nms-text-dim font-mono mt-0.5">{l.desc}</p>
            </div>
            <ExternalLink className="w-3.5 h-3.5 text-nms-text-dim shrink-0 mt-0.5" />
          </a>
        ))}
      </div>
    </div>
  );
}

// Shared between both tabs, rendered directly under each tab's own header —
// same position on the page either way (matches the Spectrum Access System
// page's layout: header with title+actions first, tabs directly below it).
function ModuleTabBar({ pageTab, setPageTab }: { pageTab: 'sms' | 'mms'; setPageTab: (t: 'sms' | 'mms') => void }) {
  return (
    <div className="flex border-b border-nms-border">
      {([
        { id: 'sms' as const, label: 'SMS (SGs)', Icon: MessageSquare },
        { id: 'mms' as const, label: 'MMS',        Icon: Image },
      ]).map(({ id, label, Icon }) => (
        <button key={id} onClick={() => setPageTab(id)}
          className={clsx('flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            pageTab === id
              ? 'border-nms-accent text-nms-accent'
              : 'border-transparent text-nms-text-dim hover:text-nms-text'
          )}>
          <Icon className="w-4 h-4" /> {label}
        </button>
      ))}
    </div>
  );
}

function MmsTab({ pageTab, setPageTab }: { pageTab: 'sms' | 'mms'; setPageTab: (t: 'sms' | 'mms') => void }) {
  const [status,     setStatus]     = useState<MmsStatus | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [acting,     setActing]     = useState(false);
  const [streamLog,  setStreamLog]  = useState('');
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: string[]; removed: number } | null>(null);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallLog, setUninstallLog] = useState('');
  const [mm1PublicIp, setMm1PublicIp] = useState('');
  const [mobileconfigApn, setMobileconfigApn] = useState('internet');
  const [mobileconfigMmscUrl, setMobileconfigMmscUrl] = useState('');
  const cfgSeeded = useRef(false);
  const mobileconfigSeeded = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const s = await mmsApi.getStatus();
      setStatus(s);
      if (!cfgSeeded.current && s.currentConfig?.mm1PublicIp) {
        setMm1PublicIp(s.currentConfig.mm1PublicIp);
        cfgSeeded.current = true;
      }
      if (!mobileconfigSeeded.current && s.currentConfig?.mm1PublicIp) {
        setMobileconfigMmscUrl(`http://${s.currentConfig.mm1PublicIp}:8002/mms/retrieve`);
        mobileconfigSeeded.current = true;
      }
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
      const resp   = await mmsApi.install();
      const reader = resp.body?.getReader();
      const dec    = new TextDecoder();
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
      const resp = await mmsApi.uninstall();
      const reader = resp.body?.getReader();
      const dec = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setUninstallLog(prev => prev + dec.decode(value, { stream: true }));
        }
      }
      toast.success('MMS removed');
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
      await mmsApi.configure(mm1PublicIp);
      toast.success('VectorCore MMSC configured and wired to osmo-msc via SMPP');
      await load(true);
    } catch (err: any) {
      toast.error(`Configure failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  const handleSync = async () => {
    setActing(true);
    setSyncResult(null);
    try {
      const r = await mmsApi.syncSubscribers();
      setSyncResult(r);
      toast.success(`Synced ${r.synced} subscriber${r.synced !== 1 ? 's' : ''}${r.removed ? ` · removed ${r.removed} stale` : ''}`);
      await load(true);
    } catch (err: any) {
      toast.error(`Sync failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  const handleSvcAction = async (action: 'start' | 'stop' | 'restart') => {
    setActing(true);
    try {
      await mmsApi[action]();
      toast.success(`VectorCore MMSC ${action}ed`);
      await load(true);
    } catch (err: any) {
      toast.error(`${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-nms-text-dim">
      <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading MMS status…
    </div>
  );

  const installed = status?.installed ?? false;

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">MMS</h1>
          <p className="text-sm text-nms-text-dim mt-1">Multimedia Messaging via VectorCore MMSC — delivery notifications ride on the SMS (SGs) SMPP interface</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {installed && (
            <>
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

      {FEATURES.mms && <ModuleTabBar pageTab={pageTab} setPageTab={setPageTab} />}

      {showUninstallConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="w-5 h-5 text-red-400 shrink-0" />
              <h2 className="text-base font-semibold text-nms-text">Uninstall MMS</h2>
            </div>
            <p className="text-sm text-nms-text-dim mb-3 leading-relaxed">This completely removes VectorCore MMSC and all traces of it:</p>
            <ul className="text-xs text-nms-text-dim space-y-1 mb-4 pl-4 list-disc">
              <li>Stop and disable the vectorcore-smsc service</li>
              <li>Remove the SMPP ESME from osmo-msc</li>
              <li>Delete the systemd unit</li>
              <li>Delete /opt/vectorcore entirely — binary, database, and stored media</li>
            </ul>
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-5">
              This does not touch SMS (SGs) itself, only the MMS layer on top of it. Cannot be undone.
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

      {/* Distinct from configStale below: Install rebuilds the actual
          VectorCore binary from source (git pull + go build), Configure
          only rewrites mmsc.yaml and restarts with whatever binary is
          already on disk - a source-level fix (e.g. the PNG content-type
          token patch, 2026-08-01) needs a real re-Install, Configure alone
          can never pick it up. Amber (heavier/slower operation, briefly
          stops the service) vs the lighter blue Configure banner below. */}
      {status?.installStale && (
        <div className="nms-card border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-300">VectorCore build out of date</p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                This deployment's VectorCore binary was built by an older version ({status.installedWithVersion ?? 'unknown'}, running {status.appVersion}) —
                a source-level fix has shipped since then. Click Rebuild below (safe to re-run — reuses the existing clone, only rebuilds).
              </p>
            </div>
            <button onClick={handleInstall} disabled={acting} className="nms-btn-primary flex items-center gap-2 text-sm shrink-0">
              <Terminal className="w-4 h-4" />
              {acting ? 'Rebuilding…' : 'Rebuild'}
            </button>
          </div>
          {streamLog && <LogTerminal lines={streamLog} />}
        </div>
      )}

      {status?.configStale && (
        <div className="nms-card border-blue-500/30 bg-blue-500/5 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-blue-300">Configuration out of date</p>
            <p className="text-xs text-nms-text-dim mt-0.5">
              This deployment was configured by an older version ({status.configuredWithVersion ?? 'unknown'}, running {status.appVersion}).
              Click Configure below to regenerate with the current template.
            </p>
          </div>
        </div>
      )}

      {/* Status panel */}
      <div className={`nms-card ${!installed ? 'border-amber-500/30 bg-amber-500/5' : status?.healthy ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            {!installed
              ? <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
              : status?.healthy
                ? <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
                : <XCircle className="w-5 h-5 text-red-400 shrink-0" />
            }
            <div>
              <p className="text-sm font-semibold">
                {!installed ? 'VectorCore MMSC not installed' : status?.healthy ? 'Running and healthy' : status?.serviceActive ? 'Running but not responding' : 'Stopped'}
              </p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                IMS: {status?.imsConfigured ? 'configured' : 'not configured'} · SMS (SGs): {status?.smsConfigured ? 'configured' : 'not configured — configure it on the SMS (SGs) tab first'}
              </p>
            </div>
          </div>
          {installed && (
            <div className="flex items-center gap-2 flex-wrap">
              <SvcBadge label="vectorcore-smsc" active={!!status?.serviceActive} />
              <SvcBadge label="SMPP ESME" active={!!status?.esmeActive} />
            </div>
          )}
        </div>
      </div>

      {/* Install card */}
      {!installed && (
        <div className="nms-card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <Terminal className="w-4 h-4 text-nms-accent" /> Install VectorCore MMSC
              </h2>
              <p className="text-xs text-nms-text-dim mt-1">
                Builds VectorCore MMSC from source (Go toolchain + embedded web UI) and installs it as a host service. Can take a few minutes.
                Requires IMS to already be installed — MMS relies on IMS being the default SMS delivery path for a fully working deployment.
              </p>
            </div>
            <button onClick={handleInstall} disabled={acting || !status?.imsInstalled} className="nms-btn-primary flex items-center gap-2 text-sm shrink-0">
              <Terminal className="w-4 h-4" />
              {acting ? 'Installing…' : 'Install'}
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

      {/* Configure card */}
      {installed && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
            <Settings className="w-4 h-4 text-nms-accent" /> Configure
          </h2>
          <p className="text-xs text-nms-text-dim mb-4">
            Writes VectorCore's config, registers its SMPP link to osmo-msc, and wires it up. Requires IMS and SMS (SGs) to already be configured.
          </p>
          {(!status?.imsConfigured || !status?.smsConfigured) && (
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-4">
              {!status?.imsConfigured && !status?.smsConfigured
                ? 'IMS and SMS (SGs) are not configured yet — configure both first.'
                : !status?.imsConfigured
                  ? 'IMS is not configured yet — configure IMS first.'
                  : 'SMS (SGs) is not configured yet — configure it on the SMS (SGs) tab first.'}
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div>
              <label className="nms-label flex items-center gap-1.5">
                <Network className="w-3 h-3" /> MM1 public IP
              </label>
              <input
                value={mm1PublicIp}
                onChange={e => setMm1PublicIp(e.target.value)}
                placeholder="10.0.1.178"
                className="nms-input font-mono text-xs mt-1"
              />
              <p className="text-xs text-nms-text-dim mt-1">IP real handsets can reach this host on — same address used for other UE-facing services (e.g. P-CSCF)</p>
            </div>
          </div>
          <button onClick={handleConfigure} disabled={acting || !mm1PublicIp || !status?.imsConfigured || !status?.smsConfigured} className="nms-btn-primary flex items-center gap-2 text-sm">
            <Settings className="w-4 h-4" />
            {acting ? 'Configuring…' : 'Configure'}
          </button>
        </div>
      )}

      {/* Subscriber sync card */}
      {installed && (
        <div className="nms-card">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-nms-accent" /> Subscriber Sync
              </h2>
              <p className="text-xs text-nms-text-dim">
                Push MSISDNs from Open5GS MongoDB into VectorCore so it knows which numbers can send/receive MMS.
              </p>
              {syncResult && (
                <p className={`text-xs mt-2 font-mono ${syncResult.failed.length ? 'text-amber-400' : 'text-green-400'}`}>
                  Synced {syncResult.synced}
                  {(syncResult.removed ?? 0) > 0 && ` · Removed ${syncResult.removed} stale`}
                  {syncResult.failed.length > 0 && ` · Failed: ${syncResult.failed.join(', ')}`}
                </p>
              )}
            </div>
            <button onClick={handleSync} disabled={acting} className="nms-btn-primary flex items-center gap-2 text-sm shrink-0">
              <Users className="w-4 h-4" />
              {acting ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
        </div>
      )}

      {/* iPhone MMS settings profile */}
      {installed && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
            <Smartphone className="w-4 h-4 text-nms-accent" /> iPhone MMS Settings Profile
          </h2>
          <p className="text-xs text-nms-text-dim mb-4">
            iOS hides the manual APN/MMSC settings screen on most SIMs — a Configuration Profile is the
            reliable way to set these on a real iPhone. Download it here, then AirDrop/email/Message it to
            the subscriber's phone (same "Review Profile" install flow either way) — Settings will prompt to
            install it, then Settings &gt; General &gt; VPN &amp; Device Management to confirm.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div>
              <label className="nms-label">APN name</label>
              <input
                value={mobileconfigApn}
                onChange={e => setMobileconfigApn(e.target.value)}
                placeholder="internet"
                className="nms-input font-mono text-xs mt-1"
              />
            </div>
            <div>
              <label className="nms-label flex items-center gap-1.5">
                <Network className="w-3 h-3" /> MMSC URL
              </label>
              <input
                value={mobileconfigMmscUrl}
                onChange={e => setMobileconfigMmscUrl(e.target.value)}
                placeholder={`http://${mm1PublicIp || '10.0.1.178'}:8002/mms/retrieve`}
                className="nms-input font-mono text-xs mt-1"
              />
            </div>
          </div>
          <a
            href={`/api/mms/mobileconfig?apn=${encodeURIComponent(mobileconfigApn || 'internet')}${mobileconfigMmscUrl ? `&mmscUrl=${encodeURIComponent(mobileconfigMmscUrl)}` : ''}`}
            className="nms-btn-primary inline-flex items-center gap-2 text-sm"
          >
            <Download className="w-4 h-4" /> Download .mobileconfig
          </a>
        </div>
      )}

      {installed && <VectorCoreAdminLinks />}

      {/* Empty state */}
      {!installed && !streamLog && (
        <div className="nms-card border-dashed border-nms-border text-center py-10">
          <Image className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
          <p className="text-sm text-nms-text-dim">VectorCore MMSC is not installed on this host.</p>
          <p className="text-xs text-nms-text-dim mt-1">Click <strong>Install</strong> above to build it from source.</p>
        </div>
      )}
    </>
  );
}

export function SMSPage() {
  const [pageTab,    setPageTab]    = useState<'sms' | 'mms'>('sms');
  const [activeTab,  setActiveTab]  = useState<'overview' | 'configs'>('overview');
  const [status,     setStatus]     = useState<SmsStatus | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [acting,     setActing]     = useState(false);
  const [streamLog,  setStreamLog]  = useState('');
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: string[]; removed?: number } | null>(null);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallLog, setUninstallLog] = useState('');

  // SMS delivery-mode selector (SMS over IMS vs SMS over SGs) — real phones
  // prefer IMS-based SMS whenever they're IMS-registered, regardless of
  // whether SGs is also configured, so this is a deployment-wide gate
  // enforced on the IMS side (S-CSCF hard-rejects SIP MESSAGE when SGs mode
  // is selected — see ims-controller.ts's setSmsDeliveryMode()).
  const [imsStatus, setImsStatus]   = useState<ImsStatus | null>(null);
  const [modeActing, setModeActing] = useState(false);
  const [intervalActing, setIntervalActing] = useState(false);
  const [intervalInput, setIntervalInput] = useState<string>('');

  // Send test SMS
  const [testTo,      setTestTo]      = useState('');
  const [testFrom,    setTestFrom]    = useState('');
  const [testText,    setTestText]    = useState('Hello World');
  const [testSending, setTestSending] = useState(false);
  const [testOutput,  setTestOutput]  = useState<string | null>(null);

  // Configure form — seeded from saved config on first load
  const [cfg, setCfg] = useState<SmsConfigureInput>({
    mscBindIp:  '127.0.0.2',
    hlrBindIp:  '127.0.0.1',
    mmeLocalIp: '',
  });
  const cfgSeeded = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const s = await smsApi.getStatus();
      setStatus(s);
      // Seed form from saved config on first load only
      if (!cfgSeeded.current && s.currentConfig) {
        setCfg(s.currentConfig);
        cfgSeeded.current = true;
      }
    } catch (err: any) {
      if (!silent) toast.error(`Status fetch failed: ${err.message}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadImsStatus = useCallback(() => {
    imsApi.getStatus().then(setImsStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    loadImsStatus();
    const iv = setInterval(() => { load(true); loadImsStatus(); }, 10_000);
    return () => clearInterval(iv);
  }, [load, loadImsStatus]);

  const handleSetDeliveryMode = async (mode: 'sgs' | 'ims') => {
    setModeActing(true);
    try {
      await imsApi.setSmsDeliveryMode(mode);
      toast.success(mode === 'sgs'
        ? 'SMS over IMS is now blocked at S-CSCF — SGs only'
        : 'SMS over IMS restored');
      loadImsStatus();
    } catch (err: any) {
      toast.error(`Failed to change delivery mode: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setModeActing(false);
    }
  };

  const handleSetSmsWorkerInterval = async () => {
    const seconds = parseInt(intervalInput, 10);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
      toast.error('Enter an integer between 1 and 300 seconds');
      return;
    }
    setIntervalActing(true);
    try {
      await imsApi.setSmsWorkerInterval(seconds);
      toast.success(`SMS delivery poll interval set to ${seconds}s`);
      loadImsStatus();
    } catch (err: any) {
      toast.error(`Failed to change poll interval: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setIntervalActing(false);
    }
  };

  const handleInstall = async () => {
    setActing(true);
    setStreamLog('');
    try {
      const resp   = await smsApi.install();
      const reader = resp.body?.getReader();
      const dec    = new TextDecoder();
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
      const resp = await smsApi.uninstall();
      const reader = resp.body?.getReader();
      const dec = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setUninstallLog(prev => prev + dec.decode(value, { stream: true }));
        }
      }
      toast.success('SMS-over-SGs removed');
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
      await smsApi.configure(cfg);
      toast.success('Configs written and MME restarted');
      await load(true);
    } catch (err: any) {
      toast.error(`Configure failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  const handleSync = async () => {
    setActing(true);
    setSyncResult(null);
    try {
      const r = await smsApi.syncSubscribers();
      setSyncResult(r);
      toast.success(`Synced ${r.synced} subscriber${r.synced !== 1 ? 's' : ''} to OsmoHLR${r.removed ? ` · removed ${r.removed} stale` : ''}`);
      await load(true);
    } catch (err: any) {
      toast.error(`Sync failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  const handleToggle = async () => {
    setActing(true);
    try {
      if (status?.smsEnabled) {
        await smsApi.disable();
        toast.success('SMS disabled — sgsap removed, Osmocom services stopped');
      } else {
        await smsApi.enable();
        toast.success('SMS enabled — sgsap restored, Osmocom services started');
      }
      await load(true);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err.message);
    } finally {
      setActing(false);
    }
  };

  const handleSendTest = async () => {
    setTestSending(true);
    setTestOutput(null);
    try {
      const r = await smsApi.sendTest(testTo, testFrom, testText);
      setTestOutput(r.output ?? r.error ?? '');
      if (r.success) toast.success('Test SMS sent via osmo-msc VTY');
      else toast.error('VTY reported an error — check output below');
    } catch (err: any) {
      setTestOutput(String(err?.response?.data?.error ?? err.message));
      toast.error('Send failed');
    } finally {
      setTestSending(false);
    }
  };

  const handleSvcAction = async (action: 'start' | 'stop' | 'restart') => {
    setActing(true);
    try {
      await smsApi[action]();
      toast.success(`Osmocom services ${action}ed`);
      await load(true);
    } catch (err: any) {
      toast.error(`${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  const installed = status?.installed ?? false;
  const svcs      = status?.services;
  const allUp     = svcs?.stp && svcs?.hlr && svcs?.msc;

  return (
    <div className="p-6 space-y-6">
      {pageTab === 'mms' ? <MmsTab pageTab={pageTab} setPageTab={setPageTab} /> : loading ? (
        <div className="flex items-center justify-center h-64 text-nms-text-dim">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading SMS status…
        </div>
      ) : (
      <>
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">SMS over SGs</h1>
          <p className="text-sm text-nms-text-dim mt-1">UE-to-UE SMS via Osmocom STP + HLR + MSC over the LTE SGs interface</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {installed && (status?.smsEnabled || status?.hasSavedConfig) && (
            <button
              onClick={handleToggle}
              disabled={acting}
              className={`flex items-center gap-2 text-sm px-4 py-2 rounded-lg border transition-all ${
                status?.smsEnabled
                  ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
                  : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text'
              }`}
            >
              <Power className="w-4 h-4" />
              {acting ? '…' : status?.smsEnabled ? 'SMS Enabled' : 'SMS Disabled'}
            </button>
          )}
          {installed && (
            <>
              <div className="w-px h-6 bg-nms-border" />
              <button
                onClick={() => handleSvcAction('start')}
                disabled={acting}
                className="nms-btn-ghost flex items-center gap-2 text-sm text-green-400 border-green-500/20 hover:border-green-500/40"
              >
                <CheckCircle className="w-4 h-4" /> Start
              </button>
              <button
                onClick={() => handleSvcAction('stop')}
                disabled={acting}
                className="nms-btn-ghost flex items-center gap-2 text-sm text-red-400 border-red-500/20 hover:border-red-500/40"
              >
                <XCircle className="w-4 h-4" /> Stop
              </button>
              <button
                onClick={() => handleSvcAction('restart')}
                disabled={acting}
                className="nms-btn-ghost flex items-center gap-2 text-sm text-amber-400 border-amber-500/20 hover:border-amber-500/40"
              >
                <RotateCw className={`w-4 h-4 ${acting ? 'animate-spin' : ''}`} /> Restart
              </button>
              <button
                onClick={() => setShowUninstallConfirm(true)}
                disabled={acting || uninstalling}
                className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg border text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
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

      {FEATURES.mms && <ModuleTabBar pageTab={pageTab} setPageTab={setPageTab} />}

      {showUninstallConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="w-5 h-5 text-red-400 shrink-0" />
              <h2 className="text-base font-semibold text-nms-text">Uninstall SMS over SGs</h2>
            </div>
            <p className="text-sm text-nms-text-dim mb-3 leading-relaxed">This completely removes SMS-over-SGs and all traces of it:</p>
            <ul className="text-xs text-nms-text-dim space-y-1 mb-4 pl-4 list-disc">
              <li>Stop and disable osmo-stp, osmo-hlr, and osmo-msc</li>
              <li>Remove the sgsap block from mme.yaml and restart open5gs-mmed</li>
              <li>Delete osmo-stp.cfg, osmo-hlr.cfg, and osmo-msc.cfg</li>
              <li>Delete the OsmoHLR subscriber database (hlr.db)</li>
              <li>Purge the osmo-stp/osmo-hlr/osmo-msc packages (sqlite3 is left installed — shared system utility)</li>
            </ul>
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-5">
              This does not touch subscriber MSISDNs in Open5GS/MongoDB, and does not affect
              SMS over IMS if that's separately configured — only this SGs-path stack. Cannot be undone.
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

      {/* Tab bar */}
      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {([['overview', 'Overview'], ['configs', 'Config Files']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={clsx('px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
                activeTab === key ? 'bg-nms-accent text-white shadow-sm' : 'text-nms-text-dim hover:text-nms-text')}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'configs' && <SmsConfigEditor />}

      {activeTab === 'overview' && <>

      <OverviewCard />

      {/* Status panel */}
      <div className={`nms-card ${!installed ? 'border-amber-500/30 bg-amber-500/5' : allUp ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            {!installed
              ? <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
              : allUp
                ? <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
                : <XCircle    className="w-5 h-5 text-red-400 shrink-0" />
            }
            <div>
              <p className="text-sm font-semibold">
                {!installed ? 'Osmocom not installed' : allUp ? 'All services running' : 'Services partially stopped'}
              </p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                MME SGs config: {status?.mmeSgsConfigured ? 'configured' : 'not configured'} ·{' '}
                OsmoHLR subscribers: {status?.hlrSubscribers ?? 0} /{' '}
                Open5GS with MSISDN: {status?.open5gsSubscribers ?? 0}
              </p>
            </div>
          </div>
          {installed && svcs && (
            <div className="flex items-center gap-2 flex-wrap">
              <SvcBadge label="osmo-stp" active={svcs.stp} />
              <SvcBadge label="osmo-hlr" active={svcs.hlr} />
              <SvcBadge label="osmo-msc" active={svcs.msc} />
            </div>
          )}
        </div>
      </div>

      {/* SMS delivery mode — real phones prefer SMS over IMS whenever
          they're IMS-registered, regardless of whether SGs is also
          available, so this deployment-wide gate lives on the IMS side
          (S-CSCF hard-rejects MESSAGE when SGs mode is selected). Only
          shown once IMS has been configured — the toggle is meaningless
          otherwise. */}
      {imsStatus?.hasSavedConfig && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
            <Network className="w-4 h-4 text-nms-accent" /> SMS Delivery Mode
          </h2>
          <p className="text-xs text-nms-text-dim mb-4">
            SMS over IMS is the default — real phones prefer it whenever they're IMS-registered, and it's the confirmed working baseline for this deployment.
            Select SGs-only to hard-block SIP MESSAGE at S-CSCF and force delivery over this SGs path instead (experimental — see docs before enabling).
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => handleSetDeliveryMode('ims')}
              disabled={modeActing || imsStatus.smsDeliveryMode === 'ims'}
              className={clsx('flex-1 flex items-center justify-center gap-2 text-sm px-4 py-2.5 rounded-lg border transition-all',
                imsStatus.smsDeliveryMode === 'ims'
                  ? 'bg-nms-accent/15 text-nms-accent border-nms-accent/30'
                  : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text')}
            >
              SMS over IMS (default) {imsStatus.smsDeliveryMode === 'ims' && '· active'}
            </button>
            <button
              onClick={() => handleSetDeliveryMode('sgs')}
              disabled={modeActing || imsStatus.smsDeliveryMode === 'sgs'}
              className={clsx('flex-1 flex items-center justify-center gap-2 text-sm px-4 py-2.5 rounded-lg border transition-all',
                imsStatus.smsDeliveryMode === 'sgs'
                  ? 'bg-nms-accent/15 text-nms-accent border-nms-accent/30'
                  : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text')}
            >
              SMS over SGs (this page, experimental) {imsStatus.smsDeliveryMode === 'sgs' && '· active'}
            </button>
          </div>

          {/* SMS_TO_3GPP/SMS_TO_SIP delivery over IMS is store-and-forward,
              polled by kamailio-smsc's own rtimer at this interval (see
              route[SMS_WORKER] in ims-controller.ts's smscMainCfg()) -
              applies regardless of which delivery mode above is currently
              selected, since it's purely about how often the IMS path's
              queue gets drained once a message reaches it. */}
          <div className="flex items-center justify-between gap-3 mt-4 pt-4 border-t border-nms-border">
            <div>
              <p className="text-sm font-medium">SMS-over-IMS delivery poll interval</p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                Currently {imsStatus.smsWorkerIntervalSeconds}s — lower means faster delivery, at the cost of more frequent queue polling (1-300s)
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={1}
                max={300}
                placeholder={String(imsStatus.smsWorkerIntervalSeconds)}
                value={intervalInput}
                onChange={e => setIntervalInput(e.target.value)}
                className="w-20 text-sm px-2 py-1.5 rounded-lg border border-nms-border bg-nms-surface-2 text-nms-text"
              />
              <button
                onClick={handleSetSmsWorkerInterval}
                disabled={intervalActing || !intervalInput}
                className="nms-btn-secondary text-sm px-3 py-1.5"
              >
                Set
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Install card — shown only when not installed */}
      {!installed && (
        <div className="nms-card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <Terminal className="w-4 h-4 text-nms-accent" /> Install Packages
              </h2>
              <p className="text-xs text-nms-text-dim mt-1">
                Installs <span className="font-mono">osmo-stp osmo-hlr osmo-msc sqlite3</span> on the host via apt
              </p>
            </div>
            <button
              onClick={handleInstall}
              disabled={acting}
              className="nms-btn-primary flex items-center gap-2 text-sm shrink-0"
            >
              <Terminal className="w-4 h-4" />
              {acting ? 'Installing…' : 'Install Packages'}
            </button>
          </div>
          {streamLog && <LogTerminal lines={streamLog} />}
        </div>
      )}

      {/* Configure card */}
      {installed && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
            <Settings className="w-4 h-4 text-nms-accent" /> Configure
          </h2>
          <p className="text-xs text-nms-text-dim mb-4">
            Writes <span className="font-mono">/etc/osmocom/*.cfg</span> and updates MME sgsap to connect to OsmoMSC.
            Use loopback IPs when all services run on the same host; use real IPs for distributed setups.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div>
              <label className="nms-label flex items-center gap-1.5">
                <Network className="w-3 h-3" /> OsmoMSC SGs bind IP
              </label>
              <input
                value={cfg.mscBindIp}
                onChange={e => setCfg(c => ({ ...c, mscBindIp: e.target.value }))}
                placeholder="127.0.0.2"
                className="nms-input font-mono text-xs mt-1"
              />
              <p className="text-xs text-nms-text-dim mt-1">MME will connect to this address on port 29118</p>
            </div>
            <div>
              <label className="nms-label flex items-center gap-1.5">
                <Network className="w-3 h-3" /> OsmoHLR GSUP bind IP
              </label>
              <input
                value={cfg.hlrBindIp}
                onChange={e => setCfg(c => ({ ...c, hlrBindIp: e.target.value }))}
                placeholder="127.0.0.1"
                className="nms-input font-mono text-xs mt-1"
              />
              <p className="text-xs text-nms-text-dim mt-1">OsmoMSC connects here on port 4222</p>
            </div>
            <div>
              <label className="nms-label flex items-center gap-1.5">
                <Network className="w-3 h-3" /> MME local SGs IP <span className="text-nms-text-dim font-normal">(optional)</span>
              </label>
              <input
                value={cfg.mmeLocalIp}
                onChange={e => setCfg(c => ({ ...c, mmeLocalIp: e.target.value }))}
                placeholder="leave blank = OS picks"
                className="nms-input font-mono text-xs mt-1"
              />
              <p className="text-xs text-nms-text-dim mt-1">MME's local SCTP bind for the SGs link</p>
            </div>
          </div>
          <button
            onClick={handleConfigure}
            disabled={acting || !cfg.mscBindIp || !cfg.hlrBindIp}
            className="nms-btn-primary flex items-center gap-2 text-sm"
          >
            <Settings className="w-4 h-4" />
            {acting ? 'Configuring…' : 'Generate Configs & Update MME'}
          </button>
        </div>
      )}

      {/* Subscriber sync card */}
      {installed && (
        <div className="nms-card">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-nms-accent" /> Subscriber Sync
              </h2>
              <p className="text-xs text-nms-text-dim">
                Push IMSI + MSISDN from Open5GS MongoDB into OsmoHLR so UEs can reach each other by phone number.
                OsmoHLR is briefly stopped during the bulk write.
              </p>
              <div className="flex items-center gap-4 mt-2">
                <span className="text-xs text-nms-text-dim">
                  OsmoHLR: <span className="font-mono text-nms-text">{status?.hlrSubscribers ?? 0}</span>
                </span>
                <span className="text-xs text-nms-text-dim">
                  Open5GS with MSISDN: <span className="font-mono text-nms-text">{status?.open5gsSubscribers ?? 0}</span>
                </span>
              </div>
              {syncResult && (
                <p className={`text-xs mt-2 font-mono ${syncResult.failed.length ? 'text-amber-400' : 'text-green-400'}`}>
                  Synced {syncResult.synced}
                  {(syncResult.removed ?? 0) > 0 && ` · Removed ${syncResult.removed} stale`}
                  {syncResult.failed.length > 0 && ` · Failed: ${syncResult.failed.join(', ')}`}
                </p>
              )}
            </div>
            <button
              onClick={handleSync}
              disabled={acting}
              className="nms-btn-primary flex items-center gap-2 text-sm shrink-0"
            >
              <Users className="w-4 h-4" />
              {acting ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
        </div>
      )}

      {/* Send test SMS card */}
      {installed && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
            <Send className="w-4 h-4 text-nms-accent" /> Send Test SMS
          </h2>
          <p className="text-xs text-nms-text-dim mb-4">
            Injects a message directly at OsmoMSC via its VTY (
            <span className="font-mono">subscriber msisdn &lt;to&gt; sms sender msisdn &lt;from&gt; send &lt;text&gt;</span>),
            bypassing the SGs path entirely — useful for testing SMS delivery to a handset without a second phone to send from.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div>
              <label className="nms-label">To (recipient MSISDN)</label>
              <input
                value={testTo}
                onChange={e => setTestTo(e.target.value)}
                placeholder="61487654321"
                className="nms-input font-mono text-xs mt-1"
              />
            </div>
            <div>
              <label className="nms-label">From (sender MSISDN)</label>
              <input
                value={testFrom}
                onChange={e => setTestFrom(e.target.value)}
                placeholder="61412341234"
                className="nms-input font-mono text-xs mt-1"
              />
            </div>
            <div>
              <label className="nms-label">Message text</label>
              <input
                value={testText}
                onChange={e => setTestText(e.target.value)}
                maxLength={160}
                placeholder="Hello World"
                className="nms-input text-xs mt-1"
              />
            </div>
          </div>
          <button
            onClick={handleSendTest}
            disabled={testSending || !testTo || !testFrom || !testText}
            className="nms-btn-primary flex items-center gap-2 text-sm"
          >
            <Send className="w-4 h-4" />
            {testSending ? 'Sending…' : 'Send Test SMS'}
          </button>
          {testOutput !== null && <LogTerminal lines={testOutput || '(no output)'} />}
        </div>
      )}

      {/* Empty state */}
      {!installed && !streamLog && (
        <div className="nms-card border-dashed border-nms-border text-center py-10">
          <MessageSquare className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
          <p className="text-sm text-nms-text-dim">Osmocom is not installed on this host.</p>
          <p className="text-xs text-nms-text-dim mt-1">
            Click <strong>Install Packages</strong> above to install osmo-stp, osmo-hlr, and osmo-msc.
          </p>
          <p className="text-xs font-mono text-nms-text-dim/60 mt-2">
            apt-get install -y osmo-stp osmo-hlr osmo-msc sqlite3
          </p>
        </div>
      )}

      </>}
      </>
      )}
    </div>
  );
}
