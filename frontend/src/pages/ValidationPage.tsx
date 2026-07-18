import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'react-hot-toast';
import {
  Play, Square, RefreshCw, Wifi, Radio, ChevronDown, ChevronUp,
  CheckCircle, XCircle, Loader, AlertTriangle, Network, Signal, Trash2, Download, PhoneCall,
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  inferConfig, getSessions, startSession, stopSession, stopAll,
  fetchSessionStatus, fetchRawLogs, forceCleanup, getCapacity, pingUe,
  InferredConfig, SessionSummary, UeStatus, HostCapacity, PingResult, RawLogs,
} from '../api/validation';
import { swuEmulatorApi, SwuEmulatorStatus } from '../api/swuEmulator';
import { getVolteStatus, runVolteTest, VolteValidationStatus, VolteTestStep } from '../api/volteValidation';
import { getVowifiStatus, runVowifiTest, VowifiValidationStatus, VowifiTestStep } from '../api/vowifiValidation';

// ─── UE state badge ──────────────────────────────────────────────────────────

function StateBadge({ state }: { state: UeStatus['state'] }) {
  const map: Record<UeStatus['state'], { icon: React.ReactNode; label: string; cls: string }> = {
    starting:            { icon: <Loader className="w-3 h-3 animate-spin" />, label: 'Starting',      cls: 'text-gray-400 border-gray-600' },
    registered:          { icon: <Signal className="w-3 h-3" />,             label: 'Registered',    cls: 'text-blue-400 border-blue-500/40 bg-blue-500/10' },
    session_established: { icon: <CheckCircle className="w-3 h-3" />,        label: 'Connected',     cls: 'text-green-400 border-green-500/40 bg-green-500/10' },
    failed:              { icon: <XCircle className="w-3 h-3" />,            label: 'Failed',        cls: 'text-red-400 border-red-500/40 bg-red-500/10' },
    stopped:             { icon: <Square className="w-3 h-3" />,             label: 'Stopped',       cls: 'text-gray-500 border-gray-600' },
  };
  const { icon, label, cls } = map[state] ?? map.starting;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}>
      {icon} {label}
    </span>
  );
}

// ─── Distribution visualiser ─────────────────────────────────────────────────

function DistributionViz({
  nodeCount, ueTotal, label,
}: { nodeCount: number; ueTotal: number; label: string }) {
  const perNode = nodeCount > 0 ? Math.ceil(ueTotal / nodeCount) : 0;
  return (
    <div className="flex gap-2 flex-wrap mt-2">
      {Array.from({ length: Math.min(nodeCount, 8) }, (_, i) => (
        <div key={i} className="flex flex-col items-center gap-1">
          <div className="text-[9px] text-nms-text-dim">{label}{i + 1}</div>
          <div className="border border-nms-border rounded p-1 flex flex-wrap gap-0.5 w-14 min-h-[28px] content-start">
            {Array.from({ length: Math.min(perNode, 12) }, (_, j) => (
              <div key={j} className="w-1.5 h-1.5 rounded-full bg-nms-accent/60" />
            ))}
            {perNode > 12 && <div className="text-[8px] text-nms-text-dim">+{perNode - 12}</div>}
          </div>
        </div>
      ))}
      {nodeCount > 8 && (
        <div className="text-xs text-nms-text-dim self-center">+{nodeCount - 8} more</div>
      )}
    </div>
  );
}

// ─── VoWiFi / SWu-IKEv2 emulator card ───────────────────────────────────────

function SwuLogTerminal({ lines }: { lines: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-72 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-2">
      {lines || 'Waiting for output...'}
    </pre>
  );
}

