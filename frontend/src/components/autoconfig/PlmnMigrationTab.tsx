import { useState, useEffect, useRef } from 'react';
import {
  Globe, RefreshCw, ChevronDown, Database, Play, RotateCcw, AlertTriangle,
  CheckCircle, XCircle, ShieldAlert,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  plmnMigrationApi, PlmnMigrationPlan, PhaseResult, MigrationBackupInfo,
  MigrationBackupListItem, PlmnMigrationPhase,
} from '../../api/plmn-migration';

const PHASES: { id: PlmnMigrationPhase; title: string; description: string }[] = [
  {
    id: 'a',
    title: 'Core plmn_id + DNS',
    description: "Rewrites mme.yaml's gummei/tai and amf.yaml's guami/tai/plmn_support (plus smf.yaml's info[].tai[].plmn_id, if present) to the new PLMN, then generates the 5gc/epc BIND zones and verifies every FQDN resolves. No service is restarted yet.",
  },
  {
    id: 'b',
    title: 'EPC/Diameter Mesh',
    description: 'Rewrites mme/hss/pcrf/smf freeDiameter confs to the new realm and restarts those 4 services — this is when mme/smf actually pick up the new plmn_id written in Phase A.',
  },
  {
    id: 'c',
    title: '5GC SBI Mesh',
    description: "Rewrites every NF's client.nrf/client.scp URI to the new domain and restarts all 11 SBI-mesh NFs (NRF first) — this is when AMF picks up the new guami/tai/plmn_support.",
  },
  {
    id: 'd',
    title: 'IMS → SMS → VoWiFi',
    description: 'Reconfigures each optional module in this strict order (VoWiFi depends on Phase B/C already having landed). Any module not installed on this host is skipped with a note, not an error.',
  },
  {
    id: 'e',
    title: 'Verification',
    description: 'Cross-checks every service (mme/hss/pcrf/amf/smf/IMS/VoWiFi) actually agrees on the new PLMN and is active. No writes.',
  },
];

function LogBlock({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-3">
      {lines.join('\n')}
    </pre>
  );
}

function ExclusionsCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="nms-card">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-nms-accent shrink-0" />
          <span className="text-sm font-semibold text-nms-text">What This Wizard Does NOT Touch</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-4 space-y-2 text-sm text-nms-text-dim leading-relaxed">
          <p><span className="text-nms-text font-medium">SAS/CBRS —</span> fully out of scope. CBSD registration keys purely on fccId/cbsdSerialNumber, never mcc/mnc.</p>
          <p><span className="text-nms-text font-medium">Radios / TR-069 provisioning —</span> Baicells/Sercomm eNB/gNB PLMN broadcast is NOT reprovisioned by this wizard. Reprovision radios yourself afterward if needed.</p>
          <p><span className="text-nms-text font-medium">Subscriber records —</span> IMSI/Ki are untouched. SMS's sgsap map entry and IMS's PyHSS routing config are "subscriber-adjacent" — they change how the network routes to existing subscribers under the new PLMN, without touching the subscriber records themselves.</p>
        </div>
      )}
    </div>
  );
}

