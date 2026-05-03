import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, KeyRound, UserCog, AlertTriangle, X, Eye, EyeOff, Shield, Eye as EyeIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { usersApi } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import type { AuthUser } from '../../contexts/AuthContext';

function scorePassword(password: string) {
  if (!password) return { score: 0, label: '', color: '', barColor: '' };
  let score = 0;
  if (password.length >= 8)  score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  const c = Math.min(4, Math.max(1, score)) as 1|2|3|4;
  const map = {
    1: { label: 'Weak',   color: 'text-nms-red',   barColor: 'bg-nms-red' },
    2: { label: 'Fair',   color: 'text-nms-amber',  barColor: 'bg-nms-amber' },
    3: { label: 'Good',   color: 'text-blue-400',   barColor: 'bg-blue-400' },
    4: { label: 'Strong', color: 'text-nms-green',  barColor: 'bg-nms-green' },
  };
  return { score: c, ...map[c] };
}

function PasswordStrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const { score, label, color, barColor } = scorePassword(password);
  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-1">
        {[1,2,3,4].map(i => (
          <div key={i} className={clsx('h-1 flex-1 rounded-full transition-all', i <= score ? barColor : 'bg-nms-border')} />
        ))}
      </div>
      <p className={clsx('text-xs font-medium', color)}>{label}</p>
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder, disabled }: {
  value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? 'text' : 'password'} className="nms-input font-mono text-sm pr-9"
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? '••••••••'} disabled={disabled} />
      <button type="button" tabIndex={-1} onClick={() => setShow(s => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-nms-text-dim hover:text-nms-text transition-colors">
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return role === 'admin' ? (
    <span className="inline-flex items-center gap-1 text-[10px] bg-nms-accent/10 text-nms-accent border border-nms-accent/20 rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider">
      <Shield className="w-2.5 h-2.5" /> Admin
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] bg-nms-text-dim/10 text-nms-text-dim border border-nms-border rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider">
      <EyeIcon className="w-2.5 h-2.5" /> Viewer
    </span>
  );
}

