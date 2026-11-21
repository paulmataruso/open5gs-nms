import { createContext, useContext } from 'react';

// The context, its types and its hook live here rather than beside
// AuthProvider: a module that exports anything which is not a component has
// Fast Refresh disabled for the whole module, so with useAuth next to the
// provider, editing either one forced a full page reload — and a full reload
// of this app re-checks the session and drops you back through the auth
// gate. Provider in AuthContext.tsx, everything else here.

export interface AuthUser {
  id: string;
  username: string;
  role: string;
  createdAt: string | null;
  lastLoginAt: string | null;
}

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
