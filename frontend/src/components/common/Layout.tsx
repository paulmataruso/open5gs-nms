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
} from 'lucide-react';

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
