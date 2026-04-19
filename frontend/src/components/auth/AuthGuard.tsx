import { useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useServiceStore } from '../../stores';
import { LoginPage } from './LoginPage';

// ─────────────────────────────────────────────────────────────
// Auth Guard — wraps the entire app
// Shows a full-screen spinner during initial session check,
// LoginPage if unauthenticated, or children if authenticated.
// ─────────────────────────────────────────────────────────────

export function AuthGuard({ children }: { children: React.ReactNode }): JSX.Element {
  const { user, loading } = useAuth();
  const fetchStatuses = useServiceStore((s) => s.fetchStatuses);

  // Only fetch service statuses once the user is confirmed authenticated
  useEffect(() => {
    if (user) {
      fetchStatuses();
    }
  }, [user, fetchStatuses]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-nms-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-nms-accent to-cyan-600 flex items-center justify-center animate-pulse">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p className="text-sm text-nms-text-dim font-display">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <>{children}</>;
}
