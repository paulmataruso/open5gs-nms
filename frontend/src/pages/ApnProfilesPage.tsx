import { useState, useEffect, useCallback } from 'react';
import { Network, Plus, Pencil, Trash2, Save, RefreshCw, X, AlertTriangle, Wand2, Globe2 } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  apnProfilesApi, type ApnProfileListEntry, type ApnProfileInput, type ApnProfile,
} from '../api/apnProfiles';

const DEFAULT_INPUT: ApnProfileInput = {
  dnn: '', dev: '', subnet: '', gateway: '',
  qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
  staticRangeStart: null, staticRangeEnd: null,
  dynamicRangeStart: null, dynamicRangeEnd: null,
};

function ProfileFormModal({
  initial, onClose, onSaved,
}: {
  initial?: ApnProfile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ApnProfileInput>(initial ? {
    dnn: initial.dnn, dev: initial.dev, subnet: initial.subnet, gateway: initial.gateway,
    subnetV6: initial.subnetV6, gatewayV6: initial.gatewayV6, qos: initial.qos,
    staticRangeStart: initial.staticRangeStart, staticRangeEnd: initial.staticRangeEnd,
    dynamicRangeStart: initial.dynamicRangeStart, dynamicRangeEnd: initial.dynamicRangeEnd,
  } : DEFAULT_INPUT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // #30 follow-up: whether a core-wide IPv6 pool is configured at all — only
  // shows the "Auto-fill" button when there's actually something to fill
  // from. Fetched once on open, not kept live — this is a cheap read and the
  // form is short-lived.
  const [ipv6PoolConfigured, setIpv6PoolConfigured] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);

  useEffect(() => {
    apnProfilesApi.getIPv6Settings()
      .then(s => setIpv6PoolConfigured(!!s.parentPrefix))
      .catch(() => {});
  }, []);

  const autoFillIPv6 = async () => {
    setAutoFilling(true);
    try {
      const next = await apnProfilesApi.previewNextIPv6Subnet();
      if (!next) {
        toast.error('No IPv6 pool configured');
        return;
      }
      setForm(f => ({ ...f, subnetV6: next.subnet, gatewayV6: next.gateway }));
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to allocate an IPv6 subnet');
    } finally {
      setAutoFilling(false);
    }
  };

  const save = async () => {
    setError('');
    if (!form.dnn.trim() || !form.dev.trim() || !form.subnet.trim() || !form.gateway.trim()) {
      setError('DNN, device, subnet, and gateway are all required.');
      return;
    }
    setSaving(true);
    try {
      if (initial) await apnProfilesApi.update(initial.id, form);
      else await apnProfilesApi.create(form);
      toast.success(`Profile ${form.dnn} saved`);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border">
          <h2 className="text-lg font-semibold font-display text-nms-text flex items-center gap-2">
            <Network className="w-5 h-5 text-nms-accent" />
            {initial ? `Edit ${initial.dnn}` : 'New APN Profile'}
          </h2>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="nms-label mb-1">DNN / APN Name</label>
              <input
                className="nms-input w-full font-mono disabled:opacity-60"
                value={form.dnn}
                onChange={e => setForm(f => ({ ...f, dnn: e.target.value }))}
                disabled={!!initial}
                placeholder="ptt.example.com"
              />
            </div>
            <div>
              <label className="nms-label mb-1">TUN Device</label>
              <input
                className="nms-input w-full font-mono"
                value={form.dev}
                onChange={e => setForm(f => ({ ...f, dev: e.target.value }))}
                placeholder="ptt"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="nms-label mb-1">IPv4 Subnet</label>
              <input
                className="nms-input w-full font-mono"
                value={form.subnet}
                onChange={e => setForm(f => ({ ...f, subnet: e.target.value }))}
                placeholder="198.51.100.0/24"
              />
            </div>
            <div>
              <label className="nms-label mb-1">Gateway</label>
              <input
                className="nms-input w-full font-mono"
                value={form.gateway}
                onChange={e => setForm(f => ({ ...f, gateway: e.target.value }))}
                placeholder="198.51.100.1"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="nms-label mb-0">IPv6 (optional)</label>
              {ipv6PoolConfigured && (
                <button
                  type="button"
                  onClick={autoFillIPv6}
                  disabled={autoFilling}
                  title="Fill in the next unused /64 from the configured IPv6 pool"
                  className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-0.5"
                >
                  <Wand2 className="w-3 h-3" /> {autoFilling ? 'Allocating…' : 'Auto-fill from pool'}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                className="nms-input w-full font-mono"
                value={form.subnetV6 ?? ''}
                onChange={e => setForm(f => ({ ...f, subnetV6: e.target.value || undefined }))}
                placeholder="2001:db8:cafe::/64"
              />
              <input
                className="nms-input w-full font-mono"
                value={form.gatewayV6 ?? ''}
                onChange={e => setForm(f => ({ ...f, gatewayV6: e.target.value || undefined }))}
                placeholder="2001:db8:cafe::1"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-nms-border">
            <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">QoS Defaults</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="nms-label mb-1">5QI/QCI</label>
                <input
                  className="nms-input w-full font-mono" type="number" min={1} max={255}
                  value={form.qos.index}
                  onChange={e => setForm(f => ({ ...f, qos: { ...f.qos, index: parseInt(e.target.value) || 9 } }))}
                />
              </div>
              <div>
                <label className="nms-label mb-1">ARP Priority</label>
                <input
                  className="nms-input w-full font-mono" type="number" min={1} max={15}
                  value={form.qos.arp.priority_level}
                  onChange={e => setForm(f => ({ ...f, qos: { ...f.qos, arp: { ...f.qos.arp, priority_level: parseInt(e.target.value) || 8 } } }))}
                />
              </div>
              <div>
                <label className="nms-label mb-1">Pre-emption</label>
                <select
                  className="nms-input w-full"
                  value={form.qos.arp.pre_emption_capability}
                  onChange={e => setForm(f => ({ ...f, qos: { ...f.qos, arp: { ...f.qos.arp, pre_emption_capability: parseInt(e.target.value) } } }))}
                >
                  <option value={1}>Disabled</option>
                  <option value={2}>Enabled</option>
                </select>
              </div>
            </div>
          </div>

          <div className="pt-2 border-t border-nms-border">
            <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">
              Static / Dynamic Split
            </p>
            <p className="text-[11px] text-nms-text-dim mb-2">
              Auto-Assign IPs draws exclusively from the dynamic range — addresses in the
              static range are never at risk of being handed out automatically. Leave both
              blank to let auto-assign use the whole pool (today's behavior).
            </p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="nms-label mb-1">Static Start</label>
                <input
                  className="nms-input w-full font-mono"
                  value={form.staticRangeStart ?? ''}
                  onChange={e => setForm(f => ({ ...f, staticRangeStart: e.target.value || null }))}
                  placeholder="198.51.100.2"
                />
              </div>
              <div>
                <label className="nms-label mb-1">Static End</label>
                <input
                  className="nms-input w-full font-mono"
                  value={form.staticRangeEnd ?? ''}
                  onChange={e => setForm(f => ({ ...f, staticRangeEnd: e.target.value || null }))}
                  placeholder="198.51.100.49"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="nms-label mb-1">Dynamic Start</label>
                <input
                  className="nms-input w-full font-mono"
                  value={form.dynamicRangeStart ?? ''}
                  onChange={e => setForm(f => ({ ...f, dynamicRangeStart: e.target.value || null }))}
                  placeholder="198.51.100.50"
                />
              </div>
              <div>
                <label className="nms-label mb-1">Dynamic End</label>
                <input
                  className="nms-input w-full font-mono"
                  value={form.dynamicRangeEnd ?? ''}
                  onChange={e => setForm(f => ({ ...f, dynamicRangeEnd: e.target.value || null }))}
                  placeholder="198.51.100.254"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-nms-red">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="nms-btn-ghost flex-1 text-sm" disabled={saving}>Cancel</button>
            <button onClick={save} className="nms-btn-primary flex-1 text-sm flex items-center justify-center gap-2" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create Profile'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// #30 follow-up: the core-wide IPv6 parent prefix new profiles auto-carve a
// /64 out of. Compact, collapsed-by-default-feeling settings row rather than
// a whole separate page — this is one field, and it's directly next to the
// thing it affects.
function Ipv6PoolCard() {
  const [parentPrefix, setParentPrefix] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apnProfilesApi.getIPv6Settings();
      setParentPrefix(s.parentPrefix);
      setInput(s.parentPrefix ?? '');
    } catch {
      // Non-fatal — the rest of the page (IPv4-only) works fine either way.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await apnProfilesApi.updateIPv6Settings(input.trim() || null);
      setParentPrefix(result.parentPrefix);
      toast.success(result.parentPrefix ? `IPv6 pool set to ${result.parentPrefix}` : 'IPv6 pool cleared');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update IPv6 pool');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <div className="nms-card flex items-center gap-3 flex-wrap">
      <Globe2 className="w-4 h-4 text-nms-accent shrink-0" />
      <div className="flex-1 min-w-[240px]">
        <p className="text-xs font-semibold text-nms-text">IPv6 Pool</p>
        <p className="text-[11px] text-nms-text-dim">
          A core-wide parent prefix (e.g. a /48 or /56) — new profiles can auto-allocate the next unused /64 from it instead of a hand-typed subnet.
        </p>
      </div>
      <input
        className="nms-input font-mono text-xs w-56"
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="2001:db8:cafe::/48 (none set)"
      />
      <button
        onClick={save}
        disabled={saving || input.trim() === (parentPrefix ?? '')}
        className="nms-btn-ghost text-xs px-3 py-1.5"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

export function ApnProfilesPage() {
  const [entries, setEntries] = useState<ApnProfileListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<null | 'add' | ApnProfile>(null);
  const [busyDnn, setBusyDnn] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await apnProfilesApi.list());
    } catch {
      toast.error('Failed to load APN profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handlePromote = async (dnn: string) => {
    setBusyDnn(dnn);
    try {
      await apnProfilesApi.promote(dnn);
      toast.success(`${dnn} saved as a profile`);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || `Failed to save ${dnn}`);
    } finally {
      setBusyDnn(null);
    }
  };

  const handleDelete = async (profile: ApnProfile) => {
    if (!confirm(`Delete the profile for "${profile.dnn}"? This only removes the profile metadata — smf.yaml/upf.yaml and any subscribers already using this DNN are untouched.`)) return;
    setBusyDnn(profile.dnn);
    try {
      await apnProfilesApi.remove(profile.id);
      toast.success(`Profile ${profile.dnn} deleted`);
      await load();
    } catch (err: any) {
      toast.error(err.response?.data?.error || `Failed to delete ${profile.dnn}`);
    } finally {
      setBusyDnn(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
            <Network className="w-6 h-6 text-nms-accent" />
            APN Profiles
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            One object per DNN — pool, device, QoS defaults, and a static/dynamic IP split.
            Saving writes both smf.yaml and upf.yaml so they can't drift out of sync.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="nms-btn-ghost flex items-center gap-2" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setModal('add')} className="nms-btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> New Profile
          </button>
        </div>
      </div>

      <Ipv6PoolCard />

      <div className="nms-card p-0 overflow-hidden overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-nms-text-dim">Loading APN profiles...</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-nms-text-dim">No DNNs found in smf.yaml/upf.yaml yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-nms-border text-left text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                <th className="px-4 py-3">DNN</th>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Subnet</th>
                <th className="px-4 py-3">Static Range</th>
                <th className="px-4 py-3">Dynamic Range</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nms-border/50">
              {entries.map(e => (
                <tr key={e.dnn} className="hover:bg-nms-surface-2/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-nms-text">{e.dnn}</td>
                  <td className="px-4 py-3 font-mono text-nms-text-dim">{e.dev}</td>
                  <td className="px-4 py-3 font-mono text-nms-text-dim">{e.subnet}</td>
                  <td className="px-4 py-3 font-mono text-xs text-nms-text-dim">
                    {e.persisted && e.staticRangeStart ? `${e.staticRangeStart} – ${e.staticRangeEnd}` : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-nms-text-dim">
                    {e.persisted && e.dynamicRangeStart ? `${e.dynamicRangeStart} – ${e.dynamicRangeEnd}` : e.persisted ? 'Whole pool' : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {e.persisted ? (
                      <span className="text-xs bg-nms-accent/10 border border-nms-accent/20 text-nms-accent rounded px-2 py-0.5">Saved</span>
                    ) : (
                      <span className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-2 py-0.5">Not saved</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      {e.persisted ? (
                        <>
                          <button
                            onClick={() => setModal(e)}
                            disabled={busyDnn === e.dnn}
                            title="Edit"
                            className="nms-btn-ghost text-xs flex items-center gap-1 px-2 py-1"
                          >
                            <Pencil className="w-3.5 h-3.5" /> Edit
                          </button>
                          <button
                            onClick={() => handleDelete(e)}
                            disabled={busyDnn === e.dnn}
                            title="Delete profile (config untouched)"
                            className="nms-btn-ghost text-xs flex items-center gap-1 px-2 py-1 text-red-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Delete
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handlePromote(e.dnn)}
                          disabled={busyDnn === e.dnn || !e.gateway}
                          title={e.gateway ? 'Save this discovered DNN as a real profile' : 'No matching UPF gateway — edit upf.yaml first'}
                          className="nms-btn-primary text-xs flex items-center gap-1 px-2 py-1"
                        >
                          <Save className="w-3.5 h-3.5" /> {busyDnn === e.dnn ? 'Saving…' : 'Save as Profile'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal && (
        <ProfileFormModal
          initial={modal === 'add' ? undefined : modal}
          onClose={() => setModal(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
