import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Radio, MapPin, Wifi, Server, Locate, AlertCircle, Terminal, Monitor,
  Eye, EyeOff, HelpCircle, Send, RefreshCw, ChevronDown, ChevronUp,
  Clock, ExternalLink, Copy, Check, RotateCw, WifiOff,
  GripVertical, X, Plus, Shield,
} from 'lucide-react';
import { LabelWithTooltip } from '../common/UniversalTooltipWrappers';
import { configApi, genieacsApi, SercommRadio, SercommProvisionInput, NbiTask } from '../../api';
import { ProvisionConfirmModal } from './ProvisionConfirmModal';
import { SercommWebUIModal } from './SercommWebUIModal';
import { CwmpScreenshotsModal } from './CwmpScreenshotsModal';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

const POLL_INTERVAL_MS = 30_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatLastInform(ts: string | null): string {
  if (!ts) return 'Never';
  const d    = new Date(ts);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

function RfDot({ status }: { status: SercommRadio['rfStatus'] }) {
  return (
    <span
      title={status === 'on' ? 'RF On' : status === 'off' ? 'RF Off (radio up)' : 'Offline'}
      className={clsx(
        'inline-block w-2.5 h-2.5 rounded-full flex-shrink-0',
        status === 'on'      && 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]',
        status === 'off'     && 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]',
        status === 'offline' && 'bg-red-500',
      )}
    />
  );
}

