import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import {
  CheckCircle, XCircle, RefreshCw, RotateCw, Play, Square, ShieldCheck,
  AlertTriangle, AlertCircle, BookOpen, ChevronDown, Radio as RadioIcon,
  PlusCircle, Download, Trash2, X, Zap, Copy, Check, Eye, EyeOff, Info, Pencil,
  Activity, FileText,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  secgwApi,
  IKE_ENCRYPTION_OPTIONS, ESP_ENCRYPTION_OPTIONS, IKE_INTEGRITY_OPTIONS, ESP_INTEGRITY_OPTIONS,
  IKE_DH_GROUP_OPTIONS, ESP_DH_GROUP_OPTIONS,
  NOKIA_IKE_ENCRYPTION_OPTIONS, NOKIA_ESP_ENCRYPTION_OPTIONS, NOKIA_IKE_INTEGRITY_OPTIONS, NOKIA_ESP_INTEGRITY_OPTIONS,
  NOKIA_IKE_DH_GROUP_OPTIONS, NOKIA_PFS_DH_GROUP_OPTIONS,
} from '../api/secgw';
import type {
  SecGwStatus, SecGwRadio, SecGwRadioType, SecGwSession, SecGwConfigFile,
  SecGwAuthMode, SecGwIkeEncryption, SecGwEspEncryption, SecGwIkeIntegrity, SecGwEspIntegrity, SecGwDhGroup,
  SecGwRadioVendor, SecGwIkeSaMode,
} from '../api/secgw';
import { genieacsApi } from '../api/genieacs';
import type { BaicellsRadio, SercommRadio } from '../api/genieacs';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';

function optionLabel<T extends string>(options: { label: string; value: T }[], value: T): string {
  return options.find(o => o.value === value)?.label ?? value;
}

// ── Shared sub-components ─────────────────────────────────────────────────────

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

