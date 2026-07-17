import { useState, useEffect, useRef } from 'react';
import { X, RadioTower, CheckCircle, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

interface Props {
  onClose: () => void;
}

interface StatusData {
  installed: boolean;
  running: boolean;
  configured: boolean;
  target: { host: string; port: number; protocol: 'udp' | 'tcp' } | null;
  includeDirOk: boolean;
  frrGroupOk: boolean;
  apparmorOk: boolean;
  logFileCount: number;
}

export const SyslogForwardingModal: React.FC<Props> = ({ onClose }) => {
  const API_URL = import.meta.env.VITE_API_URL || '/api';

  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [host, setHost] = useState('');
  const [port, setPort] = useState(514);
  const [protocol, setProtocol] = useState<'udp' | 'tcp'>('udp');

  const installRef = useRef<HTMLPreElement>(null);

  const fetchStatus = async () => {
    try {
      const { data } = await axios.get(`${API_URL}/syslog/status`);
      setStatus(data);
      if (data.target) {
        setHost(data.target.host);
        setPort(data.target.port);
        setProtocol(data.target.protocol);
      }
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  useEffect(() => {
    if (installRef.current) installRef.current.scrollTop = installRef.current.scrollHeight;
  }, [installLog]);

  const handleInstall = async () => {
    setInstalling(true);
    setInstallLog('');
    try {
      const resp = await fetch(`${API_URL}/syslog/install`, {
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
      await fetchStatus();
      toast.success('rsyslog installed');
    } catch (err: any) {
      toast.error(`Install failed: ${err.message}`);
    } finally {
      setInstalling(false);
    }
  };

  const handleSave = async () => {
    setErrorMessage('');
    if (!host.trim()) { setErrorMessage('Enter a syslog server host or IP.'); return; }
    setSaving(true);
    try {
      const { data } = await axios.post(`${API_URL}/syslog/configure`, { host: host.trim(), port, protocol });
      if (data.success) {
        toast.success(`Forwarding all logs to ${host}:${port}/${protocol}`);
        await fetchStatus();
      } else {
        setErrorMessage(data.error || 'Failed to configure forwarding');
      }
    } catch (err: any) {
      setErrorMessage(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    setDisabling(true);
    try {
      await axios.post(`${API_URL}/syslog/disable`);
      toast.success('Syslog forwarding disabled');
      await fetchStatus();
    } catch (err: any) {
      toast.error(`Failed to disable: ${err.message}`);
    } finally {
      setDisabling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">

        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border">
          <h2 className="text-lg font-semibold font-display text-nms-text flex items-center gap-2">
            <RadioTower className="w-5 h-5 text-nms-accent" />
            Syslog Forwarding
          </h2>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-nms-text-dim">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : !status ? (
            <p className="text-sm text-nms-red">Failed to load syslog status.</p>
          ) : (
            <>
              <p className="text-xs text-nms-text-dim">
                Forwards all open5gs NF logs, GenieACS access logs, and FRR logs
                ({status.logFileCount} files) to a remote syslog server via rsyslog.
                Docker container stdout (e.g. SAS logs) isn't included yet.
              </p>

              {/* Install state */}
              {!status.installed ? (
                <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-2">
                  <div className="flex items-center gap-2 text-sm text-amber-300">
                    <AlertTriangle className="w-4 h-4 shrink-0" /> rsyslog is not installed on this host
                  </div>
                  <button
                    onClick={handleInstall}
                    disabled={installing}
                    className="nms-btn-primary w-full flex items-center justify-center gap-2 text-sm"
                  >
                    {installing ? <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</> : 'Install rsyslog'}
                  </button>
                  {installLog && (
                    <pre ref={installRef} className="bg-nms-bg rounded p-2 text-xs font-mono text-green-300 h-32 overflow-y-auto whitespace-pre-wrap">
                      {installLog}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  {status.running ? (
                    <><CheckCircle className="w-4 h-4 text-nms-green" /> <span className="text-nms-text">rsyslog installed and running</span></>
                  ) : (
                    <><XCircle className="w-4 h-4 text-nms-red" /> <span className="text-nms-text">rsyslog installed but not running</span></>
                  )}
                </div>
              )}

              {status.installed && !status.includeDirOk && (
                <div className="flex items-start gap-2 text-xs text-amber-300 p-2 rounded border border-amber-500/30 bg-amber-500/5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>/etc/rsyslog.conf doesn't appear to include /etc/rsyslog.d/*.conf — our forwarding config may not take effect. Check the host's rsyslog.conf.</span>
                </div>
              )}

              {status.configured && status.target && (
                <div className="flex items-center gap-2 text-xs text-nms-accent">
                  <CheckCircle className="w-3.5 h-3.5" />
                  Currently forwarding to <span className="font-mono">{status.target.host}:{status.target.port}/{status.target.protocol}</span>
                </div>
              )}

              {status.configured && !status.frrGroupOk && (
                <div className="flex items-start gap-2 text-xs text-amber-300 p-2 rounded border border-amber-500/30 bg-amber-500/5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>rsyslog can't read the FRR log (permission denied) — re-save the target below to retry the fix.</span>
                </div>
              )}

              {status.configured && !status.apparmorOk && (
                <div className="flex items-start gap-2 text-xs text-amber-300 p-2 rounded border border-amber-500/30 bg-amber-500/5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>AppArmor is blocking rsyslog from reading the GenieACS logs — re-save the target below to retry the fix.</span>
                </div>
              )}

              {/* Target form */}
              {status.installed && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="nms-label mb-1">Syslog Server Host / IP</label>
                      <input
                        type="text"
                        value={host}
                        onChange={e => setHost(e.target.value)}
                        placeholder="e.g. 10.0.0.5"
                        className="nms-input w-full"
                      />
                    </div>
                    <div>
                      <label className="nms-label mb-1">Port</label>
                      <input
                        type="number"
                        value={port}
                        onChange={e => setPort(parseInt(e.target.value) || 514)}
                        min={1}
                        max={65535}
                        className="nms-input w-full text-center"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="nms-label mb-1">Protocol</label>
                    <div className="flex gap-2">
                      {(['udp', 'tcp'] as const).map(p => (
                        <button
                          key={p}
                          onClick={() => setProtocol(p)}
                          className={`px-3 py-1.5 rounded text-sm transition-colors border uppercase ${
                            protocol === p
                              ? 'bg-nms-accent/10 text-nms-accent border-nms-accent/30'
                              : 'text-nms-text-dim border-nms-border hover:text-nms-text'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>

                  {errorMessage && (
                    <div className="flex items-center gap-2 text-xs text-nms-red">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {errorMessage}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="nms-btn-primary flex-1 flex items-center justify-center gap-2 text-sm"
                    >
                      {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : status.configured ? 'Update Forwarding' : 'Enable Forwarding'}
                    </button>
                    {status.configured && (
                      <button
                        onClick={handleDisable}
                        disabled={disabling}
                        className="nms-btn-ghost text-sm text-red-400 flex items-center gap-1.5"
                      >
                        {disabling ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Disable'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
