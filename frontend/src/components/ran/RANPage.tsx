import { useEffect } from 'react';
import { Radio, Activity, Users, Circle, Wifi, Network } from 'lucide-react';
import { useTopologyStore } from '../../stores';
import { clsx } from 'clsx';

interface RANPageProps {
  onNavigateToSubscriber?: (imsi: string) => void;
}

// ── Reusable interface card ───────────────────────────────────────────────────

interface InterfaceCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  devices: string[];
  deviceLabel: string;       // 'eNodeB' or 'gNodeB'
  generation: '4G' | '5G';
}

function InterfaceCard({
  icon,
  title,
  subtitle,
  active,
  devices,
  deviceLabel,
  generation,
}: InterfaceCardProps): JSX.Element {
  const is5G = generation === '5G';
  const accentColor = is5G ? 'text-nms-accent' : 'text-purple-400';
  const accentBg   = is5G ? 'bg-nms-accent/10' : 'bg-purple-500/10';

  return (
    <div className="nms-card">
      <div className="flex items-center gap-3 mb-4">
        <div className={clsx('p-2 rounded-lg', active ? (is5G ? 'bg-nms-green/10' : 'bg-nms-green/10') : 'bg-nms-red/10')}>
          <div className={active ? 'text-nms-green' : 'text-nms-red'}>
            {icon}
          </div>
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
          {devices.length} {devices.length === 1 ? deviceLabel : `${deviceLabel}s`} connected
        </span>
      </div>

      {/* Device list */}
      {devices.length > 0 ? (
        <div className="border border-nms-border rounded-md overflow-hidden">
          <div className="bg-nms-surface-2 px-3 py-2 border-b border-nms-border">
            <span className="text-xs font-semibold text-nms-text">Connected {deviceLabel}s</span>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {devices.map((ip, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between px-3 py-2 border-b border-nms-border last:border-b-0 hover:bg-nms-surface-2/50 transition-colors"
              >
                <span className="text-sm font-mono text-nms-text">{ip}</span>
                <Circle className="w-2 h-2 fill-nms-green text-nms-green" />
              </div>
            ))}
          </div>
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
  const interfaceStatus    = useTopologyStore((s) => s.interfaceStatus);
  const fetchInterfaceStatus = useTopologyStore((s) => s.fetchInterfaceStatus);

  useEffect(() => {
    fetchInterfaceStatus();
    const interval = setInterval(fetchInterfaceStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchInterfaceStatus]);

  // 4G
  const s1mmeActive  = interfaceStatus?.s1mme?.active            || false;
  const s1mmeEnodebs = interfaceStatus?.s1mme?.connectedEnodebs   || [];
  const s1uActive    = interfaceStatus?.s1u?.active               || false;
  const s1uEnodebs   = interfaceStatus?.s1u?.connectedEnodebs     || [];

  // 5G
  const n2Active     = interfaceStatus?.n2?.active                || false;
  const n2Gnodebs    = interfaceStatus?.n2?.connectedGnodebs      || [];
  const n3Active     = interfaceStatus?.n3?.active                || false;
  const n3Gnodebs    = interfaceStatus?.n3?.connectedGnodebs      || [];

  // Sessions
  const activeUEs4G  = interfaceStatus?.activeUEs4G || [];
  const activeUEs5G  = interfaceStatus?.activeUEs5G || [];

  // Merge with generation tag for the table
  const allSessions = [
    ...activeUEs4G.map(ue => ({ ...ue, gen: '4G' as const })),
    ...activeUEs5G.map(ue => ({ ...ue, gen: '5G' as const })),
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-display text-nms-text mb-1">RAN Network</h1>
        <p className="text-sm text-nms-text-dim">Radio Access Network interface status and active sessions</p>
      </div>

      {/* 4G EPC section */}
      <div>
        <SectionHeader label="4G EPC" color="4G" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <InterfaceCard
            icon={<Radio className="w-5 h-5" />}
            title="S1-MME Interface"
            subtitle="Control Plane (MME ↔ eNodeB)"
            active={s1mmeActive}
            devices={s1mmeEnodebs}
            deviceLabel="eNodeB"
            generation="4G"
          />
          <InterfaceCard
            icon={<Activity className="w-5 h-5" />}
            title="S1-U Interface"
            subtitle="User Plane (SGW-U ↔ eNodeB)"
            active={s1uActive}
            devices={s1uEnodebs}
            deviceLabel="eNodeB"
            generation="4G"
          />
        </div>
      </div>

      {/* 5G NR section */}
      <div>
        <SectionHeader label="5G NR" color="5G" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <InterfaceCard
            icon={<Wifi className="w-5 h-5" />}
            title="N2 Interface"
            subtitle="Control Plane (AMF ↔ gNodeB)"
            active={n2Active}
            devices={n2Gnodebs}
            deviceLabel="gNodeB"
            generation="5G"
          />
          <InterfaceCard
            icon={<Network className="w-5 h-5" />}
            title="N3 Interface"
            subtitle="User Plane (UPF ↔ gNodeB)"
            active={n3Active}
            devices={n3Gnodebs}
            deviceLabel="gNodeB"
            generation="5G"
          />
        </div>
      </div>

      {/* Active UE Sessions */}
      <div className="nms-card">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-nms-accent/10">
            <Users className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold font-display text-nms-text">Active UE Sessions</h2>
            <p className="text-xs text-nms-text-dim">Connected user equipment with active PDN/PDU sessions</p>
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
            <table className="w-full">
              <thead className="bg-nms-surface-2 border-b border-nms-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">
                    IMSI
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text uppercase tracking-wider">
                    Assigned IP
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">
                    Generation
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-nms-text uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border">
                {allSessions.map((ue, idx) => (
                  <tr key={idx} className="hover:bg-nms-surface-2/50 transition-colors">
                    <td className="px-4 py-3 text-sm font-mono">
                      <button
                        onClick={() => onNavigateToSubscriber?.(ue.imsi)}
                        className="text-nms-accent hover:text-nms-accent-hover hover:underline transition-colors cursor-pointer text-left"
                      >
                        {ue.imsi}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-nms-text">
                      {ue.ip}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={clsx(
                        'inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold',
                        ue.gen === '5G'
                          ? 'bg-nms-accent/10 text-nms-accent'
                          : 'bg-purple-500/10 text-purple-400',
                      )}>
                        {ue.gen}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-nms-green/10 text-nms-green text-xs font-medium">
                        <Circle className="w-1.5 h-1.5 fill-nms-green" />
                        Active
                      </span>
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
            <p className="text-xs mt-1">UE sessions will appear here when devices connect</p>
          </div>
        )}
      </div>
    </div>
  );
};
