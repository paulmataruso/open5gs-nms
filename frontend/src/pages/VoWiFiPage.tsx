import { Fragment, useState, useEffect, useRef, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import {
  CheckCircle, XCircle, RefreshCw, RotateCw, Play, Square, Wifi,
  AlertTriangle, AlertCircle, BookOpen, ChevronDown, Users, Activity, Info,
  FileText,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { vowifiApi } from '../api/vowifi';
import type {
  VowifiStatus, VowifiConfigFile, VectorcoreStats, VectorcoreSession, VectorcoreClientDiag,
  VectorcoreIpsecStats, VectorcoreGtpuStats, VectorcoreStatusInfo,
} from '../api/vowifi';

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function uptimeHuman(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

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
              Gateway) using IKEv2/EAP-AKA and GTP. This module deploys{' '}
              <span className="font-mono text-nms-text">VectorCore ePDG</span> (Go, single binary,
              native XDP/eBPF GTP-U dataplane) paired with{' '}
              <span className="font-mono text-nms-text">VectorCore AAA</span> (Erlang), which handles
              SWx authentication against the HSS, SWm EAP-AKA relay from the ePDG, and S6b Diameter
              towards SMF.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">Component roles</h3>
            <div className="grid grid-cols-1 gap-2">
              {[
                { label: 'VectorCore ePDG', color: 'text-blue-400', desc: 'UE-facing IKEv2/EAP-AKA responder and S2b GTPv2-C client towards SMF. Native BPF/XDP+TC dataplane for GTP-U — no out-of-tree kernel module.' },
                { label: 'VectorCore AAA', color: 'text-amber-400', desc: 'Diameter proxy: SWm (from the ePDG), S6b (from SMF, acting as a AAA peer), SWx (to the HSS). Single Diameter stack for all three interfaces.' },
                { label: 'HSS (SWx)', color: 'text-green-400', desc: 'VectorCore AAA dials out to the existing HSS as the SWx client — no HSS-side config changes are needed.' },
                { label: 'SMF (S6b + GTPv2-C)', color: 'text-purple-400', desc: 'SMF is the S6b Diameter client, dialing out to VectorCore AAA acting as a AAA peer. One ConnectPeer line is added to smf.conf for this. GTPv2-C session establishment then proceeds exactly like an LTE PDN attach.' },
                { label: 'dummy-epdg interface', color: 'text-cyan-400', desc: 'A dedicated host IP the ePDG binds to for IKE and GTP-C/U traffic, and the XDP dataplane attaches to. Deliberately NOT advertised into EIGRP — it only needs to be reachable on this host.' },
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
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Alpha/experimental:</span> this backend replaced an earlier osmo-epdg-based one (archived, not deleted) after real UE registration never completed on it. Treat this as a beta-quality dependency until validated end-to-end with a real phone.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Self-signed certificate:</span> the ePDG presents a self-signed CA-issued certificate to the UE during IKE_AUTH, generated automatically on first Configure. A real consumer phone will not trust this by default without an explicit trust step.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Admin API:</span> the live session panel below is a direct, read-only view into VectorCore ePDG's own diagnostics API (IMSI, UE IP, APN, IKE/CHILD SA state) — proxied through this NMS, never exposed directly.</span></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Setup / lifecycle tab ──────────────────────────────────────────────────────

function SetupTab({ status, refresh }: { status: VowifiStatus | null; refresh: () => void }) {
  const [epdgIp, setEpdgIp] = useState('10.0.1.180');
  const [aaaListenIp, setAaaListenIp] = useState('127.0.0.11');
  const [interfaceMode, setInterfaceMode] = useState<'dummy' | 'existing'>('dummy');
  const [installLog, setInstallLog] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const streamRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (status?.epdgIp) setEpdgIp(status.epdgIp);
    if (status?.aaaListenIp) setAaaListenIp(status.aaaListenIp);
    if (status?.epdgInterfaceMode) setInterfaceMode(status.epdgInterfaceMode);
  }, [status?.epdgIp, status?.aaaListenIp, status?.epdgInterfaceMode]);

  const streamLog = useCallback(async () => {
    streamRef.current?.abort();
    const controller = new AbortController();
    streamRef.current = controller;
    try {
      const res = await fetch('/api/vowifi/install/log/stream', { credentials: 'include', signal: controller.signal });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setInstallLog(prev => prev + decoder.decode(value));
      }
    } catch { /* aborted or stream ended — fine */ }
  }, []);

  const isInstalling = !!status && !['idle', 'complete', 'failed'].includes(status.installStatus);
  // First-run vs. update-available vs. already-installed — the "1. Install" card only
  // needs to look like an action item in the first two cases. Once installed and not
  // stale, re-showing "Run Install" as the primary CTA every visit made it look like
  // install was never done (same fix already applied to the SecGW page's Setup tab).
  const neverInstalled = !status?.installedOnDisk;
  const installNeedsAttention = neverInstalled || !!status?.buildStale;

  useEffect(() => {
    if (isInstalling) streamLog();
    return () => streamRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInstalling]);

  const handleInstall = async () => {
    setBusy('install');
    setInstallLog('');
    try {
      await vowifiApi.install();
      toast.success('Install started');
      refresh();
    } catch (err) {
      toast.error(`Install failed to start: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleConfigure = async () => {
    setBusy('configure');
    try {
      const result = await vowifiApi.configure({ epdgIp, aaaListenIp, interfaceMode });
      if (result.ok) {
        toast.success('Configured');
        refresh();
      } else {
        toast.error(result.error ?? 'Configure failed');
      }
    } catch (err) {
      toast.error(`Configure failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {status?.configStale && (
        <div className="nms-card border-blue-500/30 bg-blue-500/10 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-200 leading-relaxed">
              <span className="font-semibold text-blue-400">Configuration out of date.</span>{' '}
              This deployment was last configured by
              {status.configuredWithVersion ? ` config-gen v${status.configuredWithVersion}` : ' an older version'},
              but this server generates v{status.currentConfigGenVersion}. Click Configure to redeploy with any
              fixes shipped since then.
            </p>
          </div>
          <button
            onClick={handleConfigure}
            disabled={!!busy}
            className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border text-blue-300 bg-blue-500/15 border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
          >
            Configure
          </button>
        </div>
      )}

      {installNeedsAttention ? (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text mb-3">1. Install</h2>
          {status?.buildStale && !neverInstalled && (
            <p className="text-xs text-amber-400 mb-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              A newer VectorCore build (source patch or commit pin) is available — rebuild to pick it up.
            </p>
          )}
          <p className="text-xs text-nms-text-dim mb-3">
            Builds VectorCore ePDG (Go + BPF) and VectorCore AAA (Erlang) from source and installs
            both to <span className="font-mono">/opt/vectorcore</span>. Takes a few minutes.
          </p>
          <button className="nms-btn-primary" disabled={!!busy || isInstalling} onClick={handleInstall}>
            {isInstalling ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {isInstalling ? `Installing (${status?.installStatus})...` : neverInstalled ? 'Run Install' : 'Rebuild'}
          </button>
          {(installLog || isInstalling) && <LogTerminal lines={installLog} />}
          {status?.installStatus === 'failed' && status.installError && (
            <p className="text-xs text-red-400 mt-2 flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {status.installError}
            </p>
          )}
        </div>
      ) : (
        <div className="nms-card !py-2.5 flex items-center justify-between">
          <p className="text-xs text-nms-text-dim flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
            VectorCore installed (patch rev {status?.builtWithVectorcorePatchRev}).
          </p>
          <button onClick={handleInstall} disabled={!!busy || isInstalling} className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1">
            {busy === 'install' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Reinstall
          </button>
        </div>
      )}
      {!installNeedsAttention && (installLog || isInstalling) && <LogTerminal lines={installLog} />}

      <div className="nms-card">
        <h2 className="text-sm font-semibold text-nms-text mb-3">2. Configure</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="nms-label">ePDG IP</label>
            <input className="nms-input" value={epdgIp} onChange={e => setEpdgIp(e.target.value)} />
          </div>
          <div>
            <label className="nms-label">AAA Listen IP (loopback)</label>
            <input className="nms-input" value={aaaListenIp} onChange={e => setAaaListenIp(e.target.value)} />
          </div>
          <div>
            <label className="nms-label">Interface Mode</label>
            <select className="nms-input" value={interfaceMode} onChange={e => setInterfaceMode(e.target.value as 'dummy' | 'existing')}>
              <option value="dummy">Create dummy interface</option>
              <option value="existing">Use existing IP</option>
            </select>
          </div>
        </div>
        <button className="nms-btn-primary" disabled={!!busy || status?.installStatus !== 'complete'} onClick={handleConfigure}>
          {busy === 'configure' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
          Configure
        </button>
        {status?.configured && (
          <p className="text-xs text-nms-text-dim mt-2">
            Configured {status.configuredAt ? new Date(status.configuredAt).toLocaleString() : ''} — aaaFqdn: <span className="font-mono">{status.aaaFqdn}</span>
          </p>
        )}
      </div>
    </div>
  );
}

// ── Config Files tab ────────────────────────────────────────────────────────

function ConfigFilesTab() {
  const [files, setFiles] = useState<VowifiConfigFile[]>([]);
  const [selected, setSelected] = useState<VowifiConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { vowifiApi.getConfigs().then(r => setFiles(r.configs)); }, []);

  const openFile = async (f: VowifiConfigFile) => {
    setSelected(f);
    const r = await vowifiApi.getConfigContent(f.path);
    setContent(r.content ?? '');
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const r = await vowifiApi.saveConfigContent(selected.path, content);
      if (r.ok) toast.success(`Saved — restarted: ${selected.restartServices.join(', ')}`);
      else toast.error('Save failed');
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
            <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1.5">{g}</h3>
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
      </div>
      <div className="nms-card lg:col-span-2">
        {selected ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-mono text-nms-text">{selected.path}</span>
              <button className="nms-btn-primary" disabled={saving} onClick={save}>
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : null} Save & Restart
              </button>
            </div>
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
          <p className="text-sm text-nms-text-dim">Select a config file to view/edit.</p>
        )}
      </div>
    </div>
  );
}

// ── Live Sessions tab — net-new capability vs. the archived backend ─────────────

// Expanded per-client detail — fetched lazily (only when the operator actually clicks
// Details, not eagerly for every session on every 5s poll) from VectorCore's own
// /api/v1/clients/{imsi}/diag, which exposes real IKE/ESP SPIs and a full per-bearer
// breakdown (EBI, QCI, TEIDs, traffic counters, last-packet timestamp) that the plain
// /api/v1/clients summary endpoint doesn't have at all.
function ClientDiagPanel({ diag }: { diag: VectorcoreClientDiag }) {
  const bearers = [{ ...diag.default_bearer, kind: 'Default' }, ...(diag.dedicated_bearers ?? []).map(b => ({ ...b, kind: 'Dedicated' }))];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <p className="text-nms-text-dim">IKE SPI (i / r)</p>
          <p className="font-mono text-nms-text break-all">{diag.ike_spi_i} / {diag.ike_spi_r}</p>
        </div>
        <div>
          <p className="text-nms-text-dim">ESP SPI (in / out)</p>
          <p className="font-mono text-nms-text break-all">{diag.esp_spi_in} / {diag.esp_spi_out}</p>
        </div>
        <div>
          <p className="text-nms-text-dim">PGW Control (S2b GTP-C)</p>
          <p className="font-mono text-nms-text">{diag.pgw_control_ip}:{diag.pgw_control_teid}</p>
        </div>
        <div>
          <p className="text-nms-text-dim">Last Activity</p>
          <p className="font-mono text-nms-text">{new Date(diag.last_activity).toLocaleString()}</p>
        </div>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-nms-text-dim border-b border-nms-border/50">
            <th className="pb-1.5 font-medium">Bearer</th>
            <th className="pb-1.5 font-medium">EBI</th>
            <th className="pb-1.5 font-medium">QCI</th>
            <th className="pb-1.5 font-medium">Local TEID</th>
            <th className="pb-1.5 font-medium">PGW TEID</th>
            <th className="pb-1.5 font-medium">Uplink</th>
            <th className="pb-1.5 font-medium">Downlink</th>
            <th className="pb-1.5 font-medium">Last UL Packet</th>
          </tr>
        </thead>
        <tbody>
          {bearers.map((b, idx) => (
            <tr key={idx} className="border-b border-nms-border/30 last:border-0">
              <td className="py-1 text-nms-text-dim">{b.kind}</td>
              <td className="py-1 font-mono text-nms-text">{b.ebi}</td>
              <td className="py-1 font-mono text-nms-text">{b.qci}</td>
              <td className="py-1 font-mono text-nms-text-dim">{b.local_teid}</td>
              <td className="py-1 font-mono text-nms-text-dim">{b.pgw_teid}</td>
              <td className="py-1 font-mono text-nms-text-dim">{b.uplink_packets.toLocaleString()} pkts / {bytesHuman(b.uplink_bytes)}</td>
              <td className="py-1 font-mono text-nms-text-dim">{b.downlink_packets.toLocaleString()} pkts / {bytesHuman(b.downlink_bytes)}</td>
              <td className="py-1 font-mono text-nms-text-dim text-[10px]">{b.last_uplink_packet ? new Date(b.last_uplink_packet).toLocaleTimeString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LiveSessionsTab({ enabled }: { enabled: boolean }) {
  const [sessions, setSessions] = useState<VectorcoreSession[]>([]);
  const [stats, setStats] = useState<VectorcoreStats | null>(null);
  const [ipsecStats, setIpsecStats] = useState<VectorcoreIpsecStats | null>(null);
  const [gtpuStats, setGtpuStats] = useState<VectorcoreGtpuStats | null>(null);
  const [statusInfo, setStatusInfo] = useState<VectorcoreStatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedImsi, setExpandedImsi] = useState<string | null>(null);
  const [diagCache, setDiagCache] = useState<Record<string, VectorcoreClientDiag>>({});
  const [diagLoading, setDiagLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const [sess, s, ipsec, gtpu, info] = await Promise.all([
        vowifiApi.getSessions(), vowifiApi.getStats(), vowifiApi.getIpsecStats(),
        vowifiApi.getGtpuStats(), vowifiApi.getVectorcoreStatusInfo(),
      ]);
      setSessions(sess);
      setStats(s);
      setIpsecStats(ipsec);
      setGtpuStats(gtpu);
      setStatusInfo(info);
      setError(null);
    } catch {
      setError('Admin API unreachable — is vectorcore-epdg running with api.enabled: true?');
    }
  }, [enabled]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const toggleDetails = async (imsi: string) => {
    if (expandedImsi === imsi) { setExpandedImsi(null); return; }
    setExpandedImsi(imsi);
    if (!diagCache[imsi]) {
      setDiagLoading(imsi);
      try {
        const diag = await vowifiApi.getClientDiag(imsi);
        setDiagCache(prev => ({ ...prev, [imsi]: diag }));
      } catch {
        toast.error('Failed to load client diagnostics');
      } finally {
        setDiagLoading(null);
      }
    }
  };

  const droppedTotal = gtpuStats
    ? gtpuStats.dropped_bad_teid + gtpuStats.dropped_bad_peer + gtpuStats.dropped_unsupported + gtpuStats.dropped_malformed
    : 0;

  return (
    <div className="space-y-4">
      {statusInfo && (
        <p className="text-xs text-nms-text-dim">
          VectorCore ePDG v{statusInfo.version} · built {new Date(statusInfo.build_date).toLocaleDateString()} · up {uptimeHuman(statusInfo.uptime_seconds)}
        </p>
      )}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Clients', value: stats.active_clients },
            { label: 'IKE SAs', value: stats.active_ike_sas },
            { label: 'CHILD SAs', value: stats.active_child_sas },
            { label: 'Bearers', value: stats.active_bearers },
          ].map(({ label, value }) => (
            <div key={label} className="nms-card text-center">
              <p className="text-2xl font-semibold text-nms-text">{value}</p>
              <p className="text-xs text-nms-text-dim mt-1">{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ipsecStats && (
          <div className="nms-card">
            <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">IPsec (ESP)</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-nms-text-dim">Packets In:</span> <span className="font-mono text-nms-text">{ipsecStats.esp_packets_in.toLocaleString()}</span></div>
              <div><span className="text-nms-text-dim">Packets Out:</span> <span className="font-mono text-nms-text">{ipsecStats.esp_packets_out.toLocaleString()}</span></div>
              <div><span className="text-nms-text-dim">Bytes In:</span> <span className="font-mono text-nms-text">{bytesHuman(ipsecStats.esp_bytes_in)}</span></div>
              <div><span className="text-nms-text-dim">Bytes Out:</span> <span className="font-mono text-nms-text">{bytesHuman(ipsecStats.esp_bytes_out)}</span></div>
            </div>
          </div>
        )}
        {gtpuStats && (
          <div className="nms-card">
            <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">GTP-U</h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-nms-text-dim">Uplink RX / TX:</span> <span className="font-mono text-nms-text">{gtpuStats.uplink_rx_packets.toLocaleString()} / {gtpuStats.uplink_tx_packets.toLocaleString()}</span></div>
              <div><span className="text-nms-text-dim">Downlink RX / TX:</span> <span className="font-mono text-nms-text">{gtpuStats.downlink_rx_packets.toLocaleString()} / {gtpuStats.downlink_tx_packets.toLocaleString()}</span></div>
              <div><span className="text-nms-text-dim">Active Tunnels:</span> <span className="font-mono text-nms-text">{gtpuStats.active_tunnels}</span></div>
              <div>
                <span className="text-nms-text-dim">Dropped:</span>{' '}
                <span className={clsx('font-mono', droppedTotal > 0 ? 'text-amber-400' : 'text-nms-text')}>{droppedTotal.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="nms-card">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-nms-accent" />
          <h2 className="text-sm font-semibold text-nms-text">Attached Subscribers</h2>
        </div>
        {error && <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {error}</p>}
        {!error && sessions.length === 0 && <p className="text-xs text-nms-text-dim">No active sessions.</p>}
        {sessions.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-nms-text-dim border-b border-nms-border">
                <th className="pb-2 font-medium">IMSI</th>
                <th className="pb-2 font-medium">UE IP</th>
                <th className="pb-2 font-medium">Outer IP</th>
                <th className="pb-2 font-medium">APN</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 font-medium">S2b PGW / TEIDs (ctrl / data)</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => (
                <Fragment key={s.imsi}>
                  <tr className="border-b border-nms-border/50">
                    <td className="py-1.5 font-mono text-nms-text">{s.imsi}</td>
                    <td className="py-1.5 font-mono text-nms-text-dim">{s.ue_ip}</td>
                    <td className="py-1.5 font-mono text-nms-text-dim">{s.outer_ip}</td>
                    <td className="py-1.5 text-nms-text-dim">{s.apn}</td>
                    <td className="py-1.5">
                      <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-mono border',
                        s.state === 'Active' ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-amber-400 bg-amber-500/10 border-amber-500/30')}>
                        {s.state}
                      </span>
                    </td>
                    <td className="py-1.5 font-mono text-nms-text-dim text-[11px]">{s.s2b.pgw} ({s.s2b.control_teid} / {s.s2b.data_teid})</td>
                    <td className="py-1.5 text-right">
                      <button onClick={() => toggleDetails(s.imsi)} className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1 ml-auto">
                        <Info className="w-3 h-3" /> {expandedImsi === s.imsi ? 'Hide' : 'Details'}
                      </button>
                    </td>
                  </tr>
                  {expandedImsi === s.imsi && (
                    <tr className="border-b border-nms-border/50 bg-nms-bg/30">
                      <td colSpan={7} className="py-3 px-2">
                        {diagLoading === s.imsi
                          ? <p className="text-xs text-nms-text-dim">Loading...</p>
                          : diagCache[s.imsi]
                            ? <ClientDiagPanel diag={diagCache[s.imsi]} />
                            : <p className="text-xs text-red-400">Failed to load diagnostics.</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function VoWiFiPage() {
  const [status, setStatus] = useState<VowifiStatus | null>(null);
  const [tab, setTab] = useState<'setup' | 'sessions' | 'configs'>('setup');
  const [svcBusy, setSvcBusy] = useState<string | null>(null);

  const refresh = useCallback(() => { vowifiApi.getStatus().then(setStatus).catch(() => {}); }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setSvcBusy(action);
    try {
      const fn = action === 'start' ? vowifiApi.start : action === 'stop' ? vowifiApi.stop : vowifiApi.restart;
      const result = await fn();
      if (result.ok) {
        toast.success(`${action[0].toUpperCase()}${action.slice(1)}ed`);
        refresh();
      } else {
        toast.error(result.error ?? `${action} failed`);
      }
    } catch (err) {
      toast.error(`${action} failed: ${String(err)}`);
    } finally {
      setSvcBusy(null);
    }
  };

  const TABS: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'setup',    label: 'Setup',         icon: <Wifi className="w-4 h-4" /> },
    { id: 'sessions', label: 'Live Sessions', icon: <Activity className="w-4 h-4" /> },
    { id: 'configs',  label: 'Config Files',  icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold font-display text-nms-text">VoWiFi (ePDG)</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">alpha</span>
          </div>
          <p className="text-sm text-nms-text-dim mt-1">VectorCore ePDG/AAA — VoWiFi call termination</p>
        </div>

        {status?.installedOnDisk && (
          <div className="flex items-center gap-2 flex-wrap">
            <SvcBadge label="vectorcore-epdg" active={!!status?.services['vowifi-vectorcore-epdg']} />
            <SvcBadge label="vectorcore-aaa" active={!!status?.services['vowifi-vectorcore-aaa']} />
            {status && <SvcBadge label={`dummy-epdg ${status.dummyInterfaceUp ? 'up' : 'down'}`} active={status.dummyInterfaceUp} />}
            {status && <SvcBadge label={`SMF peer ${status.smfConnectPeerPresent ? 'present' : 'missing'}`} active={status.smfConnectPeerPresent} />}

            <div className="h-5 w-px bg-nms-border" />

            <button onClick={() => handleServiceAction('start')} disabled={!!svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Play className="w-3 h-3" /> Start
            </button>
            <button onClick={() => handleServiceAction('stop')} disabled={!!svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Square className="w-3 h-3" /> Stop
            </button>
            <button onClick={() => handleServiceAction('restart')} disabled={!!svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <RotateCw className="w-3 h-3" /> Restart
            </button>
          </div>
        )}
      </div>

      <OverviewCard />

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {TABS.map(tabDef => (
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

      {tab === 'setup' && <SetupTab status={status} refresh={refresh} />}
      {tab === 'sessions' && <LiveSessionsTab enabled={!!status?.services['vowifi-vectorcore-epdg']} />}
      {tab === 'configs' && <ConfigFilesTab />}
    </div>
  );
}
