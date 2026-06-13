import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Pencil, Trash2, ArrowUp, ArrowDown, RefreshCw,
  AlertTriangle, Info, Network, CheckCircle, XCircle,
} from 'lucide-react';
import { tunApi, configApi, type TunInterface } from '../api';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

interface ModalProps {
  mode: 'create' | 'edit';
  initial?: TunInterface;
  suggestedName?: string;
  onSave: (data: { name: string; ip: string; prefix: number }) => Promise<void>;
  onClose: () => void;
}

function TunModal({ mode, initial, suggestedName, onSave, onClose }: ModalProps) {
  const [name,   setName]   = useState(initial?.name   || suggestedName || 'ogstun2');
  const [ip,     setIp]     = useState(initial?.ip     || '');
  const [prefix, setPrefix] = useState(String(initial?.prefix || 16));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const p = parseInt(prefix);
    if (!name.match(/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/)) { toast.error('Name must start with a letter, max 15 chars, letters/digits/hyphen/underscore only'); return; }
    if (!ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) { toast.error('Enter a valid IPv4 address'); return; }
    if (isNaN(p) || p < 1 || p > 32) { toast.error('Prefix must be between 1 and 32'); return; }
    setSaving(true);
    try { await onSave({ name, ip, prefix: p }); onClose(); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="nms-card w-full max-w-md">
        <h2 className="text-lg font-bold font-display text-nms-text mb-4">
          {mode === 'create' ? 'Create TUN Interface' : `Edit ${initial?.name}`}
        </h2>
        <div className="space-y-4">
          <div>
            <label className="nms-label">Interface Name</label>
            <input className="nms-input font-mono" value={name} onChange={e => setName(e.target.value)} disabled={mode === 'edit'} placeholder="ogstun2" />
            <p className="text-xs text-nms-text-dim mt-1">Any valid Linux interface name — starts with a letter, max 15 chars, e.g. <span className="font-mono">ogstun2</span>, <span className="font-mono">upf-ims</span>, <span className="font-mono">tun_data</span></p>
          </div>
          <div>
            <label className="nms-label">Gateway IP Address</label>
            <input className="nms-input font-mono" value={ip} onChange={e => setIp(e.target.value)} placeholder="10.46.0.1" />
            <p className="text-xs text-nms-text-dim mt-1">The IP assigned to the TUN interface — the gateway for the UE pool. Must match <span className="font-mono">gateway:</span> in your UPF session config.</p>
          </div>
          <div>
            <label className="nms-label">Prefix Length</label>
            <input className="nms-input font-mono" type="number" min={1} max={32} value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="16" />
            <p className="text-xs text-nms-text-dim mt-1">e.g. <span className="font-mono">16</span> means UE pool is <span className="font-mono">{ip || '10.46.0.0'}/{prefix || '16'}</span></p>
          </div>
          <div className="p-3 rounded bg-blue-500/10 border border-blue-500/20 flex items-start gap-2">
            <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <p className="text-xs text-nms-text-dim">Ensure the <span className="font-mono">subnet:</span> and <span className="font-mono">dev: {name || 'ogstun2'}</span> fields in your UPF session config match this interface.</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="nms-btn-ghost" disabled={saving}>Cancel</button>
          <button onClick={handleSave} className="nms-btn-primary flex items-center gap-2" disabled={saving}>
            {saving ? 'Saving...' : mode === 'create' ? 'Create' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StateDot({ state }: { state: 'up' | 'down' }) {
  if (state === 'up') return <CheckCircle className="w-4 h-4 text-nms-green" />;
  return <XCircle className="w-4 h-4 text-nms-red" />;
}

export function TunInterfacePage() {
  const { user } = useAuth();
  const isAdmin  = user?.role === 'admin';

  const [interfaces,    setInterfaces]    = useState<TunInterface[]>([]);
  const [networkdActive, setNetworkdActive] = useState(true);
  const [nextName,      setNextName]      = useState('ogstun2');
  const [loading,       setLoading]       = useState(true);
  const [modal,         setModal]         = useState<null | { mode: 'create' | 'edit'; iface?: TunInterface }>(null);
  const [actingOn,      setActingOn]      = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Map of TUN interface name -> { dnn, subnet } from UPF session config
  const [devMap, setDevMap] = useState<Map<string, { dnn: string; subnet: string }>>(new Map());

  const load = useCallback(async () => {
    try {
      const [tunData, configs] = await Promise.all([
        tunApi.list(),
        configApi.getAll().catch(() => null),
      ]);
      setInterfaces(tunData.interfaces);
      setNetworkdActive(tunData.networkdActive);
      setNextName(tunData.nextName);

      // Build dev -> { dnn, subnet } from UPF session pools
      if (configs) {
        const upfSessions: any[] = (configs.upf as any)?.upf?.session || [];
        const map = new Map<string, { dnn: string; subnet: string }>();
        for (const sess of upfSessions) {
          if (sess.dev) {
            map.set(sess.dev, { dnn: sess.dnn || '', subnet: sess.subnet || '' });
          }
        }
        // ogstun (default) = first session pool with no dev field
        const defaultSess = upfSessions.find(s => !s.dev);
        if (defaultSess) {
          map.set('ogstun', { dnn: defaultSess.dnn || 'internet', subnet: defaultSess.subnet || '' });
        }
        setDevMap(map);
      }
    } catch {
      toast.error('Failed to load TUN interfaces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (data: { name: string; ip: string; prefix: number }) => {
    await tunApi.create(data);
    toast.success(`Interface ${data.name} created`);
    await load();
  };

  const handleEdit = async (data: { name: string; ip: string; prefix: number }) => {
    await tunApi.edit(data.name, { ip: data.ip, prefix: data.prefix });
    toast.success(`Interface ${data.name} updated`);
    await load();
  };

  const handleDelete = async (name: string) => {
    setActingOn(name);
    try {
      await tunApi.delete(name);
      toast.success(`Interface ${name} deleted`);
      setConfirmDelete(null);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || `Failed to delete ${name}`);
    } finally {
      setActingOn(null);
    }
  };

  const handleToggle = async (iface: TunInterface) => {
    setActingOn(iface.name);
    try {
      if (iface.state === 'up') {
        await tunApi.setDown(iface.name);
        toast.success(`${iface.name} brought down`);
      } else {
        await tunApi.setUp(iface.name);
        toast.success(`${iface.name} brought up`);
      }
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || `Failed to toggle ${iface.name}`);
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-display text-nms-text flex items-center gap-2">
            <Network className="w-6 h-6 text-nms-accent" />
            TUN Interfaces
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Manage TUN interfaces for multi-APN deployments.
            Changes are applied immediately and persisted via systemd-networkd (.netdev + .network pairs).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={load} className="nms-btn-ghost flex items-center gap-2" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button onClick={() => setModal({ mode: 'create' })} className="nms-btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Interface
            </button>
          )}
        </div>
      </div>

      {/* systemd-networkd warning */}
      {!networkdActive && (
        <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-300">systemd-networkd is not active</p>
            <p className="text-xs text-nms-text-dim mt-1">
              Interface changes will apply immediately but <strong>will not persist across reboots</strong>. Enable systemd-networkd to activate persistence.
            </p>
          </div>
        </div>
      )}

      {/* Info banner */}
      <div className="p-3 rounded-lg border border-nms-border bg-nms-surface-2/30 flex items-start gap-3 text-xs text-nms-text-dim">
        <Info className="w-4 h-4 text-nms-accent shrink-0 mt-0.5" />
        <span>
          The default <span className="font-mono text-nms-text">ogstun</span> is created by Open5GS and cannot be deleted here.
          Create additional interfaces with any valid name for multi-APN setups and set the matching{' '}
          <span className="font-mono text-nms-text">dev:</span> field in your UPF session config.
          Each interface is persisted via a <span className="font-mono text-nms-text">.netdev</span> +{' '}
          <span className="font-mono text-nms-text">.network</span> pair in <span className="font-mono text-nms-text">/etc/systemd/network/</span>.
        </span>
      </div>

      {/* Interface table */}
      <div className="nms-card p-0 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-nms-text-dim">Loading interfaces...</div>
        ) : interfaces.length === 0 ? (
          <div className="p-8 text-center text-nms-text-dim">No ogstun interfaces found.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-nms-border">
                <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">State</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Interface</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">IP / Prefix</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">APN / Pool</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Managed by</th>
                {isAdmin && (
                  <th className="px-4 py-3 text-right text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-nms-border/50">
              {interfaces.map(iface => {
                const acting = actingOn === iface.name;
                return (
                  <tr key={iface.name} className={clsx('transition-colors', acting ? 'opacity-60' : 'hover:bg-nms-surface-2/40')}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <StateDot state={iface.exists ? iface.state : 'down'} />
                        <span className={clsx('text-xs font-medium', iface.state === 'up' ? 'text-nms-green' : 'text-nms-text-dim')}>
                          {!iface.exists ? 'NOT CREATED' : iface.state.toUpperCase()}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-nms-text">{iface.name}</td>
                    <td className="px-4 py-3 font-mono text-sm text-nms-accent">
                      {iface.ip && iface.prefix ? `${iface.ip}/${iface.prefix}` : <span className="text-nms-text-dim">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const info = devMap.get(iface.name);
                        if (!info) return <span className="text-xs text-nms-text-dim">Not configured in UPF</span>;
                        return (
                          <div>
                            {info.dnn && (
                              <span className="text-xs font-mono text-nms-accent font-semibold">{info.dnn}</span>
                            )}
                            {info.subnet && (
                              <span className="text-xs font-mono text-nms-text-dim ml-2">{info.subnet}</span>
                            )}
                            {!info.dnn && !info.subnet && (
                              <span className="text-xs text-nms-text-dim">Default pool</span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      {iface.default ? (
                        <span className="text-xs bg-nms-surface-2 border border-nms-border text-nms-text-dim rounded px-2 py-0.5">Open5GS</span>
                      ) : iface.managed ? (
                        <span className="text-xs bg-nms-accent/10 border border-nms-accent/20 text-nms-accent rounded px-2 py-0.5">NMS (persistent)</span>
                      ) : (
                        <span className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-2 py-0.5">Manual</span>
                      )}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {iface.exists && (
                            <button
                              onClick={() => handleToggle(iface)}
                              disabled={acting}
                              title={iface.state === 'up' ? 'Bring down' : 'Bring up'}
                              className={clsx('p-1.5 rounded transition-colors', iface.state === 'up' ? 'text-amber-400 hover:bg-amber-500/10' : 'text-nms-green hover:bg-nms-green/10')}
                            >
                              {iface.state === 'up' ? <ArrowDown className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
                            </button>
                          )}
                          {!iface.default && iface.managed && (
                            <button onClick={() => setModal({ mode: 'edit', iface })} disabled={acting} title="Edit IP" className="p-1.5 rounded text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 transition-colors">
                              <Pencil className="w-4 h-4" />
                            </button>
                          )}
                          {!iface.default && iface.managed && (
                            <button onClick={() => setConfirmDelete(iface.name)} disabled={acting} title="Delete" className="p-1.5 rounded text-nms-text-dim hover:text-nms-red hover:bg-red-500/10 transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Persistence note */}
      {networkdActive && (
        <div className="text-xs text-nms-text-dim flex items-center gap-2">
          <CheckCircle className="w-3.5 h-3.5 text-nms-green" />
          systemd-networkd is active — NMS-managed interfaces persist across reboots via <span className="font-mono">/etc/systemd/network/10-nms-*.netdev</span> + <span className="font-mono">*.network</span>
        </div>
      )}

      {/* Create / Edit modal */}
      {modal && (
        <TunModal
          mode={modal.mode}
          initial={modal.iface}
          suggestedName={modal.mode === 'create' ? nextName : undefined}
          onSave={modal.mode === 'create' ? handleCreate : handleEdit}
          onClose={() => setModal(null)}
        />
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="nms-card w-full max-w-sm">
            <h2 className="text-lg font-bold font-display text-nms-text mb-2">Delete {confirmDelete}?</h2>
            <p className="text-sm text-nms-text-dim mb-4">
              This will bring the interface down, remove it from the OS, and delete its systemd-networkd configuration.
              UEs using this pool will lose connectivity.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="nms-btn-ghost">Cancel</button>
              <button onClick={() => handleDelete(confirmDelete)} className="nms-btn-danger flex items-center gap-2" disabled={actingOn === confirmDelete}>
                <Trash2 className="w-4 h-4" />
                {actingOn === confirmDelete ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
