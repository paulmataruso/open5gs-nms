import React, { useState, useEffect } from 'react';
import { Radio, MapPin, Wifi, Server, ChevronDown, ChevronUp, Locate, AlertCircle, Terminal } from 'lucide-react';
import { LabelWithTooltip } from '../common/UniversalTooltipWrappers';
import { FEMTO_TOOLTIPS } from '../../data/tooltips/femto';
import { configApi } from '../../api';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

interface FemtoConfig {
  ip: string;
  mac: string;
  rootPass: string;
  webuiUser: string;
  webuiPass: string;
  carrierNumber: '1' | '2';
  bandwidth: '5' | '10' | '15' | '20';
  freqBand: string;
  earfcn: string;
  cellIdentity: string;
  pci: string;
  txPower: string;
  syncSource: 'FREE_RUNNING' | 'GNSS' | 'PTP';
  carrierAggregation: boolean;
  contiguousCC: boolean;
  autoInternalNeighbors: boolean;
  adminState: boolean;
  mmeIp: string;
  plmnId: string;
  tac: string;
  tunnelType: 'IPv4' | 'IPv6';
  sasEnable: boolean;
  sasLocation: 'indoor' | 'outdoor';
  sasLocationSource: '0' | '1';
  latitude: string;
  longitude: string;
}

const DEFAULTS: FemtoConfig = {
  ip: '',
  mac: '',
  rootPass: '',
  webuiUser: 'debug',
  webuiPass: '',
  carrierNumber: '2',
  bandwidth: '20',
  freqBand: '48,48',
  earfcn: '55340,55538',
  cellIdentity: '350,351',
  pci: '400,401',
  txPower: '13,13',
  syncSource: 'FREE_RUNNING',
  carrierAggregation: true,
  contiguousCC: true,
  autoInternalNeighbors: true,
  adminState: true,
  mmeIp: '',
  plmnId: '99970',
  tac: '1',
  tunnelType: 'IPv4',
  sasEnable: false,
  sasLocation: 'indoor',
  sasLocationSource: '0',
  latitude: '',
  longitude: '',
};

function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="p-2 rounded-lg bg-nms-accent/10 text-nms-accent flex-shrink-0">{icon}</div>
      <div>
        <h3 className="text-base font-semibold font-display text-nms-text">{title}</h3>
        {subtitle && <p className="text-xs text-nms-text-dim">{subtitle}</p>}
      </div>
    </div>
  );
}

function CheckboxField({ label, checked, onChange, tooltip }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; tooltip?: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent"
      />
      <span className="text-sm text-nms-text group-hover:text-nms-accent transition-colors">
        {tooltip ? <LabelWithTooltip tooltip={tooltip}>{label}</LabelWithTooltip> : label}
      </span>
    </label>
  );
}

