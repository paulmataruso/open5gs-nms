import { useState, type FormEvent } from 'react';
import { Zap } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

// ─────────────────────────────────────────────────────────────
// Login Page — matches NMS dark theme
// ─────────────────────────────────────────────────────────────

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(username.trim(), password);
    } catch {
      // Generic message — never reveal which field was wrong
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-nms-bg">
      <div className="w-full max-w-sm px-4">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-nms-accent to-cyan-600 flex items-center justify-center mb-4 shadow-lg shadow-nms-accent/20">
            <Zap className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-semibold font-display text-nms-text tracking-tight">
            Open5GS NMS
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">Sign in to continue</p>
        </div>

        {/* Card */}
        <div className="nms-card">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="nms-label">Username</label>
              <input
                type="text"
                className="nms-input font-mono text-sm"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                autoFocus
                disabled={loading}
                required
              />
            </div>

            <div>
              <label className="nms-label">Password</label>
              <input
                type="password"
                className="nms-input font-mono text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                autoComplete="current-password"
                disabled={loading}
                required
              />
            </div>

            {error && (
              <div className="text-xs text-nms-red bg-nms-red/10 border border-nms-red/20 rounded px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="nms-btn-primary w-full flex items-center justify-center gap-2 mt-2"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-nms-text-dim mt-6">
          Open5GS Network Management System
        </p>
      </div>
    </div>
  );
}
