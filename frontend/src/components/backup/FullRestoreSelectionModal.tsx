import { useEffect, useRef, useState } from 'react';
import { X, CheckSquare, Square, AlertTriangle, Database, FileCog, KeyRound, Puzzle, Network, Globe, ShieldCheck, RadioTower, UserCog, CheckCircle2, XCircle, MinusCircle, Loader2, MapPin, ToggleLeft, Coins, History } from 'lucide-react';
import toast from 'react-hot-toast';
import { BackupCategory, BackupCategoryInfo, backupApi, FullRestoreOrchestratorState } from '../../api/backup';
import { LogBlock } from '../common/LogBlock';
import { IpPlanPanel } from '../common/IpPlanPanel';

interface FullRestoreSelectionModalProps {
  uploadId: string;
  categories: BackupCategoryInfo[];
  createdAt?: string;
  presentModules: string[];
  onClose: () => void;
  // Called once the restore pipeline reaches a terminal 'complete' state
  // with no top-level failure, so the parent can refresh its backup list.
  onRestored: () => void;
}

// L3/network, DNS, GenieACS, and OCS data default OFF. L3/DNS: a restore
// commonly happens onto a host whose physical IP topology differs from the
// one the backup was taken on, and silently overwriting frr.conf/netplan/
// BIND could break connectivity to the box entirely. GenieACS: a full
// separate-database restore that overwrites live radio provisioning/session
// state — the same "be deliberate about this one" posture, not because it's
// less important. OCS data: briefly stops a live billing service during
// restore and unconditionally overwrites its real prepaid balances/rating
// plans — same posture again. Everything else (including secgw-pki, despite
// also being irreplaceable like suci-keys) defaults ON.
const DEFAULT_UNCHECKED: BackupCategory[] = ['l3-network', 'dns', 'genieacs', 'ocs-data'];

const ICONS: Record<BackupCategory, React.ReactNode> = {
  subscribers: <Database className="w-4 h-4" />,
  'core-configs': <FileCog className="w-4 h-4" />,
  'suci-keys': <KeyRound className="w-4 h-4" />,
  'secgw-pki': <ShieldCheck className="w-4 h-4" />,
  'optional-modules': <Puzzle className="w-4 h-4" />,
  'l3-network': <Network className="w-4 h-4" />,
  dns: <Globe className="w-4 h-4" />,
  genieacs: <RadioTower className="w-4 h-4" />,
  auth: <UserCog className="w-4 h-4" />,
  'ui-modules': <ToggleLeft className="w-4 h-4" />,
  'ocs-data': <Coins className="w-4 h-4" />,
  'radio-backups': <History className="w-4 h-4" />,
};

const POLL_MS = 2000;

function StatusIcon({ success, skipped }: { success: boolean; skipped: boolean }) {
  if (skipped) return <MinusCircle className="w-3.5 h-3.5 text-nms-text-dim shrink-0" />;
  return success
    ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
    : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
}

