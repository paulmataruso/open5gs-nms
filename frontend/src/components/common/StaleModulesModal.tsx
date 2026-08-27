import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, RefreshCw, Wrench, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { modulesApi, ModuleId, ModuleStaleStatus, FixAllRunState } from '../../api/modules';
import { useStaleModulesStore } from '../../stores/staleModules';
import { useAuth } from '../../contexts/AuthContext';
import { FEATURES } from '../../config/features';
import { LogBlock } from './LogBlock';

// Centralized replacement for the old per-module "install/config is stale"
// banners (removed from IMSPage/SMSPage/TwampPage/PstnGatewayPage/SecGWPage/
// VoWiFiPage) — see backend/src/application/use-cases/module-fixall-usecase.ts
// for the aggregation/orchestration this drives. Mounted as a sibling of
// <Layout> inside <AuthGuard> in App.tsx, so it only exists post-auth and
// remounts fresh on every login — its own mount-time fetch is what gives
// "check on reload or login" for free, no changes needed to AuthGuard itself.
//
// Non-dismissible while any auto-fixable staleness remains (no X / backdrop
// click) — the operator's only ways out are Fix All succeeding, or every
// remaining stale module being one Fix All can't touch (canAutoFix: false,
// e.g. MMS with no saved mm1PublicIp), in which case a "Continue" escape
// hatch appears so a manual-fix-only case never traps the operator behind
// an unclosable overlay.
const FEATURE_FLAG_BY_MODULE: Record<ModuleId, boolean> = {
  ims: FEATURES.ims,
  mms: FEATURES.mms,
  vectorcoreSmsc: FEATURES.vectorcoreSmsc,
  pstn: FEATURES.pstn,
  vowifi: FEATURES.vowifi,
  secgw: FEATURES.secgw,
  twamp: FEATURES.twamp,
};

const POLL_MS = 1500;

function ModuleRow({ m }: { m: ModuleStaleStatus }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-nms-border last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-nms-text">{m.label}</div>
        {m.blockedReason && (
          <div className="text-xs text-amber-400 mt-0.5">{m.blockedReason}</div>
        )}
      </div>
      <div className="flex gap-1.5 shrink-0">
        {m.installStale && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
            Install out of date
          </span>
        )}
        {m.configStale && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
            Config out of date
          </span>
        )}
      </div>
    </div>
  );
}

export function StaleModulesModal(): JSX.Element | null {
  const { user } = useAuth();
  const { modules, fetchStaleModules } = useStaleModulesStore();
  const [fetched, setFetched] = useState(false);
  const [dismissedForSession, setDismissedForSession] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [run, setRun] = useState<FixAllRunState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchStaleModules().finally(() => setFetched(true));
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = modules.filter(m => FEATURE_FLAG_BY_MODULE[m.moduleId]);
  const isAdmin = user?.role === 'admin';
  const allBlockedOnly = visible.length > 0 && visible.every(m => !m.canAutoFix);

  if (!fetched || visible.length === 0 || dismissedForSession) return null;

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const handleFixAll = async () => {
    setFixing(true);
    setRun(null);
    try {
      await modulesApi.fixAll();
    } catch (err) {
      setFixing(false);
      toast.error(`Failed to start Fix All: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const state = await modulesApi.getFixAllStatus();
        setRun(state);
        if (state.status === 'complete' || state.status === 'failed') {
          stopPolling();
          setFixing(false);
          await fetchStaleModules();
          const failedCount = state.results.filter(r => !r.skipped && (r.installSuccess === false || r.configureSuccess === false)).length;
          if (failedCount > 0) {
            toast.error(`Fix All finished with ${failedCount} module(s) still failing — see details below.`);
          } else {
            toast.success('Fix All completed.');
          }
        }
      } catch {
        // transient poll failure — keep trying until stopPolling() fires
      }
    }, POLL_MS);
  };

  const logLines = run?.results.flatMap(r => [
    `── ${r.moduleId} ──`,
    ...(r.skipped ? [`skipped: ${r.skipReason ?? ''}`] : r.log),
    r.error ? `error: ${r.error}` : '',
  ].filter(Boolean)) ?? [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="nms-card max-w-lg w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center gap-2 mb-1">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
          <h3 className="text-lg font-semibold font-display">Updates available</h3>
        </div>
        <p className="text-sm text-nms-text-dim mb-3">
          {visible.length} module{visible.length === 1 ? '' : 's'} on this deployment {visible.length === 1 ? 'is' : 'are'} running an out-of-date install or configuration.
        </p>

        <div className="overflow-y-auto flex-1 min-h-0">
          {visible.map(m => <ModuleRow key={m.moduleId} m={m} />)}
        </div>

        {run && <LogBlock lines={logLines} />}

        <div className="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-nms-border">
          {isAdmin ? (
            <>
              {allBlockedOnly ? (
                <div className="flex items-center gap-2 text-xs text-nms-text-dim">
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  These need manual attention (see notes above) — nothing here can be auto-fixed.
                </div>
              ) : (
                <button
                  onClick={handleFixAll}
                  disabled={fixing}
                  className="nms-btn-primary flex items-center gap-2"
                >
                  {fixing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                  {fixing ? 'Fixing…' : 'Fix All'}
                </button>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-nms-text-dim">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Ask an admin to fix these modules.
            </div>
          )}

          {(allBlockedOnly || !isAdmin) && (
            <button onClick={() => setDismissedForSession(true)} className="nms-btn-ghost">
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
