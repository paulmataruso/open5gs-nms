import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { type BeforeMount } from '@monaco-editor/react';
import {
  CheckCircle, XCircle, RefreshCw, RotateCw, Play, Square, Wifi,
  AlertTriangle, BookOpen, ChevronDown, Trash2, RadioTower,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { vowifiApi } from '../api/vowifi';
import type { VowifiStatus, VowifiInstallStatus, VowifiConfigFile } from '../api/vowifi';

// Monaco has no built-in Erlang tokenizer. osmo-epdg.config is Erlang sys.config syntax
// (% line comments, atoms, quoted strings, nested tuples/lists) — this registers just
// enough of a Monarch grammar to make it readable, not a full language server.
const registerErlangLanguage: BeforeMount = (monaco) => {
  if (monaco.languages.getLanguages().some((l: { id: string }) => l.id === 'erlang')) return;
  monaco.languages.register({ id: 'erlang' });
  monaco.languages.setLanguageConfiguration('erlang', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' },
      { open: '(', close: ')' }, { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider('erlang', {
    defaultToken: '',
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b[A-Z_][a-zA-Z0-9_]*\b/, 'variable'],
        [/\b[a-z][a-zA-Z0-9_]*\b/, 'type.identifier'],
        [/-?\d+\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/-?\d+/, 'number'],
        [/[{}()\[\]]/, '@brackets'],
        [/[,|]/, 'delimiter'],
      ],
    },
  });
};

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

// ── Overview / architecture explainer ─────────────────────────────────────────

function OverviewCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="nms-card">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-nms-accent shrink-0" />
          <span className="text-sm font-semibold text-nms-text">How VoWiFi Works</span>
          <span className="text-xs text-nms-text-dim">— architecture overview</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-5 space-y-5 text-sm">
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Overview</h3>
            <p className="text-nms-text-dim leading-relaxed">
              VoWiFi (Voice over WiFi) lets a UE attach to the core over an untrusted WiFi access
              network instead of LTE/NR, tunneling back to the EPC via an ePDG (evolved Packet Data
              Gateway) using IKEv2/EAP-AKA and GTP. This module deploys <span className="font-mono text-nms-text">osmo-epdg</span>
              {' '}(Erlang, handles SWx auth against the HSS and GTPv2-C session signaling towards SMF)
              paired with a patched <span className="font-mono text-nms-text">strongSwan</span> build
              that provides the IKEv2/EAP-AKA responder and bridges to osmo-epdg over a local GSUP link.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">Component roles</h3>
            <div className="grid grid-cols-1 gap-2">
              {[
                { label: 'strongSwan (charon)', color: 'text-blue-400', desc: 'UE-facing IKEv2 responder. Authenticates the UE via EAP-AKA, negotiates the IPsec child SA that carries the GTP-U bearer traffic.' },
                { label: 'osmo-epdg', color: 'text-amber-400', desc: 'Erlang ePDG core. Runs SWx Diameter towards the HSS (subscriber auth + static IP), S6b Diameter towards SMF (as a AAA peer), and GTPv2-C session signaling towards SMF. Bridges to charon over a local GSUP/IPA link.' },
                { label: 'HSS (SWx)', color: 'text-green-400', desc: 'osmo-epdg dials out to the existing HSS as the SWx client — no HSS-side config changes are needed.' },
                { label: 'SMF (S6b + GTPv2-C)', color: 'text-purple-400', desc: 'SMF is the S6b Diameter client, dialing out to osmo-epdg acting as a AAA peer. One ConnectPeer line is added to smf.conf for this. GTPv2-C session establishment then proceeds exactly like an LTE PDN attach.' },
                { label: 'dummy-epdg interface', color: 'text-cyan-400', desc: 'A dedicated host IP the ePDG binds to for IKE and GTP-C/U traffic. Deliberately NOT advertised into EIGRP — it only needs to be reachable on this host.' },
              ].map(({ label, color, desc }) => (
                <div key={label} className="flex items-start gap-3 bg-nms-bg border border-nms-border rounded-xl p-3">
                  <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${color.replace('text-', 'bg-')}`} />
                  <div>
                    <p className={`font-semibold text-xs ${color}`}>{label}</p>
                    <p className="text-xs text-nms-text-dim mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Important notes</h3>
            <ul className="space-y-1.5 text-xs text-nms-text-dim">
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Static subscriber IP recommended:</span> always test with a dedicated static IP (set on the subscriber) outside the range of any real device's assigned address — a dynamically-allocated test session can otherwise collide with a real UE's active IP.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">GTP kernel module flakiness:</span> the `gtp0` tunnel device intermittently fails to create with an EEXIST error. Every start of the ePDG service automatically reloads the `gtp` kernel module first, and a manual "Reload GTP Module" button is available below if the tunnel ever gets stuck.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">GSUP port:</span> osmo-epdg's GSUP bridge defaults to a non-standard port to avoid colliding with the existing SMS-over-SGs OsmoHLR, which owns port 4222 on this host.</span></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Setup Wizard tab ──────────────────────────────────────────────────────────

const INSTALL_STEP_ORDER: VowifiInstallStatus[] = [
  'preparing', 'installing_libosmocore', 'installing_osmo_epdg', 'installing_strongswan', 'verifying',
];

const INSTALL_STEP_LABELS: Record<string, string> = {
  preparing: 'Preflight checks + install build dependencies',
  installing_libosmocore: 'Build + install libosmocore (from source — apt package lacks EPDG support)',
  installing_osmo_epdg: 'Clone + build osmo-epdg (Erlang, rebar3)',
  installing_strongswan: 'Clone, patch, and build strongswan-epdg',
  verifying: 'Verify binaries installed',
};

function SetupWizardTab({ status, onDone }: { status: VowifiStatus | null; onDone: () => void }) {
  const [installLog, setInstallLog] = useState('');
  const [epdgIp, setEpdgIp] = useState('10.0.1.180');
  const [interfaceMode, setInterfaceMode] = useState<'dummy' | 'existing'>('dummy');
  const [s6bLocalIp, setS6bLocalIp] = useState('127.0.0.10');
  const [gsupPort, setGsupPort] = useState(4223);
  const [busy, setBusy] = useState<'install' | 'configure' | 'start' | null>(null);

  const installActive = status && !['idle', 'complete', 'failed'].includes(status.installStatus);

  useEffect(() => {
    if (!installActive) return;
    const poll = setInterval(async () => {
      try { setInstallLog(await vowifiApi.getInstallLog()); } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(poll);
  }, [installActive]);

  useEffect(() => {
    if (status?.installStatus === 'complete' || status?.installStatus === 'failed') {
      vowifiApi.getInstallLog().then(setInstallLog).catch(() => {});
    }
  }, [status?.installStatus]);

  const doInstall = async () => {
    setBusy('install');
    try {
      await vowifiApi.install(gsupPort);
      toast.success('Install started');
      onDone();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to start install');
    } finally {
      setBusy(null);
    }
  };

  const doConfigure = async () => {
    setBusy('configure');
    try {
      const r = await vowifiApi.configure({ epdgIp, interfaceMode, s6bLocalIp, gsupPort });
      if (r.ok) toast.success('Configured');
      else toast.error(r.error ?? 'Configure failed');
      onDone();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Configure failed');
    } finally {
      setBusy(null);
    }
  };

  const doStart = async () => {
    setBusy('start');
    try {
      await vowifiApi.start();
      toast.success('Services starting');
      setTimeout(onDone, 2000);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Start failed');
    } finally {
      setBusy(null);
    }
  };

  const stepIdx = status ? INSTALL_STEP_ORDER.indexOf(status.installStatus as any) : -1;
  const installComplete = status?.installStatus === 'complete';

  return (
    <div className="space-y-4 mt-4">
      {/* Step 1: Install */}
      <div className="nms-card space-y-3">
        <div className="flex items-center gap-2">
          <div className={clsx('w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
            installComplete ? 'bg-green-500/20 text-green-400' : 'bg-nms-accent/20 text-nms-accent')}>
            {installComplete ? <CheckCircle className="w-4 h-4" /> : '1'}
          </div>
          <span className="text-sm font-semibold text-nms-text">Install</span>
          <span className="text-xs text-nms-text-dim">— builds libosmocore, osmo-epdg, and strongswan-epdg from source (10-20+ minutes)</span>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-nms-text-dim block mb-1">GSUP bridge port</label>
            <input type="number" value={gsupPort} onChange={e => setGsupPort(parseInt(e.target.value) || 4223)}
              disabled={!!installActive || installComplete} className="nms-input text-sm w-28 font-mono" />
          </div>
          <p className="text-[10px] text-nms-text-dim max-w-xs mb-2">Local-only port used between charon and osmo-epdg. Default 4223 avoids colliding with the existing SMS-over-SGs OsmoHLR (port 4222).</p>
          <div className="flex-1" />
          <button onClick={doInstall} disabled={busy !== null || !!installActive || installComplete} className="nms-btn-primary flex items-center gap-2 text-sm">
            {busy === 'install' || installActive ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {installComplete ? 'Installed' : installActive ? 'Installing…' : 'Start Install'}
          </button>
        </div>

        {status && status.installStatus !== 'idle' && (
          <div className="space-y-2 pt-2 border-t border-nms-border">
            {INSTALL_STEP_ORDER.map((step, i) => {
              const isDone = stepIdx > i || installComplete;
              const isCurrent = status.installStatus === step;
              return (
                <div key={step} className="flex items-center gap-3">
                  <div className={clsx('w-5 h-5 rounded-full flex items-center justify-center shrink-0',
                    isDone ? 'bg-green-500/20' : isCurrent ? 'bg-nms-accent/20' : 'bg-nms-border/50')}>
                    {isDone ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                      : isCurrent ? <RefreshCw className="w-3 h-3 text-nms-accent animate-spin" />
                      : <span className="text-[10px] font-bold text-nms-text-dim/40">{i}</span>}
                  </div>
                  <span className={clsx('text-sm', isDone ? 'text-nms-text' : isCurrent ? 'text-nms-accent font-medium' : 'text-nms-text-dim')}>
                    {INSTALL_STEP_LABELS[step]}
                  </span>
                </div>
              );
            })}
            {status.installStatus === 'failed' && (
              <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded px-3 py-2 mt-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {status.installError}
              </div>
            )}
          </div>
        )}

        {installLog && <LogTerminal lines={installLog} />}
      </div>

      {/* Step 2: Configure */}
      <div className="nms-card space-y-3">
        <div className="flex items-center gap-2">
          <div className={clsx('w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
            status?.configured ? 'bg-green-500/20 text-green-400' : installComplete ? 'bg-nms-accent/20 text-nms-accent' : 'bg-nms-border/50 text-nms-text-dim')}>
            {status?.configured ? <CheckCircle className="w-4 h-4" /> : '2'}
          </div>
          <span className="text-sm font-semibold text-nms-text">Configure</span>
          <span className="text-xs text-nms-text-dim">— generates all config, adds one smf.conf line, restarts SMF</span>
        </div>

        <div>
          <label className="text-xs text-nms-text-dim block mb-1">ePDG IP source</label>
          <div className="flex gap-4 text-xs text-nms-text">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="epdgIfMode" checked={interfaceMode === 'dummy'}
                onChange={() => setInterfaceMode('dummy')} disabled={!installComplete} />
              Create a new dummy interface for this IP (default)
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="epdgIfMode" checked={interfaceMode === 'existing'}
                onChange={() => setInterfaceMode('existing')} disabled={!installComplete} />
              Use an IP I've already bound myself (loopback or a real interface)
            </label>
          </div>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-nms-text-dim block mb-1">
              ePDG IP {interfaceMode === 'dummy' ? '(will be assigned to a new dummy-epdg interface)' : '(must already be bound to an interface on this host)'}
            </label>
            <input value={epdgIp} onChange={e => setEpdgIp(e.target.value)} disabled={!installComplete}
              className="nms-input text-sm w-40 font-mono" spellCheck={false} />
          </div>
          <div>
            <label className="text-xs text-nms-text-dim block mb-1">S6b local IP (loopback)</label>
            <input value={s6bLocalIp} onChange={e => setS6bLocalIp(e.target.value)} disabled={!installComplete}
              className="nms-input text-sm w-40 font-mono" spellCheck={false} />
          </div>
          <div className="flex-1" />
          <button onClick={doConfigure} disabled={busy !== null || !installComplete} className="nms-btn-primary flex items-center gap-2 text-sm disabled:opacity-40">
            {busy === 'configure' ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
            {status?.configured ? 'Re-configure' : 'Configure'}
          </button>
        </div>
        {interfaceMode === 'existing' && (
          <p className="text-[10px] text-nms-text-dim">
            This IP is used as-is for osmo-epdg and strongSwan — nothing new is created. Bind it to a
            loopback alias (<code>ip addr add {epdgIp || '&lt;ip&gt;'}/32 dev lo</code>) or a real LAN
            interface yourself first (e.g. via systemd-networkd/netplan), or Configure will fail with a
            clear error rather than silently writing broken config.
          </p>
        )}
        <p className="text-[10px] text-nms-text-dim">
          S6b must bind to a loopback address — SMF's own Diameter stack lives on loopback, and Linux
          refuses to route loopback-sourced traffic to a non-loopback local destination even on the same host.
        </p>
      </div>

      {/* Step 3: Start & verify */}
      <div className="nms-card space-y-3">
        <div className="flex items-center gap-2">
          <div className={clsx('w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
            status?.running ? 'bg-green-500/20 text-green-400' : status?.configured ? 'bg-nms-accent/20 text-nms-accent' : 'bg-nms-border/50 text-nms-text-dim')}>
            {status?.running ? <CheckCircle className="w-4 h-4" /> : '3'}
          </div>
          <span className="text-sm font-semibold text-nms-text">Start &amp; Verify</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={doStart} disabled={busy !== null || !status?.configured} className="nms-btn-primary flex items-center gap-2 text-sm disabled:opacity-40">
            {busy === 'start' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Start Services
          </button>
          {status && (
            <>
              <SvcBadge label="osmo-epdg" active={status.services['vowifi-osmo-epdg']} />
              <SvcBadge label="charon" active={status.services['vowifi-charon']} />
              <SvcBadge label="GTP module" active={status.gtpModuleLoaded} />
              {status.epdgInterfaceMode !== 'existing' && <SvcBadge label="dummy-epdg" active={status.dummyInterfaceUp} />}
            </>
          )}
        </div>
        {status && status.running && (
          <p className="text-xs text-nms-text-dim">
            {status.activeIkeSas} active IKE SA{status.activeIkeSas === 1 ? '' : 's'}. Test with a real device or the
            SWu-IKEv2 test emulator against ePDG IP <span className="font-mono text-nms-text">{status.epdgIp}</span>.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Config Files tab ───────────────────────────────────────────────────────────

function ConfigEditorTab() {
  const [manifest, setManifest]             = useState<VowifiConfigFile[]>([]);
  const [selectedPath, setSelectedPath]     = useState<string | null>(null);
  const [content, setContent]               = useState('');
  const [originalContent, setOriginal]      = useState('');
  const [loading, setLoading]               = useState(false);
  const [saving, setSaving]                 = useState(false);
  const [manifestLoading, setManifestLoading] = useState(false);

  const isDirty = content !== originalContent;

  const loadManifest = useCallback(async () => {
    setManifestLoading(true);
    try {
      const d = await vowifiApi.getConfigs();
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
    try {
      const { content: c } = await vowifiApi.getConfigContent(filePath);
      setContent(c);
      setOriginal(c);
    } catch (err: any) {
      toast.error('Failed to load file: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!selectedPath) return;
    setSaving(true);
    try {
      await vowifiApi.saveConfigContent(selectedPath, content);
      setOriginal(content);
      setManifest(m => m.map(f => f.path === selectedPath ? { ...f, exists: true } : f));
      toast.success('Saved — dependent service(s) restarted.');
    } catch (err: any) {
      toast.error('Save failed: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const groups = manifest.reduce<Record<string, VowifiConfigFile[]>>((acc, f) => {
    (acc[f.group] ??= []).push(f);
    return acc;
  }, {});

  const selectedFile = manifest.find(f => f.path === selectedPath);

  return (
    <div className="flex border border-nms-border rounded-xl overflow-hidden" style={{ height: 'calc(100vh - 220px)', minHeight: '500px' }}>
      <div className="w-52 shrink-0 bg-nms-bg border-r border-nms-border overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-nms-border shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-nms-text-dim">Files</span>
          <button onClick={loadManifest} disabled={manifestLoading} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <RefreshCw className={clsx('w-3 h-3', manifestLoading && 'animate-spin')} />
          </button>
        </div>
        {Object.entries(groups).map(([group, files]) => (
          <div key={group}>
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-nms-text-dim">{group}</div>
            {files.map(f => (
              <button key={f.path} onClick={() => selectFile(f.path)}
                className={clsx('w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  selectedPath === f.path ? 'bg-nms-accent/10 text-nms-accent' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2')}>
                <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0',
                  selectedPath === f.path && isDirty ? 'bg-amber-400' : f.exists ? 'bg-green-500' : 'bg-nms-border')} />
                <span className="truncate font-mono">{f.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="flex-1 flex flex-col min-w-0 bg-[#1e1e1e]">
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-nms-surface border-b border-nms-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {selectedPath ? (
              <>
                <span className="font-mono text-xs text-nms-text-dim truncate">{selectedPath}</span>
                {isDirty && <span className="text-amber-400 text-xs shrink-0">● unsaved</span>}
              </>
            ) : <span className="text-xs text-nms-text-dim">Select a file from the left panel</span>}
          </div>
          <button onClick={handleSave} disabled={!selectedPath || saving || !isDirty} className="nms-btn text-xs px-3 py-1.5 disabled:opacity-40">
            {saving ? 'Saving…' : 'Save & Restart'}
          </button>
        </div>
        {loading ? (
          <div className="flex-1 flex items-center justify-center"><RefreshCw className="w-5 h-5 text-nms-accent animate-spin" /></div>
        ) : !selectedPath ? (
          <div className="flex-1 flex items-center justify-center"><p className="text-sm text-nms-text-dim">Select a config file to edit</p></div>
        ) : (
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              language={selectedFile?.language ?? 'plaintext'}
              theme="vs-dark"
              beforeMount={registerErlangLanguage}
              value={content}
              onChange={v => setContent(v ?? '')}
              options={{
                minimap: { enabled: false }, fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                wordWrap: 'off', scrollBeyondLastLine: false, lineNumbers: 'on',
                renderWhitespace: 'selection', tabSize: 2, automaticLayout: true,
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

export function VoWiFiPage() {
  const [status, setStatus]       = useState<VowifiStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'wizard' | 'configs'>('overview');
  const [acting, setActing]       = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallLog, setUninstallLog] = useState('');

  const load = useCallback(async () => {
    try { setStatus(await vowifiApi.getStatus()); } catch { /* backend not reachable */ }
  }, []);

  useEffect(() => {
    load();
    const isBusy = status && (!['idle', 'complete', 'failed'].includes(status.installStatus));
    const interval = setInterval(load, isBusy ? 3000 : 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, status?.installStatus]);

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setActing(true);
    try {
      if (action === 'start') await vowifiApi.start();
      if (action === 'stop') await vowifiApi.stop();
      if (action === 'restart') await vowifiApi.restart();
      toast.success(`${action} sent`);
      setTimeout(load, 1500);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? `${action} failed`);
    } finally {
      setActing(false);
    }
  };

  const handleReloadGtp = async () => {
    setActing(true);
    try {
      await vowifiApi.reloadGtpModule();
      toast.success('GTP kernel module reloaded');
      setTimeout(load, 1000);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Reload failed');
    } finally {
      setActing(false);
    }
  };

  const handleUninstall = async () => {
    setShowUninstallConfirm(false);
    setUninstalling(true);
    setUninstallLog('');
    try {
      const resp = await vowifiApi.uninstall();
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setUninstallLog(prev => prev + decoder.decode(value, { stream: true }));
        }
      }
      toast.success('Uninstall complete');
      await load();
    } catch (err: any) {
      toast.error('Uninstall failed: ' + String(err));
    } finally {
      setUninstalling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-nms-accent/10 border border-nms-accent/20">
            <Wifi className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold font-display text-nms-text">VoWiFi</h1>
            <p className="text-xs text-nms-text-dim">Voice over WiFi — osmo-epdg + strongSwan ePDG</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {status?.running && (
            <>
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
            </>
          )}
          {status?.installedOnDisk && (
            <button onClick={handleReloadGtp} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <RadioTower className="w-3 h-3" /> Reload GTP Module
            </button>
          )}
          {status?.installedOnDisk && (
            <button
              onClick={() => setShowUninstallConfirm(true)}
              disabled={acting || uninstalling}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" /> Uninstall
            </button>
          )}
          <button onClick={() => load()} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Alpha warning — VoWiFi is more experimental than IMS */}
      <div className="flex items-start gap-3 p-4 rounded-lg border border-amber-500/40 bg-amber-500/5">
        <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-amber-300">Alpha — highly experimental, not production-ready</p>
          <p className="text-xs text-nms-text-dim mt-0.5">
            The goal is a 100% automated deployment — today, expect to do manual configuration beyond what this
            wizard automates. This module is more experimental than IMS/VoLTE. It was proven working end-to-end against a test
            IKEv2/EAP-AKA emulator (real SWx/S6b/GTP-C signaling, a real subscriber, a real static-IP assignment,
            EAP-AKA authentication succeeding), but a real handset has not been confirmed working. Two real bugs in
            upstream osmo-epdg were found and patched during testing: it silently dropped the HSS-assigned static
            IP, and it hardcoded an oversized GTP hash-table size that a real Linux kernel's GTP driver rejects
            (this was previously misdiagnosed as random "GTP kernel-module flakiness" — it was actually
            deterministic). The `gtp0` kernel module is still reloaded on every service start as defense-in-depth,
            and a manual "Reload GTP Module" button exists above if a tunnel ever gets stuck. Do not rely on this
            for a production voice deployment.
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-nms-border">
        {(['overview', 'wizard', 'configs'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={clsx('px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === tab ? 'border-nms-accent text-nms-accent' : 'border-transparent text-nms-text-dim hover:text-nms-text')}>
            {tab === 'overview' ? 'Overview' : tab === 'wizard' ? 'Setup Wizard' : 'Config Files'}
          </button>
        ))}
      </div>

      {showUninstallConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <Trash2 className="w-5 h-5 text-red-400 shrink-0" />
              <h2 className="text-base font-semibold text-nms-text">Uninstall VoWiFi</h2>
            </div>
            <p className="text-sm text-nms-text-dim mb-3 leading-relaxed">This completely removes VoWiFi and all traces of it:</p>
            <ul className="text-xs text-nms-text-dim space-y-1 mb-4 pl-4 list-disc">
              <li>Stop, disable, and remove the osmo-epdg and charon systemd units</li>
              <li>Remove the S6b peer line from smf.conf and restart SMF</li>
              <li>Delete the dummy-epdg interface (only if VoWiFi created one)</li>
              <li>Remove strongSwan, osmo-epdg, and the from-source libosmocore build</li>
              <li>Delete the entire build workdir and all VoWiFi state</li>
            </ul>
            <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-5">
              osmo-hlr/osmo-msc/osmo-stp (SMS-over-SGs) are re-checked after removal since they share the
              apt-packaged libosmocore runtime — this cannot be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowUninstallConfirm(false)} className="flex-1 nms-btn-ghost text-sm py-2">Cancel</button>
              <button onClick={handleUninstall} className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition-colors">
                <Trash2 className="w-3.5 h-3.5" /> Uninstall VoWiFi
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

      {activeTab === 'overview' && (
        <>
          <OverviewCard />
          {status && (
            <div className="nms-card">
              <div className="flex items-center gap-2 mb-3">
                <Wifi className="w-4 h-4 text-nms-accent" />
                <span className="text-sm font-semibold text-nms-text">Service Status</span>
                {status.installStatus !== 'complete' && (
                  <span className="text-[10px] font-semibold uppercase tracking-widest px-2 py-0.5 rounded-full border text-amber-400 bg-amber-500/10 border-amber-500/30">
                    Not Installed
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <SvcBadge label="osmo-epdg" active={status.services['vowifi-osmo-epdg']} />
                <SvcBadge label="charon" active={status.services['vowifi-charon']} />
                <SvcBadge label="GTP module" active={status.gtpModuleLoaded} />
                {status.epdgInterfaceMode !== 'existing' && <SvcBadge label="dummy-epdg" active={status.dummyInterfaceUp} />}
                <SvcBadge label="smf.conf peer" active={status.smfConnectPeerPresent} />
              </div>
              <div className="flex gap-4 mt-3 pt-3 border-t border-nms-border text-xs text-nms-text-dim">
                <span>{status.activeIkeSas} active IKE SA{status.activeIkeSas === 1 ? '' : 's'}</span>
                {status.epdgIp && <span>ePDG IP: <span className="font-mono text-nms-text">{status.epdgIp}</span></span>}
                {status.gsupPort && <span>GSUP port: <span className="font-mono text-nms-text">{status.gsupPort}</span></span>}
              </div>
            </div>
          )}
          {status?.installStatus !== 'complete' && (
            <div className="nms-card text-center py-6 space-y-2">
              <p className="text-sm text-nms-text-dim">
                {status?.installStatus === 'failed' ? 'The last install attempt failed.' : 'VoWiFi is not installed yet.'}
              </p>
              {status?.installedOnDisk && (
                <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 max-w-md mx-auto">
                  Some VoWiFi binaries exist on disk already, but they don't come from a verified, completed
                  install (e.g. leftovers from an earlier failed or manual attempt). Run Uninstall first to
                  clear them out, then Install fresh for a clean, verified build.
                </p>
              )}
              <button onClick={() => setActiveTab('wizard')} className="nms-btn-primary text-sm">Go to Setup Wizard</button>
            </div>
          )}
        </>
      )}
      {activeTab === 'wizard' && <SetupWizardTab status={status} onDone={load} />}
      {activeTab === 'configs' && <ConfigEditorTab />}
    </div>
  );
}
