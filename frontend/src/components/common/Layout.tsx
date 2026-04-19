import { useState } from 'react';
import { clsx } from 'clsx';
import {
  Radio,
  Settings,
  Users,
  Activity,
  Network,
  FileText,
  ChevronLeft,
  ChevronRight,
  Zap,
  Database,
  ScrollText,
  Key,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'topology', label: 'Topology', icon: Network },
  { id: 'ran', label: 'RAN Network', icon: Radio },
  { id: 'services', label: 'Services', icon: Activity },
  { id: 'config', label: 'Configuration', icon: Settings },
  { id: 'auto-config', label: 'Auto Config', icon: Zap },
  { id: 'subscribers', label: 'Subscribers', icon: Users },
  { id: 'suci', label: 'SUCI Keys', icon: Key },
  { id: 'backup', label: 'Backup & Restore', icon: Database },
  { id: 'logs', label: 'Unified Logs', icon: ScrollText },
  { id: 'audit', label: 'Audit Log', icon: FileText },
];

export function Layout({ children, activeTab, onTabChange }: LayoutProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const { user, logout } = useAuth();

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
        <div className="flex items-center gap-2 px-4 h-14 border-b border-nms-border shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-nms-accent to-cyan-600 flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <div className="text-sm font-semibold text-nms-text font-display tracking-tight">
                Open5GS
              </div>
              <div className="text-[10px] text-nms-accent uppercase tracking-widest">NMS</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 space-y-1">
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
              {!collapsed && <span className="font-display">{item.label}</span>}
            </button>
          ))}
        </nav>

        {/* User + Logout */}
        <div className="border-t border-nms-border px-2 py-2">
          <div className={clsx(
            'flex items-center gap-2 px-2 py-2 rounded-md',
            collapsed ? 'justify-center' : '',
          )}>
            <div className="w-7 h-7 rounded-full bg-nms-accent/20 border border-nms-accent/30 flex items-center justify-center shrink-0">
              <span className="text-xs font-semibold text-nms-accent">
                {user?.username?.[0]?.toUpperCase() ?? '?'}
              </span>
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-nms-text truncate">{user?.username}</div>
                <div className="text-[10px] text-nms-text-dim uppercase tracking-wider">{user?.role}</div>
              </div>
            )}
            <button
              onClick={logout}
              title="Sign out"
              className="text-nms-text-dim hover:text-nms-red transition-colors shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center h-10 border-t border-nms-border text-nms-text-dim hover:text-nms-text transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
