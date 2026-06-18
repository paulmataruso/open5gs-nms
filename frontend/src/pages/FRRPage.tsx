import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw, AlertTriangle, CheckCircle, XCircle,
  ChevronRight, RotateCcw, Eye, Shield, Play, Settings, BookOpen, ChevronDown,
  Filter, Plus, Trash2, ArrowDown, ArrowUp, Activity, Radio, GitBranch, Terminal,
  Globe, Layers,
} from 'lucide-react';
import { frrApi, UeSubnet } from '../api/frr';
import { TunInterfacePage } from './TunInterfacePage';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';

type Phase =
  | 'INIT' | 'BACKUP_CREATED' | 'FRR_INSTALLED' | 'TRANSIT_CONFIGURED'
  | 'NEIGHBOR_UP' | 'DUMMY_INTERFACES_CREATED' | 'SERVICE_DUAL_STACK_ACTIVE'
  | 'LEGACY_INTERFACES_REMOVED' | 'CUTOVER_COMPLETE';

type Protocol = 'eigrp' | 'ospf' | 'bgp';

interface ServiceMapping { service: string; ip: string; dummyName: string; }
interface IfaceInfo { name: string; addresses: string[]; state: string; isMgmt: boolean; }
interface RouteFilter { id: string; name: string; direction: 'in' | 'out'; action: 'permit' | 'deny'; seq: number; prefixes: string[]; description?: string; }

const PHASE_ORDER: Phase[] = [
  'INIT', 'BACKUP_CREATED', 'FRR_INSTALLED', 'TRANSIT_CONFIGURED',
  'NEIGHBOR_UP', 'DUMMY_INTERFACES_CREATED', 'SERVICE_DUAL_STACK_ACTIVE',
  'LEGACY_INTERFACES_REMOVED', 'CUTOVER_COMPLETE',
];

const PHASE_LABELS: Record<Phase, string> = {
  INIT: 'Not started', BACKUP_CREATED: 'Backup created', FRR_INSTALLED: 'FRR installed',
  TRANSIT_CONFIGURED: 'Transit configured', NEIGHBOR_UP: 'Neighbor established',
  DUMMY_INTERFACES_CREATED: 'VSIs created', SERVICE_DUAL_STACK_ACTIVE: 'Service IPs advertised',
  LEGACY_INTERFACES_REMOVED: 'Legacy IPs removed', CUTOVER_COMPLETE: 'Migration complete',
};

const REWIND_TO: Partial<Record<Phase, Phase>> = {
  BACKUP_CREATED: 'INIT', FRR_INSTALLED: 'BACKUP_CREATED', TRANSIT_CONFIGURED: 'FRR_INSTALLED',
  NEIGHBOR_UP: 'TRANSIT_CONFIGURED', DUMMY_INTERFACES_CREATED: 'NEIGHBOR_UP',
  SERVICE_DUAL_STACK_ACTIVE: 'DUMMY_INTERFACES_CREATED', LEGACY_INTERFACES_REMOVED: 'SERVICE_DUAL_STACK_ACTIVE',
};

// ─── Architecture card ────────────────────────────────────────────────────────

function ArchitectureCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="nms-card">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-nms-accent shrink-0" />
          <span className="text-sm font-semibold text-nms-text">Pre-flight Requirements &amp; Architecture Overview</span>
          <span className="text-xs text-nms-text-dim">— read before starting</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-5 space-y-6 text-sm">

          {/* Architecture diagram */}
          <img src="/images/open5gs-frr-diagram.png" alt="Open5GS FRR architecture diagram" className="w-full rounded-lg border border-nms-border" />

          {/* What this wizard does */}
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">What this wizard does</h3>
            <p className="text-nms-text-dim leading-relaxed">
              This wizard migrates Open5GS from a flat Layer 2 network (all service IPs on one interface) to a
              routed Layer 3 design. Each service IP (AMF, UPF, S1MME, etc.) is moved onto its own
              dedicated <span className="text-nms-text font-medium">Virtual Service Interface (VSI)</span> — a Linux dummy interface with a /32 address.
              Those /32s are then advertised to your upstream core router via a dynamic routing protocol (EIGRP, OSPF, or BGP)
              over a dedicated transit link.
            </p>
          </div>

          {/* Three interface requirement */}
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">Required: 3 physical interfaces</h3>
            <div className="space-y-3">

              <div className="flex items-start gap-3 bg-nms-bg border border-nms-border rounded-xl p-4">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-blue-400">1</span>
                </div>
                <div>
                  <p className="font-semibold text-nms-text">Management Interface <span className="text-xs font-normal text-nms-text-dim ml-1">(e.g. ens18, eth0)</span></p>
                  <p className="text-xs text-nms-text-dim mt-1 leading-relaxed">
                    Your out-of-band access interface — SSH, NMS WebUI, etc. This interface is
                    <span className="text-amber-400 font-medium"> never touched</span> by the wizard.
                    It must be on a separate network segment from the transit and service links.
                    If you lose access through this interface, you will be locked out.
                    <span className="text-red-400 font-medium"> Ensure you have console or IPMI access before proceeding.</span>
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 bg-nms-bg border border-nms-border rounded-xl p-4">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-amber-400">2</span>
                </div>
                <div>
                  <p className="font-semibold text-nms-text">Current Open5GS Service Interface <span className="text-xs font-normal text-nms-text-dim ml-1">(e.g. ens19, eth1)</span></p>
                  <p className="text-xs text-nms-text-dim mt-1 leading-relaxed">
                    The interface that currently carries your Open5GS service IPs (AMF, UPF, S1MME, etc.).
                    During migration, service IPs are moved off this interface onto VSIs.
                    At cutover, this interface is left up but its service IP addresses are removed — it can remain
                    in use for other traffic or be decommissioned afterward.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 bg-nms-bg border border-nms-border rounded-xl p-4">
                <div className="w-8 h-8 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-xs font-bold text-green-400">3</span>
                </div>
                <div>
                  <p className="font-semibold text-nms-text">L3 Transit Interface <span className="text-xs font-normal text-nms-text-dim ml-1">(e.g. ens20, eth2)</span></p>
                  <p className="text-xs text-nms-text-dim mt-1 leading-relaxed">
                    A dedicated point-to-point link to your core router — typically a /30 subnet
                    (e.g. <span className="font-mono text-nms-text">192.168.253.2/30</span> on the Open5GS side,
                    <span className="font-mono text-nms-text"> 192.168.253.1/30</span> on the router side).
                    FRR runs the routing protocol (EIGRP/OSPF/BGP) over this link to exchange routes with your core.
                    This interface must be cabled and the router end must be configured
                    <span className="text-amber-400 font-medium"> before you start the wizard.</span>
                  </p>
                </div>
              </div>

            </div>
          </div>

          {/* Router side must be pre-configured */}
          <div className="bg-amber-500/5 border border-amber-500/30 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <h3 className="text-xs font-semibold text-amber-300 uppercase tracking-wider">Core router must be configured first</h3>
            </div>
            <p className="text-xs text-nms-text-dim leading-relaxed">
              The wizard only configures the Open5GS host side. Your upstream core router or switch
              must already be set up with the matching routing protocol configuration before you begin Phase 3
              (Establish Neighbor). Specifically:
            </p>
            <ul className="text-xs text-nms-text-dim space-y-1 mt-1 ml-1">
              <li className="flex items-start gap-2"><span className="text-nms-accent shrink-0 mt-0.5">•</span> Transit interface configured with the /30 peer address</li>
              <li className="flex items-start gap-2"><span className="text-nms-accent shrink-0 mt-0.5">•</span> EIGRP / OSPF / BGP process enabled and matching the AS or process ID you configure here</li>
              <li className="flex items-start gap-2"><span className="text-nms-accent shrink-0 mt-0.5">•</span> Route policy to accept /32 host routes from the Open5GS peer (if your router filters by prefix length)</li>
              <li className="flex items-start gap-2"><span className="text-nms-accent shrink-0 mt-0.5">•</span> Any static routes pointing to the old service IPs removed or replaced once the dynamic routes are up</li>
            </ul>
          </div>

          {/* How it works */}
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">How it works — migration phases</h3>
            <div className="space-y-1.5 text-xs text-nms-text-dim">
              {[
                ['Phase 0', 'Snapshot netplan, FRR config, routing table, and interface state — full rollback point.'],
                ['Phase 1', 'Install FRR and enable the correct routing daemon (zebra + eigrpd / ospfd / bgpd).'],
                ['Phase 2', 'Assign the transit /30 to the transit interface via netplan.'],
                ['Phase 3', 'Write a transit-only FRR config and wait for the routing neighbor to come up. No service IPs moved yet.'],
                ['Phase 4', 'Create dummy VSI interfaces for each service IP (/32s). FRR config updated to advertise them.'],
                ['Phase 5', 'Verify all /32s appear in the routing table and no management IPs are leaking.'],
                ['Phase 6 — Cutover', 'Remove service IPs from the legacy interface. Write a unified netplan. Migration complete.'],
              ].map(([phase, desc]) => (
                <div key={phase} className="flex items-start gap-3">
                  <span className="font-mono text-nms-accent shrink-0 w-36">{phase}</span>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* FRR/EIGRP route filter bug note */}
          <div className="bg-nms-surface-2 border border-nms-border rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider">Known limitation: EIGRP route filtering</h3>
            </div>
            <p className="text-xs text-nms-text-dim leading-relaxed">
              FRR 8.4.x's <span className="font-mono text-nms-text">eigrpd</span> has a known bug where
              <span className="font-mono text-nms-text"> distribute-list</span> is accepted by the CLI but never actually
              implemented — the command is silently dropped when FRR writes back the config.
              This means <span className="text-nms-text font-medium">route filtering cannot be applied at the EIGRP protocol level</span> on this version.
            </p>
            <p className="text-xs text-nms-text-dim leading-relaxed">
              As a workaround, the NMS applies route filters using
              <span className="font-mono text-nms-text"> ip protocol eigrp route-map</span> — a zebra-level directive
              that filters EIGRP routes as they are <span className="text-nms-text font-medium">installed into the kernel RIB</span>,
              rather than at the FRR/EIGRP adjacency level. The practical effect is the same for inbound filtering:
              routes learned from your Nexus are filtered before being installed into the host routing table.
            </p>
            <p className="text-xs text-nms-text-dim leading-relaxed">
              For <span className="text-nms-text font-medium">outbound filtering</span> (what Open5GS advertises to the Nexus),
              the <span className="font-mono text-nms-text">network</span> statements in the EIGRP config already act as an
              exact permit list — only IPs explicitly listed are advertised. The outbound route-map is generated and
              stored but cannot be wired to EIGRP in FRR 8.4.x. If you need true outbound filtering beyond the
              network statement list, consider upgrading FRR or switching to OSPF/BGP which fully support route-maps.
            </p>
          </div>

          {/* Rollback */}
          <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
              <h3 className="text-xs font-semibold text-green-300 uppercase tracking-wider">Rollback is always available</h3>
            </div>
            <p className="text-xs text-nms-text-dim leading-relaxed">
              A full backup is created at Phase 0 before anything changes. The Rollback button (top of page)
              removes all generated netplan files and stops FRR, returning the host to its pre-migration state.
              Individual phases can also be rewound using the Redo button on each phase card.
              Rollback does <span className="text-nms-text font-medium">not</span> reconfigure the router — you will need
              to remove the routing protocol config on the router side manually if you roll back after Phase 3.
            </p>
          </div>

        </div>
      )}
    </div>
  );
}

