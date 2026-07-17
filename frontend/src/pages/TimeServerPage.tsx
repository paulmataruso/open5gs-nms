import { useState, useEffect, useRef, useCallback } from 'react';
import { Clock, CheckCircle, XCircle, AlertCircle, RefreshCw, Plus, Trash2, Save, Terminal, RotateCw, Users } from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

const API = () => (import.meta.env.VITE_API_URL || '/api');

interface ChronyServer  { type: 'server' | 'pool'; address: string; options: string; }
interface ChronyConfig  { servers: ChronyServer[]; allowNets: string[]; localStratum: number; makestep: string; rtcsync: boolean; driftfile: string; logdir: string; }
interface ChronyClient  { hostname: string; ntpRequests: number; ntpDropped: number; ntpInterval: string; ntpLast: string; }
interface ChronySource  { mode: string; state: string; name: string; stratum: string; poll: string; reach: string; lastRx: string; offset: string; error: string; }
interface ChronyTracking { refId: string; refSource: string; stratum: string; refTime: string; sysTimeOffset: string; rmsOffset: string; frequency: string; residualFreq: string; skew: string; rootDelay: string; rootDispersion: string; updateInterval: string; leap: string; }
interface StatusData    { installed: boolean; active: boolean; tracking: ChronyTracking | null; sources: ChronySource[]; }

/** Parse chronyc elapsed-time strings ("3h", "14m", "2d5h30m", raw seconds) → seconds. Returns null for "-" / unknown. */
function parseChronycAge(s: string): number | null {
  if (!s || s === '-') return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let seconds = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)([dhms])/g)) {
    const v = parseInt(n, 10);
    if (unit === 'd') seconds += v * 86400;
    else if (unit === 'h') seconds += v * 3600;
    else if (unit === 'm') seconds += v * 60;
    else seconds += v;
  }
  return seconds > 0 ? seconds : null;
}

