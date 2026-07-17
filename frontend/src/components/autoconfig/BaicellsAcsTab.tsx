import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Radio, RefreshCw, Send, ChevronDown, ChevronUp,
  AlertCircle, Clock, ExternalLink, RotateCw, Wifi, WifiOff,
  Satellite, Users, Signal, Copy, Check,
} from 'lucide-react';
import { genieacsApi, radioTagsApi, BaicellsRadio, ProvisionInput, NbiTask } from '../../api';
import { sasApi } from '../../api/sas';
import { useTopologyStore } from '../../stores';
import { ProvisionConfirmModal } from './ProvisionConfirmModal';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

const POLL_INTERVAL_MS = 30_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatLastInform(ts: string | null): string {
  if (!ts) return 'Never';
  const d    = new Date(ts);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

// ─── Copy button ──────────────────────────────────────────────────────────────
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copyToClipboard = useCopyToClipboard();
  return (
    <button
      onClick={async () => {
        const ok = await copyToClipboard(text);
        if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
        else toast.error('Copy failed — please copy manually');
      }}
      className="p-1 rounded hover:bg-nms-surface text-nms-text-dim hover:text-nms-accent transition-colors flex-shrink-0"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// ─── SAS grant cross-check ───────────────────────────────────────────────────
// GenieACS's cached sasEnableMode is only as reliable as the radio's own
// self-report — Baicells firmware has been observed to keep operating on a
// previously-granted channel even after enableMode is toggled off (no
// relinquish/reboot forces re-sync). Cross-checking against our own SAS
// server's grant records catches that kind of drift independently of what
// the radio itself claims.
interface CbsdGrant {
  state: string;
  grantExpireTime: string;
  operationParam?: { operationFrequencyRange?: { lowFrequency: number; highFrequency: number } };
}
interface CbsdWithGrants {
  cbsdSerialNumber: string;
  fccId: string;
  grants: CbsdGrant[];
}
interface GrantCrossCheck {
  status: 'ok' | 'mismatch';
  message: string;
}

function crossCheckGrant(radio: BaicellsRadio, cbsds: CbsdWithGrants[]): GrantCrossCheck {
  const cbsd = cbsds.find(c =>
    c.cbsdSerialNumber === radio.serial && (!radio.sasFccId || c.fccId === radio.sasFccId),
  );
  if (!cbsd) return { status: 'ok', message: '' };

  const now = Date.now();
  const activeGrants = (cbsd.grants || []).filter(
    g => g.state !== 'TERMINATED' && new Date(g.grantExpireTime).getTime() > now,
  );
  const isSasMode = radio.sasEnableMode === '2';

  if (isSasMode && activeGrants.length === 0) {
    return {
      status: 'mismatch',
      message: 'Radio reports SAS mode 2, but no active grant is on file for this CBSD in the SAS server.',
    };
  }

  if (!isSasMode && activeGrants.length > 0) {
    const g       = activeGrants[0];
    const lowMhz  = (g.operationParam?.operationFrequencyRange?.lowFrequency  ?? 0) / 1e6;
    const highMhz = (g.operationParam?.operationFrequencyRange?.highFrequency ?? 0) / 1e6;
    const expiry  = new Date(g.grantExpireTime).toLocaleString();
    return {
      status: 'mismatch',
      message: `Radio reports SAS enableMode ${radio.sasEnableMode} (not mode 2), but the SAS server has an active grant on ${lowMhz}–${highMhz} MHz (expires ${expiry}). The radio is likely still operating on that grant — the enableMode flag is stale. Push Config with SAS mode 2 to resync it.`,
    };
  }

  if (isSasMode && activeGrants.length > 0) {
    const g          = activeGrants[0];
    const lowMhz     = (g.operationParam?.operationFrequencyRange?.lowFrequency  ?? 0) / 1e6;
    const highMhz    = (g.operationParam?.operationFrequencyRange?.highFrequency ?? 0) / 1e6;
    const grantCenter = (lowMhz + highMhz) / 2;
    const liveEarfcn  = parseFloat(radio.earfcn || '0');
    if (liveEarfcn > 0) {
      const liveFreq = 3550 + 0.1 * (liveEarfcn - 55240);
      if (Math.abs(liveFreq - grantCenter) > 0.5) {
        return {
          status: 'mismatch',
          message: `Live EARFCN ${radio.earfcn} (${liveFreq.toFixed(1)} MHz) doesn't match the active grant's channel (${lowMhz}–${highMhz} MHz, center ${grantCenter.toFixed(1)} MHz).`,
        };
      }
    }
  }

  return { status: 'ok', message: '' };
}

function RfDot({ status }: { status: BaicellsRadio['rfStatus'] }) {
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

// ─── Editable form state ──────────────────────────────────────────────────────
interface RadioForm {
  mcc: string; mnc: string; tac: string; mmeIp: string;
  bandwidthMhz: string; earfcn: string; cellId: string; pci: string; band: string;
  txPower: string;
  // SAS fields
  sasEnableMode: string;        // '0'=off '1'=OMC DP '2'=direct SAS
  sasServerUrl: string;
  sasUserId: string;
  sasFccId: string;
  sasCallSign: string;
  sasGroupType: string;
  sasGroupId: string;
  sasLegacyMode: boolean;
  sasRegistrationType: string;
  sasReqLowFrequency: string;   // MHz 3550-3700
  sasReqHighFrequency: string;  // MHz 3550-3700
  sasPreferredFrequency: string; // MHz
  sasPreferredBandwidth: string; // n25/n50/n75/n100
  sasPreferredPower: string;     // 17-43 dBm
  sasFrequencySelectionLogic: string;
  sasMaxEIRP: string;            // 0-37 dBm/MHz
  sasEirpCapability: string;     // dBm/10MHz
}

function radioToForm(r: BaicellsRadio): RadioForm {
  return {
    mcc: r.mcc, mnc: r.mnc, tac: r.tac, mmeIp: r.mmeIp,
    bandwidthMhz: r.bandwidthMhz, earfcn: r.earfcn, cellId: r.cellId, pci: r.pci, band: r.band,
    txPower: r.txPower,
    sasEnableMode:              r.sasEnableMode || '2',
    sasServerUrl:               r.sasServerUrl  || `http://${window.location.hostname}:8888/sas/v1.2/`,
    sasUserId:                  r.sasUserId     || '256000',
    sasFccId:                   r.sasFccId      || '2AG32PBS3101S',
    sasCallSign:                r.sasCallSign   || '',
    sasGroupType:               r.sasGroupType  || 'INTERFERENCE_COORDINATION',
    sasGroupId:                 r.sasGroupId    || 'baicells',
    sasLegacyMode:              r.sasLegacyMode === 'true' || r.sasLegacyMode === '1',
    sasRegistrationType:        r.sasRegistrationType        || 'Single-step',
    // Normalize reqLow/HighFrequency — radio may have old bad Hz values (3550000000)
    // Data model says MHz range 3550-3700, so if value > 10000 it's been set incorrectly in Hz
    sasReqLowFrequency:  (() => { const v = parseFloat(r.sasReqLowFrequency || '3560'); return String(v > 10000 ? Math.round(v / 1e6) : v); })(),
    sasReqHighFrequency: (() => { const v = parseFloat(r.sasReqHighFrequency || '3580'); return String(v > 10000 ? Math.round(v / 1e6) : v); })(),
    // PreferredFrequency format is 'pvalue:svalue' e.g. '3590:3590' (primary:secondary cell)
    sasPreferredFrequency: r.sasPreferredFrequency || '3570:3570',
    sasPreferredBandwidth:      r.sasPreferredBandwidth      || 'n100',
    sasPreferredPower:          r.sasPreferredPower          || '20',
    sasFrequencySelectionLogic: r.sasFrequencySelectionLogic || 'Frequency,Bandwidth,Power',
    sasMaxEIRP:                 r.sasMaxEIRP                 || '20',
    sasEirpCapability:          r.sasEirpCapability          || '23',
  };
}

function formToInput(f: RadioForm): ProvisionInput {
  return {
    mcc: f.mcc.trim(), mnc: f.mnc.trim(), mmeIp: f.mmeIp.trim(),
    tac: parseInt(f.tac), bandwidthMhz: parseInt(f.bandwidthMhz),
    earfcn: parseInt(f.earfcn), cellId: parseInt(f.cellId),
    pci: parseInt(f.pci), band: parseInt(f.band),
    txPower: parseInt(f.txPower),
    sasEnableMode:              f.sasEnableMode,
    sasServerUrl:               f.sasServerUrl.trim(),
    sasUserId:                  f.sasUserId.trim(),
    sasFccId:                   f.sasFccId.trim(),
    sasCallSign:                f.sasCallSign.trim(),
    sasGroupType:               f.sasGroupType.trim(),
    sasGroupId:                 f.sasGroupId.trim(),
    sasLegacyMode:              f.sasLegacyMode,
    sasRegistrationType:        f.sasRegistrationType,
    sasReqLowFrequency:         f.sasReqLowFrequency.trim(),
    sasReqHighFrequency:        f.sasReqHighFrequency.trim(),
    sasPreferredFrequency:      f.sasPreferredFrequency.trim(),
    sasPreferredBandwidth:      f.sasPreferredBandwidth,
    sasPreferredPower:          f.sasPreferredPower.trim(),
    sasFrequencySelectionLogic: f.sasFrequencySelectionLogic,
    sasMaxEIRP:                 f.sasMaxEIRP.trim(),
    sasEirpCapability:          f.sasEirpCapability.trim(),
  };
}

// ─── Band 48 EARFCN table (3GPP TS 36.101) ──────────────────────────────────
// F_MHz = 3550 + 0.1 × (EARFCN - 55240)
// Baicells valid range: EARFCN 55340 (3560 MHz) to 56640 (3690 MHz)
// PreferredFrequency field takes the center frequency in MHz
const BAND48_EARFCN_OPTIONS: { earfcn: number; freqMhz: number }[] = (() => {
  const opts = [];
  for (let earfcn = 55340; earfcn <= 56640; earfcn += 50) {
    const freqMhz = parseFloat((3550 + 0.1 * (earfcn - 55240)).toFixed(1));
    opts.push({ earfcn, freqMhz });
  }
  return opts;
})();

const BAND42_EARFCN_OPTIONS: { earfcn: number; freqMhz: number }[] = (() => {
  const opts = [];
  // Band 42: F = 3400 + 0.1*(EARFCN - 41590), range 41590-43589
  for (let earfcn = 41590; earfcn <= 43589; earfcn += 50) {
    const freqMhz = parseFloat((3400 + 0.1 * (earfcn - 41590)).toFixed(1));
    opts.push({ earfcn, freqMhz });
  }
  return opts;
})();

const BAND43_EARFCN_OPTIONS: { earfcn: number; freqMhz: number }[] = (() => {
  const opts = [];
  // Band 43: F = 3600 + 0.1*(EARFCN - 43590), range 43590-45589
  for (let earfcn = 43590; earfcn <= 45589; earfcn += 50) {
    const freqMhz = parseFloat((3600 + 0.1 * (earfcn - 43590)).toFixed(1));
    opts.push({ earfcn, freqMhz });
  }
  return opts;
})();

// ─── Band preset defaults ─────────────────────────────────────────────────────
// CRITICAL RULES (learned from BaiBLQ_3.0.12):
// 1. SAS grant band must NOT overlap other bands or radio picks the wrong band
// 2. Band 48 safe zone: 3550-3600 MHz (below Band 43 start at 3600 MHz)
// 3. reqLow/reqHigh must match SAS grant band exactly
// 4. LegacyMode: true = Band 42/43, false = Band 48
// 5. FreqBandIndicator must match the band you intend to operate on
const BAND_PRESETS: Record<string, {
  label: string;
  band: string;
  legacyMode: boolean;
  reqLow: string;    // MHz
  reqHigh: string;   // MHz
  prefFreq: string;  // pvalue:svalue MHz
  earfcn: string;    // center EARFCN
  earfcnOptions: { earfcn: number; freqMhz: number }[];
}> = {
  '42': {
    label: 'Band 42 (3400–3600 MHz)',
    band: '42',
    legacyMode: true,
    reqLow:  '3400',   // Full Band 42 low — pure Band 42, no overlap with B43/B48
    reqHigh: '3420',   // 20 MHz channel
    prefFreq: '3410:3410',
    earfcn:  '41790',  // F = 3400 + 0.1*(41790-41590) = 3420 MHz center
    earfcnOptions: BAND42_EARFCN_OPTIONS,
  },
  '43': {
    label: 'Band 43 (3600–3800 MHz)',
    band: '43',
    legacyMode: true,
    reqLow:  '3600',   // Pure Band 43, no overlap with B48 (B48 tops at 3700 MHz)
    reqHigh: '3620',   // 20 MHz channel
    prefFreq: '3610:3610',
    earfcn:  '43790',  // F = 3600 + 0.1*(43790-43590) = 3620 MHz center
    earfcnOptions: BAND43_EARFCN_OPTIONS,
  },
  '48': {
    label: 'Band 48 / CBRS (3550–3700 MHz)',
    band: '48',
    legacyMode: false,
    reqLow:  '3560',   // SAFE ZONE: below Band 43 start (3600 MHz)
    reqHigh: '3580',   // 20 MHz channel — stays below 3600 so radio uses B48 not B43
    prefFreq: '3570:3570',
    earfcn:  '55440',  // F = 3550 + 0.1*(55440-55240) = 3570 MHz center
    earfcnOptions: BAND48_EARFCN_OPTIONS,
  },
};

// ─── S1 status chips from Open5GS interface-status API ───────────────────────
function S1Chips({ ip }: { ip: string }) {
  const ifStatus = useTopologyStore(s => s.interfaceStatus);
  if (!ifStatus || !ip) return null;
  const s1cRadio = ifStatus.s1mme.connectedEnodebs.find(r => r.ip === ip);
  const s1uRadio = ifStatus.s1u.connectedEnodebs.find(r => r.ip === ip);
  const s1cUp = s1cRadio?.setupSuccess ?? false;
  const s1uUp = s1uRadio?.setupSuccess ?? false;
  return (
    <>
      <span title={s1cUp ? 'S1-C (MME) connected' : 'S1-C not connected'} className={clsx('text-xs font-mono', s1cUp ? 'text-green-400' : 'text-red-400')}>
        S1-C{s1cUp ? '✓' : '✗'}
      </span>
      <span title={s1uUp ? 'S1-U (SGW-U) active' : 'S1-U not active'} className={clsx('text-xs font-mono', s1uUp ? 'text-green-400' : 'text-red-400')}>
        S1-U{s1uUp ? '✓' : '✗'}
      </span>
    </>
  );
}

// ─── Single radio row ─────────────────────────────────────────────────────────
const RadioRow: React.FC<{ radio: BaicellsRadio; onRefresh: () => void; nickname?: string; cbsds: CbsdWithGrants[] }> = ({ radio, onRefresh, nickname, cbsds }) => {
  const [expanded, setExpanded]   = useState(false);
  const [form, setForm]           = useState<RadioForm>(radioToForm(radio));
  const [refreshing, setRefreshing] = useState(false);
  const [rebooting, setRebooting]   = useState(false);
  const [rfBusy, setRfBusy]         = useState(false);
  const [previewTasks, setPreviewTasks] = useState<NbiTask[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Only resync from the radio's ACS-reported state while the card is collapsed.
  // While expanded, the user may be mid-edit — a background poll landing every
  // 30s must not stomp on unsaved changes. Collapsing (or the initial expand,
  // which reads whatever was last synced while collapsed) still picks up
  // fresh data, and an explicit Refresh always re-syncs regardless (see
  // handleRefresh below), so the data is never more than one poll cycle stale.
  useEffect(() => {
    if (!expanded) setForm(radioToForm(radio));
  }, [radio, expanded]);

  const set = (key: keyof RadioForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [key]: e.target.value }));

  // ── Preferred Frequency backfills Req Low/High so users don't have to
  // hand-compute the spectrumInquiry range that matches their channel pick ──
  const handlePreferredFrequencyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setForm(f => {
      if (!value) return { ...f, sasPreferredFrequency: value };
      const center = parseFloat(value.split(':')[0]);
      const bw     = parseFloat(f.bandwidthMhz) || 20;
      if (isNaN(center)) return { ...f, sasPreferredFrequency: value };
      const low  = Math.max(3550, +(center - bw / 2).toFixed(1));
      const high = Math.min(3700, +(center + bw / 2).toFixed(1));
      return {
        ...f,
        sasPreferredFrequency: value,
        sasReqLowFrequency:  String(low),
        sasReqHighFrequency: String(high),
      };
    });
  };

  // ── Band preset auto-fill ────────────────────────────────────────────────
  const applyBandPreset = (bandNum: string) => {
    const preset = BAND_PRESETS[bandNum];
    if (!preset) return;
    setForm(f => ({
      ...f,
      band:                 preset.band,
      sasLegacyMode:        preset.legacyMode,
      sasReqLowFrequency:   preset.reqLow,
      sasReqHighFrequency:  preset.reqHigh,
      sasPreferredFrequency: preset.prefFreq,
      // Only update EARFCN if SAS mode 2 is not active
      ...(f.sasEnableMode !== '2' ? { earfcn: preset.earfcn } : {}),
    }));
    toast.success(`Band ${bandNum} preset applied — review and push config`);
  };

  // Derive current EARFCN options based on selected band
  const currentBandPreset = BAND_PRESETS[form.band];
  const earfcnOptions = currentBandPreset?.earfcnOptions ?? BAND48_EARFCN_OPTIONS;

  // Warn if EARFCN doesn’t match the selected band
  const earfcnMismatch = (() => {
    const e = parseInt(form.earfcn);
    if (!e || !form.band) return false;
    if (form.band === '42') return e < 41590 || e > 43589;
    if (form.band === '43') return e < 43590 || e > 45589;
    if (form.band === '48') return e < 55240 || e > 56739;
    return false;
  })();

  // Cross-check GenieACS's reported SAS state against our own SAS server's
  // actual grant records — catches a stale enableMode flag (see B0669 case:
  // radio kept operating on a valid grant after enableMode reverted to 0).
  const grantCheck = crossCheckGrant(radio, cbsds);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await genieacsApi.forceRefresh(radio.id);
      toast.success(`${radio.serial}: connection request sent, refreshing in 10s…`);
      setTimeout(onRefresh, 10000);
    } catch (err: any) {
      toast.error(`Refresh failed: ${err?.response?.data?.error ?? err?.message ?? 'Unknown error'}`);
    } finally { setRefreshing(false); }
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
      await genieacsApi.setRf(radio.id, enable);
      toast.success(`${radio.serial}: RF ${enable ? 'enabled' : 'disabled'}.`);
      setTimeout(onRefresh, 5000);
    } catch (err: any) {
      toast.error(`RF set failed: ${err?.response?.data?.error ?? err?.message}`);
    } finally { setRfBusy(false); }
  };

  const handlePushConfig = async () => {
    const input = formToInput(form);
    if (Object.values(input).some(v => v === '' || (typeof v === 'number' && isNaN(v)))) {
      toast.error('All fields are required');
      return;
    }
    setPreviewLoading(true);
    try {
      const preview = await genieacsApi.preview(radio.id, input);
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
          onSuccess={() => { setPreviewTasks(null); setExpanded(false); onRefresh(); }}
        />
      )}

      <div className="border border-nms-border rounded-lg overflow-hidden">
        {/* ── Summary row ── */}
        <button
          className="w-full flex items-center gap-3 px-4 py-3 bg-nms-surface hover:bg-nms-surface-2 transition-colors text-left"
          onClick={() => setExpanded(e => !e)}
        >
          <RfDot status={radio.rfStatus} />
          <Radio className="w-4 h-4 text-nms-accent flex-shrink-0" />
          <span className="font-mono text-sm text-nms-text truncate">{radio.serial}</span>
          <span className="flex-1" />
          {nickname && <span className="text-xs text-nms-text-dim font-mono">{nickname}</span>}
          {radio.ip && (
            <span className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
              <span className="text-xs text-nms-text-dim font-mono">{radio.ip}</span>
              <CopyBtn text={radio.ip} />
            </span>
          )}
          <span className={clsx(
            'text-xs font-mono flex items-center gap-1',
            parseInt(radio.ueCount || '0') > 0 ? 'text-green-400' : 'text-nms-text-dim',
          )} title="Active UEs">
            <Users className="w-3 h-3" />{radio.ueCount || '0'}
          </span>
          <S1Chips ip={radio.ip} />
          <span className={clsx(
            'text-xs px-2 py-0.5 rounded-full flex items-center gap-1',
            radio.lastInform ? 'bg-green-500/15 text-green-400' : 'bg-nms-surface-2 text-nms-text-dim',
          )}>
            <Clock className="w-3 h-3" />
            {formatLastInform(radio.lastInform)}
          </span>
          <span className="text-xs font-mono"
            title={grantCheck.status === 'mismatch'
              ? `⚠ SAS cross-check mismatch: ${grantCheck.message}`
              : radio.sasEnableMode === '2'
                ? `SAS-granted EARFCN calculated from req ${radio.sasReqLowFrequency}–${radio.sasReqHighFrequency} MHz`
                : 'EARFCN from TR-069'}>
            {(() => {
              const mismatchClass = grantCheck.status === 'mismatch' ? 'text-amber-400' : undefined;
              if (radio.sasEnableMode === '2') {
                // Calculate EARFCN from center of SAS req frequency range
                const low  = parseFloat(radio.sasReqLowFrequency  || '0');
                const high = parseFloat(radio.sasReqHighFrequency || '0');
                if (low > 0 && high > 0) {
                  // Values from radio are in MHz (3550-3700 range)
                  const centerMhz = (low + high) / 2;
                  const earfcn = Math.round(55240 + (centerMhz - 3550) * 10);
                  return (
                    <span className={mismatchClass ?? 'text-nms-accent'}>
                      EARFCN {earfcn}
                      <span className="text-nms-text-dim ml-1">{mismatchClass ? '(SAS ⚠)' : '(SAS)'}</span>
                    </span>
                  );
                }
              }
              return (
                <span className={mismatchClass ?? 'text-nms-text-dim'}>
                  EARFCN {radio.earfcn || '—'}
                  {mismatchClass && <span className="ml-1">⚠</span>}
                </span>
              );
            })()}
          </span>
          <span className="text-xs text-nms-text-dim font-mono">PCI {radio.pci || '—'}</span>
          {/* Per-row action buttons — stop propagation so they don't expand the row */}
          <button
            onClick={e => { e.stopPropagation(); handleRefresh(); }}
            disabled={refreshing}
            className="p-1 rounded hover:bg-nms-surface text-nms-text-dim hover:text-nms-accent transition-colors"
            title="Force inform — refresh values from device"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-nms-text-dim flex-shrink-0" />
            : <ChevronDown className="w-4 h-4 text-nms-text-dim flex-shrink-0" />
          }
        </button>

        {/* ── Edit form ── */}
        {expanded && (
          <div className="px-4 pb-4 pt-3 bg-nms-surface-2 border-t border-nms-border space-y-4">

            {/* Live Status — only shown when the radio has full parameter tree */}
            {(radio.mmeStatus || radio.uptime || radio.gpsStatus || radio.latitude) && (
              <div className="bg-nms-surface rounded-lg border border-nms-border p-3">
                <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
                  <Signal className="w-3.5 h-3.5 text-nms-accent" />
                  Live Status
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-1.5 text-xs font-mono">
                  {radio.mmeStatus !== '' && (
                    <div className="flex items-center gap-1.5">
                      <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', radio.mmeStatus === '1' ? 'bg-green-400' : 'bg-red-400')} />
                      <span className="text-nms-text-dim">S1 (MME)</span>
                      <span className={radio.mmeStatus === '1' ? 'text-green-400' : 'text-red-400'}>
                        {radio.mmeStatus === '1' ? 'Connected' : 'Down'}
                      </span>
                    </div>
                  )}
                  {radio.ueCount !== '' && (
                    <div className="flex items-center gap-1.5">
                      <Users className="w-3 h-3 text-nms-text-dim flex-shrink-0" />
                      <span className="text-nms-text-dim">UEs</span>
                      <span className={parseInt(radio.ueCount) > 0 ? 'text-green-400' : 'text-nms-text'}>
                        {radio.ueCount}
                      </span>
                    </div>
                  )}
                  {radio.gpsStatus !== '' && (
                    <div className="flex items-center gap-1.5">
                      <Satellite className="w-3 h-3 text-nms-text-dim flex-shrink-0" />
                      <span className="text-nms-text-dim">GPS</span>
                      <span className={radio.gpsStatus === '1' ? 'text-green-400' : 'text-amber-400'}>
                        {radio.gpsStatus === '1' ? `Locked` : 'Searching'}
                        {radio.gpsSatCount ? ` (${radio.gpsSatCount} sv)` : ''}
                      </span>
                    </div>
                  )}
                  {radio.uptime !== '' && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-nms-text-dim flex-shrink-0" />
                      <span className="text-nms-text-dim">Uptime</span>
                      <span className="text-nms-text">{radio.uptime}</span>
                    </div>
                  )}
                  {radio.latitude !== '' && radio.longitude !== '' && (
                    <div className="flex items-center gap-1.5 col-span-2">
                      <span className="text-nms-text-dim">GPS Coords</span>
                      <span className="text-nms-text">
                        {parseFloat(radio.latitude).toFixed(6)}, {parseFloat(radio.longitude).toFixed(6)}
                      </span>
                    </div>
                  )}
                  {radio.swVersion !== '' && (
                    <div className="flex items-center gap-1.5 col-span-2">
                      <span className="text-nms-text-dim">SW</span>
                      <span className="text-nms-text">{radio.swVersion}</span>
                      {radio.hwVersion !== '' && (
                        <><span className="text-nms-text-dim ml-2">HW</span><span className="text-nms-text">{radio.hwVersion}</span></>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              <div><label className="nms-label">MCC</label>
                <input className="nms-input font-mono" placeholder="999" value={form.mcc} onChange={set('mcc')} maxLength={3} /></div>
              <div><label className="nms-label">MNC</label>
                <input className="nms-input font-mono" placeholder="70" value={form.mnc} onChange={set('mnc')} maxLength={3} /></div>
              <div><label className="nms-label">TAC</label>
                <input className="nms-input font-mono" placeholder="1" type="number" min={1} value={form.tac} onChange={set('tac')} /></div>
              <div><label className="nms-label">MME IP</label>
                <input className="nms-input font-mono" placeholder="10.0.1.2" value={form.mmeIp} onChange={set('mmeIp')} /></div>
              <div><label className="nms-label">Band</label>
                <select className="nms-input font-mono" value={form.band} onChange={e => {
                  set('band')(e);
                  // Don't auto-apply preset on manual band change alone
                }}>
                  <option value="">Select…</option>
                  <option value="42">Band 42 (3.5 GHz)</option>
                  <option value="43">Band 43 (3.7 GHz)</option>
                  <option value="48">Band 48 (CBRS)</option>
                </select>
                <button
                  type="button"
                  onClick={() => applyBandPreset(form.band)}
                  disabled={!form.band || !BAND_PRESETS[form.band]}
                  className="mt-1 w-full text-xs px-2 py-1 rounded border border-nms-accent/40 text-nms-accent hover:bg-nms-accent/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Auto-fill Band {form.band || '?'} defaults
                </button>
              </div>
              <div><label className="nms-label">Bandwidth</label>
                <select className="nms-input font-mono" value={form.bandwidthMhz} onChange={set('bandwidthMhz')}>
                  <option value="">Select…</option>
                  <option value="5">5 MHz</option>
                  <option value="10">10 MHz</option>
                  <option value="15">15 MHz</option>
                  <option value="20">20 MHz</option>
                </select></div>
              <div><label className="nms-label">EARFCN (DL = UL)</label>
                <input className="nms-input font-mono" placeholder="56060" type="number" min={0} value={form.earfcn} onChange={set('earfcn')}
                  disabled={form.sasEnableMode === '2'}
                  title={form.sasEnableMode === '2' ? 'EARFCN is managed by SAS in mode 2 — set via Preferred Frequency below' : undefined}
                />
                {form.sasEnableMode === '2' && (
                  <p className="text-xs text-amber-400 mt-1">⚠ SAS mode 2 — EARFCN controlled by SAS grant, not ACS</p>
                )}
                {earfcnMismatch && form.sasEnableMode !== '2' && (
                  <p className="text-xs text-red-400 mt-1">⚠ EARFCN {form.earfcn} is not in Band {form.band} range — use Auto-fill to fix</p>
                )}
              </div>
              <div><label className="nms-label">Cell ID</label>
                <input className="nms-input font-mono" placeholder="256002" type="number" min={0} value={form.cellId} onChange={set('cellId')} /></div>
              <div><label className="nms-label">PCI</label>
                <input className="nms-input font-mono" placeholder="462" type="number" min={0} max={503} value={form.pci} onChange={set('pci')} /></div>
              <div><label className="nms-label">TX Power (dBm)</label>
                <select className="nms-input font-mono" value={form.txPower} onChange={set('txPower')}>
                  <option value="">Select…</option>
                  {[17,18,19,20,21,22,23,24].map(v => (
                    <option key={v} value={String(v)}>{v} dBm</option>
                  ))}
                </select></div>
            </div>

            <div className="text-xs text-nms-text-dim bg-nms-surface rounded px-3 py-2 border border-nms-border">
              <span className="font-semibold text-nms-text">Auto-set on push: </span>
              S1 port 36412 · TDD SubFrame 2 · SpecialSubframe 5 · GPS sync enabled ·
              Self-config EARFCN/PCI disabled · Periodic inform 5s
            </div>

            {/* SAS Configuration */}
            <div>
              <p className="text-xs font-semibold text-nms-text mb-3 flex items-center gap-2">
                <Wifi className="w-3.5 h-3.5 text-nms-accent" />
                SAS (CBRS Spectrum Access)
              </p>

              {/* Enable Mode */}
              <div className="mb-4">
                <label className="nms-label">SAS Mode (enableMode)</label>
                <select className="nms-input max-w-xs" value={form.sasEnableMode} onChange={set('sasEnableMode')}>
                  <option value="0">0 — Disabled</option>
                  <option value="1">1 — Baicells OMC as Domain Proxy</option>
                  <option value="2">2 — Direct SAS Protocol (recommended)</option>
                </select>
                <p className="text-xs text-nms-text-dim mt-1">Use mode 2 for direct connection to this NMS SAS server</p>
              </div>

              {form.sasEnableMode !== '0' && (
                <div className="space-y-4">

                  {/* Identity */}
                  <div>
                    <p className="text-xs font-medium text-nms-text-dim mb-2 uppercase tracking-wide">Identity</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      <div>
                        <label className="nms-label">SAS Server URL</label>
                        <input className="nms-input font-mono text-xs" value={form.sasServerUrl} onChange={set('sasServerUrl')} />
                      </div>
                      <div>
                        <label className="nms-label">User ID</label>
                        <input className="nms-input font-mono" placeholder="256000" value={form.sasUserId} onChange={set('sasUserId')} />
                      </div>
                      <div>
                        <label className="nms-label">FCC ID</label>
                        <input className="nms-input font-mono" placeholder="2AG32PBS3101S" value={form.sasFccId} onChange={set('sasFccId')} />
                      </div>
                      <div>
                        <label className="nms-label">Call Sign <span className="text-nms-text-dim">(optional)</span></label>
                        <input className="nms-input font-mono" placeholder="256000" value={form.sasCallSign} onChange={set('sasCallSign')} />
                      </div>
                      <div>
                        <label className="nms-label">Group Type</label>
                        <select className="nms-input font-mono" value={form.sasGroupType} onChange={set('sasGroupType')}>
                          <option value="">— None —</option>
                          <option value="INTERFERENCE_COORDINATION">INTERFERENCE_COORDINATION</option>
                        </select>
                      </div>
                      <div>
                        <label className="nms-label">Group ID</label>
                        <input className="nms-input font-mono" placeholder="baicells" value={form.sasGroupId} onChange={set('sasGroupId')} />
                      </div>
                    </div>
                  </div>

                  {/* Registration */}
                  <div>
                    <p className="text-xs font-medium text-nms-text-dim mb-2 uppercase tracking-wide">Registration</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="nms-label">Registration Type</label>
                        <select className="nms-input" value={form.sasRegistrationType} onChange={set('sasRegistrationType')}>
                          <option value="Single-step">Single-step</option>
                          <option value="Multi-step">Multi-step (CPI required)</option>
                        </select>
                      </div>
                      <div>
                        <label className="nms-label">EIRP Capability (dBm/10MHz)</label>
                        <input className="nms-input font-mono" placeholder="23" type="number" min={-127} max={47}
                          value={form.sasEirpCapability} onChange={set('sasEirpCapability')} />
                        <p className="text-xs text-nms-text-dim mt-1">Reported to SAS at registration</p>
                      </div>
                      <div>
                        <label className="nms-label">Max EIRP (dBm/MHz)</label>
                        <input className="nms-input font-mono" placeholder="20" type="number" min={0} max={37}
                          value={form.sasMaxEIRP} onChange={set('sasMaxEIRP')} />
                        <p className="text-xs text-nms-text-dim mt-1">Cat A: 0-20, Cat B: 0-37</p>
                      </div>
                    </div>
                  </div>

                  {/* Frequency */}
                  <div>
                    <p className="text-xs font-medium text-nms-text-dim mb-2 uppercase tracking-wide">Frequency (MHz)</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      <div>
                        <label className="nms-label">Req Low Frequency (MHz)</label>
                        <input className="nms-input font-mono" placeholder="3550" type="number" min={3550} max={3700}
                          value={form.sasReqLowFrequency} onChange={set('sasReqLowFrequency')} />
                        <p className="text-xs text-nms-text-dim mt-1">Lower bound for spectrumInquiry</p>
                      </div>
                      <div>
                        <label className="nms-label">Req High Frequency (MHz)</label>
                        <input className="nms-input font-mono" placeholder="3700" type="number" min={3550} max={3700}
                          value={form.sasReqHighFrequency} onChange={set('sasReqHighFrequency')} />
                        <p className="text-xs text-nms-text-dim mt-1">Upper bound for spectrumInquiry</p>
                      </div>
                      <div>
                        <label className="nms-label">Preferred Frequency (Primary:Secondary)</label>
                        <select className="nms-input font-mono" value={form.sasPreferredFrequency} onChange={handlePreferredFrequencyChange}>
                          <option value="">— None —</option>
                          {earfcnOptions.map(({ earfcn, freqMhz }) => (
                            <option key={earfcn} value={`${freqMhz}:${freqMhz}`}>EARFCN {earfcn} — {freqMhz} MHz</option>
                          ))}
                        </select>
                        <p className="text-xs text-nms-text-dim mt-1">Format: primary:secondary — options shown for Band {form.band || '48'}. Selecting a value auto-fills Req Low/High Frequency below to match.</p>
                      </div>
                      <div>
                        <label className="nms-label">Preferred Bandwidth</label>
                        <select className="nms-input" value={form.sasPreferredBandwidth} onChange={set('sasPreferredBandwidth')}>
                          <option value="n25">n25 — 5 MHz</option>
                          <option value="n50">n50 — 10 MHz</option>
                          <option value="n75">n75 — 15 MHz</option>
                          <option value="n100">n100 — 20 MHz</option>
                        </select>
                      </div>
                      <div>
                        <label className="nms-label">Preferred Power (dBm)</label>
                        <input className="nms-input font-mono" placeholder="20" type="number" min={17} max={43}
                          value={form.sasPreferredPower} onChange={set('sasPreferredPower')} />
                      </div>
                      <div>
                        <label className="nms-label">Frequency Selection Logic</label>
                        <select className="nms-input text-xs" value={form.sasFrequencySelectionLogic} onChange={set('sasFrequencySelectionLogic')}>
                          <option value="Frequency,Bandwidth,Power">Freq → BW → Power</option>
                          <option value="Frequency,Power,Bandwidth">Freq → Power → BW</option>
                          <option value="Bandwidth,Frequency,Power">BW → Freq → Power</option>
                          <option value="Bandwidth,Power,Frequency">BW → Power → Freq</option>
                          <option value="Power,Bandwidth,Frequency">Power → BW → Freq</option>
                          <option value="Power,Frequency,Bandwidth">Power → Freq → BW</option>
                        </select>
                        <p className="text-xs text-nms-text-dim mt-1">Priority order for grant negotiation</p>
                      </div>
                    </div>
                  </div>

                  {/* Flags */}
                  <div className="flex flex-wrap gap-5">
                    <label className="flex items-center gap-2 cursor-pointer group">
                      <input type="checkbox" checked={form.sasLegacyMode}
                        onChange={e => setForm(f => ({ ...f, sasLegacyMode: e.target.checked }))}
                        className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                      <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">
                        Legacy Mode <span className="text-nms-text-dim">(true = Band 42/43, false = Band 48)</span>
                      </span>
                    </label>
                  </div>

                </div>
              )}
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

              <button
                onClick={handleReboot}
                disabled={rebooting}
                className="nms-btn border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RotateCw className={clsx('w-4 h-4', rebooting && 'animate-spin')} />
                {rebooting ? 'Rebooting…' : 'Reboot'}
              </button>

              <div className="flex-1" />

              <button
                onClick={handlePushConfig}
                disabled={previewLoading}
                className="nms-btn-primary flex items-center gap-2"
              >
                {previewLoading
                  ? <><RefreshCw className="w-4 h-4 animate-spin" />Building preview…</>
                  : <><Send className="w-4 h-4" />Push Config &amp; Reboot</>
                }
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

// ─── Main tab ────────────────────────────────────────────────────────────────
export const BaicellsAcsTab: React.FC = () => {
  const [radios, setRadios]   = useState<BaicellsRadio[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [radioTags, setRadioTags]   = useState<Record<string, string>>({});
  const [cbsds, setCbsds] = useState<CbsdWithGrants[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchInterfaceStatus = useTopologyStore(s => s.fetchInterfaceStatus);

  const fetchDevices = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const devices = await genieacsApi.getDevices();
      setRadios(devices);
    } catch (err: any) {
      if (!silent) setError(err?.response?.data?.error ?? err?.message ?? 'Failed to reach GenieACS NBI');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const fetchCbsds = useCallback(async () => {
    try {
      const data = await sasApi.getCbsds();
      if (data?.success) setCbsds(data.cbsds ?? []);
    } catch {
      // Cross-check is a nice-to-have — if the SAS admin API is unreachable,
      // just skip it silently rather than surfacing an error banner for it.
    }
  }, []);

  useEffect(() => { radioTagsApi.getAll().then(setRadioTags).catch(() => {}); }, []);

  // Initial load + 30s polling
  useEffect(() => {
    fetchDevices();
    fetchInterfaceStatus();
    fetchCbsds();
    pollRef.current = setInterval(() => { fetchDevices(true); fetchInterfaceStatus(); fetchCbsds(); }, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchDevices, fetchInterfaceStatus, fetchCbsds]);

  const handleRebootAll = async () => {
    if (!confirm(`Reboot ALL ${radios.length} radio(s)?\n\nAll radios will be unreachable for ~2 minutes.`)) return;
    setGlobalBusy(true);
    try {
      const r = await genieacsApi.rebootAll();
      if (r.success) toast.success(`All ${r.rebooted} radios queued for reboot.`);
      else toast.error(`Reboot all: ${r.failures.length} failure(s). Check audit log.`);
    } catch (err: any) {
      toast.error(`Reboot all failed: ${err?.response?.data?.error ?? err?.message}`);
    } finally { setGlobalBusy(false); }
  };

  const handleRfAll = async (enable: boolean) => {
    const verb = enable ? 'Enable RF on' : 'Disable RF on';
    const warn = enable ? '' : '\n\n⚠️ This will kill all active cells immediately.';
    if (!confirm(`${verb} ALL ${radios.length} radio(s)?${warn}`)) return;
    setGlobalBusy(true);
    try {
      const r = await genieacsApi.setRfAll(enable);
      if (r.success) toast.success(`RF ${enable ? 'enabled' : 'disabled'} on ${r.affected} radio(s).`);
      else toast.error(`RF all: ${r.failures.length} failure(s). Check audit log.`);
      setTimeout(() => fetchDevices(true), 5000);
    } catch (err: any) {
      toast.error(`RF all failed: ${err?.response?.data?.error ?? err?.message}`);
    } finally { setGlobalBusy(false); }
  };

  return (
    <div className="space-y-4">
      {/* Beta warning */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/40">
        <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-red-400">⚠️ Beta / Under Construction</p>
          <p className="text-xs text-red-300/80 mt-0.5">
            Tested on Baicells Nova 430i running BaiBLQ_3.0.12 firmware only —
            other models or firmware versions may not work correctly.
          </p>
        </div>
      </div>

      {/* Description */}
      <div className="nms-card border-nms-accent/30 bg-nms-accent/5">
        <div className="flex items-start gap-3">
          <Radio className="w-5 h-5 text-nms-accent mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-1">Baicells eNodeB Provisioning via GenieACS</h3>
            <p className="text-xs text-nms-text-dim leading-relaxed mb-3">
              Provision Baicells LTE eNodeBs via the GenieACS TR-069 ACS. Tested on the{' '}
              <span className="text-nms-text font-medium">Baicells Nova 430i</span> running{' '}
              <span className="text-nms-text font-medium">BaiBLQ_3.0.12</span> firmware.
              Once connected, select a radio below, fill in the parameters, and click Push Config &amp; Reboot.
              A preview modal shows the exact NBI API calls before anything is sent.
            </p>
            <div className="bg-nms-bg border border-nms-border rounded-md px-3 py-2.5 space-y-1.5">
              <p className="text-xs font-medium text-nms-text">ACS URL — enter this on the radio:</p>
              <p className="font-mono text-sm text-nms-accent select-all">
                {`http://${window.location.hostname}:7547`}
              </p>
              <p className="text-xs text-nms-text-dim">
                On the radio WebUI:{' '}
                <span className="text-nms-text">BTS Settings</span>
                {' → '}
                <span className="text-nms-text">Management Server</span>
                {' → paste the URL above into the '}
                <span className="text-nms-text">Management Server URL</span>
                {' box.'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Header — buttons */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-nms-text flex items-center gap-2">
            <Radio className="w-4 h-4 text-nms-accent" />
            Connected Radios
            {radios.length > 0 && (
              <span className="text-xs text-nms-text-dim font-normal">({radios.length})</span>
            )}
          </h2>
          <p className="text-xs text-nms-text-dim mt-0.5">Status refreshes every 30s · click a row to edit</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={`http://${window.location.hostname}:7000`}
            target="_blank"
            rel="noopener noreferrer"
            className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 flex items-center gap-2 text-sm"
          >
            <ExternalLink className="w-4 h-4" />
            GenieACS UI
          </a>

          <button
            onClick={() => fetchDevices()}
            disabled={loading}
            className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 flex items-center gap-2 text-sm"
          >
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
            Refresh
          </button>

          <button
            onClick={() => handleRfAll(false)}
            disabled={globalBusy || radios.length === 0}
            className="nms-btn border border-red-500/40 text-red-400 hover:bg-red-500/10 flex items-center gap-2 text-sm"
          >
            <WifiOff className="w-4 h-4" />
            RF Off — All
          </button>

          <button
            onClick={() => handleRfAll(true)}
            disabled={globalBusy || radios.length === 0}
            className="nms-btn border border-green-500/40 text-green-400 hover:bg-green-500/10 flex items-center gap-2 text-sm"
          >
            <Wifi className="w-4 h-4" />
            RF On — All
          </button>

          <button
            onClick={handleRebootAll}
            disabled={globalBusy || radios.length === 0}
            className="nms-btn border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 flex items-center gap-2 text-sm"
          >
            <RotateCw className={clsx('w-4 h-4', globalBusy && 'animate-spin')} />
            Reboot All
          </button>
        </div>
      </div>

      {/* Status dot legend */}
      <div className="flex items-center gap-4 text-xs text-nms-text-dim flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> RF On</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> RF Off (radio up)</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> Offline</span>
        <span className="flex items-center gap-1.5 text-amber-400">EARFCN ⚠ SAS cross-check mismatch — hover for details</span>
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
          <p className="text-sm">No radios found in GenieACS</p>
          <p className="text-xs mt-1 opacity-60">Point a Baicells radio at ACS port 7547 to get started</p>
        </div>
      )}

      {/* Radio list */}
      {!loading && !error && radios.length > 0 && (
        <div className="space-y-2">
          {radios.map(radio => (
            <RadioRow key={radio.id} radio={radio} onRefresh={() => fetchDevices(true)} nickname={radio.ip ? radioTags[radio.ip] : undefined} cbsds={cbsds} />
          ))}
        </div>
      )}

      {/* Info box */}
      <div className="nms-card bg-amber-500/5 border-amber-500/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-nms-text-dim space-y-1">
            <p><span className="font-semibold text-nms-text">Push Config &amp; Reboot</span> shows a preview of the exact GenieACS NBI API calls — you can edit the JSON before confirming.</p>
            <p>Sequence: setParameterValues (all params) → reboot → setParameterValues (RF enable). RF re-enables automatically after boot.</p>
            <p>EARFCN applies to both DL and UL. Bandwidth converts to LTE resource blocks automatically (20 MHz = 100 RBs).</p>
          </div>
        </div>
      </div>
    </div>
  );
};