function ChangePasswordModal({ user, onClose, onSaved }: { user: AuthUser; onClose: () => void; onSaved: () => void; }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [saving, setSaving]     = useState(false);
  const mismatch = confirm.length > 0 && password !== confirm;
  const valid    = password.length >= 8 && password === confirm;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await usersApi.changePassword(user.id, password);
      toast.success(`Password updated for ${user.username}`);
      onSaved(); onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to change password');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="nms-card w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold font-display text-nms-text">Change Password</h2>
            <p className="text-xs text-nms-text-dim mt-0.5">User: <span className="font-mono text-nms-accent">{user.username}</span></p>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="nms-label">New Password</label>
            <PasswordInput value={password} onChange={setPassword} />
            <PasswordStrengthMeter password={password} />
          </div>
          <div>
            <label className="nms-label">Confirm Password</label>
            <PasswordInput value={confirm} onChange={setConfirm} placeholder="Repeat password" />
            {mismatch && <p className="text-xs text-nms-red mt-1">Passwords do not match</p>}
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="nms-btn-ghost" disabled={saving}>Cancel</button>
          <button onClick={handleSave} disabled={!valid || saving} className="nms-btn-primary flex items-center gap-2">
            <KeyRound className="w-4 h-4" />{saving ? 'Saving...' : 'Save Password'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ user, onClose, onDeleted }: { user: AuthUser; onClose: () => void; onDeleted: () => void; }) {
  const [deleting, setDeleting] = useState(false);
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await usersApi.delete(user.id);
      toast.success(`User ${user.username} deleted`);
      onDeleted(); onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to delete user');
    } finally { setDeleting(false); }
  };
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="nms-card w-full max-w-sm mx-4">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-nms-red/10 border border-nms-red/20 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-nms-red" />
          </div>
          <div>
            <h2 className="text-base font-semibold font-display text-nms-text">Delete User</h2>
            <p className="text-sm text-nms-text-dim mt-1">
              Delete <span className="font-mono text-nms-text">{user.username}</span>? This invalidates all their active sessions.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="nms-btn-ghost" disabled={deleting}>Cancel</button>
          <button onClick={handleDelete} disabled={deleting}
            className="nms-btn-primary bg-nms-red/10 text-nms-red border-nms-red/30 hover:bg-nms-red/20 flex items-center gap-2">
            <Trash2 className="w-4 h-4" />{deleting ? 'Deleting...' : 'Delete User'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function UserManagementPage(): JSX.Element {
  const { user: currentUser } = useAuth();
  const [users, setUsers]     = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole]         = useState<'admin' | 'viewer'>('admin');
  const [adding, setAdding]           = useState(false);
  const [changePwTarget, setChangePwTarget] = useState<AuthUser | null>(null);
  const [deleteTarget, setDeleteTarget]     = useState<AuthUser | null>(null);

  const fetchUsers = useCallback(async () => {
    try { setUsers(await usersApi.list()); }
    catch { toast.error('Failed to load users'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const handleAddUser = async () => {
    if (!newUsername.trim() || newPassword.length < 8) return;
    setAdding(true);
    try {
      await usersApi.create(newUsername.trim(), newPassword, newRole);
      toast.success(`User ${newUsername.trim()} created as ${newRole}`);
      setNewUsername(''); setNewPassword(''); setNewRole('admin');
      await fetchUsers();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to create user');
    } finally { setAdding(false); }
  };

  const handleToggleRole = async (u: AuthUser) => {
    const newR = u.role === 'admin' ? 'viewer' : 'admin';
    try {
      await usersApi.updateRole(u.id, newR);
      toast.success(`${u.username} is now ${newR}`);
      await fetchUsers();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to update role');
    }
  };

  const formatDate = (d: string | null) => d
    ? new Date(d).toLocaleString(undefined, { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
    : 'Never';

  const canAdd = newUsername.trim().length >= 2 && newPassword.length >= 8;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
          <UserCog className="w-6 h-6 text-nms-accent" /> User Management
        </h1>
        <p className="text-sm text-nms-text-dim mt-1">
          Manage NMS accounts. <strong>Admin</strong> users have full access.{' '}
          <strong>Viewer</strong> users can monitor but cannot make changes.
        </p>
      </div>

      {/* Users table */}
      <div className="nms-card">
        <h2 className="text-sm font-semibold font-display text-nms-accent mb-4">Users ({users.length})</h2>
        {loading ? (
          <div className="text-sm text-nms-text-dim py-4">Loading...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-nms-border">
                  {['Username', 'Role', 'Last Login', 'Created', 'Actions'].map((h, i) => (
                    <th key={h} className={clsx('text-xs font-semibold text-nms-text-dim uppercase tracking-wider pb-2 pr-4', i === 4 && 'text-right')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border">
                {users.map(u => {
                  const isSelf   = u.id === currentUser?.id;
                  const isLast   = users.length === 1;
                  const isLastAdmin = users.filter(x => x.role === 'admin').length === 1 && u.role === 'admin';
                  return (
                    <tr key={u.id} className="group">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-nms-accent/20 border border-nms-accent/30 flex items-center justify-center shrink-0">
                            <span className="text-[10px] font-semibold text-nms-accent">{u.username[0].toUpperCase()}</span>
                          </div>
                          <span className="font-mono text-nms-text">{u.username}</span>
                          {isSelf && (
                            <span className="text-[10px] bg-nms-accent/10 text-nms-accent border border-nms-accent/20 rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider">You</span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <RoleBadge role={u.role} />
                      </td>
                      <td className="py-3 pr-4 text-xs text-nms-text-dim font-mono">{formatDate(u.lastLoginAt)}</td>
                      <td className="py-3 pr-4 text-xs text-nms-text-dim font-mono">{formatDate((u as any).createdAt ?? null)}</td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleToggleRole(u)}
                            disabled={isSelf || isLastAdmin}
                            title={isSelf ? "Can't change your own role" : isLastAdmin ? 'Must keep at least one admin' : `Change to ${u.role === 'admin' ? 'viewer' : 'admin'}`}
                            className={clsx('nms-btn-ghost text-xs flex items-center gap-1 py-1 px-2',
                              (isSelf || isLastAdmin) ? 'opacity-30 cursor-not-allowed' : '')}
                          >
                            <Shield className="w-3.5 h-3.5" />
                            {u.role === 'admin' ? 'Make Viewer' : 'Make Admin'}
                          </button>
                          <button onClick={() => setChangePwTarget(u)} className="nms-btn-ghost text-xs flex items-center gap-1 py-1 px-2">
                            <KeyRound className="w-3.5 h-3.5" /> Password
                          </button>
                          <button
                            onClick={() => setDeleteTarget(u)}
                            disabled={isSelf || isLast}
                            className={clsx('nms-btn-ghost text-xs flex items-center gap-1 py-1 px-2',
                              (isSelf || isLast) ? 'opacity-30 cursor-not-allowed' : 'hover:text-nms-red hover:border-nms-red/30')}
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add User */}
      <div className="nms-card">
        <h2 className="text-sm font-semibold font-display text-nms-accent mb-4 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add User
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 items-start">
          <div>
            <label className="nms-label">Username</label>
            <input type="text" className="nms-input font-mono text-sm"
              value={newUsername} onChange={e => setNewUsername(e.target.value.toLowerCase())}
              placeholder="username" disabled={adding}
              onKeyDown={e => e.key === 'Enter' && canAdd && handleAddUser()} />
          </div>
          <div>
            <label className="nms-label">Password</label>
            <PasswordInput value={newPassword} onChange={setNewPassword} disabled={adding} />
            <PasswordStrengthMeter password={newPassword} />
          </div>
          <div>
            <label className="nms-label">Role</label>
            <select className="nms-input" value={newRole} onChange={e => setNewRole(e.target.value as 'admin' | 'viewer')} disabled={adding}>
              <option value="admin">Admin — full access</option>
              <option value="viewer">Viewer — read only</option>
            </select>
          </div>
          <div className="pt-5">
            <button onClick={handleAddUser} disabled={!canAdd || adding}
              className="nms-btn-primary w-full flex items-center justify-center gap-2 h-[38px]">
              <Plus className="w-4 h-4" />{adding ? 'Creating...' : 'Add User'}
            </button>
          </div>
        </div>
        <div className="mt-3 p-3 bg-nms-surface-2 rounded border border-nms-border text-xs text-nms-text-dim space-y-1">
          <p><strong className="text-nms-text">Admin</strong> — full read/write access to all NMS features including config changes, service restarts, subscriber management, and user management.</p>
          <p><strong className="text-nms-text">Viewer</strong> — read-only access. Can view all dashboards, configs, subscribers, logs, and metrics but cannot make any changes.</p>
        </div>
      </div>

      {changePwTarget && <ChangePasswordModal user={changePwTarget} onClose={() => setChangePwTarget(null)} onSaved={fetchUsers} />}
      {deleteTarget   && <DeleteConfirmModal  user={deleteTarget}   onClose={() => setDeleteTarget(null)}   onDeleted={fetchUsers} />}
    </div>
  );
}
