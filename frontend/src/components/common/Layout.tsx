import { useState } from 'react';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, EyeOff } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { NmsLogo, NmsLogoMark } from './NmsLogo';
import { UserMenu } from './UserMenu';
import { NAV_ITEMS } from './navItems';
import { MobileTopBar, MobileTabBar } from './MobileChrome';
import { useIsMobile } from '../../hooks/useIsMobile';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}


export function Layout({ children, activeTab, onTabChange }: LayoutProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const { user } = useAuth();
  const isMobile = useIsMobile();

  // ONE root element for both shells, and the page lives in ONE keyed <main>.
  //
  // This matters more than it looks. React reconciles by element type at a
  // given position, so returning <MobileShell> in one branch and a <div> in
  // the other would change the root type on every crossing of 768px and
  // unmount the whole page subtree — a running install loses its streamed log
  // with no way to tell whether a 1800s apt-get succeeded, a half-typed
  // subscriber form is gone, open modals close. And this is not an edge case:
  // a modern phone in landscape is ~844px wide, so an ordinary rotation
  // crosses it. The stable key on <main> is what makes React reuse it even
  // though its sibling count differs between the two branches.
  //
  // The chrome is still swapped rather than CSS-hidden, because the two navs
  // have different DOM and ARIA: rendering both would put every destination in
  // the accessibility tree twice and double every focus stop.
  return (
    <div className={isMobile
      ? 'nms-mobile-shell flex flex-col bg-nms-bg'
      : 'flex h-screen overflow-hidden bg-nms-bg'}
    >
      {isMobile ? (
        <MobileTopBar key="chrome-mobile" activeTab={activeTab} />
      ) : (
      /* Sidebar */
      <aside
        key="chrome-desktop"
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
              aria-current={activeTab === item.id ? 'page' : undefined}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-all',
                'min-h-9',
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
        <button aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center h-10 border-t border-nms-border text-nms-text-dim hover:text-nms-text transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </aside>
      )}

      {/* The page. One element, one key, both shells — see the comment above. */}
      <main
        key="page"
        className={isMobile
          ? 'flex-1 overflow-y-auto overscroll-contain'
          : 'flex-1 overflow-auto'}
      >
        {user?.role === 'viewer' && (
          <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
            <EyeOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-xs text-amber-400">View-only mode — you can monitor but cannot make changes</span>
          </div>
        )}
        {children}
      </main>

      {isMobile && <MobileTabBar key="tabbar" activeTab={activeTab} onTabChange={onTabChange} />}
    </div>
  );
}
