import { useState } from 'react';
import { clsx } from 'clsx';
import {
  Radio, Settings, Users, Activity, Network,
  ChevronLeft, ChevronRight, Database, ScrollText,
  Key, UserCog, BarChart2, EyeOff, Shield, ShieldCheck, Clock, GitBranch, Zap, MessageSquare, Phone, PhoneCall, FlaskConical, Wifi, Globe, Radar, TrendingUp, RadioTower, Calculator, Layers, Gauge,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { NmsLogo, NmsLogoMark } from './NmsLogo';
import { UserMenu } from './UserMenu';
import { FEATURES } from '../../config/features';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const NAV_ITEMS: Array<{ id: string; label: string; icon: React.ComponentType<any> }> = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'topology', label: 'Topology', icon: Network },
  { id: 'ran', label: 'RAN Network', icon: Radio },
  { id: 'radio-signal', label: 'UE Signal', icon: Wifi },
  { id: 'services', label: 'Services', icon: Activity },
  { id: 'config', label: 'Configuration', icon: Settings },
  { id: 'auto-config', label: 'Auto Config', icon: Zap },
  { id: 'radio-config', label: 'Radio Provisioning', icon: RadioTower },
  ...(FEATURES.rfPlanning ? [{ id: 'rf-planning', label: 'RF Planning', icon: Calculator }] : []),
  { id: 'apn-profiles', label: 'APN Profiles', icon: Layers },
  { id: 'subscribers', label: 'Subscribers', icon: Users },
  { id: 'suci', label: 'SUCI Keys', icon: Key },
  { id: 'backup', label: 'Backup & Restore', icon: Database },
  { id: 'logs', label: 'Unified Logs', icon: ScrollText },
  { id: 'metrics', label: 'Metrics', icon: BarChart2 },
  { id: 'traffic-history', label: 'Traffic History', icon: TrendingUp },
  { id: 'sas',         label: 'SAS',          icon: Shield    },
  { id: 'time-server', label: 'Time Server',   icon: Clock     },
  { id: 'frr', label: 'L3 Routing', icon: GitBranch },
  { id: 'bind', label: 'DNS (BIND9)', icon: Globe },
  ...(FEATURES.sms ? [{ id: 'sms', label: FEATURES.mms ? 'SMS/MMS' : 'SMS', icon: MessageSquare }] : []),
  ...(FEATURES.ims ? [{ id: 'ims', label: 'IMS / VoLTE', icon: Phone }] : []),
  ...(FEATURES.pstn ? [{ id: 'pstn', label: 'PSTN Gateway', icon: PhoneCall }] : []),
  ...(FEATURES.vowifi ? [{ id: 'vowifi', label: 'VoWiFi', icon: Wifi }] : []),
  ...(FEATURES.secgw ? [{ id: 'secgw', label: 'SecGW', icon: ShieldCheck }] : []),
  ...(FEATURES.twamp ? [{ id: 'twamp', label: 'TWAMP', icon: Gauge }] : []),
  ...(FEATURES.validation ? [{ id: 'validation', label: 'UE/Core Validation', icon: FlaskConical }] : []),
  ...(FEATURES.pcap ? [{ id: 'pcap', label: 'Packet Capture', icon: Radar }] : []),
  { id: 'users',   label: 'User Management', icon: UserCog },
];

export function Layout({ children, activeTab, onTabChange }: LayoutProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const { user } = useAuth();

  return (
    <div className="flex h-screen overflow-hidden bg-nms-bg">
      {/* Sidebar */}
      <aside
        className={clsx(
          'flex flex-col border-r border-nms-border bg-nms-surface transition-all duration-200',
          collapsed ? 'w-16' : 'w-56',
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 h-14 border-b border-nms-border shrink-0">
          {collapsed
            ? <NmsLogoMark size={32} />
            : <NmsLogo size={32} showWordmark />
          }
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-all',
                activeTab === item.id
                  ? 'bg-nms-accent/10 text-nms-accent border border-nms-accent/20'
                  : 'text-nms-text-dim hover:bg-nms-surface-2 hover:text-nms-text border border-transparent',
              )}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {!collapsed && (
                <span className="font-display flex-1 truncate text-left">{item.label}</span>
              )}
            </button>
          ))}

        </nav>

        {/* User + Theme + Logout */}
        <UserMenu collapsed={collapsed} />

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center h-10 border-t border-nms-border text-nms-text-dim hover:text-nms-text transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {user?.role === 'viewer' && (
          <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
            <EyeOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-xs text-amber-400">View-only mode — you can monitor but cannot make changes</span>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
