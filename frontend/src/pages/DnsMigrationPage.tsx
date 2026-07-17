import { useState, useEffect, useRef } from 'react';
import { Globe, RefreshCw, ChevronDown, Database, Play, RotateCcw, AlertTriangle, CheckCircle, XCircle, RotateCw } from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  dnsMigrationApi, DnsMigrationPlan, PhaseResult, MigrationBackupInfo, MigrationBackupListItem, DnsEntry,
} from '../api/dns-migration';

// Short, one-line descriptions for the post-migration summary table — not the long
// FunctionInfoBox paragraphs used elsewhere, just enough to remind someone what each
// row actually is at a glance.
const NF_DESCRIPTIONS: Record<string, string> = {
  nrf:  'Service registry — every NF discovers its peers through here',
  scp:  'Indirect-communication proxy for NF-to-NF service calls',
  amf:  'Access & Mobility Management — UE registration and mobility',
  smf:  'Session Management — PDU sessions and UPF/SGW-U selection',
  ausf: 'Authentication Server — performs UE authentication',
  udm:  'Unified Data Management — subscriber identity & auth vectors',
  udr:  'Unified Data Repository — raw subscriber data storage',
  pcf:  'Policy Control — QoS and charging policy rules',
  bsf:  'Binding Support — tracks which PCF handles each session',
  nssf: 'Network Slice Selection — picks the slice for a UE',
  mme:  'Mobility Management Entity — 4G mobility & session control',
  hss:  'Home Subscriber Server — 4G subscriber database & auth',
  pcrf: 'Policy & Charging Rules — 4G policy control (Gx/Rx)',
};

function nfNameFromFqdn(fqdn: string): string {
  return fqdn.split('.')[0];
}

function MigrationSummaryTable({ plan, onRerun }: { plan: DnsMigrationPlan; onRerun: () => void }): JSX.Element {
  const sgcRows = plan.dnsEntries.filter(e => e.zone === '5gc');
  const epcRows = plan.dnsEntries.filter(e => e.zone === 'epc');

  const table = (title: string, rows: DnsEntry[]) => (
    <div>
      <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">{title}</h3>
      <div className="border border-nms-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-nms-surface-2 text-left text-xs text-nms-text-dim uppercase tracking-wider">
              <th className="px-4 py-2 font-semibold">Function</th>
              <th className="px-4 py-2 font-semibold">FQDN</th>
              <th className="px-4 py-2 font-semibold">IP Address</th>
              <th className="px-4 py-2 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const name = nfNameFromFqdn(row.fqdn);
              return (
                <tr key={row.fqdn} className="border-t border-nms-border">
                  <td className="px-4 py-2 font-semibold text-nms-text uppercase">{name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-nms-text">{row.fqdn}</td>
                  <td className="px-4 py-2 font-mono text-xs text-nms-text-dim">{row.ip}</td>
                  <td className="px-4 py-2 text-xs text-nms-text-dim">{NF_DESCRIPTIONS[name] ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="nms-card border-green-500/20 bg-green-500/5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-nms-text">FQDN migration applied</p>
              <p className="text-xs text-nms-text-dim mt-0.5">
                PLMN {plan.mcc}/{plan.mnc} — 5GC zone <span className="font-mono">{plan.sgcDomain}</span>,
                {' '}EPC zone <span className="font-mono">{plan.epcDomain}</span>
              </p>
            </div>
          </div>
          <button onClick={onRerun} className="nms-btn-ghost flex items-center gap-2 text-sm shrink-0">
            <RotateCw className="w-4 h-4" /> Re-run Wizard
          </button>
        </div>
      </div>

      {table('5G Core — SBI Mesh', sgcRows)}
      {table('4G EPC — Diameter Mesh', epcRows)}
    </div>
  );
}

function LogBlock({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-3">
      {lines.join('\n')}
    </pre>
  );
}

function OverviewCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="nms-card">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-nms-accent shrink-0" />
          <span className="text-sm font-semibold text-nms-text">How This Migration Works</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-4 space-y-3 text-sm text-nms-text-dim leading-relaxed">
          <p>
            Every open5gs NF in this deployment currently addresses its peers by hardcoded loopback
            IP. Carrier-grade deployments use DNS-based FQDN discovery instead, matching the open5gs
            roaming tutorial's own setup and 3GPP TS 23.003. This wizard converts the core to that
            scheme in three independent phases, each separately backed up and rollback-able.
          </p>
          <ul className="space-y-1.5">
            <li><span className="text-nms-text font-medium">Phase A — DNS only.</span> Generates the two new zones and verifies every record resolves. Touches no NF config. Zero risk.</li>
            <li><span className="text-nms-text font-medium">Phase B — EPC/Diameter mesh.</span> Rewrites mme/hss/pcrf/smf freeDiameter confs to reference each other by FQDN instead of a pinned IP.</li>
            <li><span className="text-nms-text font-medium">Phase C — 5GC SBI mesh.</span> Rewrites every NF's client.nrf/client.scp URI to the FQDN form.</li>
          </ul>
          <p>
            SEPP1's local SBI (to our own SCP/NRF) is migrated like any other NF — only its N32
            interface to the visited PLMN's SEPP is left alone, since that peer belongs to another
            operator entirely. All GTP-C/GTP-U/S1AP/PFCP bearer-plane addresses are also
            intentionally left as IPs — see the warnings list in the preview for why. Run a fresh
            backup before Phase B or C — a rollback button stays available as long as that backup exists.
          </p>
        </div>
      )}
    </div>
  );
}