export function PlmnMigrationTab(): JSX.Element {
  const [targetMcc, setTargetMcc] = useState('');
  const [targetMnc, setTargetMnc] = useState('');
  const [plan, setPlan] = useState<PlmnMigrationPlan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [backup, setBackup] = useState<MigrationBackupInfo | null>(null);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [backups, setBackups] = useState<MigrationBackupListItem[]>([]);
  const [selectedBackupId, setSelectedBackupId] = useState('');
  const [applyingPhase, setApplyingPhase] = useState<PlmnMigrationPhase | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [phaseResults, setPhaseResults] = useState<Record<PlmnMigrationPhase, PhaseResult | null>>({
    a: null, b: null, c: null, d: null, e: null,
  });

  const loadBackups = async () => {
    try {
      const list = await plmnMigrationApi.listBackups();
      setBackups(list);
      if (!selectedBackupId && list.length > 0) setSelectedBackupId(list[0].id);
    } catch { /* ignore */ }
  };

  useEffect(() => { loadBackups(); }, []);

  const handleLoadPlan = async () => {
    if (!/^\d{3}$/.test(targetMcc)) { toast.error('MCC must be exactly 3 digits'); return; }
    if (!/^\d{2,3}$/.test(targetMnc)) { toast.error('MNC must be 2 or 3 digits'); return; }
    setLoadingPlan(true);
    try {
      const p = await plmnMigrationApi.getPlan(targetMcc, targetMnc);
      setPlan(p);
      setBackup(null);
      setPhaseResults({ a: null, b: null, c: null, d: null, e: null });
      toast.success('Migration plan loaded');
    } catch (err: any) {
      toast.error(`Failed to load plan: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setLoadingPlan(false);
    }
  };

  const handleCreateBackup = async () => {
    if (!plan) return;
    setCreatingBackup(true);
    try {
      const info = await plmnMigrationApi.createBackup(plan.newMcc, plan.newMnc);
      setBackup(info);
      toast.success(`Backup created: ${info.backupId}`);
      await loadBackups();
      setSelectedBackupId(info.backupId);
    } catch (err: any) {
      toast.error(`Backup failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleApplyPhase = async (phase: PlmnMigrationPhase) => {
    if (!plan || !backup) {
      toast.error('Create a migration backup first');
      return;
    }
    const label = phase.toUpperCase();
    const restartNote = phase === 'e' ? '' : phase === 'a' ? ' (writes plmn_id + DNS zones, no restarts)' : ' and restarts services';
    if (!confirm(`Apply Phase ${label}? This writes to live config on the host${restartNote}.`)) return;
    setApplyingPhase(phase);
    try {
      const result = await plmnMigrationApi.applyPhase(phase, plan.newMcc, plan.newMnc);
      setPhaseResults(prev => ({ ...prev, [phase]: result }));
      if (result.success) toast.success(`Phase ${label} applied`);
      else toast.error(`Phase ${label} failed — see log`);
    } catch (err: any) {
      toast.error(`Phase ${label} request failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setApplyingPhase(null);
    }
  };

  const handleRollback = async () => {
    if (!selectedBackupId) return;
    if (!confirm(`Roll back to migration backup ${selectedBackupId}? This restores NF yaml, freeDiameter confs, BIND config, and IMS/VoWiFi state, then restarts every affected service.`)) return;
    setRollingBack(true);
    try {
      const result = await plmnMigrationApi.rollback(selectedBackupId);
      if (result.success) {
        toast.success('Rollback complete');
        setPhaseResults({ a: null, b: null, c: null, d: null, e: null });
      } else {
        toast.error('Rollback reported failure — see log');
      }
      setPhaseResults(prev => ({ ...prev, a: result }));
    } catch (err: any) {
      toast.error(`Rollback failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setRollingBack(false);
    }
  };

  const phaseCard = (phase: PlmnMigrationPhase, title: string, description: string) => {
    const result = phaseResults[phase];
    return (
      <div className="nms-card" key={phase}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-nms-text flex items-center gap-2">
              Phase {phase.toUpperCase()} — {title}
              {result && (result.success
                ? <CheckCircle className="w-4 h-4 text-green-400" />
                : <XCircle className="w-4 h-4 text-red-400" />)}
            </h3>
            <p className="text-xs text-nms-text-dim mt-1">{description}</p>
          </div>
          <button
            onClick={() => handleApplyPhase(phase)}
            disabled={!plan || !backup || applyingPhase !== null}
            className="nms-btn-primary flex items-center gap-2 text-sm shrink-0"
          >
            <Play className="w-4 h-4" />
            {applyingPhase === phase ? 'Applying…' : `Apply Phase ${phase.toUpperCase()}`}
          </button>
        </div>
        {result && <LogBlock lines={result.details} />}
        {result?.error && <p className="text-xs text-red-400 mt-2">{result.error}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold font-display">PLMN Migration Wizard</h2>
        <p className="text-sm text-nms-text-dim mt-1">
          Replace the current MCC/MNC across the core 17 NFs, DNS, IMS/VoLTE, SMS, and VoWiFi in one coordinated operation.
        </p>
      </div>

      <ExclusionsCard />

      {/* Target PLMN input */}
      <div className="nms-card">
        <h3 className="text-sm font-semibold text-nms-accent mb-3">Target PLMN</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">New MCC</label>
            <input
              className="nms-input font-mono text-sm w-28"
              placeholder="999"
              maxLength={3}
              value={targetMcc}
              onChange={e => setTargetMcc(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">New MNC</label>
            <input
              className="nms-input font-mono text-sm w-28"
              placeholder="070"
              maxLength={3}
              value={targetMnc}
              onChange={e => setTargetMnc(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <button onClick={handleLoadPlan} disabled={loadingPlan} className="nms-btn-ghost flex items-center gap-2 text-sm">
            <RefreshCw className={clsx('w-4 h-4', loadingPlan && 'animate-spin')} /> {plan ? 'Reload Plan' : 'Load Migration Plan'}
          </button>
        </div>
        <p className="text-xs text-nms-text-dim mt-2">This is a dry run — nothing is written until you create a backup and apply a phase below.</p>
      </div>

      {plan && (
        <>
          {/* Preview */}
          <div className="nms-card">
            <h2 className="text-sm font-semibold text-nms-accent mb-3">Preview</h2>
            <p className="text-xs text-nms-text-dim mb-3">
              <span className="font-mono text-red-400/80">{plan.oldMcc}/{plan.oldMnc}</span>
              {' '}→{' '}
              <span className="font-mono text-green-400/80">{plan.newMcc}/{plan.newMnc}</span>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs mb-3">
              <div className="px-3 py-2 rounded border border-nms-border">
                <span className="text-nms-text-dim">IMS domain: </span>
                <span className="font-mono text-red-400/80">{plan.oldImsDomain}</span> → <span className="font-mono text-green-400/80">{plan.newImsDomain}</span>
                <span className={clsx('ml-2', plan.imsInstalled ? 'text-green-400' : 'text-nms-text-dim')}>
                  {plan.imsInstalled ? '[configured]' : '[not configured — will skip]'}
                </span>
              </div>
              <div className="px-3 py-2 rounded border border-nms-border">
                <span className="text-nms-text-dim">VoWiFi pub domain: </span>
                <span className="font-mono text-red-400/80">{plan.oldPubDomain}</span> → <span className="font-mono text-green-400/80">{plan.newPubDomain}</span>
                <span className={clsx('ml-2', plan.vowifiInstalled ? 'text-green-400' : 'text-nms-text-dim')}>
                  {plan.vowifiInstalled ? '[configured]' : '[not configured — will skip]'}
                </span>
              </div>
            </div>
            <p className="text-xs text-nms-text-dim mb-3">
              SMS (SGs): <span className={clsx(plan.smsConfigured ? 'text-green-400' : 'text-nms-text-dim')}>
                {plan.smsConfigured ? 'configured — will reconfigure' : 'not configured — will skip'}
              </span>
            </p>

            {plan.warnings.length > 0 && (
              <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-1.5">
                {plan.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Backup & confirm */}
          <div className="nms-card">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-sm font-semibold text-nms-accent flex items-center gap-2">
                  <Database className="w-4 h-4" /> Backup & Confirm
                </h2>
                <p className="text-xs text-nms-text-dim mt-1">
                  Backs up NF yaml, freeDiameter confs, BIND config, and IMS/VoWiFi state before any phase writes anything.
                  Required before Phase A–E become clickable.
                </p>
                {backup && (
                  <p className="text-xs text-nms-green mt-2 font-mono">Backup ready: {backup.backupId}</p>
                )}
              </div>
              <button onClick={handleCreateBackup} disabled={creatingBackup} className="nms-btn-primary flex items-center gap-2 text-sm shrink-0">
                <Database className="w-4 h-4" /> {creatingBackup ? 'Backing up…' : 'Create Migration Backup'}
              </button>
            </div>
          </div>

          {/* Phases */}
          {PHASES.map(p => phaseCard(p.id, p.title, p.description))}

          {/* Rollback */}
          <div className="nms-card border-red-500/20">
            <h2 className="text-sm font-semibold text-nms-red flex items-center gap-2 mb-1">
              <RotateCcw className="w-4 h-4" /> Rollback
            </h2>
            <p className="text-xs text-nms-text-dim mb-3">
              Restores NF yaml, freeDiameter confs, BIND config, and IMS/VoWiFi state from a migration backup, then restarts every affected service.
            </p>
            <div className="flex items-center gap-3">
              <select
                className="nms-input font-mono text-xs"
                value={selectedBackupId}
                onChange={e => setSelectedBackupId(e.target.value)}
              >
                <option value="">— Select a backup —</option>
                {backups.map(b => (
                  <option key={b.id} value={b.id}>{b.id} ({new Date(b.createdAt).toLocaleString()})</option>
                ))}
              </select>
              <button
                onClick={handleRollback}
                disabled={!selectedBackupId || rollingBack}
                className="nms-btn-ghost text-red-400 border-red-500/30 hover:border-red-500/60 flex items-center gap-2 text-sm shrink-0"
              >
                <RotateCcw className="w-4 h-4" /> {rollingBack ? 'Rolling back…' : 'Rollback to Selected Backup'}
              </button>
            </div>
          </div>
        </>
      )}

      {!plan && (
        <div className="nms-card border-dashed border-nms-border text-center py-10">
          <Globe className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
          <p className="text-sm text-nms-text-dim">No plan loaded yet.</p>
          <p className="text-xs text-nms-text-dim mt-1">Enter the new MCC/MNC above and click <strong>Load Migration Plan</strong> — this is a dry run, nothing is written.</p>
        </div>
      )}
    </div>
  );
}
