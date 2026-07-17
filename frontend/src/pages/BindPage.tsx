import { useState, useEffect, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import {
  CheckCircle, XCircle, RefreshCw, Play, Square, RotateCw, Download,
  Globe, Plus, Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { bindApi } from '../api/bind';
import type { BindStatus, BindFile } from '../api/bind';
import { DnsMigrationPage } from './DnsMigrationPage';
import { FEATURES } from '../config/features';

export function BindPage() {
  const [activeTab, setActiveTab] = useState<'files' | 'migration'>('files');
  const [status, setStatus]     = useState<BindStatus | null>(null);
  const [manifest, setManifest] = useState<BindFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent]           = useState('');
  const [originalContent, setOriginal]  = useState('');
  const [loading, setLoading]           = useState(false);
  const [saving, setSaving]             = useState(false);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [installing, setInstalling]     = useState(false);
  const [installLog, setInstallLog]     = useState('');
  const [acting, setActing]             = useState(false);
  const [forwardersInput, setForwardersInput] = useState('');
  const [savingForwarders, setSavingForwarders] = useState(false);

  const isDirty = content !== originalContent;

  const loadStatus = useCallback(async () => {
    try { setStatus(await bindApi.getStatus()); } catch { /* backend not reachable */ }
  }, []);

  const loadManifest = useCallback(async () => {
    setManifestLoading(true);
    try {
      const d = await bindApi.getFiles();
      setManifest(d.files);
    } catch { /* ignore */ }
    finally { setManifestLoading(false); }
  }, []);

  const loadForwarders = useCallback(async () => {
    try {
      const d = await bindApi.getForwarders();
      setForwardersInput(d.forwarders.join(', '));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadStatus();
    loadManifest();
    loadForwarders();
    const interval = setInterval(loadStatus, 8000);
    return () => clearInterval(interval);
  }, [loadStatus, loadManifest, loadForwarders]);

  const handleSaveForwarders = async () => {
    const forwarders = forwardersInput.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    const ipRe = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    if (forwarders.length === 0 || !forwarders.every(f => ipRe.test(f))) {
      toast.error('Enter one or more valid IPv4 addresses, separated by commas');
      return;
    }
    setSavingForwarders(true);
    try {
      await bindApi.saveForwarders(forwarders);
      toast.success('Upstream DNS saved — BIND9 restarted.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Failed to save upstream DNS');
    } finally {
      setSavingForwarders(false);
    }
  };

  const doInstall = async () => {
    setInstalling(true);
    setInstallLog('');
    try {
      const resp = await bindApi.install();
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setInstallLog(prev => prev + decoder.decode(value, { stream: true }));
        }
      }
      toast.success('BIND9 installed');
      await Promise.all([loadStatus(), loadManifest()]);
    } catch (err: any) {
      toast.error('Install failed: ' + String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setActing(true);
    try {
      if (action === 'start') await bindApi.start();
      if (action === 'stop') await bindApi.stop();
      if (action === 'restart') await bindApi.restart();
      toast.success(`${action} sent`);
      setTimeout(loadStatus, 1000);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? `${action} failed`);
    } finally {
      setActing(false);
    }
  };

  const selectFile = async (filePath: string) => {
    if (isDirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    setSelectedPath(filePath);
    setLoading(true);
    setContent('');
    setOriginal('');
    try {
      const { content: c } = await bindApi.getFileContent(filePath);
      setContent(c);
      setOriginal(c);
    } catch (err: any) {
      toast.error('Failed to load file: ' + String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (restart: boolean) => {
    if (!selectedPath) return;
    setSaving(true);
    try {
      await bindApi.saveFileContent(selectedPath, content, restart);
      setOriginal(content);
      setManifest(m => m.some(f => f.path === selectedPath) ? m : [...m, { path: selectedPath, label: selectedPath.replace('/etc/bind/', '') }]);
      toast.success(restart ? 'Saved — BIND9 restarted.' : 'Saved.');
    } catch (err: any) {
      toast.error('Save failed: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleNewFile = async () => {
    const name = window.prompt('New file path relative to /etc/bind (e.g. zones/mycustom.zone):');
    if (!name) return;
    const filePath = `/etc/bind/${name.replace(/^\/+/, '')}`;
    try {
      await bindApi.saveFileContent(filePath, '', false);
      await loadManifest();
      selectFile(filePath);
    } catch (err: any) {
      toast.error('Failed to create file: ' + String(err));
    }
  };

  const handleDelete = async () => {
    if (!selectedPath) return;
    if (!window.confirm(`Delete ${selectedPath}? This cannot be undone.`)) return;
    try {
      await bindApi.deleteFile(selectedPath);
      setManifest(m => m.filter(f => f.path !== selectedPath));
      setSelectedPath(null);
      setContent('');
      setOriginal('');
      toast.success('Deleted.');
    } catch (err: any) {
      toast.error('Delete failed: ' + String(err));
    }
  };

  const language = selectedPath?.endsWith('.conf') || selectedPath?.endsWith('.local') || selectedPath?.endsWith('.options')
    ? 'plaintext' : selectedPath?.endsWith('.zone') ? 'plaintext' : 'plaintext';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-nms-accent/10 border border-nms-accent/20">
            <Globe className="w-5 h-5 text-nms-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold font-display text-nms-text">DNS (BIND9)</h1>
            <p className="text-xs text-nms-text-dim">Shared DNS server — raw file editor for zones and config used by IMS, VoWiFi, and anything else</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {status?.installed && (
            <>
              <button onClick={() => handleServiceAction('start')} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <Play className="w-3 h-3" /> Start
              </button>
              <button onClick={() => handleServiceAction('stop')} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <Square className="w-3 h-3" /> Stop
              </button>
              <button onClick={() => handleServiceAction('restart')} disabled={acting} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                <RotateCw className="w-3 h-3" /> Restart
              </button>
              <div className="h-5 w-px bg-nms-border" />
            </>
          )}
          {!status?.installed && (
            <button onClick={doInstall} disabled={installing} className="nms-btn-primary text-xs flex items-center gap-1.5 px-2.5 py-1.5 disabled:opacity-40">
              {installing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} Install BIND9
            </button>
          )}
          <button onClick={() => { loadStatus(); loadManifest(); }} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {FEATURES.dnsMigration && (
        <div className="flex justify-center">
          <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
            {([['files', 'Files'], ['migration', 'FQDN Migration']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setActiveTab(key)}
                className={clsx('px-4 py-1.5 rounded-md text-sm font-medium transition-colors',
                  activeTab === key ? 'bg-nms-accent text-white shadow-sm' : 'text-nms-text-dim hover:text-nms-text')}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'migration' && FEATURES.dnsMigration && <DnsMigrationPage />}

      {activeTab === 'files' && <>

      {status && (
        <div className="flex items-center gap-2">
          <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border',
            status.installed ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30')}>
            {status.installed ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} {status.installed ? 'Installed' : 'Not Installed'}
          </span>
          <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border',
            status.running ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-nms-text-dim border-nms-border')}>
            {status.running ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />} {status.running ? 'Running' : 'Stopped'}
          </span>
          <span className="text-xs text-nms-text-dim">{status.fileCount} file{status.fileCount === 1 ? '' : 's'} under /etc/bind</span>
        </div>
      )}

      {(installing || installLog) && (
        <div className="nms-card">
          <p className="text-xs text-nms-text-dim mb-1">Install log</p>
          <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border">
            {installLog || 'Waiting for output...'}
          </pre>
        </div>
      )}

      {status?.installed && (
        <div className="nms-card">
          <p className="text-sm font-semibold text-nms-text mb-1">Upstream DNS (internet forwarding)</p>
          <p className="text-xs text-nms-text-dim mb-3">
            This server only answers authoritatively for its own zones (IMS, VoWiFi's ePDG domain, etc).
            Any other lookup is forwarded here — without this, a UE using this server as its DNS would
            resolve IMS/VoWiFi names fine but get nothing for general internet domains.
          </p>
          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[240px]">
              <label className="text-xs text-nms-text-dim block mb-1">Forwarder IP(s), comma-separated</label>
              <input
                value={forwardersInput}
                onChange={e => setForwardersInput(e.target.value)}
                placeholder="8.8.8.8, 8.8.4.4"
                className="nms-input text-sm w-full font-mono"
                spellCheck={false}
              />
            </div>
            <button onClick={handleSaveForwarders} disabled={savingForwarders} className="nms-btn text-sm px-3 py-1.5 disabled:opacity-40 flex items-center gap-2">
              {savingForwarders ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null} Save & Restart
            </button>
          </div>
        </div>
      )}

      <div className="flex border border-nms-border rounded-xl overflow-hidden" style={{ height: 'calc(100vh - 260px)', minHeight: '450px' }}>
        <div className="w-64 shrink-0 bg-nms-bg border-r border-nms-border overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-nms-border shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-nms-text-dim">/etc/bind</span>
            <div className="flex items-center gap-1">
              <button onClick={handleNewFile} title="New file" className="text-nms-text-dim hover:text-nms-text transition-colors">
                <Plus className="w-3.5 h-3.5" />
              </button>
              <button onClick={loadManifest} disabled={manifestLoading} title="Refresh" className="text-nms-text-dim hover:text-nms-text transition-colors">
                <RefreshCw className={clsx('w-3 h-3', manifestLoading && 'animate-spin')} />
              </button>
            </div>
          </div>
          {manifest.length === 0 && !manifestLoading && (
            <p className="px-3 py-4 text-xs text-nms-text-dim">{status?.installed ? 'No files found.' : 'BIND9 not installed yet.'}</p>
          )}
          {manifest.map(f => (
            <button
              key={f.path}
              onClick={() => selectFile(f.path)}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                selectedPath === f.path ? 'bg-nms-accent/10 text-nms-accent' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
              )}
            >
              <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', selectedPath === f.path && isDirty ? 'bg-amber-400' : 'bg-green-500')} />
              <span className="truncate font-mono">{f.label}</span>
            </button>
          ))}
        </div>

        <div className="flex-1 flex flex-col min-w-0 bg-[#1e1e1e]">
          <div className="flex items-center justify-between gap-3 px-4 py-2 bg-nms-surface border-b border-nms-border shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {selectedPath ? (
                <>
                  <span className="font-mono text-xs text-nms-text-dim truncate">{selectedPath}</span>
                  {isDirty && <span className="text-amber-400 text-xs shrink-0">● unsaved</span>}
                </>
              ) : <span className="text-xs text-nms-text-dim">Select a file, or create a new one</span>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {selectedPath && (
                <button onClick={handleDelete} className="text-red-400 hover:text-red-300 transition-colors" title="Delete file">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={() => handleSave(false)} disabled={!selectedPath || saving || !isDirty} className="nms-btn-ghost text-xs px-3 py-1.5 disabled:opacity-40">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => handleSave(true)} disabled={!selectedPath || saving} className="nms-btn text-xs px-3 py-1.5 disabled:opacity-40">
                {saving ? 'Saving…' : 'Save & Restart'}
              </button>
            </div>
          </div>
          {loading ? (
            <div className="flex-1 flex items-center justify-center"><RefreshCw className="w-5 h-5 text-nms-accent animate-spin" /></div>
          ) : !selectedPath ? (
            <div className="flex-1 flex items-center justify-center"><p className="text-sm text-nms-text-dim">Select a file from the left panel</p></div>
          ) : (
            <div className="flex-1 min-h-0">
              <Editor
                height="100%"
                language={language}
                theme="vs-dark"
                value={content}
                onChange={v => setContent(v ?? '')}
                options={{
                  minimap: { enabled: false }, fontSize: 13,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  wordWrap: 'off', scrollBeyondLastLine: false, lineNumbers: 'on',
                  renderWhitespace: 'selection', tabSize: 4, automaticLayout: true,
                  padding: { top: 8, bottom: 8 },
                }}
              />
            </div>
          )}
        </div>
      </div>

      </>}
    </div>
  );
}
