import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Network, Play, Square, RotateCcw, Download, Plus, Trash2, Save,
  AlertTriangle, Info, RefreshCw, Server, Pin, Clock, Cable, Waypoints, X,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  dhcpApi, DHCP_DEFAULT_LEASE_LIFETIME,
  type DhcpConfig, type DhcpInterface, type DhcpLease, type DhcpStatus, type DhcpSubnet,
} from '../../api/dhcp';
import { useAuth } from '../../contexts/AuthContext';
import { ifaceServesOwnRange, subnetReach } from './subnet-reach';

type Tab = 'subnets' | 'bindings' | 'leases' | 'setup';

const EMPTY: DhcpConfig = { interfaces: [], subnets: [], defaultLeaseLifetime: DHCP_DEFAULT_LEASE_LIFETIME, reservationsOnly: false };

function nextSubnetId(subnets: DhcpSubnet[]): number {
  return subnets.reduce((m, s) => Math.max(m, s.id), 0) + 1;
}

/** Seconds -> the shortest readable form. Lease times are read, not computed. */
function humanDuration(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(s % 3600 === 0 ? 0 : 1)}h`;
  return `${(s / 86400).toFixed(s % 86400 === 0 ? 0 : 1)}d`;
}

/** Keeps a blocked interface's reason readable inside a <select> option. */
function shortReason(reason: string | undefined): string {
  const r = (reason ?? 'unavailable').trim();
  return r.length > 72 ? `${r.slice(0, 71)}…` : r;
}

const LEASE_STATE_STYLE: Record<DhcpLease['state'], string> = {
  active:   'bg-nms-green/10 text-nms-green border-nms-green/30',
  declined: 'bg-nms-red/10 text-nms-red border-nms-red/30',
  expired:  'bg-nms-surface text-nms-text-dim border-nms-border',
  released: 'bg-nms-surface text-nms-text-dim border-nms-border',
};

export function DhcpPage(): JSX.Element {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [tab, setTab] = useState<Tab>('subnets');
  const [status, setStatus] = useState<DhcpStatus | null>(null);
  const [interfaces, setInterfaces] = useState<DhcpInterface[]>([]);
  const [config, setConfig] = useState<DhcpConfig>(EMPTY);
  const [saved, setSaved] = useState<DhcpConfig>(EMPTY);
  const [leases, setLeases] = useState<DhcpLease[]>([]);
  const [leaseFileExists, setLeaseFileExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ifaceToAdd, setIfaceToAdd] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  const dirty = JSON.stringify(config) !== JSON.stringify(saved);

  // Which subnets have their reachability overrides revealed.
  //
  // The explicit choice wins once made, and the default is "open if one is
  // already set" — hiding a value that is live in Kea's own config would make
  // this page disagree with the file it edits, which is worse than the clutter
  // the disclosure exists to remove.
  const [reachOpen, setReachOpen] = useState<Record<number, boolean>>({});
  const reachOverridden = (s: DhcpSubnet) => !!s.iface || (s.relayIps?.length ?? 0) > 0;
  const reachVisible = (s: DhcpSubnet) => reachOpen[s.id] ?? reachOverridden(s);

  // What the operator types on the far-end router. The first bound interface
  // that actually holds an address: this is the address a relay points AT, so
  // guessing is worse than saying nothing.
  const helperTarget = (() => {
    for (const name of config.interfaces) {
      const ip = interfaces.find(i => i.name === name)?.cidr?.split('/')[0];
      if (ip) return ip;
    }
    return null;
  })();

  const refresh = useCallback(async () => {
    try {
      const [st, ifs, cf] = await Promise.all([dhcpApi.status(), dhcpApi.interfaces(), dhcpApi.getConfig()]);
      setStatus(st); setInterfaces(ifs);
      // Never clobber an unsaved edit with a poll result.
      setSaved(cf.config);
      setConfig(prev => (JSON.stringify(prev) === JSON.stringify(saved) ? cf.config : prev));
    } catch { /* surfaced by the status card staying empty */ }
    finally { setLoading(false); }
  }, [saved]);

  const refreshLeases = useCallback(async () => {
    try {
      const r = await dhcpApi.leases();
      setLeases(r.leases); setLeaseFileExists(r.leaseFileExists);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    if (tab !== 'leases') return;
    void refreshLeases();
    const t = setInterval(() => void refreshLeases(), 10_000);
    return () => clearInterval(t);
  }, [tab, refreshLeases]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [installLog]);

  const save = async () => {
    setSaving(true); setWarnings([]);
    try {
      const r = await dhcpApi.saveConfig(config);
      setSaved(r.config); setConfig(r.config); setWarnings(r.warnings ?? []);
      toast.success(r.reloaded ? 'Saved and reloaded' : 'Saved');
      await refresh();
    } catch (err: any) {
      const data = err?.response?.data;
      setWarnings(data?.warnings ?? []);
      toast.error(data?.error ?? 'Failed to save');
    } finally { setSaving(false); }
  };

  const doAction = async (action: 'start' | 'stop' | 'restart') => {
    try {
      await dhcpApi.action(action);
      toast.success(`DHCP ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`);
    } catch (err: any) {
      const d = err?.response?.data;
      toast.error(d?.error ?? `Failed to ${action}`);
      if (Array.isArray(d?.journal)) setInstallLog(d.journal.join('\n'));
    }
    await refresh();
  };

  const install = async () => {
    setInstalling(true); setInstallLog('');
    try {
      const resp = await fetch(dhcpApi.installUrl, { method: 'POST', credentials: 'include' });
      const reader = resp.body?.getReader();
      const dec = new TextDecoder();
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setInstallLog(p => p + dec.decode(value));
      }
      toast.success('Kea installed — configure a subnet, then Start');
      await refresh();
    } catch (err: any) { toast.error(`Install failed: ${err.message}`); }
    finally { setInstalling(false); }
  };

  // ── interface binding ──
  // A dropdown rather than a card grid: binding is a short, occasional pick
  // from a list the host decides, not a set of options worth a card each.
  const selectableIfaces = interfaces.filter(i => !i.blocked && !config.interfaces.includes(i.name));
  const unavailableIfaces = interfaces.filter(i => i.blocked && !config.interfaces.includes(i.name));
  const subnetCidrs = config.subnets.map(s => s.subnet).filter(Boolean);

  const bindIface = () => {
    if (!ifaceToAdd) return;
    setConfig(c => (c.interfaces.includes(ifaceToAdd) ? c : { ...c, interfaces: [...c.interfaces, ifaceToAdd] }));
    setIfaceToAdd('');
  };

  // ── subnet/reservation editing helpers ──
  const patchSubnet = (id: number, patch: Partial<DhcpSubnet>) =>
    setConfig(c => ({ ...c, subnets: c.subnets.map(s => (s.id === id ? { ...s, ...patch } : s)) }));

  const addSubnet = () => setConfig(c => ({
    ...c,
    subnets: [...c.subnets, {
      id: nextSubnetId(c.subnets), subnet: '', pools: [{ start: '', end: '' }],
      routers: [], dnsServers: [], leaseLifetime: c.defaultLeaseLifetime, reservations: [],
    }],
  }));

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading DHCP module…
      </div>
    );
  }

  const allReservations = config.subnets.flatMap(s => s.reservations.map(r => ({ ...r, subnetId: s.id, subnet: s.subnet })));

  return (
    <div className="p-4 space-y-4 md:p-6 md:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
            <Network className="w-6 h-6 text-nms-accent" /> DHCP Server
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Kea DHCPv4 — per-interface binding, address pools, static MAC bindings and live leases.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={clsx('text-xs font-semibold px-2 py-1 rounded border',
            status?.installed ? 'bg-nms-green/10 text-nms-green border-nms-green/30' : 'bg-nms-surface text-nms-text-dim border-nms-border')}>
            {status?.installed ? 'Installed' : 'Not installed'}
          </span>
          <span className={clsx('text-xs font-semibold px-2 py-1 rounded border',
            status?.running ? 'bg-nms-green/10 text-nms-green border-nms-green/30' : 'bg-nms-red/10 text-nms-red border-nms-red/30')}>
            {status?.running ? 'Running' : 'Stopped'}
          </span>
          {/* Gated on `installed`, never on `configured` — a running service whose
              controls vanish because config looks incomplete is a real bug this
              project has already had (see the VoWiFi note in CLAUDE.md). */}
          {isAdmin && status?.installed && (
            <>
              <button onClick={() => doAction('start')} disabled={status.running}
                className="nms-btn border border-nms-border-strong text-nms-text-dim hover:text-nms-green disabled:opacity-40 flex items-center gap-1.5 text-sm">
                <Play className="w-4 h-4" /> Start
              </button>
              <button onClick={() => doAction('stop')} disabled={!status.running}
                className="nms-btn border border-nms-border-strong text-nms-text-dim hover:text-nms-red disabled:opacity-40 flex items-center gap-1.5 text-sm">
                <Square className="w-4 h-4" /> Stop
              </button>
              <button onClick={() => doAction('restart')} disabled={!status.running}
                className="nms-btn border border-nms-border-strong text-nms-text-dim hover:text-nms-accent disabled:opacity-40 flex items-center gap-1.5 text-sm">
                <RotateCcw className="w-4 h-4" /> Restart
              </button>
            </>
          )}
        </div>
      </div>

      {status && status.conflictingListeners.length > 0 && (
        <div className="nms-card border-nms-red/40 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-nms-red shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-nms-red">Another process is already serving DHCP</p>
            <p className="text-nms-text-dim mt-1">
              {status.conflictingListeners.join(', ')} {status.conflictingListeners.length === 1 ? 'holds' : 'hold'} UDP/67.
              Kea will fail to bind until that stops — two DHCP servers on one segment hand out conflicting addresses.
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {([
            { id: 'subnets' as const,  label: 'Subnets',         Icon: Network },
            { id: 'bindings' as const, label: 'Static Bindings', Icon: Pin },
            { id: 'leases' as const,   label: 'Leases',          Icon: Clock },
            { id: 'setup' as const,    label: 'Setup',           Icon: Server },
          ]).map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id}
              className={clsx('flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                tab === id ? 'bg-nms-accent text-nms-accent-fg shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface')}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="nms-card border-nms-accent/30 flex items-start gap-3">
          <Info className="w-5 h-5 text-nms-accent shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-nms-text">Saved, with notes</p>
            <ul className="mt-1 space-y-1 text-nms-text-dim list-disc list-inside">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* ── Subnets ── */}
      {tab === 'subnets' && (
        <>
          {/* Binding is "where Kea listens", nothing more. Kept visually and
              textually separate from the subnet list because conflating the two
              is the mistake that makes a relay deployment look impossible. */}
          <div className="nms-card space-y-3">
            <div>
              <h2 className="text-base font-semibold font-display text-nms-text">Interface binding</h2>
              <p className="text-xs text-nms-text-dim mt-1">
                Where Kea listens for requests — and nothing else. It does not decide which subnets
                are served: a relayed request is accepted on any bound interface and Kea picks the
                subnet from the relay's own address, so the subnets below are configured
                independently of what is bound here.
              </p>
            </div>

            <div className="flex items-end gap-2 flex-wrap">
              <div className="flex-1 min-w-[16rem]">
                <label htmlFor="dhcp-iface-add" className="block text-xs text-nms-text-dim mb-1">
                  Interface
                </label>
                <select id="dhcp-iface-add" className="nms-input" value={ifaceToAdd} disabled={!isAdmin}
                  onChange={e => setIfaceToAdd(e.target.value)}>
                  <option value="">Select an interface…</option>
                  {selectableIfaces.length > 0 && (
                    <optgroup label="Available">
                      {selectableIfaces.map(i => (
                        <option key={i.name} value={i.name}>
                          {i.name} — {i.cidr ?? 'no IPv4'}{i.isDummy ? ' (dummy)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {/* Shown disabled rather than hidden, so an operator looking for
                      ogstun or docker0 reads why instead of assuming a bug. */}
                  {unavailableIfaces.length > 0 && (
                    <optgroup label="Unavailable">
                      {unavailableIfaces.map(i => (
                        <option key={i.name} value={i.name} disabled>
                          {i.name} — {shortReason(i.warnings[0])}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              {isAdmin && (
                <button onClick={bindIface} disabled={!ifaceToAdd}
                  className="nms-btn border border-nms-border-strong text-nms-text-dim hover:text-nms-accent disabled:opacity-40 flex items-center gap-1.5 text-sm">
                  <Plus className="w-4 h-4" /> Bind
                </button>
              )}
            </div>

            {config.interfaces.length === 0 ? (
              <p className="text-sm text-nms-text-dim">
                Nothing bound yet. Kea needs at least one interface to listen on, including when
                every subnet it serves is remote.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {config.interfaces.map(name => {
                  const i = interfaces.find(x => x.name === name);
                  // Only meaningful when a subnet really does lease out of this
                  // interface's own range — see localPoolWarnings.
                  const poolNotes = i && ifaceServesOwnRange(i, subnetCidrs) ? i.localPoolWarnings : [];
                  const notes = [...(i?.warnings ?? []), ...poolNotes];
                  return (
                    <li key={name} className="flex items-start gap-2 p-2 rounded-md border border-nms-border-strong bg-nms-surface-2/30">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-mono font-semibold text-nms-text">{name}</span>
                          <span className="text-xs font-mono text-nms-text-dim">{i ? (i.cidr ?? 'no IPv4') : 'not present on this host'}</span>
                          {i?.isDummy && <span className="text-[10px] px-1 py-0.5 rounded bg-nms-surface text-nms-text-dim border border-nms-border">dummy</span>}
                        </span>
                        {notes.map((w, k) => (
                          <span key={k} className="block text-xs text-nms-text-dim/80 mt-0.5">{w}</span>
                        ))}
                      </span>
                      {isAdmin && (
                        <button aria-label={`Stop listening on ${name}`} title={`Stop listening on ${name}`}
                          onClick={() => setConfig(c => ({ ...c, interfaces: c.interfaces.filter(n => n !== name) }))}
                          className="text-nms-text-dim hover:text-nms-red transition-colors shrink-0">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="nms-card">
            <h2 className="text-base font-semibold font-display text-nms-text">Subnets</h2>
            <p className="text-xs text-nms-text-dim mt-1">
              Any address range this server is responsible for, local or remote. A remote segment
              behind a DHCP relay is added here exactly like a local one — give it its own range,
              pool and gateway. Kea selects it from the relay's <span className="font-mono">giaddr</span>,
              so nothing has to match a bound interface.
            </p>
            <p className="text-xs text-nms-text-dim mt-2">
              Relaying itself is configured on the far-end router, not here:
              <span className="font-mono"> ip helper-address {helperTarget ?? '<this server>'}</span> on
              that segment's own gateway interface. Nothing on this page needs to know the relay's
              address — it puts its own in every request it forwards.
            </p>
          </div>

          {config.subnets.length === 0 && (
            <p className="text-sm text-nms-text-dim px-1">No subnets yet.</p>
          )}

          {config.subnets.map(s => {
            const reach = subnetReach(s.subnet, interfaces);
            const servedLocally = reach.ifaces.some(n => config.interfaces.includes(n));
            return (
            <div key={s.id} className="nms-card space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h3 className="text-sm font-semibold font-display text-nms-text flex items-center gap-2 flex-wrap">
                  <span>{s.subnet || `Subnet ${s.id}`}</span>
                  {reach.kind === 'direct' && (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-nms-surface text-nms-text-dim border border-nms-border"
                      title={`This range contains ${reach.ifaces.join(', ')}'s own address, so directly connected clients on that segment are answered from it`}>
                      <Cable className="w-2.5 h-2.5 shrink-0" />Directly connected · {reach.ifaces.join(', ')}
                    </span>
                  )}
                  {reach.kind === 'relayed' && (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-nms-accent/10 text-nms-accent border border-nms-accent/30"
                      title="No local interface holds an address in this range, so requests reach it through a DHCP relay. Kea selects the subnet from the relay's giaddr.">
                      <Waypoints className="w-2.5 h-2.5 shrink-0" />Via DHCP relay
                    </span>
                  )}
                </h3>
                {isAdmin && (
                  <button aria-label={`Remove subnet ${s.subnet || s.id}`}
                    onClick={() => setConfig(c => ({ ...c, subnets: c.subnets.filter(x => x.id !== s.id) }))}
                    className="text-nms-text-dim hover:text-nms-red transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {reach.kind === 'direct' && !servedLocally && (
                <p className="text-xs text-nms-text-dim">
                  {reach.ifaces.join(', ')} {reach.ifaces.length === 1 ? 'holds' : 'hold'} an address in
                  this range but {reach.ifaces.length === 1 ? 'is' : 'are'} not bound above, so clients on
                  that segment will only be answered if their requests arrive through a relay.
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label htmlFor={`cidr-${s.id}`} className="block text-xs text-nms-text-dim mb-1">Subnet (CIDR)</label>
                  <input id={`cidr-${s.id}`} className="nms-input font-mono" placeholder="192.168.50.0/24"
                    value={s.subnet} disabled={!isAdmin} onChange={e => patchSubnet(s.id, { subnet: e.target.value.trim() })} />
                </div>
                <div>
                  <label htmlFor={`pool-start-${s.id}`} className="block text-xs text-nms-text-dim mb-1">Pool start</label>
                  <input id={`pool-start-${s.id}`} className="nms-input font-mono" placeholder="192.168.50.100"
                    value={s.pools[0]?.start ?? ''} disabled={!isAdmin}
                    onChange={e => patchSubnet(s.id, { pools: [{ start: e.target.value.trim(), end: s.pools[0]?.end ?? '' }] })} />
                </div>
                <div>
                  <label htmlFor={`pool-end-${s.id}`} className="block text-xs text-nms-text-dim mb-1">Pool end</label>
                  <input id={`pool-end-${s.id}`} className="nms-input font-mono" placeholder="192.168.50.200"
                    value={s.pools[0]?.end ?? ''} disabled={!isAdmin}
                    onChange={e => patchSubnet(s.id, { pools: [{ start: s.pools[0]?.start ?? '', end: e.target.value.trim() }] })} />
                </div>
                <div>
                  <label htmlFor={`routers-${s.id}`} className="block text-xs text-nms-text-dim mb-1">Gateway</label>
                  <input id={`routers-${s.id}`} className="nms-input font-mono" placeholder="192.168.50.1"
                    value={s.routers.join(', ')} disabled={!isAdmin}
                    onChange={e => patchSubnet(s.id, { routers: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
                </div>
                <div>
                  <label htmlFor={`dns-${s.id}`} className="block text-xs text-nms-text-dim mb-1">DNS servers</label>
                  <input id={`dns-${s.id}`} className="nms-input font-mono" placeholder="10.0.1.180, 1.1.1.1"
                    value={s.dnsServers.join(', ')} disabled={!isAdmin}
                    onChange={e => patchSubnet(s.id, { dnsServers: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
                </div>
                <div>
                  <label htmlFor={`lease-${s.id}`} className="block text-xs text-nms-text-dim mb-1">
                    Lease lifetime (seconds) — {humanDuration(s.leaseLifetime)}
                  </label>
                  <input id={`lease-${s.id}`} type="number" min={60} className="nms-input font-mono"
                    value={s.leaseLifetime} disabled={!isAdmin}
                    onChange={e => patchSubnet(s.id, { leaseLifetime: Number(e.target.value) || DHCP_DEFAULT_LEASE_LIFETIME })} />
                </div>
                <div>
                  <label htmlFor={`domain-${s.id}`} className="block text-xs text-nms-text-dim mb-1">Domain name (optional)</label>
                  <input id={`domain-${s.id}`} className="nms-input" placeholder="lab.local"
                    value={s.domainName ?? ''} disabled={!isAdmin}
                    onChange={e => patchSubnet(s.id, { domainName: e.target.value.trim() || undefined })} />
                </div>
              </div>

              {/* Deliberately NOT in the grid above. Both of these are overrides
                  for cases Kea's own manual calls uncommon, and an inline field
                  reads as a step in the normal flow however its help text is
                  worded — which is how "Relay addresses" got read as "tell the
                  server where your relay is", the reverse of how relaying works. */}
              <div className="border-t border-nms-border pt-3">
                <button type="button" aria-expanded={reachVisible(s)}
                  onClick={() => setReachOpen(prev => ({ ...prev, [s.id]: !reachVisible(s) }))}
                  className="flex items-center gap-1.5 text-xs text-nms-text-dim hover:text-nms-accent transition-colors">
                  {reachVisible(s)
                    ? <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    : <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                  Reachability overrides
                  {reachOverridden(s) && (
                    <span className="inline-flex items-center whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-nms-accent/10 text-nms-accent border border-nms-accent/30">
                      in use
                    </span>
                  )}
                </button>

                {reachVisible(s) && (
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-nms-text-dim">
                      An ordinary relayed subnet needs neither of these. Leave both empty unless
                      something below describes your network.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor={`relay-${s.id}`} className="block text-xs text-nms-text-dim mb-1">
                          Match extra relay addresses
                        </label>
                        <input id={`relay-${s.id}`} className="nms-input font-mono" placeholder="(empty)"
                          value={(s.relayIps ?? []).join(', ')} disabled={!isAdmin}
                          onChange={e => patchSubnet(s.id, { relayIps: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} />
                        <p className="text-xs text-nms-text-dim/80 mt-1">
                          Extra <span className="font-mono">giaddr</span> values Kea should map to this
                          subnet. A relay sets <span className="font-mono">giaddr</span> to its own
                          address on the client's segment, so a relay that is this subnet's gateway is
                          already matched. Only needed when it is not — a relay sourcing from a
                          loopback or transit address, or a shared network.
                        </p>
                      </div>
                      <div>
                        <label htmlFor={`iface-pin-${s.id}`} className="block text-xs text-nms-text-dim mb-1">
                          Pin to interface
                        </label>
                        <select id={`iface-pin-${s.id}`} className="nms-input" value={s.iface ?? ''} disabled={!isAdmin}
                          onChange={e => patchSubnet(s.id, { iface: e.target.value || undefined })}>
                          <option value="">Not pinned — any bound interface</option>
                          {interfaces.filter(i => !i.blocked).map(i => <option key={i.name} value={i.name}>{i.name}</option>)}
                        </select>
                        <p className="text-xs text-nms-text-dim/80 mt-1">
                          Restricts this subnet to directly connected clients on one interface. A
                          relayed subnet has no local interface to pin to, so leave it unset.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            );
          })}

          {isAdmin && (
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={addSubnet} className="nms-btn border border-nms-border-strong text-nms-text-dim hover:text-nms-accent flex items-center gap-1.5 text-sm">
                <Plus className="w-4 h-4" /> Add subnet
              </button>
              <button onClick={save} disabled={saving || !dirty}
                className="nms-btn-primary flex items-center gap-1.5 text-sm disabled:opacity-40">
                <Save className="w-4 h-4" /> {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Static bindings ── */}
      {tab === 'bindings' && (
        <div className="nms-card space-y-3">
          <div>
            <h2 className="text-base font-semibold font-display text-nms-text">Static bindings</h2>
            <p className="text-xs text-nms-text-dim mt-1">
              A MAC always receives the same address. Keep reserved addresses outside the dynamic pool,
              or the same address can be leased to another client before its owner asks for it.
            </p>
          </div>
          {config.subnets.length === 0 ? (
            <p className="text-sm text-nms-text-dim py-6 text-center">Add a subnet first — a binding has to live inside one.</p>
          ) : (
            <div className="nms-table-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-nms-text-dim uppercase tracking-wider border-b border-nms-border">
                    <th className="text-left py-2 px-2 font-semibold">MAC address</th>
                    <th className="text-left py-2 px-2 font-semibold">IP address</th>
                    <th className="text-left py-2 px-2 font-semibold">Hostname</th>
                    <th className="text-left py-2 px-2 font-semibold">Subnet</th>
                    <th className="py-2 px-2" />
                  </tr>
                </thead>
                <tbody>
                  {allReservations.length === 0 && (
                    <tr><td colSpan={5} className="py-6 text-center text-nms-text-dim">No static bindings yet.</td></tr>
                  )}
                  {allReservations.map((r, i) => (
                    <tr key={`${r.subnetId}-${r.mac}-${i}`} className="border-b border-nms-border/50">
                      <td className="py-1.5 px-2 font-mono">{r.mac}</td>
                      <td className="py-1.5 px-2 font-mono">{r.ip}</td>
                      <td className="py-1.5 px-2">{r.hostname || <span className="text-nms-text-dim">—</span>}</td>
                      <td className="py-1.5 px-2 font-mono text-nms-text-dim">{r.subnet}</td>
                      <td className="py-1.5 px-2 text-right">
                        {isAdmin && (
                          <button aria-label={`Remove binding for ${r.mac}`}
                            onClick={() => patchSubnet(r.subnetId, {
                              reservations: config.subnets.find(s => s.id === r.subnetId)!.reservations.filter(x => x.mac !== r.mac),
                            })}
                            className="text-nms-text-dim hover:text-nms-red transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {isAdmin && config.subnets.length > 0 && (
            <AddBindingForm subnets={config.subnets} onAdd={(subnetId, res) => {
              const s = config.subnets.find(x => x.id === subnetId)!;
              patchSubnet(subnetId, { reservations: [...s.reservations, res] });
            }} />
          )}
          {isAdmin && (
            <button onClick={save} disabled={saving || !dirty}
              className="nms-btn-primary flex items-center gap-1.5 text-sm disabled:opacity-40">
              <Save className="w-4 h-4" /> {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          )}
        </div>
      )}

      {/* ── Leases ── */}
      {tab === 'leases' && (
        <div className="nms-card space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h2 className="text-base font-semibold font-display text-nms-text">Leases</h2>
              <p className="text-xs text-nms-text-dim mt-1">
                Read from Kea's own lease file, so it still works while the server is stopped. Refreshes every 10s.
              </p>
            </div>
            <button onClick={() => void refreshLeases()} aria-label="Refresh leases"
              className="nms-btn border border-nms-border-strong text-nms-text-dim hover:text-nms-accent flex items-center gap-1.5 text-sm">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>
          {!leaseFileExists ? (
            <p className="text-sm text-nms-text-dim py-6 text-center">No lease file yet — Kea has not served a request.</p>
          ) : leases.length === 0 ? (
            <p className="text-sm text-nms-text-dim py-6 text-center">No leases recorded.</p>
          ) : (
            <div className="nms-table-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-nms-text-dim uppercase tracking-wider border-b border-nms-border">
                    <th className="text-left py-2 px-2 font-semibold">IP address</th>
                    <th className="text-left py-2 px-2 font-semibold">MAC</th>
                    <th className="text-left py-2 px-2 font-semibold">Hostname</th>
                    <th className="text-left py-2 px-2 font-semibold">State</th>
                    <th className="text-left py-2 px-2 font-semibold">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {leases.map(l => (
                    <tr key={l.ip} className="border-b border-nms-border/50">
                      <td className="py-1.5 px-2 font-mono">
                        <span className="flex items-center gap-1.5">
                          {l.ip}
                          {l.reserved && (
                            <span title="Pinned by a static binding" aria-label="Pinned by a static binding">
                              <Pin className="w-3 h-3 text-nms-accent" aria-hidden="true" />
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 font-mono text-nms-text-dim">{l.mac || '—'}</td>
                      <td className="py-1.5 px-2">{l.hostname || <span className="text-nms-text-dim">—</span>}</td>
                      <td className="py-1.5 px-2">
                        <span className={clsx('text-xs font-semibold px-1.5 py-0.5 rounded border', LEASE_STATE_STYLE[l.state])}>
                          {l.state}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-nms-text-dim">
                        {l.state === 'active' ? `in ${humanDuration(l.expiresInSeconds)}`
                          : l.state === 'expired' ? `${humanDuration(l.expiresInSeconds)} ago` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Setup ── */}
      {tab === 'setup' && (
        <div className="nms-card space-y-3">
          <div>
            <h2 className="text-base font-semibold font-display text-nms-text">Install</h2>
            <p className="text-xs text-nms-text-dim mt-1">
              Installs <span className="font-mono">kea-dhcp4-server</span> and leaves it stopped, so it cannot
              answer on a live segment before you have configured a subnet.
              {status?.version && <> Installed: <span className="font-mono">{status.version}</span></>}
            </p>
          </div>
          {isAdmin && (
            <button onClick={install} disabled={installing}
              className="nms-btn-primary flex items-center gap-1.5 text-sm disabled:opacity-40">
              <Download className="w-4 h-4" /> {installing ? 'Installing…' : status?.installed ? 'Reinstall' : 'Install Kea'}
            </button>
          )}
          {installLog && (
            <pre ref={logRef} className="text-xs font-mono bg-nms-surface-2 border border-nms-border rounded-md p-3 max-h-80 overflow-auto whitespace-pre-wrap">
              {installLog}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function AddBindingForm({ subnets, onAdd }: {
  subnets: DhcpSubnet[];
  onAdd: (subnetId: number, res: { mac: string; ip: string; hostname?: string }) => void;
}): JSX.Element {
  const [mac, setMac] = useState('');
  const [ip, setIp] = useState('');
  const [hostname, setHostname] = useState('');
  const [subnetId, setSubnetId] = useState(subnets[0]?.id ?? 0);

  const submit = () => {
    if (!mac.trim() || !ip.trim()) { toast.error('MAC and IP are both required'); return; }
    onAdd(subnetId, { mac: mac.trim(), ip: ip.trim(), hostname: hostname.trim() || undefined });
    setMac(''); setIp(''); setHostname('');
  };

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5 items-end pt-2 border-t border-nms-border">
      <div>
        <label htmlFor="new-binding-mac" className="block text-xs text-nms-text-dim mb-1">MAC address</label>
        <input id="new-binding-mac" className="nms-input font-mono" placeholder="aa:bb:cc:dd:ee:ff"
          value={mac} onChange={e => setMac(e.target.value)} />
      </div>
      <div>
        <label htmlFor="new-binding-ip" className="block text-xs text-nms-text-dim mb-1">IP address</label>
        <input id="new-binding-ip" className="nms-input font-mono" placeholder="192.168.50.10"
          value={ip} onChange={e => setIp(e.target.value)} />
      </div>
      <div>
        <label htmlFor="new-binding-host" className="block text-xs text-nms-text-dim mb-1">Hostname (optional)</label>
        <input id="new-binding-host" className="nms-input" placeholder="printer"
          value={hostname} onChange={e => setHostname(e.target.value)} />
      </div>
      <div>
        <label htmlFor="new-binding-subnet" className="block text-xs text-nms-text-dim mb-1">Subnet</label>
        <select id="new-binding-subnet" className="nms-input" value={subnetId} onChange={e => setSubnetId(Number(e.target.value))}>
          {subnets.map(s => <option key={s.id} value={s.id}>{s.subnet || `Subnet ${s.id}`}</option>)}
        </select>
      </div>
      <button onClick={submit} className="nms-btn border border-nms-border-strong text-nms-text-dim hover:text-nms-accent flex items-center gap-1.5 text-sm">
        <Plus className="w-4 h-4" /> Add binding
      </button>
    </div>
  );
}