function SourceStateLabel({ state }: { state: string }) {
  const map: Record<string, { label: string; color: string }> = {
    '*': { label: 'Selected',  color: 'text-green-400 bg-green-500/10 border-green-500/30' },
    '+': { label: 'Combined',  color: 'text-blue-400  bg-blue-500/10  border-blue-500/30'  },
    '-': { label: 'Rejected',  color: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
    '?': { label: 'Unreachable',color:'text-red-400   bg-red-500/10   border-red-500/30'   },
    'x': { label: 'Falseticker',color:'text-red-400   bg-red-500/10   border-red-500/30'   },
    '!': { label: 'Error',     color: 'text-red-400   bg-red-500/10   border-red-500/30'   },
  };
  const s = map[state] ?? { label: state, color: 'text-nms-text-dim bg-nms-surface border-nms-border' };
  return <span className={`px-1.5 py-0.5 rounded text-xs font-mono border ${s.color}`}>{s.label}</span>;
}

export function TimeServerPage() {
  const [status,    setStatus]    = useState<StatusData | null>(null);
  const [config,    setConfig]    = useState<ChronyConfig | null>(null);
  const [clients,   setClients]   = useState<ChronyClient[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [restarting,setRestarting]= useState(false);
  const [installing,setInstalling]= useState(false);
  const [installLog,setInstallLog]= useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dirty,     setDirty]     = useState(false);
  const installRef = useRef<HTMLPreElement>(null);

  const fetchAll = useCallback(async (silent = false, force = false) => {
    if (!silent) setLoading(true);
    try {
      const [statusRes, configRes, clientsRes] = await Promise.allSettled([
        axios.get(`${API()}/chrony/status`),
        axios.get(`${API()}/chrony/config`),
        axios.get(`${API()}/chrony/clients`),
      ]);
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value.data);
      if (configRes.status === 'fulfilled' && configRes.value.data.config) {
        // Don't overwrite unsaved user edits during background polls
        if (force) setConfig(configRes.value.data.config);
        else setConfig(c => c ?? configRes.value.data.config);
      }
      if (clientsRes.status === 'fulfilled') setClients(clientsRes.value.data.clients ?? []);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(() => fetchAll(true), 10_000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  // Auto-scroll install log
  useEffect(() => {
    if (installRef.current) installRef.current.scrollTop = installRef.current.scrollHeight;
  }, [installLog]);

  const handleInstall = async () => {
    setInstalling(true);
    setInstallLog('');
    try {
      const resp = await fetch(`${API()}/chrony/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setInstallLog(prev => prev + decoder.decode(value));
        }
      }
      await fetchAll();
      toast.success('Chrony installed successfully');
    } catch (err: any) {
      toast.error(`Install failed: ${err.message}`);
    } finally {
      setInstalling(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await axios.put(`${API()}/chrony/config`, config);
      setDirty(false);
      toast.success('Chrony config saved and restarted');
      await fetchAll(true, true);
    } catch (err: any) {
      toast.error(`Save failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await axios.post(`${API()}/chrony/restart`);
      toast.success('Chrony restarted');
      setTimeout(() => fetchAll(true), 2000);
    } catch (err: any) {
      toast.error(`Restart failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setRestarting(false);
    }
  };

  const markDirty = () => setDirty(true);
  const addServer = () => { markDirty(); setConfig(c => c ? { ...c, servers: [...c.servers, { type: 'server', address: '', options: 'iburst' }] } : c); };
  const addPool   = () => { markDirty(); setConfig(c => c ? { ...c, servers: [...c.servers, { type: 'pool',   address: '', options: 'iburst' }] } : c); };
  const removeServer = (i: number) => { markDirty(); setConfig(c => c ? { ...c, servers: c.servers.filter((_, idx) => idx !== i) } : c); };
  const updateServer = (i: number, field: keyof ChronyServer, val: string) => {
    markDirty();
    setConfig(c => c ? { ...c, servers: c.servers.map((s, idx) => idx === i ? { ...s, [field]: val } : s) } : c);
  };
  const addNet    = () => { markDirty(); setConfig(c => c ? { ...c, allowNets: [...c.allowNets, ''] } : c); };
  const removeNet = (i: number) => { markDirty(); setConfig(c => c ? { ...c, allowNets: c.allowNets.filter((_, idx) => idx !== i) } : c); };
  const updateNet = (i: number, val: string) => {
    markDirty();
    setConfig(c => c ? { ...c, allowNets: c.allowNets.map((n, idx) => idx === i ? val : n) } : c);
  };

  if (loading) return (
    <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
      <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading chrony status…
    </div>
  );

  const installed = status?.installed ?? false;
  const active    = status?.active    ?? false;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">Time Server</h1>
          <p className="text-sm text-nms-text-dim mt-1">NTP via Chrony — serves time to radios and UEs</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => fetchAll()} className="nms-btn-ghost flex items-center gap-2 text-sm">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          {installed && active && (
            <button onClick={handleRestart} disabled={restarting}
              className="nms-btn-ghost flex items-center gap-2 text-sm text-amber-400">
              <RotateCw className={`w-4 h-4 ${restarting ? 'animate-spin' : ''}`} />
              {restarting ? 'Restarting…' : 'Restart Chrony'}
            </button>
          )}
          {config && dirty && (
            <button onClick={() => { setDirty(false); fetchAll(true, true); }}
              className="nms-btn-ghost flex items-center gap-2 text-sm text-nms-text-dim">
              Discard
            </button>
          )}
          {config && (
            <button onClick={handleSave} disabled={saving}
              className={`nms-btn-primary flex items-center gap-2 text-sm ${dirty ? 'ring-2 ring-nms-accent/50' : ''}`}>
              <Save className="w-4 h-4" />
              {saving ? 'Saving…' : dirty ? 'Save & Restart *' : 'Save & Restart'}
            </button>
          )}
        </div>
      </div>

      {/* Status banner */}
      <div className={`nms-card flex items-center gap-4 ${!installed ? 'border-amber-500/30 bg-amber-500/5' : active ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
        <div className="flex items-center gap-2">
          {!installed
            ? <AlertCircle className="w-5 h-5 text-amber-400" />
            : active
              ? <CheckCircle className="w-5 h-5 text-green-400" />
              : <XCircle    className="w-5 h-5 text-red-400"   />
          }
          <div>
            <p className="text-sm font-semibold">
              {!installed ? 'Chrony not installed' : active ? 'Chrony running' : 'Chrony stopped'}
            </p>
            {status?.tracking && (
              <p className="text-xs text-nms-text-dim mt-0.5">
                Synced to <span className="font-mono text-nms-text">{status.tracking.refSource || status.tracking.refId}</span>
                {status.tracking.stratum && <> · Stratum <span className="font-mono text-nms-text">{status.tracking.stratum}</span></>}
                {status.tracking.sysTimeOffset && <> · Offset <span className="font-mono text-nms-text">{status.tracking.sysTimeOffset.split(' ')[0]}</span></>}
              </p>
            )}
          </div>
        </div>
        {!installed && (
          <button onClick={handleInstall} disabled={installing}
            className="ml-auto nms-btn-primary flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            {installing ? 'Installing…' : 'Install Chrony'}
          </button>
        )}
      </div>

      {/* Install output */}
      {installLog && (
        <div className="nms-card border-nms-border">
          <p className="text-xs font-semibold text-nms-text-dim mb-2 flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5" /> Install Output
          </p>
          <pre ref={installRef} className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 h-48 overflow-y-auto whitespace-pre-wrap">
            {installLog}
          </pre>
        </div>
      )}

      {/* Tracking details */}
      {status?.tracking && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text mb-3">Tracking Status</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Reference',      value: status.tracking.refSource || status.tracking.refId },
              { label: 'Stratum',        value: status.tracking.stratum },
              { label: 'System Offset',  value: status.tracking.sysTimeOffset.split(' ')[0] },
              { label: 'RMS Offset',     value: status.tracking.rmsOffset.split(' ')[0] },
              { label: 'Frequency',      value: status.tracking.frequency.split(' ')[0] },
              { label: 'Root Delay',     value: status.tracking.rootDelay.split(' ')[0] },
              { label: 'Update Interval',value: status.tracking.updateInterval.split(' ')[0] },
              { label: 'Leap Status',    value: status.tracking.leap },
            ].map(({ label, value }) => (
              <div key={label} className="bg-nms-bg rounded px-3 py-2">
                <p className="text-xs text-nms-text-dim">{label}</p>
                <p className="text-sm font-mono text-nms-text mt-0.5 truncate">{value || '—'}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sources table */}
      {status?.sources && status.sources.length > 0 && (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text mb-3">NTP Sources</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-nms-text-dim border-b border-nms-border">
                  <th className="text-left pb-2 pr-3">State</th>
                  <th className="text-left pb-2 pr-3">Source</th>
                  <th className="text-left pb-2 pr-3">Stratum</th>
                  <th className="text-left pb-2 pr-3">Poll</th>
                  <th className="text-left pb-2 pr-3">Reach</th>
                  <th className="text-left pb-2 pr-3">Last Rx</th>
                  <th className="text-left pb-2 pr-3">Offset</th>
                  <th className="text-left pb-2">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border/40">
                {status.sources.map((src, i) => (
                  <tr key={i} className="hover:bg-nms-surface-2/50">
                    <td className="py-1.5 pr-3"><SourceStateLabel state={src.state} /></td>
                    <td className="py-1.5 pr-3 text-nms-text">{src.name}</td>
                    <td className="py-1.5 pr-3 text-nms-text-dim">{src.stratum}</td>
                    <td className="py-1.5 pr-3 text-nms-text-dim">{src.poll}</td>
                    <td className="py-1.5 pr-3 text-nms-text-dim">{src.reach}</td>
                    <td className="py-1.5 pr-3 text-nms-text-dim">{src.lastRx}</td>
                    <td className="py-1.5 pr-3 text-nms-text">{src.offset}</td>
                    <td className="py-1.5 text-nms-text-dim">{src.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Connected clients */}
      {active && (
        <div className="nms-card">
          {(() => {
            const ONE_HOUR = 3600;
            const recentClients = clients.filter(c => {
              const age = parseChronycAge(c.ntpLast);
              return age === null || age <= ONE_HOUR;
            });
            const staleCount = clients.length - recentClients.length;
            return (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <Users className="w-4 h-4 text-nms-accent" />
                  <h2 className="text-sm font-semibold text-nms-text">Connected NTP Clients</h2>
                  <span className="ml-auto text-xs text-nms-text-dim">
                    {recentClients.length} client{recentClients.length !== 1 ? 's' : ''}
                    {staleCount > 0 && <span className="ml-1 text-nms-text-dim/60">· {staleCount} stale hidden</span>}
                  </span>
                </div>
                {recentClients.length === 0 ? (
                  <p className="text-xs text-nms-text-dim py-2">
                    {clients.length === 0
                      ? 'No clients seen yet — chronyc reports clients after they have queried this server at least once.'
                      : `All ${clients.length} client${clients.length !== 1 ? 's' : ''} last seen over 1 hour ago.`}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-nms-text-dim border-b border-nms-border">
                          <th className="text-left pb-2 pr-4">Client</th>
                          <th className="text-right pb-2 pr-4">NTP Requests</th>
                          <th className="text-right pb-2 pr-4">Dropped</th>
                          <th className="text-right pb-2 pr-4">Poll Interval</th>
                          <th className="text-right pb-2">Last Seen</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-nms-border/40">
                        {recentClients.map((c, i) => (
                          <tr key={i} className="hover:bg-nms-surface-2/50">
                            <td className="py-1.5 pr-4 text-nms-text">{c.hostname}</td>
                            <td className="py-1.5 pr-4 text-right text-nms-text">{c.ntpRequests.toLocaleString()}</td>
                            <td className={`py-1.5 pr-4 text-right ${c.ntpDropped > 0 ? 'text-amber-400' : 'text-nms-text-dim'}`}>{c.ntpDropped}</td>
                            <td className="py-1.5 pr-4 text-right text-nms-text-dim">{c.ntpInterval === '-' ? '—' : `2^${c.ntpInterval}s`}</td>
                            <td className="py-1.5 text-right text-nms-text-dim">{c.ntpLast === '-' ? '—' : c.ntpLast}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Config editor */}
      {config && (
        <div className="space-y-4">
          {/* NTP Servers */}
          <div className="nms-card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-nms-text">NTP Servers &amp; Pools</h2>
              <div className="flex gap-2">
                <button onClick={addServer} className="nms-btn-ghost text-xs flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add Server
                </button>
                <button onClick={addPool} className="nms-btn-ghost text-xs flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add Pool
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {config.servers.length === 0 && (
                <p className="text-xs text-nms-text-dim py-2">No NTP sources configured. Add a server or pool above.</p>
              )}
              {config.servers.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={s.type}
                    onChange={e => updateServer(i, 'type', e.target.value as 'server' | 'pool')}
                    className="bg-nms-bg border border-nms-border rounded px-2 py-1.5 text-xs text-nms-text w-20 shrink-0"
                  >
                    <option value="server">server</option>
                    <option value="pool">pool</option>
                  </select>
                  <input
                    value={s.address}
                    onChange={e => updateServer(i, 'address', e.target.value)}
                    placeholder="time.nist.gov"
                    className="nms-input font-mono text-xs flex-1"
                  />
                  <input
                    value={s.options}
                    onChange={e => updateServer(i, 'options', e.target.value)}
                    placeholder="iburst"
                    className="nms-input font-mono text-xs w-32 shrink-0"
                  />
                  <button onClick={() => removeServer(i)}
                    className="text-red-400/60 hover:text-red-400 transition-colors p-1">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Allowed networks */}
          <div className="nms-card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-nms-text">Allowed Client Networks</h2>
                <p className="text-xs text-nms-text-dim mt-0.5">Subnets that are allowed to query this NTP server</p>
              </div>
              <button onClick={addNet} className="nms-btn-ghost text-xs flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add Network
              </button>
            </div>
            <div className="space-y-2">
              {config.allowNets.length === 0 && (
                <p className="text-xs text-nms-text-dim py-2">No client networks allowed. Add a CIDR block above.</p>
              )}
              {config.allowNets.map((net, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={net}
                    onChange={e => updateNet(i, e.target.value)}
                    placeholder="172.16.0.0/24"
                    className="nms-input font-mono text-xs flex-1"
                  />
                  <button onClick={() => removeNet(i)}
                    className="text-red-400/60 hover:text-red-400 transition-colors p-1">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Advanced */}
          <div className="nms-card">
            <button onClick={() => setShowAdvanced(v => !v)}
              className="w-full flex items-center justify-between text-sm font-semibold text-nms-text">
              <span>Advanced Options</span>
              <span className="text-xs text-nms-text-dim">{showAdvanced ? '▲ Hide' : '▼ Show'}</span>
            </button>
            {showAdvanced && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="nms-label">Local Stratum</label>
                  <input
                    type="number" min={1} max={15}
                    value={config.localStratum}
                    onChange={e => { markDirty(); setConfig(c => c ? { ...c, localStratum: parseInt(e.target.value) || 10 } : c); }}
                    className="nms-input font-mono text-xs"
                  />
                  <p className="text-xs text-nms-text-dim mt-1">Stratum reported when no upstream sources available (1–15)</p>
                </div>
                <div>
                  <label className="nms-label">Makestep</label>
                  <input
                    value={config.makestep}
                    onChange={e => { markDirty(); setConfig(c => c ? { ...c, makestep: e.target.value } : c); }}
                    placeholder="1.0 3"
                    className="nms-input font-mono text-xs"
                  />
                  <p className="text-xs text-nms-text-dim mt-1">Step correction threshold and limit (e.g. "1.0 3")</p>
                </div>
                <div>
                  <label className="nms-label">Drift File</label>
                  <input
                    value={config.driftfile}
                    onChange={e => { markDirty(); setConfig(c => c ? { ...c, driftfile: e.target.value } : c); }}
                    className="nms-input font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="nms-label">Log Directory</label>
                  <input
                    value={config.logdir}
                    onChange={e => { markDirty(); setConfig(c => c ? { ...c, logdir: e.target.value } : c); }}
                    className="nms-input font-mono text-xs"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config.rtcsync}
                      onChange={e => { markDirty(); setConfig(c => c ? { ...c, rtcsync: e.target.checked } : c); }}
                      className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent"
                    />
                    <span className="text-xs text-nms-text">RTC Sync</span>
                  </label>
                  <span className="text-xs text-nms-text-dim">Keep hardware clock synchronized</span>
                </div>
              </div>
            )}
          </div>


        </div>
      )}

      {/* Not installed + no config */}
      {!installed && !config && !installLog && (
        <div className="nms-card border-dashed border-nms-border text-center py-10">
          <Clock className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
          <p className="text-sm text-nms-text-dim">Chrony is not installed on this system.</p>
          <p className="text-xs text-nms-text-dim mt-1">Click <strong>Install Chrony</strong> above to install and start the NTP server.</p>
          <p className="text-xs font-mono text-nms-text-dim/60 mt-2">apt install chrony &amp;&amp; systemctl start chrony &amp;&amp; systemctl enable chrony</p>
        </div>
      )}
    </div>
  );
}