function RadioStatusBadge({ status }: { status: SecGwRadio['status'] }) {
  const cfg = {
    pending: { label: 'Never Connected', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
    active: { label: 'Provisioned', cls: 'text-blue-400 bg-blue-500/10 border-blue-500/30' },
    revoked: { label: 'Revoked', cls: 'text-red-400 bg-red-500/10 border-red-500/30' },
  }[status];
  return (
    <span
      className={clsx('px-2 py-0.5 rounded-full text-[10px] font-mono border', cfg.cls)}
      title="Certificate/PSK lifecycle — has this credential ever connected. NOT live tunnel status, see the Tunnel column."
    >
      {cfg.label}
    </span>
  );
}

// Real-time tunnel liveness — recomputed fresh from swanctl on every poll, distinct
// from RadioStatusBadge's PKI lifecycle status. Found live 2026-08-23: a physically
// powered-off Nokia radio still showed RadioStatusBadge "Active" (correctly latched
// from an earlier successful connection) while its tunnel had long since been torn
// down by DPD — conflating the two into one badge made a dead radio look live.
function TunnelStatusBadge({ active, enabled }: { active: boolean; enabled: boolean }) {
  if (!enabled) {
    return (
      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono border text-nms-text-dim bg-nms-surface-2 border-nms-border">
        — disabled
      </span>
    );
  }
  return (
    <span className={clsx(
      'px-2 py-0.5 rounded-full text-[10px] font-mono border flex items-center gap-1 w-fit',
      active
        ? 'text-green-400 bg-green-500/10 border-green-500/30'
        : 'text-red-400 bg-red-500/10 border-red-500/30',
    )}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', active ? 'bg-green-400 animate-pulse' : 'bg-red-500')} />
      {active ? 'Up' : 'Down'}
    </span>
  );
}

// Administrative on/off — independent of both RadioStatusBadge and TunnelStatusBadge.
// Clickable: toggles via secgw-controller.ts's /enable /disable endpoints, which
// unload/reload the radio's swanctl connection without touching its credential.
function EnabledToggleBadge({ enabled, busy, onToggle }: { enabled: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      disabled={busy}
      className={clsx(
        'px-2 py-0.5 rounded-full text-[10px] font-mono border transition-colors',
        enabled
          ? 'text-nms-accent bg-nms-accent/10 border-nms-accent/30 hover:bg-nms-accent/20'
          : 'text-nms-text-dim bg-nms-surface-2 border-nms-border hover:text-nms-text',
      )}
      title={enabled ? 'Click to disable — tears down the tunnel without revoking the credential' : 'Click to re-enable'}
    >
      {busy ? '…' : enabled ? 'Enabled' : 'Disabled'}
    </button>
  );
}

// Labeled value + copy button, optionally maskable (for the PSK) — same show/hide +
// copy-to-clipboard pattern as SeppEditor.tsx's cert display, reused here so an
// operator can read off Right ID/Left ID/subnets/PSK straight from this page while
// configuring the radio's own IPsec UI side by side, instead of having to open the
// downloaded connection-info.txt every time.
function CopyField({ label, value, maskable }: { label: string; value: string; maskable?: boolean }) {
  const copyToClipboard = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!maskable);

  const doCopy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };

  return (
    <div>
      <p className="text-[10px] text-nms-text-dim uppercase tracking-wider mb-0.5">{label}</p>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 text-xs font-mono text-nms-text bg-nms-bg border border-nms-border rounded px-2 py-1 truncate">
          {maskable && !revealed ? '•'.repeat(Math.min(value.length, 32)) : value}
        </code>
        {maskable && (
          <button type="button" onClick={() => setRevealed(r => !r)} className="nms-btn-ghost px-1.5 py-1 shrink-0" title={revealed ? 'Hide' : 'Show'}>
            {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
        <button type="button" onClick={doCopy} className="nms-btn-ghost px-1.5 py-1 shrink-0" title="Copy">
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

// Inline expandable detail panel — everything an operator needs while typing values
// into a Baicells radio's own IPsec page: Right ID/Left ID/Right Subnet/Left Subnet
// terminology matches Baicells' UI exactly (see connectionInfoSheet() on the backend,
// which this mirrors), plus the PSK (if applicable) and the algorithm proposal summary.
function RadioDetailsPanel({ radio, gatewayFqdn, gatewayIp }: { radio: SecGwRadio; gatewayFqdn: string | null; gatewayIp: string | null }) {
  if (radio.vendor === 'nokia') {
    // Nokia has no IKEv2 Configuration Payload support (confirmed live 2026-08-14 against
    // the radio's own page) — "Local/Remote IP Address" is a static traffic selector
    // (what traffic gets protected), a genuinely different thing from "Local/Remote
    // tunnel endpoint" (the real outer IPs IKE/ESP packets travel between). remoteIps
    // may be >1 address — Nokia needs a SEPARATE "Protect" policy per address if its page
    // only accepts one Remote IP Address per policy.
    const remoteIps = radio.localTs.split(',').map(s => s.trim().replace(/\/32$/, ''));
    const remoteIpValue = remoteIps.join(' , ') + (remoteIps.length > 1
      ? ` (${remoteIps.length} separate Protect policies needed — one per address, sharing every other setting below)`
      : '');
    // Every field name below is exactly what the user specified this radio's own IPsec
    // page asks for — do not rename these, only correct spelling.
    const rows: { label: string; value: string }[] = [
      { label: 'Local IP Address', value: radio.localIpAddress ?? '—' },
      { label: 'Local tunnel endpoint IP address', value: radio.localIpAddress ?? '—' },
      { label: 'Remote IP Address', value: remoteIpValue },
      { label: 'Remote Tunnel Endpoint', value: gatewayIp ?? '—' },
      { label: 'IKE Diffie-Hellman Group', value: optionLabel(NOKIA_IKE_DH_GROUP_OPTIONS, radio.ikeDhGroup) },
      { label: 'IKE Encryption method', value: optionLabel(NOKIA_IKE_ENCRYPTION_OPTIONS, radio.ikeEncryption) },
      { label: 'IKE Authentication method', value: optionLabel(NOKIA_IKE_INTEGRITY_OPTIONS, radio.ikeIntegrity) },
      { label: 'IKE SA connection establishment mode', value: radio.ikeSaMode === 'responder' ? 'Responder' : 'Initiator and responder' },
      { label: 'IKE Reauthentication enable', value: radio.ikeReauthEnabled ? 'Yes' : 'No' },
      { label: 'ESP encryption method', value: optionLabel(NOKIA_ESP_ENCRYPTION_OPTIONS, radio.espEncryption) },
      { label: 'ESP authentication method', value: optionLabel(NOKIA_ESP_INTEGRITY_OPTIONS, radio.espIntegrity) },
      { label: 'IPsec perfect forward secrecy enable', value: radio.pfsEnabled ? 'Yes' : 'No' },
      { label: 'PFS Diffie-Hellman group', value: radio.pfsEnabled ? optionLabel(NOKIA_PFS_DH_GROUP_OPTIONS, radio.pfsDhGroup ?? 'modp2048') : 'N/A (PFS disabled)' },
      { label: 'Anti replay enable', value: radio.antiReplayEnabled ? 'Yes' : 'No' },
      { label: 'anti replay window size', value: radio.antiReplayEnabled ? String(radio.antiReplayWindowSize ?? 64) : 'N/A' },
      { label: 'dead peer detection delay', value: `${radio.dpdDelaySeconds ?? '—'}s` },
      { label: 'IKE association max lifetime', value: `${radio.ikeSaLifetimeSeconds ?? '—'}s` },
      { label: 'Security association max lifetime', value: `${radio.childSaLifetimeSeconds ?? '—'}s` },
      { label: 'Peer IKE identity', value: gatewayFqdn ?? '—' },
    ];
    return (
      <tr className="border-b border-nms-border/50 bg-nms-bg/30">
        <td colSpan={6} className="py-3 px-2">
          <table className="w-full text-xs">
            <tbody>
              {rows.map(row => (
                <tr key={row.label} className="border-b border-nms-border/40 last:border-0">
                  <td className="py-1 pr-3 text-nms-text-dim whitespace-nowrap align-top">{row.label}</td>
                  <td className="py-1 font-mono text-nms-text">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {radio.psk && (
            <div className="mt-2 max-w-sm">
              <CopyField label="Secret Key (PSK)" value={radio.psk} maskable />
            </div>
          )}
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b border-nms-border/50 bg-nms-bg/30">
      <td colSpan={6} className="py-3 px-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <CopyField label="Right ID (this gateway's IKE identity)" value={gatewayFqdn ?? '—'} />
          <CopyField label="Left ID (this radio's IKE identity — set this on the radio)" value={radio.peerIdentity} />
          <CopyField label="Right Subnet (reachable through this gateway)" value={radio.localTs} />
          <CopyField label="Assigned Virtual IP (dedicated to this radio, auto-allocated)" value={radio.poolAddress ?? '—'} />
          {radio.authMode === 'psk' && radio.psk && (
            <div className="sm:col-span-2">
              <CopyField label="Secret Key (PSK)" value={radio.psk} maskable />
            </div>
          )}
        </div>
        <p className="text-[10px] text-nms-text-dim mt-3">
          IKE: {optionLabel(IKE_ENCRYPTION_OPTIONS, radio.ikeEncryption)} / {optionLabel(IKE_INTEGRITY_OPTIONS, radio.ikeIntegrity)} / {optionLabel(IKE_DH_GROUP_OPTIONS, radio.ikeDhGroup)}
          {'  ·  '}
          ESP: {optionLabel(ESP_ENCRYPTION_OPTIONS, radio.espEncryption)} / {optionLabel(ESP_INTEGRITY_OPTIONS, radio.espIntegrity)} / {optionLabel(ESP_DH_GROUP_OPTIONS, radio.espDhGroup)}
          {'  ·  '}Auth: {radio.authMode === 'psk' ? 'PSK' : 'PubKey (Certificate)'}
        </p>
      </td>
    </tr>
  );
}

// ── Overview / architecture explainer ─────────────────────────────────────────

function OverviewCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="nms-card">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-nms-accent shrink-0" />
          <span className="text-sm font-semibold text-nms-text">How the Security Gateway Works</span>
          <span className="text-xs text-nms-text-dim">— architecture overview</span>
        </div>
        <ChevronDown className={clsx('w-4 h-4 text-nms-text-dim transition-transform shrink-0', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-5 space-y-5 text-sm">
          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Overview</h3>
            <p className="text-nms-text-dim leading-relaxed">
              Most eNodeB/gNodeB hardware (Baicells, Sercomm, etc.) supports certificate-based
              IPsec for its S1/N2/N3 backhaul to the core. This module runs{' '}
              <span className="font-mono text-nms-text">strongSwan</span> (via <span className="font-mono text-nms-text">swanctl</span>/vici)
              to terminate those tunnels — decrypting real backhaul traffic at the edge and
              forwarding it, in plaintext, to the existing core NFs — for both 4G (S1-MME + S1-U,
              to MME/SGW-U) and 5G (N2 + N3, to AMF/UPF).
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-3">How a radio gets set up</h3>
            <div className="grid grid-cols-1 gap-2">
              {[
                { label: '1. Add Radio', color: 'text-blue-400', desc: 'Pick a radio from GenieACS (or enter one manually if it hasn’t called home yet) and issue it a client certificate signed by this gateway’s own CA.' },
                { label: '2. Download Bundle', color: 'text-amber-400', desc: 'Download the cert+key+CA+connection-info bundle and hand-configure the radio’s own IPsec page — this module never pushes config to the radio automatically.' },
                { label: '3. Test Tunnel', color: 'text-purple-400', desc: 'Once the radio attempts to connect, verify the IKE/CHILD SA actually establishes before touching anything else. The radio keeps working over its existing plaintext path the whole time.' },
                { label: '4. Cut over', color: 'text-cyan-400', desc: 'Only once the tunnel is verified, manually re-point the radio’s own S1-MME/N2 signaling destination at this gateway’s IP.' },
              ].map(({ label, color, desc }) => (
                <div key={label} className="flex items-start gap-3 bg-nms-bg border border-nms-border rounded-xl p-3">
                  <div className={`w-2 h-2 rounded-full mt-2 shrink-0 ${color.replace('text-', 'bg-')}`} />
                  <div>
                    <p className={`font-semibold text-xs ${color}`}>{label}</p>
                    <p className="text-xs text-nms-text-dim mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2">Important notes</h3>
            <ul className="space-y-1.5 text-xs text-nms-text-dim">
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Beta / experimental:</span> this module never restarts MME/AMF/UPF/SGW-U and never edits the radio’s own configuration — adding a radio is purely additive until you manually cut it over.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">No CRL/OCSP:</span> removing a radio deletes its tunnel connection (stopping it from negotiating) and moves its cert to a revoked/ folder, but does not cryptographically revoke it — same trust tier already accepted for this project’s other self-signed cert-based modules.</span></li>
              <li className="flex items-start gap-2"><span className="text-nms-accent mt-0.5">•</span><span><span className="text-nms-text font-medium">Manual download only:</span> there is no automatic TR-069 push of IPsec settings to the radio in this version.</span></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Setup / lifecycle tab ──────────────────────────────────────────────────────

function SetupTab({ status, refresh }: { status: SecGwStatus | null; refresh: () => void }) {
  const [gatewayIp, setGatewayIp] = useState('10.0.1.190');
  const [interfaceMode, setInterfaceMode] = useState<'dummy' | 'existing'>('dummy');
  const [poolCidr, setPoolCidr] = useState('10.0.1.200/29');
  const [frrAcknowledged, setFrrAcknowledged] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (status?.gatewayIp) setGatewayIp(status.gatewayIp);
    if (status?.interfaceMode) setInterfaceMode(status.interfaceMode);
    if (status?.poolCidr) setPoolCidr(status.poolCidr);
  }, [status?.gatewayIp, status?.interfaceMode, status?.poolCidr]);

  const isInstalling = status?.installStatus === 'installing';
  // First-run vs. update-available vs. already-installed — the "1. Install" card only
  // needs to look like an action item in the first two cases. Once installed and not
  // stale, re-showing "Run Install" as the primary CTA every visit made it look like
  // install was never done, per explicit user feedback.
  const neverInstalled = !status?.installedOnDisk;
  const installNeedsAttention = neverInstalled || !!status?.buildStale;
  // The FRR route only matters the first time (nothing routes to the gateway IP yet) or
  // when the operator is actively changing the Gateway IP to a new address — once
  // configured with the current IP, re-showing this and gating Save Changes on it every
  // visit was pure friction, per explicit user feedback.
  const gatewayIpChanged = !!status?.configured && !!status?.gatewayIp && gatewayIp !== status.gatewayIp;
  const needsFrrAck = !status?.configured || gatewayIpChanged;

  const handleInstall = async () => {
    setBusy('install');
    setInstallLog('');
    try {
      const res = await fetch('/api/secgw/install', { method: 'POST', credentials: 'include' });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          setInstallLog(prev => prev + decoder.decode(value));
        }
      }
      refresh();
    } catch (err) {
      toast.error(`Install failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleConfigure = async () => {
    setBusy('configure');
    try {
      const result = await secgwApi.configure({ gatewayIp, interfaceMode, poolCidr });
      if (result.success) {
        toast.success('Configured');
        refresh();
      } else {
        toast.error(result.error ?? 'Configure failed');
      }
    } catch (err) {
      toast.error(`Configure failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleAddDnsRecord = async () => {
    setBusy('dns-record');
    try {
      const result = await secgwApi.addDnsRecord();
      if (result.success) {
        toast.success('DNS record added');
        refresh();
      } else {
        toast.error(result.error ?? 'Failed to add DNS record');
      }
    } catch (err) {
      toast.error(`Failed to add DNS record: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      {installNeedsAttention ? (
        <div className="nms-card">
          <h2 className="text-sm font-semibold text-nms-text mb-3">1. Install</h2>
          <p className="text-xs text-nms-text-dim mb-3">
            Builds strongSwan from source (with a small patch so it can coexist with VoWiFi's
            own IKEv2 daemon on UDP 500/4500) and installs it to <span className="font-mono">/opt/strongswan</span>.
            Takes a few minutes.
          </p>
          <button className="nms-btn-primary" disabled={!!busy || isInstalling} onClick={handleInstall}>
            {busy === 'install' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {busy === 'install' ? 'Installing...' : neverInstalled ? 'Run Install' : 'Rebuild'}
          </button>
          {installLog && (
            <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-96 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-2">
              {installLog}
            </pre>
          )}
          {status?.installStatus === 'failed' && status.installError && (
            <p className="text-xs text-red-400 mt-2 flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {status.installError}
            </p>
          )}
        </div>
      ) : (
        <div className="nms-card !py-2.5 flex items-center justify-between">
          <p className="text-xs text-nms-text-dim flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
            strongSwan installed (patch rev {status?.builtWithPatchRev}).
          </p>
          <button onClick={handleInstall} disabled={!!busy || isInstalling} className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1">
            {busy === 'install' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Reinstall
          </button>
        </div>
      )}
      {!installNeedsAttention && installLog && (
        <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-96 overflow-y-auto whitespace-pre-wrap border border-nms-border">
          {installLog}
        </pre>
      )}

      {needsFrrAck && (
      <div className="nms-card border-amber-500/40 bg-amber-500/5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200 leading-relaxed">
            <p className="font-semibold text-amber-400 mb-1">Before configuring: make the gateway IP reachable from your radios.</p>
            <p>
              This module never edits <span className="font-mono">frr.conf</span> automatically. If your radios sit
              behind EIGRP-carried routing, add the gateway IP/subnet yourself, e.g.:
            </p>
            <pre className="bg-nms-bg border border-nms-border rounded px-2 py-1 mt-1.5 font-mono text-[11px] text-amber-100">network {gatewayIp}/32</pre>
            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" checked={frrAcknowledged} onChange={e => setFrrAcknowledged(e.target.checked)} />
              I’ve added the route (or my radios don’t need one)
            </label>
          </div>
        </div>
      </div>
      )}

      <div className="nms-card">
        <h2 className="text-sm font-semibold text-nms-text mb-3">2. Configure</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="nms-label">Gateway IP</label>
            <input className="nms-input" value={gatewayIp} onChange={e => setGatewayIp(e.target.value)} />
          </div>
          <div>
            <label className="nms-label">Interface Mode</label>
            <select className="nms-input" value={interfaceMode} onChange={e => setInterfaceMode(e.target.value as 'dummy' | 'existing')}>
              <option value="dummy">Create dummy interface</option>
              <option value="existing">Use existing IP</option>
            </select>
          </div>
          <div>
            <label className="nms-label">Virtual IP Pool (CIDR)</label>
            <input className="nms-input font-mono text-xs" value={poolCidr} onChange={e => setPoolCidr(e.target.value)} placeholder="10.0.1.200/29" />
          </div>
        </div>
        <p className="text-xs text-nms-text-dim mb-3">
          Some radios (confirmed with real Baicells hardware) request a virtual IP via IKEv2
          Configuration Payload instead of doing classic fixed-subnet IPsec — without a pool,
          their tunnel negotiates an IKE_SA but never completes a CHILD_SA. This pool only needs
          to be reachable from this host — it must <span className="text-nms-text font-medium">not</span> be
          advertised into EIGRP, unlike the Gateway IP above.
        </p>
        <button
          className="nms-btn-primary"
          disabled={!!busy || status?.installStatus !== 'complete' || (!frrAcknowledged && needsFrrAck)}
          onClick={handleConfigure}
        >
          {busy === 'configure' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
          {status?.configured ? 'Save Changes' : 'Configure'}
        </button>
        {status?.configured && (
          <p className="text-xs text-nms-text-dim mt-2">
            Configured {status.configuredAt ? new Date(status.configuredAt).toLocaleString() : ''} — gatewayFqdn: <span className="font-mono">{status.gatewayFqdn}</span>.{' '}
            {needsFrrAck
              ? "You're changing the Gateway IP — acknowledge the FRR route above before saving."
              : 'Editing the pool or other fields and clicking Save Changes re-applies the config and restarts the service, which briefly tears down any currently-connected tunnels.'}
          </p>
        )}
        {status?.configured && (
          <div className="mt-3 pt-3 border-t border-nms-border flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-nms-text-dim">
              {status.dnsRecordPresent ? (
                <span className="text-green-400">DNS record present — <span className="font-mono">{status.gatewayFqdn}</span> resolves to {status.gatewayIp}.</span>
              ) : status.bindZoneExists ? (
                <span className="text-amber-400">BIND is set up but the DNS record is missing or stale.</span>
              ) : (
                <span>BIND / the internal DNS zone isn't set up yet — install BIND9 and run the DNS/FQDN Migration Wizard, then add the record here.</span>
              )}
            </p>
            {!status.dnsRecordPresent && (
              <button onClick={handleAddDnsRecord} disabled={!!busy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
                {busy === 'dns-record' ? <RefreshCw className="w-3 h-3 animate-spin" /> : null} Add DNS Record
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Add Radio modal ────────────────────────────────────────────────────────────

function generateRandomPsk(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const randChar = (set: string): string => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];

// Nokia's own IPsec page rejects a plain hex PSK — confirmed live (2026-08-14) via the
// radio's own validation error: min 8/max 128 chars, >=2 digits, both upper and lower
// case, >=1 non-alphanumeric char, no space or quotation mark, and no two identical
// characters back-to-back. Ambiguous-looking chars (0/O, 1/l/I) are excluded so an
// operator copying this by eye onto the radio's own page doesn't mistranscribe it.
// Uses rejection sampling rather than constructing-then-patching a candidate — an earlier
// version tried to fix up shuffled duplicates in place, which could silently overwrite one
// of the two required digits and produce a PSK that still failed Nokia's own check.
function generateNokiaPsk(): string {
  const LOWER = 'abcdefghijkmnpqrstuvwxyz';
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const DIGITS = '23456789';
  const SPECIAL = '!@#$%^&*-_=+.,:;?~';
  const ALL = LOWER + UPPER + DIGITS + SPECIAL;

  for (let attempt = 0; attempt < 500; attempt++) {
    const candidate = Array.from({ length: 20 }, () => randChar(ALL)).join('');
    if (!nokiaPskError(candidate)) return candidate;
  }
  // Unreachable in practice — the charset mix converges within a handful of attempts —
  // but never hand back a PSK that wasn't actually validated.
  throw new Error("Failed to generate a PSK satisfying Nokia's complexity rule");
}

// Mirrors Nokia's own validation rule (see generateNokiaPsk's comment) so a manually-typed
// PSK gets caught here instead of only failing later when pasted into the radio's page.
function nokiaPskError(psk: string): string | null {
  if (psk.length < 8 || psk.length > 128) return 'PSK must be 8-128 characters';
  if (/[\s"']/.test(psk)) return 'PSK cannot contain spaces or quotation marks';
  if ((psk.match(/\d/g) ?? []).length < 2) return 'PSK needs at least 2 digits';
  if (!/[a-z]/.test(psk) || !/[A-Z]/.test(psk)) return 'PSK needs both upper and lower case letters';
  if (!/[^a-zA-Z0-9]/.test(psk)) return 'PSK needs at least one non-alphanumeric character';
  for (let i = 1; i < psk.length; i++) {
    if (psk[i] === psk[i - 1]) return 'PSK cannot have the same character twice in a row';
  }
  return null;
}

// Handles both "Add Radio" and "Edit Radio" — same fields either way, just a
// different submit target (POST vs PUT) and different initial values. Editing an
// existing radio pre-fills from it and always uses genieacs/manual mode based on
// which identifier the radio currently has set.
function RadioFormModal({ vendor, radio, onClose, onSaved }: { vendor: SecGwRadioVendor; radio?: SecGwRadio; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!radio;
  const effectiveVendor: SecGwRadioVendor = radio?.vendor ?? vendor;
  const isNokia = effectiveVendor === 'nokia';
  // Nokia radios aren't provisioned via GenieACS/TR-069 at all — always manual entry, no picker.
  const [mode, setMode] = useState<'genieacs' | 'manual'>(isNokia || radio?.manualIdentifier ? 'manual' : 'genieacs');
  const [name, setName] = useState(radio?.name ?? '');
  const [radioType, setRadioType] = useState<SecGwRadioType>(radio?.radioType ?? '4g');
  const [baicellsDevices, setBaicellsDevices] = useState<BaicellsRadio[]>([]);
  const [sercommDevices, setSercommDevices] = useState<SercommRadio[]>([]);
  const [genieacsDeviceId, setGenieacsDeviceId] = useState(radio?.genieacsDeviceId ?? '');
  const [manualIdentifier, setManualIdentifier] = useState(radio?.manualIdentifier ?? '');
  // Nokia is PSK-only (no cert path yet) — forced, no toggle shown.
  const [authMode, setAuthMode] = useState<SecGwAuthMode>(radio?.authMode ?? (isNokia ? 'psk' : 'cert'));
  const [psk, setPsk] = useState<string>(() => radio?.psk ?? (isNokia ? generateNokiaPsk() : generateRandomPsk()));
  const [ikeEncryption, setIkeEncryption] = useState<SecGwIkeEncryption>(radio?.ikeEncryption ?? 'aes256');
  const [ikeIntegrity, setIkeIntegrity] = useState<SecGwIkeIntegrity>(radio?.ikeIntegrity ?? 'sha256');
  const [ikeDhGroup, setIkeDhGroup] = useState<SecGwDhGroup>(radio?.ikeDhGroup ?? 'modp2048');
  const [espEncryption, setEspEncryption] = useState<SecGwEspEncryption>(radio?.espEncryption ?? 'aes256');
  const [espIntegrity, setEspIntegrity] = useState<SecGwEspIntegrity>(radio?.espIntegrity ?? 'sha256');
  const [espDhGroup, setEspDhGroup] = useState<SecGwDhGroup>(radio?.espDhGroup ?? 'modp2048');
  // ─── Nokia-only fields ───
  const [ikeSaMode, setIkeSaMode] = useState<SecGwIkeSaMode>(radio?.ikeSaMode ?? 'initiator_responder');
  const [ikeReauthEnabled, setIkeReauthEnabled] = useState(radio?.ikeReauthEnabled ?? false);
  const [pfsEnabled, setPfsEnabled] = useState(radio?.pfsEnabled ?? true);
  const [pfsDhGroup, setPfsDhGroup] = useState<SecGwDhGroup>(radio?.pfsDhGroup ?? 'modp2048');
  const [antiReplayEnabled, setAntiReplayEnabled] = useState(radio?.antiReplayEnabled ?? true);
  const [antiReplayWindowSize, setAntiReplayWindowSize] = useState(radio?.antiReplayWindowSize ?? 64);
  const [dpdDelaySeconds, setDpdDelaySeconds] = useState(radio?.dpdDelaySeconds ?? 30);
  const [ikeSaLifetimeSeconds, setIkeSaLifetimeSeconds] = useState(radio?.ikeSaLifetimeSeconds ?? 28800);
  const [childSaLifetimeSeconds, setChildSaLifetimeSeconds] = useState(radio?.childSaLifetimeSeconds ?? 3600);
  const [localIpAddress, setLocalIpAddress] = useState(radio?.localIpAddress ?? '');
  // Extra destinations reachable through this radio's tunnel beyond the core NF pair —
  // e.g. the BIND DNS server, for a radio whose own IPsec page can't do a plaintext
  // "Bypass" policy and needs it added as a real "Protect" traffic selector instead.
  const [extraLocalCidrs, setExtraLocalCidrs] = useState(radio?.extraLocalCidrs?.join(', ') ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNokia) return;
    genieacsApi.getDevices().then(setBaicellsDevices).catch(() => {});
    genieacsApi.getSercommDevices().then(setSercommDevices).catch(() => {});
  }, [isNokia]);

  const genieacsOptions = radioType === '5g' ? sercommDevices : baicellsDevices;

  const submit = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    if (mode === 'genieacs' && !genieacsDeviceId) { toast.error('Pick a device'); return; }
    if (mode === 'manual' && !manualIdentifier.trim()) { toast.error('Enter an identifier'); return; }
    if ((isNokia || authMode === 'psk') && !psk.trim()) { toast.error('Enter or generate a secret key'); return; }
    if (isNokia) {
      const pskErr = nokiaPskError(psk.trim());
      if (pskErr) { toast.error(pskErr); return; }
    }
    if (extraLocalCidrs.trim()) {
      const cidrRe = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/;
      for (const part of extraLocalCidrs.split(',').map(s => s.trim()).filter(Boolean)) {
        if (!cidrRe.test(part)) { toast.error(`"${part}" is not a valid IPv4 address or CIDR`); return; }
      }
    }
    setBusy(true);
    try {
      const input = {
        name: name.trim(),
        vendor: effectiveVendor,
        radioType,
        genieacsDeviceId: mode === 'genieacs' ? genieacsDeviceId : undefined,
        manualIdentifier: mode === 'manual' ? manualIdentifier.trim() : undefined,
        authMode: isNokia ? 'psk' as const : authMode,
        psk: (isNokia || authMode === 'psk') ? psk.trim() : undefined,
        ikeEncryption, ikeIntegrity, ikeDhGroup, espEncryption, espIntegrity, espDhGroup,
        extraLocalCidrs: extraLocalCidrs.trim() || undefined,
        ...(isNokia ? {
          ikeSaMode, ikeReauthEnabled, pfsEnabled,
          pfsDhGroup: pfsEnabled ? pfsDhGroup : undefined,
          antiReplayEnabled,
          antiReplayWindowSize: antiReplayEnabled ? antiReplayWindowSize : undefined,
          dpdDelaySeconds, ikeSaLifetimeSeconds, childSaLifetimeSeconds,
          localIpAddress: localIpAddress.trim() || undefined,
        } : {}),
      };
      const result = isEdit ? await secgwApi.updateRadio(radio!.id, input) : await secgwApi.addRadio(input);
      if (result.success) {
        toast.success(isEdit ? 'Radio updated — download the updated bundle' : 'Radio added — download its bundle from the list');
        onSaved();
        onClose();
      } else {
        toast.error(result.error ?? (isEdit ? 'Failed to update radio' : 'Failed to add radio'));
      }
    } catch (err) {
      toast.error(`${isEdit ? 'Update' : 'Add'} failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const ikeEncOptions = isNokia ? NOKIA_IKE_ENCRYPTION_OPTIONS : IKE_ENCRYPTION_OPTIONS;
  const ikeIntOptions = isNokia ? NOKIA_IKE_INTEGRITY_OPTIONS : IKE_INTEGRITY_OPTIONS;
  const ikeDhOptions = isNokia ? NOKIA_IKE_DH_GROUP_OPTIONS : IKE_DH_GROUP_OPTIONS;
  const espEncOptions = isNokia ? NOKIA_ESP_ENCRYPTION_OPTIONS : ESP_ENCRYPTION_OPTIONS;
  const espIntOptions = isNokia ? NOKIA_ESP_INTEGRITY_OPTIONS : ESP_INTEGRITY_OPTIONS;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-nms-border flex-shrink-0">
          <h2 className="text-base font-semibold text-nms-text">{isEdit ? `Edit Radio — ${radio!.name}` : `Add ${isNokia ? 'Nokia' : 'Baicells'} Radio`}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-nms-surface-2 text-nms-text-dim">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {isEdit && (
            <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Saving tears down this radio's current tunnel and marks it pending again — the radio must reconnect with the updated settings. Download the updated bundle afterward if any of the IPsec settings below changed.</span>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="nms-label">Name</label>
              <input className="nms-input" value={name} onChange={e => setName(e.target.value)} placeholder={isNokia ? 'e.g. Nokia AirScale #1' : 'e.g. Baicells eNB #1'} />
            </div>
            <div>
              <label className="nms-label">Radio Type</label>
              <select className="nms-input" value={radioType} onChange={e => setRadioType(e.target.value as SecGwRadioType)}>
                <option value="4g">4G (S1-MME + S1-U → MME / SGW-U)</option>
                <option value="5g">5G (N2 + N3 → AMF / UPF)</option>
              </select>
            </div>
          </div>

          {isNokia ? (
            <div>
              <label className="nms-label">Identifier (serial/MAC/note)</label>
              <input className="nms-input" value={manualIdentifier} onChange={e => setManualIdentifier(e.target.value)} placeholder="Nokia AirScale radios aren't seen by GenieACS — enter one manually" />
            </div>
          ) : (
            <>
              <div className="flex gap-1 border-b border-nms-border">
                {([['genieacs', 'Pick from GenieACS'], ['manual', 'Manual entry']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setMode(key)}
                    className={clsx(
                      'px-3 py-1.5 text-xs font-medium border-b-2 -mb-px',
                      mode === key ? 'border-nms-accent text-nms-accent' : 'border-transparent text-nms-text-dim hover:text-nms-text',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mode === 'genieacs' ? (
                <div>
                  <label className="nms-label">Device</label>
                  <select className="nms-input" value={genieacsDeviceId} onChange={e => setGenieacsDeviceId(e.target.value)}>
                    <option value="">Select a device...</option>
                    {genieacsOptions.map(d => (
                      <option key={d.id} value={d.id}>{d.serial} ({d.ip || 'no IP yet'})</option>
                    ))}
                  </select>
                  {genieacsOptions.length === 0 && (
                    <p className="text-xs text-nms-text-dim mt-1">No {radioType === '5g' ? 'Sercomm' : 'Baicells'} devices seen by GenieACS yet — use manual entry instead.</p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="nms-label">Identifier (serial/MAC/note)</label>
                  <input className="nms-input" value={manualIdentifier} onChange={e => setManualIdentifier(e.target.value)} placeholder="Not yet provisioned in GenieACS" />
                </div>
              )}
            </>
          )}

          {isNokia ? (
            <div className="text-xs text-nms-text-dim bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
              Nokia has no IKEv2 Configuration Payload support — its remote traffic selector is
              this radio's own real IP (Local IP Address above), not an auto-assigned virtual IP.
              See the Details panel after saving for the exact values to enter on the radio's own
              IPsec page (Local/Remote tunnel endpoint, Remote IP address).
            </div>
          ) : (
            <div className="text-xs text-nms-text-dim bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
              This gateway automatically assigns this radio a dedicated virtual IP from the pool
              CIDR (Setup tab) — no need to configure a traffic selector by hand. Each radio always
              gets its own unique address, so radios can never collide with each other.
              {isEdit && radio?.poolAddress && <> Currently assigned: <span className="font-mono text-nms-text">{radio.poolAddress}</span>.</>}
            </div>
          )}

          <div>
            <label className="nms-label">Additional Protected Destinations (optional)</label>
            <input
              className="nms-input font-mono text-xs"
              value={extraLocalCidrs}
              onChange={e => setExtraLocalCidrs(e.target.value)}
              placeholder="e.g. 10.0.1.180 (BIND DNS server)"
            />
            <p className="text-[10px] text-nms-text-dim mt-1">
              Comma-separated IPv4 addresses or CIDRs reachable through this radio's tunnel, on top
              of the core NFs above — e.g. the BIND DNS server, if the radio's own IPsec page can't
              do a plaintext "Bypass" policy and needs it added as a real "Protect" entry instead.
            </p>
          </div>

          <div className="pt-3 border-t border-nms-border">
            <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">IPsec Settings — match these on the radio's own IPsec page</p>

            <div className="grid grid-cols-2 gap-3 mb-3">
              {!isNokia && (
                <div>
                  <label className="nms-label">Left / Right Auth</label>
                  <select className="nms-input" value={authMode} onChange={e => setAuthMode(e.target.value as SecGwAuthMode)}>
                    <option value="cert">PubKey (Certificate)</option>
                    <option value="psk">PSK</option>
                  </select>
                </div>
              )}
              {(isNokia || authMode === 'psk') && (
                <div>
                  <label className="nms-label">Secret Key (PSK)</label>
                  <div className="flex gap-1.5">
                    <input className="nms-input font-mono text-xs" value={psk} onChange={e => setPsk(e.target.value)} />
                    <button type="button" onClick={() => setPsk(isNokia ? generateNokiaPsk() : generateRandomPsk())} className="nms-btn-ghost px-2 shrink-0" title="Generate random">
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {isNokia && (
                    <p className="text-[10px] text-nms-text-dim mt-1">
                      Nokia's own IPsec page requires: 8-128 chars, 2+ digits, both upper and lower
                      case, 1+ non-alphanumeric character, no spaces/quotes, no repeated character
                      twice in a row.
                    </p>
                  )}
                </div>
              )}
              {isNokia && (
                <div>
                  <label className="nms-label">Local IP Address (radio's U/M/C-Plane IP)</label>
                  <input className="nms-input font-mono text-xs" value={localIpAddress} onChange={e => setLocalIpAddress(e.target.value)} placeholder="10.0.2.xxx" />
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3 mb-3">
              <div>
                <label className="nms-label">IKE {isNokia ? 'encryption method' : 'Encryption'}</label>
                <select className="nms-input" value={ikeEncryption} onChange={e => setIkeEncryption(e.target.value as SecGwIkeEncryption)}>
                  {ikeEncOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="nms-label">IKE {isNokia ? 'Authentication method' : 'Auth'}</label>
                <select className="nms-input" value={ikeIntegrity} onChange={e => setIkeIntegrity(e.target.value as SecGwIkeIntegrity)}>
                  {ikeIntOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="nms-label">IKE DH Group</label>
                <select className="nms-input" value={ikeDhGroup} onChange={e => setIkeDhGroup(e.target.value as SecGwDhGroup)}>
                  {ikeDhOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="nms-label">ESP {isNokia ? 'encrytion method' : 'Encryption'}</label>
                <select className="nms-input" value={espEncryption} onChange={e => setEspEncryption(e.target.value as SecGwEspEncryption)}>
                  {espEncOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="nms-label">ESP {isNokia ? 'Authentication method' : 'Auth'}</label>
                <select className="nms-input" value={espIntegrity} onChange={e => setEspIntegrity(e.target.value as SecGwEspIntegrity)}>
                  {espIntOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {!isNokia && (
                <div>
                  <label className="nms-label">ESP DH Group</label>
                  <select className="nms-input" value={espDhGroup} onChange={e => setEspDhGroup(e.target.value as SecGwDhGroup)}>
                    {ESP_DH_GROUP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>

          {isNokia && (
            <div className="pt-3 border-t border-nms-border">
              <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">Nokia-specific IKE / SA settings</p>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="nms-label">IKE SA connection establishment mode</label>
                  <select className="nms-input" value={ikeSaMode} onChange={e => setIkeSaMode(e.target.value as SecGwIkeSaMode)}>
                    <option value="initiator_responder">Initiator and responder</option>
                    <option value="responder">Responder</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 mt-5 cursor-pointer">
                  <input type="checkbox" checked={ikeReauthEnabled} onChange={e => setIkeReauthEnabled(e.target.checked)} />
                  <span className="text-xs text-nms-text">IKE reauthentication enable</span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={pfsEnabled} onChange={e => setPfsEnabled(e.target.checked)} />
                  <span className="text-xs text-nms-text">IPsec perfect forward secrecy enable</span>
                </label>
                {pfsEnabled && (
                  <div>
                    <label className="nms-label">PFS DH Group</label>
                    <select className="nms-input" value={pfsDhGroup} onChange={e => setPfsDhGroup(e.target.value as SecGwDhGroup)}>
                      {NOKIA_PFS_DH_GROUP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={antiReplayEnabled} onChange={e => setAntiReplayEnabled(e.target.checked)} />
                  <span className="text-xs text-nms-text">Anti replay enable</span>
                </label>
                {antiReplayEnabled && (
                  <div>
                    <label className="nms-label">anti replay window size</label>
                    <select className="nms-input" value={antiReplayWindowSize} onChange={e => setAntiReplayWindowSize(Number(e.target.value))}>
                      <option value={64}>64</option>
                      <option value={28}>28</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="nms-label">dead peer detection delay (10-360s)</label>
                  <input type="number" min={10} max={360} className="nms-input" value={dpdDelaySeconds} onChange={e => setDpdDelaySeconds(Number(e.target.value))} />
                </div>
                <div>
                  <label className="nms-label">IKE association max lifetime (3600-86400s)</label>
                  <input type="number" min={3600} max={86400} className="nms-input" value={ikeSaLifetimeSeconds} onChange={e => setIkeSaLifetimeSeconds(Number(e.target.value))} />
                </div>
                <div>
                  <label className="nms-label">Security association max lifetime (300-86400s)</label>
                  <input type="number" min={300} max={86400} className="nms-input" value={childSaLifetimeSeconds} onChange={e => setChildSaLifetimeSeconds(Number(e.target.value))} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-nms-border flex-shrink-0">
          <button onClick={onClose} className="nms-btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="nms-btn-primary text-sm">
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <PlusCircle className="w-4 h-4" />}
            {isEdit ? 'Save Changes' : 'Add Radio'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Radios tab ─────────────────────────────────────────────────────────────────

function RadiosTab({ vendor, configured, gatewayFqdn, gatewayIp }: { vendor: SecGwRadioVendor; configured: boolean; gatewayFqdn: string | null; gatewayIp: string | null }) {
  const [allRadios, setAllRadios] = useState<SecGwRadio[]>([]);
  // 'add' | a radio being edited | null (closed) — one modal covers both, see RadioFormModal.
  const [formTarget, setFormTarget] = useState<'add' | SecGwRadio | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => { secgwApi.getRadios().then(r => setAllRadios(r.radios)).catch(() => {}); }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  const radios = allRadios.filter(r => r.vendor === vendor);

  const testTunnel = async (id: string) => {
    setBusyId(id);
    try {
      const r = await secgwApi.testTunnel(id);
      if (r.established) toast.success('Tunnel established');
      else toast.error('No established IKE/CHILD SA seen yet for this radio');
      load();
    } catch (err) {
      toast.error(`Test failed: ${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = async (id: string, currentlyEnabled: boolean) => {
    setBusyId(id);
    try {
      const r = currentlyEnabled ? await secgwApi.disableRadio(id) : await secgwApi.enableRadio(id);
      if (r.success) { toast.success(currentlyEnabled ? 'Radio disabled — tunnel torn down' : 'Radio enabled'); load(); }
      else toast.error(r.error ?? `Failed to ${currentlyEnabled ? 'disable' : 'enable'}`);
    } catch (err) {
      toast.error(`Failed to ${currentlyEnabled ? 'disable' : 'enable'}: ${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const rotateCredential = async (id: string) => {
    setBusyId(id);
    try {
      const r = await secgwApi.rotateCredential(id);
      if (r.success) { toast.success('Credential rotated — download the updated bundle'); load(); }
      else toast.error(r.error ?? 'Rotate failed');
    } catch (err) {
      toast.error(`Rotate failed: ${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (id: string, name: string) => {
    if (!confirm(`Revoke "${name}"? Its tunnel connection will be removed and its certificate marked revoked, but it stays listed for audit trail. Use Delete instead to remove it entirely.`)) return;
    setBusyId(id);
    try {
      const r = await secgwApi.removeRadio(id);
      if (r.success) { toast.success('Radio revoked'); load(); }
      else toast.error(r.error ?? 'Revoke failed');
    } catch (err) {
      toast.error(`Revoke failed: ${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const deletePermanently = async (id: string, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This removes it from the list entirely — including its certificate/PSK and its tunnel connection if still active. This cannot be undone.`)) return;
    setBusyId(id);
    try {
      const r = await secgwApi.deleteRadioPermanently(id);
      if (r.success) { toast.success('Radio deleted'); load(); }
      else toast.error(r.error ?? 'Delete failed');
    } catch (err) {
      toast.error(`Delete failed: ${String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  if (!configured) {
    return (
      <div className="nms-card text-center py-8">
        <p className="text-sm text-nms-text-dim">Configure the Security Gateway on the Setup tab before adding radios.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <button className="nms-btn-primary text-sm" onClick={() => setFormTarget('add')}>
          <PlusCircle className="w-4 h-4" /> Add {vendor === 'nokia' ? 'Nokia' : 'Baicells'} Radio
        </button>
      </div>

      <div className="nms-card overflow-x-auto">
        {radios.length === 0 ? (
          <p className="text-sm text-nms-text-dim text-center py-6">No {vendor === 'nokia' ? 'Nokia' : 'Baicells'} radios added yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-nms-text-dim border-b border-nms-border">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 font-medium">Auth</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Tunnel</th>
                <th className="pb-2 font-medium">Enabled</th>
                <th className="pb-2 font-medium">Cert Expires</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {radios.map(r => (
                <Fragment key={r.id}>
                  <tr className="border-b border-nms-border/50">
                    <td className="py-2 text-nms-text">{r.name}</td>
                    <td className="py-2 text-nms-text-dim uppercase">{r.radioType}</td>
                    <td className="py-2 text-nms-text-dim">{r.authMode === 'psk' ? 'PSK' : 'Cert'}</td>
                    <td className="py-2"><RadioStatusBadge status={r.status} /></td>
                    <td className="py-2"><TunnelStatusBadge active={!!r.tunnelActive} enabled={r.enabled} /></td>
                    <td className="py-2">
                      {r.status === 'revoked' ? (
                        <span className="text-nms-text-dim">—</span>
                      ) : (
                        <EnabledToggleBadge
                          enabled={r.enabled}
                          busy={busyId === r.id}
                          onToggle={() => toggleEnabled(r.id, r.enabled)}
                        />
                      )}
                    </td>
                    <td className="py-2 font-mono text-nms-text-dim">{r.certExpiresAt ? new Date(r.certExpiresAt).toLocaleDateString() : '—'}</td>
                    <td className="py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setExpandedId(id => id === r.id ? null : r.id)}
                          title="Right ID / Left ID / Subnets / PSK"
                          className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1"
                        >
                          <Info className="w-3 h-3" /> Details
                        </button>
                        {r.status !== 'revoked' && (
                          <>
                            <button
                              onClick={() => setFormTarget(r)}
                              disabled={busyId === r.id}
                              title="Edit"
                              className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1"
                            >
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                            <button
                              onClick={() => testTunnel(r.id)}
                              disabled={busyId === r.id}
                              title="Test Tunnel"
                              className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1"
                            >
                              <Zap className="w-3 h-3" /> Test
                            </button>
                            <a
                              href={secgwApi.downloadBundleUrl(r.id)}
                              title="Download Bundle"
                              className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1"
                            >
                              <Download className="w-3 h-3" /> Bundle
                            </a>
                            <button
                              onClick={() => rotateCredential(r.id)}
                              disabled={busyId === r.id}
                              title={r.authMode === 'psk' ? 'Generate a new PSK' : 'Reissue Certificate'}
                              className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1"
                            >
                              <RefreshCw className="w-3 h-3" /> Rotate
                            </button>
                            <button
                              onClick={() => revoke(r.id, r.name)}
                              disabled={busyId === r.id}
                              title="Revoke (soft — keeps a record for audit trail)"
                              className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1 text-amber-400"
                            >
                              <XCircle className="w-3 h-3" /> Revoke
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => deletePermanently(r.id, r.name)}
                          disabled={busyId === r.id}
                          title="Delete permanently — removes it from the list entirely"
                          className="nms-btn-ghost text-[11px] flex items-center gap-1 px-2 py-1 text-red-400"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === r.id && <RadioDetailsPanel radio={r} gatewayFqdn={gatewayFqdn} gatewayIp={gatewayIp} />}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {formTarget && (
        <RadioFormModal
          vendor={vendor}
          radio={formTarget === 'add' ? undefined : formTarget}
          onClose={() => setFormTarget(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

// ── Live Sessions tab ────────────────────────────────────────────────────────

function LiveSessionsTab({ enabled }: { enabled: boolean }) {
  const [sessions, setSessions] = useState<SecGwSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await secgwApi.getSessions();
      setSessions(r.sessions);
      setError(null);
    } catch {
      setError('Could not reach strongSwan — is the service running?');
    }
  }, [enabled]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // One radio (one parent IKE_SA) can carry MULTIPLE CHILD_SAs — e.g. a Nokia radio
  // using Additional Protected Destinations negotiates a separate CHILD_SA per
  // destination (MME, SGW-U, BIND, ...). Group rows by radio so the table shows one
  // parent SA row per radio with its CHILD_SAs indented underneath, instead of a flat
  // list where it's not obvious several rows belong to the same tunnel.
  const groups = useMemo(() => {
    const map = new Map<string, SecGwSession[]>();
    for (const s of sessions) {
      const key = s.radioId || s.connectionName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.values());
  }, [sessions]);
  const established = groups.filter(g => g[0]?.established).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: 'Tunnels Seen', value: groups.length },
          { label: 'Established', value: established },
          { label: 'Not Established', value: groups.length - established },
        ].map(({ label, value }) => (
          <div key={label} className="nms-card text-center">
            <p className="text-2xl font-semibold text-nms-text">{value}</p>
            <p className="text-xs text-nms-text-dim mt-1">{label}</p>
          </div>
        ))}
      </div>
      <div className="nms-card">
        <div className="flex items-center gap-2 mb-3">
          <RadioIcon className="w-4 h-4 text-nms-accent" />
          <h2 className="text-sm font-semibold text-nms-text">IKE / CHILD SAs</h2>
        </div>
        {error && <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> {error}</p>}
        {!error && sessions.length === 0 && <p className="text-xs text-nms-text-dim">No sessions.</p>}
        {sessions.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-nms-text-dim border-b border-nms-border">
                <th className="pb-2 font-medium">Radio / SA</th>
                <th className="pb-2 font-medium">Remote Addr</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 font-medium">Traffic Selectors</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group, gIdx) => {
                const parent = group[0];
                return (
                  <Fragment key={parent.radioId || gIdx}>
                    <tr className="border-b border-nms-border/50 bg-nms-bg/30">
                      <td className="py-1.5 text-nms-text font-semibold">{parent.radioName}</td>
                      <td className="py-1.5 font-mono text-nms-text-dim">{parent.remoteAddr ?? '—'}</td>
                      <td className="py-1.5">
                        <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-mono border',
                          parent.established ? 'text-green-400 bg-green-500/10 border-green-500/30' : 'text-amber-400 bg-amber-500/10 border-amber-500/30')}>
                          IKE {parent.ikeState}
                        </span>
                      </td>
                      <td className="py-1.5 text-nms-text-dim text-[11px]">
                        {group.length > 1 ? `${group.length} CHILD_SAs` : ''}
                      </td>
                    </tr>
                    {group.map((child, cIdx) => (
                      <tr key={cIdx} className="border-b border-nms-border/50">
                        <td className="py-1.5 pl-5 text-nms-text-dim">↳ CHILD_SA</td>
                        <td className="py-1.5"></td>
                        <td className="py-1.5 text-nms-text-dim">{child.childState ?? '—'}</td>
                        <td className="py-1.5 font-mono text-nms-text-dim text-[11px]">{child.localTs ?? '—'} ↔ {child.remoteTs ?? '—'}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Config Files tab ────────────────────────────────────────────────────────

function ConfigFilesTab() {
  const [files, setFiles] = useState<SecGwConfigFile[]>([]);
  const [selected, setSelected] = useState<SecGwConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { secgwApi.getConfigs().then(r => setFiles(r.configs)); }, []);

  const openFile = async (f: SecGwConfigFile) => {
    setSelected(f);
    const r = await secgwApi.getConfigContent(f.path);
    setContent(r.content ?? '');
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const r = await secgwApi.saveConfigContent(selected.path, content);
      if (r.success) toast.success('Saved and reloaded (swanctl --load-all)');
      else toast.error('Save failed');
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
            <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1.5">{g}</h3>
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
              <button className="nms-btn-primary" disabled={saving} onClick={save}>
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : null} Save & Reload
              </button>
            </div>
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
          <p className="text-sm text-nms-text-dim">Select a config file to view/edit.</p>
        )}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function SecGWPage() {
  const [status, setStatus] = useState<SecGwStatus | null>(null);
  const [tab, setTab] = useState<'setup' | 'baicells' | 'nokia' | 'sessions' | 'configs'>('setup');
  const [svcBusy, setSvcBusy] = useState<string | null>(null);

  const refresh = useCallback(() => { secgwApi.getStatus().then(setStatus).catch(() => {}); }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setSvcBusy(action);
    try {
      const fn = action === 'start' ? secgwApi.start : action === 'stop' ? secgwApi.stop : secgwApi.restart;
      const result = await fn();
      if (result.success) {
        toast.success(`${action[0].toUpperCase()}${action.slice(1)}ed`);
        refresh();
      } else {
        toast.error(result.error ?? `${action} failed`);
      }
    } catch (err) {
      toast.error(`${action} failed: ${String(err)}`);
    } finally {
      setSvcBusy(null);
    }
  };

  const TABS: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'setup',    label: 'Setup',         icon: <ShieldCheck className="w-4 h-4" /> },
    { id: 'baicells', label: 'Baicells',      icon: <RadioIcon className="w-4 h-4" /> },
    { id: 'nokia',    label: 'Nokia',         icon: <RadioIcon className="w-4 h-4" /> },
    { id: 'sessions', label: 'Live Sessions', icon: <Activity className="w-4 h-4" /> },
    { id: 'configs',  label: 'Config Files',  icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold font-display text-nms-text">Security Gateway (SecGW)</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">beta</span>
          </div>
          <p className="text-sm text-nms-text-dim mt-1">IPsec tunnel termination for radio backhaul (S1/N2/N3)</p>
        </div>

        {status?.installedOnDisk && (
          <div className="flex items-center gap-2 flex-wrap">
            <SvcBadge label="strongswan" active={!!status?.serviceActive} />
            {status && <SvcBadge label={`dummy-secgw ${status.dummyInterfaceUp ? 'up' : 'down'}`} active={status.dummyInterfaceUp} />}

            <div className="h-5 w-px bg-nms-border" />

            <button onClick={() => handleServiceAction('start')} disabled={!!svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Play className="w-3 h-3" /> Start
            </button>
            <button onClick={() => handleServiceAction('stop')} disabled={!!svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Square className="w-3 h-3" /> Stop
            </button>
            <button onClick={() => handleServiceAction('restart')} disabled={!!svcBusy} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <RotateCw className="w-3 h-3" /> Restart
            </button>
          </div>
        )}
      </div>

      <OverviewCard />

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {TABS.map(tabDef => (
            <button
              key={tabDef.id}
              onClick={() => setTab(tabDef.id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                tab === tabDef.id
                  ? 'bg-nms-accent text-white shadow-sm'
                  : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
              )}
            >
              {tabDef.icon}
              {tabDef.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'setup' && <SetupTab status={status} refresh={refresh} />}
      {tab === 'baicells' && <RadiosTab vendor="baicells" configured={!!status?.configured} gatewayFqdn={status?.gatewayFqdn ?? null} gatewayIp={status?.gatewayIp ?? null} />}
      {tab === 'nokia' && <RadiosTab vendor="nokia" configured={!!status?.configured} gatewayFqdn={status?.gatewayFqdn ?? null} gatewayIp={status?.gatewayIp ?? null} />}
      {tab === 'sessions' && <LiveSessionsTab enabled={!!status?.serviceActive} />}
      {tab === 'configs' && <ConfigFilesTab />}
    </div>
  );
}