export function FemtoConfigTab() {
  const [cfg, setCfg] = useState<FemtoConfig>(DEFAULTS);
  const [showCredentials, setShowCredentials] = useState(false);
  const [locating, setLocating] = useState(false);
  const [running, setRunning] = useState(false);
  const [dryRunOutput, setDryRunOutput] = useState<string | null>(null);
  const [liveOutput, setLiveOutput] = useState<string | null>(null);
  const dryRunRef = React.useRef<HTMLPreElement>(null);
  const liveRef = React.useRef<HTMLPreElement>(null);

  // Auto-scroll output windows as lines arrive
  React.useEffect(() => {
    if (dryRunRef.current) dryRunRef.current.scrollTop = dryRunRef.current.scrollHeight;
  }, [dryRunOutput]);
  React.useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [liveOutput]);

  const set = (patch: Partial<FemtoConfig>) => setCfg(prev => ({ ...prev, ...patch }));

  // Auto-load MME IP from current Open5GS config
  useEffect(() => {
    configApi.getAll().then(configs => {
      const mmeIp = (configs.mme as any)?.mme?.s1ap?.server?.[0]?.address || '';
      if (mmeIp) {
        set({ mmeIp });
        toast.success(`MME IP auto-populated: ${mmeIp}`, { duration: 3000, icon: '📡' });
      }
    }).catch(() => {});
  }, []);

  // When carrier number changes, update dual-value fields
  const handleCarrierNumberChange = (n: '1' | '2') => {
    if (n === '1') {
      set({
        carrierNumber: '1',
        freqBand: cfg.freqBand.split(',')[0] || '48',
        earfcn: cfg.earfcn.split(',')[0] || '55340',
        cellIdentity: cfg.cellIdentity.split(',')[0] || '350',
        pci: cfg.pci.split(',')[0] || '400',
        txPower: cfg.txPower.split(',')[0] || '13',
        carrierAggregation: false,
        contiguousCC: false,
      });
    } else {
      const single = (v: string, fallback: string) => v.includes(',') ? v : `${v},${fallback}`;
      set({
        carrierNumber: '2',
        freqBand: single(cfg.freqBand, cfg.freqBand),
        earfcn: single(cfg.earfcn, '55538'),
        cellIdentity: single(cfg.cellIdentity, String(Number(cfg.cellIdentity.split(',')[0]) + 1)),
        pci: single(cfg.pci, String(Number(cfg.pci.split(',')[0]) + 1)),
        txPower: single(cfg.txPower, cfg.txPower),
      });
    }
  };

  // Browser geolocation → micro-degrees format the device expects
  const useMyLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation not supported by your browser');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = Math.round(pos.coords.latitude  * 1_000_000).toString();
        const lon = Math.round(pos.coords.longitude * 1_000_000).toString();
        set({ latitude: lat, longitude: lon });
        toast.success(`Location set: ${pos.coords.latitude.toFixed(5)}°, ${pos.coords.longitude.toFixed(5)}°`);
        setLocating(false);
      },
      err => {
        toast.error(`Location error: ${err.message}`);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const [probeStatus, setProbeStatus] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const probeDevice = async (ip: string) => {
    if (!ip) return;
    setProbing(true);
    setProbeStatus(null);
    try {
      const webuiPass = cfg.webuiPass || null;
      const url = `/api/femto/probe?ip=${encodeURIComponent(ip)}&webuiUser=${encodeURIComponent(cfg.webuiUser)}${webuiPass ? `&webuiPass=${encodeURIComponent(webuiPass)}` : ''}`;
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();

      if (!data.webui) {
        setProbeStatus('⚪ WebUI not reachable — device may need enabling via SSH first');
        return;
      }

      if (!data.config) {
        setProbeStatus('🟡 WebUI is enabled — enter WebUI password above to pull current config');
        return;
      }

      // Populate form fields from device
      set({
        carrierNumber:          data.config.carrier_number  as '1' | '2',
        bandwidth:              data.config.bandwidth       as any,
        freqBand:               data.config.freq_band,
        earfcn:                 data.config.earfcn,
        cellIdentity:           data.config.cell_identity,
        pci:                    data.config.pci,
        txPower:                data.config.tx_power,
        syncSource:             (data.config.sync_source || 'FREE_RUNNING') as any,
        tunnelType:             (data.config.tunnel_type  || 'IPv4')         as any,
        mmeIp:                  data.config.mme_ip,
        plmnId:                 data.config.plmn_id,
        tac:                    data.config.tac,
        adminState:             data.config.admin_state,
        carrierAggregation:     data.config.carrier_aggregation,
        contiguousCC:           data.config.contiguous_cc,
        autoInternalNeighbors:  data.config.auto_internal_neighbors,
      });
      setProbeStatus('🟢 WebUI is enabled — current config loaded. Review and push changes if needed.');
    } catch {
      setProbeStatus('⚪ Could not reach device');
    } finally {
      setProbing(false);
    }
  };

  const validate = () => {
    if (!cfg.ip)     { toast.error('Femtocell IP is required'); return false; }
    if (!cfg.mmeIp)  { toast.error('MME IP is required'); return false; }
    if (!cfg.plmnId) { toast.error('PLMN ID is required'); return false; }
    return true;
  };

  const buildPayload = (dryRun: boolean) => ({
    ip: cfg.ip,
    mac: cfg.mac || null,
    rootPass:  cfg.rootPass  || null,
    webuiUser: cfg.webuiUser,
    webuiPass: cfg.webuiPass || null,
    dryRun,
    config: {
      admin_state:              cfg.adminState,
      carrier_number:           cfg.carrierNumber,
      auto_internal_neighbors:  cfg.autoInternalNeighbors,
      carrier_aggregation:      cfg.carrierAggregation,
      contiguous_cc:            cfg.contiguousCC,
      bandwidth:                cfg.bandwidth,
      freq_band:                cfg.freqBand,
      earfcn:                   cfg.earfcn,
      cell_identity:            cfg.cellIdentity,
      pci:                      cfg.pci,
      tx_power:                 cfg.txPower,
      sync_source:              cfg.syncSource,
      tunnel_type:              cfg.tunnelType,
      mme_ip:                   cfg.mmeIp,
      plmn_id:                  cfg.plmnId,
      tac:                      cfg.tac,
      sas_enable:               cfg.sasEnable,
      sas_location:             cfg.sasLocation,
      sas_location_source:      cfg.sasLocationSource,
      sas_latitude:             cfg.latitude,
      sas_longitude:            cfg.longitude,
    },
  });

  const runProvision = async (dryRun: boolean) => {
    if (!validate()) return;
    if (!dryRun && !confirm(
      `Provision femtocell at ${cfg.ip}?\n\nThis will modify device configuration and reboot it twice. Continue?`
    )) return;

    setRunning(true);
    if (dryRun) setDryRunOutput('Running dry run...');
    else        setLiveOutput('⏳ Provisioning in progress — please be patient.\n\nThe device reboots twice during this process (approximately 80 seconds each).\nThis can take 3-5 minutes total. Do not close this page.\n\nWaiting for script to complete...');

    try {
      const res = await fetch('/api/femto/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload(dryRun)),
      });
      const data = await res.json();
      if (dryRun) {
        setDryRunOutput(data.output || 'No output');
      } else {
        setLiveOutput(data.output || 'No output');
        if (data.success) {
          toast.success('Femtocell provisioned successfully');
        } else {
          // Show the error but keep the output visible so the user can diagnose
          toast.error(`Provisioning failed: ${data.error || 'Check output for details'}`, { duration: 8000 });
        }
      }
    } catch (err) {
      toast.error(dryRun ? 'Dry run failed' : 'Provisioning failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">

      {/* Info banner */}
      <div className="nms-card border-nms-accent/30 bg-nms-accent/5">
        <div className="flex items-start gap-3">
          <Radio className="w-5 h-5 text-nms-accent mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-1">Sercomm SCE4255W Small Cell Provisioning</h3>
            <p className="text-xs text-nms-text-dim leading-relaxed">
              Automatically provision a FreedomFi/Sercomm SCE4255W CBRS small cell.
              Provide the device IP and optional MAC address — credentials are automatically derived from the MAC
              using the calc_f2 algorithm. The script will enable the WebUI if needed, apply all radio and core
              configuration, and reboot the device. The MME IP is pre-filled from your current Open5GS config.
            </p>
          </div>
        </div>
      </div>

      {/* Section 1 — Device Identity */}
      <div className="nms-card">
        <SectionHeader icon={<Server className="w-4 h-4" />} title="Device Identity" subtitle="IP and MAC address of the small cell" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="nms-label">
              <LabelWithTooltip tooltip={FEMTO_TOOLTIPS.ip}>Femtocell IP Address <span className="text-nms-accent">*</span></LabelWithTooltip>
            </label>
            <input className="nms-input font-mono" value={cfg.ip}
              onChange={e => set({ ip: e.target.value })}
              onBlur={e => probeDevice(e.target.value)}
              placeholder="172.16.0.101" />
            {probing && <p className="text-xs text-nms-text-dim mt-1 animate-pulse">🔍 Checking device...</p>}
            {probeStatus && !probing && (
              <p className={`text-xs mt-1 ${
                probeStatus.startsWith('🟢') ? 'text-green-400' :
                probeStatus.startsWith('🟡') ? 'text-yellow-400' : 'text-nms-text-dim'
              }`}>{probeStatus}</p>
            )}
          </div>
          <div>
            <label className="nms-label">
              <LabelWithTooltip tooltip={FEMTO_TOOLTIPS.mac}>MAC Address</LabelWithTooltip>
            </label>
            <input className="nms-input font-mono" value={cfg.mac} onChange={e => set({ mac: e.target.value })} placeholder="3C:62:F0:AA:AA:AA  (blank = fetch via SSH)" />
            <p className="text-xs text-nms-text-dim mt-1">
              Leave blank to automatically retrieve via SSH as <code className="text-nms-accent">sc_femto</code>
            </p>
          </div>
        </div>

        {/* Credentials override */}
        <div className="mt-4">
          <button
            onClick={() => setShowCredentials(!showCredentials)}
            className="flex items-center gap-2 text-xs text-nms-text-dim hover:text-nms-text transition-colors"
          >
            {showCredentials ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            Override derived credentials (optional — leave blank to derive from MAC)
          </button>
          {showCredentials && (
            <div className="mt-3 pt-3 border-t border-nms-border grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.root_pass}>Root SSH Password</LabelWithTooltip></label>
                <input type="password" className="nms-input font-mono" value={cfg.rootPass} onChange={e => set({ rootPass: e.target.value })} placeholder="Derived from MAC" />
              </div>
              <div>
                <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.webui_user}>WebUI Username</LabelWithTooltip></label>
                <input className="nms-input" value={cfg.webuiUser} onChange={e => set({ webuiUser: e.target.value })} placeholder="debug" />
              </div>
              <div>
                <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.webui_pass}>WebUI Password</LabelWithTooltip></label>
                <input type="password" className="nms-input font-mono" value={cfg.webuiPass} onChange={e => set({ webuiPass: e.target.value })} placeholder="Derived from MAC" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 2 — Radio */}
      <div className="nms-card">
        <SectionHeader icon={<Wifi className="w-4 h-4" />} title="Radio Configuration" subtitle="LTE carrier settings — defaults are for CBRS Band 48 dual-carrier" />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.carrier_number}>Carrier Number</LabelWithTooltip></label>
            <select className="nms-input" value={cfg.carrierNumber} onChange={e => handleCarrierNumberChange(e.target.value as '1' | '2')}>
              <option value="1">1 — Single</option>
              <option value="2">2 — Dual CA</option>
            </select>
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.bandwidth}>Bandwidth (MHz)</LabelWithTooltip></label>
            <select className="nms-input" value={cfg.bandwidth} onChange={e => set({ bandwidth: e.target.value as any })}>
              <option value="5">5 MHz</option>
              <option value="10">10 MHz</option>
              <option value="15">15 MHz</option>
              <option value="20">20 MHz</option>
            </select>
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.sync_source}>Sync Source</LabelWithTooltip></label>
            <select className="nms-input" value={cfg.syncSource} onChange={e => set({ syncSource: e.target.value as any })}>
              <option value="FREE_RUNNING">FREE_RUNNING</option>
              <option value="GNSS">GNSS (GPS)</option>
              <option value="PTP">PTP (1588)</option>
            </select>
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.tunnel_type}>Tunnel Type</LabelWithTooltip></label>
            <select className="nms-input" value={cfg.tunnelType} onChange={e => set({ tunnelType: e.target.value as any })}>
              <option value="IPv4">IPv4</option>
              <option value="IPv6">IPv6</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
          {[
            { label: 'Frequency Band', key: 'freqBand',     tooltip: FEMTO_TOOLTIPS.freq_band,     hint: cfg.carrierNumber === '2' ? 'Dual: 48,48' : 'Single: 48' },
            { label: 'EARFCN',         key: 'earfcn',       tooltip: FEMTO_TOOLTIPS.earfcn,        hint: 'CBRS range: 55240–56740' },
            { label: 'Cell Identity',  key: 'cellIdentity', tooltip: FEMTO_TOOLTIPS.cell_identity, hint: cfg.carrierNumber === '2' ? 'CA: high 20-bits must match' : '28-bit value' },
            { label: 'PCI',            key: 'pci',          tooltip: FEMTO_TOOLTIPS.pci,           hint: 'Range 0–503, supports: 400..503' },
            { label: 'TX Power (dBm)', key: 'txPower',      tooltip: FEMTO_TOOLTIPS.tx_power,      hint: 'Range 0–24 dBm per antenna' },
          ].map(({ label, key, tooltip, hint }) => (
            <div key={key}>
              <label className="nms-label"><LabelWithTooltip tooltip={tooltip}>{label}</LabelWithTooltip></label>
              <input
                className="nms-input font-mono"
                value={(cfg as any)[key]}
                onChange={e => set({ [key]: e.target.value } as any)}
                placeholder={hint}
              />
              <p className="text-xs text-nms-text-dim mt-1">{hint}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3 border-t border-nms-border">
          <CheckboxField label="Admin State"             checked={cfg.adminState}             onChange={v => set({ adminState: v })}             tooltip={FEMTO_TOOLTIPS.admin_state} />
          <CheckboxField label="Carrier Aggregation"     checked={cfg.carrierAggregation}     onChange={v => set({ carrierAggregation: v })}     tooltip={FEMTO_TOOLTIPS.carrier_aggregation} />
          <CheckboxField label="Contiguous CC"           checked={cfg.contiguousCC}           onChange={v => set({ contiguousCC: v })}           tooltip={FEMTO_TOOLTIPS.contiguous_cc} />
          <CheckboxField label="Auto Internal Neighbors" checked={cfg.autoInternalNeighbors} onChange={v => set({ autoInternalNeighbors: v })} tooltip={FEMTO_TOOLTIPS.auto_internal_neighbors} />
        </div>
      </div>

      {/* Section 3 — Core */}
      <div className="nms-card">
        <SectionHeader icon={<Server className="w-4 h-4" />} title="Core Network (S1)" subtitle="MME IP auto-populated from your Open5GS config" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.mme_ip}>MME IP Address <span className="text-nms-accent">*</span></LabelWithTooltip></label>
            <input className="nms-input font-mono" value={cfg.mmeIp} onChange={e => set({ mmeIp: e.target.value })} placeholder="Auto-populated from MME config" />
            <p className="text-xs text-nms-text-dim mt-1">S1-MME control plane interface</p>
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.plmn_id}>PLMN ID (MCC+MNC) <span className="text-nms-accent">*</span></LabelWithTooltip></label>
            <input className="nms-input font-mono" value={cfg.plmnId} onChange={e => set({ plmnId: e.target.value })} placeholder="99970" />
            <p className="text-xs text-nms-text-dim mt-1">MCC 999 + MNC 70 = 99970. Must match MME.</p>
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.tac}>TAC</LabelWithTooltip></label>
            <input className="nms-input font-mono" value={cfg.tac} onChange={e => set({ tac: e.target.value })} placeholder="1" />
            <p className="text-xs text-nms-text-dim mt-1">Must match MME TAC. Dual: 1,2</p>
          </div>
        </div>
      </div>

      {/* Section 4 — Location / SAS */}
      <div className="nms-card">
        <SectionHeader icon={<MapPin className="w-4 h-4" />} title="Location &amp; SAS" subtitle="CBRS Spectrum Access System settings" />
        <div className="mb-4">
          <CheckboxField label="Enable SAS (CBRS automated spectrum coordination)" checked={cfg.sasEnable} onChange={v => set({ sasEnable: v })} tooltip={FEMTO_TOOLTIPS.sas_enable} />
          <p className="text-xs text-nms-text-dim mt-1 ml-6">Disable for lab/private CBRS use without a SAS provider</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.sas_location}>Location</LabelWithTooltip></label>
            <select className="nms-input" value={cfg.sasLocation} onChange={e => set({ sasLocation: e.target.value as any })}>
              <option value="indoor">Indoor</option>
              <option value="outdoor">Outdoor</option>
            </select>
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.sas_location_source}>Location Source</LabelWithTooltip></label>
            <select className="nms-input" value={cfg.sasLocationSource} onChange={e => set({ sasLocationSource: e.target.value as any })}>
              <option value="0">Manual (enter coordinates)</option>
              <option value="1">GPS (device built-in)</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.latitude}>Latitude (micro-degrees)</LabelWithTooltip></label>
            <input className="nms-input font-mono" value={cfg.latitude} onChange={e => set({ latitude: e.target.value })} placeholder="43375246" />
            <p className="text-xs text-nms-text-dim mt-1">Degrees × 1,000,000 — e.g. 43.375246° = 43375246</p>
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={FEMTO_TOOLTIPS.longitude}>Longitude (micro-degrees)</LabelWithTooltip></label>
            <input className="nms-input font-mono" value={cfg.longitude} onChange={e => set({ longitude: e.target.value })} placeholder="-72180291" />
            <p className="text-xs text-nms-text-dim mt-1">Degrees × 1,000,000 — e.g. -72.180291° = -72180291</p>
          </div>
        </div>
        <button
          onClick={useMyLocation}
          disabled={locating}
          className="mt-3 flex items-center gap-2 text-xs text-nms-accent hover:text-nms-accent/80 transition-colors border border-nms-accent/30 hover:border-nms-accent/60 px-3 py-1.5 rounded"
        >
          <Locate className={clsx('w-3.5 h-3.5', locating && 'animate-spin')} />
          {locating ? 'Getting location...' : 'Use My Location'}
        </button>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button onClick={() => runProvision(true)}  disabled={running} className="nms-btn-secondary flex-1 flex items-center justify-center gap-2">
          <Terminal className="w-4 h-4" />
          {running ? 'Running...' : 'Dry Run'}
        </button>
        <button onClick={() => runProvision(false)} disabled={running} className="nms-btn-primary flex-1 flex items-center justify-center gap-2">
          <Radio className="w-4 h-4" />
          {running ? 'Provisioning...' : 'Provision Femtocell'}
        </button>
      </div>

      {/* Output windows */}
      {dryRunOutput !== null && (
        <div className="nms-card">
          <div className="flex items-center gap-2 mb-3">
            <Terminal className="w-4 h-4 text-nms-accent" />
            <h3 className="text-sm font-semibold text-nms-text">Dry Run Output</h3>
          </div>
          <pre ref={dryRunRef} className="text-xs font-mono text-nms-text-dim bg-nms-surface-2 border border-nms-border rounded p-4 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto min-h-12">
            {dryRunOutput || <span className="animate-pulse">Starting...</span>}
          </pre>
        </div>
      )}

      {liveOutput !== null && (
        <div className={clsx('nms-card', liveOutput.includes('[-] FAILED') ? 'border-nms-red/30 bg-nms-red/5' : 'border-nms-green/30 bg-nms-green/5')}>
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className={clsx('w-4 h-4', liveOutput.includes('[-] FAILED') ? 'text-nms-red' : 'text-nms-green')} />
            <h3 className="text-sm font-semibold text-nms-text">Provisioning Output</h3>
          </div>
          <pre ref={liveRef} className="text-xs font-mono text-nms-text-dim bg-nms-surface-2 border border-nms-border rounded p-4 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto min-h-12">
            {liveOutput || <span className="animate-pulse">Starting...</span>}
          </pre>
        </div>
      )}

      {/* Warning */}
      <div className="nms-card bg-amber-500/5 border-amber-500/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-nms-text-dim space-y-1">
            <p className="font-semibold text-nms-text">Before provisioning</p>
            <p>• The small cell must be powered on and reachable at the IP address specified</p>
            <p>• If MAC is blank the device must have SSH enabled and the <code className="text-nms-accent">sc_femto</code> account accessible</p>
            <p>• The device will reboot twice — once to enable the WebUI (if needed) and once after config is applied</p>
            <p>• PLMN ID and TAC must match your Open5GS MME configuration exactly for the device to register</p>
          </div>
        </div>
      </div>

    </div>
  );
}
