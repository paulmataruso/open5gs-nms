import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import {
  Play, Square, RotateCw, Settings, FileText, CheckCircle, XCircle, ShieldAlert, ExternalLink, DollarSign, UserPlus, Users, AlertTriangle,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { ocsApi, type OcsStatus, type OcsConfigFile } from '../api/ocs';

function SvcBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border ${
      active ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30'
    }`}>
      {active ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label}
    </div>
  );
}

function SetupTab({ status, refresh }: { status: OcsStatus | null; refresh: () => void }) {
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [bindIp, setBindIp] = useState('127.0.1.10');
  const [httpPort, setHttpPort] = useState(8093);
  const [originHost, setOriginHost] = useState('');
  const [originRealm, setOriginRealm] = useState('');
  const [ocsUsername, setOcsUsername] = useState('');
  const [ocsPassword, setOcsPassword] = useState('');
  const [savingUser, setSavingUser] = useState(false);
  const [defaultOfferId, setDefaultOfferId] = useState('');
  const [syncing, setSyncing] = useState(false);

  // Seed once from server state, same reasoning as every other module's own
  // SetupTab (HnbPage.tsx, GsmPage.tsx) — re-seeding on every 5s poll would
  // wipe in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (!status?.currentConfig || seeded.current) return;
    seeded.current = true;
    setBindIp(status.currentConfig.bindIp || '127.0.1.10');
    setHttpPort(status.currentConfig.httpPort || 8093);
    setOriginHost(status.currentConfig.originHost || '');
    setOriginRealm(status.currentConfig.originRealm || '');
    setDefaultOfferId(status.currentConfig.defaultOfferId || '');
  }, [status]);

  // One button does install + configure, same convention as every other
  // module's Setup tab in this project (never split — a split Install/
  // Configure left an obvious gap in an earlier module where it could look
  // "configured" without ever having actually been installed).
  const handleInstallAndConfigure = async () => {
    setInstalling(true);
    setInstallLog('');
    try {
      const res = await ocsApi.install();
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setInstallLog(prev => prev + decoder.decode(value));
        }
      }
    } catch {
      toast.error('Install failed');
      setInstalling(false);
      return;
    }
    setInstalling(false);
    setConfiguring(true);
    try {
      const result = await ocsApi.configure({
        bindIp, httpPort,
        originHost: originHost || undefined,
        originRealm: originRealm || undefined,
        defaultOfferId: defaultOfferId || undefined,
      });
      if (result.subscriberSyncWarning) {
        // Not just a toast — this is exactly the failure mode that caused a
        // real production outage (Gy live, zero subscribers provisioned,
        // every attach rejected as USER_UNKNOWN). A toast that fades in a
        // few seconds isn't enough; the persistent banner below (driven by
        // status.currentConfig.lastSyncedAt) is what actually keeps this
        // visible until fixed.
        toast.error(result.subscriberSyncWarning, { duration: 10000 });
      } else if (result.subscriberSync) {
        toast.success(
          `Installed and configured — Gy peer ${result.gyPeerOpen ? 'is up and open' : 'wired, still establishing'}. ` +
          `Subscribers synced: ${result.subscriberSync.synced} ok` +
          (result.subscriberSync.failed ? `, ${result.subscriberSync.failed} failed` : '') +
          (result.subscriberSync.removed ? `, ${result.subscriberSync.removed} stale removed` : '') + '.',
        );
      } else {
        toast.success(result.gyPeerOpen
          ? 'Installed and configured — the Gy peer to SMF is up and open.'
          : 'Installed and configured — Gy peer wired, still establishing (check back in a moment).');
      }
      refresh();
    } catch (err: any) {
      toast.error(`Configure failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setConfiguring(false);
    }
  };

  const handleSyncSubscribers = async () => {
    setSyncing(true);
    try {
      const result = await ocsApi.syncSubscribers();
      if (!result.success) {
        toast.error(result.error || 'Sync failed');
        return;
      }
      toast.success(
        `Synced: ${result.synced} ok` +
        (result.failed ? `, ${result.failed} failed` : '') +
        (result.removed ? `, ${result.removed} stale removed` : '') + '.',
      );
      refresh();
    } catch (err: any) {
      toast.error(`Sync failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  // Same "set credentials" button handles both the first-ever account and
  // a later password change — the backend tries add_user then transparently
  // falls back to update_user, so there's nothing for the operator to pick
  // between. Password field clears on success (username stays, so a repeat
  // password change is just "type new password, submit" again); username
  // never had a default to guess correctly, so it isn't cleared.
  const handleSetOcsUser = async () => {
    if (!ocsUsername || !ocsPassword) {
      toast.error('Username and password are both required');
      return;
    }
    setSavingUser(true);
    try {
      const result = await ocsApi.setUser(ocsUsername, ocsPassword);
      if (!result.success) {
        toast.error(result.error || 'Failed to set OCS user');
        return;
      }
      toast.success(result.created ? `Created OCS user "${ocsUsername}"` : `Updated password for "${ocsUsername}"`);
      setOcsPassword('');
    } catch (err: any) {
      toast.error(`Failed to set OCS user: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSavingUser(false);
    }
  };

  if (!status) {
    return <div className="nms-card text-sm text-nms-text-dim">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      {!status.installed && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
          Not installed yet — this installs SigScale OCS's own real apt package, then wires a
          Diameter Gy peer into Open5GS's SMF for real-time 4G/EPC charging. 5G sessions are not
          covered — Open5GS's SMF has no 5G online-charging (Nchf) client upstream.
        </div>
      )}

      {/* Real 2026-09-16 production incident: the moment Gy goes live, SMF
          hard-rejects every 4G attach on every radio as USER_UNKNOWN unless
          subscribers are provisioned in OCS. This banner is deliberately not
          just a toast — it stays up for as long as the condition is true. */}
      {status.gyPeerWired && !status.currentConfig.lastSyncedAt && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            <strong>Gy peer is wired but subscribers have never been synced to OCS.</strong> Every
            4G attach on every radio will be rejected as USER_UNKNOWN until you set a Product
            Offering ID below and click Sync Subscribers.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="nms-card flex items-center gap-2.5">
          {status.mnesiaInitialized ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0" /> : <XCircle className="w-4 h-4 text-nms-text-dim shrink-0" />}
          <div>
            <p className="text-xs font-semibold text-nms-text">Mnesia DB</p>
            <p className="text-xs text-nms-text-dim">{status.mnesiaInitialized ? 'Initialized' : 'Not initialized'}</p>
          </div>
        </div>
        <div className="nms-card flex items-center gap-2.5">
          {status.gyPeerWired ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0" /> : <XCircle className="w-4 h-4 text-nms-text-dim shrink-0" />}
          <div>
            <p className="text-xs font-semibold text-nms-text">Gy peer in smf.conf</p>
            <p className="text-xs text-nms-text-dim">{status.gyPeerWired ? 'Wired' : 'Not wired'}</p>
          </div>
        </div>
        <div className="nms-card flex items-center gap-2.5">
          {status.gyPeerOpen ? <CheckCircle className="w-4 h-4 text-green-400 shrink-0" /> : <XCircle className="w-4 h-4 text-nms-text-dim shrink-0" />}
          <div>
            <p className="text-xs font-semibold text-nms-text">Gy connection</p>
            <p className="text-xs text-nms-text-dim">{status.gyPeerOpen ? 'STATE_OPEN' : 'Not established'}</p>
          </div>
        </div>
      </div>

      {/* Subscriber provisioning — deliberately its own always-visible card,
          not tucked into the collapsed "advanced settings" below. Forgetting
          this field is exactly what caused a real outage: it looks like
          everything is fine (gyPeerOpen:true) right up until a real UE tries
          to attach. */}
      <div className="nms-card space-y-3">
        <p className="text-sm font-semibold text-nms-text flex items-center gap-2">
          <Users className="w-4 h-4 text-nms-accent" /> Subscriber provisioning
        </p>
        <p className="text-xs text-nms-text-dim">
          OCS has no implicit subscriber authorization — every Open5GS subscriber needs a matching
          `service`+`product` record in OCS or its Gy charging request is rejected as USER_UNKNOWN,
          which fails the entire attach. Create a Product Offering in OCS's own web GUI first (Setup
          tab's login below gets you in), paste its Offer ID here, then Sync — this also runs
          automatically on every Install &amp; Configure once an Offer ID is set.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-xs text-nms-text-dim block mb-1">Default Product Offering ID</label>
            <input aria-label="Default Product Offering ID"
              value={defaultOfferId}
              onChange={e => setDefaultOfferId(e.target.value)}
              placeholder="e.g. prepaid-data-4g"
              className="nms-input font-mono text-sm w-56"
            />
          </div>
          <button
            onClick={handleSyncSubscribers}
            disabled={syncing || !status.installed || !status.currentConfig.defaultOfferId}
            title={!status.currentConfig.defaultOfferId ? 'Save a Product Offering ID via Install & Configure first' : undefined}
            className="nms-btn-primary text-xs px-3 py-2 flex items-center gap-1.5"
          >
            <Users className="w-3.5 h-3.5" /> {syncing ? 'Syncing…' : 'Sync Subscribers'}
          </button>
        </div>
        {status.currentConfig.lastSyncedAt && status.currentConfig.lastSyncCounts && (
          <p className="text-xs text-nms-text-dim">
            Last synced {new Date(status.currentConfig.lastSyncedAt).toLocaleString()} —{' '}
            <span className="text-green-400">{status.currentConfig.lastSyncCounts.synced} ok</span>
            {status.currentConfig.lastSyncCounts.failed > 0 && <span className="text-red-400 ml-2">{status.currentConfig.lastSyncCounts.failed} failed</span>}
            {status.currentConfig.lastSyncCounts.removed > 0 && <span className="ml-2">{status.currentConfig.lastSyncCounts.removed} stale removed</span>}
          </p>
        )}
      </div>

      <div className="nms-card space-y-4">
        <button onClick={() => setAdvancedOpen(v => !v)} className="text-xs text-nms-text-dim hover:text-nms-text flex items-center gap-1.5">
          <Settings className="w-3.5 h-3.5" /> {advancedOpen ? 'Hide' : 'Show'} advanced settings (defaults work for a standard deployment)
        </button>
        {advancedOpen && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">Diameter/HTTP bind IP</label>
              <input aria-label="Diameter/HTTP bind IP" value={bindIp} onChange={e => setBindIp(e.target.value)} className="nms-input w-full font-mono" />
              <p className="text-xs text-nms-text-dim mt-1">Own dedicated loopback alias — OCS's own default (0.0.0.0) silently fails to bind against the other NFs' own freeDiameter listeners already sharing port 3868/3869.</p>
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">HTTP (REST + web GUI) port</label>
              <input aria-label="HTTP (REST + web GUI) port" type="number" value={httpPort} onChange={e => setHttpPort(Number(e.target.value))} className="nms-input w-full" />
              <p className="text-xs text-nms-text-dim mt-1">OCS's own default (8080) collides with PyHSS's API when IMS is installed.</p>
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">Diameter Origin-Host</label>
              <input aria-label="Diameter Origin-Host" value={originHost} onChange={e => setOriginHost(e.target.value)} placeholder="ocs.epc.mnc001.mcc001.3gppnetwork.org" className="nms-input w-full font-mono" />
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">Diameter Origin-Realm</label>
              <input aria-label="Diameter Origin-Realm" value={originRealm} onChange={e => setOriginRealm(e.target.value)} placeholder="epc.mnc001.mcc001.3gppnetwork.org" className="nms-input w-full font-mono" />
              <p className="text-xs text-nms-text-dim mt-1">Must match what smf.conf's ConnectPeer expects, or the CEA handshake is rejected.</p>
            </div>
          </div>
        )}

        <button onClick={handleInstallAndConfigure} disabled={installing || configuring} className="nms-btn-primary w-full">
          {installing ? 'Installing (real apt package)…' : configuring ? 'Configuring…' : status.installed ? 'Re-Configure' : 'Install & Configure'}
        </button>

        {installLog && (
          <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border">
            {installLog}
          </pre>
        )}
      </div>

      {status.installed && status.serviceActive && (
        <div className="nms-card">
          <p className="text-sm font-semibold text-nms-text mb-1 flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-nms-accent" /> Subscriber / product / balance management
          </p>
          <p className="text-xs text-nms-text-dim mb-3">
            This page only manages OCS's own lifecycle (install, Gy peering, config files). Rating
            plans, product offers, subscriber balances, and CDRs are managed in OCS's own real web
            app and REST APIs — this project doesn't reimplement them.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={`http://${window.location.hostname}:${status.currentConfig.httpPort}/`}
              target="_blank" rel="noreferrer"
              className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5"
            >
              <ExternalLink className="w-3 h-3" /> Open OCS Web GUI
            </a>
            <a
              href={`http://${window.location.hostname}:${status.currentConfig.httpPort}/doc/`}
              target="_blank" rel="noreferrer"
              className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5"
            >
              <ExternalLink className="w-3 h-3" /> OCS REST/Erlang Docs
            </a>
          </div>
          <div className="mt-3 pt-3 border-t border-nms-border">
            <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5" /> OCS web GUI / REST API login
            </p>
            <p className="text-xs text-nms-text-dim mb-2">
              OCS ships with no default login. Set one here — the same form creates it the first
              time and changes the password any time after.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="text-xs text-nms-text-dim block mb-1">Username</label>
                <input aria-label="Username"
                  value={ocsUsername}
                  onChange={e => setOcsUsername(e.target.value)}
                  placeholder="admin"
                  className="nms-input font-mono text-sm w-40"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="text-xs text-nms-text-dim block mb-1">Password</label>
                <input aria-label="Password"
                  type="password"
                  value={ocsPassword}
                  onChange={e => setOcsPassword(e.target.value)}
                  placeholder="min 4 characters"
                  className="nms-input font-mono text-sm w-48"
                  autoComplete="new-password"
                />
              </div>
              <button onClick={handleSetOcsUser} disabled={savingUser} className="nms-btn-primary text-xs px-3 py-2">
                {savingUser ? 'Saving…' : 'Create / Update User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigFilesTab() {
  const [files, setFiles] = useState<OcsConfigFile[]>([]);
  const [selected, setSelected] = useState<OcsConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    ocsApi.getConfigs().then(r => setFiles(r.files || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const openFile = async (f: OcsConfigFile) => {
    setSelected(f);
    const r = await ocsApi.getConfigContent(f.path);
    setContent(r.content || '');
  };

  const handleSave = async () => {
    if (!selected) return;
    if (selected.shared && !window.confirm(
      `${selected.label} is shared with ${selected.sharedWith}\n\nSave and restart ${selected.restartServices.join(', ')} anyway?`,
    )) return;
    setSaving(true);
    try {
      await ocsApi.saveConfigContent(selected.path, content);
      await ocsApi.restartServices(selected.restartServices);
      toast.success(`Saved — restarted ${selected.restartServices.join(', ')}`);
      load();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const groups = [...new Set(files.map(f => f.group))];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="nms-card lg:col-span-1">
        {groups.map(g => (
          <div key={g} className="mb-3">
            <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              {g}
              {g.startsWith('Shared') && <ShieldAlert className="w-3 h-3 text-amber-400" />}
            </h3>
            {files.filter(f => f.group === g).map(f => (
              <button
                key={f.path}
                onClick={() => openFile(f)}
                className={clsx(
                  'w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono mb-1 flex items-center justify-between',
                  selected?.path === f.path ? 'bg-nms-accent/15 text-nms-accent' : 'text-nms-text-dim hover:bg-nms-bg',
                )}
              >
                {f.label}
                {!f.exists && <span className="text-red-400 text-[10px]">missing</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="nms-card lg:col-span-2">
        {selected ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-mono text-nms-text">{selected.path}</span>
              <button className="nms-btn-primary" disabled={saving} onClick={handleSave}>
                {saving ? <RotateCw className="w-4 h-4 animate-spin" /> : null} Save &amp; Restart
              </button>
            </div>
            {selected.shared && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 text-xs text-amber-300 mb-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span><strong>Shared file — not owned by this module.</strong> {selected.sharedWith}</span>
              </div>
            )}
            <div className="border border-nms-border rounded-lg overflow-hidden">
              <Editor
                height="500px"
                language={selected.language}
                theme="vs-dark"
                value={content}
                onChange={v => setContent(v ?? '')}
                options={{ minimap: { enabled: false }, fontSize: 13 }}
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-nms-text-dim py-10 text-center">Select a config file to view/edit.</p>
        )}
      </div>
    </div>
  );
}

export function OcsPage() {
  const [status, setStatus] = useState<OcsStatus | null>(null);
  const [tab, setTab] = useState<'setup' | 'configs'>('setup');
  const [svcBusy, setSvcBusy] = useState(false);

  const refresh = useCallback(() => {
    ocsApi.getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setSvcBusy(true);
    try {
      await { start: ocsApi.start, stop: ocsApi.stop, restart: ocsApi.restart }[action]();
      toast.success(`SigScale OCS ${action}ed`);
      refresh();
    } catch (err: any) {
      toast.error(`${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSvcBusy(false);
    }
  };

  const TABS: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'setup',   label: 'Setup',        icon: <Settings className="w-4 h-4" /> },
    { id: 'configs', label: 'Config Files', icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="p-4 space-y-4 md:p-6 md:space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold font-display text-nms-text">SigScale OCS</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">alpha</span>
          </div>
          <p className="text-sm text-nms-text-dim mt-1">
            Online Charging System — real-time 4G/EPC credit-control charging over Diameter Gy.
          </p>
        </div>

        {status?.installed && (
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <SvcBadge label="ocs" active={status.serviceActive} />
            <SvcBadge label="Gy peer" active={status.gyPeerOpen} />
            <div className="h-5 w-px bg-nms-border" />
            <button onClick={() => handleServiceAction('start')} disabled={svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Play className="w-3 h-3" /> Start
            </button>
            <button onClick={() => handleServiceAction('stop')} disabled={svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Square className="w-3 h-3" /> Stop
            </button>
            <button onClick={() => handleServiceAction('restart')} disabled={svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <RotateCw className="w-3 h-3" /> Restart
            </button>
          </div>
        )}
      </div>

      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {TABS.map(tabDef => (
            <button
              key={tabDef.id}
              onClick={() => setTab(tabDef.id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                tab === tabDef.id ? 'bg-nms-accent text-nms-accent-fg shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
              )}
            >
              {tabDef.icon}
              {tabDef.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'setup' && <SetupTab status={status} refresh={refresh} />}
      {tab === 'configs' && <ConfigFilesTab />}
    </div>
  );
}
