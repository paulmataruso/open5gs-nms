import { useState, useEffect, useCallback } from 'react';
import { Wallet, Plus, Pencil, Trash2, Users, Database, Phone, ChevronDown, ChevronUp, Power, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { chargingPlansApi, type ChargingPlan, type SubscriberUsage } from '../api';
import { imsApi, type ImsStatus } from '../api/ims';
import { useEscapeKey } from '../hooks/useKeyboardA11y';

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

function formatMinutes(seconds: number): string {
  return `${Math.floor(seconds / 60)} min`;
}

// The default "Unlimited" plan (backend: ensureDefaultUnlimitedPlan() in
// charging-plans-controller.ts) stores a very large finite cap rather than a
// dedicated no-cap sentinel — a real bucket, not a special case in the
// billing engine. 100,000 GB/min is a round number no operator would ever
// type by hand for a real cap, so it doubles safely as the "just show
// Unlimited" display threshold, independent of the plan's name.
const UNLIMITED_DATA_GB_THRESHOLD = 100_000;
const UNLIMITED_VOICE_MIN_THRESHOLD = 100_000;

function formatDataCap(gb: number): string {
  return gb >= UNLIMITED_DATA_GB_THRESHOLD ? 'Unlimited' : `${gb} GB`;
}
function formatVoiceCap(minutes: number): string {
  return minutes >= UNLIMITED_VOICE_MIN_THRESHOLD ? 'Unlimited' : `${minutes} min`;
}
function formatDataCapBytes(bytes: number): string {
  return formatDataCap(bytes / 1_000_000_000);
}
function formatVoiceCapSeconds(seconds: number): string {
  return formatVoiceCap(seconds / 60);
}

// Same used/total -> color/width convention as TrafficHistoryPage.tsx's own
// UsageBar (amber at 70%+, red at 90%+) — this file has its own copy since
// that one is module-local there, not exported.
function usageBarColor(used: number, total: number, baseColor: string): string {
  if (total <= 0) return baseColor;
  const pct = (used / total) * 100;
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return baseColor;
}
function UsageBar({ used, total, color }: { used: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return (
    <div className="w-full h-1 bg-nms-surface-2 rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: usageBarColor(used, total, color) }} />
    </div>
  );
}

function PlanModal({
  plan, onClose, onSaved,
}: {
  plan: ChargingPlan | null; // null = create new
  onClose: () => void;
  onSaved: () => void;
}) {
  // Escape closes this dialog (its backdrop closes on click, which the
  // keyboard has no equivalent for).
  useEscapeKey(onClose);

  const [name, setName] = useState(plan?.name ?? '');
  const [dataCapGB, setDataCapGB] = useState(plan?.dataCapGB ?? 5);
  const [voiceCapMinutes, setVoiceCapMinutes] = useState(plan?.voiceCapMinutes ?? 500);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim() || dataCapGB <= 0 || voiceCapMinutes <= 0) {
      toast.error('Name, data cap, and voice cap are all required (caps must be greater than 0)');
      return;
    }
    setSaving(true);
    try {
      const result = plan
        ? await chargingPlansApi.update(plan._id, { name, dataCapGB, voiceCapMinutes })
        : await chargingPlansApi.create(name, dataCapGB, voiceCapMinutes);
      if (!result.success) {
        toast.error(result.error || 'Save failed');
        return;
      }
      toast.success(plan ? `Updated "${name}"` : `Created "${name}"`);
      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-nms-surface border border-nms-border rounded-xl p-5 w-full max-w-sm space-y-4">
        <h2 className="text-lg font-semibold font-display">{plan ? 'Edit Plan' : 'New Plan'}</h2>
        <div>
          <label className="text-xs text-nms-text-dim block mb-1">Plan name</label>
          <input aria-label="Plan name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Standard" className="nms-input w-full" autoFocus />
        </div>
        <div>
          <label className="text-xs text-nms-text-dim block mb-1">Data cap (GB)</label>
          <input aria-label="Data cap (GB)" type="number" min={0.1} step={0.1} value={dataCapGB} onChange={e => setDataCapGB(Number(e.target.value))} className="nms-input w-full" />
        </div>
        <div>
          <label className="text-xs text-nms-text-dim block mb-1">Voice / airtime cap (minutes)</label>
          <input aria-label="Voice / airtime cap (minutes)" type="number" min={1} step={1} value={voiceCapMinutes} onChange={e => setVoiceCapMinutes(Number(e.target.value))} className="nms-input w-full" />
        </div>
        {plan && (
          <p className="text-xs text-amber-400">
            Changing caps only affects newly-assigned subscribers — it doesn't resize
            allowances already granted to subscribers currently on this plan.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="nms-btn-ghost">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="nms-btn-primary">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanCard({ plan, onEdit, onDeleted }: { plan: ChargingPlan; onEdit: () => void; onDeleted: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [usage, setUsage] = useState<Record<string, SubscriberUsage | null> | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadUsage = useCallback(async () => {
    setLoadingUsage(true);
    try {
      const data = await chargingPlansApi.usage(plan._id);
      setUsage(data);
    } catch {
      toast.error('Failed to load usage');
    } finally {
      setLoadingUsage(false);
    }
  }, [plan._id]);

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !usage) loadUsage();
  };

  const handleDelete = async () => {
    if (plan.imsis.length > 0) {
      toast.error(`${plan.imsis.length} subscriber(s) still on this plan — reassign them from the Subscribers page first.`);
      return;
    }
    if (!window.confirm(`Delete "${plan.name}"?`)) return;
    setDeleting(true);
    try {
      const result = await chargingPlansApi.delete(plan._id);
      if (!result.success) {
        toast.error(result.error || 'Delete failed');
        return;
      }
      toast.success(`Deleted "${plan.name}"`);
      onDeleted();
    } catch (err: any) {
      toast.error(`Delete failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="nms-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-nms-accent/10">
            <Wallet className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold font-display text-nms-text">{plan.name}</p>
            <div className="flex items-center gap-3 text-xs text-nms-text-dim mt-0.5">
              <span className="flex items-center gap-1"><Database className="w-3 h-3" /> {formatDataCap(plan.dataCapGB)}</span>
              <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {formatVoiceCap(plan.voiceCapMinutes)}</span>
              <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {plan.imsis.length} subscriber{plan.imsis.length === 1 ? '' : 's'}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleExpand} className="nms-btn-ghost text-xs px-2.5 py-1.5" title="Show usage">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button onClick={onEdit} className="nms-btn-ghost text-xs px-2.5 py-1.5" title="Edit plan">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={handleDelete} disabled={deleting} className="nms-btn-ghost text-xs px-2.5 py-1.5 text-red-400" title="Delete plan">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-nms-border">
          {plan.imsis.length === 0 ? (
            <p className="text-xs text-nms-text-dim">
              No subscribers on this plan yet — assign some from the Subscribers page
              ("Add to plan" in the bulk-select toolbar).
            </p>
          ) : loadingUsage ? (
            <p className="text-xs text-nms-text-dim">Loading usage…</p>
          ) : (
            <div className="nms-table-scroll"><table className="w-full text-xs">
              <thead>
                <tr className="text-left text-nms-text-dim border-b border-nms-border">
                  <th className="pb-2 font-medium">Subscriber</th>
                  <th className="pb-2 font-medium">Data Usage</th>
                  <th className="pb-2 font-medium">Voice Usage</th>
                </tr>
              </thead>
              <tbody>
                {plan.imsis.map(imsi => {
                  const u = usage?.[imsi];
                  return (
                    <tr key={imsi} className="border-b border-nms-border/50 last:border-0">
                      <td className="py-2 pr-3 font-mono text-nms-text-dim align-top">{imsi}</td>
                      {u ? (
                        <>
                          <td className="py-2 pr-3 align-top">
                            <div className="flex items-center justify-between text-nms-text mb-1">
                              <span className="flex items-center gap-1"><Database className="w-3 h-3 text-nms-text-dim" /> {formatBytes(u.dataUsedBytes)}</span>
                              <span className="text-nms-text-dim">/ {formatDataCapBytes(u.dataTotalBytes)}</span>
                            </div>
                            <UsageBar used={u.dataUsedBytes} total={u.dataTotalBytes} color="#38bdf8" />
                          </td>
                          <td className="py-2 align-top">
                            <div className="flex items-center justify-between text-nms-text mb-1">
                              <span className="flex items-center gap-1"><Phone className="w-3 h-3 text-nms-text-dim" /> {formatMinutes(u.voiceUsedSeconds)}</span>
                              <span className="text-nms-text-dim">/ {formatVoiceCapSeconds(u.voiceTotalSeconds)}</span>
                            </div>
                            <UsageBar used={u.voiceUsedSeconds} total={u.voiceTotalSeconds} color="#10b981" />
                          </td>
                        </>
                      ) : (
                        <td className="py-2 text-nms-text-dim" colSpan={2}>not provisioned yet</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </div>
      )}
    </div>
  );
}

function VoiceChargingCard({ imsStatus, onChanged }: { imsStatus: ImsStatus | null; onChanged: () => void }) {
  const [toggling, setToggling] = useState(false);
  if (!imsStatus?.hasSavedConfig) return null; // IMS isn't set up at all — nothing to toggle yet

  const enabled = imsStatus.voiceChargingEnabled;
  const available = imsStatus.ocsAvailable;

  const handleToggle = async () => {
    if (!enabled && !window.confirm(
      "Enable voice/airtime charging?\n\nThis restarts the live S-CSCF (Kamailio) — every real call will be " +
      "torn down mid-call if its subscriber runs out of granted minutes. Make sure subscribers who need to " +
      "keep calling are assigned to a plan with enough voice minutes first.",
    )) {
      return;
    }
    setToggling(true);
    try {
      await imsApi.setVoiceCharging(!enabled);
      toast.success(!enabled ? 'Voice charging enabled — S-CSCF restarted' : 'Voice charging disabled — S-CSCF restarted');
      onChanged();
    } catch (err: any) {
      toast.error(`Failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="nms-card">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-nms-accent/10">
            <Phone className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold font-display text-nms-text">Voice / Airtime Charging</p>
            <p className="text-xs text-nms-text-dim mt-0.5">
              {enabled
                ? 'Live — real calls are metered against each subscriber\'s plan and torn down when minutes run out.'
                : available
                  ? 'Off — calls are not metered. Data caps still work independently.'
                  : 'Set up SigScale OCS first (SigScale OCS page) before enabling this.'}
            </p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          disabled={toggling || (!enabled && !available)}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            enabled
              ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/25'
              : 'bg-nms-surface-2 text-nms-text-dim border-nms-border hover:text-nms-text'
          }`}
        >
          <Power className="w-3 h-3" />
          {toggling ? '…' : enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>
      {!enabled && available && (
        <div className="mt-3 pt-3 border-t border-nms-border flex items-start gap-2 text-xs text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Make sure every subscriber who needs to keep calling has a plan with enough voice
            minutes assigned before enabling — a subscriber with no plan is treated as out of credit.
          </span>
        </div>
      )}
    </div>
  );
}

export function ChargingPlansPage() {
  const [plans, setPlans] = useState<ChargingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalPlan, setModalPlan] = useState<ChargingPlan | null | 'new'>(null);
  const [imsStatus, setImsStatus] = useState<ImsStatus | null>(null);

  const load = useCallback(() => {
    chargingPlansApi.list().then(setPlans).catch(() => toast.error('Failed to load plans')).finally(() => setLoading(false));
  }, []);
  const loadImsStatus = useCallback(() => {
    imsApi.getStatus().then(setImsStatus).catch(() => {});
  }, []);
  useEffect(() => { load(); loadImsStatus(); }, [load, loadImsStatus]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">Charging Plans</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Simple data and voice/airtime caps for subscribers — assign a plan from the
            Subscribers page. Backed by SigScale OCS; full rating/billing detail stays in
            OCS's own web GUI.
          </p>
        </div>
        <button onClick={() => setModalPlan('new')} className="nms-btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Plan
        </button>
      </div>

      <VoiceChargingCard imsStatus={imsStatus} onChanged={loadImsStatus} />

      {loading ? (
        <div className="nms-card text-sm text-nms-text-dim">Loading…</div>
      ) : plans.length === 0 ? (
        <div className="nms-card text-sm text-nms-text-dim text-center py-10">
          No plans yet — create one to start capping subscriber data and voice usage.
        </div>
      ) : (
        <div className="space-y-3">
          {plans.map(plan => (
            <PlanCard key={plan._id} plan={plan} onEdit={() => setModalPlan(plan)} onDeleted={load} />
          ))}
        </div>
      )}

      {modalPlan && (
        <PlanModal
          plan={modalPlan === 'new' ? null : modalPlan}
          onClose={() => setModalPlan(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
