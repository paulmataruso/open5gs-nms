import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Gauge, CheckCircle, XCircle, AlertCircle, RefreshCw, Terminal, Trash2,
  Plus, Play, Clock, Network, Server, Settings, RotateCw, ListTree, Users, Activity,
  History, TrendingUp, ExternalLink,
} from 'lucide-react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { twampApi } from '../api/twamp';
import type {
  TwampStatus, TwampTarget, TwampTargetInput, TwampMode, TwampProtocol, TwampServerStatus,
  TwampServerConnection, TwampMetricSample, TwampHistorySummaryRow, TwampHistorySeriesPoint,
} from '../api/twamp';
import { TimeRangePicker, type TimeRangeValue } from '../components/common/TimeRangePicker';

function LogTerminal({ lines }: { lines: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-48 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-2">
      {lines}
    </pre>
  );
}

function fmtMs(v: number | undefined): string {
  return v === undefined ? '—' : `${v.toFixed(2)} ms`;
}

const emptyForm: TwampTargetInput = {
  name: '', host: '', port: 862, protocol: 'full', mode: 'unauthenticated',
  sharedSecret: '', keyId: '', packetCount: 10, bindIp: '', pollIntervalSeconds: 60, enabled: true,
};

function TargetFormModal({ initial, onClose, onSaved }: {
  initial?: TwampTarget; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<TwampTargetInput>(initial ? {
    name: initial.name, host: initial.host, port: initial.port, protocol: initial.protocol, mode: initial.mode,
    sharedSecret: initial.sharedSecret ?? '', keyId: initial.keyId ?? '',
    packetCount: initial.packetCount, bindIp: initial.bindIp ?? '',
    pollIntervalSeconds: initial.pollIntervalSeconds, enabled: initial.enabled,
  } : emptyForm);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!form.name || !form.host) {
      toast.error('Name and host are required');
      return;
    }
    setSaving(true);
    try {
      if (initial) {
        await twampApi.updateTarget(initial._id, form);
        toast.success('Target updated');
      } else {
        await twampApi.createTarget(form);
        toast.success('Target added');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl">
        <h2 className="text-base font-semibold text-nms-text mb-4">{initial ? 'Edit' : 'Add'} TWAMP Target</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div className="md:col-span-2">
            <label className="nms-label">Name</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Nokia AirScale — 10.0.2.214" className="nms-input text-xs mt-1" />
          </div>
          <div>
            <label className="nms-label flex items-center gap-1.5"><Network className="w-3 h-3" /> Host</label>
            <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
              placeholder="10.0.2.214" className="nms-input font-mono text-xs mt-1" />
          </div>
          <div>
            <label className="nms-label">Port</label>
            <input type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: parseInt(e.target.value, 10) || 862 }))}
              placeholder="862" className="nms-input font-mono text-xs mt-1" />
          </div>
          <div>
            <label className="nms-label">Protocol</label>
            <select value={form.protocol} onChange={e => setForm(f => ({ ...f, protocol: e.target.value as TwampProtocol }))}
              className="nms-input text-xs mt-1">
              <option value="full">Full TWAMP-Control (TCP + UDP)</option>
              <option value="light">TWAMP-Light (UDP only, no handshake)</option>
            </select>
            <p className="text-xs text-nms-text-dim mt-1">
              Most real hardware reflectors (confirmed on a Nokia AirScale) only speak TWAMP-Light — try that first if Full doesn't connect.
            </p>
          </div>
          {form.protocol === 'full' && (
            <div>
              <label className="nms-label">Mode</label>
              <select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value as TwampMode }))}
                className="nms-input text-xs mt-1">
                <option value="unauthenticated">Unauthenticated</option>
                <option value="authenticated">Authenticated</option>
                <option value="encrypted">Encrypted</option>
              </select>
            </div>
          )}
          {form.protocol === 'full' && form.mode !== 'unauthenticated' && (
            <>
              <div>
                <label className="nms-label">Key ID</label>
                <input value={form.keyId} onChange={e => setForm(f => ({ ...f, keyId: e.target.value }))}
                  className="nms-input font-mono text-xs mt-1" />
              </div>
              <div>
                <label className="nms-label">Shared secret</label>
                <input type="password" value={form.sharedSecret} onChange={e => setForm(f => ({ ...f, sharedSecret: e.target.value }))}
                  className="nms-input font-mono text-xs mt-1" />
              </div>
            </>
          )}
          <div>
            <label className="nms-label">Packets per test</label>
            <input type="number" value={form.packetCount} onChange={e => setForm(f => ({ ...f, packetCount: parseInt(e.target.value, 10) || 10 }))}
              className="nms-input font-mono text-xs mt-1" />
          </div>
          <div>
            <label className="nms-label flex items-center gap-1.5"><Network className="w-3 h-3" /> Bind IP <span className="text-nms-text-dim font-normal">(optional)</span></label>
            <input value={form.bindIp} onChange={e => setForm(f => ({ ...f, bindIp: e.target.value }))}
              placeholder="leave blank = OS picks" className="nms-input font-mono text-xs mt-1" />
            <p className="text-xs text-nms-text-dim mt-1">This host is multi-homed — set this if the default route doesn't reach the target's subnet</p>
          </div>
          <div>
            <label className="nms-label flex items-center gap-1.5"><Clock className="w-3 h-3" /> Poll interval (s)</label>
            <input type="number" value={form.pollIntervalSeconds} onChange={e => setForm(f => ({ ...f, pollIntervalSeconds: parseInt(e.target.value, 10) || 60 }))}
              className="nms-input font-mono text-xs mt-1" />
            <p className="text-xs text-nms-text-dim mt-1">How often the background monitor re-tests this target</p>
          </div>
          <div className="md:col-span-2 flex items-center gap-2 mt-1">
            <input type="checkbox" id="twamp-enabled" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="nms-checkbox" />
            <label htmlFor="twamp-enabled" className="text-sm text-nms-text">Enable background monitoring for this target</label>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 nms-btn-ghost text-sm py-2">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="flex-1 nms-btn-primary text-sm py-2">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TargetRow({ target, onChanged }: { target: TwampTarget; onChanged: () => void }) {
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState(target.latest);

  useEffect(() => { setTestResult(target.latest); }, [target.latest]);

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await twampApi.testTarget(target._id);
      setTestResult({ ...result, targetId: target._id, name: target.name, host: target.host, timestamp: Date.now() });
      if (result.success) toast.success(`Test complete: avg RTT ${result.avgRttMs?.toFixed(2)}ms`);
      else toast.error(`Test failed: ${result.error}`);
    } catch (err: any) {
      toast.error(`Test failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setTesting(false);
    }
  };

  const handleToggle = async () => {
    try {
      await twampApi.updateTarget(target._id, { enabled: !target.enabled });
      onChanged();
    } catch (err: any) {
      toast.error(`Failed to toggle: ${err?.response?.data?.error ?? err.message}`);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Remove target "${target.name}"? This does not affect the radio's own reflector.`)) return;
    try {
      await twampApi.deleteTarget(target._id);
      toast.success('Target removed');
      onChanged();
    } catch (err: any) {
      toast.error(`Delete failed: ${err?.response?.data?.error ?? err.message}`);
    }
  };

  return (
    <>
      {editing && <TargetFormModal initial={target} onClose={() => setEditing(false)} onSaved={onChanged} />}
      <tr className="border-b border-nms-border/50 hover:bg-nms-bg/50">
        <td className="py-2.5 pr-4">
          <div className={clsx('w-2 h-2 rounded-full',
            !testResult ? 'bg-nms-text-dim/40' : testResult.success ? 'bg-green-400' : 'bg-red-400')}
            title={!testResult ? 'No test run yet' : testResult.success ? 'Last test succeeded' : testResult.error ?? 'Last test failed'}
          />
        </td>
        <td className="py-2.5 pr-4 font-medium text-nms-text whitespace-nowrap">{target.name}</td>
        <td className="py-2.5 pr-4 font-mono text-xs whitespace-nowrap">{target.host}:{target.port}</td>
        <td className="py-2.5 pr-4 whitespace-nowrap">
          {target.protocol === 'light' ? 'TWAMP-Light' : `full (${target.mode})`}
        </td>
        <td className="py-2.5 pr-4 font-mono whitespace-nowrap">
          {!testResult ? '—' : testResult.success ? fmtMs(testResult.avgRttMs) : <span className="text-red-400">failed</span>}
        </td>
        <td className="py-2.5 pr-4 font-mono whitespace-nowrap">
          {!testResult ? '—' : testResult.success ? `${testResult.packetsLost ?? 0}/${testResult.packetsSent ?? 0}` : '—'}
        </td>
        <td className="py-2.5 pr-4 whitespace-nowrap text-nms-text-dim">
          {testResult ? new Date(testResult.timestamp).toLocaleTimeString() : '—'}
        </td>
        <td className="py-2.5 pr-4 whitespace-nowrap">
          <button
            onClick={handleToggle}
            className={clsx('text-xs px-2 py-1 rounded-full', target.enabled ? 'bg-nms-accent/10 text-nms-accent' : 'bg-gray-500/10 text-gray-500')}
            title={target.enabled ? 'Background monitoring on — click to disable' : 'Background monitoring off — click to enable'}
          >
            {target.enabled ? `every ${target.pollIntervalSeconds}s` : 'off'}
          </button>
        </td>
        <td className="py-2.5 pr-4">
          <div className="flex items-center gap-1.5 justify-end">
            <button onClick={handleTest} disabled={testing} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5" title="Test Now">
              <Play className={clsx('w-3 h-3', testing && 'animate-pulse')} /> {testing ? 'Testing…' : 'Test'}
            </button>
            <button onClick={() => setEditing(true)} className="nms-btn-ghost text-xs px-2.5 py-1.5" title="Edit">
              Edit
            </button>
            <button onClick={handleDelete} className="flex items-center px-2 py-1.5 rounded-lg border text-red-400 bg-red-500/10 border-red-500/20 hover:bg-red-500/20 transition-colors" title="Delete">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}

