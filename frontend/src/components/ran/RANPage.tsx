import { useEffect } from 'react';
import { Radio, Activity, Users, Circle, Wifi, Network, Shield, ChevronRight } from 'lucide-react';
import { useTopologyStore } from '../../stores';
import { clsx } from 'clsx';

interface RANPageProps {
  onNavigateToSubscriber?: (imsi: string) => void;
}

interface ConnectedRadio {
  ip: string;
  numConnectedUes: number;
  setupSuccess: boolean;
  plmn?: string;
}

interface ActiveUE {
  ip: string;
  imsi: string;
  cmState?: string;
  dnn?: string;
  apn?: string;
  sliceSst?: number;
  sliceSd?: string;
  securityEnc?: string;
  securityInt?: string;
  ambrDownlink?: number;
  ambrUplink?: number;
  radioIp?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAmbr(bps?: number): string {
  if (!bps) return '—';
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(1)} Gbps`;
  if (bps >= 1_000_000)     return `${(bps / 1_000_000).toFixed(0)} Mbps`;
  if (bps >= 1_000)         return `${(bps / 1_000).toFixed(0)} Kbps`;
  return `${bps} bps`;
}

// ── UE sub-row inside a radio card ────────────────────────────────────────────

function UESubRow({ ue, gen, onNavigate }: {
  ue: ActiveUE;
  gen: '4G' | '5G';
  onNavigate?: (imsi: string) => void;
}): JSX.Element {
  const is5G = gen === '5G';
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-nms-border last:border-b-0 hover:bg-nms-surface-2/40 transition-colors">
      <ChevronRight className="w-3 h-3 text-nms-text-dim flex-shrink-0" />
      <div className="flex-1 min-w-0 grid grid-cols-3 gap-2 items-center">
        {/* IMSI */}
        <button
          onClick={() => onNavigate?.(ue.imsi)}
          className="text-xs font-mono text-nms-accent hover:underline text-left truncate"
        >
          {ue.imsi}
        </button>
        {/* IP */}
        <span className="text-xs font-mono text-nms-text text-center">
          {ue.ip || '—'}
        </span>
        {/* CM State */}
        <div className="flex justify-end">
          {ue.cmState ? (
            <span className={clsx(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium',
              ue.cmState === 'connected'
                ? 'bg-nms-green/10 text-nms-green'
                : 'bg-nms-text-dim/10 text-nms-text-dim',
            )}>
              <Circle className="w-1.5 h-1.5 fill-current" />
              {ue.cmState}
            </span>
          ) : (
            <span className={clsx(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium',
              'bg-nms-green/10 text-nms-green',
            )}>
              <Circle className="w-1.5 h-1.5 fill-current" />
              active
            </span>
          )}
        </div>
      </div>
      {/* DNN/APN */}
      <span className="text-xs font-mono text-nms-text-dim w-16 text-right truncate">
        {ue.dnn || ue.apn || '—'}
      </span>
      {/* Security (5G only) */}
      {is5G && (ue.securityEnc || ue.securityInt) && (
        <span className="text-xs text-nms-text-dim flex items-center gap-1">
          <Shield className="w-3 h-3 text-nms-accent flex-shrink-0" />
          <span className="font-mono">{ue.securityEnc?.toUpperCase()}</span>
        </span>
      )}
    </div>
  );
}

// ── Reusable interface card ───────────────────────────────────────────────────

interface InterfaceCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  radios: ConnectedRadio[];
  deviceLabel: string;
  generation: '4G' | '5G';
  ues: ActiveUE[];
  onNavigateToSubscriber?: (imsi: string) => void;
}

function InterfaceCard({
  icon, title, subtitle, active, radios, deviceLabel, generation, ues, onNavigateToSubscriber,
}: InterfaceCardProps): JSX.Element {
  const is5G = generation === '5G';
  const accentColor = is5G ? 'text-nms-accent' : 'text-purple-400';
  const accentBg   = is5G ? 'bg-nms-accent/10' : 'bg-purple-500/10';

  return (
    <div className="nms-card">
      {/* Card header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={clsx('p-2 rounded-lg', active ? 'bg-nms-green/10' : 'bg-nms-red/10')}>
          <div className={active ? 'text-nms-green' : 'text-nms-red'}>{icon}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold font-display text-nms-text">{title}</h2>
            <span className={clsx('text-xs font-bold px-1.5 py-0.5 rounded', accentBg, accentColor)}>
              {generation}
            </span>
          </div>
          <p className="text-xs text-nms-text-dim">{subtitle}</p>
        </div>
      </div>

      {/* Status row */}
      <div className="flex items-center gap-2 mb-4">
        <Circle className={clsx('w-2 h-2', active ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red')} />
        <span className={clsx('text-sm font-medium', active ? 'text-nms-green' : 'text-nms-red')}>
          {active ? 'Active' : 'Inactive'}
        </span>
        <span className="text-xs text-nms-text-dim ml-auto">
          {radios.length} {radios.length === 1 ? deviceLabel : `${deviceLabel}s`} connected
        </span>
      </div>

      {/* Radio list — each radio shows its connected UEs below it */}
      {radios.length > 0 ? (
        <div className="border border-nms-border rounded-md overflow-hidden">
          {/* Column headers */}
          <div className="bg-nms-surface-2 px-3 py-2 border-b border-nms-border grid grid-cols-3 text-xs font-semibold text-nms-text uppercase tracking-wider">
            <span>IP Address</span>
            <span className="text-center">UEs</span>
            <span className="text-right">Status</span>
          </div>

          {radios.map((radio, idx) => {
            const radioUEs = ues.filter(ue => ue.radioIp === radio.ip);
            return (
              <div key={idx}>
                {/* Radio row */}
                <div className="grid grid-cols-3 items-center px-3 py-2 border-b border-nms-border hover:bg-nms-surface-2/50 transition-colors bg-nms-surface-2/20">
                  <span className="text-sm font-mono font-semibold text-nms-text">{radio.ip}</span>
                  <span className="text-center text-sm font-bold text-nms-accent">{radio.numConnectedUes}</span>
                  <div className="flex justify-end">
                    <Circle className={clsx('w-2 h-2', radio.setupSuccess ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red')} />
                  </div>
                </div>

                {/* UE sub-rows */}
                {radioUEs.length > 0 && (
                  <div className="bg-nms-surface-2/10">
                    {/* UE column headers — only shown on first radio */}
                    {idx === 0 && (
                      <div className="grid grid-cols-3 gap-2 px-3 py-1 border-b border-nms-border/50">
                        <span className="text-xs text-nms-text-dim pl-5">IMSI</span>
                        <span className="text-xs text-nms-text-dim text-center">UE IP</span>
                        <span className="text-xs text-nms-text-dim text-right">State</span>
                      </div>
                    )}
                    {radioUEs.map((ue, ueIdx) => (
                      <UESubRow
                        key={ueIdx}
                        ue={ue}
                        gen={generation}
                        onNavigate={onNavigateToSubscriber}
                      />
                    ))}
                  </div>
                )}

                {/* Radio has UEs per counter but none resolved to this IP */}
                {radioUEs.length === 0 && radio.numConnectedUes > 0 && (
                  <div className="px-6 py-1.5 border-b border-nms-border/50 last:border-b-0">
                    <span className="text-xs text-nms-text-dim italic">
                      {radio.numConnectedUes} UE{radio.numConnectedUes > 1 ? 's' : ''} connected (session details pending)
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-8 text-nms-text-dim text-sm">
          No {deviceLabel}s connected
        </div>
      )}
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ label, color }: { label: string; color: '4G' | '5G' }): JSX.Element {
  const is5G = color === '5G';
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className={clsx(
        'text-xs font-bold uppercase tracking-widest px-2.5 py-1 rounded',
        is5G ? 'bg-nms-accent/15 text-nms-accent' : 'bg-purple-500/15 text-purple-400',
      )}>
        {label}
      </span>
      <div className="flex-1 h-px bg-nms-border" />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export const RANPage: React.FC<RANPageProps> = ({ onNavigateToSubscriber }) => {
  const interfaceStatus      = useTopologyStore((s) => s.interfaceStatus);
  const fetchInterfaceStatus = useTopologyStore((s) => s.fetchInterfaceStatus);

  useEffect(() => {
    fetchInterfaceStatus();
    const interval = setInterval(fetchInterfaceStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchInterfaceStatus]);

  // 4G
  const s1mmeActive  = interfaceStatus?.s1mme?.active            || false;
  const s1mmeRadios  = (interfaceStatus?.s1mme?.connectedEnodebs || []) as ConnectedRadio[];
  const s1uActive    = interfaceStatus?.s1u?.active               || false;
  const s1uRadios    = (interfaceStatus?.s1u?.connectedEnodebs   || []) as ConnectedRadio[];

  // 5G
  const n2Active     = interfaceStatus?.n2?.active                || false;
  const n2Radios     = (interfaceStatus?.n2?.connectedGnodebs    || []) as ConnectedRadio[];
  const n3Active     = interfaceStatus?.n3?.active                || false;
  const n3Radios     = (interfaceStatus?.n3?.connectedGnodebs    || []) as ConnectedRadio[];

  // Sessions
  const activeUEs4G  = (interfaceStatus?.activeUEs4G || []) as ActiveUE[];
  const activeUEs5G  = (interfaceStatus?.activeUEs5G || []) as ActiveUE[];
  const allSessions  = [
    ...activeUEs4G.map(ue => ({ ...ue, gen: '4G' as const })),
    ...activeUEs5G.map(ue => ({ ...ue, gen: '5G' as const })),
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-display text-nms-text mb-1">RAN Network</h1>
        <p className="text-sm text-nms-text-dim">
          Radio Access Network — interface status, connected radios, and active UE sessions
        </p>
      </div>

      {/* 4G EPC */}
      <div>
        <SectionHeader label="4G EPC" color="4G" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <InterfaceCard
            icon={<Radio className="w-5 h-5" />}
            title="S1-MME Interface"
            subtitle="Control Plane (MME ↔ eNodeB)"
            active={s1mmeActive}
            radios={s1mmeRadios}
            deviceLabel="eNodeB"
            generation="4G"
            ues={activeUEs4G}
            onNavigateToSubscriber={onNavigateToSubscriber}
          />
          <InterfaceCard
            icon={<Activity className="w-5 h-5" />}
            title="S1-U Interface"
            subtitle="User Plane (SGW-U ↔ eNodeB)"
            active={s1uActive}
            radios={s1uRadios}
            deviceLabel="eNodeB"
            generation="4G"
            ues={activeUEs4G}
            onNavigateToSubscriber={onNavigateToSubscriber}
          />
        </div>
      </div>

      {/* 5G NR */}
      <div>
        <SectionHeader label="5G NR" color="5G" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <InterfaceCard
            icon={<Wifi className="w-5 h-5" />}
            title="N2 Interface"
            subtitle="Control Plane (AMF ↔ gNodeB)"
            active={n2Active}
            radios={n2Radios}
            deviceLabel="gNodeB"
            generation="5G"
            ues={activeUEs5G}
            onNavigateToSubscriber={onNavigateToSubscriber}
          />
          <InterfaceCard
            icon={<Network className="w-5 h-5" />}
            title="N3 Interface"
            subtitle="User Plane (UPF ↔ gNodeB)"
            active={n3Active}
            radios={n3Radios}
            deviceLabel="gNodeB"
            generation="5G"
            ues={activeUEs5G}
            onNavigateToSubscriber={onNavigateToSubscriber}
          />
        </div>
      </div>

      {/* All Sessions summary table */}
      <div className="nms-card">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-nms-accent/10">
            <Users className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold font-display text-nms-text">All Active UE Sessions</h2>
            <p className="text-xs text-nms-text-dim">Combined 4G + 5G session summary</p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {activeUEs4G.length > 0 && (
              <span className="text-xs font-medium text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">
                {activeUEs4G.length} 4G
              </span>
            )}
            {activeUEs5G.length > 0 && (
              <span className="text-xs font-medium text-nms-accent bg-nms-accent/10 px-2 py-0.5 rounded">
                {activeUEs5G.length} 5G
              </span>
            )}
            <span className="text-sm font-semibold text-nms-accent">
              {allSessions.length} {allSessions.length === 1 ? 'session' : 'sessions'}
            </span>
          </div>
        </div>

        {allSessions.length > 0 ? (
          <div className="border border-nms-border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-nms-surface-2 border-b border-nms-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">IMSI</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">UE IP</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">Radio IP</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">Gen</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">CM State</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">DNN / APN</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">Security</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-nms-text uppercase tracking-wider">AMBR ↓ / ↑</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border">
                {allSessions.map((ue, idx) => (
                  <tr key={idx} className="hover:bg-nms-surface-2/50 transition-colors">
                    <td className="px-4 py-3 font-mono">
                      <button
                        onClick={() => onNavigateToSubscriber?.(ue.imsi)}
                        className="text-nms-accent hover:underline transition-colors"
                      >
                        {ue.imsi}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono text-nms-text text-xs">
                      {ue.ip || <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {ue.radioIp
                        ? <span className={ue.gen === '5G' ? 'text-nms-accent' : 'text-purple-400'}>{ue.radioIp}</span>
                        : <span className="text-nms-text-dim">—</span>
                      }
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={clsx(
                        'inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold',
                        ue.gen === '5G' ? 'bg-nms-accent/10 text-nms-accent' : 'bg-purple-500/10 text-purple-400',
                      )}>
                        {ue.gen}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {ue.cmState ? (
                        <span className={clsx(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                          ue.cmState === 'connected' ? 'bg-nms-green/10 text-nms-green' : 'bg-nms-text-dim/10 text-nms-text-dim',
                        )}>
                          <Circle className="w-1.5 h-1.5 fill-current" />
                          {ue.cmState}
                        </span>
                      ) : <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-4 py-3 text-nms-text font-mono text-xs">
                      {ue.dnn || ue.apn || <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {ue.securityEnc || ue.securityInt ? (
                        <span className="inline-flex items-center gap-1 text-xs text-nms-text-dim">
                          <Shield className="w-3 h-3 text-nms-accent" />
                          <span className="font-mono">{ue.securityEnc?.toUpperCase()}</span>
                          {ue.securityInt && <span className="font-mono">/{ue.securityInt?.toUpperCase()}</span>}
                        </span>
                      ) : <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-nms-text-dim font-mono">
                      {ue.ambrDownlink || ue.ambrUplink
                        ? `${formatAmbr(ue.ambrDownlink)} / ${formatAmbr(ue.ambrUplink)}`
                        : '—'
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-12 text-nms-text-dim">
            <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No active UE sessions</p>
            <p className="text-xs mt-1">Sessions appear here when UEs connect and establish PDN/PDU bearers</p>
          </div>
        )}
      </div>
    </div>
  );
};
