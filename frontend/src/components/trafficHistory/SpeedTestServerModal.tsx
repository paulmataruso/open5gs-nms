import { useState, useEffect } from 'react';
import { X, Gauge, CheckCircle, XCircle, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import axios from 'axios';
import toast from 'react-hot-toast';

interface Props {
  onClose: () => void;
}

interface Settings {
  bindIp: string;
  httpPort: number;
  httpsPort: number;
  enableHttps: boolean;
}

const DEFAULT_SETTINGS: Settings = { bindIp: '0.0.0.0', httpPort: 9080, httpsPort: 9081, enableHttps: true };

export const SpeedTestServerModal: React.FC<Props> = ({ onClose }) => {
  const API_URL = import.meta.env.VITE_API_URL || '/api';

  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [availableIps, setAvailableIps] = useState<{ ip: string; iface: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const fetchStatus = async () => {
    try {
      const [{ data: statusData }, { data: ipsData }] = await Promise.all([
        axios.get(`${API_URL}/speedtest/status`),
        axios.get(`${API_URL}/speedtest/available-ips`),
      ]);
      setRunning(statusData.running);
      setSettings(statusData.settings);
      setAvailableIps(ipsData.ips || []);
    } catch {
      setErrorMessage('Failed to load speed test server status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStatus(); }, []);

  const handleStart = async () => {
    setErrorMessage('');
    setStarting(true);
    try {
      const { data } = await axios.post(`${API_URL}/speedtest/start`, settings);
      if (data.success) {
        toast.success(`OpenSpeedTest server started on ${settings.bindIp}:${settings.httpPort}`);
        setRunning(true);
        setSettings(data.settings);
      } else {
        setErrorMessage(data.error || 'Failed to start speed test server');
      }
    } catch (err: any) {
      setErrorMessage(err.response?.data?.error || err.message);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await axios.post(`${API_URL}/speedtest/stop`);
      toast.success('Speed test server stopped');
      setRunning(false);
    } catch (err: any) {
      toast.error(`Failed to stop: ${err.message}`);
    } finally {
      setStopping(false);
    }
  };

  const displayHost = settings.bindIp === '0.0.0.0' ? window.location.hostname : settings.bindIp;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">

        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border">
          <h2 className="text-lg font-semibold font-display text-nms-text flex items-center gap-2">
            <Gauge className="w-5 h-5 text-nms-accent" />
            Speed Test Server
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
          ) : (
            <>
              {/* Status + primary action — always visible up top, no scrolling needed */}
              <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-nms-border bg-nms-surface-2">
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border ${
                  running ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30'
                }`}>
                  {running ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {running ? 'Running' : 'Stopped'}
                </div>

                {!running ? (
                  <button
                    onClick={handleStart}
                    disabled={starting}
                    className="nms-btn-primary flex items-center justify-center gap-2 text-sm px-4"
                  >
                    {starting ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</> : 'Start Server'}
                  </button>
                ) : (
                  <button
                    onClick={handleStop}
                    disabled={stopping}
                    className="nms-btn-ghost text-sm text-red-400 flex items-center justify-center gap-2 px-4"
                  >
                    {stopping ? <><Loader2 className="w-4 h-4 animate-spin" /> Stopping…</> : 'Stop Server'}
                  </button>
                )}
              </div>

              <p className="text-xs text-nms-text-dim">
                Spins up a temporary OpenSpeedTest container on the core so a UE can run a
                real throughput test against the network directly — no NAT/public internet
                involved when bound to a DNN gateway IP (e.g. 10.45.0.1 for the "internet" APN).
              </p>

              {running && (
                <div className="p-3 rounded-lg border border-nms-accent/30 bg-nms-accent/5 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-nms-text-dim">HTTP</span>
                    <a
                      href={`http://${displayHost}:${settings.httpPort}`}
                      target="_blank" rel="noreferrer"
                      className="font-mono text-nms-accent flex items-center gap-1 hover:underline"
                    >
                      {settings.bindIp}:{settings.httpPort} <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  {settings.enableHttps && (
                    <div className="flex items-center justify-between">
                      <span className="text-nms-text-dim">HTTPS (self-signed)</span>
                      <a
                        href={`https://${displayHost}:${settings.httpsPort}`}
                        target="_blank" rel="noreferrer"
                        className="font-mono text-nms-accent flex items-center gap-1 hover:underline"
                      >
                        {settings.bindIp}:{settings.httpsPort} <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-3">
                <div>
                  <label className="nms-label mb-1">Bind IP</label>
                  <input
                    type="text"
                    list="speedtest-bind-ips"
                    value={settings.bindIp}
                    onChange={e => setSettings(s => ({ ...s, bindIp: e.target.value }))}
                    disabled={running}
                    placeholder="e.g. 10.45.0.1"
                    className="nms-input w-full font-mono disabled:opacity-60"
                  />
                  <datalist id="speedtest-bind-ips">
                    <option value="0.0.0.0">All interfaces</option>
                    {availableIps.map(({ ip, iface }) => (
                      <option key={ip} value={ip}>{iface}</option>
                    ))}
                  </datalist>
                  <p className="text-[11px] text-nms-text-dim mt-1">
                    Use a DNN gateway IP (e.g. ogstun's 10.45.0.1) so UEs reach it directly over the core.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="nms-label mb-1">HTTP Port</label>
                    <input
                      type="number"
                      value={settings.httpPort}
                      onChange={e => setSettings(s => ({ ...s, httpPort: parseInt(e.target.value) || 0 }))}
                      disabled={running}
                      min={1} max={65535}
                      className="nms-input w-full text-center disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="nms-label mb-1 flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={settings.enableHttps}
                        onChange={e => setSettings(s => ({ ...s, enableHttps: e.target.checked }))}
                        disabled={running}
                        className="nms-checkbox"
                      />
                      HTTPS Port
                    </label>
                    <input
                      type="number"
                      value={settings.httpsPort}
                      onChange={e => setSettings(s => ({ ...s, httpsPort: parseInt(e.target.value) || 0 }))}
                      disabled={running || !settings.enableHttps}
                      min={1} max={65535}
                      className="nms-input w-full text-center disabled:opacity-60"
                    />
                  </div>
                </div>
              </div>

              {errorMessage && (
                <div className="flex items-start gap-2 text-xs text-nms-red">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {errorMessage}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
