import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import {
  Play, Square, RotateCw, Settings, FileText, CheckCircle, XCircle, Plus, Trash2, ShieldAlert, Wifi, Smartphone,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { hnbgwApi, parseHnbList, type HnbgwStatus } from '../api/hnbgw';
import { SubscriberAuthTab } from './SubscriberAuthTab';

// Mirrors gsm-controller.ts's own GsmConfigFile shape directly — defined
// locally since only this page's Config Files tab needs it, and the API
// client doesn't otherwise need to know this shape.
interface HnbgwConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
  shared?: boolean;
  sharedWith?: string;
}

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

function SetupTab({ status, refresh }: { status: HnbgwStatus | null; refresh: () => void }) {
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [rncId, setRncId] = useState(1);
  const [iuhLocalIp, setIuhLocalIp] = useState('0.0.0.0');
  const [iuhLocalPort, setIuhLocalPort] = useState(29169);
  const [hnbgwPointCode, setHnbgwPointCode] = useState('0.23.5');
  const [mscPointCode, setMscPointCode] = useState('0.23.1');
  const [sgsnIuPsPointCode, setSgsnIuPsPointCode] = useState('0.23.4');
  const [mgwBindIp, setMgwBindIp] = useState('127.0.1.8');
  const [mgwRtpBindIp, setMgwRtpBindIp] = useState('127.0.1.8');

  // Seed once from server state, same reasoning as GsmPage.tsx's own
  // SetupTab: re-seeding on every 5s poll would wipe in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (!status || seeded.current) return;
    seeded.current = true;
    setRncId(status.rncId ?? 1);
    setIuhLocalIp(status.iuhLocalIp || '0.0.0.0');
    setIuhLocalPort(status.iuhLocalPort ?? 29169);
    setHnbgwPointCode(status.hnbgwPointCode || '0.23.5');
    setMscPointCode(status.mscPointCode || '0.23.1');
    setSgsnIuPsPointCode(status.sgsnIuPsPointCode || '0.23.4');
    setMgwBindIp(status.mgwBindIp || '127.0.1.8');
    setMgwRtpBindIp(status.mgwRtpBindIp || '127.0.1.8');
  }, [status]);

  // One button does install + configure, same convention as every other
  // module's Setup tab in this project — never split (explicit past
  // feedback: a split Install/Configure left an obvious gap where a module
  // could look "configured" without ever having actually been installed).
  const handleInstallAndConfigure = async () => {
    setInstalling(true);
    setInstallLog('');
    try {
      const res = await hnbgwApi.install();
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
      await hnbgwApi.configure({
        rncId, iuhLocalIp, iuhLocalPort, hnbgwPointCode, mscPointCode, sgsnIuPsPointCode, mgwBindIp, mgwRtpBindIp,
      });
      toast.success('Installed and configured — osmo-hnbgw and its dedicated osmo-mgw instance are live.');
      refresh();
    } catch (err: any) {
      toast.error(`Configure failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setConfiguring(false);
    }
  };

  if (!status) {
    return <div className="nms-card text-sm text-nms-text-dim">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      {!status.installedOnDisk && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
          Not installed yet — osmo-hnbgw isn't an apt package, this builds it from source
          (tag 1.3.0, matched to this host's installed Osmocom libraries). Fill in the fields
          below (or leave the defaults) and hit Install &amp; Configure.
        </div>
      )}
      <div className="bg-nms-surface-2 border border-nms-border rounded-lg p-3 text-xs text-nms-text-dim">
        <strong className="text-nms-text">Prerequisite:</strong> the 2G GSM page's GPRS/EDGE
        must already be configured — this module adds its own IuPS point-code block into
        osmo-sgsn.cfg (never touching anything else in that file), and refuses to configure
        if that file doesn't exist yet.
      </div>

      <div className="nms-card space-y-4">
        <div>
          <p className="text-sm font-semibold text-nms-text mb-1">Iuh (femtocell-facing)</p>
          <p className="text-xs text-nms-text-dim mb-3">Where a real HNB (or the virtual test one) connects in.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">RNC-ID</label>
              <input type="number" value={rncId} onChange={e => setRncId(Number(e.target.value))} className="nms-input w-full" />
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">Iuh listen IP</label>
              <input value={iuhLocalIp} onChange={e => setIuhLocalIp(e.target.value)} className="nms-input w-full font-mono" />
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">Iuh listen port</label>
              <input type="number" value={iuhLocalPort} onChange={e => setIuhLocalPort(Number(e.target.value))} className="nms-input w-full" />
            </div>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-nms-text mb-1">SCCP/M3UA point-codes</p>
          <p className="text-xs text-nms-text-dim mb-3">
            osmo-stp already accepts new SIGTRAN clients dynamically — these just need to not
            collide with what's already registered (STP itself is 0.24.1, osmo-msc is 0.23.1).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">This gateway's own point-code</label>
              <input value={hnbgwPointCode} onChange={e => setHnbgwPointCode(e.target.value)} className="nms-input w-full font-mono" />
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">MSC point-code (IuCS peer)</label>
              <input value={mscPointCode} onChange={e => setMscPointCode(e.target.value)} className="nms-input w-full font-mono" />
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">SGSN point-code (IuPS peer)</label>
              <input value={sgsnIuPsPointCode} onChange={e => setSgsnIuPsPointCode(e.target.value)} className="nms-input w-full font-mono" />
            </div>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-nms-text mb-1">Dedicated MGW instance</p>
          <p className="text-xs text-nms-text-dim mb-3">
            A third, fully isolated OsmoMGW instance for 3G RTP relay — never the same one the
            2G module's A-interface already uses.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">MGCP bind IP</label>
              <input value={mgwBindIp} onChange={e => setMgwBindIp(e.target.value)} className="nms-input w-full font-mono" />
            </div>
            <div>
              <label className="text-xs text-nms-text-dim block mb-1">RTP bind IP</label>
              <input value={mgwRtpBindIp} onChange={e => setMgwRtpBindIp(e.target.value)} className="nms-input w-full font-mono" />
            </div>
          </div>
        </div>

        <button onClick={handleInstallAndConfigure} disabled={installing || configuring} className="nms-btn-primary w-full">
          {installing ? 'Installing (source build, can take a few minutes)…' : configuring ? 'Configuring…' : 'Install & Configure'}
        </button>

        {installLog && (
          <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border">
            {installLog}
          </pre>
        )}
      </div>
    </div>
  );
}

function VirtualHnbTab({ status, refresh }: { status: HnbgwStatus | null; refresh: () => void }) {
  const [deploying, setDeploying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deployLog, setDeployLog] = useState('');

  const deploy = async () => {
    setDeploying(true);
    setDeployLog('');
    try {
      const res = await hnbgwApi.deployVirtualHnb();
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setDeployLog(prev => prev + decoder.decode(value));
        }
      }
      toast.success('Virtual HNB deployed');
      refresh();
    } catch {
      toast.error('Deploy failed');
    } finally {
      setDeploying(false);
    }
  };
  const remove = async () => {
    setRemoving(true);
    try {
      await hnbgwApi.removeVirtualHnb();
      toast.success('Virtual HNB removed');
      refresh();
    } catch (err: any) {
      toast.error(`Remove failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setRemoving(false);
    }
  };

  const hnbs = status ? parseHnbList(status.hnbListRaw || '') : [];

  return (
    <div className="space-y-4">
      <div className="bg-nms-surface-2 border border-nms-border rounded-lg p-3 text-xs text-nms-text-dim">
        <strong className="text-nms-text">OsmoHNodeB</strong> — Osmocom's own software 3G Home
        NodeB, the direct equivalent of the 2G module's virtual BTS. Proves the whole HNBAP/Iuh
        registration chain against this real OsmoHNBGW instance without needing the real nano3G.
        No RF, no real subscriber can attach to it.
      </div>

      <div className="nms-card flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm font-semibold text-nms-text">Virtual HNB (osmo-hnodeb)</p>
          <p className="text-xs text-nms-text-dim mt-0.5">
            {status?.virtualHnbDeployed ? 'Deployed and running' : status?.virtualHnbInstalled ? 'Built, not deployed' : 'Not built yet — first deploy builds it from source (tag 0.1.0)'}
          </p>
        </div>
        {status?.virtualHnbDeployed ? (
          <button onClick={remove} disabled={removing} className="nms-btn-ghost text-red-400 flex items-center gap-1.5 text-xs">
            <Trash2 className="w-3.5 h-3.5" /> {removing ? 'Removing…' : 'Remove Virtual HNB'}
          </button>
        ) : (
          <button onClick={deploy} disabled={deploying || !status?.configured} className="nms-btn-ghost flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" /> {deploying ? 'Deploying (source build)…' : 'Deploy Virtual HNB'}
          </button>
        )}
      </div>
      {!status?.configured && (
        <p className="text-xs text-amber-400">Configure OsmoHNBGW itself first (Setup tab) — the virtual HNB dials out to it.</p>
      )}

      {deployLog && (
        <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border">
          {deployLog}
        </pre>
      )}

      <div className="nms-card">
        <p className="text-sm font-semibold text-nms-text mb-3">Registered HNBs</p>
        {hnbs.length === 0 ? (
          <p className="text-sm text-nms-text-dim italic">
            None registered. Iuh/HNBAP has no remote-provisioning push (unlike 2G's OML) — a real
            HNB must be pointed at this gateway's Iuh address on its own local config first, then
            it self-registers here.
          </p>
        ) : (
          <div className="divide-y divide-nms-border">
            {hnbs.map(h => (
              <div key={h.identity + h.remoteAddr} className="flex items-center justify-between py-2">
                <div>
                  <span className="text-sm font-mono text-nms-text">{h.identity}</span>
                  <span className="text-xs text-nms-text-dim ml-2">{h.remoteAddr}</span>
                </div>
                <span className="text-xs font-mono text-nms-text-dim">
                  MCC {h.mcc} MNC {h.mnc} LAC {h.lac} CID {h.cid}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigFilesTab() {
  const [files, setFiles] = useState<HnbgwConfigFile[]>([]);
  const [selected, setSelected] = useState<HnbgwConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    fetch('/api/hnbgw/configs', { credentials: 'include' })
      .then(r => r.json()).then(r => setFiles(r.files || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const openFile = async (f: HnbgwConfigFile) => {
    setSelected(f);
    const r = await fetch(`/api/hnbgw/configs/content?path=${encodeURIComponent(f.path)}`, { credentials: 'include' }).then(r => r.json());
    setContent(r.content || '');
  };

  const handleSave = async () => {
    if (!selected) return;
    if (selected.shared && !window.confirm(
      `${selected.label} is shared with ${selected.sharedWith}\n\nSave and restart ${selected.restartServices.join(', ')} anyway?`,
    )) return;
    setSaving(true);
    try {
      await fetch('/api/hnbgw/configs/content', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selected.path, content }),
      });
      await fetch('/api/hnbgw/configs/restart', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services: selected.restartServices }),
      });
      toast.success(`Saved — restarted ${selected.restartServices.join(', ')}`);
      load();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.message ?? 'unknown error'}`);
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

export function HnbPage({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [status, setStatus] = useState<HnbgwStatus | null>(null);
  const [tab, setTab] = useState<'setup' | 'virtual-hnb' | 'subscribers' | 'configs'>('setup');
  const [svcBusy, setSvcBusy] = useState(false);

  const refresh = useCallback(() => {
    hnbgwApi.getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setSvcBusy(true);
    try {
      await { start: hnbgwApi.start, stop: hnbgwApi.stop, restart: hnbgwApi.restart }[action]();
      toast.success(`3G UMTS services ${action}ed`);
      refresh();
    } catch (err: any) {
      toast.error(`${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSvcBusy(false);
    }
  };

  const TABS: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'setup',       label: 'Setup',        icon: <Settings className="w-4 h-4" /> },
    { id: 'virtual-hnb', label: 'Virtual HNB',  icon: <Wifi className="w-4 h-4" /> },
    { id: 'subscribers', label: 'Subscribers',  icon: <Smartphone className="w-4 h-4" /> },
    { id: 'configs',     label: 'Config Files', icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold font-display text-nms-text">3G UMTS (OsmoHNBGW)</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">alpha</span>
          </div>
          <p className="text-sm text-nms-text-dim mt-1">
            Home NodeB Gateway bridging a 3G femtocell to osmo-msc and osmo-sgsn.
          </p>
        </div>

        {status?.installedOnDisk && (
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <SvcBadge label="osmo-hnbgw" active={!!status.services['osmo-hnbgw']} />
            <SvcBadge label="dedicated mgw" active={!!status.services['osmo-mgw-hnbgw']} />
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
                tab === tabDef.id ? 'bg-nms-accent text-white shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
              )}
            >
              {tabDef.icon}
              {tabDef.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'setup' && <SetupTab status={status} refresh={refresh} />}
      {tab === 'virtual-hnb' && <VirtualHnbTab status={status} refresh={refresh} />}
      {tab === 'subscribers' && <SubscriberAuthTab onNavigate={onNavigate} />}
      {tab === 'configs' && <ConfigFilesTab />}
    </div>
  );
}
