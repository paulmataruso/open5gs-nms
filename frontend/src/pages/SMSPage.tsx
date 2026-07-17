import { useState, useEffect, useRef, useCallback } from 'react';
import {
  MessageSquare, CheckCircle, XCircle, AlertCircle, RefreshCw,
  Terminal, RotateCw, Settings, Users, Network, Power, BookOpen, ChevronDown, Send, Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import Editor from '@monaco-editor/react';
import { smsApi, SmsConfigureInput } from '../api/sms';
import type { SmsStatus, SmsConfigFile } from '../api/sms';

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

export function SMSPage() {
  const [activeTab,  setActiveTab]  = useState<'overview' | 'configs'>('overview');
  const [status,     setStatus]     = useState<SmsStatus | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [acting,     setActing]     = useState(false);
  const [streamLog,  setStreamLog]  = useState('');
  const [syncResult, setSyncResult] = useState<{ synced: number; failed: string[]; removed?: number } | null>(null);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallLog, setUninstallLog] = useState('');

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

  useEffect(() => {
    load();
    const iv = setInterval(() => load(true), 10_000);
    return () => clearInterval(iv);
  }, [load]);

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

  if (loading) return (
    <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
      <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading SMS status…
    </div>
  );

  const installed = status?.installed ?? false;
  const svcs      = status?.services;
  const allUp     = svcs?.stp && svcs?.hlr && svcs?.msc;

  return (
    <div className="p-6 space-y-6">
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
    </div>
  );
}