export function DnsMigrationPage(): JSX.Element {
  const [mode, setMode] = useState<'summary' | 'wizard' | null>(null); // null = still checking status
  const [plan, setPlan] = useState<DnsMigrationPlan | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [backup, setBackup] = useState<MigrationBackupInfo | null>(null);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [backups, setBackups] = useState<MigrationBackupListItem[]>([]);
  const [selectedBackupId, setSelectedBackupId] = useState('');
  const [applyingPhase, setApplyingPhase] = useState<'a' | 'b' | 'c' | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [phaseResults, setPhaseResults] = useState<Record<'a' | 'b' | 'c', PhaseResult | null>>({ a: null, b: null, c: null });

  const loadBackups = async () => {
    try {
      const list = await dnsMigrationApi.listBackups();
      setBackups(list);
      if (!selectedBackupId && list.length > 0) setSelectedBackupId(list[0].id);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadBackups();
    // If a migration has already been applied on this host, default to the summary
    // table instead of the empty wizard landing — the wizard is for making a change,
    // not for checking what's already there.
    (async () => {
      try {
        const { migrated } = await dnsMigrationApi.getStatus();
        if (migrated) {
          const p = await dnsMigrationApi.getPlan();
          setPlan(p);
          setMode('summary');
        } else {
          setMode('wizard');
        }
      } catch {
        setMode('wizard');
      }
    })();
  }, []);

  const handleLoadPlan = async () => {
    setLoadingPlan(true);
    try {
      const p = await dnsMigrationApi.getPlan();
      setPlan(p);
      toast.success('Migration plan loaded');
    } catch (err: any) {
      toast.error(`Failed to load plan: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setLoadingPlan(false);
    }
  };

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      const info = await dnsMigrationApi.createBackup();
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

  const handleApplyPhase = async (phase: 'a' | 'b' | 'c') => {
    if (!backup) {
      toast.error('Create a migration backup first');
      return;
    }
    const label = phase.toUpperCase();
    if (!confirm(`Apply Phase ${label}? This writes to live config${phase !== 'a' ? ' and restarts services' : ''} on the host.`)) return;
    setApplyingPhase(phase);
    try {
      const result = await dnsMigrationApi.applyPhase(phase);
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
    if (!confirm(`Roll back to migration backup ${selectedBackupId}? This restores NF yaml, freeDiameter confs, and BIND config, then restarts every core service.`)) return;
    setRollingBack(true);
    try {
      const result = await dnsMigrationApi.rollback(selectedBackupId);
      if (result.success) {
        toast.success('Rollback complete');
        setPhaseResults({ a: null, b: null, c: null });
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

  const phaseCard = (phase: 'a' | 'b' | 'c', title: string, description: string) => {
    const result = phaseResults[phase];
    return (
      <div className="nms-card">
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

  if (mode === null) {
    return (
      <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Checking migration status…
      </div>
    );
  }

  if (mode === 'summary' && plan) {
    return (
      <div className="p-6">
        <MigrationSummaryTable plan={plan} onRerun={() => setMode('wizard')} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">DNS/FQDN Migration Wizard</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Convert this core from hardcoded IP addressing to 3GPP FQDN/DNS-based NF discovery
          </p>
        </div>
        <button onClick={handleLoadPlan} disabled={loadingPlan} className="nms-btn-ghost flex items-center gap-2 text-sm">
          <RefreshCw className={clsx('w-4 h-4', loadingPlan && 'animate-spin')} /> {plan ? 'Reload Plan' : 'Load Migration Plan'}
        </button>
      </div>

      <OverviewCard />

      {!plan && (
        <div className="nms-card border-dashed border-nms-border text-center py-10">
          <Globe className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
          <p className="text-sm text-nms-text-dim">No plan loaded yet.</p>
          <p className="text-xs text-nms-text-dim mt-1">Click <strong>Load Migration Plan</strong> above — this is a dry run, nothing is written.</p>
        </div>
      )}

      {plan && (
        <>
          {/* Preview */}
          <div className="nms-card">
            <h2 className="text-sm font-semibold text-nms-accent mb-3">Preview</h2>
            <p className="text-xs text-nms-text-dim mb-3">
              PLMN {plan.mcc}/{plan.mnc} — 5GC zone <span className="font-mono text-nms-text">{plan.sgcDomain}</span>,
              {' '}EPC zone <span className="font-mono text-nms-text">{plan.epcDomain}</span>
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-nms-text-dim mb-2">DNS Records ({plan.dnsEntries.length})</h3>
                <div className="border border-nms-border rounded-md max-h-48 overflow-y-auto">
                  {plan.dnsEntries.map(e => (
                    <div key={e.fqdn} className="flex items-center justify-between px-3 py-1.5 border-b border-nms-border last:border-b-0 text-xs">
                      <span className="font-mono text-nms-text truncate">{e.fqdn}</span>
                      <span className="font-mono text-nms-text-dim shrink-0 ml-2">{e.ip}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-nms-text-dim mb-2">SBI Client Changes ({plan.sbiChanges.length})</h3>
                <div className="border border-nms-border rounded-md max-h-48 overflow-y-auto">
                  {plan.sbiChanges.map((c, i) => (
                    <div key={i} className="px-3 py-1.5 border-b border-nms-border last:border-b-0 text-xs">
                      <span className="font-mono text-nms-text">{c.service}</span>
                      <span className="text-nms-text-dim"> {c.field}: </span>
                      <span className="font-mono text-red-400/80">{c.oldUri}</span>
                      <span className="text-nms-text-dim"> → </span>
                      <span className="font-mono text-green-400/80">{c.newUri}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <h3 className="text-xs font-semibold uppercase tracking-wider text-nms-text-dim mb-2">freeDiameter Changes ({plan.freeDiameterChanges.length})</h3>
            <div className="border border-nms-border rounded-md max-h-48 overflow-y-auto mb-4">
              {plan.freeDiameterChanges.map(c => (
                <div key={c.file} className="px-3 py-2 border-b border-nms-border last:border-b-0 text-xs">
                  <span className="font-mono text-nms-text">{c.file}</span>: Identity{' '}
                  <span className="font-mono text-red-400/80">{c.identityOld}</span> →{' '}
                  <span className="font-mono text-green-400/80">{c.identityNew}</span>, Realm{' '}
                  <span className="font-mono text-red-400/80">{c.realmOld}</span> →{' '}
                  <span className="font-mono text-green-400/80">{c.realmNew}</span>
                  {c.peers.length > 0 && (
                    <div className="mt-1 text-nms-text-dim">
                      {c.peers.map(p => (
                        <div key={p.peer}>
                          peer <span className="font-mono">{p.identityOld}</span> → <span className="font-mono">{p.identityNew}</span>,
                          {' '}dropped ConnectTo <span className="font-mono">{p.droppedConnectTo}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

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
                  Backs up NF yaml, freeDiameter confs, and BIND config before any phase writes anything.
                  Required before Phase A/B/C become clickable.
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
          {phaseCard('a', 'DNS Only', 'Generates the 5gc/epc BIND zones and verifies every FQDN resolves via dig. Touches no NF config — zero risk.')}
          {phaseCard('b', 'EPC/Diameter Mesh', 'Rewrites mme/hss/pcrf/smf freeDiameter confs to reference each other by FQDN, dropping the pinned ConnectTo IP. Restarts those 4 services.')}
          {phaseCard('c', '5GC SBI Mesh', "Rewrites every NF's client.nrf/client.scp/client.nsi URI to the FQDN form. Restarts NRF first, then dependents in order.")}

          {/* Rollback */}
          <div className="nms-card border-red-500/20">
            <h2 className="text-sm font-semibold text-nms-red flex items-center gap-2 mb-1">
              <RotateCcw className="w-4 h-4" /> Rollback
            </h2>
            <p className="text-xs text-nms-text-dim mb-3">
              Restores NF yaml, freeDiameter confs, and BIND config from a migration backup, then restarts every core service.
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
    </div>
  );
}
