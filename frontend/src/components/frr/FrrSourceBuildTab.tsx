import { useState, useEffect, useRef, useCallback } from 'react';
import {
  AlertTriangle, CheckCircle, XCircle, RefreshCw, Play, RotateCcw,
  ExternalLink, ChevronDown, BookOpen,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { frrSourceBuildApi, FrrBuildState } from '../../api/frr';

const STEP_ORDER: FrrBuildState['status'][] = [
  'preparing', 'building_libyang', 'building_frr', 'swapping', 'starting_service', 'verifying',
];

const STEP_LABELS: Record<string, string> = {
  preparing: 'Preflight + install build dependencies',
  building_libyang: 'Build + install libyang',
  building_frr: 'Clone + configure + compile FRR — isolated, no downtime yet',
  swapping: 'Swap in new build — brief downtime (stop service, install, restore config)',
  starting_service: 'systemd enable + start',
  verifying: 'Verify service active + EIGRP neighbor',
};

const WARNING_KEY = 'frr-source-build-warning-accepted';

function LogTerminal({ lines }: { lines: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  if (!lines) return null;
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-96 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-2">
      {lines}
    </pre>
  );
}

function BuildWarningModal({ onAccept, onCancel }: { onAccept: () => void; onCancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="fixed inset-0 z-50 p-6 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="nms-card max-w-lg w-full border-amber-500/40 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-amber-500/10 shrink-0"><AlertTriangle className="w-6 h-6 text-amber-400" /></div>
          <h2 className="text-lg font-semibold font-display">Rebuild FRR from source</h2>
        </div>
        <div className="space-y-2 text-sm text-nms-text-dim">
          <p>This <span className="text-nms-text font-semibold">completely removes</span> the apt-installed FRR package and replaces it with a source build.</p>
          <ul className="space-y-1.5 mt-2">
            <li className="flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" /><span>EIGRP/OSPF/BGP routing goes down for the duration of the build (typically several minutes).</span></li>
            <li className="flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" /><span>Radios and any traffic depending on dynamic routes will drop during that window — same blast radius as an eigrpd crash restart, just planned.</span></li>
            <li className="flex items-start gap-2"><CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" /><span>Your live frr.conf/daemons/vtysh.conf are backed up automatically before anything is touched.</span></li>
            <li className="flex items-start gap-2"><CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" /><span>Rollback reinstalls the stock apt package and restores the backup if the build fails.</span></li>
          </ul>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="w-4 h-4 rounded border-nms-border" />
          <span className="text-nms-text">I understand routing will drop and have accepted the risk</span>
        </label>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="nms-btn-ghost flex-1">Cancel</button>
          <button onClick={onAccept} disabled={!confirmed} className="nms-btn-primary flex-1 disabled:opacity-40">I understand — continue</button>
        </div>
      </div>
    </div>
  );
}

export function FrrSourceBuildTab() {
  const [state, setState] = useState<FrrBuildState | null>(null);
  const [targetTag, setTargetTag] = useState('');
  const [showWarning, setShowWarning] = useState(false);
  const [busy, setBusy] = useState<'backup' | 'start' | 'rollback' | 'reset' | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await frrSourceBuildApi.getStatus();
      setState(s);
      setTargetTag(t => t || s.targetTag || s.defaultTargetTag);
    } catch {
      // backend not reachable — leave existing state, next poll will retry
    }
  }, []);

  useEffect(() => {
    load();
    const running = state && !['idle', 'complete', 'failed', 'rolled_back'].includes(state.status);
    const interval = setInterval(load, running ? 2000 : 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, state?.status]);

  const isRunning = !!state && !['idle', 'complete', 'failed', 'rolled_back'].includes(state.status);
  const stepIdx = state ? STEP_ORDER.indexOf(state.status) : -1;

  const doBackup = async () => {
    setBusy('backup');
    try {
      const r = await frrSourceBuildApi.backup();
      toast.success(`Backed up to ${r.backupPath}`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Backup failed');
    } finally {
      setBusy(null);
    }
  };

  const doStart = async () => {
    setBusy('start');
    try {
      await frrSourceBuildApi.start(targetTag);
      toast.success('Build started');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to start build');
    } finally {
      setBusy(null);
    }
  };

  const doRollback = async () => {
    if (!confirm('Roll back to the stock apt package and restore the backed-up config?')) return;
    setBusy('rollback');
    try {
      await frrSourceBuildApi.rollback();
      toast.success('Rolled back to apt package');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Rollback failed');
    } finally {
      setBusy(null);
    }
  };

  const doReset = async () => {
    setBusy('reset');
    try {
      await frrSourceBuildApi.resetState();
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Reset failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 mt-4">
      {showWarning && (
        <BuildWarningModal
          onAccept={() => { localStorage.setItem(WARNING_KEY, '1'); setShowWarning(false); doStart(); }}
          onCancel={() => setShowWarning(false)}
        />
      )}

      {/* Explanation */}
      <div className="nms-card">
        <button onClick={() => setExplainOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-nms-accent shrink-0" />
            <span className="text-sm font-semibold text-nms-text">Why rebuild FRR from source?</span>
          </div>
          <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', explainOpen && 'rotate-180')} />
        </button>
        {explainOpen && (
          <div className="mt-3 space-y-2 text-xs text-nms-text-dim leading-relaxed">
            <p>
              The apt-installed FRR (8.4.4) has known eigrpd crash bugs (assertion failures on
              interface deletion and route FSM processing) that cause the intermittent routing
              drops seen on this host. Upstream FRR keeps landing eigrpd crash fixes well past
              8.4.4 (10.4.0 through 10.6.1), but Ubuntu 24.04 doesn't ship anything newer, and
              FRR's own apt repository is currently broken for 10.3+ on this OS (unmet
              <span className="font-mono text-nms-text"> libyang2</span> dependency). Building
              from source is the only current path to the fixed version.
            </p>
            <p>
              This tool backs up your live <span className="font-mono text-nms-text">frr.conf</span>/
              <span className="font-mono text-nms-text">daemons</span>/
              <span className="font-mono text-nms-text">vtysh.conf</span>, purges the apt
              package, builds the target FRR tag from source, and restores your config into the
              new install. If it fails, Rollback reinstalls the stock package and restores the
              backup.
            </p>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="nms-card space-y-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-nms-text-dim block mb-1">Target FRR tag</label>
            <input
              value={targetTag}
              onChange={e => setTargetTag(e.target.value)}
              disabled={isRunning}
              placeholder={state?.defaultTargetTag ?? 'frr-10.6.1'}
              className="nms-input text-sm w-48 font-mono"
            />
          </div>
          <a href="https://github.com/FRRouting/frr/releases" target="_blank" rel="noreferrer"
            className="text-xs text-nms-accent hover:underline flex items-center gap-1 mb-2">
            <ExternalLink className="w-3 h-3" /> Check latest release
          </a>

          <div className="flex-1" />

          <button onClick={doBackup} disabled={busy !== null || isRunning} className="nms-btn-ghost flex items-center gap-2 text-sm">
            {busy === 'backup' ? <RefreshCw className="w-4 h-4 animate-spin" /> : null} Backup Now
          </button>

          <button
            onClick={() => {
              if (localStorage.getItem(WARNING_KEY) === '1') doStart();
              else setShowWarning(true);
            }}
            disabled={busy !== null || isRunning}
            className="nms-btn-primary flex items-center gap-2 text-sm"
          >
            {busy === 'start' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Start Build
          </button>

          {state?.status === 'failed' && (
            <button onClick={doRollback} disabled={busy !== null} className="nms-btn-danger flex items-center gap-2 text-sm">
              {busy === 'rollback' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Rollback to APT
            </button>
          )}

          {state && ['complete', 'failed', 'rolled_back'].includes(state.status) && (
            <button onClick={doReset} disabled={busy !== null} className="nms-btn-ghost flex items-center gap-2 text-sm text-nms-text-dim">
              <XCircle className="w-4 h-4" /> Reset
            </button>
          )}
        </div>

        {state?.backupPath && (
          <p className="text-xs text-nms-text-dim">Last backup: <span className="font-mono text-nms-text">{state.backupPath}</span></p>
        )}
      </div>

      {/* Step list */}
      {state && state.status !== 'idle' && (
        <div className="nms-card space-y-2">
          {STEP_ORDER.map((step, i) => {
            const isDone = stepIdx > i || state.status === 'complete';
            const isCurrent = state.status === step;
            const isFailed = state.status === 'failed' && stepIdx <= i;
            return (
              <div key={step} className="flex items-center gap-3">
                <div className={clsx('w-5 h-5 rounded-full flex items-center justify-center shrink-0',
                  isDone ? 'bg-green-500/20' : isCurrent ? 'bg-nms-accent/20' : 'bg-nms-border/50'
                )}>
                  {isDone ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                    : isCurrent ? <RefreshCw className="w-3 h-3 text-nms-accent animate-spin" />
                    : <span className="text-[10px] font-bold text-nms-text-dim/40">{i}</span>}
                </div>
                <span className={clsx('text-sm', isDone ? 'text-nms-text' : isCurrent ? 'text-nms-accent font-medium' : isFailed ? 'text-nms-text-dim' : 'text-nms-text-dim')}>
                  {STEP_LABELS[step]}
                </span>
              </div>
            );
          })}
          <div className="flex items-center gap-3">
            <div className={clsx('w-5 h-5 rounded-full flex items-center justify-center shrink-0',
              state.status === 'complete' ? 'bg-green-500/20' : state.status === 'failed' ? 'bg-red-500/20' : 'bg-nms-border/50'
            )}>
              {state.status === 'complete' && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
              {state.status === 'failed' && <XCircle className="w-3.5 h-3.5 text-red-400" />}
            </div>
            <span className={clsx('text-sm', state.status === 'complete' ? 'text-green-400 font-medium' : state.status === 'failed' ? 'text-red-400 font-medium' : 'text-nms-text-dim')}>
              {state.currentStepLabel || (state.status === 'complete' ? 'Complete' : state.status === 'failed' ? 'Failed' : '')}
            </span>
          </div>
          {state.error && (
            <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded px-3 py-2 mt-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {state.error}
            </div>
          )}
        </div>
      )}

      {/* Log */}
      {state && state.log && (
        <div className="nms-card">
          <p className="text-xs text-nms-text-dim mb-1">Build log</p>
          <LogTerminal lines={state.log} />
        </div>
      )}
    </div>
  );
}