// ─── Safety modal ─────────────────────────────────────────────────────────────

function SafetyWarningModal({ onAccept, onCancel }: { onAccept: () => void; onCancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="fixed inset-0 z-50 p-6 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="nms-card max-w-lg w-full border-amber-500/40 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-amber-500/10 shrink-0"><AlertTriangle className="w-6 h-6 text-amber-400" /></div>
          <div>
            <h2 className="text-lg font-semibold font-display">Network Migration Warning</h2>
          </div>
        </div>
        <div className="space-y-2 text-sm text-nms-text-dim">
          <p>This wizard will make <span className="text-nms-text font-semibold">live changes to host network configuration</span>.</p>
          <ul className="space-y-1.5 mt-2">
            <li className="flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" /><span>You <strong className="text-nms-text">may temporarily lose SSH/management access</strong> if something goes wrong.</span></li>
            <li className="flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" /><span>Open5GS services will be interrupted during the cutover phase.</span></li>
            <li className="flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" /><span>Ensure you have <strong className="text-nms-text">out-of-band access</strong> before proceeding.</span></li>
            <li className="flex items-start gap-2"><CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" /><span>A full backup is taken before any changes are made.</span></li>
            <li className="flex items-start gap-2"><CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" /><span>Rollback is available at every phase.</span></li>
          </ul>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="w-4 h-4 rounded border-nms-border" />
          <span className="text-nms-text">I understand I may lose connection and have out-of-band access ready</span>
        </label>
        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="nms-btn-ghost flex-1">Cancel</button>
          <button onClick={onAccept} disabled={!confirmed} className="nms-btn-primary flex-1 disabled:opacity-40">I understand — continue</button>
        </div>
      </div>
    </div>
  );
}

// ─── Log terminal ─────────────────────────────────────────────────────────────