function SwuEmulatorCard() {
  const [status, setStatus] = useState<SwuEmulatorStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [runLog, setRunLog] = useState('');
  const [busy, setBusy] = useState<'install' | 'run' | 'stop' | null>(null);
  const [imsi, setImsi] = useState('');
  const [k, setK] = useState('');
  const [opc, setOpc] = useState('');
  const [staticIp, setStaticIp] = useState('');

  const load = useCallback(async () => {
    try { setStatus(await swuEmulatorApi.getStatus()); } catch { /* backend not reachable */ }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, status?.running ? 2000 : 6000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, status?.running]);

  useEffect(() => {
    if (!status?.running) return;
    const poll = setInterval(async () => {
      try { setRunLog(await swuEmulatorApi.getLog()); } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(poll);
  }, [status?.running]);

  const doInstall = async () => {
    setBusy('install');
    setInstalling(true);
    setInstallLog('');
    try {
      const resp = await swuEmulatorApi.install();
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setInstallLog(prev => prev + decoder.decode(value, { stream: true }));
        }
      }
      toast.success('SWu-IKEv2 emulator installed');
      await load();
    } catch (err: any) {
      toast.error('Install failed: ' + String(err));
    } finally {
      setInstalling(false);
      setBusy(null);
    }
  };

  const doRun = async () => {
    setBusy('run');
    try {
      const body = imsi && k && opc ? { imsi, k, opc, staticIp: staticIp || undefined } : {};
      const r = await swuEmulatorApi.run(body);
      if (r.ok) {
        toast.success(`Test tunnel starting — IMSI ${r.imsi}, IP ${r.staticIp}${r.autoCreated ? ' (auto-created test subscriber)' : ''}`);
      } else {
        toast.error(r.error ?? 'Failed to start');
      }
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to start test tunnel');
    } finally {
      setBusy(null);
    }
  };

  const doStop = async () => {
    setBusy('stop');
    try {
      await swuEmulatorApi.stop();
      toast.success('Test tunnel stopped and cleaned up');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Stop failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border rounded-lg overflow-hidden border-nms-border bg-nms-surface">
      <div className="flex items-center justify-between px-4 py-3 border-b border-nms-border/50">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-nms-accent" />
          <span className="font-semibold text-nms-text">VoWiFi Test Tunnel</span>
          <span className="text-[10px] text-nms-text-dim bg-nms-surface border border-nms-border px-1.5 py-0.5 rounded">SWu-IKEv2</span>
        </div>
        {status && (
          <div className="flex items-center gap-2">
            <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border',
              status.running ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-nms-text-dim border-nms-border')}>
              {status.running ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} {status.running ? 'Running' : 'Stopped'}
            </span>
            <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border',
              status.tunnelEstablished ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-nms-text-dim border-nms-border')}>
              {status.tunnelEstablished ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} IKE {status.tunnelEstablished ? 'ESTABLISHED' : 'not established'}
            </span>
          </div>
        )}
      </div>

      <div className="px-4 py-4 space-y-4">
        <p className="text-xs text-nms-text-dim leading-relaxed">
          Runs <a href="https://github.com/fasferraz/SWu-IKEv2" target="_blank" rel="noreferrer" className="text-nms-accent hover:underline">fasferraz/SWu-IKEv2</a>,
          a standalone IKEv2/EAP-AKA client, in an isolated network namespace (so it doesn't collide with the host's own
          charon listening on port 500), and points it at the configured VoWiFi ePDG. This is the same tool used to prove
          out VoWiFi end-to-end during development. Requires the VoWiFi module to already be installed and configured.
        </p>

        {!status?.epdgIp && (
          <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            VoWiFi is not configured yet — go to the VoWiFi page and run Configure first.
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={doInstall} disabled={busy !== null || status?.installed} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5 disabled:opacity-40">
            {installing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            {status?.installed ? 'Installed' : 'Install Emulator'}
          </button>
          {status?.assignedIp && <span className="text-xs text-nms-text-dim">Assigned IP: <span className="font-mono text-nms-text">{status.assignedIp}</span></span>}
        </div>

        {installLog && (
          <div>
            <p className="text-xs text-nms-text-dim mb-1">Install log</p>
            <SwuLogTerminal lines={installLog} />
          </div>
        )}

        {status?.installed && !status.running && (
          <div className="space-y-2 pt-2 border-t border-nms-border">
            <p className="text-xs text-nms-text-dim">
              Leave IMSI/K/OPc blank to auto-create a disposable test subscriber with a static IP picked from the
              top of the "internet" pool (well clear of real subscribers). Fill them in only to test a specific
              existing subscriber — in that case a static IP is required.
            </p>
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="text-xs text-nms-text-dim block mb-1">IMSI (optional)</label>
                <input value={imsi} onChange={e => setImsi(e.target.value)} placeholder="auto" className="nms-input text-sm w-40 font-mono" spellCheck={false} />
              </div>
              <div>
                <label className="text-xs text-nms-text-dim block mb-1">K (optional)</label>
                <input value={k} onChange={e => setK(e.target.value)} placeholder="auto" className="nms-input text-sm w-40 font-mono" spellCheck={false} />
              </div>
              <div>
                <label className="text-xs text-nms-text-dim block mb-1">OPc (optional)</label>
                <input value={opc} onChange={e => setOpc(e.target.value)} placeholder="auto" className="nms-input text-sm w-40 font-mono" spellCheck={false} />
              </div>
              <div>
                <label className="text-xs text-nms-text-dim block mb-1">Static IP</label>
                <input value={staticIp} onChange={e => setStaticIp(e.target.value)} placeholder="auto" className="nms-input text-sm w-32 font-mono" spellCheck={false} />
              </div>
              <button onClick={doRun} disabled={busy !== null || !status?.epdgIp} className="nms-btn-primary flex items-center gap-2 text-sm disabled:opacity-40">
                {busy === 'run' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Start Test Tunnel
              </button>
            </div>
          </div>
        )}

        {status?.running && (
          <div className="space-y-2 pt-2 border-t border-nms-border">
            <div className="flex items-center gap-4 text-xs text-nms-text-dim flex-wrap">
              <span>IMSI: <span className="font-mono text-nms-text">{status.imsi}</span></span>
              <span>Static IP: <span className="font-mono text-nms-text">{status.staticIp}</span></span>
              {status.autoCreatedSubscriber && <span className="text-amber-400">auto-created test subscriber — removed on Stop</span>}
            </div>
            <button onClick={doStop} disabled={busy !== null} className="nms-btn-danger flex items-center gap-2 text-sm">
              {busy === 'stop' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />} Stop Test Tunnel
            </button>
            <SwuLogTerminal lines={runLog} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── VoLTE E2E validation test card ─────────────────────────────────────────

function VolteStepRow({ step }: { step: VolteTestStep }) {
  const [expanded, setExpanded] = useState(false);
  const hasLog = !!step.logExcerpt;
  return (
    <div className="py-1.5 border-b border-nms-border/30 last:border-0">
      <div className="flex items-center gap-2 text-xs">
        {step.ok ? <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
        <span className={clsx('shrink-0', step.ok ? 'text-nms-text' : 'text-red-400')}>{step.name}</span>
        {step.detail && (
          <span className={clsx('flex-1 font-mono truncate', step.ok ? 'text-nms-text-dim' : 'text-red-400/80')} title={step.detail}>
            {step.detail}
          </span>
        )}
        {!step.detail && <span className="flex-1" />}
        <span className="text-nms-text-dim font-mono shrink-0">{step.durationMs}ms</span>
        {hasLog && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="shrink-0 text-nms-text-dim hover:text-nms-text flex items-center gap-0.5 text-[10px] border border-nms-border rounded px-1 py-0.5"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} log
          </button>
        )}
      </div>
      {expanded && hasLog && (
        <pre className="mt-1.5 bg-nms-bg rounded p-2 text-[10px] font-mono text-green-300/90 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border">
          {step.logExcerpt}
        </pre>
      )}
    </div>
  );
}

function VolteTestCard() {
  const [status, setStatus] = useState<VolteValidationStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<VolteTestStep[]>([]);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await getVolteStatus()); } catch { /* backend not reachable */ }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, running ? 3000 : 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, running]);

  const doRun = async () => {
    setRunning(true);
    setSteps([]);
    setResult(null);
    try {
      const resp = await runVolteTest();
      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (parsed.type === 'step') {
            setSteps(prev => [...prev, parsed as VolteTestStep]);
          } else if (parsed.type === 'result') {
            setResult({ success: parsed.success, error: parsed.error });
          }
        }
      }
    } catch (err: any) {
      toast.error('VoLTE test failed: ' + String(err.message ?? err));
      setResult({ success: false, error: String(err.message ?? err) });
    } finally {
      setRunning(false);
      await load();
    }
  };

  return (
    <div className="border rounded-lg overflow-hidden border-nms-border bg-nms-surface">
      <div className="flex items-center justify-between px-4 py-3 border-b border-nms-border/50">
        <div className="flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-nms-accent" />
          <span className="font-semibold text-nms-text">VoLTE End-to-End Test</span>
          <span className="text-[10px] text-nms-text-dim bg-nms-surface border border-nms-border px-1.5 py-0.5 rounded">IMS / SIP</span>
        </div>
        {result && (
          <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border',
            result.success ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30')}>
            {result.success ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} {result.success ? 'PASS' : 'FAIL'}
          </span>
        )}
      </div>

      <div className="px-4 py-4 space-y-4">
        <p className="text-xs text-nms-text-dim leading-relaxed">
          Provisions two disposable IMS-only test subscribers directly in PyHSS (no Open5GS/Mongo subscribers, no
          RAN involved), registers both over SIP via <span className="font-mono">linphonec</span>, places a call
          from one to the other, answers it, verifies bidirectional RTP media, hangs up, and then deprovisions
          both test subscribers and reverts the S-CSCF auth mode — all automatically, regardless of outcome.
        </p>

        {status && !status.imsConfigured && (
          <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            IMS is not configured yet — go to the IMS page and run Configure first.
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={doRun}
            disabled={running || !status?.imsConfigured || status?.running}
            className="nms-btn-primary flex items-center gap-2 text-sm disabled:opacity-40"
          >
            {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Running...' : 'Run VoLTE Test'}
          </button>
          {status?.imsDomain && <span className="text-xs text-nms-text-dim">IMS domain: <span className="font-mono text-nms-text">{status.imsDomain}</span></span>}
        </div>

        {steps.length > 0 && (
          <div className="pt-2 border-t border-nms-border">
            <p className="text-xs text-nms-text-dim mb-1">Test steps</p>
            <div className="bg-nms-bg rounded p-3 border border-nms-border">
              {steps.map((s, i) => <VolteStepRow key={i} step={s} />)}
            </div>
          </div>
        )}

        {result && !result.success && result.error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2 font-mono whitespace-pre-wrap">
            {result.error}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── VoWiFi E2E validation test card ────────────────────────────────────────
// Same shape as VolteTestCard — the backend establishes a real IPsec tunnel
// (SWu-IKEv2 emulator) and runs one linphonec instance *inside* that tunnel's
// network namespace, so this proves SIP/RTP actually transits the encrypted
// tunnel, not a loopback shortcut. VolteStepRow is reused as-is: VowifiTestStep
// has the identical shape (name/ok/detail/logExcerpt/durationMs).

function VowifiTestCard() {
  const [status, setStatus] = useState<VowifiValidationStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<VowifiTestStep[]>([]);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await getVowifiStatus()); } catch { /* backend not reachable */ }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, running ? 3000 : 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, running]);

  const doRun = async () => {
    setRunning(true);
    setSteps([]);
    setResult(null);
    try {
      const resp = await runVowifiTest();
      if (!resp.ok || !resp.body) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (parsed.type === 'step') {
            setSteps(prev => [...prev, parsed as VowifiTestStep]);
          } else if (parsed.type === 'result') {
            setResult({ success: parsed.success, error: parsed.error });
          }
        }
      }
    } catch (err: any) {
      toast.error('VoWiFi test failed: ' + String(err.message ?? err));
      setResult({ success: false, error: String(err.message ?? err) });
    } finally {
      setRunning(false);
      await load();
    }
  };

  return (
    <div className="border rounded-lg overflow-hidden border-nms-border bg-nms-surface">
      <div className="flex items-center justify-between px-4 py-3 border-b border-nms-border/50">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-nms-accent" />
          <span className="font-semibold text-nms-text">VoWiFi End-to-End Test</span>
          <span className="text-[10px] text-nms-text-dim bg-nms-surface border border-nms-border px-1.5 py-0.5 rounded">IMS / SIP over IPsec</span>
        </div>
        {result && (
          <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border',
            result.success ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30')}>
            {result.success ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} {result.success ? 'PASS' : 'FAIL'}
          </span>
        )}
      </div>

      <div className="px-4 py-4 space-y-4">
        <p className="text-xs text-nms-text-dim leading-relaxed">
          Establishes a real IKEv2/EAP-AKA IPsec tunnel to the configured ePDG (reusing the same
          SWu-IKEv2 emulator as the VoWiFi Test Tunnel card below), then runs{' '}
          <span className="font-mono">linphonec</span> <em>inside that tunnel's network namespace</em> so
          its SIP traffic genuinely transits the encrypted tunnel — the same path a real VoWiFi phone
          takes, not a loopback shortcut. Registers, places a call to a plain local test subscriber,
          verifies bidirectional RTP, hangs up, then tears down the tunnel and both test identities
          automatically regardless of outcome.
        </p>

        {status && !status.imsConfigured && (
          <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            IMS is not configured yet — go to the IMS page and run Configure first.
          </div>
        )}
        {status?.tunnelAlreadyRunning && (
          <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            A VoWiFi Test Tunnel session is already running below — stop it first, this test needs the tunnel slot free.
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={doRun}
            disabled={running || !status?.imsConfigured || status?.running || status?.tunnelAlreadyRunning}
            className="nms-btn-primary flex items-center gap-2 text-sm disabled:opacity-40"
          >
            {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Running...' : 'Run VoWiFi Test'}
          </button>
          {status?.imsDomain && <span className="text-xs text-nms-text-dim">IMS domain: <span className="font-mono text-nms-text">{status.imsDomain}</span></span>}
        </div>

        {steps.length > 0 && (
          <div className="pt-2 border-t border-nms-border">
            <p className="text-xs text-nms-text-dim mb-1">Test steps</p>
            <div className="bg-nms-bg rounded p-3 border border-nms-border">
              {steps.map((s, i) => <VolteStepRow key={i} step={s} />)}
            </div>
          </div>
        )}

        {result && !result.success && result.error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2 font-mono whitespace-pre-wrap">
            {result.error}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── UE status table ─────────────────────────────────────────────────────────

function UeTable({ statuses, filter, sessionId }: { statuses?: Record<string, UeStatus>; filter?: '5g' | '4g'; sessionId: string }) {
  const entries = Object.values(statuses ?? {}).filter(u => !filter || u.type === filter);
  const [pingState, setPingState] = useState<Record<string, 'pinging' | PingResult | 'error'>>({});

  const handlePing = async (imsi: string, ip: string) => {
    setPingState(s => ({ ...s, [imsi]: 'pinging' }));
    try {
      const result = await pingUe(sessionId, ip);
      setPingState(s => ({ ...s, [imsi]: result }));
    } catch {
      setPingState(s => ({ ...s, [imsi]: 'error' }));
    }
  };

  if (entries.length === 0) return null;

  const counts = {
    starting: entries.filter(u => u.state === 'starting').length,
    registered: entries.filter(u => u.state === 'registered').length,
    session_established: entries.filter(u => u.state === 'session_established').length,
    failed: entries.filter(u => u.state === 'failed').length,
  };

  return (
    <div className="space-y-2">
      {/* Summary row */}
      <div className="flex gap-3 text-xs">
        <span className="text-nms-text-dim">Starting: <span className="text-gray-300">{counts.starting}</span></span>
        <span className="text-nms-text-dim">Registered: <span className="text-blue-400">{counts.registered}</span></span>
        <span className="text-nms-text-dim">Connected: <span className="text-green-400">{counts.session_established}</span></span>
        {counts.failed > 0 && <span className="text-nms-text-dim">Failed: <span className="text-red-400">{counts.failed}</span></span>}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-nms-border">
              <th className="text-left py-1 px-2 text-nms-text-dim font-medium">IMSI</th>
              <th className="text-left py-1 px-2 text-nms-text-dim font-medium">Node</th>
              <th className="text-left py-1 px-2 text-nms-text-dim font-medium">State</th>
              <th className="text-left py-1 px-2 text-nms-text-dim font-medium">IP</th>
              <th className="text-left py-1 px-2 text-nms-text-dim font-medium">Reachability</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(ue => {
              const ping = pingState[ue.imsi];
              return (
                <tr key={ue.imsi} className="border-b border-nms-border/50 hover:bg-nms-surface-2/50">
                  <td className="py-1 px-2 font-mono text-nms-text">{ue.imsi}</td>
                  <td className="py-1 px-2 text-nms-text-dim">{ue.nodeId}</td>
                  <td className="py-1 px-2"><StateBadge state={ue.state} /></td>
                  <td className="py-1 px-2 font-mono text-nms-text-dim">{ue.ip ?? '—'}</td>
                  <td className="py-1 px-2">
                    {ue.state !== 'session_established' || !ue.ip ? (
                      <span className="text-nms-text-dim">—</span>
                    ) : ping === 'pinging' ? (
                      <span className="inline-flex items-center gap-1 text-nms-text-dim"><Loader className="w-3 h-3 animate-spin" /> Pinging…</span>
                    ) : ping === 'error' ? (
                      <span className="text-red-400">Check failed</span>
                    ) : ping ? (
                      <span className={ping.reachable ? 'text-green-400' : 'text-red-400'}>
                        {ping.reachable ? `Reachable (${ping.avgRttMs ?? '?'}ms)` : `Unreachable (${ping.lossPct}% loss)`}
                      </span>
                    ) : (
                      <button
                        onClick={() => handlePing(ue.imsi, ue.ip!)}
                        className="nms-btn-ghost text-[10px] px-1.5 py-0.5"
                      >
                        Verify
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Number stepper ──────────────────────────────────────────────────────────

function NumInput({ label, value, onChange, min = 1, max = 50, hint }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-nms-text-dim mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          className="w-7 h-7 rounded border border-nms-border text-nms-text-dim hover:text-nms-text hover:border-nms-accent/50 transition-colors flex items-center justify-center text-sm"
        >−</button>
        <input
          type="number" min={min} max={max} value={value}
          onChange={e => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
          className="w-16 text-center bg-nms-surface border border-nms-border rounded px-2 py-1 text-sm text-nms-text"
        />
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          className="w-7 h-7 rounded border border-nms-border text-nms-text-dim hover:text-nms-text hover:border-nms-accent/50 transition-colors flex items-center justify-center text-sm"
        >+</button>
      </div>
      {hint && <div className="text-[10px] text-nms-text-dim mt-1">{hint}</div>}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export function ValidationPage() {
  const [inferredCfg, setInferredCfg] = useState<InferredConfig | null>(null);
  const [inferring, setInferring] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [starting, setStarting] = useState(false);
  const [capacity, setCapacity] = useState<HostCapacity | null>(null);

  useEffect(() => { getCapacity().then(setCapacity).catch(() => {}); }, []);

  // 5G params
  const [enable5G, setEnable5G] = useState(true);
  const [gnbCount, setGnbCount] = useState(1);
  const [gnbUeCount, setGnbUeCount] = useState(5);
  const [show5gAdvanced, setShow5gAdvanced] = useState(false);
  const [sst, setSst] = useState(1);
  const [sd, setSd] = useState('');
  const [dnn, setDnn] = useState('');
  const [amfIp, setAmfIp] = useState('');
  const [upfIp, setUpfIp] = useState('');

  // 4G params
  const [enable4G, setEnable4G] = useState(false);
  const [enbCount, setEnbCount] = useState(1);
  const [enbUeCount, setEnbUeCount] = useState(3);
  const [show4gAdvanced, setShow4gAdvanced] = useState(false);
  const [apn, setApn] = useState('');

  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // Start polling /status/:id every second for a session until it reaches a terminal state.
  // Can be called both from handleStart (new session) and on mount (rehydrating existing sessions).
  const startPolling = useCallback((sessionId: string) => {
    if (pollRefs.current[sessionId]) return; // already polling
    const timer = setInterval(async () => {
      const s = await fetchSessionStatus(sessionId);
      if (!s) {
        // Session gone from backend (restart) — remove from UI
        clearInterval(timer);
        delete pollRefs.current[sessionId];
        setSessions(prev => prev.filter(x => x.id !== sessionId));
        return;
      }
      setSessions(prev => {
        const idx = prev.findIndex(x => x.id === sessionId);
        if (idx === -1) return [...prev, s];
        const next = [...prev];
        next[idx] = { ...next[idx], ...s };
        return next;
      });
      if (s.status === 'failed' || s.status === 'stopped') {
        clearInterval(timer);
        delete pollRefs.current[sessionId];
      }
    }, 1000);
    pollRefs.current[sessionId] = timer;
    setTimeout(() => { clearInterval(timer); delete pollRefs.current[sessionId]; }, 600_000);
  }, []);

  // On mount: load inferred config + rehydrate any in-progress sessions from the backend
  useEffect(() => {
    handleInfer();
    getSessions().then(existing => {
      if (existing.length > 0) {
        setSessions(existing);
        existing
          .filter(s => s.status !== 'stopped' && s.status !== 'failed')
          .forEach(s => startPolling(s.id));
      }
    }).catch(() => {});
    return () => { Object.values(pollRefs.current).forEach(clearInterval); };
  }, []);

  const handleInfer = useCallback(async () => {
    setInferring(true);
    try {
      const cfg = await inferConfig();
      setInferredCfg(cfg);
      // Pre-fill from inferred config
      if (cfg.slices[0]) {
        setSst(cfg.slices[0].sst);
        setSd(cfg.slices[0].sd ?? '');
      }
      if (cfg.dnns[0]) setDnn(cfg.dnns[0]);
      if (cfg.apns[0]) setApn(cfg.apns[0]);
      if (cfg.amfIp) setAmfIp(cfg.amfIp);
      if (cfg.upfIp) setUpfIp(cfg.upfIp);
    } catch (e) {
      toast.error(`Config inference failed: ${e}`);
    } finally {
      setInferring(false);
    }
  }, []);

  const handleStart = useCallback(async () => {
    if (!enable5G && !enable4G) {
      toast.error('Enable at least one test type (5G or 4G)');
      return;
    }
    setStarting(true);
    let sessionId: string;
    try {
      ({ sessionId } = await startSession({
        enable5G, enable4G,
        gnbCount, gnbUeCount,
        enbCount, enbUeCount,
        sliceOverride: enable5G ? { sst, sd: sd || undefined } : undefined,
        dnnOverride: dnn || undefined,
        apnOverride: apn || undefined,
        amfIpOverride: amfIp || undefined,
        upfIpOverride: upfIp || undefined,
      }));
    } catch (e) {
      toast.error(`Failed to start: ${e}`);
      setStarting(false);
      return;
    }
    setStarting(false);

    // Immediately show the session card so the user sees it right away
    setSessions(prev => [...prev, {
      id: sessionId,
      startedAt: new Date().toISOString(),
      status: 'provisioning',
      imsiCount: 0,
      containerCount: 0,
      ueStatuses: {},
      logs: ['Provisioning started…'],
    }]);

    startPolling(sessionId);
  }, [enable5G, enable4G, gnbCount, gnbUeCount, enbCount, enbUeCount, sst, sd, dnn, apn, amfIp, upfIp, startPolling]);

  const handleStop = useCallback(async (id: string) => {
    try {
      await stopSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
      toast.success('Session stopped and cleaned up');
    } catch (e) {
      toast.error(`Stop failed: ${e}`);
    }
  }, []);

  const handleStopAll = useCallback(async () => {
    try {
      await stopAll();
      setSessions([]);
      toast.success('All sessions stopped');
    } catch (e) {
      toast.error(`Stop all failed: ${e}`);
    }
  }, []);

  const handleForceCleanup = useCallback(async () => {
    try {
      const results = await forceCleanup();
      setSessions([]);
      Object.values(pollRefs.current).forEach(clearInterval);
      pollRefs.current = {};
      toast.success(`Force cleanup done: ${results[results.length - 1] ?? 'complete'}`);
    } catch (e) {
      toast.error(`Force cleanup failed: ${e}`);
    }
  }, []);

  const activeSessions = sessions.filter(s => s.status !== 'stopped');
  const totalUes = (enable5G ? gnbCount * gnbUeCount : 0) + (enable4G ? enbCount * enbUeCount : 0);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-display font-bold text-nms-text">UE/Core Validation</h1>
          <p className="text-sm text-nms-text-dim mt-0.5">
            Simulate UE attach using UERANSIM (5G) and srsRAN (4G) — configs inferred from your Open5GS deployment
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleInfer}
            disabled={inferring}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border border-nms-border rounded hover:border-nms-accent/50 text-nms-text-dim hover:text-nms-text transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${inferring ? 'animate-spin' : ''}`} />
            Re-read Config
          </button>
          <button
            onClick={handleStopAll}
            className="flex items-center gap-2 px-3 py-1.5 text-sm border border-red-500/40 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <Square className="w-3.5 h-3.5" /> Stop All
          </button>
          <button
            onClick={handleForceCleanup}
            title="Force-delete all VAL-TEST-* subscribers and ue-val-* containers, even after a backend restart"
            className="flex items-center gap-2 px-3 py-1.5 text-sm border border-red-700/50 rounded bg-red-900/20 text-red-500 hover:bg-red-900/40 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Force Cleanup
          </button>
        </div>
      </div>

      {/* Resource warning */}
      <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 text-sm text-amber-400">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          Running a UE simulation is <strong>very resource-intensive</strong> (real-time DSP for 4G, concurrent
          radio processes for 5G) and can cause the GUI to lag while a session is starting or under load.
          Please be patient — status and log updates may take a few seconds to catch up.
        </div>
      </div>

      <SwuEmulatorCard />

      <VolteTestCard />

      <VowifiTestCard />

      {/* Inferred config pills */}
      {inferredCfg && (
        <div className="flex flex-wrap gap-2">
          {[
            { label: 'PLMN', value: `${inferredCfg.plmn.mcc}-${inferredCfg.plmn.mnc}` },
            { label: 'AMF', value: inferredCfg.amfIp },
            { label: 'MME', value: inferredCfg.mmeIp },
            { label: 'TAC 5G', value: String(inferredCfg.tac5g) },
            { label: 'TAC 4G', value: String(inferredCfg.tac4g) },
            ...inferredCfg.slices.map((s, i) => ({
              label: `Slice${inferredCfg.slices.length > 1 ? i + 1 : ''}`,
              value: s.sd ? `SST:${s.sst} SD:${s.sd}` : `SST:${s.sst}`,
            })),
            { label: 'DNN', value: inferredCfg.dnns.join(', ') },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center gap-1.5 text-xs bg-nms-surface border border-nms-border rounded px-2 py-1">
              <span className="text-nms-text-dim">{label}:</span>
              <span className="text-nms-text font-mono">{value}</span>
            </div>
          ))}
          {inferredCfg.subnets.map(s => (
            <div key={s.dnn} className="flex items-center gap-1.5 text-xs bg-green-500/10 border border-green-500/20 rounded px-2 py-1">
              <span className="text-nms-text-dim">Pool ({s.dnn}):</span>
              <span className="text-green-400 font-mono">{s.cidr}</span>
            </div>
          ))}
        </div>
      )}

      {/* Config panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* 5G Panel */}
        <div className={`border rounded-lg overflow-hidden transition-colors ${enable5G ? 'border-nms-accent/30 bg-nms-accent/5' : 'border-nms-border bg-nms-surface'}`}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-nms-border/50">
            <div className="flex items-center gap-2">
              <Wifi className="w-4 h-4 text-nms-accent" />
              <span className="font-semibold text-nms-text">5G NR</span>
              <span className="text-[10px] text-nms-text-dim bg-nms-surface border border-nms-border px-1.5 py-0.5 rounded">UERANSIM</span>
            </div>
            <button
              onClick={() => setEnable5G(v => !v)}
              className={`relative w-9 h-5 rounded-full transition-colors ${enable5G ? 'bg-nms-accent' : 'bg-nms-surface-2 border border-nms-border'}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enable5G ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <div className={`px-4 py-4 space-y-4 ${!enable5G ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex gap-8">
              <NumInput label="gNodeBs" value={gnbCount} onChange={setGnbCount} min={1} max={20}
                hint={capacity && gnbCount > capacity.recommended5G.gnb
                  ? `This host detected ${capacity.cores} cores — more than ~${capacity.recommended5G.gnb} gNBs may not run reliably`
                  : undefined} />
              <NumInput label="UEs per gNB" value={gnbUeCount} onChange={setGnbUeCount} min={1} max={50}
                hint={`${gnbCount * gnbUeCount} total UEs`} />
            </div>

            <DistributionViz nodeCount={gnbCount} ueTotal={gnbCount * gnbUeCount} label="gNB" />

            <button
              onClick={() => setShow5gAdvanced(v => !v)}
              className="flex items-center gap-1 text-xs text-nms-text-dim hover:text-nms-text transition-colors"
            >
              {show5gAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Advanced settings
            </button>

            {show5gAdvanced && (
              <div className="space-y-3 border-t border-nms-border/50 pt-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-nms-text-dim mb-1">SST</label>
                    <input
                      type="number" value={sst} onChange={e => setSst(Number(e.target.value))} min={0} max={255}
                      className="w-full bg-nms-surface border border-nms-border rounded px-2 py-1 text-sm text-nms-text"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-nms-text-dim mb-1">SD (hex, optional)</label>
                    <input
                      type="text" value={sd} onChange={e => setSd(e.target.value)} placeholder="000000"
                      className="w-full bg-nms-surface border border-nms-border rounded px-2 py-1 text-sm text-nms-text font-mono"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-nms-text-dim mb-1">DNN</label>
                  <input
                    type="text" value={dnn} onChange={e => setDnn(e.target.value)} placeholder="internet"
                    className="w-full bg-nms-surface border border-nms-border rounded px-2 py-1 text-sm text-nms-text"
                  />
                </div>
                {inferredCfg && inferredCfg.dnns.length > 1 && (
                  <div className="flex gap-1 flex-wrap">
                    {inferredCfg.dnns.map(d => (
                      <button key={d} onClick={() => setDnn(d)}
                        className="text-[10px] px-1.5 py-0.5 border border-nms-border rounded hover:border-nms-accent/50 text-nms-text-dim">
                        {d}
                      </button>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3 border-t border-nms-border/30 pt-3">
                  <div>
                    <label className="block text-xs text-nms-text-dim mb-1">AMF IP <span className="text-nms-text-dim/50">(NGAP)</span></label>
                    <input
                      type="text" value={amfIp} onChange={e => setAmfIp(e.target.value)}
                      placeholder={inferredCfg?.amfIp ?? '10.0.0.1'}
                      className="w-full bg-nms-surface border border-nms-border rounded px-2 py-1 text-sm text-nms-text font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-nms-text-dim mb-1">UPF IP <span className="text-nms-text-dim/50">(GTP-U)</span></label>
                    <input
                      type="text" value={upfIp} onChange={e => setUpfIp(e.target.value)}
                      placeholder={inferredCfg?.upfIp ?? '10.0.0.2'}
                      className="w-full bg-nms-surface border border-nms-border rounded px-2 py-1 text-sm text-nms-text font-mono"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-nms-text-dim">
                  AMF must be reachable via SCTP. UPF GTP-U port 2152 must not conflict with open5gs-smfd.
                  Values are inferred from amf.yaml / upf.yaml automatically.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 4G Panel */}
        <div className={`border rounded-lg overflow-hidden transition-colors ${enable4G ? 'border-amber-500/30 bg-amber-500/5' : 'border-nms-border bg-nms-surface'}`}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-nms-border/50">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-amber-400" />
              <span className="font-semibold text-nms-text">4G LTE</span>
              <span className="text-[10px] text-nms-text-dim bg-nms-surface border border-nms-border px-1.5 py-0.5 rounded">srsRAN</span>
            </div>
            <button
              onClick={() => setEnable4G(v => !v)}
              className={`relative w-9 h-5 rounded-full transition-colors ${enable4G ? 'bg-amber-500' : 'bg-nms-surface-2 border border-nms-border'}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enable4G ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </button>
          </div>

          <div className={`px-4 py-4 space-y-4 ${!enable4G ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex gap-8">
              <NumInput label="eNodeBs" value={enbCount} onChange={setEnbCount} min={1} max={10} />
              <NumInput label="UEs per eNB" value={enbUeCount} onChange={setEnbUeCount} min={1} max={10}
                hint={capacity && enbCount * enbUeCount > capacity.recommended4G.enb
                  ? `${enbCount * enbUeCount} total UEs — this host detected ${capacity.cores} cores; more than ~${capacity.recommended4G.enb} concurrent 4G radios (real-time DSP) may not run reliably`
                  : `${enbCount * enbUeCount} total UEs`} />
            </div>

            <DistributionViz nodeCount={enbCount} ueTotal={enbCount * enbUeCount} label="eNB" />

            <button
              onClick={() => setShow4gAdvanced(v => !v)}
              className="flex items-center gap-1 text-xs text-nms-text-dim hover:text-nms-text transition-colors"
            >
              {show4gAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Advanced settings
            </button>

            {show4gAdvanced && (
              <div className="space-y-3 border-t border-nms-border/50 pt-3">
                <div>
                  <label className="block text-xs text-nms-text-dim mb-1">APN</label>
                  <input
                    type="text" value={apn} onChange={e => setApn(e.target.value)} placeholder="internet"
                    className="w-full bg-nms-surface border border-nms-border rounded px-2 py-1 text-sm text-nms-text"
                  />
                </div>
                {inferredCfg && inferredCfg.apns.length > 1 && (
                  <div className="flex gap-1 flex-wrap">
                    {inferredCfg.apns.map(a => (
                      <button key={a} onClick={() => setApn(a)}
                        className="text-[10px] px-1.5 py-0.5 border border-nms-border rounded hover:border-amber-500/50 text-nms-text-dim">
                        {a}
                      </button>
                    ))}
                  </div>
                )}
                <div className="bg-amber-500/10 border border-amber-500/20 rounded p-2 text-xs text-amber-400">
                  4G uses ZeroMQ virtual RF — no SDR hardware needed.
                  Requires <code className="font-mono">gradiant/srslte:22.04</code> Docker image.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary + launch */}
      <div className="flex items-center justify-between bg-nms-surface border border-nms-border rounded-lg px-4 py-3">
        <div className="text-sm text-nms-text-dim">
          {totalUes > 0
            ? <>Will provision <span className="text-nms-text font-semibold">{totalUes} test UEs</span> with PLMN <span className="font-mono text-nms-accent">999-70</span> and insert into MongoDB</>
            : 'Enable at least one test type above'}
        </div>
        <button
          onClick={handleStart}
          disabled={starting || totalUes === 0}
          className="flex items-center gap-2 px-4 py-2 bg-nms-accent hover:bg-nms-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded transition-colors"
        >
          {starting ? <Loader className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {starting ? 'Launching…' : 'Start Test'}
        </button>
      </div>

      {/* Sessions — active and failed */}
      {activeSessions.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-nms-text">
            Sessions
            {activeSessions.some(s => s.status === 'failed') && (
              <span className="ml-2 text-red-400 font-normal text-xs">— see log below for errors</span>
            )}
          </h2>
          {activeSessions.map(session => (
            <SessionCard key={session.id} session={session} onStop={() => handleStop(session.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Raw log pane ─────────────────────────────────────────────────────────────

function RawLogPane({ lines, label }: { lines: string[]; label: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines.length]);

  const color = (line: string) => {
    if (/error|failed|denied|barred|reject/i.test(line)) return 'text-red-400';
    if (/warn|warning/i.test(line)) return 'text-amber-400';
    if (/registered|established|success|connected|NGAP|NG Setup/i.test(line)) return 'text-green-400';
    return 'text-gray-300';
  };

  return (
    <div>
      <div className="text-xs font-semibold text-nms-text-dim mb-1 uppercase tracking-wider">{label}</div>
      <div className="bg-black border border-nms-border rounded font-mono text-[11px] p-2 h-48 overflow-y-auto space-y-0.5">
        {lines.length === 0
          ? <div className="text-nms-text-dim italic">No output yet…</div>
          : lines.map((line, i) => (
            <div key={i} className={color(line)}>{line}</div>
          ))
        }
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Session card ─────────────────────────────────────────────────────────────

type RawTab = 'gnb' | 'enb' | 'ue5g' | 'ue4g';
const RAW_TAB_LABELS: Record<RawTab, string> = { gnb: 'gNodeB', enb: 'eNodeB', ue5g: '5G UE', ue4g: '4G UE' };

function SessionCard({ session, onStop }: { session: SessionSummary; onStop: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const [rawTab, setRawTab] = useState<RawTab>('gnb');
  const [rawLogs, setRawLogs] = useState<RawLogs>({ gnb: [], enb: [], ue5g: [], ue4g: [] });

  // Poll raw log files while session is active
  useEffect(() => {
    if (session.status === 'stopped') return;
    const fetch_ = () => fetchRawLogs(session.id).then(setRawLogs).catch(() => {});
    fetch_();
    const t = setInterval(fetch_, 2000);
    return () => clearInterval(t);
  }, [session.id, session.status]);

  const statusColor: Record<string, string> = {
    provisioning: 'text-amber-400',
    running:      'text-green-400',
    stopping:     'text-amber-400',
    failed:       'text-red-400',
  };

  const ueList = Object.values(session.ueStatuses ?? {});
  const has5G = ueList.some(u => u.type === '5g');
  const has4G = ueList.some(u => u.type === '4g');
  const hasRaw = rawLogs.gnb.length > 0 || rawLogs.enb.length > 0 || rawLogs.ue5g.length > 0 || rawLogs.ue4g.length > 0;

  const rawTabs: RawTab[] = [
    ...(has5G ? (['gnb', 'ue5g'] as const) : []),
    ...(has4G ? (['enb', 'ue4g'] as const) : []),
  ];
  const activeRawTab = rawTabs.includes(rawTab) ? rawTab : (rawTabs[0] ?? 'gnb');

  return (
    <div className="border border-nms-border rounded-lg overflow-hidden bg-nms-surface">
      <div className="flex items-center justify-between px-4 py-3 border-b border-nms-border/50">
        <div className="flex items-center gap-3">
          {session.status === 'provisioning' || session.status === 'stopping'
            ? <Loader className="w-4 h-4 animate-spin text-amber-400" />
            : session.status === 'failed'
            ? <AlertTriangle className="w-4 h-4 text-red-400" />
            : <Network className="w-4 h-4 text-green-400" />
          }
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-nms-text">{session.id}</span>
              <span className={`text-xs font-semibold uppercase ${statusColor[session.status] ?? 'text-nms-text-dim'}`}>
                {session.status}
              </span>
            </div>
            <div className="text-xs text-nms-text-dim">
              {session.imsiCount} UEs · Started {new Date(session.startedAt).toLocaleTimeString()}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setExpanded(v => !v)}
            className="p-1 text-nms-text-dim hover:text-nms-text transition-colors">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button onClick={onStop}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-500/40 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
            <Square className="w-3 h-3" /> Stop & Clean Up
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 py-4 space-y-4">
          {/* Provisioning step log */}
          <div>
            <div className="text-xs font-semibold text-nms-text-dim mb-1 uppercase tracking-wider">Provisioning Log</div>
            <div className="bg-black/40 border border-nms-border rounded font-mono text-[11px] p-2 max-h-48 overflow-y-auto space-y-0.5">
              {(session.logs ?? []).length === 0 ? (
                <div className="text-nms-text-dim italic">Waiting for output…</div>
              ) : (session.logs ?? []).map((line, i) => (
                <div key={i} className={
                  /FATAL|Error|error|failed|Failed/.test(line) ? 'text-red-400'
                  : /WARN|warn/.test(line) ? 'text-amber-400'
                  : 'text-green-400'
                }>
                  {line}
                </div>
              ))}
            </div>
          </div>

          {session.error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded p-3 text-xs text-red-400 font-mono">
              {session.error}
            </div>
          )}

          {/* Raw UERANSIM / srsRAN output — one tab per node/radio type */}
          {(session.status === 'running' || session.status === 'failed' || hasRaw) && rawTabs.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-2">
                <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mr-2">Radio Node Output</div>
                {rawTabs.map(tab => (
                  <button
                    key={tab}
                    onClick={() => setRawTab(tab)}
                    className={`px-2.5 py-0.5 text-xs rounded border transition-colors ${
                      activeRawTab === tab
                        ? 'bg-nms-accent/20 border-nms-accent/40 text-nms-accent'
                        : 'border-nms-border text-nms-text-dim hover:text-nms-text'
                    }`}
                  >
                    {RAW_TAB_LABELS[tab]}
                    {rawLogs[tab].length > 0 && (
                      <span className="ml-1 text-[9px] opacity-60">({rawLogs[tab].length})</span>
                    )}
                  </button>
                ))}
              </div>
              <RawLogPane
                lines={rawLogs[activeRawTab]}
                label={`${RAW_TAB_LABELS[activeRawTab]} raw output`}
              />
            </div>
          )}

          {has5G && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Wifi className="w-3.5 h-3.5 text-nms-accent" />
                <span className="text-xs font-semibold text-nms-text">5G NR UEs</span>
              </div>
              <UeTable statuses={session.ueStatuses} filter="5g" sessionId={session.id} />
            </div>
          )}
          {has4G && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Radio className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs font-semibold text-nms-text">4G LTE UEs</span>
              </div>
              <UeTable statuses={session.ueStatuses} filter="4g" sessionId={session.id} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