export const FullRestoreSelectionModal: React.FC<FullRestoreSelectionModalProps> = ({
  uploadId, categories, createdAt, presentModules, onClose, onRestored,
}) => {
  const [selected, setSelected] = useState<Set<BackupCategory>>(
    new Set(categories.filter(c => c.present && !DEFAULT_UNCHECKED.includes(c.id)).map(c => c.id)),
  );
  const [freshHost, setFreshHost] = useState(false);
  const [phase, setPhase] = useState<'selecting' | 'running' | 'done'>('selecting');
  const [run, setRun] = useState<FullRestoreOrchestratorState | null>(null);
  const [showIpPlan, setShowIpPlan] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const toggle = (id: BackupCategory) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const selectAll = () => setSelected(new Set(categories.filter(c => c.present).map(c => c.id)));
  const deselectAll = () => setSelected(new Set());

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    const list = Array.from(selected);
    const label = categories.filter(c => list.includes(c.id)).map(c => c.label).join(', ');
    const restartWarning = 'Affected services will be automatically restarted once the restore finishes (core NFs, strongSwan, BIND9, and every restored optional module) — this will interrupt any active calls/sessions on this host.';
    const bootstrapNote = freshHost ? `\n\nFresh-host mode: ${presentModules.length} optional module(s) will be installed first.` : '';
    if (!confirm(`Restore ${selected.size} categor${selected.size === 1 ? 'y' : 'ies'} (${label})?\n\n${restartWarning}${bootstrapNote}\n\nAnything not checked is left untouched.`)) {
      return;
    }

    setPhase('running');
    setRun(null);
    try {
      const r = await backupApi.startFullRestore(uploadId, list, freshHost, presentModules);
      if (!r.success) throw new Error(r.error || 'Failed to start restore');
    } catch (err) {
      setPhase('selecting');
      toast.error(err instanceof Error ? err.message : 'Failed to start restore');
      return;
    }

    pollRef.current = setInterval(async () => {
      try {
        const { run: state } = await backupApi.getFullRestoreStatus();
        setRun(state);
        if (state.status === 'complete' || state.status === 'failed') {
          stopPolling();
          setPhase('done');
          if (state.status === 'complete') {
            toast.success('Restore complete.');
            onRestored();
          } else {
            toast.error(state.restoreError || 'Restore failed — see details below.');
          }
        }
      } catch {
        // transient poll failure (or, briefly, the backend restarting itself
        // after an `auth` category restore) — keep trying until stopPolling()
        // fires on the next successful terminal-status read.
      }
    }, POLL_MS);
  };

  const phaseLabel = (p?: string) => p === 'bootstrap' ? 'Installing modules'
    : p === 'restoring' ? 'Restoring config/data' : p === 'restart' ? 'Restarting services' : 'Starting…';

  const logLines = [
    ...(run?.bootstrap?.results.flatMap(r => [
      `── install: ${r.label} ──`,
      ...(r.skipped ? ['skipped — not in this backup'] : r.log),
      r.error ? `error: ${r.error}` : '',
    ]) ?? []),
    ...(run?.restart?.results.flatMap(r => [
      `── ${r.label} ──`,
      r.skipped ? `skipped${r.error ? `: ${r.error}` : ''}` : (r.success ? 'ok' : `error: ${r.error}`),
    ]) ?? []),
  ].filter(Boolean);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className={`bg-nms-surface border border-nms-border rounded-lg w-full flex flex-col max-h-[90vh] ${phase === 'selecting' ? 'max-w-2xl' : 'max-w-4xl'}`}>
        <div className="flex items-center justify-between p-4 border-b border-nms-border shrink-0">
          <div>
            <h2 className="text-xl font-bold font-display text-nms-text">
              {phase === 'selecting' ? 'Choose What to Restore' : phase === 'running' ? 'Restoring…' : 'Restore Finished'}
            </h2>
            {createdAt && (
              <p className="text-xs text-nms-text-dim">Backup taken: {new Date(createdAt).toLocaleString()}</p>
            )}
          </div>
          {phase !== 'running' && (
            <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
              <X className="w-6 h-6" />
            </button>
          )}
        </div>

        {phase === 'selecting' && (
          <>
            <div className="p-4 space-y-2 overflow-y-auto">
              {categories.map((cat) => {
                const isSelected = selected.has(cat.id);
                const disabled = !cat.present;
                return (
                  <button
                    key={cat.id}
                    onClick={() => !disabled && toggle(cat.id)}
                    disabled={disabled}
                    className={`w-full flex items-start gap-3 px-3 py-3 rounded-md text-left transition-colors border ${
                      disabled
                        ? 'bg-nms-bg text-nms-text-dim/50 border-nms-border cursor-not-allowed'
                        : isSelected
                          ? 'bg-nms-accent/10 text-nms-text border-nms-accent/30'
                          : 'bg-nms-surface text-nms-text-dim hover:bg-nms-surface-2 border-nms-border'
                    }`}
                  >
                    {disabled ? <Square className="w-4 h-4 shrink-0 mt-0.5" /> : isSelected ? <CheckSquare className="w-4 h-4 shrink-0 mt-0.5 text-nms-accent" /> : <Square className="w-4 h-4 shrink-0 mt-0.5" />}
                    <span className="shrink-0 mt-0.5">{ICONS[cat.id]}</span>
                    <span className="flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{cat.label}</span>
                        {!disabled && cat.itemCount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-nms-bg border border-nms-border text-nms-text-dim">
                            {cat.itemCount} item{cat.itemCount !== 1 ? 's' : ''}
                          </span>
                        )}
                        {disabled && <span className="text-[10px] text-nms-text-dim">not in this backup</span>}
                      </span>
                      <span className="block text-xs text-nms-text-dim mt-0.5">{cat.description}</span>
                    </span>
                  </button>
                );
              })}

              {presentModules.length > 0 && (
                <button
                  onClick={() => setFreshHost(f => !f)}
                  className={`w-full flex items-start gap-3 px-3 py-3 rounded-md text-left transition-colors border mt-1 ${
                    freshHost ? 'bg-nms-accent/10 text-nms-text border-nms-accent/30' : 'bg-nms-surface text-nms-text-dim hover:bg-nms-surface-2 border-nms-border'
                  }`}
                >
                  {freshHost ? <CheckSquare className="w-4 h-4 shrink-0 mt-0.5 text-nms-accent" /> : <Square className="w-4 h-4 shrink-0 mt-0.5" />}
                  <span className="flex-1">
                    <span className="font-semibold text-sm">This is a fresh host</span>
                    <span className="block text-xs text-nms-text-dim mt-0.5">
                      Install real packages/binaries for the {presentModules.length} optional module{presentModules.length === 1 ? '' : 's'} this backup used ({presentModules.join(', ')}) before writing any config. Skip this if restoring onto the same host these settings came from — it's already installed. Base packages (Docker, MongoDB, Open5GS itself) aren't covered here; run <code className="text-[11px]">backup-restore/bootstrap-fresh-host.sh</code> first on a genuinely new host.
                    </span>
                  </span>
                </button>
              )}
            </div>

            {(selected.has('l3-network') || selected.has('dns')) && (
              <div className="mx-4 mb-2 flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs shrink-0">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Restoring L3/IP or DNS config can break connectivity to this host if it differs from the host the backup was taken on. Only restore these onto the same physical box, or one with identical network topology.</span>
              </div>
            )}

            <div className="border-t border-nms-border bg-nms-bg p-4 flex items-center justify-between shrink-0">
              <div className="flex gap-2">
                <button onClick={selectAll} className="nms-btn-ghost text-xs">Select All</button>
                <button onClick={deselectAll} className="nms-btn-ghost text-xs">Deselect All</button>
              </div>
              <div className="flex gap-2">
                <button onClick={onClose} className="nms-btn-ghost">Cancel</button>
                <button
                  onClick={handleConfirm}
                  disabled={selected.size === 0}
                  className="nms-btn-primary"
                >
                  Restore {selected.size} Selected
                </button>
              </div>
            </div>
          </>
        )}

        {(phase === 'running' || phase === 'done') && (
          <div className="p-4 overflow-y-auto flex-1 min-h-0">
            <div className="flex items-center gap-2 text-sm text-nms-text mb-3">
              {phase === 'running' && <Loader2 className="w-4 h-4 animate-spin text-nms-accent shrink-0" />}
              <span className="font-medium">{phase === 'running' ? phaseLabel(run?.phase) : (run?.status === 'complete' ? 'Complete' : 'Failed')}</span>
            </div>

            {run?.bootstrap && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-nms-text-dim mb-1">Module install</div>
                {run.bootstrap.results.map(r => (
                  <div key={r.moduleId} className="flex items-center gap-2 py-1 text-xs text-nms-text">
                    <StatusIcon success={r.installed} skipped={r.skipped} />
                    <span>{r.label}</span>
                  </div>
                ))}
              </div>
            )}

            {run?.restoredCategories && (
              <div className="mb-3 text-xs text-nms-text-dim">
                Restored: {run.restoredCategories.join(', ')}
              </div>
            )}

            {run?.restart && (
              <div className="mb-3">
                <div className="text-xs font-semibold text-nms-text-dim mb-1">Restart / reapply</div>
                {run.restart.results.map(r => (
                  <div key={r.step} className="flex items-center gap-2 py-1 text-xs text-nms-text">
                    <StatusIcon success={r.success} skipped={r.skipped} />
                    <span>{r.label}</span>
                    {r.error && <span className="text-nms-text-dim">— {r.error}</span>}
                  </div>
                ))}
              </div>
            )}

            {run?.restoreError && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{run.restoreError}</span>
              </div>
            )}

            {logLines.length > 0 && <LogBlock lines={logLines} />}

            {phase === 'done' && run?.status === 'complete' && (
              <div className="mt-4 pt-3 border-t border-nms-border">
                <button
                  onClick={() => setShowIpPlan(s => !s)}
                  className="w-full flex items-start gap-3 px-3 py-3 rounded-md text-left transition-colors border bg-nms-surface text-nms-text-dim hover:bg-nms-surface-2 border-nms-border"
                >
                  <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="flex-1">
                    <span className="font-semibold text-sm text-nms-text">Re-address this host's IPs</span>
                    <span className="block text-xs text-nms-text-dim mt-0.5">
                      Restored config may not match this host's real network — propose and apply a new
                      IP plan right here, using the same IP Plan tool as the Auto-Configuration Wizard.
                    </span>
                  </span>
                </button>
                {showIpPlan && (
                  <div className="mt-3 rounded-md border border-nms-border bg-nms-bg p-3">
                    <IpPlanPanel />
                  </div>
                )}
              </div>
            )}

            {phase === 'done' && (
              <div className="flex justify-end mt-4 pt-3 border-t border-nms-border">
                <button onClick={onClose} className="nms-btn-primary">Close</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