function TargetsTable({ targets, onChanged }: { targets: TwampTarget[]; onChanged: () => void }) {
  return (
    <div className="nms-card overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-nms-text-dim border-b border-nms-border">
            <th className="py-2 pr-4 font-medium"></th>
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Host:Port</th>
            <th className="py-2 pr-4 font-medium">Protocol</th>
            <th className="py-2 pr-4 font-medium">Avg RTT</th>
            <th className="py-2 pr-4 font-medium">Loss</th>
            <th className="py-2 pr-4 font-medium">Last Tested</th>
            <th className="py-2 pr-4 font-medium">Monitoring</th>
            <th className="py-2 pr-4 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {targets.map(t => (
            <TargetRow key={t._id} target={t} onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ALL_MODES: TwampMode[] = ['unauthenticated', 'authenticated', 'encrypted'];

function ServerSection({ onInstall, installActing, installStreamLog }: {
  onInstall: () => void; installActing: boolean; installStreamLog: string;
}) {
  const [status, setStatus] = useState<TwampServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [listenIp, setListenIp] = useState('0.0.0.0');
  const [listenPort, setListenPort] = useState(862);
  const [enableFull, setEnableFull] = useState(true);
  const [enableLight, setEnableLight] = useState(true);
  const [modes, setModes] = useState<TwampMode[]>(['unauthenticated']);
  const [secretKeyId, setSecretKeyId] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [allowCidrs, setAllowCidrs] = useState('');
  const seeded = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const s = await twampApi.getServerStatus();
      setStatus(s);
      if (!seeded.current && s.currentConfig) {
        setListenIp(s.currentConfig.listenIp);
        setListenPort(s.currentConfig.listenPort);
        setEnableFull(s.currentConfig.enableFull);
        setEnableLight(s.currentConfig.enableLight);
        setModes(s.currentConfig.modes);
        setSecretKeyId(s.currentConfig.secretKeyId ?? '');
        setAllowCidrs((s.currentConfig.allowCidrs ?? []).join(', '));
        seeded.current = true;
      }
    } catch (err: any) {
      if (!silent) toast.error(`Server status fetch failed: ${err.message}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(() => load(true), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  const toggleMode = (m: TwampMode) => {
    setModes(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
  };

  const handleConfigure = async () => {
    setActing(true);
    try {
      await twampApi.configureServer({
        listenIp, listenPort, enableFull, enableLight, modes,
        secretKeyId: secretKeyId || undefined,
        secretValue: secretValue || undefined,
        allowCidrs: allowCidrs.split(',').map(s => s.trim()).filter(Boolean),
      });
      toast.success('TWAMP server configured and (re)started');
      setSecretValue('');
      await load(true);
    } catch (err: any) {
      toast.error(`Configure failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setActing(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-48 text-nms-text-dim">
      <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading reflector status…
    </div>
  );

  // The client and server binaries are built together by the same Install
  // step, but a deployment that installed BEFORE the server wrapper existed
  // only has the client on disk — check the server binary's own status here
  // rather than trusting the page-level "installed" (client-only) flag,
  // which was the actual bug behind Configure failing with "twamp-server is
  // not installed yet" while this section rendered the Configure form
  // anyway.
  if (!status?.installed) {
    return (
      <div className="nms-card border-dashed border-nms-border text-center py-10">
        <Server className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
        <p className="text-sm text-nms-text-dim">twamp-server binary not found.</p>
        <p className="text-xs text-nms-text-dim mt-1 mb-4">
          If you installed before the reflector feature shipped, twamp-client got built but twamp-server didn't — click Install to build it too (safe to re-run, reuses the existing module cache).
        </p>
        <button onClick={onInstall} disabled={installActing} className="nms-btn-primary inline-flex items-center gap-2 text-sm">
          <Terminal className="w-4 h-4" /> {installActing ? 'Installing…' : 'Install'}
        </button>
        {installStreamLog && <LogTerminal lines={installStreamLog} />}
      </div>
    );
  }

  return (
    <>
      <div className="nms-card">
        <div className="flex items-start justify-between flex-wrap gap-4 mb-4">
          <div className="flex items-center gap-3">
            {status?.serviceActive
              ? <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
              : <XCircle className="w-5 h-5 text-nms-text-dim shrink-0" />
            }
            <div>
              <p className="text-sm font-semibold">
                {status?.serviceActive ? 'Reflector running' : status?.hasSavedConfig ? 'Reflector stopped' : 'Reflector not configured'}
              </p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                A radio (or any TWAMP client) can test inbound against this host on the configured listen address — the reverse direction of the Targets above.
                Start/Stop/Restart controls are in the page header above.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label className="nms-label flex items-center gap-1.5"><Network className="w-3 h-3" /> Listen IP</label>
            <input value={listenIp} onChange={e => setListenIp(e.target.value)} placeholder="0.0.0.0"
              className="nms-input font-mono text-xs mt-1" />
            <p className="text-xs text-nms-text-dim mt-1">This host is multi-homed — use a specific IP if you only want to accept tests on one interface (e.g. the RAN-facing one)</p>
          </div>
          <div>
            <label className="nms-label">Listen port</label>
            <input type="number" value={listenPort} onChange={e => setListenPort(parseInt(e.target.value, 10) || 862)}
              className="nms-input font-mono text-xs mt-1" />
          </div>
          <div className="md:col-span-2">
            <label className="nms-label">Protocols to accept</label>
            <p className="text-xs text-nms-text-dim mt-1 mb-2">
              Both bind the same listen IP/port above — full uses TCP, TWAMP-Light uses UDP, so there's no conflict. Enable whichever variant(s) the devices testing against this host actually speak (a real Nokia AirScale only speaks TWAMP-Light).
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setEnableFull(v => !v)}
                className={clsx('flex-1 px-3 py-2 rounded-lg border text-xs transition-colors',
                  enableFull ? 'bg-nms-accent/15 text-nms-accent border-nms-accent/30' : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text')}>
                Full TWAMP-Control (TCP) {enableFull && '· on'}
              </button>
              <button type="button" onClick={() => setEnableLight(v => !v)}
                className={clsx('flex-1 px-3 py-2 rounded-lg border text-xs transition-colors',
                  enableLight ? 'bg-nms-accent/15 text-nms-accent border-nms-accent/30' : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text')}>
                TWAMP-Light (UDP) {enableLight && '· on'}
              </button>
            </div>
          </div>
          {enableFull && (
          <div className="md:col-span-2">
            <label className="nms-label">Supported modes (full TWAMP-Control only)</label>
            <div className="flex gap-2 mt-1">
              {ALL_MODES.map(m => (
                <button key={m} type="button" onClick={() => toggleMode(m)}
                  className={clsx('px-3 py-1.5 rounded-lg border text-xs capitalize transition-colors',
                    modes.includes(m) ? 'bg-nms-accent/15 text-nms-accent border-nms-accent/30' : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text')}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          )}
          {enableFull && modes.some(m => m !== 'unauthenticated') && (
            <>
              <div>
                <label className="nms-label">Key ID</label>
                <input value={secretKeyId} onChange={e => setSecretKeyId(e.target.value)} className="nms-input font-mono text-xs mt-1" />
              </div>
              <div>
                <label className="nms-label">Shared secret {status?.currentConfig?.hasSecret && <span className="text-nms-text-dim font-normal">(already set — leave blank to keep it)</span>}</label>
                <input type="password" value={secretValue} onChange={e => setSecretValue(e.target.value)} className="nms-input font-mono text-xs mt-1" />
              </div>
            </>
          )}
          {enableFull && (
          <div className="md:col-span-2">
            <label className="nms-label">Allowed test-receiver CIDRs (full protocol only) <span className="text-nms-text-dim font-normal">(optional)</span></label>
            <input value={allowCidrs} onChange={e => setAllowCidrs(e.target.value)} placeholder="10.0.2.0/24, 172.16.0.0/16"
              className="nms-input font-mono text-xs mt-1" />
            <p className="text-xs text-nms-text-dim mt-1">Restricts which source networks may run unauthenticated tests against this reflector — leave blank for the library's own default</p>
          </div>
          )}
        </div>
        <button onClick={handleConfigure} disabled={acting || (enableFull && modes.length === 0)} className="nms-btn-primary flex items-center gap-2 text-sm">
          <Settings className="w-4 h-4" /> {acting ? 'Configuring…' : 'Configure'}
        </button>
      </div>
    </>
  );
}

function fmtVal(v: number | undefined, digits = 2): string {
  return v === undefined ? '—' : v.toFixed(digits);
}

// Full-detail table — every field on every configured target, plus its full
// latest-result breakdown. The card view above is at-a-glance; this is the
// "show me everything" verbose view.
function TargetsInfoTable({ targets }: { targets: TwampTarget[] }) {
  if (targets.length === 0) {
    return <p className="text-sm text-nms-text-dim py-4 text-center">No targets configured.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-nms-text-dim border-b border-nms-border">
            {['Name', 'Host:Port', 'Protocol', 'Mode', 'Bind IP', 'Packets', 'Poll (s)', 'Monitoring', 'Last Test', 'Result',
              'Avg RTT', 'Min RTT', 'Max RTT', 'Jitter', 'Sent', 'Recv', 'Lost', 'Fwd Delay', 'Rev Delay', 'Asymmetry'].map(h => (
              <th key={h} className="py-2 pr-4 font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {targets.map(t => {
            const r = t.latest;
            return (
              <tr key={t._id} className="border-b border-nms-border/50 hover:bg-nms-bg/50">
                <td className="py-2 pr-4 font-medium text-nms-text whitespace-nowrap">{t.name}</td>
                <td className="py-2 pr-4 font-mono whitespace-nowrap">{t.host}:{t.port}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{t.protocol === 'light' ? 'TWAMP-Light' : 'full'}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{t.protocol === 'light' ? '—' : t.mode}</td>
                <td className="py-2 pr-4 font-mono whitespace-nowrap">{t.bindIp || '—'}</td>
                <td className="py-2 pr-4">{t.packetCount}</td>
                <td className="py-2 pr-4">{t.pollIntervalSeconds}</td>
                <td className="py-2 pr-4">{t.enabled ? <span className="text-nms-accent">on</span> : <span className="text-nms-text-dim">off</span>}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{r ? new Date(r.timestamp).toLocaleTimeString() : '—'}</td>
                <td className="py-2 pr-4">
                  {!r ? '—' : r.success
                    ? <span className="text-green-400">success</span>
                    : <span className="text-red-400" title={r.error}>failed</span>}
                </td>
                <td className="py-2 pr-4 font-mono">{fmtVal(r?.avgRttMs)}</td>
                <td className="py-2 pr-4 font-mono">{fmtVal(r?.minRttMs)}</td>
                <td className="py-2 pr-4 font-mono">{fmtVal(r?.maxRttMs)}</td>
                <td className="py-2 pr-4 font-mono">{fmtVal(r?.jitterMs)}</td>
                <td className="py-2 pr-4 font-mono">{r?.packetsSent ?? '—'}</td>
                <td className="py-2 pr-4 font-mono">{r?.packetsReceived ?? '—'}</td>
                <td className="py-2 pr-4 font-mono">{r?.packetsLost ?? '—'}</td>
                <td className="py-2 pr-4 font-mono">{fmtVal(r?.avgForwardDelayMs)}</td>
                <td className="py-2 pr-4 font-mono">{fmtVal(r?.avgReverseDelayMs)}</td>
                <td className="py-2 pr-4 font-mono">{fmtVal(r?.delayAsymmetryMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ServerConnectionsTable() {
  const [connections, setConnections] = useState<TwampServerConnection[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setConnections(await twampApi.getServerConnections());
    } catch {
      setConnections([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(() => load(true), 5_000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading) return <p className="text-sm text-nms-text-dim py-4 text-center">Loading connections…</p>;
  if (!connections || connections.length === 0) {
    return <p className="text-sm text-nms-text-dim py-4 text-center">No clients currently connected (or the reflector isn't configured/running).</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-nms-text-dim border-b border-nms-border">
            <th className="py-2 pr-4 font-medium">Peer IP</th>
            <th className="py-2 pr-4 font-medium">Peer Port</th>
            <th className="py-2 pr-4 font-medium">Protocol</th>
            <th className="py-2 pr-4 font-medium">Local Address</th>
            <th className="py-2 pr-4 font-medium">Packets</th>
            <th className="py-2 pr-4 font-medium">Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {connections.map((c, i) => (
            <tr key={i} className="border-b border-nms-border/50 hover:bg-nms-bg/50">
              <td className="py-2 pr-4 font-mono">{c.peerIp}</td>
              <td className="py-2 pr-4 font-mono">{c.peerPort}</td>
              <td className="py-2 pr-4">
                <span className={clsx('px-1.5 py-0.5 rounded font-mono text-[10px] border',
                  c.protocol === 'light' ? 'text-nms-accent bg-nms-accent/10 border-nms-accent/30' : 'text-nms-text-dim bg-nms-surface-2 border-nms-border')}>
                  {c.protocol === 'light' ? 'TWAMP-Light (UDP)' : 'Full (TCP)'}
                </span>
              </td>
              <td className="py-2 pr-4 font-mono">{c.localAddr || '—'}</td>
              <td className="py-2 pr-4 font-mono">{c.packetCount ?? '—'}</td>
              <td className="py-2 pr-4 font-mono">{c.lastSeenMs ? `${Math.max(0, Math.round((Date.now() - c.lastSeenMs) / 1000))}s ago` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServerMetricsTable() {
  const [result, setResult] = useState<{ available: boolean; data: TwampMetricSample[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setResult(await twampApi.getServerMetrics());
    } catch {
      setResult({ available: false, data: [] });
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(() => load(true), 10_000);
    return () => clearInterval(iv);
  }, [load]);

  if (loading) return <p className="text-sm text-nms-text-dim py-4 text-center">Loading reflector metrics…</p>;
  if (!result?.available || result.data.length === 0) {
    return <p className="text-sm text-nms-text-dim py-4 text-center">No metrics available — the reflector may not be running, or hasn't handled any sessions yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-nms-text-dim border-b border-nms-border">
            <th className="py-2 pr-4 font-medium">Metric</th>
            <th className="py-2 pr-4 font-medium">Labels</th>
            <th className="py-2 pr-4 font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {result.data.map((m, i) => (
            <tr key={i} className="border-b border-nms-border/50 hover:bg-nms-bg/50">
              <td className="py-2 pr-4 font-mono text-nms-text">{m.metric}</td>
              <td className="py-2 pr-4 font-mono text-nms-text-dim">
                {Object.entries(m.labels).map(([k, v]) => `${k}="${v}"`).join(', ') || '—'}
              </td>
              <td className="py-2 pr-4 font-mono">{m.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InfoStatsSection({ targets }: { targets: TwampTarget[] }) {
  return (
    <div className="space-y-6">
      <div className="nms-card">
        <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
          <ListTree className="w-4 h-4 text-nms-accent" /> Targets — Full Detail
        </h2>
        <p className="text-xs text-nms-text-dim mb-4">Every configured target and the full breakdown of its most recent test result.</p>
        <TargetsInfoTable targets={targets} />
      </div>

      <div className="nms-card">
        <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
          <Users className="w-4 h-4 text-nms-accent" /> Reflector — Connected Clients
        </h2>
        <p className="text-xs text-nms-text-dim mb-4">Real TCP peers currently connected to the reflector's TWAMP-Control port (refreshes every 5s).</p>
        <ServerConnectionsTable />
      </div>

      <div className="nms-card">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
            <Activity className="w-4 h-4 text-nms-accent" /> Reflector — Raw Metrics
          </h2>
          <a
            href={`http://${window.location.hostname}:${import.meta.env.VITE_GRAFANA_PORT || '3000'}`}
            target="_blank"
            rel="noopener noreferrer"
            className="nms-btn-ghost flex items-center gap-1.5 text-xs px-2.5 py-1.5 text-nms-accent border-nms-accent/30 hover:border-nms-accent/60 shrink-0"
            title="These same series (twamp_light_active_peers, twamp_light_packets_reflected_total, plus the client-side open5gs_twamp_* gauges) are also merged into this backend's own /metrics — already scraped by Prometheus, queryable/graphable in Grafana"
          >
            <ExternalLink className="w-3 h-3" /> Open Grafana
          </a>
        </div>
        <p className="text-xs text-nms-text-dim mb-4">
          Every counter/gauge the reflector's own local Prometheus endpoint exposes — TWAMP-Control (full) session/packet/error counters from github.com/ncode/twamp's built-in metrics, plus this project's own TWAMP-Light active-peer/packets-reflected counters (populated regardless of which protocol mode is running).
        </p>
        <ServerMetricsTable />
      </div>
    </div>
  );
}

function fmtMsOrDash(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(2)} ms`;
}
function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`;
}

type HistorySortKey = 'name' | 'sampleCount' | 'avgRttMs' | 'minRttMs' | 'maxRttMs' | 'avgJitterMs' | 'avgPacketLossRatio' | 'lastTimestampMs';

const DEFAULT_HISTORY_RANGE: TimeRangeValue = { type: 'relative', ms: 24 * 60 * 60 * 1000, label: 'Last 24 hours' };

function HistorySection() {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(DEFAULT_HISTORY_RANGE);
  const [summary, setSummary] = useState<TwampHistorySummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  // "Sort by worst ms to best ms" — default view is exactly that: avg RTT,
  // highest (worst) first. Any column is click-to-sort from there.
  const [sortKey, setSortKey] = useState<HistorySortKey>('avgRttMs');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [series, setSeries] = useState<TwampHistorySeriesPoint[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [retentionInput, setRetentionInput] = useState('');
  const [retentionSaving, setRetentionSaving] = useState(false);

  // Relative ranges re-anchor to "now" on every load; absolute ranges are fixed.
  const resolveRange = useCallback((): { from: number; to: number } => {
    if (timeRange.type === 'absolute') return { from: timeRange.from.getTime(), to: timeRange.to.getTime() };
    const to = Date.now();
    return { from: to - timeRange.ms, to };
  }, [timeRange]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = resolveRange();
      setSummary(await twampApi.getHistorySummary(from, to));
    } catch {
      toast.error('Failed to load TWAMP history summary');
    } finally {
      setLoading(false);
    }
  }, [resolveRange]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  useEffect(() => {
    twampApi.getHistorySettings()
      .then(s => { setRetentionDays(s.retentionDays); setRetentionInput(String(s.retentionDays)); })
      .catch(() => {});
  }, []);

  const loadSeries = useCallback(async (targetId: string) => {
    setSeriesLoading(true);
    try {
      const { from, to } = resolveRange();
      const { data } = await twampApi.getHistorySeries(targetId, from, to);
      setSeries(data);
    } catch {
      toast.error('Failed to load target history');
      setSeries([]);
    } finally {
      setSeriesLoading(false);
    }
  }, [resolveRange]);

  useEffect(() => { if (selectedTargetId) loadSeries(selectedTargetId); }, [selectedTargetId, loadSeries]);

  // Auto-select the current worst target once the summary first loads, so
  // the graph below isn't just a blank "pick something" state.
  useEffect(() => {
    if (!selectedTargetId && summary.length > 0) {
      const worst = [...summary].sort((a, b) => (b.avgRttMs ?? -1) - (a.avgRttMs ?? -1))[0];
      setSelectedTargetId(worst.targetId);
    }
  }, [summary, selectedTargetId]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...summary].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string' && typeof bv === 'string') return dir * av.localeCompare(bv);
      return dir * ((av as number) - (bv as number));
    });
  }, [summary, sortKey, sortDir]);

  const toggleSort = (key: HistorySortKey) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const saveRetention = async () => {
    const n = Number(retentionInput);
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      toast.error('Retention must be between 1 and 365 days');
      return;
    }
    setRetentionSaving(true);
    try {
      const r = await twampApi.updateHistorySettings(n);
      setRetentionDays(r.retentionDays);
      toast.success(`History retention set to ${r.retentionDays} day${r.retentionDays !== 1 ? 's' : ''}`);
    } catch (err: any) {
      toast.error(`Failed to update retention: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setRetentionSaving(false);
    }
  };

  const chartPoints = useMemo(() => {
    const { from, to } = resolveRange();
    const showDate = to - from > 36 * 60 * 60 * 1000;
    return series.map(p => ({
      label: new Date(p.ts).toLocaleString(undefined, showDate
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' }),
      avgRttMs: p.avgRttMs, minRttMs: p.minRttMs, maxRttMs: p.maxRttMs, jitterMs: p.jitterMs,
      lossPct: p.packetLossRatio !== null ? Number((p.packetLossRatio * 100).toFixed(2)) : null,
    }));
  }, [series, resolveRange]);

  const selectedTarget = summary.find(s => s.targetId === selectedTargetId);

  const SortHeader = ({ label, k }: { label: string; k: HistorySortKey }) => (
    <th className="py-2 pr-4 font-medium cursor-pointer select-none hover:text-nms-text" onClick={() => toggleSort(k)}>
      <span className="flex items-center gap-1">{label}{sortKey === k && (sortDir === 'asc' ? ' ▲' : ' ▼')}</span>
    </th>
  );

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="nms-card flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="nms-label">Time Range</label>
            <TimeRangePicker value={timeRange} onChange={setTimeRange} align="left" />
          </div>
          <button
            onClick={() => { loadSummary(); if (selectedTargetId) loadSeries(selectedTargetId); }}
            className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-2"
          >
            <RefreshCw className={clsx('w-3 h-3', loading && 'animate-spin')} /> Refresh
          </button>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="nms-label">History Retention (days, 1–365)</label>
            <input
              type="number" min={1} max={365}
              className="nms-input w-32 font-mono text-sm"
              value={retentionInput}
              onChange={e => setRetentionInput(e.target.value)}
            />
          </div>
          <button
            onClick={saveRetention}
            disabled={retentionSaving || !retentionDays || retentionInput === String(retentionDays)}
            className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-2"
          >
            <Settings className="w-3 h-3" /> {retentionSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Summary table */}
      <div className="nms-card">
        <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
          <History className="w-4 h-4 text-nms-accent" /> Targets — Ranked by RTT
        </h2>
        <p className="text-xs text-nms-text-dim mb-4">
          Every stored result over the selected range, rolled up per target. Click a column to sort, click a row to graph it below.
          {retentionDays !== null && <> Currently keeping <span className="font-mono text-nms-text">{retentionDays}</span> day{retentionDays !== 1 ? 's' : ''} of raw history.</>}
        </p>
        {loading ? (
          <p className="text-sm text-nms-text-dim py-6 text-center">Loading…</p>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-nms-text-dim py-6 text-center">
            No history recorded yet for this range — data accumulates as targets are tested (background poll or "Test Now").
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-nms-text-dim border-b border-nms-border">
                  <SortHeader label="Target" k="name" />
                  <th className="py-2 pr-4 font-medium">Protocol</th>
                  <SortHeader label="Samples" k="sampleCount" />
                  <th className="py-2 pr-4 font-medium">Success</th>
                  <SortHeader label="Avg RTT" k="avgRttMs" />
                  <SortHeader label="Min RTT" k="minRttMs" />
                  <SortHeader label="Max RTT" k="maxRttMs" />
                  <SortHeader label="Avg Jitter" k="avgJitterMs" />
                  <SortHeader label="Avg Loss" k="avgPacketLossRatio" />
                  <SortHeader label="Last Seen" k="lastTimestampMs" />
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => (
                  <tr
                    key={r.targetId}
                    onClick={() => setSelectedTargetId(r.targetId)}
                    className={clsx(
                      'border-b border-nms-border/50 hover:bg-nms-bg/50 cursor-pointer',
                      selectedTargetId === r.targetId && 'bg-nms-accent/10',
                    )}
                  >
                    <td className="py-2 pr-4 font-mono text-nms-text">{r.name} <span className="text-nms-text-dim">({r.host})</span></td>
                    <td className="py-2 pr-4">
                      <span className={clsx('px-1.5 py-0.5 rounded font-mono text-[10px] border',
                        r.protocol === 'light' ? 'text-nms-accent bg-nms-accent/10 border-nms-accent/30' : 'text-nms-text-dim bg-nms-surface-2 border-nms-border')}>
                        {r.protocol === 'light' ? 'Light' : 'Full'}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono">{r.sampleCount}</td>
                    <td className="py-2 pr-4 font-mono">{r.sampleCount > 0 ? `${((r.successCount / r.sampleCount) * 100).toFixed(1)}%` : '—'}</td>
                    <td className="py-2 pr-4 font-mono">{fmtMsOrDash(r.avgRttMs)}</td>
                    <td className="py-2 pr-4 font-mono">{fmtMsOrDash(r.minRttMs)}</td>
                    <td className="py-2 pr-4 font-mono">{fmtMsOrDash(r.maxRttMs)}</td>
                    <td className="py-2 pr-4 font-mono">{fmtMsOrDash(r.avgJitterMs)}</td>
                    <td className={clsx('py-2 pr-4 font-mono', (r.avgPacketLossRatio ?? 0) > 0 && 'text-amber-400')}>{fmtPct(r.avgPacketLossRatio)}</td>
                    <td className="py-2 pr-4 font-mono">
                      {new Date(r.lastTimestampMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drill-down graph */}
      <div className="nms-card">
        <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2 mb-1">
          <TrendingUp className="w-4 h-4 text-nms-accent" />
          {selectedTarget ? `${selectedTarget.name} (${selectedTarget.host}) — RTT / Jitter Over Time` : 'Select a target above'}
        </h2>
        <p className="text-xs text-nms-text-dim mb-4">
          Auto-bucketed server-side to stay readable across any range up to the full retention window.
        </p>
        {!selectedTargetId ? (
          <p className="text-sm text-nms-text-dim py-10 text-center">No target selected yet.</p>
        ) : seriesLoading ? (
          <p className="text-sm text-nms-text-dim py-10 text-center">Loading…</p>
        ) : chartPoints.length === 0 ? (
          <p className="text-sm text-nms-text-dim py-10 text-center">No history recorded yet for this target in this range.</p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chartPoints} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} minTickGap={40} />
              <YAxis yAxisId="ms" tick={{ fontSize: 11, fill: '#94a3b8' }} label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }} />
              <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 11, fill: '#94a3b8' }} label={{ value: 'loss %', angle: 90, position: 'insideRight', fill: '#94a3b8', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#1a2236', border: '1px solid #1e293b', fontSize: 12 }} labelStyle={{ color: '#e2e8f0' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="ms" type="monotone" dataKey="maxRttMs" name="Max RTT" stroke="#475569" strokeWidth={1} strokeDasharray="3 3" dot={false} />
              <Line yAxisId="ms" type="monotone" dataKey="avgRttMs" name="Avg RTT" stroke="#38bdf8" strokeWidth={2} dot={false} />
              <Line yAxisId="ms" type="monotone" dataKey="minRttMs" name="Min RTT" stroke="#475569" strokeWidth={1} strokeDasharray="3 3" dot={false} />
              <Line yAxisId="ms" type="monotone" dataKey="jitterMs" name="Jitter" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
              <Line yAxisId="pct" type="monotone" dataKey="lossPct" name="Loss %" stroke="#ef4444" strokeWidth={1.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {selectedTarget && (
          <div className="mt-4 pt-4 border-t border-nms-border overflow-x-auto">
            <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">
              Summary for the selected time range ({timeRange.label})
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-nms-text-dim border-b border-nms-border">
                  <th className="py-2 pr-4 font-medium">Samples</th>
                  <th className="py-2 pr-4 font-medium">Success</th>
                  <th className="py-2 pr-4 font-medium">Min RTT</th>
                  <th className="py-2 pr-4 font-medium">Avg RTT</th>
                  <th className="py-2 pr-4 font-medium">Max RTT</th>
                  <th className="py-2 pr-4 font-medium">Avg Jitter</th>
                  <th className="py-2 pr-4 font-medium">Avg Loss</th>
                </tr>
              </thead>
              <tbody>
                <tr className="hover:bg-nms-bg/50">
                  <td className="py-2 pr-4 font-mono">{selectedTarget.sampleCount}</td>
                  <td className="py-2 pr-4 font-mono">
                    {selectedTarget.sampleCount > 0 ? `${((selectedTarget.successCount / selectedTarget.sampleCount) * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-2 pr-4 font-mono text-nms-text">{fmtMsOrDash(selectedTarget.minRttMs)}</td>
                  <td className="py-2 pr-4 font-mono text-nms-accent font-semibold">{fmtMsOrDash(selectedTarget.avgRttMs)}</td>
                  <td className="py-2 pr-4 font-mono text-nms-text">{fmtMsOrDash(selectedTarget.maxRttMs)}</td>
                  <td className="py-2 pr-4 font-mono">{fmtMsOrDash(selectedTarget.avgJitterMs)}</td>
                  <td className={clsx('py-2 pr-4 font-mono', (selectedTarget.avgPacketLossRatio ?? 0) > 0 && 'text-amber-400')}>
                    {fmtPct(selectedTarget.avgPacketLossRatio)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function TwampPage({ onNavigate }: { onNavigate?: (tab: string) => void }): JSX.Element {
  const [status, setStatus] = useState<TwampStatus | null>(null);
  const [targets, setTargets] = useState<TwampTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [streamLog, setStreamLog] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [pageTab, setPageTab] = useState<'client' | 'server' | 'info' | 'history'>('client');

  // Server status polled here too (independently of ServerSection's own
  // poll for its Configure form) — this is what drives the header's status
  // badge + Start/Stop/Restart, matching every other module page's
  // convention of surfacing lifecycle controls in the header, not buried in
  // a body card. Same duplicate-polling pattern already used elsewhere in
  // this codebase (e.g. ServicesPage vs. SMSPage both independently poll
  // mms/vowifi status).
  const [serverStatus, setServerStatus] = useState<TwampServerStatus | null>(null);
  const [serverActing, setServerActing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const s = await twampApi.getStatus();
      setStatus(s);
      if (s.installed) setTargets(await twampApi.getTargets());
    } catch (err: any) {
      if (!silent) toast.error(`Status fetch failed: ${err.message}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadServerStatus = useCallback(() => {
    twampApi.getServerStatus().then(setServerStatus).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    loadServerStatus();
    const iv = setInterval(() => { load(true); loadServerStatus(); }, 15_000);
    return () => clearInterval(iv);
  }, [load, loadServerStatus]);

  const handleServerAction = async (action: 'start' | 'stop' | 'restart') => {
    setServerActing(true);
    try {
      await { start: twampApi.startServer, stop: twampApi.stopServer, restart: twampApi.restartServer }[action]();
      toast.success(`Reflector ${action}ed`);
      loadServerStatus();
    } catch (err: any) {
      toast.error(`${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setServerActing(false);
    }
  };

  const handleInstall = async () => {
    setActing(true);
    setStreamLog('');
    try {
      const resp   = await twampApi.install();
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

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-nms-text-dim">
      <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading TWAMP status…
    </div>
  );

  const installed = status?.installed ?? false;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold font-display">TWAMP</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            RFC 5357 network performance testing against radio/backhaul reflectors
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {installed && (
            <div className={clsx('flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-mono border',
              targets.length > 0 ? 'text-nms-accent bg-nms-accent/10 border-nms-accent/30' : 'text-nms-text-dim bg-nms-surface-2 border-nms-border')}>
              <Gauge className="w-3.5 h-3.5" /> Client: {targets.length} target{targets.length !== 1 ? 's' : ''}
            </div>
          )}
          {serverStatus?.installed && (
            <div className={clsx('flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-mono border',
              serverStatus.serviceActive ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30')}>
              {serverStatus.serviceActive ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
              Server: {serverStatus.serviceActive ? 'active' : serverStatus.hasSavedConfig ? 'stopped' : 'not configured'}
            </div>
          )}

          {/* Gated on "installed" only, matching IMS/every other module page's
              header convention — NOT on "hasSavedConfig" too. A saved-config
              gate here means the buttons vanish entirely on a freshly
              installed-but-not-yet-configured reflector, which is exactly
              the class of bug CLAUDE.md documents for VoWiFi (controls
              gated on "configured" instead of "installed" made them
              disappear while the underlying page was otherwise fine).
              Clicking Start/Stop/Restart before Configure has run just
              surfaces a normal error toast from the backend, same as any
              other action against a not-yet-configured module. */}
          {serverStatus?.installed && (
            <>
              <div className="h-5 w-px bg-nms-border" />

              <button onClick={() => handleServerAction('start')} disabled={serverActing} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <Play className="w-3 h-3" /> Start
              </button>
              <button onClick={() => handleServerAction('stop')} disabled={serverActing} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <XCircle className="w-3 h-3" /> Stop
              </button>
              <button onClick={() => handleServerAction('restart')} disabled={serverActing} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <RotateCw className={clsx('w-3 h-3', serverActing && 'animate-spin')} /> Restart
              </button>

              <div className="h-5 w-px bg-nms-border" />
            </>
          )}

          <button onClick={() => { load(); loadServerStatus(); }} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Status panel */}
      <div className={`nms-card ${!installed ? 'border-amber-500/30 bg-amber-500/5' : 'border-green-500/30 bg-green-500/5'}`}>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            {!installed
              ? <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
              : <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
            }
            <div>
              <p className="text-sm font-semibold">
                {!installed ? 'twamp-client not installed' : `twamp-client installed — ${targets.length} target${targets.length !== 1 ? 's' : ''} configured`}
              </p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                One-way forward/reverse delay figures need this host and the reflector to have reasonably synced clocks
                {onNavigate && (
                  <> — see the <button onClick={() => onNavigate('time-server')} className="text-nms-accent hover:underline">Time Server</button> page if you haven't set that up.</>
                )}
                {' '}RTT, jitter, and packet loss are valid regardless.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Install card */}
      {!installed && (
        <div className="nms-card">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <Terminal className="w-4 h-4 text-nms-accent" /> Install twamp-client &amp; twamp-server
              </h2>
              <p className="text-xs text-nms-text-dim mt-1">
                Compiles two small Go programs against github.com/ncode/twamp (that project is a library, not a CLI —
                this builds our own thin wrappers against it): an on-demand test client (no persistent service — each
                test is a short run), and an optional always-listening reflector service for the reverse direction
                (a radio testing inbound against this host).
              </p>
            </div>
            <button onClick={handleInstall} disabled={acting} className="nms-btn-primary flex items-center gap-2 text-sm shrink-0">
              <Terminal className="w-4 h-4" /> {acting ? 'Installing…' : 'Install'}
            </button>
          </div>
          {streamLog && <LogTerminal lines={streamLog} />}
        </div>
      )}

      {/* Tab bar */}
      {installed && (
        <div className="flex justify-center">
          <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
            <button onClick={() => setPageTab('client')}
              className={clsx('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                pageTab === 'client' ? 'bg-nms-accent text-white shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface')}>
              <Gauge className="w-4 h-4" /> Client (Targets)
            </button>
            <button onClick={() => setPageTab('server')}
              className={clsx('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                pageTab === 'server' ? 'bg-nms-accent text-white shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface')}>
              <Server className="w-4 h-4" /> Reflector (Server)
            </button>
            <button onClick={() => setPageTab('info')}
              className={clsx('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                pageTab === 'info' ? 'bg-nms-accent text-white shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface')}>
              <ListTree className="w-4 h-4" /> Info &amp; Stats
            </button>
            <button onClick={() => setPageTab('history')}
              className={clsx('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                pageTab === 'history' ? 'bg-nms-accent text-white shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface')}>
              <History className="w-4 h-4" /> History
            </button>
          </div>
        </div>
      )}

      {/* Targets (client) */}
      {installed && pageTab === 'client' && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-nms-text uppercase tracking-wider">Targets</h2>
            <button onClick={() => setShowAddModal(true)} className="nms-btn-primary flex items-center gap-2 text-sm">
              <Plus className="w-4 h-4" /> Add Target
            </button>
          </div>
          {showAddModal && (
            <TargetFormModal onClose={() => setShowAddModal(false)} onSaved={() => load(true)} />
          )}
          {targets.length === 0 ? (
            <div className="nms-card border-dashed border-nms-border text-center py-10">
              <Gauge className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
              <p className="text-sm text-nms-text-dim">No TWAMP targets configured yet.</p>
              <p className="text-xs text-nms-text-dim mt-1">Click <strong>Add Target</strong> to point this at a radio's TWAMP reflector.</p>
            </div>
          ) : (
            <TargetsTable targets={targets} onChanged={() => load(true)} />
          )}
        </>
      )}

      {/* Reflector (server) */}
      {installed && pageTab === 'server' && (
        <ServerSection onInstall={handleInstall} installActing={acting} installStreamLog={streamLog} />
      )}

      {/* Info & Stats */}
      {installed && pageTab === 'info' && <InfoStatsSection targets={targets} />}

      {/* History */}
      {installed && pageTab === 'history' && <HistorySection />}
    </div>
  );
}
