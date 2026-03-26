import { useEffect } from 'react';
import { Radio, Activity, Users, Circle } from 'lucide-react';
import { useTopologyStore } from '../../stores';

interface RANPageProps {
  onNavigateToSubscriber?: (imsi: string) => void;
}

export const RANPage: React.FC<RANPageProps> = ({ onNavigateToSubscriber }) => {
  const interfaceStatus = useTopologyStore((s) => s.interfaceStatus);
  const fetchInterfaceStatus = useTopologyStore((s) => s.fetchInterfaceStatus);

  useEffect(() => {
    fetchInterfaceStatus();
    const interval = setInterval(() => {
      fetchInterfaceStatus();
    }, 30000); // Poll every 30 seconds
    return () => clearInterval(interval);
  }, [fetchInterfaceStatus]);

  // Extract data
  const s1mmeActive = interfaceStatus?.s1mme?.active || false;
  const s1mmeEnodebs = interfaceStatus?.s1mme?.connectedEnodebs || [];
  
  const s1uActive = interfaceStatus?.s1u?.active || false;
  const s1uEnodebs = interfaceStatus?.s1u?.connectedEnodebs || [];
  
  const activeUEs = interfaceStatus?.activeUEs || [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-display text-nms-text mb-1">RAN Network</h1>
        <p className="text-sm text-nms-text-dim">Radio Access Network interface status and active sessions</p>
      </div>

      {/* Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        
        {/* S1-MME Interface */}
        <div className="nms-card">
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg ${s1mmeActive ? 'bg-nms-green/10' : 'bg-nms-red/10'}`}>
              <Radio className={`w-5 h-5 ${s1mmeActive ? 'text-nms-green' : 'text-nms-red'}`} />
            </div>
            <div>
              <h2 className="text-lg font-semibold font-display text-nms-text">S1-MME Interface</h2>
              <p className="text-xs text-nms-text-dim">Control Plane (MME ↔ eNodeB)</p>
            </div>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-2 mb-4">
            <Circle className={`w-2 h-2 ${s1mmeActive ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red'}`} />
            <span className={`text-sm font-medium ${s1mmeActive ? 'text-nms-green' : 'text-nms-red'}`}>
              {s1mmeActive ? 'Active' : 'Inactive'}
            </span>
            <span className="text-xs text-nms-text-dim ml-auto">
              {s1mmeEnodebs.length} {s1mmeEnodebs.length === 1 ? 'eNodeB' : 'eNodeBs'} connected
            </span>
          </div>

          {/* Connected eNodeBs */}
          {s1mmeEnodebs.length > 0 ? (
            <div className="border border-nms-border rounded-md overflow-hidden">
              <div className="bg-nms-surface-2 px-3 py-2 border-b border-nms-border">
                <span className="text-xs font-semibold text-nms-text">Connected eNodeBs</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {s1mmeEnodebs.map((ip, idx) => (
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
              No eNodeBs connected
            </div>
          )}
        </div>

        {/* S1-U Interface */}
        <div className="nms-card">
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-lg ${s1uActive ? 'bg-nms-green/10' : 'bg-nms-red/10'}`}>
              <Activity className={`w-5 h-5 ${s1uActive ? 'text-nms-green' : 'text-nms-red'}`} />
            </div>
            <div>
              <h2 className="text-lg font-semibold font-display text-nms-text">S1-U Interface</h2>
              <p className="text-xs text-nms-text-dim">User Plane (SGW-U ↔ eNodeB)</p>
            </div>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-2 mb-4">
            <Circle className={`w-2 h-2 ${s1uActive ? 'fill-nms-green text-nms-green' : 'fill-nms-red text-nms-red'}`} />
            <span className={`text-sm font-medium ${s1uActive ? 'text-nms-green' : 'text-nms-red'}`}>
              {s1uActive ? 'Active' : 'Inactive'}
            </span>
            <span className="text-xs text-nms-text-dim ml-auto">
              {s1uEnodebs.length} {s1uEnodebs.length === 1 ? 'eNodeB' : 'eNodeBs'} connected
            </span>
          </div>

          {/* Connected eNodeBs */}
          {s1uEnodebs.length > 0 ? (
            <div className="border border-nms-border rounded-md overflow-hidden">
              <div className="bg-nms-surface-2 px-3 py-2 border-b border-nms-border">
                <span className="text-xs font-semibold text-nms-text">Connected eNodeBs</span>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {s1uEnodebs.map((ip, idx) => (
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
              No eNodeBs connected
            </div>
          )}
        </div>
      </div>

      {/* Active UE Sessions - Full Width */}
      <div className="nms-card">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-nms-accent/10">
            <Users className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold font-display text-nms-text">Active UE Sessions</h2>
            <p className="text-xs text-nms-text-dim">Connected user equipment with active PDN sessions</p>
          </div>
          <div className="ml-auto">
            <span className="text-sm font-semibold text-nms-accent">
              {activeUEs.length} {activeUEs.length === 1 ? 'session' : 'sessions'}
            </span>
          </div>
        </div>

        {activeUEs.length > 0 ? (
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
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border">
                {activeUEs.map((ue, idx) => (
                  <tr
                    key={idx}
                    className="hover:bg-nms-surface-2/50 transition-colors"
                  >
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
