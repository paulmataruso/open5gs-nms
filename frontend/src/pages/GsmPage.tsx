import { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import {
  Play, Square, RotateCw, Terminal, Trash2, Plus, Settings, FileText, RadioTower, AlertTriangle, ShieldAlert,
  Pencil, Radar, CheckCircle, CheckCircle2, XCircle, Phone,
} from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  gsmApi, BTS_BAND_OPTIONS, BTS_BAND_ARFCN_RANGE,
  type GsmStatus, type BtsEntry, type BtsBackend, type GsmConfigFile, type DiscoveredRadio, type BtsLinkStatus,
} from '../api/gsm';

function LogTerminal({ lines }: { lines: string }) {
  return (
    <pre className="bg-nms-bg rounded p-3 text-xs font-mono text-green-300 max-h-64 overflow-y-auto whitespace-pre-wrap border border-nms-border mt-3">
      {lines}
    </pre>
  );
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

// The one place in this module where the stakes are regulatory, not just
// operational — 2G GSM bands are licensed almost everywhere, unlike the
// CBRS band this project's existing LTE/5G radios use. Real transmission
// (trx/remote hardware, not virtual) needs an explicit acknowledgment
// before this page lets you save it, mirroring this project's existing
// "never destructive-act on a radio without confirmation" convention —
// applied here to something with legal, not just operational, stakes.
function RfAuthorizationNotice() {
  return (
    <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        Real GSM transmission (an SDR or dedicated BTS hardware) requires real spectrum
        authorization or a shielded/lab RF setup in virtually every jurisdiction — unlike this
        project's CBRS-band LTE/5G radios. A <strong>virtual</strong> BTS has no RF at all and needs neither.
      </span>
    </div>
  );
}

function VirtualBtsControl({ btsEntries, refresh }: { btsEntries: BtsEntry[]; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const existing = btsEntries.find(e => e.backend === 'virtual');

  const deploy = async () => {
    setBusy(true);
    try {
      await gsmApi.addBts({
        name: 'Virtual BTS', backend: 'virtual', band: 'DCS1800', arfcn: 871,
        cellIdentity: 1, locationAreaCode: 1, baseStationIdCode: 63,
      });
      toast.success('Virtual BTS deployed');
      refresh();
    } catch (err: any) {
      toast.error(`Deploy failed: ${err?.response?.data?.error ?? err.message}`);
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!existing) return;
    setBusy(true);
    try {
      await gsmApi.removeBts(existing.id);
      toast.success('Virtual BTS removed');
      refresh();
    } catch (err: any) {
      toast.error(`Remove failed: ${err?.response?.data?.error ?? err.message}`);
    } finally { setBusy(false); }
  };

  return existing ? (
    <button onClick={remove} disabled={busy} className="nms-btn-ghost text-red-400 flex items-center gap-1.5 text-xs">
      <Trash2 className="w-3.5 h-3.5" /> {busy ? 'Removing…' : 'Remove Virtual BTS'}
    </button>
  ) : (
    <button onClick={deploy} disabled={busy} className="nms-btn-ghost flex items-center gap-1.5 text-xs">
      <Plus className="w-3.5 h-3.5" /> {busy ? 'Deploying…' : 'Deploy Virtual BTS'}
    </button>
  );
}

function SetupTab({ status, refresh, onNavigate }: { status: GsmStatus | null; refresh: () => void; onNavigate?: (tab: string) => void }) {
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [bscMgwBindIp, setBscMgwBindIp] = useState('127.0.0.1');
  const [mscMgwBindIp, setMscMgwBindIp] = useState('127.0.0.1');
  const [mgwRtpBindIp, setMgwRtpBindIp] = useState('127.0.0.1');
  const [configuring, setConfiguring] = useState(false);
  const [gprsEnabled, setGprsEnabled] = useState(false);
  const [gprsMode, setGprsMode] = useState<'gprs' | 'egprs'>('gprs');
  const [sgsnGtpLocalIp, setSgsnGtpLocalIp] = useState('127.0.0.1');
  const [sgsnGbRemoteIp, setSgsnGbRemoteIp] = useState('');
  const [ggsnGtpBindIp, setGgsnGtpBindIp] = useState('127.0.0.5');
  const [ggsnApn, setGgsnApn] = useState('gprs');
  const [ggsnTunDevice, setGgsnTunDevice] = useState('apn-gprs');
  const [ggsnPoolCidr, setGgsnPoolCidr] = useState('');
  const [ggsnDns1, setGgsnDns1] = useState('1.1.1.1');
  const [ggsnDns2, setGgsnDns2] = useState('9.9.9.9');
  const [gprsNat, setGprsNat] = useState(false);
  const [eigrpStatus, setEigrpStatus] = useState<string | null>(null);

  // Seed the form from server state ONCE, the first time status arrives —
  // NOT on every poll. The parent refetches /status every few seconds and
  // hands down a fresh object each time; re-seeding on every change wiped
  // whatever the operator was mid-way through typing (real bug: ticking the
  // GPRS checkbox reverted before they could fill in the fields and hit
  // Configure). After a successful Configure the local state already
  // matches what was submitted, and remounting the tab re-seeds anyway.
  const seeded = useRef(false);
  useEffect(() => {
    if (!status || seeded.current) return;
    seeded.current = true;
    setBscMgwBindIp(status.bscMgwBindIp || '127.0.0.1');
    setMscMgwBindIp(status.mscMgwBindIp || '127.0.0.1');
    setMgwRtpBindIp(status.mgwRtpBindIp || '127.0.0.1');
    setGprsEnabled(!!status.gprsEnabled);
    setGprsMode(status.gprsMode === 'egprs' ? 'egprs' : 'gprs');
    setSgsnGtpLocalIp(status.sgsnGtpLocalIp || '127.0.0.1');
    setSgsnGbRemoteIp(status.sgsnGbRemoteIp || '');
    setGgsnGtpBindIp(status.ggsnGtpBindIp || '127.0.0.5');
    setGgsnApn(status.ggsnApn || 'gprs');
    setGgsnTunDevice(status.ggsnTunDevice || 'apn-gprs');
    setGgsnPoolCidr(status.ggsnPoolCidr || '');
    setGgsnDns1(status.ggsnDns1 || '1.1.1.1');
    setGgsnDns2(status.ggsnDns2 || '9.9.9.9');
    setGprsNat(!!status.gprsNat);
  }, [status]);

  // One single action does everything — install (idempotent: a no-op apt-get
  // if packages are already present) then configure, in sequence. Real user
  // feedback (2026-09-10): a separate "Install" vs "Configure" split, with
  // GPRS/EDGE's own packages folded silently into the base Install step,
  // meant the GPRS card had nowhere obvious to trigger its own install from
  // — confusing, and easy to end up "configured" without ever having
  // actually installed the newer packages. Never split this again.
  const handleInstallAndConfigure = async () => {
    setInstalling(true);
    setInstallLog('');
    try {
      const res = await gsmApi.install();
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
      const r = await gsmApi.configure({
        bscMgwBindIp, mscMgwBindIp, mgwRtpBindIp,
        gprsEnabled, gprsMode, sgsnGtpLocalIp, sgsnGbRemoteIp, ggsnGtpBindIp, ggsnApn, ggsnTunDevice, ggsnPoolCidr, ggsnDns1, ggsnDns2, gprsNat,
      });
      setEigrpStatus(r.eigrpApplied);
      toast.success('Installed and configured — osmo-bsc/osmo-mgw (and GPRS/EDGE if enabled) are live.');
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
          Not installed yet — fill in the fields below (or leave the defaults) and hit Install &amp; Configure.
        </div>
      )}
      <div className="nms-card space-y-4">
        <div>
          <p className="text-sm font-semibold text-nms-text mb-1">MGW binding</p>
          <p className="text-xs text-nms-text-dim mb-3">
            osmo-bsc and osmo-msc each anchor their own leg of a call's RTP through osmo-mgw (real voice bearers) —
            separate endpoint domains keep them from colliding at the same MGW.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="nms-label">osmo-bsc / osmo-mgw bind IP</label>
              <input className="nms-input font-mono text-xs" value={bscMgwBindIp} onChange={e => setBscMgwBindIp(e.target.value)} placeholder="127.0.0.1" />
              <p className="text-[11px] text-nms-text-dim mt-1">osmo-mgw's own MGCP control-plane listen address, and where osmo-bsc's BTS entries dial for OML by default.</p>
            </div>
            <div>
              <label className="nms-label">osmo-mgw RTP bind IP</label>
              <input className="nms-input font-mono text-xs" value={mgwRtpBindIp} onChange={e => setMgwRtpBindIp(e.target.value)} placeholder="127.0.0.1" />
              <p className="text-[11px] text-nms-text-dim mt-1">Where actual call audio (RTP) binds — separate from MGCP control above, in case they should ever differ.</p>
            </div>
            <div>
              <label className="nms-label">osmo-msc's MGW peer IP</label>
              <input className="nms-input font-mono text-xs" value={mscMgwBindIp} onChange={e => setMscMgwBindIp(e.target.value)} placeholder="127.0.0.1" />
            </div>
          </div>
        </div>

        <div className="border-t border-nms-border pt-4">
          <p className="text-sm font-semibold text-nms-text mb-1">GPRS/EDGE (optional)</p>
          <label className="flex items-center gap-2 cursor-pointer mt-2">
            <input type="checkbox" checked={gprsEnabled} onChange={e => setGprsEnabled(e.target.checked)} className="w-4 h-4 accent-nms-accent shrink-0" />
            <span className="text-sm text-nms-text">Enable GPRS/EDGE packet data</span>
          </label>
          {gprsEnabled && (
            <>
              <div className="mt-3 max-w-xs">
                <label className="nms-label">Data service mode</label>
                <select value={gprsMode} onChange={e => setGprsMode(e.target.value as 'gprs' | 'egprs')} className="nms-input">
                  <option value="gprs">GPRS (GMSK only)</option>
                  <option value="egprs">EDGE / EGPRS (adds 8PSK MCS-5..9)</option>
                </select>
                <p className="text-[11px] text-nms-text-dim mt-1">
                  Applied to every packet-data BTS on Configure. An EDGE cell still serves GPRS-only handsets; a radio that can't do 8PSK just uses the GPRS coding schemes.
                </p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer mt-3">
                <input type="checkbox" checked={gprsNat} onChange={e => setGprsNat(e.target.checked)} className="w-4 h-4 accent-nms-accent shrink-0" />
                <span className="text-sm text-nms-text">Use NAT for the GPRS pool</span>
              </label>
              <p className="text-xs text-nms-text-dim mt-2">
                {gprsNat
                  ? `NAT mode — the pool is MASQUERADEd out on Configure, no routing/EIGRP needed. Just pick a UE subnet that does NOT overlap Open5GS's 4G/5G pool.`
                  : `Routed mode — the pool is auto-advertised via EIGRP on Configure (applied live with vtysh, no FRR restart). It must be a disjoint sub-block of an already-routed subnet. osmo-ggsn can't share Open5GS's live pool or hand out static IPs (confirmed against its source).`}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <div>
                  <label className="nms-label">SGSN GTP local IP</label>
                  <input className="nms-input font-mono text-xs" value={sgsnGtpLocalIp} onChange={e => setSgsnGtpLocalIp(e.target.value)} placeholder="127.0.0.1" />
                </div>
                <div>
                  <label className="nms-label">GGSN GTP bind IP</label>
                  <input className="nms-input font-mono text-xs" value={ggsnGtpBindIp} onChange={e => setGgsnGtpBindIp(e.target.value)} placeholder="127.0.0.5" />
                </div>
                <div className="md:col-span-2">
                  <label className="nms-label">SGSN Gb address (reachable from the BTS)</label>
                  <input className="nms-input font-mono text-xs" value={sgsnGbRemoteIp} onChange={e => setSgsnGbRemoteIp(e.target.value)} placeholder="auto — this host's IP on the RAN subnet" />
                  <p className="text-[11px] text-nms-text-dim mt-1">The IP a real nanoBTS's PCU dials for the Gb/NS link. Leave blank to auto-derive this host's address on the radio's subnet. <span className="text-amber-400">127.0.0.1 only works for a local virtual BTS</span> — a remote radio needs a real routable IP or GPRS never attaches.</p>
                </div>
                <div>
                  <label className="nms-label">APN name</label>
                  <input className="nms-input text-xs" value={ggsnApn} onChange={e => setGgsnApn(e.target.value)} placeholder="gprs" />
                  <p className="text-[11px] text-nms-text-dim mt-1">Must match the APN configured on the phone — see the reference doc's own "APN for Data Service" note.</p>
                </div>
                <div>
                  <label className="nms-label">Tun device name</label>
                  <input className="nms-input font-mono text-xs" value={ggsnTunDevice} onChange={e => setGgsnTunDevice(e.target.value)} placeholder="apn-gprs" />
                </div>
                <div className="md:col-span-2">
                  <label className="nms-label">GGSN IP pool (CIDR){gprsNat ? ' — any private subnet not overlapping Open5GS' : ' — disjoint sub-block of a routed subnet'}</label>
                  <input className="nms-input font-mono text-xs" value={ggsnPoolCidr} onChange={e => setGgsnPoolCidr(e.target.value)} placeholder={gprsNat ? '10.200.0.0/24' : '10.45.0.128/25'} />
                </div>
                <div>
                  <label className="nms-label">DNS 1</label>
                  <input className="nms-input font-mono text-xs" value={ggsnDns1} onChange={e => setGgsnDns1(e.target.value)} placeholder="1.1.1.1" />
                </div>
                <div>
                  <label className="nms-label">DNS 2</label>
                  <input className="nms-input font-mono text-xs" value={ggsnDns2} onChange={e => setGgsnDns2(e.target.value)} placeholder="9.9.9.9" />
                </div>
              </div>
            </>
          )}
          {eigrpStatus ? (
            <p className="text-xs text-nms-text-dim flex items-center gap-1.5 mt-3">
              <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
              {eigrpStatus} — applied live via vtysh (no FRR restart) and written to frr.conf.
            </p>
          ) : status?.appliedGprsEigrpCidr ? (
            <p className="text-xs text-nms-text-dim flex items-center gap-1.5 mt-3">
              <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
              GGSN pool <span className="font-mono text-nms-text">{status.appliedGprsEigrpCidr}</span> is advertised via EIGRP (<span className="font-mono">router eigrp 1</span> network statement, live in frr.conf).
            </p>
          ) : status?.appliedGprsNatCidr ? (
            <p className="text-xs text-nms-text-dim flex items-center gap-1.5 mt-3">
              <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
              GGSN pool <span className="font-mono text-nms-text">{status.appliedGprsNatCidr}</span> is NAT&#39;d out (iptables MASQUERADE) — not advertised via EIGRP.
            </p>
          ) : null}
        </div>

        <button
          onClick={handleInstallAndConfigure}
          disabled={installing || configuring}
          className="nms-btn-primary flex items-center gap-2 text-sm"
        >
          <Terminal className="w-4 h-4" />
          {installing ? 'Installing…' : configuring ? 'Configuring…' : 'Install & Configure'}
        </button>
        {installLog && <LogTerminal lines={installLog} />}
        {status.configured && !installing && !configuring && (
          <p className="text-xs text-nms-text-dim flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
            {status.btsEntries.length === 0
              ? 'Configured — no BTS attached yet, add one on the BTS / Radios tab.'
              : `Configured — ${status.btsEntries.length} BTS entr${status.btsEntries.length === 1 ? 'y' : 'ies'} configured.`}
          </p>
        )}

        {status.installedOnDisk && (
          <div className="border-t border-nms-border pt-4">
            <p className="text-sm font-semibold text-nms-text mb-1">Virtual BTS</p>
            <p className="text-xs text-nms-text-dim mb-2">
              A software-only BTS (no RF) for protocol testing — attach/LU/SMS/call flows end to end with no radio. Off by default.
            </p>
            <VirtualBtsControl btsEntries={status.btsEntries} refresh={refresh} />
          </div>
        )}
      </div>

      {status.sgsShared && (
        <div className="nms-card space-y-2">
          <p className="text-sm font-semibold text-nms-text">Shared with SMS over SGs</p>
          <p className="text-xs text-nms-text-dim">
            osmo-hlr and osmo-msc are the same processes SMS-over-SGs already runs — their own IPs are owned and
            edited on the SMS page, shown here read-only so the whole stack is visible in one place.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="nms-label">osmo-hlr GSUP bind IP</label>
              <input className="nms-input font-mono text-xs" value={status.sgsShared.hlrBindIp} disabled />
            </div>
            <div>
              <label className="nms-label">osmo-msc SGs bind IP</label>
              <input className="nms-input font-mono text-xs" value={status.sgsShared.mscBindIp} disabled />
            </div>
          </div>
          {onNavigate && (
            <button type="button" onClick={() => onNavigate('sms')} className="text-xs text-nms-accent hover:underline">
              Manage on the SMS page →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Polls link-status every 4s for up to ~80s after a real-hardware BTS is
// saved — mirrors exactly how this module's own real nanoBTS bring-up was
// watched live (see memory: gsm_2g_osmocom_module_progress): don't alarm on
// early disconnect/retry cycles, real hardware often takes 3-4 OML
// connect/drop attempts and ~45-60s before it converges on a healthy state.
function BringUpStatusPanel({ btsId, onDone }: { btsId: string; onDone: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<BtsLinkStatus | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const MAX_ATTEMPTS = 20;

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      if (cancelled) return;
      tries += 1;
      setAttempt(tries);
      try {
        const s = await gsmApi.getBtsLinkStatus(btsId);
        if (cancelled) return;
        setStatus(s);
        if (s.omlConnected && s.rslConnected) return; // converged — stop polling
      } catch { /* keep trying */ }
      if (tries >= MAX_ATTEMPTS) { setTimedOut(true); return; }
      setTimeout(poll, 4000);
    };
    poll();
    return () => { cancelled = true; };
  }, [btsId]);

  const healthy = status?.omlConnected && status?.rslConnected;

  return (
    <div className="space-y-3">
      <div className={clsx('flex items-center gap-2 text-sm', healthy ? 'text-green-400' : timedOut ? 'text-red-400' : 'text-nms-text')}>
        {healthy ? <CheckCircle2 className="w-4 h-4" /> : timedOut ? <XCircle className="w-4 h-4" /> : <RotateCw className="w-4 h-4 animate-spin" />}
        {healthy ? 'On-air — OML and RSL both connected.'
          : timedOut ? 'Timed out waiting for the radio to connect.'
          : `Waiting for the radio to reboot and connect… (check ${attempt}/${MAX_ATTEMPTS})`}
      </div>
      {status && (
        <div className="bg-nms-bg border border-nms-border rounded-lg p-3 text-xs font-mono space-y-1 text-nms-text-dim">
          <div>Admin: <span className="text-nms-text">{status.adminState}</span> · Oper: <span className="text-nms-text">{status.operState}</span> · Avail: <span className="text-nms-text">{status.availState}</span></div>
          <div>OML: <span className={status.omlConnected ? 'text-green-400' : 'text-nms-text-dim'}>{status.omlConnected ? 'connected' : 'not connected'}</span> · RSL: <span className={status.rslConnected ? 'text-green-400' : 'text-nms-text-dim'}>{status.rslConnected ? 'connected' : 'not connected'}</span></div>
        </div>
      )}
      {timedOut && !healthy && (
        <p className="text-xs text-nms-text-dim">
          The BTS entry is saved either way — this just means it hasn't come on-air yet. Real hardware can take longer than expected
          to reboot; check the Config Files tab's osmo-bsc.cfg or try again from this list.
        </p>
      )}
      <button onClick={onDone} className="nms-btn-primary text-sm w-full py-2">
        {healthy || timedOut ? 'Done' : 'Close (keeps watching in the background)'}
      </button>
    </div>
  );
}

function AddBtsModal({ onClose, onAdded, defaultOmlIp, existing, prefill }: {
  onClose: () => void; onAdded: () => void; defaultOmlIp: string;
  existing?: BtsEntry;
  prefill?: DiscoveredRadio;
}) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? (prefill ? (prefill.unitName || 'BTS 1') : 'BTS 1'));
  const [backend, setBackend] = useState<BtsBackend>(existing?.backend ?? (prefill ? 'remote-abis-ip' : 'virtual'));
  const [band, setBand] = useState(existing?.band ?? 'DCS1800');
  const [arfcn, setArfcn] = useState(String(existing?.arfcn ?? BTS_BAND_ARFCN_RANGE[existing?.band ?? 'DCS1800'].default));
  const arfcnRange = BTS_BAND_ARFCN_RANGE[band];
  const arfcnOutOfRange = arfcnRange && (Number(arfcn) < arfcnRange.min || Number(arfcn) > arfcnRange.max);
  const [cellIdentity, setCellIdentity] = useState(String(existing?.cellIdentity ?? '1'));
  const [locationAreaCode, setLocationAreaCode] = useState(String(existing?.locationAreaCode ?? '1'));
  const [baseStationIdCode, setBaseStationIdCode] = useState(String(existing?.baseStationIdCode ?? '63'));
  const [remoteIp, setRemoteIp] = useState(existing?.remoteIp ?? prefill?.ipAddress ?? '');
  const [unitId, setUnitId] = useState(existing ? String(existing.unitId) : (prefill?.unitId ? String(parseInt(prefill.unitId.split('/')[0], 10) || '') : ''));
  const [omlRemoteIp, setOmlRemoteIp] = useState(existing?.omlRemoteIp ?? defaultOmlIp);
  const [lteEarfcns, setLteEarfcns] = useState((existing?.lteEarfcns ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [ackRf, setAckRf] = useState(false);
  const [savedBtsId, setSavedBtsId] = useState<string | null>(null);

  const needsRfAck = backend !== 'virtual';
  const canSave = name.trim().length > 0 && (!needsRfAck || ackRf) && !arfcnOutOfRange;

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        name: name.trim(), backend, band,
        arfcn: Number(arfcn), cellIdentity: Number(cellIdentity),
        locationAreaCode: Number(locationAreaCode), baseStationIdCode: Number(baseStationIdCode),
        remoteIp: backend === 'remote-abis-ip' ? remoteIp : undefined,
        omlRemoteIp: backend !== 'remote-abis-ip' ? omlRemoteIp : undefined,
        unitId: unitId !== '' ? Number(unitId) : undefined,
        lteEarfcns: lteEarfcns.split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 65535),
      };
      const result = isEdit ? await gsmApi.updateBts(existing!.id, payload) : await gsmApi.addBts(payload);
      onAdded();
      if (result.provisionWarning) {
        toast.error(result.provisionWarning, { duration: 8000 });
      } else {
        toast.success(isEdit ? `${name} updated` : `${name} added`);
      }
      // Real hardware: drop into a live bring-up status view instead of
      // just closing — this is the "one click configure, then watch it
      // work" flow, not "click and hope."
      if (backend === 'remote-abis-ip' && remoteIp && !result.provisionWarning) {
        setSavedBtsId(result.bts.id);
      } else {
        onClose();
      }
    } catch (err: any) {
      toast.error(`${isEdit ? 'Update' : 'Add'} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (savedBtsId) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="bg-nms-surface border border-nms-border rounded-xl w-full max-w-lg max-h-[90vh] shadow-2xl flex flex-col">
          <div className="px-6 py-4 border-b border-nms-border flex-shrink-0">
            <h2 className="text-base font-semibold text-nms-text">{name} — bringing up</h2>
          </div>
          <div className="p-6 overflow-y-auto">
            <BringUpStatusPanel btsId={savedBtsId} onDone={onClose} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-nms-surface border border-nms-border rounded-xl w-full max-w-lg max-h-[90vh] shadow-2xl flex flex-col">
        <div className="px-6 py-4 border-b border-nms-border flex-shrink-0">
          <h2 className="text-base font-semibold text-nms-text">
            {isEdit ? `Edit ${existing!.name}` : prefill ? `Configure ${prefill.unitName || 'Discovered Radio'}` : 'Add BTS'}
          </h2>
          {prefill && !isEdit && (
            <p className="text-xs text-nms-text-dim mt-1">
              Found at {prefill.ipAddress} (MAC {prefill.macAddress}, unit-id {prefill.unitId}, {prefill.location2 || 'unknown model'}).
              Fields below are pre-filled — adjust anything, then Configure to repoint and bring it up.
            </p>
          )}
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <label className="nms-label">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className="nms-input" />
          </div>
          <div className="md:col-span-2">
            <label className="nms-label">Backend</label>
            <select
              value={backend}
              onChange={e => setBackend(e.target.value as BtsBackend)}
              disabled={isEdit || !!prefill}
              className="nms-input disabled:opacity-60"
            >
              <option value="virtual">Virtual (no RF — protocol testing only)</option>
              <option value="trx">SDR (osmo-trx) — real RF</option>
              <option value="remote-abis-ip">Dedicated BTS hardware (real RF, own embedded unit)</option>
            </select>
            {(isEdit || !!prefill) && <p className="text-[11px] text-nms-text-dim mt-1">Backend type can't be changed after creation — remove and re-add to switch.</p>}
          </div>
          <div>
            <label className="nms-label">Band</label>
            <select
              value={band}
              onChange={e => { setBand(e.target.value); setArfcn(String(BTS_BAND_ARFCN_RANGE[e.target.value]?.default ?? arfcn)); }}
              className="nms-input"
            >
              {BTS_BAND_OPTIONS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className="nms-label">ARFCN</label>
            <input type="number" value={arfcn} onChange={e => setArfcn(e.target.value)} className={clsx('nms-input font-mono text-xs', arfcnOutOfRange && 'border-red-500')} />
            {arfcnRange && (
              <p className={clsx('text-[11px] mt-1', arfcnOutOfRange ? 'text-red-400' : 'text-nms-text-dim')}>
                {band} valid range: {arfcnRange.min}–{arfcnRange.max}
                {arfcnOutOfRange && ' — out of range for this band'}
              </p>
            )}
          </div>
          <div>
            <label className="nms-label">Cell Identity</label>
            <input type="number" value={cellIdentity} onChange={e => setCellIdentity(e.target.value)} className="nms-input font-mono text-xs" />
          </div>
          <div>
            <label className="nms-label">Location Area Code</label>
            <input type="number" value={locationAreaCode} onChange={e => setLocationAreaCode(e.target.value)} className="nms-input font-mono text-xs" />
          </div>
          <div>
            <label className="nms-label">Base Station ID Code</label>
            <input type="number" value={baseStationIdCode} onChange={e => setBaseStationIdCode(e.target.value)} className="nms-input font-mono text-xs" />
          </div>
          <div className="md:col-span-2">
            <label className="nms-label">LTE neighbour EARFCNs</label>
            <input value={lteEarfcns} onChange={e => setLteEarfcns(e.target.value)} placeholder="e.g. 1850, 900" className="nms-input font-mono text-xs" />
            <p className="text-[11px] text-nms-text-dim mt-1">
              Comma-separated LTE EARFCNs this cell broadcasts in SI2quater — lets a phone reselect back to LTE after a CSFB call. Leave blank if not using CSFB.
            </p>
          </div>
          {backend === 'remote-abis-ip' ? (
            <>
              <div>
                <label className="nms-label">Unit IP</label>
                <input value={remoteIp} onChange={e => setRemoteIp(e.target.value)} placeholder="10.0.x.x" className="nms-input font-mono text-xs" />
                <p className="text-[11px] text-nms-text-dim mt-1">
                  The radio's current, reachable IP — used once to repoint its OML target at this host
                  (<code className="font-mono">ipaccess-config -o … -r …</code>) and restart it. Not written into osmo-bsc.cfg itself
                  (Abis/IP units dial in and are matched by unit ID, not source IP), so it's safe to leave stale after the radio's own IP changes.
                </p>
              </div>
              <div>
                <label className="nms-label">Unit ID <span className="text-nms-text-dim font-normal">(leave blank to auto-assign)</span></label>
                <input type="number" value={unitId} onChange={e => setUnitId(e.target.value)} placeholder="e.g. 1 — read via ipaccess-config -G" className="nms-input font-mono text-xs" />
                <p className="text-[11px] text-nms-text-dim mt-1">Real hardware usually already has one burned in — use its existing value rather than reconfigure the unit.</p>
              </div>
            </>
          ) : (
            <div>
              <label className="nms-label">OML target IP (osmo-bsc's address)</label>
              <input value={omlRemoteIp} onChange={e => setOmlRemoteIp(e.target.value)} placeholder="127.0.0.1" className="nms-input font-mono text-xs" />
              <p className="text-[11px] text-nms-text-dim mt-1">Which IP this local osmo-bts process dials to reach osmo-bsc's OML listener — defaults to the Setup tab's bind IP.</p>
            </div>
          )}
        </div>
        {needsRfAck && (
          <>
            <RfAuthorizationNotice />
            <label className="flex items-start gap-2 text-xs text-nms-text">
              <input type="checkbox" checked={ackRf} onChange={e => setAckRf(e.target.checked)} className="nms-checkbox mt-0.5" />
              I confirm I have spectrum authorization or a shielded/lab RF setup for this BTS.
            </label>
          </>
        )}
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-nms-border flex-shrink-0">
          <button onClick={onClose} className="flex-1 nms-btn-ghost text-sm py-2">Cancel</button>
          <button onClick={handleSave} disabled={saving || !canSave} className="flex-1 nms-btn-primary text-sm py-2 disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : backend === 'remote-abis-ip' ? 'Configure' : 'Add BTS'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Sends a real unicast discovery probe to every host in the given CIDR —
// works across any routed L3 path (whatever this host's own routing table
// can reach), not just a locally-attached subnet. Real bug found live
// (2026-09-09): the first version of this asked for a "bind IP" (which
// interface to broadcast from), which the user correctly pointed out can
// never reach a remote, routed subnet at all — broadcasts don't cross
// routers. A CIDR the user can route to, local or remote, is exactly what's
// needed instead; this makes no assumption about local attachment.
function DiscoverRadiosModal({ onClose, onUseRadio, defaultCidr }: {
  onClose: () => void; onUseRadio: (radio: DiscoveredRadio) => void; defaultCidr: string;
}) {
  const [cidr, setCidr] = useState(defaultCidr);
  const [scanning, setScanning] = useState(false);
  const [radios, setRadios] = useState<DiscoveredRadio[] | null>(null);

  const scan = async () => {
    setScanning(true);
    setRadios(null);
    try {
      const r = await gsmApi.discover({ cidr, timeoutSeconds: 5 });
      setRadios(r.radios);
    } catch (err: any) {
      toast.error(`Scan failed: ${err?.response?.data?.error ?? err.message}`);
      setRadios([]);
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-2xl w-full mx-4 shadow-2xl space-y-4">
        <h2 className="text-base font-semibold text-nms-text flex items-center gap-2"><Radar className="w-4 h-4" /> Scan for Radios</h2>
        <p className="text-xs text-nms-text-dim -mt-2">
          Sends a real discovery query to every address in this subnet and lists every ip.access-compatible unit that answers — works
          even if a radio's OML target still points somewhere else. Any subnet this host can route to works, local or remote —
          you're responsible for that route existing.
        </p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="nms-label">Subnet to scan (CIDR)</label>
            <input value={cidr} onChange={e => setCidr(e.target.value)} className="nms-input font-mono text-xs" placeholder="172.16.0.0/24" />
          </div>
          <button onClick={scan} disabled={scanning || !cidr} className="nms-btn-primary flex items-center gap-1.5 text-sm px-4 py-2 shrink-0">
            {scanning ? <RotateCw className="w-4 h-4 animate-spin" /> : <Radar className="w-4 h-4" />} {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {radios && (
          radios.length === 0 ? (
            <p className="text-sm text-nms-text-dim py-6 text-center">No radios answered on this subnet.</p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {radios.map(r => (
                <div key={r.macAddress || r.ipAddress} className="flex items-center justify-between gap-2 bg-nms-bg border border-nms-border rounded-lg px-3 py-2">
                  <div className="text-xs">
                    <span className="text-nms-text font-medium">{r.unitName || r.ipAddress}</span>
                    <span className="text-nms-text-dim ml-2 font-mono">{r.ipAddress} · MAC {r.macAddress} · unit-id {r.unitId}</span>
                    <div className="text-nms-text-dim mt-0.5">{r.location2 || 'unknown model'} · fw {r.softwareVersion || '—'} · S/N {r.serialNumber || '—'}</div>
                  </div>
                  <button onClick={() => onUseRadio(r)} className="nms-btn-ghost flex items-center gap-1 text-[11px] px-2 py-1 shrink-0">
                    Use This Radio →
                  </button>
                </div>
              ))}
            </div>
          )
        )}
        <button onClick={onClose} className="w-full nms-btn-ghost text-sm py-2">Close</button>
      </div>
    </div>
  );
}

// Polled independently per row (not the whole tab) so one slow/unreachable
// entry's VTY query doesn't hold up the others — same self-contained
// polling pattern as e.g. TwampPage's ServerConnectionsTable.
function BtsStatusBadge({ btsId }: { btsId: string }) {
  const [status, setStatus] = useState<BtsLinkStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => gsmApi.getBtsLinkStatus(btsId).then(s => { if (!cancelled) setStatus(s); }).catch(() => {});
    poll();
    const t = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, [btsId]);

  if (!status) return <span className="text-[10px] text-nms-text-dim">checking…</span>;
  const onAir = status.omlConnected && status.rslConnected;
  const label = onAir ? 'on-air' : status.omlConnected ? 'connecting' : 'offline';
  return (
    <span
      className={clsx('text-[10px] px-1.5 py-0.5 rounded-full border font-mono shrink-0 flex items-center gap-1 w-fit',
        onAir ? 'text-green-400 border-green-500/30 bg-green-500/10' : 'text-nms-text-dim border-nms-border bg-nms-surface-2')}
      title={`Admin ${status.adminState} · Oper ${status.operState} · Avail ${status.availState}`}
    >
      <span className={clsx('w-1.5 h-1.5 rounded-full', onAir ? 'bg-green-400 animate-pulse' : status.omlConnected ? 'bg-amber-400' : 'bg-nms-text-dim')} />
      {label}
    </span>
  );
}

function BtsTab({ btsEntries, refresh, defaultOmlIp }: { btsEntries: BtsEntry[]; refresh: () => void; defaultOmlIp: string }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [prefillRadio, setPrefillRadio] = useState<DiscoveredRadio | null>(null);
  const [editing, setEditing] = useState<BtsEntry | null>(null);

  const handleRemove = async (e: BtsEntry) => {
    if (!window.confirm(`Remove "${e.name}"? This cannot be undone.`)) return;
    try {
      await gsmApi.removeBts(e.id);
      toast.success('Removed');
      refresh();
    } catch (err: any) {
      toast.error(`Failed to remove: ${err?.response?.data?.error ?? err.message}`);
    }
  };

  const handleReprovision = async (e: BtsEntry) => {
    try {
      await gsmApi.provisionBts(e.id);
      toast.success(`Repointed ${e.name} — watch the status badge for bring-up`);
    } catch (err: any) {
      toast.error(`Reprovision failed: ${err?.response?.data?.error ?? err.message}`);
    }
  };

  const handleRestart = async (e: BtsEntry) => {
    try {
      await gsmApi.restartBts(e.id);
      toast.success(`Restarting ${e.name} — back on air in ~60-90s`);
    } catch (err: any) {
      toast.error(`Restart failed: ${err?.response?.data?.error ?? err.message}`);
    }
  };

  const backendLabel = (b: BtsBackend) =>
    b === 'virtual' ? 'Virtual (no RF)' : b === 'trx' ? 'SDR (osmo-trx)' : 'Dedicated hardware';

  return (
    <div className="space-y-4">
      {showAdd && <AddBtsModal onClose={() => setShowAdd(false)} onAdded={refresh} defaultOmlIp={defaultOmlIp} />}
      {showDiscover && (
        <DiscoverRadiosModal
          onClose={() => setShowDiscover(false)}
          defaultCidr={`${defaultOmlIp.split('.').slice(0, 3).join('.')}.0/24`}
          onUseRadio={radio => { setShowDiscover(false); setPrefillRadio(radio); }}
        />
      )}
      {prefillRadio && (
        <AddBtsModal onClose={() => setPrefillRadio(null)} onAdded={refresh} defaultOmlIp={defaultOmlIp} prefill={prefillRadio} />
      )}
      {editing && (
        <AddBtsModal onClose={() => setEditing(null)} onAdded={refresh} defaultOmlIp={defaultOmlIp} existing={editing} />
      )}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-nms-text-dim">
          Every entry here is a `bts N` stanza in osmo-bsc.cfg — virtual, SDR, and dedicated-hardware BTS units all show up in the same list.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowDiscover(true)} className="nms-btn-ghost flex items-center gap-1.5 text-xs">
            <Radar className="w-3.5 h-3.5" /> Scan for Radios
          </button>
          <button onClick={() => setShowAdd(true)} className="nms-btn-primary text-sm">
            <Plus className="w-3.5 h-3.5" /> Add Manually
          </button>
        </div>
      </div>
      <div className="nms-card overflow-x-auto">
        {btsEntries.length === 0 ? (
          <div className="text-center py-10">
            <RadioTower className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
            <p className="text-sm text-nms-text-dim">No BTS configured yet.</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-nms-text-dim border-b border-nms-border">
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Backend</th>
                <th className="pb-2 font-medium">Band / ARFCN</th>
                <th className="pb-2 font-medium">Unit ID / LAC</th>
                <th className="pb-2 font-medium">Remote IP</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {btsEntries.map(e => (
                <tr key={e.id} className="border-b border-nms-border/50 last:border-0">
                  <td className="py-2"><BtsStatusBadge btsId={e.id} /></td>
                  <td className="py-2 text-nms-text font-medium whitespace-nowrap">{e.name}</td>
                  <td className="py-2 text-nms-text-dim whitespace-nowrap">{backendLabel(e.backend)}</td>
                  <td className="py-2 text-nms-text-dim font-mono whitespace-nowrap">{e.band} / {e.arfcn}</td>
                  <td className="py-2 text-nms-text-dim font-mono whitespace-nowrap">{e.unitId} / {e.locationAreaCode}</td>
                  <td className="py-2 text-nms-text-dim font-mono whitespace-nowrap">{e.remoteIp || '—'}</td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                      {e.backend === 'remote-abis-ip' && e.remoteIp && (
                        <>
                          <button onClick={() => handleRestart(e)} className="nms-btn-ghost flex items-center gap-1 text-[11px] px-2 py-1" title="Reboot the radio in place (ipaccess-config -r)">
                            <RotateCw className="w-3 h-3" /> Restart
                          </button>
                          <button onClick={() => handleReprovision(e)} className="nms-btn-ghost flex items-center gap-1 text-[11px] px-2 py-1" title="Re-run the OML repoint against this radio's IP">
                            <RotateCw className="w-3 h-3" /> Reprovision
                          </button>
                        </>
                      )}
                      <button onClick={() => setEditing(e)} className="nms-btn-ghost flex items-center gap-1 text-[11px] px-2 py-1">
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      <button onClick={() => handleRemove(e)} className="nms-btn-ghost flex items-center gap-1 text-[11px] px-2 py-1 text-red-400">
                        <Trash2 className="w-3 h-3" /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ConfigFilesTab() {
  const [files, setFiles] = useState<GsmConfigFile[]>([]);
  const [selected, setSelected] = useState<GsmConfigFile | null>(null);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    gsmApi.getConfigs().then(r => setFiles(r.files)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const openFile = async (f: GsmConfigFile) => {
    setSelected(f);
    const r = await gsmApi.getConfigContent(f.path);
    setContent(r.content);
  };

  const handleSave = async () => {
    if (!selected) return;
    if (selected.shared && !window.confirm(
      `${selected.label} is shared with ${selected.sharedWith}\n\nSave and restart ${selected.restartServices.join(', ')} anyway?`,
    )) return;
    setSaving(true);
    try {
      await gsmApi.saveConfigContent(selected.path, content);
      await gsmApi.restartServices(selected.restartServices);
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

// SIP tab (osmo-sip-connector) — deliberately minimal, matching the
// daemon's own native config surface exactly (see osmo-sip-connector-build.ts
// on the backend): where osmo-msc's MNCC socket is (fixed, shown read-only),
// what local address to listen on, and one "remote" SIP peer. There is no
// MSISDN routing, dial plan, or automatic 2G<->IMS call bridging here by
// design — an earlier attempt at that was fully reverted on 2026-09-12
// (signaling never reliably completed and audio was never confirmed working
// in either direction). Wiring "remote" to something that actually completes
// calls — this deployment's own P-CSCF/S-CSCF, an external SIP trunk,
// anything — is entirely on whoever configures this tab.
function SipTab({ status, refresh }: { status: GsmStatus | null; refresh: () => void }) {
  const [localIp, setLocalIp] = useState('127.0.1.6');
  const [localPort, setLocalPort] = useState(5060);
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState(5060);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mnccBusy, setMnccBusy] = useState(false);

  const seeded = useRef(false);
  useEffect(() => {
    if (!status?.sip || seeded.current) return;
    seeded.current = true;
    setLocalIp(status.sip.localIp || '0.0.0.0');
    setLocalPort(status.sip.localPort || 5060);
    setRemoteHost(status.sip.remoteHost || '');
    setRemotePort(status.sip.remotePort || 5060);
  }, [status]);

  if (!status) {
    return <div className="nms-card text-sm text-nms-text-dim">Loading…</div>;
  }

  const sip = status.sip;

  const handleSave = async () => {
    if (!remoteHost.trim()) {
      toast.error('Remote SIP peer is required.');
      return;
    }
    setSaving(true);
    try {
      await gsmApi.sipConfigure({ localIp, localPort, remoteHost, remotePort });
      toast.success('osmo-sip-connector configured and (re)started.');
      refresh();
    } catch (err: any) {
      toast.error(`Configure failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleMnccMode = async (mode: 'internal' | 'external') => {
    setMnccBusy(true);
    try {
      await gsmApi.setSipMnccMode(mode);
      toast.success(`Call routing set to ${mode} (osmo-msc restarted).`);
      refresh();
    } catch (err: any) {
      toast.error(`Failed to switch mode: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setMnccBusy(false);
    }
  };

  const handleAction = async (action: 'sipStart' | 'sipStop' | 'sipRestart', label: string) => {
    setBusy(true);
    try {
      await gsmApi[action]();
      toast.success(`osmo-sip-connector ${label}`);
      refresh();
    } catch (err: any) {
      toast.error(`${label} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300 flex gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          There is no automatic call routing between 2G and IMS/4G here — only SMS/MMS is bridged, and that bridge is set
          up separately: install &amp; configure IMS, then the SMS/MMS page's "VectorCore SMSC" delivery mode (not this
          page) — that's what actually wires a 2G subscriber's SMS to/from IMS. This tab only installs and runs
          osmo-sip-connector exactly as Osmocom ships it; the "remote" peer below is a real SIP address you control
          (this deployment's own P-CSCF, an external SIP trunk, anything). Getting calls to actually complete end to end
          is on you.
        </span>
      </div>

      {!sip?.installedOnDisk && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
          Not built yet — osmo-sip-connector is built from source as part of this page's main Install action (Setup tab).
        </div>
      )}

      <div className="nms-card space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-sm font-semibold text-nms-text">osmo-sip-connector</p>
            <p className="text-xs text-nms-text-dim mt-1">{sip?.version || 'Not built'}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <SvcBadge label="osmo-sip-connector" active={!!sip?.running} />
            <div className="h-5 w-px bg-nms-border" />
            <button onClick={() => handleAction('sipStart', 'started')} disabled={busy || !sip?.configured} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Play className="w-3 h-3" /> Start
            </button>
            <button onClick={() => handleAction('sipStop', 'stopped')} disabled={busy || !sip?.configured} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <Square className="w-3 h-3" /> Stop
            </button>
            <button onClick={() => handleAction('sipRestart', 'restarted')} disabled={busy || !sip?.configured} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5">
              <RotateCw className="w-3 h-3" /> Restart
            </button>
          </div>
        </div>

        <div className="border-t border-nms-border pt-4">
          <p className="text-sm font-semibold text-nms-text mb-1">Call Routing (osmo-msc's MNCC handler)</p>
          <p className="text-[11px] text-nms-text-dim mb-3">
            This controls how osmo-msc routes EVERY call it handles, not just ones headed to osmo-sip-connector — including a
            plain call between two of its own 2G subscribers. Switching modes restarts osmo-msc.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              onClick={() => handleMnccMode('internal')}
              disabled={mnccBusy || sip?.mnccMode === 'internal'}
              className={clsx(
                'text-left rounded-lg border px-3 py-2.5 transition-colors disabled:cursor-default',
                sip?.mnccMode === 'internal' ? 'border-nms-accent bg-nms-accent/10' : 'border-nms-border hover:bg-nms-surface-2',
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-nms-text">
                <RadioTower className="w-3.5 h-3.5" /> Internal <span className="text-[10px] font-normal text-nms-text-dim">(default)</span>
              </div>
              <p className="text-[11px] text-nms-text-dim mt-1">osmo-msc/osmo-mgw route calls themselves. Plain 2G-to-2G calling works with nothing else set up.</p>
            </button>
            <button
              onClick={() => handleMnccMode('external')}
              disabled={mnccBusy || sip?.mnccMode === 'external' || !sip?.installedOnDisk}
              title={!sip?.installedOnDisk ? 'Build osmo-sip-connector first (Setup tab Install)' : undefined}
              className={clsx(
                'text-left rounded-lg border px-3 py-2.5 transition-colors disabled:cursor-default',
                sip?.mnccMode === 'external' ? 'border-nms-accent bg-nms-accent/10' : 'border-nms-border hover:bg-nms-surface-2',
                !sip?.installedOnDisk && sip?.mnccMode !== 'external' && 'opacity-50',
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-nms-text">
                <Phone className="w-3.5 h-3.5" /> External
              </div>
              <p className="text-[11px] text-nms-text-dim mt-1">Every call is handed to osmo-sip-connector ({sip?.mnccSocketPath}). Needs it configured and running below.</p>
            </button>
          </div>
          {sip?.mnccMode === 'external' && !sip?.running && (
            <div className="mt-3 flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>External is selected but osmo-sip-connector isn't running — every call, including 2G-to-2G, will fail right now. Start it below, or switch back to Internal.</span>
            </div>
          )}
        </div>

        <div className="border-t border-nms-border pt-4">
          <p className="text-sm font-semibold text-nms-text mb-1">SIP</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="nms-label">Local bind IP</label>
              <input className="nms-input font-mono text-xs" value={localIp} onChange={e => setLocalIp(e.target.value)} placeholder="127.0.1.6" />
              <p className="text-[11px] text-nms-text-dim mt-1">Use a dedicated address, not 0.0.0.0 — this host already has other SIP daemons on port 5060 (P-CSCF, Asterisk, SMSC), and a wildcard bind conflicts with any of them.</p>
            </div>
            <div>
              <label className="nms-label">Local port</label>
              <input type="number" className="nms-input font-mono text-xs" value={localPort} onChange={e => setLocalPort(Number(e.target.value))} placeholder="5060" />
            </div>
            <div>
              <label className="nms-label">Remote SIP peer (host/IP)</label>
              <input className="nms-input font-mono text-xs" value={remoteHost} onChange={e => setRemoteHost(e.target.value)} placeholder="e.g. 10.0.1.178" />
              <p className="text-[11px] text-nms-text-dim mt-1">Where 2G calls are sent to / received from. Required.</p>
            </div>
            <div>
              <label className="nms-label">Remote port</label>
              <input type="number" className="nms-input font-mono text-xs" value={remotePort} onChange={e => setRemotePort(Number(e.target.value))} placeholder="5060" />
            </div>
          </div>
          <button onClick={handleSave} disabled={saving || !sip?.installedOnDisk} className="nms-btn-primary text-sm mt-4 flex items-center gap-2">
            <Phone className="w-4 h-4" /> {saving ? 'Saving…' : 'Save & Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GsmPage({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [status, setStatus] = useState<GsmStatus | null>(null);
  const [tab, setTab] = useState<'setup' | 'bts' | 'sip' | 'configs'>('setup');
  const [svcBusy, setSvcBusy] = useState(false);

  const refresh = useCallback(() => {
    gsmApi.getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    setSvcBusy(true);
    try {
      await { start: gsmApi.start, stop: gsmApi.stop, restart: gsmApi.restart }[action]();
      toast.success(`2G GSM services ${action}ed`);
      refresh();
    } catch (err: any) {
      toast.error(`${action} failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSvcBusy(false);
    }
  };

  const TABS: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'setup',   label: 'Setup',         icon: <Settings className="w-4 h-4" /> },
    { id: 'bts',     label: 'BTS / Radios',  icon: <RadioTower className="w-4 h-4" /> },
    { id: 'sip',     label: 'SIP',           icon: <Phone className="w-4 h-4" /> },
    { id: 'configs', label: 'Config Files',  icon: <FileText className="w-4 h-4" /> },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold font-display text-nms-text">2G GSM (Osmocom)</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">alpha</span>
          </div>
          <p className="text-sm text-nms-text-dim mt-1">
            Real GSM radio access (osmo-bsc/osmo-bts) on top of the osmo-hlr/osmo-msc/osmo-stp already running for SMS over SGs.
          </p>
        </div>

        {status?.installedOnDisk && (
          <div className="flex items-center gap-2 flex-wrap">
            <SvcBadge label="osmo-bsc" active={!!status.services['osmo-bsc']} />
            <SvcBadge label="osmo-mgw" active={!!status.services['osmo-mgw']} />
            {status.btsEntries.some(e => e.backend === 'virtual') && (
              <SvcBadge label="osmo-bts-virtual" active={!!status.services['osmo-bts-virtual']} />
            )}
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

      {tab === 'setup' && <SetupTab status={status} refresh={refresh} onNavigate={onNavigate} />}
      {tab === 'bts' && <BtsTab btsEntries={status?.btsEntries ?? []} refresh={refresh} defaultOmlIp={status?.bscMgwBindIp ?? '127.0.0.1'} />}
      {tab === 'sip' && <SipTab status={status} refresh={refresh} />}
      {tab === 'configs' && <ConfigFilesTab />}
    </div>
  );
}