// ─── Credential derivation ─────────────────────────────────────────────────────
async function fetchDerivedCredentials(mac: string): Promise<{ rootPass: string; webuiPass: string } | null> {
  try {
    const clean = mac.replace(/[^0-9a-fA-F]/g, '');
    if (clean.length !== 12) return null;
    const res = await fetch(`/api/femto/derive-credentials?mac=${encodeURIComponent(clean)}`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ─── Copy button ──────────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="p-1 rounded hover:bg-nms-surface text-nms-text-dim hover:text-nms-accent transition-colors flex-shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ─── Form state ────────────────────────────────────────────────────────────────
interface SercommForm {
  mcc: string; mnc: string; tac: string; mmeIp: string;
  carrierNumber: string; bandwidth: string;
  freqBand1: string; freqBand2: string;
  earfcn: string; earfcn2: string;
  cellIdentity: string; cellIdentity2: string;
  pci1: string; pci2: string;
  txPower: string;
  syncSource: string;
  caEnable: boolean;
  sasEnable: boolean;
  sasMethod: string;           // '0'=Direct SAS, '1'=Domain Proxy
  sasManufacturerPrefix: boolean; // prepend 'Sercomm-' to serial
  sasInstallMethod: string;    // '0'=Single-Step, '1'=Multi-Step (CPIInstallParamSuppliedEnable)
  sasCpiEnable: boolean;       // CPI required (Cat B outdoor)
  sasCategory: string;         // 'A' or 'B'
  sasChannelType: string;      // 'GAA' or 'PAL'
  sasLocation: string;         // 'indoor' or 'outdoor'
  sasLocationSource: string;   // '0'=Manual, '1'=GPS (HighAccuracyLocationEnable)
  sasHeightType: string;       // 'AGL' or 'AMSL'
  sasServerUrl: string;
  sasUserId: string;
  sasIcgGroupId: string;
  sasPeerCertVerify: boolean;
  latitude: string; longitude: string;
  cipheringAlgorithms:  string[];
  integrityAlgorithms:  string[];
  enable256QAM: boolean;
}

function radioToForm(r: SercommRadio, mmeIpFallback = ''): SercommForm {
  // Convert microdegrees (×10⁶) back to decimal degrees for display
  const latRaw = r.latitude  ? parseFloat(r.latitude)  : null;
  const lonRaw = r.longitude ? parseFloat(r.longitude) : null;
  const latDecimal = latRaw !== null
    ? (Math.abs(latRaw) > 900 ? (latRaw / 1_000_000).toFixed(6) : latRaw.toFixed(6))
    : '';
  const lonDecimal = lonRaw !== null
    ? (Math.abs(lonRaw) > 1800 ? (lonRaw / 1_000_000).toFixed(6) : lonRaw.toFixed(6))
    : '';

  const cellId1 = r.cellIdentity || '138777000';

  const isCA = r.caEnable === '1' || r.caEnable?.toLowerCase() === 'true';

  return {
    mcc:           r.mcc  || '',
    mnc:           r.mnc  || '',
    tac:           r.tac  || '1',
    mmeIp:         r.mmeIp || mmeIpFallback,
    carrierNumber: isCA ? (r.cellNumber || '2') : '1',
    bandwidth:     r.bandwidth ? String(parseInt(r.bandwidth) / 5) : '20',
    freqBand1:     r.band || '48',
    freqBand2:     isCA ? (r.band || '48') : '',
    earfcn:        r.earfcn   || '56000',
    earfcn2:       isCA ? (r.earfcn2 || '56198') : '',
    cellIdentity:  cellId1,
    cellIdentity2: isCA ? (r.cellIdentity2 || '138777001') : '',
    pci1:          r.pci ? r.pci.split(',')[0].trim() : '361',
    pci2:          isCA ? (r.pci ? (r.pci.split(',')[1]?.trim() || String(parseInt(r.pci.split(',')[0].trim()) + 1)) : '362') : '',
    txPower:       r.txPower  || '13',
    syncSource:    r.syncSource || 'FREE_RUNNING',
    caEnable:      isCA,
    sasEnable:             r.sasEnable === '1' || r.sasEnable?.toLowerCase() === 'true',
    sasMethod:             '0',      // Direct SAS
    sasManufacturerPrefix: true,     // prepend 'Sercomm-' to serial
    sasInstallMethod:      '0',      // Single-Step
    sasCpiEnable:          false,    // no CPI (Cat A indoor)
    sasCategory:           'A',
    sasChannelType:        'GAA',
    sasLocation:           r.sasLocation || 'indoor',
    sasLocationSource:     '0',      // Manual
    sasHeightType:         'AGL',
    sasServerUrl:          DEFAULT_SERCOMM_SAS_URL,
    sasUserId:             r.sasUserId || cellId1,
    sasIcgGroupId:         r.icgGroupId || '',
    sasPeerCertVerify:     false,
    latitude:              latDecimal,
    longitude:             lonDecimal,
    cipheringAlgorithms:  ['EEA0', '128-EEA1', '128-EEA2'],
    integrityAlgorithms:  ['128-EIA1', '128-EIA2'],
    enable256QAM: r.enable256QAM === '1' || r.enable256QAM?.toLowerCase() === 'true',
  };
}

// Default SAS URL for Sercomm — HTTPS on port 8443
const DEFAULT_SERCOMM_SAS_URL = `https://${window.location.hostname}:8443/sas/v1.2`;

function formToInput(f: SercommForm): SercommProvisionInput {
  return {
    mcc: f.mcc.trim(), mnc: f.mnc.trim(), tac: f.tac.trim(), mmeIp: f.mmeIp.trim(),
    earfcn: f.earfcn.trim(), earfcn2: f.earfcn2.trim(),
    pci: f.pci2.trim() ? `${f.pci1.trim()},${f.pci2.trim()}` : f.pci1.trim(),
    cellIdentity: f.cellIdentity.trim(), cellIdentity2: f.cellIdentity2.trim(),
    txPower: f.txPower.trim(), bandwidth: f.bandwidth.trim(),
    freqBand: f.freqBand2.trim() ? `${f.freqBand1.trim()},${f.freqBand2.trim()}` : f.freqBand1.trim(), syncSource: f.syncSource,
    carrierNumber: f.carrierNumber, caEnable: f.caEnable, contiguousCC: false,
    sasEnable: f.sasEnable,
    sasMethod: f.sasMethod,
    sasManufacturerPrefix: f.sasManufacturerPrefix,
    sasInstallMethod: f.sasInstallMethod,
    sasCpiEnable: f.sasCpiEnable,
    sasCategory: f.sasCategory,
    sasChannelType: f.sasChannelType,
    sasLocation: f.sasLocation,
    sasLocationSource: f.sasLocationSource,
    sasHeightType: f.sasHeightType,
    sasUserId: f.sasUserId.trim(),
    sasIcgGroupId: f.sasIcgGroupId.trim(),
    sasPeerCertVerify: f.sasPeerCertVerify,
    latitude:  f.latitude.trim()  ? String(Math.round(parseFloat(f.latitude)  * 1_000_000)) : '',
    longitude: f.longitude.trim() ? String(Math.round(parseFloat(f.longitude) * 1_000_000)) : '',
    cipheringAlgorithmList:  f.cipheringAlgorithms.join(','),
    integrityAlgorithmList:  f.integrityAlgorithms.join(','),
    enable256QAM: f.enable256QAM,
  };
}

// ─── Algorithm drag-and-drop lists ────────────────────────────────────────────
const ALL_CIPHERING = ['EEA0', '128-EEA1', '128-EEA2'];
const ALL_INTEGRITY = ['128-EIA1', '128-EIA2'];

interface AlgorithmDndListProps {
  label: string;
  trParam: string;
  allOptions: string[];
  active: string[];
  onChange: (next: string[]) => void;
}

const AlgorithmDndList: React.FC<AlgorithmDndListProps> = ({ label, trParam, allOptions, active, onChange }) => {
  const dragIdx = useRef<number | null>(null);

  const reorder = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const next = [...active];
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    onChange(next);
  };

  const remove = (item: string) => onChange(active.filter(a => a !== item));
  const add    = (item: string) => onChange([...active, item]);

  const available = allOptions.filter(o => !active.includes(o));

  return (
    <div>
      <label className="nms-label">
        {label} <span className="text-nms-text-dim font-normal">({trParam})</span>
      </label>
      <div className="flex flex-col gap-1 min-h-[2.5rem] mt-1 p-1.5 rounded border border-nms-border bg-nms-bg">
        {active.length === 0 && (
          <p className="text-xs text-nms-text-dim italic px-1">No algorithms selected</p>
        )}
        {active.map((item, idx) => (
          <div
            key={item}
            draggable
            onDragStart={() => { dragIdx.current = idx; }}
            onDragOver={e => e.preventDefault()}
            onDrop={() => { if (dragIdx.current !== null) reorder(dragIdx.current, idx); dragIdx.current = null; }}
            className="flex items-center gap-2 px-2 py-1 rounded bg-nms-surface border border-nms-border cursor-grab active:cursor-grabbing select-none"
          >
            <GripVertical className="w-3.5 h-3.5 text-nms-text-dim flex-shrink-0" />
            <span className="text-xs font-mono text-nms-text flex-1">{item}</span>
            <span className="text-xs text-nms-text-dim">{idx + 1}</span>
            <button onClick={() => remove(item)} className="text-nms-text-dim hover:text-red-400 transition-colors ml-1">
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
      {available.length > 0 && (
        <div className="flex gap-1.5 mt-1 flex-wrap">
          {available.map(item => (
            <button
              key={item}
              onClick={() => add(item)}
              className="flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border border-dashed border-nms-border text-nms-text-dim hover:text-nms-accent hover:border-nms-accent transition-colors"
            >
              <Plus className="w-3 h-3" />
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Single radio row ──────────────────────────────────────────────────────────
const SercommRadioRow: React.FC<{
  radio: SercommRadio;
  mmeIpDefault: string;
  onRefresh: () => void;
}> = ({ radio, mmeIpDefault, onRefresh }) => {
  const [expanded, setExpanded]             = useState(false);
  const [form, setForm]                     = useState<SercommForm>(() => radioToForm(radio, mmeIpDefault));
  const [locating, setLocating]             = useState(false);
  const [rebooting, setRebooting]           = useState(false);
  const [rfBusy, setRfBusy]                 = useState(false);
  const [summoning, setSummoning]           = useState(false);
  const [previewTasks, setPreviewTasks]     = useState<NbiTask[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // After a push, freeze form for 90s to prevent the poll from re-loading stale GenieACS cache values.
  const pushFreezeUntil  = useRef<number>(0);
  // Set to true after a summon so the next radio update syncs the form even while expanded.
  const syncOnNextUpdate = useRef(false);

  useEffect(() => {
    if ((!expanded || syncOnNextUpdate.current) && Date.now() > pushFreezeUntil.current) {
      setForm(radioToForm(radio, mmeIpDefault));
      syncOnNextUpdate.current = false;
    }
  }, [radio, mmeIpDefault, expanded]);

  const handleExpand = async () => {
    const opening = !expanded;
    setExpanded(e => !e);
    if (!opening) return;
    // Summon the radio so GenieACS gets fresh param values immediately.
    setSummoning(true);
    try {
      await genieacsApi.refreshSercomm(radio.id);
      syncOnNextUpdate.current = true;
      setTimeout(onRefresh, 6000);
    } catch { /* non-critical — form still shows cached values */ }
    finally { setSummoning(false); }
  };

  const set = (patch: Partial<SercommForm>) => setForm(f => ({ ...f, ...patch }));

  // ─── EARFCN validation ────────────────────────────────────────────────────
  const EARFCN_MIN = 55340;
  const EARFCN_MAX = 56640;
  const CA_SPACING = 198;

  const earfcn1Num  = parseInt(form.earfcn,  10);
  const earfcn2Num  = parseInt(form.earfcn2, 10);
  const earfcn1Valid = !isNaN(earfcn1Num) && earfcn1Num >= EARFCN_MIN && earfcn1Num <= EARFCN_MAX;
  const earfcn2Valid = !isNaN(earfcn2Num) && earfcn2Num >= EARFCN_MIN && earfcn2Num <= EARFCN_MAX;
  const caSpacingValid = !form.caEnable || (earfcn1Valid && earfcn2Valid && Math.abs(earfcn2Num - earfcn1Num) === CA_SPACING);
  const earfcnError = form.caEnable && earfcn1Valid && earfcn2Valid && !caSpacingValid
    ? `CA requires EARFCN spacing of exactly ${CA_SPACING} (got ${Math.abs(earfcn2Num - earfcn1Num)})`
    : (!earfcn1Valid && form.earfcn)
    ? `EARFCN C1 must be ${EARFCN_MIN}–${EARFCN_MAX} (Band 48)`
    : (form.caEnable && !earfcn2Valid && form.earfcn2)
    ? `EARFCN C2 must be ${EARFCN_MIN}–${EARFCN_MAX} (Band 48)`
    : null;

  // Auto-suggest EARFCN2 when CA is enabled and EARFCN1 is valid
  const handleEarfcn1Change = (val: string) => {
    const n = parseInt(val, 10);
    if (form.caEnable && !isNaN(n) && n >= EARFCN_MIN && n + CA_SPACING <= EARFCN_MAX) {
      set({ earfcn: val, earfcn2: String(n + CA_SPACING) });
    } else {
      set({ earfcn: val });
    }
  };

  const handleReboot = async () => {
    if (!confirm(`Reboot ${radio.serial}?\n\nThe radio will be unreachable for ~2 minutes.`)) return;
    setRebooting(true);
    try {
      await genieacsApi.reboot(radio.id);
      toast.success(`${radio.serial}: reboot queued.`);
    } catch (err: any) {
      toast.error(`Reboot failed: ${err?.response?.data?.error ?? err?.message}`);
    } finally { setRebooting(false); }
  };

  const handleRf = async (enable: boolean) => {
    if (!enable && !confirm(`Disable RF on ${radio.serial}?`)) return;
    setRfBusy(true);
    try {
      await genieacsApi.setRfSercomm(radio.id, enable);
      toast.success(`${radio.serial}: RF ${enable ? 'enabled' : 'disabled'}.`);
      setTimeout(onRefresh, 5000);
    } catch (err: any) {
      toast.error(`RF set failed: ${err?.response?.data?.error ?? err?.message}`);
    } finally { setRfBusy(false); }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error('Geolocation not supported'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => {
        set({
          latitude:  pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        });
        toast.success(`Location set: ${pos.coords.latitude.toFixed(5)}°, ${pos.coords.longitude.toFixed(5)}°`);
        setLocating(false);
      },
      err => { toast.error(`Location error: ${err.message}`); setLocating(false); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const handlePushConfig = async () => {
    const input = formToInput(form);
    if (!input.mmeIp || !input.mcc || !input.mnc || !input.tac) {
      toast.error('MCC, MNC, TAC and MME IP are required');
      return;
    }
    if (earfcnError) {
      toast.error(earfcnError);
      return;
    }
    setPreviewLoading(true);
    try {
      const preview = await genieacsApi.previewSercomm(radio.id, { ...input, sasServerUrl: form.sasServerUrl });
      setPreviewTasks(preview.tasks);
    } catch (err: any) {
      toast.error(`Preview failed: ${err?.response?.data?.error ?? err?.message}`);
    } finally { setPreviewLoading(false); }
  };

  return (
    <>
      {previewTasks && (
        <ProvisionConfirmModal
          deviceId={radio.id}
          serial={radio.serial}
          tasks={previewTasks}
          onClose={() => setPreviewTasks(null)}
          onSuccess={() => {
            // Freeze form for 90s so the poll doesn't reload stale GenieACS cache
            // values before the radio has rebooted and reported back its new state.
            pushFreezeUntil.current = Date.now() + 120_000;
            setPreviewTasks(null);
            setExpanded(false);
            setTimeout(() => onRefresh(), 15_000);
          }}
        />
      )}

      <div className="border border-nms-border rounded-lg overflow-hidden">
        {/* Summary row */}
        <button
          className="w-full flex items-center gap-3 px-4 py-3 bg-nms-surface hover:bg-nms-surface-2 transition-colors text-left"
          onClick={handleExpand}
        >
          <RfDot status={radio.rfStatus} />
          <Radio className="w-4 h-4 text-nms-accent flex-shrink-0" />
          <span className="font-mono text-sm text-nms-text flex-1 truncate">{radio.serial}</span>
          {radio.ip && <span className="text-xs text-nms-text-dim font-mono">{radio.ip}</span>}
          <span className={clsx(
            'text-xs px-2 py-0.5 rounded-full flex items-center gap-1',
            radio.lastInform ? 'bg-green-500/15 text-green-400' : 'bg-nms-surface-2 text-nms-text-dim',
          )}>
            <Clock className="w-3 h-3" />
            {formatLastInform(radio.lastInform)}
          </span>
          {summoning && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20 flex items-center gap-1">
              <RefreshCw className="w-3 h-3 animate-spin" />
              syncing
            </span>
          )}
          {expanded && !summoning && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              editing
            </span>
          )}
          <span className="text-xs text-nms-text-dim font-mono hidden md:inline">
            EARFCN {radio.earfcn || '—'}/{radio.earfcn2 || '—'}
          </span>
          <span className="text-xs text-nms-text-dim font-mono hidden md:inline">
            PCI {radio.pci || '—'}
          </span>
          <button
            onClick={e => { e.stopPropagation(); handleReboot(); }}
            disabled={rebooting}
            className="p-1 rounded hover:bg-nms-surface text-nms-text-dim hover:text-amber-400 transition-colors"
            title="Reboot"
          >
            <RotateCw className={clsx('w-3.5 h-3.5', rebooting && 'animate-spin')} />
          </button>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-nms-text-dim flex-shrink-0" />
            : <ChevronDown className="w-4 h-4 text-nms-text-dim flex-shrink-0" />
          }
        </button>

        {/* Expanded config */}
        {expanded && (
          <div className="px-4 pb-4 pt-3 bg-nms-surface-2 border-t border-nms-border space-y-5">

            {/* Core Network */}
            <div>
              <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
                <Server className="w-3.5 h-3.5 text-nms-accent" />
                Core Network (S1)
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><label className="nms-label">MCC</label>
                  <input className="nms-input font-mono" placeholder="999" value={form.mcc} onChange={e => set({ mcc: e.target.value })} maxLength={3} /></div>
                <div><label className="nms-label">MNC</label>
                  <input className="nms-input font-mono" placeholder="70" value={form.mnc} onChange={e => set({ mnc: e.target.value })} maxLength={3} /></div>
                <div><label className="nms-label">TAC</label>
                  <input className="nms-input font-mono" placeholder="1" value={form.tac} onChange={e => set({ tac: e.target.value })} /></div>
                <div><label className="nms-label">MME IP</label>
                  <input className="nms-input font-mono" placeholder="10.0.1.2" value={form.mmeIp} onChange={e => set({ mmeIp: e.target.value })} /></div>
              </div>
            </div>

            {/* Radio Configuration */}
            <div>
              <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
                <Wifi className="w-3.5 h-3.5 text-nms-accent" />
                Radio Configuration
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                <div><label className="nms-label">Carrier Number <span className="text-nms-text-dim font-normal">(X_000E8F_Cell_Number)</span></label>
                  <select className="nms-input" value={form.carrierNumber} onChange={e => {
                    const v = e.target.value;
                    const enabling = v === '2';
                    set({
                      carrierNumber: v,
                      caEnable: enabling,
                      // Clear C2 fields when switching to single carrier
                      // Populate C2 fields with sensible defaults when switching to CA
                      earfcn2:       enabling ? (form.earfcn2 || String(parseInt(form.earfcn) + 198)) : '',
                      pci2:          enabling ? (form.pci2   || String(parseInt(form.pci1) + 1))     : '',
                      freqBand2:     enabling ? (form.freqBand2 || form.freqBand1)                   : '',
                      cellIdentity2: enabling ? (form.cellIdentity2 || String(parseInt(form.cellIdentity) + 1)) : '',
                    });
                  }}>
                    <option value="1">1 — Single Carrier</option>
                    <option value="2">2 — Dual Carrier (CA)</option>
                  </select></div>
                <div><label className="nms-label">Bandwidth (MHz)</label>
                  <select className="nms-input" value={form.bandwidth} onChange={e => set({ bandwidth: e.target.value })}>
                    <option value="5">5 MHz</option>
                    <option value="10">10 MHz</option>
                    <option value="15">15 MHz</option>
                    <option value="20">20 MHz</option>
                  </select></div>
                <div><label className="nms-label">Sync Source</label>
                  <select className="nms-input" value={form.syncSource} onChange={e => set({ syncSource: e.target.value })}>
                    <option value="FREE_RUNNING">FREE_RUNNING</option>
                    <option value="GNSS">GNSS (GPS)</option>
                    <option value="PTP">PTP (1588)</option>
                  </select></div>
                <div><label className="nms-label">Freq Band (C1)</label>
                  <input className="nms-input font-mono" placeholder="48" value={form.freqBand1} onChange={e => set({ freqBand1: e.target.value })} /></div>
                <div><label className="nms-label">Freq Band (C2)</label>
                  <input className="nms-input font-mono" placeholder="48" value={form.freqBand2} onChange={e => set({ freqBand2: e.target.value })} /></div>
                <div>
                  <label className="nms-label">EARFCN (C1)</label>
                  <input
                    className={clsx('nms-input font-mono', !earfcn1Valid && form.earfcn && 'border-red-500/60 focus:border-red-500')}
                    placeholder="56000"
                    value={form.earfcn}
                    onChange={e => handleEarfcn1Change(e.target.value)}
                  />
                </div>
                <div>
                  <label className="nms-label">EARFCN (C2) {form.caEnable && <span className="text-nms-text-dim font-normal">— auto C1+198</span>}</label>
                  <input
                    className={clsx('nms-input font-mono', form.caEnable && !caSpacingValid && earfcn2Valid && 'border-amber-500/60 focus:border-amber-500')}
                    placeholder="56198"
                    value={form.earfcn2}
                    onChange={e => set({ earfcn2: e.target.value })}
                    disabled={form.caEnable && earfcn1Valid}
                    title={form.caEnable ? `Must be C1 + ${CA_SPACING} = ${earfcn1Valid ? earfcn1Num + CA_SPACING : '?'}` : ''}
                  />
                </div>
                {earfcnError && (
                  <div className="col-span-2 flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {earfcnError}
                  </div>
                )}
                <div><label className="nms-label">Cell Identity</label>
                  <input className="nms-input font-mono" placeholder="138777000" value={form.cellIdentity} onChange={e => set({ cellIdentity: e.target.value })} /></div>
                <div><label className="nms-label">Cell Identity 2</label>
                  <input className="nms-input font-mono" placeholder="138777001" value={form.cellIdentity2} onChange={e => set({ cellIdentity2: e.target.value })} /></div>
                <div><label className="nms-label">PCI (C1)</label>
                  <input className="nms-input font-mono" placeholder="361" value={form.pci1} onChange={e => set({ pci1: e.target.value })} /></div>
                <div><label className="nms-label">PCI (C2)</label>
                  <input className="nms-input font-mono" placeholder="362" value={form.pci2} onChange={e => set({ pci2: e.target.value })} /></div>
                <div><label className="nms-label">TX Power (dBm)</label>
                  <input className="nms-input font-mono" placeholder="13" value={form.txPower} onChange={e => set({ txPower: e.target.value })} /></div>
              </div>
              <div className="flex flex-wrap gap-5 mt-3">
                <label className="flex items-center gap-2 cursor-pointer opacity-60">
                  <input type="checkbox" checked disabled className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent" />
                  <LabelWithTooltip tooltip="AdminState is set automatically as the final step after push — always enabled">
                    <span className="text-xs text-nms-text">Admin State</span>
                  </LabelWithTooltip>
                </label>
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input type="checkbox" checked={form.caEnable} onChange={e => {
                    const v = e.target.checked;
                    set({
                      caEnable: v, carrierNumber: v ? '2' : '1',
                      earfcn2:       v ? (form.earfcn2 || String(parseInt(form.earfcn) + 198)) : '',
                      pci2:          v ? (form.pci2   || String(parseInt(form.pci1) + 1))     : '',
                      freqBand2:     v ? (form.freqBand2 || form.freqBand1)                   : '',
                      cellIdentity2: v ? (form.cellIdentity2 || String(parseInt(form.cellIdentity) + 1)) : '',
                    });
                  }}
                    className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                  <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">Carrier Aggregation</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input type="checkbox" checked={form.enable256QAM} onChange={e => set({ enable256QAM: e.target.checked })}
                    className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                  <LabelWithTooltip tooltip="Sets PDSCH.X_000E8F_Enable256QAM — enables 256QAM downlink modulation when UE supports it">
                    <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">256QAM DL</span>
                  </LabelWithTooltip>
                </label>
              </div>
            </div>

            {/* Location & SAS */}
            <div>
              <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
                <MapPin className="w-3.5 h-3.5 text-nms-accent" />
                Location &amp; SAS
              </p>

              {/* Row 1 — SAS mode fields */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div><label className="nms-label">Method</label>
                  <select className="nms-input" value={form.sasMethod} onChange={e => set({ sasMethod: e.target.value })}>
                    <option value="0">0 — Direct SAS</option>
                    <option value="1">1 — Domain Proxy</option>
                  </select></div>
                <div><label className="nms-label">Installation Method</label>
                  <select className="nms-input" value={form.sasInstallMethod} onChange={e => set({ sasInstallMethod: e.target.value })}>
                    <option value="0">Single-Step</option>
                    <option value="1">Multi-Step</option>
                  </select></div>
                <div><label className="nms-label">Category</label>
                  <select className="nms-input" value={form.sasCategory} onChange={e => set({ sasCategory: e.target.value })}>
                    <option value="A">A — Indoor / low power</option>
                    <option value="B">B — Outdoor / high power</option>
                  </select></div>
                <div><label className="nms-label">Channel Type</label>
                  <select className="nms-input" value={form.sasChannelType} onChange={e => set({ sasChannelType: e.target.value })}>
                    <option value="GAA">GAA</option>
                    <option value="PAL">PAL</option>
                  </select></div>
              </div>

              {/* Row 2 — Location fields */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                <div><label className="nms-label">Location</label>
                  <select className="nms-input" value={form.sasLocation} onChange={e => set({ sasLocation: e.target.value })}>
                    <option value="indoor">Indoor</option>
                    <option value="outdoor">Outdoor</option>
                  </select></div>
                <div><label className="nms-label">Location Source</label>
                  <select className="nms-input" value={form.sasLocationSource} onChange={e => set({ sasLocationSource: e.target.value })}>
                    <option value="0">Manual</option>
                    <option value="1">GPS</option>
                  </select></div>
                <div><label className="nms-label">Height Type</label>
                  <select className="nms-input" value={form.sasHeightType} onChange={e => set({ sasHeightType: e.target.value })}>
                    <option value="AGL">AGL (Above Ground Level)</option>
                    <option value="AMSL">AMSL (Above Mean Sea Level)</option>
                  </select></div>
                <div className="flex items-end">
                  <button onClick={useMyLocation} disabled={locating}
                    className="nms-btn border border-nms-accent/30 hover:border-nms-accent/60 text-nms-accent text-xs flex items-center gap-2 w-full justify-center">
                    <Locate className={clsx('w-3.5 h-3.5', locating && 'animate-spin')} />
                    {locating ? 'Locating…' : 'Use My Location'}
                  </button>
                </div>
              </div>

              {/* Row 3 — Lat/Long */}
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div><label className="nms-label">Latitude (decimal degrees)</label>
                  <input className="nms-input font-mono" placeholder="43.375246" value={form.latitude} onChange={e => set({ latitude: e.target.value })} /></div>
                <div><label className="nms-label">Longitude (decimal degrees)</label>
                  <input className="nms-input font-mono" placeholder="-72.180291" value={form.longitude} onChange={e => set({ longitude: e.target.value })} /></div>
              </div>
              <p className="text-xs text-nms-text-dim mt-1">Decimal degrees — converted to microdegrees automatically on push.</p>

              {/* Row 4 — User ID + Server URL + ICG Group ID */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <div>
                  <label className="nms-label">SAS User ID <span className="text-nms-text-dim font-normal">(UserContactInformation)</span></label>
                  <input className="nms-input font-mono" value={form.sasUserId} onChange={e => set({ sasUserId: e.target.value })} placeholder="256000" />
                </div>
                <div>
                  <label className="nms-label">SAS Server URL</label>
                  <input className="nms-input font-mono text-xs" value={form.sasServerUrl} onChange={e => set({ sasServerUrl: e.target.value })} placeholder="https://172.16.0.168:8443/sas/v1.2" />
                </div>
              </div>
              <div className="mt-3">
                <label className="nms-label">ICG Group ID <span className="text-nms-text-dim font-normal">(ICGGroupId — interference coordination group name sent to SAS)</span></label>
                <input className="nms-input font-mono" value={form.sasIcgGroupId} onChange={e => set({ sasIcgGroupId: e.target.value })} placeholder="Leave blank for no group" />
              </div>

              {/* Row 5 — Checkboxes */}
              <div className="flex flex-wrap gap-5 mt-3">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input type="checkbox" checked={form.sasManufacturerPrefix} onChange={e => set({ sasManufacturerPrefix: e.target.checked })}
                    className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                  <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">
                    Manufacturer Prefix <span className="text-nms-text-dim">(prepend &quot;Sercomm-&quot; to serial)</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input type="checkbox" checked={form.sasCpiEnable} onChange={e => set({ sasCpiEnable: e.target.checked })}
                    className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                  <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">
                    CPI Required <span className="text-nms-text-dim">(Cat B outdoor only)</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input type="checkbox" checked={form.sasPeerCertVerify} onChange={e => set({ sasPeerCertVerify: e.target.checked })}
                    className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                  <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">
                    Verify SAS Cert <span className="text-nms-text-dim">(disable for self-signed)</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input type="checkbox" checked={form.sasEnable} onChange={e => set({ sasEnable: e.target.checked })}
                    className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                  <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">
                    Enable SAS
                  </span>
                </label>
              </div>
            </div>

            {/* Security Algorithms */}
            <div>
              <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-nms-accent" />
                Security Algorithms
              </p>
              <p className="text-xs text-nms-text-dim mb-3">
                Drag to reorder — first item has highest priority. Click <strong className="text-nms-text">+</strong> to restore a removed algorithm.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <AlgorithmDndList
                  label="Ciphering Algorithms"
                  trParam="AllowedCipheringAlgorithmList"
                  allOptions={ALL_CIPHERING}
                  active={form.cipheringAlgorithms}
                  onChange={v => set({ cipheringAlgorithms: v })}
                />
                <AlgorithmDndList
                  label="Integrity Algorithms"
                  trParam="AllowedIntegrityProtectionAlgorithmList"
                  allOptions={ALL_INTEGRITY}
                  active={form.integrityAlgorithms}
                  onChange={v => set({ integrityAlgorithms: v })}
                />
              </div>
            </div>

            {/* Auto-set info */}
            <div className="text-xs text-nms-text-dim bg-nms-surface rounded px-3 py-2 border border-nms-border">
              <span className="font-semibold text-nms-text">Auto-set on push: </span>
              S1 port 36412 · TDD SubFrame 2 · SpecialSubframe 7 · GPS scan on boot ·
              PerfMgmt enabled · Tunnel IPv4 · Periodic inform 5s · FCC ID P27-SCE4255W ·
              UserIDSelectMethod=0 (Manual) · AdminState (after reboot)
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handleRf(false)}
                disabled={rfBusy || radio.rfStatus === 'offline'}
                className="nms-btn border border-red-500/40 text-red-400 hover:bg-red-500/10 flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <WifiOff className="w-4 h-4" />
                RF Off
              </button>
              <button
                onClick={() => handleRf(true)}
                disabled={rfBusy || radio.rfStatus === 'on'}
                className="nms-btn border border-green-500/40 text-green-400 hover:bg-green-500/10 flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Wifi className="w-4 h-4" />
                RF On
              </button>
              <button onClick={handleReboot} disabled={rebooting}
                className="nms-btn border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed">
                <RotateCw className={clsx('w-4 h-4', rebooting && 'animate-spin')} />
                {rebooting ? 'Rebooting…' : 'Reboot'}
              </button>
              <div className="flex-1" />
              <button onClick={handlePushConfig} disabled={previewLoading} className="nms-btn-primary flex items-center gap-2">
                {previewLoading
                  ? <><RefreshCw className="w-4 h-4 animate-spin" />Building preview…</>
                  : <><Send className="w-4 h-4" />Push Config via ACS</>
                }
              </button>
            </div>

          </div>
        )}
      </div>
    </>
  );
};

// ─── Main tab ──────────────────────────────────────────────────────────────────
export function FemtoConfigTab() {
  const [radios, setRadios]         = useState<SercommRadio[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [mmeIpDefault, setMmeIpDefault] = useState('');
  // Device Identity — shared card above radio list
  const [mac, setMac]                           = useState('');
  const [derivedRootPass, setDerivedRootPass]   = useState('');
  const [derivedWebuiPass, setDerivedWebuiPass] = useState('');
  const [showDerivedPasses, setShowDerivedPasses] = useState(false);
  const [showWebUIModal, setShowWebUIModal]       = useState(false);
  const [showCwmpModal, setShowCwmpModal]         = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDevices = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const devices = await genieacsApi.getSercommDevices();
      setRadios(devices);
    } catch (err: any) {
      if (!silent) setError(err?.response?.data?.error ?? err?.message ?? 'Failed to reach GenieACS NBI');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const handleMacChange = async (value: string) => {
    setMac(value);
    setDerivedRootPass('');
    setDerivedWebuiPass('');
    const creds = await fetchDerivedCredentials(value);
    if (creds) { setDerivedRootPass(creds.rootPass); setDerivedWebuiPass(creds.webuiPass); }
  };

  const handleRebootAll = async () => {
    if (!confirm(`Reboot ALL ${radios.length} radio(s)?\n\nAll radios will be unreachable for ~2 minutes.`)) return;
    setGlobalBusy(true);
    try {
      const results = await Promise.allSettled(radios.map(r => genieacsApi.reboot(r.id)));
      const failed  = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) toast.success(`All ${radios.length} radios queued for reboot.`);
      else toast.error(`${failed} reboot(s) failed.`);
    } catch (err: any) {
      toast.error(`Reboot all failed: ${err?.message}`);
    } finally { setGlobalBusy(false); }
  };

  const handleRfAll = async (enable: boolean) => {
    const warn = enable ? '' : '\n\n⚠️ This will kill all active cells immediately.';
    if (!confirm(`${enable ? 'Enable' : 'Disable'} RF on ALL ${radios.length} radio(s)?${warn}`)) return;
    setGlobalBusy(true);
    try {
      const r = await genieacsApi.setRfSercommAll(enable);
      toast.success(`RF ${enable ? 'enabled' : 'disabled'} on ${r.affected} radio(s).`);
      setTimeout(() => fetchDevices(true), 5000);
    } catch (err: any) {
      toast.error(`RF all failed: ${err?.message}`);
    } finally { setGlobalBusy(false); }
  };

  useEffect(() => {
    configApi.getAll().then(configs => {
      const ip = (configs.mme as any)?.mme?.s1ap?.server?.[0]?.address || '';
      if (ip) setMmeIpDefault(ip);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchDevices();
    pollRef.current = setInterval(() => fetchDevices(true), POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchDevices]);

  return (
    <div className="space-y-4">
      {showCwmpModal && (
        <CwmpScreenshotsModal
          acsUrl={`http://${window.location.hostname}:7547`}
          onClose={() => setShowCwmpModal(false)}
        />
      )}

      {showWebUIModal && (
        <SercommWebUIModal
          ip=""
          rootPass={derivedRootPass}
          webuiPass={derivedWebuiPass}
          onClose={() => setShowWebUIModal(false)}
        />
      )}

      {/* Beta warning */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/40">
        <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-red-400">⚠️ Beta / Under Construction</p>
          <p className="text-xs text-red-300/80 mt-0.5">
            Tested on Sercomm SCE4255W / FreedomFi running stock firmware only —
            other models or firmware versions may not work correctly.
          </p>
        </div>
      </div>

      {/* Description */}
      <div className="nms-card border-nms-accent/30 bg-nms-accent/5">
        <div className="flex items-start gap-3">
          <Radio className="w-5 h-5 text-nms-accent mt-0.5 flex-shrink-0" />
          <div className="w-full">
            <h3 className="text-sm font-semibold text-nms-text mb-1">Sercomm / FreedomFi CBRS eNodeB Provisioning via GenieACS</h3>
            <p className="text-xs text-nms-text-dim leading-relaxed mb-3">
              Provision <span className="text-nms-text font-medium">FreedomFi</span>,{' '}
              <span className="text-nms-text font-medium">Moso Labs</span>, and{' '}
              <span className="text-nms-text font-medium">Sercomm SCE4255W</span> CBRS small cells
              via GenieACS TR-069. Point the radio at this ACS, then select it from the list below and click Push Config.
            </p>

            {/* ACS URL */}
            <div className="bg-nms-bg border border-nms-border rounded-md px-3 py-2.5 mb-4">
              <p className="text-xs font-medium text-nms-text mb-1">ACS URL</p>
              <p className="font-mono text-sm text-nms-accent select-all">
                {`http://${window.location.hostname}:7547`}
              </p>
            </div>

            {/* Two-column setup instructions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

              {/* Method 1 — SSH */}
              <div className="bg-nms-bg border border-nms-border rounded-md px-3 py-3 space-y-2">
                <p className="text-xs font-semibold text-nms-text flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-nms-accent" />
                  Method 1 — SSH (no WebUI needed)
                </p>
                <p className="text-xs text-nms-text-dim">SSH as root and run these commands:</p>
                <div className="space-y-1 font-mono text-xs">
                  {[
                    `femto_cli sset Device.ManagementServer.URL="http://${window.location.hostname}:7547"`,
                    'femto_cli sset Device.ManagementServer.EnableCWMP="1"',
                    'femto_cli sset Device.ManagementServer.PeriodicInformEnable="1"',
                    'femto_cli sset Device.ManagementServer.PeriodicInformInterval="3600"',
                    'femto_cli fsave',
                    'reboot',
                  ].map((cmd, i) => (
                    <div key={i} className="flex items-center gap-1 bg-nms-surface rounded px-2 py-1">
                      <span className="flex-1 text-nms-accent break-all">{cmd}</span>
                      <CopyBtn text={cmd} />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-nms-text-dim pt-1">
                  Need the root password?{' '}
                  <button onClick={() => setShowWebUIModal(true)} className="text-nms-accent hover:text-nms-accent/80 underline underline-offset-2">
                    Generate from MAC address
                  </button>
                </p>
              </div>

              {/* Method 2 — WebUI */}
              <div className="bg-nms-bg border border-nms-border rounded-md px-3 py-3 space-y-2">
                <p className="text-xs font-semibold text-nms-text flex items-center gap-1.5">
                  <Wifi className="w-3.5 h-3.5 text-nms-accent" />
                  Method 2 — WebUI
                </p>
                <p className="text-xs text-nms-text-dim">Log into the radio WebUI and navigate to:</p>
                <div className="space-y-1 text-xs">
                  <div className="bg-nms-surface rounded px-2 py-1 text-nms-text">
                    Management → TR-069 / ACS
                  </div>
                  <div className="text-nms-text-dim pt-1 space-y-0.5">
                    <p>• <span className="text-nms-text">ACS URL</span> → paste the URL above</p>
                    <p>• <span className="text-nms-text">Enable CWMP</span> → checked</p>
                    <p>• <span className="text-nms-text">Periodic Inform</span> → checked</p>
                    <p>• <span className="text-nms-text">Periodic Inform Interval</span> → 5</p>
                    <p>• Save and reboot</p>
                  </div>
                </div>
                <p className="text-xs text-nms-text-dim pt-1">
                  WebUI not enabled?{' '}
                  <button onClick={() => setShowWebUIModal(true)} className="text-nms-accent hover:text-nms-accent/80 underline underline-offset-2">
                    How to enable it
                  </button>
                </p>
                <p className="text-xs text-nms-text-dim">
                  <button onClick={() => setShowCwmpModal(true)} className="text-nms-accent hover:text-nms-accent/80 underline underline-offset-2 flex items-center gap-1">
                    <Monitor className="w-3 h-3" />
                    View WebUI screenshots
                  </button>
                </p>
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* ── Device Identity ── above radio list */}
      <div className="nms-card">
        <p className="text-xs font-semibold text-nms-text mb-3 flex items-center gap-2">
          <Server className="w-3.5 h-3.5 text-nms-accent" />
          Device Identity
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="nms-label">MAC Address</label>
            <input
              className="nms-input font-mono"
              value={mac}
              onChange={e => handleMacChange(e.target.value)}
              placeholder="3C:62:F0:AA:AA:AA"
            />
            <p className="text-xs text-nms-text-dim mt-1">Enter MAC to generate SSH / WebUI credentials</p>
          </div>
          {(derivedRootPass || derivedWebuiPass) ? (
            <div className="bg-nms-accent/5 border border-nms-accent/20 rounded-lg px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-nms-text">Generated Credentials</p>
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowDerivedPasses(v => !v)}
                    className="text-xs text-nms-text-dim hover:text-nms-accent flex items-center gap-1">
                    {showDerivedPasses ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    {showDerivedPasses ? 'Hide' : 'Show'}
                  </button>
                  <button onClick={() => setShowWebUIModal(true)}
                    className="text-xs text-nms-accent hover:text-nms-accent/80 flex items-center gap-1">
                    <HelpCircle className="w-3 h-3" />
                    Enable WebUI
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-nms-text-dim">Root SSH</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <p className="font-mono text-xs text-nms-text flex-1 truncate">
                      {showDerivedPasses ? derivedRootPass : '•'.repeat(derivedRootPass.length)}
                    </p>
                    {showDerivedPasses && <CopyBtn text={derivedRootPass} />}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-nms-text-dim">Debug WebUI</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <p className="font-mono text-xs text-nms-text flex-1 truncate">
                      {showDerivedPasses ? derivedWebuiPass : '•'.repeat(derivedWebuiPass.length)}
                    </p>
                    {showDerivedPasses && <CopyBtn text={derivedWebuiPass} />}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center">
              <button onClick={() => setShowWebUIModal(true)}
                className="text-xs text-nms-accent hover:text-nms-accent/80 flex items-center gap-1">
                <HelpCircle className="w-3 h-3" />
                How to enable the WebUI
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Header + action buttons ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-nms-text flex items-center gap-2">
            <Radio className="w-4 h-4 text-nms-accent" />
            Connected Radios
            {radios.length > 0 && (
              <span className="text-xs text-nms-text-dim font-normal">({radios.length})</span>
            )}
          </h2>
          <p className="text-xs text-nms-text-dim mt-0.5">Status refreshes every 30s · click a row to edit · <span className="text-amber-400">auto-refresh pauses while a card is open</span></p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`http://${window.location.hostname}:7000`}
            target="_blank" rel="noopener noreferrer"
            className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 flex items-center gap-2 text-sm"
          >
            <ExternalLink className="w-4 h-4" />
            GenieACS UI
          </a>
          <button onClick={() => fetchDevices()} disabled={loading}
            className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 flex items-center gap-2 text-sm">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
            Refresh
          </button>
          <button onClick={() => handleRfAll(false)} disabled={globalBusy || radios.length === 0}
            className="nms-btn border border-red-500/40 text-red-400 hover:bg-red-500/10 flex items-center gap-2 text-sm">
            <WifiOff className="w-4 h-4" />
            RF Off — All
          </button>
          <button onClick={() => handleRfAll(true)} disabled={globalBusy || radios.length === 0}
            className="nms-btn border border-green-500/40 text-green-400 hover:bg-green-500/10 flex items-center gap-2 text-sm">
            <Wifi className="w-4 h-4" />
            RF On — All
          </button>
          <button onClick={handleRebootAll} disabled={globalBusy || radios.length === 0}
            className="nms-btn border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 flex items-center gap-2 text-sm">
            <RotateCw className={clsx('w-4 h-4', globalBusy && 'animate-spin')} />
            Reboot All
          </button>
        </div>
      </div>

      {/* Status dot legend */}
      <div className="flex items-center gap-4 text-xs text-nms-text-dim">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> RF On</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> RF Off (radio up)</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> Offline</span>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Could not reach GenieACS NBI</p>
            <p className="text-xs mt-0.5 text-red-400/80">{error}</p>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && !error && (
        <div className="flex items-center justify-center h-32 text-nms-text-dim">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">Loading devices from GenieACS…</span>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && radios.length === 0 && (
        <div className="flex flex-col items-center justify-center h-40 text-nms-text-dim border border-dashed border-nms-border rounded-lg">
          <Radio className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-sm">No Sercomm/FreedomFi radios found in GenieACS</p>
          <p className="text-xs mt-1 opacity-60">Point a radio at ACS port 7547 to get started</p>
        </div>
      )}

      {/* Radio list */}
      {!loading && !error && radios.length > 0 && (
        <div className="space-y-2">
          {radios.map(radio => (
            <SercommRadioRow
              key={radio.id}
              radio={radio}
              mmeIpDefault={mmeIpDefault}
              onRefresh={() => fetchDevices(true)}
            />
          ))}
        </div>
      )}

      {/* Info box */}
      <div className="nms-card bg-amber-500/5 border-amber-500/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-nms-text-dim space-y-1">
            <p><span className="font-semibold text-nms-text">Push Config via ACS</span> shows a preview of the exact GenieACS NBI API calls — you can edit the JSON before confirming.</p>
            <p>Sequence: setParameterValues (all params, queued) → reboot (explicit, wakes radio) → setParameterValues (AdminState = 1, fires on first inform after reboot). CA_Enable and Cell_Number only take effect after reboot via their _InUse shadow params.</p>
            <p>Enter the radio's MAC address above to generate SSH root and debug WebUI credentials automatically.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