function LogTerminal({ lines }: { lines: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  if (!lines) return null;
  return (
    <pre ref={ref} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-48 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-2">
      {lines}
    </pre>
  );
}

// ─── Phase card ───────────────────────────────────────────────────────────────

function PhaseCard({ title, description, phase, current, acting, canRun, onRun,
  streamLog, warning, isDangerous, extraContent, onRewind }: {
  title: string; description: string; phase: Phase; current: Phase;
  acting: boolean; canRun: boolean; onRun: () => Promise<void>;
  streamLog?: string; warning?: string; isDangerous?: boolean;
  extraContent?: React.ReactNode; onRewind?: () => Promise<void>;
}) {
  const [localActing, setLocalActing] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const phaseIdx = PHASE_ORDER.indexOf(phase);
  const curIdx   = PHASE_ORDER.indexOf(current);
  const isDone   = phaseIdx < curIdx;
  const isCurrent = phase === current;

  const handleRun = async () => { setLocalActing(true); try { await onRun(); } finally { setLocalActing(false); } };
  const handleRewind = async () => {
    if (!onRewind) return;
    if (!confirm(`Rewind to re-run "${title}"?\n\nOnly the migration phase counter is stepped back — no system changes are made.`)) return;
    setRewinding(true); try { await onRewind(); } finally { setRewinding(false); }
  };

  return (
    <div className={clsx('nms-card space-y-2 transition-all',
      isDone ? 'border-green-500/20' : isCurrent ? 'border-nms-accent/30' : 'opacity-60'
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={clsx('w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5',
            isDone ? 'bg-green-500/20' : isCurrent ? 'bg-nms-accent/20' : 'bg-nms-border/50'
          )}>
            {isDone ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
              : <span className={clsx('text-xs font-bold', isCurrent ? 'text-nms-accent' : 'text-nms-text-dim/40')}>{phaseIdx}</span>}
          </div>
          <div>
            <p className="text-sm font-semibold text-nms-text">{title}</p>
            <p className="text-xs text-nms-text-dim mt-0.5">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isDone && onRewind && (
            <button onClick={handleRewind} disabled={acting || rewinding}
              className="nms-btn-ghost flex items-center gap-1.5 text-xs text-nms-text-dim hover:text-amber-400">
              {rewinding ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Redo
            </button>
          )}
          {canRun && !isDone && (
            <button onClick={handleRun} disabled={localActing}
              className={clsx('flex items-center gap-2 text-sm', isDangerous ? 'nms-btn-danger' : 'nms-btn-primary')}>
              {localActing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {isDangerous ? 'Execute (destructive)' : 'Execute'}
            </button>
          )}
        </div>
      </div>
      {warning && !isDone && (
        <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/5 border border-amber-500/20 rounded px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {warning}
        </div>
      )}
      {extraContent}
      {streamLog && isCurrent && <LogTerminal lines={streamLog} />}
    </div>
  );
}

// ─── Protocol config form ─────────────────────────────────────────────────────

function ProtocolForm({ protocol, eigrpAs, setEigrpAs, eigrpPeer, setEigrpPeer,
  ospfPid, setOspfPid, ospfArea, setOspfArea, ospfNetType, setOspfNetType, ospfMethod, setOspfMethod,
  bgpLocal, setBgpLocal, bgpPeer, setBgpPeer, bgpPeerIp, setBgpPeerIp, bgpHop, setBgpHop, bgpNHS, setBgpNHS }: any) {
  return (
    <div className="bg-nms-bg border border-nms-border rounded-lg p-4 space-y-3">
      {protocol === 'eigrp' && (
        <div className="grid grid-cols-2 gap-3">
          <div><label className="nms-label">AS number</label><input value={eigrpAs} onChange={(e: any) => setEigrpAs(e.target.value)} className="nms-input font-mono text-sm" /></div>
          <div><label className="nms-label">Peer IP (upstream)</label><input value={eigrpPeer} onChange={(e: any) => setEigrpPeer(e.target.value)} className="nms-input font-mono text-sm" placeholder="192.168.253.1" /></div>
        </div>
      )}
      {protocol === 'ospf' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><label className="nms-label">Process ID</label><input value={ospfPid} onChange={(e: any) => setOspfPid(e.target.value)} className="nms-input font-mono text-sm" /></div>
          <div><label className="nms-label">Area ID</label><input value={ospfArea} onChange={(e: any) => setOspfArea(e.target.value)} className="nms-input font-mono text-sm" /></div>
          <div><label className="nms-label">Network type</label>
            <select value={ospfNetType} onChange={(e: any) => setOspfNetType(e.target.value)} className="nms-input text-sm">
              <option value="point-to-point">point-to-point</option><option value="broadcast">broadcast</option>
            </select>
          </div>
          <div><label className="nms-label">Advertisement</label>
            <select value={ospfMethod} onChange={(e: any) => setOspfMethod(e.target.value)} className="nms-input text-sm">
              <option value="redistribute">redistribute connected</option><option value="network">network statements</option>
            </select>
          </div>
        </div>
      )}
      {protocol === 'bgp' && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div><label className="nms-label">Local AS</label><input value={bgpLocal} onChange={(e: any) => setBgpLocal(e.target.value)} className="nms-input font-mono text-sm" /></div>
          <div><label className="nms-label">Peer AS</label><input value={bgpPeer} onChange={(e: any) => setBgpPeer(e.target.value)} className="nms-input font-mono text-sm" /></div>
          <div><label className="nms-label">Peer IP</label><input value={bgpPeerIp} onChange={(e: any) => setBgpPeerIp(e.target.value)} className="nms-input font-mono text-sm" /></div>
          <div><label className="nms-label">eBGP multihop TTL</label><input value={bgpHop} onChange={(e: any) => setBgpHop(e.target.value)} className="nms-input font-mono text-sm" /></div>
          <div className="flex items-center gap-2 pt-5">
            <input type="checkbox" id="nhs" checked={bgpNHS} onChange={(e: any) => setBgpNHS(e.target.checked)} className="w-4 h-4 rounded" />
            <label htmlFor="nhs" className="text-sm text-nms-text cursor-pointer">next-hop-self</label>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Route filter card ────────────────────────────────────────────────────────

function RouteFilterCard({ filters, setFilters, onSave, onRollback, hasBackup, protocol, vsiMappings }: {
  filters: RouteFilter[];
  setFilters: (f: RouteFilter[]) => void;
  onSave: () => Promise<void>;
  onRollback: () => Promise<void>;
  hasBackup: boolean;
  protocol: string;
  vsiMappings: ServiceMapping[];
}) {
  const [newPrefix, setNewPrefix]     = useState<Record<string, string>>({});
  const [previewCfg, setPreviewCfg]   = useState<string | null>(null);
  const [previewing, setPreviewing]   = useState(false);
  const [applying, setApplying]       = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const addFilter = () => {
    const id = Date.now().toString(36);
    setFilters([...filters, { id, name: '', direction: 'in', action: 'permit', seq: (filters.length + 1) * 10, prefixes: [] }]);
  };

  const update = (i: number, patch: Partial<RouteFilter>) =>
    setFilters(filters.map((f, j) => j === i ? { ...f, ...patch } : f));

  const remove = (i: number) => setFilters(filters.filter((_, j) => j !== i));

  const addPrefix = (i: number) => {
    const val = (newPrefix[filters[i].id] ?? '').trim();
    if (!val) return;
    update(i, { prefixes: [...filters[i].prefixes, val] });
    setNewPrefix(p => ({ ...p, [filters[i].id]: '' }));
  };

  const removePrefix = (i: number, pi: number) =>
    update(i, { prefixes: filters[i].prefixes.filter((_, j) => j !== pi) });

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const r = await frrApi.previewFilters(filters);
      setPreviewCfg(r.config);
    } catch { toast.error('Preview failed'); }
    finally { setPreviewing(false); }
  };

  const handleApply = async () => {
    setApplying(true);
    setPreviewCfg(null);
    try { await onSave(); }
    finally { setApplying(false); }
  };

  const handleRollback = async () => {
    if (!confirm('Roll back to previous filters?\n\nThis will restore the last applied filter set and reload FRR.')) return;
    setRollingBack(true);
    try { await onRollback(); }
    finally { setRollingBack(false); }
  };

  const filterAppliesTo = protocol === 'eigrp'
    ? 'EIGRP — zebra RIB-level filtering'
    : protocol === 'ospf'
    ? 'OSPF — applied via distribute-list on process'
    : 'BGP — applied via neighbor route-map';

  return (
    <div className="nms-card space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-nms-accent" />
          <h2 className="text-sm font-semibold text-nms-text">Route Filters</h2>
          <span className="text-xs text-nms-text-dim">— {filterAppliesTo}</span>
        </div>
        <div className="flex items-center gap-2">
          {hasBackup && (
            <button onClick={handleRollback} disabled={rollingBack}
              className="nms-btn-ghost flex items-center gap-1.5 text-xs text-amber-400">
              {rollingBack ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
              Rollback
            </button>
          )}
          <button
            onClick={() => {
              if (vsiMappings.length === 0) { toast.error('No VSI mappings configured'); return; }
              const existing = filters.find(f => f.direction === 'out' && f.name === 'permit-vsi-ips');
              if (existing) {
                setFilters(filters.map(f =>
                  f.name === 'permit-vsi-ips' && f.direction === 'out'
                    ? { ...f, prefixes: vsiMappings.filter(m => m.ip).map(m => `${m.ip}/32`) }
                    : f
                ));
                toast.success('Updated VSI outbound filter');
              } else {
                const id = Date.now().toString(36);
                const newFilter: RouteFilter = {
                  id, name: 'permit-vsi-ips', direction: 'out', action: 'permit',
                  seq: (filters.length + 1) * 10,
                  prefixes: vsiMappings.filter(m => m.ip).map(m => `${m.ip}/32`),
                  description: 'Auto-generated — permits VSI /32 service IPs outbound',
                };
                setFilters([...filters, newFilter]);
                toast.success(`Created outbound permit filter with ${newFilter.prefixes.length} VSI IPs`);
              }
            }}
            className="nms-btn-ghost flex items-center gap-1.5 text-xs text-nms-accent"
            title="Create/update an outbound permit filter with all VSI interface IPs">
            <Shield className="w-3.5 h-3.5" /> Auto VSI filter
          </button>
          <button onClick={addFilter} className="nms-btn-ghost flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" /> New filter
          </button>
        </div>
      </div>

      {filters.length === 0 ? (
        <div className="text-center py-6 border border-dashed border-nms-border rounded-lg">
          <Filter className="w-6 h-6 text-nms-text-dim/30 mx-auto mb-2" />
          <p className="text-xs text-nms-text-dim">No filters — all routes permitted in both directions.</p>
          <button onClick={addFilter} className="nms-btn-ghost text-xs mt-2 flex items-center gap-1 mx-auto">
            <Plus className="w-3.5 h-3.5" /> Add first filter
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filters.map((f, i) => (
            <div key={f.id} className="border border-nms-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-nms-surface-2 border-b border-nms-border">
                <input
                  value={f.name}
                  onChange={(e: any) => update(i, { name: e.target.value })}
                  placeholder="Filter name (e.g. block-rfc1918-in)"
                  className="nms-input text-sm font-medium flex-1"
                />
                <div className="flex rounded-lg border border-nms-border overflow-hidden shrink-0">
                  {(['in', 'out'] as const).map(d => (
                    <button key={d} onClick={() => update(i, { direction: d })}
                      className={clsx('px-2.5 py-1 text-xs font-medium flex items-center gap-1 transition-colors',
                        f.direction === d ? 'bg-nms-accent/20 text-nms-accent' : 'text-nms-text-dim hover:text-nms-text'
                      )}>
                      {d === 'in' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />}
                      {d.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="flex rounded-lg border border-nms-border overflow-hidden shrink-0">
                  {(['permit', 'deny'] as const).map(a => (
                    <button key={a} onClick={() => update(i, { action: a })}
                      className={clsx('px-2.5 py-1 text-xs font-medium transition-colors',
                        f.action === a
                          ? a === 'permit' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                          : 'text-nms-text-dim hover:text-nms-text'
                      )}>{a === 'permit' ? 'Permit' : 'Deny'}</button>
                  ))}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-xs text-nms-text-dim">seq</span>
                  <input type="number" value={f.seq}
                    onChange={(e: any) => update(i, { seq: parseInt(e.target.value) || 10 })}
                    className="nms-input font-mono text-xs w-14" />
                </div>
                <button onClick={() => remove(i)} className="text-nms-text-dim/50 hover:text-red-400 transition-colors shrink-0 p-1">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-3 space-y-2">
                {f.prefixes.length === 0 && (
                  <p className="text-xs text-nms-text-dim/60 italic">No prefixes added yet.</p>
                )}
                {f.prefixes.map((pfx, pi) => (
                  <div key={pi} className="flex items-center gap-2">
                    <span className={clsx(
                      'text-xs font-mono px-2 py-0.5 rounded shrink-0',
                      f.action === 'permit' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                    )}>{f.action}</span>
                    <code className="font-mono text-xs text-nms-text flex-1 bg-nms-bg border border-nms-border rounded px-2 py-0.5">{pfx}</code>
                    <button onClick={() => removePrefix(i, pi)} className="text-nms-text-dim/40 hover:text-red-400 shrink-0">
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    value={newPrefix[f.id] ?? ''}
                    onChange={(e: any) => setNewPrefix(p => ({ ...p, [f.id]: e.target.value }))}
                    onKeyDown={(e: any) => e.key === 'Enter' && addPrefix(i)}
                    placeholder="10.0.0.0/8  or  172.16.0.0/12 le 32"
                    className="nms-input font-mono text-xs flex-1"
                  />
                  <button onClick={() => addPrefix(i)}
                    disabled={!(newPrefix[f.id] ?? '').trim()}
                    className="nms-btn-ghost text-xs flex items-center gap-1 shrink-0 disabled:opacity-40">
                    <Plus className="w-3.5 h-3.5" /> Add
                  </button>
                </div>
                <p className="text-xs text-nms-text-dim/50">CIDR — supports <code>le</code>/<code>ge</code> e.g. <code>10.0.0.0/8 le 32</code>. Press Enter or click Add.</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {filters.length > 0 && (
        <div className="space-y-3 pt-1 border-t border-nms-border">
          {previewCfg && (
            <div>
              <p className="text-xs text-nms-text-dim mb-1 flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" /> Generated FRR config with these filters
              </p>
              <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-nms-text border border-nms-border max-h-56 overflow-y-auto">{previewCfg}</pre>
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={handlePreview} disabled={previewing}
              className="nms-btn-ghost flex items-center gap-2 text-sm">
              {previewing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
              Preview config
            </button>
            <button onClick={handleApply} disabled={applying}
              className="nms-btn-primary flex items-center gap-2 text-sm">
              {applying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Filter className="w-4 h-4" />}
              Apply to FRR
            </button>
            {hasBackup && (
              <p className="text-xs text-nms-text-dim">Previous filter set available for rollback ↑</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Running config panel ────────────────────────────────────────────────────

function RunningConfigPanel({ config }: { config: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!config) return null;
  return (
    <div className="border border-nms-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-nms-surface-2 hover:bg-nms-bg transition-colors text-left">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-nms-text-dim" />
          <span className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Running Config</span>
        </div>
        <ChevronDown className={clsx('w-3.5 h-3.5 text-nms-text-dim transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <pre className="text-xs font-mono text-nms-text-dim bg-nms-bg px-4 py-3 max-h-64 overflow-y-auto border-t border-nms-border leading-relaxed">
          {config}
        </pre>
      )}
    </div>
  );
}

// ─── UE Subnet Routing panel ──────────────────────────────────────────────────

function UeSubnetPanel({ storedSubnets, hasRollback, onApplied }: {
  storedSubnets: UeSubnet[];
  hasRollback: boolean;
  onApplied: () => void;
}) {
  const [discovered, setDiscovered]   = useState<UeSubnet[]>([]);
  const [selected, setSelected]       = useState<Set<string>>(new Set(storedSubnets.map(u => u.subnet)));
  const [discovering, setDiscovering] = useState(false);
  const [log, setLog]                 = useState('');
  const [applying, setApplying]       = useState(false);
  const [didDiscover, setDidDiscover] = useState(false);

  const streamFetch = async (fetchFn: () => Promise<Response>, successMsg: string) => {
    setApplying(true);
    setLog('');
    try {
      const resp = await fetchFn();
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setLog(prev => prev + decoder.decode(value));
        }
      }
      toast.success(successMsg);
      onApplied();
    } catch (err: any) { toast.error(`Failed: ${err.message}`); }
    finally { setApplying(false); }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await frrApi.discoverUeSubnets();
      setDiscovered(r.subnets);
      setDidDiscover(true);
      if (r.subnets.length === 0) toast.error('No IPv4 UE subnets found in upf.yaml');
      else toast.success(`Found ${r.subnets.length} UE subnet(s)`);
    } catch { toast.error('Discovery failed'); }
    finally { setDiscovering(false); }
  };

  const toggle = (subnet: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(subnet) ? next.delete(subnet) : next.add(subnet);
      return next;
    });
  };

  const apply = async () => {
    const toApply = discovered.filter(u => selected.has(u.subnet));
    await streamFetch(
      () => frrApi.applyUeSubnets(toApply),
      `Applied ${toApply.length} UE subnet(s) — NAT removed, FORWARD rules added`
    );
  };

  const rollback = async () => {
    if (!confirm(
      'Roll back UE subnet routing?\n\n' +
      '• Removes iptables FORWARD rules\n' +
      '• Restores NAT MASQUERADE rules that were removed\n' +
      '• Removes UE subnets from FRR advertisement\n\n' +
      'UEs will route via NAT again.'
    )) return;
    await streamFetch(frrApi.rollbackUeSubnets, 'Rolled back — NAT restored, FORWARD rules removed');
  };

  const displaySubnets = didDiscover ? discovered : storedSubnets;

  return (
    <div className="nms-card space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-nms-accent" />
          <h2 className="text-sm font-semibold text-nms-text">UE Subnet Routing</h2>
          {storedSubnets.length > 0 && (
            <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded-full">
              {storedSubnets.length} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasRollback && (
            <button onClick={rollback} disabled={applying}
              className="nms-btn-ghost flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300">
              {applying ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
              Rollback (restore NAT)
            </button>
          )}
          <button onClick={discover} disabled={discovering || applying}
            className="nms-btn-ghost flex items-center gap-1.5 text-xs">
            {discovering ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Discover from upf.yaml
          </button>
        </div>
      </div>

      <p className="text-xs text-nms-text-dim">
        Advertise UE IP pools via {'{'}EIGRP/OSPF/BGP{'}'} without NAT. On apply: existing MASQUERADE rules are removed and
        stored for rollback, ip_forward is enabled, and FORWARD rules are added. One-click rollback restores everything.
      </p>

      {hasRollback && (
        <div className="flex items-start gap-2 text-xs bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <span className="text-amber-300">
            Rollback available — NAT rules are stored and can be restored. Click <strong>Rollback (restore NAT)</strong> to reverse all changes.
          </span>
        </div>
      )}

      {displaySubnets.length === 0 && !didDiscover ? (
        <div className="text-center py-5 border border-dashed border-nms-border rounded-lg">
          <Globe className="w-5 h-5 text-nms-text-dim/30 mx-auto mb-2" />
          <p className="text-xs text-nms-text-dim">Click "Discover from upf.yaml" to load UE subnets</p>
        </div>
      ) : (
        <div className="space-y-2">
          {displaySubnets.map(u => (
            <label key={u.subnet} className="flex items-center gap-3 bg-nms-bg border border-nms-border rounded-lg px-3 py-2.5 cursor-pointer hover:border-nms-accent/40 transition-colors select-none">
              <input type="checkbox" checked={selected.has(u.subnet)} onChange={() => toggle(u.subnet)}
                className="w-4 h-4 rounded border-nms-border shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-mono text-sm text-nms-text">{u.subnet}</span>
                <span className="text-xs text-nms-text-dim ml-3">via {u.dev}</span>
                {u.dnn && <span className="text-xs text-nms-accent ml-2">dnn: {u.dnn}</span>}
                {u.gateway && <span className="text-xs text-nms-text-dim ml-2">gw {u.gateway}</span>}
              </div>
              {storedSubnets.some(s => s.subnet === u.subnet) && (
                <span className="text-xs text-green-400 shrink-0">active</span>
              )}
            </label>
          ))}
        </div>
      )}

      {didDiscover && displaySubnets.length > 0 && (
        <div className="flex items-center gap-3 pt-1 border-t border-nms-border">
          <button onClick={apply} disabled={applying || selected.size === 0}
            className="nms-btn-primary flex items-center gap-2 text-sm disabled:opacity-40">
            {applying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
            Apply {selected.size > 0 ? `(${selected.size} subnet${selected.size > 1 ? 's' : ''})` : ''}
          </button>
          <p className="text-xs text-nms-text-dim">
            Removes MASQUERADE rules · adds FORWARD rules · updates FRR
          </p>
        </div>
      )}

      {log && <LogTerminal lines={log} />}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function FRRPage() {
  const [pageTab, setPageTab] = useState<'routing' | 'tun'>('routing');
  const [detection, setDetection]   = useState<any>(null);
  const [migState,  setMigState]    = useState<any>(null);
  const [interfaces, setInterfaces] = useState<IfaceInfo[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showWarning, setShowWarning]         = useState(false);
  const [warningAccepted, setWarningAccepted] = useState(
    () => localStorage.getItem('frr-warning-accepted') === '1'
  );
  const [acting, setActing]         = useState(false);
  const [streamLog, setStreamLog]   = useState('');
  const [reconfigLog, setReconfigLog] = useState('');
  const [previewConfig, setPreviewConfig] = useState('');
  const [showPreview, setShowPreview]     = useState(false);
  const [reconfigMode, setReconfigMode]   = useState(false);
  const [neighborTimer, setNeighborTimer] = useState<ReturnType<typeof setInterval> | null>(null);
  const [routeFilters, setRouteFiltersState] = useState<RouteFilter[]>([]);
  const [storedUeSubnets, setStoredUeSubnets] = useState<UeSubnet[]>([]);
  const [hasUeRollback, setHasUeRollback]     = useState(false);

  const [mgmtIface,    setMgmtIface]    = useState('');
  const [transitIface, setTransitIface] = useState('');
  const [transitCidr,  setTransitCidr]  = useState('192.168.253.2/30');
  const [svcIface,     setSvcIface]     = useState('');
  const [protocol,     setProtocol]     = useState<Protocol>('eigrp');

  const [serviceMappings, setServiceMappings] = useState<ServiceMapping[]>([
    { service: 'amf',   ip: '10.0.1.155', dummyName: 'dummy-amf'   },
    { service: 'upf',   ip: '10.0.1.156', dummyName: 'dummy-upf'   },
    { service: 's1mme', ip: '10.0.1.175', dummyName: 'dummy-s1mme' },
    { service: 's1u',   ip: '10.0.1.176', dummyName: 'dummy-s1u'   },
    { service: 'sgwc',  ip: '10.0.1.177', dummyName: 'dummy-sgwc'  },
  ]);

  const [eigrpAs,     setEigrpAs]     = useState('1');
  const [eigrpPeer,   setEigrpPeer]   = useState('192.168.253.1');
  const [ospfArea,    setOspfArea]    = useState('0');
  const [ospfPid,     setOspfPid]     = useState('1');
  const [ospfNetType, setOspfNetType] = useState<'point-to-point' | 'broadcast'>('point-to-point');
  const [ospfMethod,  setOspfMethod]  = useState<'redistribute' | 'network'>('redistribute');
  const [bgpLocal,    setBgpLocal]    = useState('65001');
  const [bgpPeer,     setBgpPeer]     = useState('65000');
  const [bgpPeerIp,   setBgpPeerIp]   = useState('192.168.253.1');
  const [bgpHop,      setBgpHop]      = useState('2');
  const [bgpNHS,      setBgpNHS]      = useState(false);

  const applyParsed = (parsed: Record<string, any>) => {
    if (!parsed) return;
    if (parsed.protocol) setProtocol(parsed.protocol as Protocol);
    if (parsed.as) setEigrpAs(String(parsed.as));
    if (parsed.processId) setOspfPid(String(parsed.processId));
    if (parsed.area) setOspfArea(String(parsed.area));
    if (parsed.networkType) setOspfNetType(parsed.networkType);
    if (parsed.redistributeMethod) setOspfMethod(parsed.redistributeMethod);
    if (parsed.localAs) setBgpLocal(String(parsed.localAs));
    if (parsed.peerAs) setBgpPeer(String(parsed.peerAs));
    if (parsed.peerIp) { setBgpPeerIp(parsed.peerIp); setEigrpPeer(parsed.peerIp); }
    if (parsed.ebgpMultihop) setBgpHop(String(parsed.ebgpMultihop));
    if (parsed.nextHopSelf !== undefined) setBgpNHS(parsed.nextHopSelf);
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [det, ifaces, st] = await Promise.all([
        frrApi.detect().catch(() => null),
        frrApi.interfaces().catch(() => ({ interfaces: [], mgmtInterface: null })),
        frrApi.getState().catch(() => null),
      ]);
      setDetection(det);
      setInterfaces(ifaces.interfaces ?? []);
      setMigState(st);
      // frrApi.getState() returns data.state directly — st IS the state object, not {state: ...}
      if (st?.routeFilters !== undefined) { setRouteFiltersState(st.routeFilters); }
      if (st?.ueSubnets        !== undefined) { setStoredUeSubnets(st.ueSubnets ?? []); }
      setHasUeRollback(!!(st?.ueSubnetsRollback));
      if (ifaces.mgmtInterface && !mgmtIface) setMgmtIface(ifaces.mgmtInterface);
      // Also read phase/config back from state so wizard is in sync
      if (st?.protocol)          setProtocol(st.protocol);
      if (st?.mgmtInterface)     setMgmtIface(st.mgmtInterface);
      if (st?.transitInterface)  setTransitIface(st.transitInterface);
      if (st?.transitCidr)       setTransitCidr(st.transitCidr);
      if (st?.serviceMappings?.length) setServiceMappings(st.serviceMappings);
      if (det?.active && det.protocol) {
        const parsed = await frrApi.parseRunningConfig().catch(() => null);
        if (parsed) applyParsed(parsed);
      }
    } finally { if (!silent) setLoading(false); }
  }, [mgmtIface]);

  useEffect(() => { load(); return () => { if (neighborTimer) clearInterval(neighborTimer); }; }, []);

  const buildProtocolConfig = () => {
    if (protocol === 'eigrp') return { protocol: 'eigrp', as: parseInt(eigrpAs), peerIp: eigrpPeer, mgmtInterface: mgmtIface };
    if (protocol === 'ospf')  return { protocol: 'ospf', processId: parseInt(ospfPid), area: ospfArea, networkType: ospfNetType, passiveInterfaces: [mgmtIface].filter(Boolean), redistributeMethod: ospfMethod };
    return { protocol: 'bgp', localAs: parseInt(bgpLocal), peerAs: parseInt(bgpPeer), peerIp: bgpPeerIp, ebgpMultihop: parseInt(bgpHop), nextHopSelf: bgpNHS };
  };

  const buildPayload = () => ({
    mgmtInterface: mgmtIface, transitInterface: transitIface, transitCidr,
    servicePlaneInterface: svcIface, serviceMappings, protocol,
    protocolConfig: buildProtocolConfig() as Record<string, any>,
  });

  const saveConfig = async () => { await frrApi.configure(buildPayload()); };

  const runStream = async (fetchFn: () => Promise<Response>, label: string, setLog?: React.Dispatch<React.SetStateAction<string>>): Promise<boolean> => {
    const setter = setLog ?? setStreamLog;
    setter(''); setActing(true);
    try {
      const resp = await fetchFn();
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; setter(prev => prev + decoder.decode(value)); } }
      await load(true); return true;
    } catch (err: any) { toast.error(`${label} failed: ${err.message}`); return false; }
    finally { setActing(false); }
  };

  const startNeighborPolling = () => {
    if (neighborTimer) clearInterval(neighborTimer);
    const timer = setInterval(async () => {
      const result = await frrApi.validateNeighbor().catch(() => null);
      if (result?.neighborUp) { clearInterval(timer); setNeighborTimer(null); toast.success('Neighbor established!'); await load(true); }
    }, 5000);
    setNeighborTimer(timer);
  };

  const rewind = async (phase: Phase) => { await frrApi.rewind(phase); await load(true); };

  const currentPhase: Phase = migState?.phase ?? 'INIT';
  const phaseIdx            = PHASE_ORDER.indexOf(currentPhase);
  const isComplete          = currentPhase === 'CUTOVER_COMPLETE' || currentPhase === 'LEGACY_INTERFACES_REMOVED';
  const frrRunning          = detection?.active === true;
  const frrInstalled        = detection?.installed === true;

  const protoFormProps = {
    protocol, eigrpAs, setEigrpAs, eigrpPeer, setEigrpPeer,
    ospfPid, setOspfPid, ospfArea, setOspfArea, ospfNetType, setOspfNetType, ospfMethod, setOspfMethod,
    bgpLocal, setBgpLocal, bgpPeer, setBgpPeer, bgpPeerIp, setBgpPeerIp, bgpHop, setBgpHop, bgpNHS, setBgpNHS,
  };

  return (
    <div className="p-6 space-y-6">
      {pageTab === 'routing' && showWarning && (
        <SafetyWarningModal
          onAccept={() => { setWarningAccepted(true); localStorage.setItem('frr-warning-accepted', '1'); setShowWarning(false); }}
          onCancel={() => setShowWarning(false)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">L3 Routing</h1>
          <p className="text-sm text-nms-text-dim mt-1">FRR routing migration and TUN interface management</p>
        </div>
        {pageTab === 'routing' && (
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => load()} disabled={acting} className="nms-btn-ghost flex items-center gap-2 text-sm">
              <RefreshCw className={clsx('w-4 h-4', acting && 'animate-spin')} /> Refresh
            </button>
            {currentPhase !== 'INIT' && !isComplete && (
              <button onClick={() => runStream(frrApi.rollback, 'Rollback')} disabled={acting}
                className="nms-btn-ghost flex items-center gap-2 text-sm text-amber-400">
                <RotateCcw className="w-4 h-4" /> Rollback
              </button>
            )}
            <button
              onClick={async () => {
                if (confirm('Reset migration state to INIT?\n\nOnly resets the wizard counter — no network changes.')) {
                  await frrApi.resetState();
                  localStorage.removeItem('frr-warning-accepted');
                  setWarningAccepted(false);
                  await load();
                }
              }}
              className="nms-btn-ghost flex items-center gap-2 text-sm text-red-400">
              <XCircle className="w-4 h-4" /> Reset state
            </button>
          </div>
        )}
      </div>

      {/* Page tabs */}
      <div className="flex border-b border-nms-border">
        {([
          { id: 'routing', label: 'L3 Routing',     Icon: GitBranch },
          { id: 'tun',     label: 'TUN Interfaces', Icon: Layers    },
        ] as const).map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setPageTab(id)}
            className={clsx('flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              pageTab === id
                ? 'border-nms-accent text-nms-accent'
                : 'border-transparent text-nms-text-dim hover:text-nms-text'
            )}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {pageTab === 'tun' && <TunInterfacePage />}

      {pageTab === 'routing' && (loading ? (
        <div className="flex items-center justify-center h-64 text-nms-text-dim">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading FRR status…
        </div>
      ) : <>

      <ArchitectureCard />

      {/* Safety banner — only show during active migration, and only if not yet acknowledged */}
      {!warningAccepted && !isComplete && (
        <div className="nms-card border-amber-500/40 bg-amber-500/5 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-300">This feature can interrupt your network connection</p>
            <p className="text-xs text-nms-text-dim mt-0.5">Live changes will be made to the host network stack. Ensure you have out-of-band access before proceeding.</p>
          </div>
          <button onClick={() => setShowWarning(true)} className="nms-btn-ghost text-sm text-amber-400 shrink-0">Acknowledge &amp; proceed</button>
        </div>
      )}

      {/* FRR detection status */}
      <div className={clsx('nms-card flex items-center gap-4',
        frrRunning ? 'border-green-500/30 bg-green-500/5' : frrInstalled ? 'border-amber-500/30 bg-amber-500/5' : ''
      )}>
        {frrRunning ? <CheckCircle className="w-5 h-5 text-green-400 shrink-0" />
          : frrInstalled ? <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          : <XCircle className="w-5 h-5 text-nms-text-dim/40 shrink-0" />}
        <div className="flex-1">
          <p className="text-sm font-semibold">
            {frrRunning ? `FRR active — ${detection.protocol?.toUpperCase() ?? 'protocol unknown'}`
              : frrInstalled ? 'FRR installed but not active'
              : 'FRR not installed — wizard will install it'}
          </p>
          {frrRunning && (detection.neighbors?.length ?? 0) > 0 && (
            <p className="text-xs text-nms-text-dim mt-0.5">{detection.neighbors.length} neighbor(s) established</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {frrRunning && isComplete && !reconfigMode && (
            <button onClick={() => setReconfigMode(true)} className="nms-btn-ghost flex items-center gap-2 text-sm text-nms-accent">
              <Settings className="w-4 h-4" /> Reconfigure
            </button>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-nms-text-dim">Phase:</span>
            <span className={clsx('text-xs font-mono px-2 py-0.5 rounded',
              isComplete ? 'bg-green-500/10 text-green-400' : 'bg-nms-surface text-nms-text'
            )}>{PHASE_LABELS[currentPhase]}</span>
          </div>
        </div>
      </div>

      {/* Live routing status — only after migration complete */}
      {frrRunning && isComplete && (
        <div className="nms-card space-y-5">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-nms-accent" />
            <h2 className="text-sm font-semibold text-nms-text">Live Routing Status</h2>
            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              Active
            </span>
          </div>

          {/* Stat pills */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-nms-bg border border-nms-border rounded-xl p-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-nms-accent/10 flex items-center justify-center shrink-0">
                <Radio className="w-4 h-4 text-nms-accent" />
              </div>
              <div>
                <p className="text-xs text-nms-text-dim">Protocol</p>
                <p className="text-sm font-bold text-nms-text font-mono">{detection.protocol?.toUpperCase() ?? '—'}</p>
              </div>
            </div>
            <div className="bg-nms-bg border border-nms-border rounded-xl p-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0">
                <CheckCircle className="w-4 h-4 text-green-400" />
              </div>
              <div>
                <p className="text-xs text-nms-text-dim">Neighbors</p>
                <p className="text-sm font-bold text-nms-text">{detection.neighbors?.length ?? 0} established</p>
              </div>
            </div>
            <div className="bg-nms-bg border border-nms-border rounded-xl p-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                <GitBranch className="w-4 h-4 text-blue-400" />
              </div>
              <div>
                <p className="text-xs text-nms-text-dim">Prefixes</p>
                <p className="text-sm font-bold text-nms-text">{detection.topology?.length ?? detection.routes?.length ?? 0} routes</p>
              </div>
            </div>
          </div>

          {/* Neighbors */}
          <div>
            <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Radio className="w-3 h-3" /> Neighbors
            </p>
            {(detection.neighbors?.length ?? 0) === 0 ? (
              <div className="flex items-center gap-2 text-xs text-nms-text-dim bg-nms-bg border border-dashed border-nms-border rounded-lg px-3 py-3">
                <XCircle className="w-3.5 h-3.5 shrink-0" /> No neighbors established
              </div>
            ) : (
              <div className="space-y-2">
                {detection.neighbors.map((n: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 bg-nms-bg border border-nms-border rounded-xl px-4 py-3">
                    <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono font-semibold text-nms-text truncate">{n.ip ?? n.peer ?? n.id}</p>
                      {n.state && <p className="text-xs text-nms-text-dim">{n.state}</p>}
                    </div>
                    {n.iface && (
                      <span className="text-xs font-mono text-nms-accent bg-nms-accent/10 border border-nms-accent/20 px-2 py-0.5 rounded shrink-0">
                        {n.iface}
                      </span>
                    )}
                    {(n.holdTime || n.uptime || n.deadTime) && (
                      <span className="text-xs text-nms-text-dim shrink-0">
                        {n.holdTime ? `hold ${n.holdTime}s` : n.uptime ?? n.deadTime}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* EIGRP Topology table */}
          {(detection.topology?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <GitBranch className="w-3 h-3" /> EIGRP Topology — {detection.topology.length} prefixes
              </p>
              <div className="rounded-xl border border-nms-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-nms-surface-2 border-b border-nms-border">
                      <th className="text-left px-4 py-2 text-nms-text-dim font-medium">Prefix</th>
                      <th className="text-left px-4 py-2 text-nms-text-dim font-medium">Next Hop</th>
                      <th className="text-left px-4 py-2 text-nms-text-dim font-medium">Interface</th>
                      <th className="text-left px-4 py-2 text-nms-text-dim font-medium">Metric</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detection.topology.map((t: any, i: number) => (
                      <tr key={i} className={clsx('border-b border-nms-border last:border-0', i % 2 === 0 ? 'bg-nms-bg' : 'bg-nms-surface-2/30')}>
                        <td className="px-4 py-2 font-mono text-nms-text font-medium">{t.prefix}</td>
                        <td className="px-4 py-2 font-mono text-nms-text-dim">{t.via?.[0]?.nexthop ?? <span className="text-green-400/70">Connected</span>}</td>
                        <td className="px-4 py-2 font-mono">
                          {t.via?.[0]?.iface
                            ? <span className="text-nms-accent bg-nms-accent/10 border border-nms-accent/20 px-1.5 py-0.5 rounded text-[11px]">{t.via[0].iface}</span>
                            : <span className="text-nms-text-dim/40">—</span>}
                        </td>
                        <td className="px-4 py-2 font-mono text-nms-text-dim/60">{t.via?.[0]?.metric ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <RunningConfigPanel config={detection.runningConfig} />
        </div>
      )}

      {/* UE Subnet Routing */}
      {frrRunning && (
        <UeSubnetPanel storedSubnets={storedUeSubnets} hasRollback={hasUeRollback} onApplied={() => load(true)} />
      )}

      {/* Reconfigure panel */}
      {frrRunning && isComplete && reconfigMode && (
        <div className="nms-card space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-nms-accent" />
              <h2 className="text-sm font-semibold text-nms-text">Reconfigure FRR</h2>
            </div>
            <button onClick={() => { setReconfigMode(false); setReconfigLog(''); }} className="nms-btn-ghost text-xs">Cancel</button>
          </div>
          <div className={clsx('space-y-4', !warningAccepted && !isComplete && 'opacity-50 pointer-events-none')}>
            <p className="text-xs text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Reconfiguring will overwrite <code>/etc/frr/frr.conf</code> and reload FRR.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="nms-label">Management interface</label>
                <select value={mgmtIface} onChange={e => setMgmtIface(e.target.value)} className="nms-input text-sm">
                  <option value="">— select —</option>
                  {interfaces.map(i => <option key={i.name} value={i.name}>{i.name}{i.isMgmt ? ' ★' : ''}</option>)}
                </select>
              </div>
              <div>
                <label className="nms-label">Transit interface</label>
                <select value={transitIface} onChange={e => setTransitIface(e.target.value)} className="nms-input text-sm">
                  <option value="">— select —</option>
                  {interfaces.filter(i => i.name !== mgmtIface).map(i => <option key={i.name} value={i.name}>{i.name}{i.addresses[0] ? ` (${i.addresses[0]})` : ''}</option>)}
                </select>
                <input value={transitCidr} onChange={e => setTransitCidr(e.target.value)} className="nms-input font-mono text-sm mt-1" />
              </div>
              <div>
                <label className="nms-label">Protocol</label>
                <div className="flex gap-2 flex-wrap mt-1">
                  {(['ospf', 'bgp', 'eigrp'] as Protocol[]).map(p => (
                    <button key={p} onClick={() => setProtocol(p)}
                      className={clsx('px-3 py-1.5 rounded-lg border text-xs font-medium transition-all',
                        protocol === p ? 'bg-nms-accent/10 border-nms-accent/40 text-nms-accent' : 'border-nms-border text-nms-text-dim hover:text-nms-text'
                      )}>{p.toUpperCase()}</button>
                  ))}
                </div>
              </div>
            </div>
            <ProtocolForm {...protoFormProps} />
            <div className="flex gap-2">
              <button onClick={async () => { await saveConfig(); const cfg = await frrApi.previewConfig(); setPreviewConfig(cfg); setShowPreview(true); }}
                className="nms-btn-ghost flex items-center gap-2 text-sm">
                <Eye className="w-4 h-4" /> Preview config
              </button>
              <button onClick={async () => { await runStream(() => frrApi.reconfigure(buildPayload()), 'Reconfigure', setReconfigLog); toast.success('FRR reconfigured'); setReconfigMode(false); }}
                disabled={acting} className="nms-btn-primary flex items-center gap-2 text-sm">
                {acting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Settings className="w-4 h-4" />} Apply reconfiguration
              </button>
            </div>
            {showPreview && previewConfig && (
              <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-nms-text border border-nms-border max-h-64 overflow-y-auto">{previewConfig}</pre>
            )}
            <LogTerminal lines={reconfigLog} />
          </div>
        </div>
      )}

      {/* Route filtering — only after migration complete */}
      {frrRunning && isComplete && (
        <RouteFilterCard
          filters={routeFilters}
          setFilters={setRouteFiltersState}
          protocol={detection?.protocol ?? 'eigrp'}
          hasBackup={!!(migState?.routeFilterBackup)}
          vsiMappings={serviceMappings}
          onSave={async () => {
            const r = await frrApi.saveFilters(routeFilters);
            if (r.success) { toast.success(r.applied ? 'Filters applied to FRR' : 'Filters saved'); await load(true); }
            else toast.error(r.error);
          }}
          onRollback={async () => {
            const r = await frrApi.rollbackFilters();
            if (r.success) { setRouteFiltersState(r.filters ?? []); toast.success('Rolled back to previous filters'); await load(true); }
            else toast.error(r.error);
          }}
        />
      )}

      {/* Migration wizard */}
      <>
        {/* Progress bar — hidden when migration is complete */}
        {!isComplete && (
          <div className="nms-card">
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {PHASE_ORDER.map((p, i) => (
                <div key={p} className="flex items-center gap-1 shrink-0">
                  <div className={clsx('w-2.5 h-2.5 rounded-full shrink-0 transition-colors',
                    i < phaseIdx ? 'bg-green-400' : i === phaseIdx ? 'bg-nms-accent' : 'bg-nms-border'
                  )} title={PHASE_LABELS[p]} />
                  <span className={clsx('text-xs hidden lg:block truncate max-w-24',
                    i < phaseIdx ? 'text-green-400' : i === phaseIdx ? 'text-nms-accent font-medium' : 'text-nms-text-dim/40'
                  )}>{PHASE_LABELS[p]}</span>
                  {i < PHASE_ORDER.length - 1 && <ChevronRight className="w-3 h-3 text-nms-border shrink-0" />}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Config summary (read-only) — shown after migration is complete */}
        {isComplete ? (
          <div className="nms-card space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-400" />
                Active Configuration
              </h2>
              <p className="text-xs text-nms-text-dim">Use <span className="font-medium text-nms-text">Reconfigure</span> or <span className="font-medium text-nms-text">Reset state</span> to make changes</p>
            </div>

            {/* Protocol + Peer IP pill row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-nms-bg border border-nms-border rounded-xl px-4 py-3">
                <p className="text-xs text-nms-text-dim mb-0.5">Protocol</p>
                <p className="text-sm font-bold font-mono text-nms-text">{protocol.toUpperCase()}</p>
              </div>
              <div className="bg-nms-bg border border-nms-border rounded-xl px-4 py-3">
                <p className="text-xs text-nms-text-dim mb-0.5">
                  {protocol === 'eigrp' ? 'AS Number' : protocol === 'ospf' ? 'Process ID' : 'Local AS'}
                </p>
                <p className="text-sm font-bold font-mono text-nms-text">
                  {protocol === 'eigrp' ? eigrpAs : protocol === 'ospf' ? ospfPid : bgpLocal}
                </p>
              </div>
              <div className="bg-nms-bg border border-nms-border rounded-xl px-4 py-3">
                <p className="text-xs text-nms-text-dim mb-0.5">Peer IP</p>
                <p className="text-sm font-bold font-mono text-nms-text">
                  {protocol === 'eigrp' ? eigrpPeer : protocol === 'ospf' ? transitIface : bgpPeerIp}
                </p>
              </div>
            </div>

            {/* VSI mappings table */}
            <div>
              <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">Service IP → VSI Mappings</p>
              <div className="rounded-xl border border-nms-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-nms-surface-2 border-b border-nms-border">
                      <th className="text-left px-4 py-2 text-nms-text-dim font-medium">Service</th>
                      <th className="text-left px-4 py-2 text-nms-text-dim font-medium">Service IP</th>
                      <th className="text-left px-4 py-2 text-nms-text-dim font-medium">VSI Interface</th>
                    </tr>
                  </thead>
                  <tbody>
                    {serviceMappings.map((svc, i) => (
                      <tr key={i} className={clsx('border-b border-nms-border last:border-0', i % 2 === 0 ? 'bg-nms-bg' : 'bg-nms-surface-2/30')}>
                        <td className="px-4 py-2 font-mono font-medium text-nms-text">{svc.service || <span className="text-nms-text-dim/40">—</span>}</td>
                        <td className="px-4 py-2 font-mono text-nms-accent">{svc.ip}/32</td>
                        <td className="px-4 py-2 font-mono text-nms-text-dim">{svc.dummyName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
        <div className={clsx('nms-card space-y-4', !warningAccepted && 'opacity-50 pointer-events-none')}>
          <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-nms-accent/20 text-nms-accent text-xs flex items-center justify-center font-bold">1</span>
            Interface assignment &amp; protocol selection
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="nms-label">Management interface <span className="text-red-400">(never touched)</span></label>
              <select value={mgmtIface} onChange={e => setMgmtIface(e.target.value)} className="nms-input text-sm">
                <option value="">— select —</option>
                {interfaces.map(i => <option key={i.name} value={i.name}>{i.name}{i.addresses[0] ? ` (${i.addresses[0]})` : ''}{i.isMgmt ? ' ★' : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="nms-label">Transit interface (L3 uplink)</label>
              <select value={transitIface} onChange={e => setTransitIface(e.target.value)} className="nms-input text-sm">
                <option value="">— select —</option>
                {interfaces.filter(i => i.name !== mgmtIface).map(i => <option key={i.name} value={i.name}>{i.name}{i.addresses[0] ? ` (${i.addresses[0]})` : ' (unconfigured)'}</option>)}
              </select>
              <input value={transitCidr} onChange={e => setTransitCidr(e.target.value)} placeholder="192.168.253.2/30" className="nms-input text-sm font-mono mt-1" />
            </div>
            <div>
              <label className="nms-label">Service plane interface (to migrate)</label>
              <select value={svcIface} onChange={e => setSvcIface(e.target.value)} className="nms-input text-sm">
                <option value="">— select —</option>
                {interfaces.filter(i => i.name !== mgmtIface && i.name !== transitIface).map(i => <option key={i.name} value={i.name}>{i.name}{i.addresses[0] ? ` (${i.addresses[0]})` : ''}</option>)}
              </select>
              <p className="text-xs text-nms-text-dim mt-1">Open5GS service IPs currently here — cleaned up at cutover</p>
            </div>
          </div>
          <div>
            <label className="nms-label">Routing protocol</label>
            <div className="flex gap-3 flex-wrap">
              {(['ospf', 'bgp', 'eigrp'] as Protocol[]).map(p => (
                <button key={p} onClick={() => setProtocol(p)}
                  className={clsx('px-4 py-2 rounded-lg border text-sm font-medium transition-all',
                    protocol === p ? 'bg-nms-accent/10 border-nms-accent/40 text-nms-accent' : 'border-nms-border text-nms-text-dim hover:text-nms-text'
                  )}>
                  {p.toUpperCase()}
                  {p === 'ospf'  && <span className="ml-1.5 text-[10px] text-green-400/70">recommended</span>}
                  {p === 'eigrp' && <span className="ml-1.5 text-[10px] text-amber-400/70">Cisco only</span>}
                </button>
              ))}
            </div>
          </div>
          <ProtocolForm {...protoFormProps} />
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="nms-label mb-0">Service IP → VSI mappings</label>
              <button onClick={() => setServiceMappings(m => [...m, { service: '', ip: '', dummyName: 'dummy-' }])} className="nms-btn-ghost text-xs">+ Add</button>
            </div>
            <div className="space-y-1.5">
              {serviceMappings.map((svc, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={svc.service} onChange={e => setServiceMappings(m => m.map((s, j) => j === i ? { ...s, service: e.target.value } : s))}
                    placeholder="service" className="nms-input font-mono text-xs w-20 shrink-0" />
                  <input value={svc.ip} onChange={e => setServiceMappings(m => m.map((s, j) => j === i ? { ...s, ip: e.target.value } : s))}
                    placeholder="10.0.1.155" className="nms-input font-mono text-xs flex-1" />
                  <ChevronRight className="w-3 h-3 text-nms-text-dim shrink-0" />
                  <input value={svc.dummyName} onChange={e => setServiceMappings(m => m.map((s, j) => j === i ? { ...s, dummyName: e.target.value } : s))}
                    placeholder="dummy-amf" className="nms-input font-mono text-xs flex-1" />
                  <span className="text-xs text-nms-text-dim shrink-0">/32</span>
                  <button onClick={() => setServiceMappings(m => m.filter((_, j) => j !== i))} className="text-red-400/60 hover:text-red-400 text-xs shrink-0 px-1">✕</button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between pt-2">
            <button onClick={async () => { await saveConfig(); const cfg = await frrApi.previewConfig(); setPreviewConfig(cfg); setShowPreview(true); }}
              disabled={!transitIface || !mgmtIface} className="nms-btn-ghost flex items-center gap-2 text-sm">
              <Eye className="w-4 h-4" /> Preview FRR config
            </button>
            <button onClick={async () => { await saveConfig(); toast.success('Configuration saved — proceed to Phase 0 below'); }}
              disabled={!transitIface || !mgmtIface || !svcIface} className="nms-btn-primary flex items-center gap-2 text-sm">
              Save configuration →
            </button>
          </div>
          {showPreview && previewConfig && (
            <div>
              <p className="text-xs text-nms-text-dim mb-1 flex items-center gap-1"><Shield className="w-3.5 h-3.5" /> Generated FRR config (preview — not yet applied)</p>
              <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-nms-text border border-nms-border max-h-64 overflow-y-auto">{previewConfig}</pre>
            </div>
          )}
        </div>
        )} {/* end isComplete ternary */}

        {/* Phase cards — hidden when complete */}
        {!isComplete && (
          <div className={clsx('space-y-3', !warningAccepted && 'opacity-50 pointer-events-none')}>
            <PhaseCard title="Phase 0 — Create backup"
              description="Backup netplan config, FRR config, routing table, and interface state before any changes"
              phase="BACKUP_CREATED" current={currentPhase} acting={acting}
              canRun={currentPhase === 'INIT' && !!mgmtIface && !!transitIface && !!svcIface}
              onRun={async () => { await saveConfig(); const r = await frrApi.backup(); if (r.success) { await load(true); toast.success('Backup created'); } else toast.error(r.error); }}
              onRewind={async () => rewind(REWIND_TO.BACKUP_CREATED!)}
            />
            <PhaseCard title="Phase 1 — Install FRR"
              description={frrInstalled ? 'FRR already installed — click Execute to verify daemons and confirm phase.' : `Install frr + frr-pythontools. Enable zebra + ${protocol}d. No network changes.`}
              phase="FRR_INSTALLED" current={currentPhase} acting={acting}
              canRun={currentPhase === 'BACKUP_CREATED'}
              onRun={async () => { await runStream(frrApi.installFrr, 'Install FRR'); }}
              streamLog={streamLog}
              onRewind={async () => rewind(REWIND_TO.FRR_INSTALLED!)}
            />
            <PhaseCard title="Phase 2 — Configure transit interface"
              description={`Apply ${transitCidr} to ${transitIface || 'transit interface'} via netplan apply`}
              phase="TRANSIT_CONFIGURED" current={currentPhase} acting={acting}
              canRun={currentPhase === 'FRR_INSTALLED'}
              onRun={async () => { await runStream(frrApi.transit, 'Transit config'); }}
              streamLog={streamLog}
              warning="netplan apply is used — changes are applied immediately"
              onRewind={async () => rewind(REWIND_TO.TRANSIT_CONFIGURED!)}
            />
            <PhaseCard title="Phase 3 — Establish routing neighbor"
              description={`Write FRR ${protocol.toUpperCase()} transit-only config and wait for neighbor/peer to come up`}
              phase="NEIGHBOR_UP" current={currentPhase} acting={acting}
              canRun={currentPhase === 'TRANSIT_CONFIGURED'}
              onRun={async () => { await runStream(frrApi.neighbor, 'FRR neighbor config'); toast.success('FRR restarted — polling for neighbor…'); startNeighborPolling(); }}
              streamLog={streamLog}
              extraContent={neighborTimer ? (
                <div className="flex items-center gap-2 text-xs text-nms-accent mt-1">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Polling for neighbor every 5s…
                </div>
              ) : null}
              onRewind={async () => rewind(REWIND_TO.NEIGHBOR_UP!)}
            />
            <PhaseCard title="Phase 4 — Create Virtual Service Interfaces (VSIs)"
              description={`Create ${serviceMappings.length} dummy /32 VSIs then update FRR config with explicit network statements for each.`}
              phase="DUMMY_INTERFACES_CREATED" current={currentPhase} acting={acting}
              canRun={currentPhase === 'NEIGHBOR_UP'}
              onRun={async () => { const r = await frrApi.createDummies(); if (r.success) { await load(true); toast.success('VSIs created, FRR updated'); } else toast.error(r.error); }}
              onRewind={async () => rewind(REWIND_TO.DUMMY_INTERFACES_CREATED!)}
            />
            <PhaseCard title="Phase 5 — Verify service IP advertisement"
              description="Confirm all /32 service IPs are in the routing table and management IPs are not leaking"
              phase="SERVICE_DUAL_STACK_ACTIVE" current={currentPhase} acting={acting}
              canRun={currentPhase === 'DUMMY_INTERFACES_CREATED'}
              onRun={async () => {
                const r = await frrApi.advertise();
                if (r.success && r.advertised) { await load(true); toast.success('All service IPs advertised'); }
                else { toast.error(r.message ?? r.error ?? 'Check failed', { duration: 8000 }); await load(true); }
              }}
              onRewind={async () => rewind(REWIND_TO.SERVICE_DUAL_STACK_ACTIVE!)}
              extraContent={currentPhase === 'DUMMY_INTERFACES_CREATED' ? (
                <div className="flex items-center gap-2 text-xs text-nms-text-dim mt-1">
                  <span>VSIs up but check failing?</span>
                  <button onClick={async () => {
                    if (!confirm('Skip verification and advance to cutover?\n\nOnly do this if routes are reachable from the upstream router.')) return;
                    await frrApi.rewind('SERVICE_DUAL_STACK_ACTIVE'); await load(true); toast.success('Advanced to cutover phase');
                  }} className="text-nms-accent hover:underline">Skip verification</button>
                </div>
              ) : null}
            />
            <PhaseCard title="Phase 6 — Cutover (remove legacy service IPs)"
              description={`Remove service IPs from ${svcIface || 'legacy interface'}, write unified netplan, mark migration complete.`}
              phase="LEGACY_INTERFACES_REMOVED" current={currentPhase} acting={acting}
              canRun={currentPhase === 'SERVICE_DUAL_STACK_ACTIVE'}
              onRun={async () => { await runStream(frrApi.cutover, 'Cutover'); }}
              streamLog={streamLog} isDangerous
              warning="Open5GS services will briefly reconnect via VSIs during cutover. Changes are applied immediately."
              onRewind={async () => rewind(REWIND_TO.LEGACY_INTERFACES_REMOVED!)}
            />
          </div>
        )}

        {/* Migration log */}
        {(migState?.log?.length ?? 0) > 0 && (
          <div className="nms-card">
            <h2 className="text-sm font-semibold text-nms-text mb-3">Migration log</h2>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {[...migState.log].reverse().map((entry: any, i: number) => (
                <div key={i} className="flex items-start gap-3 text-xs font-mono">
                  <span className="text-nms-text-dim/50 shrink-0">{new Date(entry.ts).toLocaleTimeString()}</span>
                  <span className={clsx('shrink-0', entry.ok ? 'text-green-400' : 'text-red-400')}>{entry.ok ? '✓' : '✗'}</span>
                  <span className="text-nms-text-dim shrink-0">[{entry.phase}]</span>
                  <span className="text-nms-text">{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </> {/* end migration wizard fragment */}
      </>)} {/* end routing tab */}
    </div>
  );
}
