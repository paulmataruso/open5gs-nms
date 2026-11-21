import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { authApi } from '../api';
import { AuthContext, type AuthUser } from './auth-context';

// ─────────────────────────────────────────────────────────────
// Auth Provider
// ─────────────────────────────────────────────────────────────
// Only the provider belongs in this file. The context object, its types and
// the useAuth hook are in ./auth-context so that this module exports nothing
// but a component and Fast Refresh keeps working — see that file's comment.

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true); // true on mount while we check session

  // On mount: check if a valid session cookie already exists
  useEffect(() => {
    authApi
      .me()
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const u = await authApi.login(username, password);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
