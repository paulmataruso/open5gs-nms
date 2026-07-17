import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Radio, MapPin, Wifi, Server, Locate, AlertCircle, Send, RefreshCw,
  ChevronDown, ChevronUp, Clock, ExternalLink, Copy, Check,
  RotateCw, WifiOff, Shield, Layers, Calculator,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { sercommNRApi, radioTagsApi, SercommNRDevice, NRConfigInput } from '../../api';
import { useTopologyStore } from '../../stores';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_NR_SAS_URL = `http://${window.location.hostname}:8899/sas`;

// ─── TDD Patterns ─────────────────────────────────────────────────────────────
// All six named presets have been verified against real hardware (set on the
// radio's own local UI, then read back fresh via GenieACS — see memory
// sercomm-nr-tdd-slot-patterns for the full verification log). "8:2", "3:1",
// "7:3", and "6:4" require pattern 2 — omitting it produced a wrong, non-working
// config even when the pattern-1 numbers were right ("7:3" was wrong on every
// single field, pattern 1 and 2 both). "4:1" and "5:5" don't need pattern 2.
// Only one of the six old hardcoded guesses ("4:1") turned out fully correct —
// don't assume an unverified preset's numbers are right just because they look
// plausible.
const TDD_PATTERNS = [
  { key: 'p82', label: '8:2 — FR1.30-4  (DDDSUUDDD)', numDlSlot: 3, numUlSlot: 2, numDlSymbol: 6, numUlSymbol: 4, np2Pres: 1, numDlSlot2: 4, numUlSlot2: 0, numDlSymbolP2: 0, numUlSymbolP2: 0 },
  { key: 'p31', label: '3:1 — FR1.30-6  (DSSU)', numDlSlot: 1, numUlSlot: 0, numDlSymbol: 10, numUlSymbol: 2, np2Pres: 1, numDlSlot2: 0, numUlSlot2: 1, numDlSymbolP2: 12, numUlSymbolP2: 0 },
  { key: 'p41', label: '4:1 — FR1.30-2  (DDDSU)', numDlSlot: 3, numUlSlot: 1, numDlSymbol: 10, numUlSymbol: 2, np2Pres: 0, numDlSlot2: 0, numUlSlot2: 0, numDlSymbolP2: 0, numUlSymbolP2: 0 },
  { key: 'p55', label: '5:5 — FR1.30-5  (DSUU)', numDlSlot: 1, numUlSlot: 2, numDlSymbol: 12, numUlSymbol: 0, np2Pres: 0, numDlSlot2: 0, numUlSlot2: 0, numDlSymbolP2: 0, numUlSymbolP2: 0 },
  { key: 'p73', label: '7:3 — FR1.30-3  (DDDSUDDSUU)', numDlSlot: 3, numUlSlot: 1, numDlSymbol: 10, numUlSymbol: 2, np2Pres: 1, numDlSlot2: 2, numUlSlot2: 2, numDlSymbolP2: 10, numUlSymbolP2: 2 },
  { key: 'p64', label: '6:4 — CBRSA_1   (DDDSUUUUDD)', numDlSlot: 3, numUlSlot: 4, numDlSymbol: 6, numUlSymbol: 4, np2Pres: 1, numDlSlot2: 2, numUlSlot2: 0, numDlSymbolP2: 0, numUlSymbolP2: 0 },
  { key: 'custom', label: 'Custom (manual entry)', numDlSlot: null, numUlSlot: null, numDlSymbol: null, numUlSymbol: null, np2Pres: null, numDlSlot2: null, numUlSlot2: null, numDlSymbolP2: null, numUlSymbolP2: null },
] as const;

type TddPatternKey = typeof TDD_PATTERNS[number]['key'];

function detectTddPattern(
  dlSlot: string, ulSlot: string, dlSym: string, ulSym: string,
  np2: string, dlSlot2: string, ulSlot2: string, dlSym2: string, ulSym2: string,
): TddPatternKey {
  const dl = parseInt(dlSlot), ul = parseInt(ulSlot), dls = parseInt(dlSym), uls = parseInt(ulSym);
  const np2p = parseInt(np2) || 0, dl2 = parseInt(dlSlot2) || 0, ul2 = parseInt(ulSlot2) || 0, dls2 = parseInt(dlSym2) || 0, uls2 = parseInt(ulSym2) || 0;
  return (TDD_PATTERNS.find(p =>
    p.numDlSlot === dl && p.numUlSlot === ul && p.numDlSymbol === dls && p.numUlSymbol === uls &&
    (p.np2Pres ?? 0) === np2p && (p.numDlSlot2 ?? 0) === dl2 && (p.numUlSlot2 ?? 0) === ul2 &&
    (p.numDlSymbolP2 ?? 0) === dls2 && (p.numUlSymbolP2 ?? 0) === uls2
  )?.key ?? 'custom') as TddPatternKey;
}

// Unlike `parseInt(x) || undefined`, this preserves an explicit "0" as a real value
// instead of treating it as unset (0 is falsy, so `0 || undefined` silently becomes
// undefined — a real bug for TDD fields where several verified presets need 0).
function numOrUndef(s: string): number | undefined {
  if (s === '') return undefined;
  const n = parseInt(s);
  return isNaN(n) ? undefined : n;
}

// ─── NR-ARFCN validation ──────────────────────────────────────────────────────
interface ArfcnCheck {
  valid: boolean;
  error?: string;
  centerMhz?: number;
  lowerMhz?: number;
  upperMhz?: number;
}

const NR_BAND_INFO: Record<number, { minFreq: number; maxFreq: number; freqOffs: number; nRefOffs: number; step: number }> = {
  //                                                     step = ΔF_Global (MHz)
  48: { minFreq: 3550, maxFreq: 3700, freqOffs: 3000, nRefOffs: 600000, step: 0.015 },
  46: { minFreq: 5150, maxFreq: 5925, freqOffs: 3000, nRefOffs: 600000, step: 0.015 },
  96: { minFreq: 5925, maxFreq: 7125, freqOffs: 3000, nRefOffs: 600000, step: 0.015 },
};

// ─── ARFCN Calculator ─────────────────────────────────────────────────────────
const CALC_BWS = [10, 20, 25, 30, 40, 50, 60, 80, 100] as const;
type CalcBw = typeof CALC_BWS[number];

interface ArfcnOption {
  arfcn:    number;
  centerMhz: number;
  lowerMhz:  number;
  upperMhz:  number;
}

function calcArfcnOptions(bwMhz: CalcBw, band: number = 48): ArfcnOption[] {
  const info = NR_BAND_INFO[band];
  if (!info) return [];
  const halfBw    = bwMhz / 2;
  const minCenter = info.minFreq + halfBw;
  const maxCenter = info.maxFreq - halfBw;
  if (minCenter > maxCenter) return [];
  const STEP_MHZ  = 5;
  const options: ArfcnOption[] = [];
  for (let c = minCenter; c <= maxCenter + 0.001; c += STEP_MHZ) {
    const center  = Math.round(c * 1000) / 1000;
    const arfcn   = Math.round((center - info.freqOffs) / info.step) + info.nRefOffs;
    const centerMhz = (arfcn - info.nRefOffs) * info.step + info.freqOffs;
    options.push({ arfcn, centerMhz, lowerMhz: centerMhz - halfBw, upperMhz: centerMhz + halfBw });
  }
  return options;
}

function ArfcnCalculator() {
  const [open, setOpen] = useState(false);
  const [bw, setBw]     = useState<CalcBw>(40);
  const [band, setBand] = useState(48);
  const options = calcArfcnOptions(bw, band);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 flex items-center gap-2 text-sm"
      >
        <Calculator className="w-4 h-4" />
        ARFCN Calculator
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-nms-bg border border-nms-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-nms-border flex-shrink-0">
              <div className="flex items-center gap-2">
                <Calculator className="w-4 h-4 text-nms-accent" />
                <h3 className="text-sm font-semibold text-nms-text">Center ARFCN Calculator</h3>
              </div>
              <button onClick={() => setOpen(false)} className="text-nms-text-dim hover:text-nms-text text-lg leading-none">&times;</button>
            </div>

            {/* Controls */}
            <div className="px-5 py-4 border-b border-nms-border flex-shrink-0 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-xs text-nms-text-dim whitespace-nowrap w-14">Band</label>
                <select className="nms-input py-1 text-xs font-mono w-36"
                  value={band} onChange={e => setBand(Number(e.target.value))}>
                  {Object.keys(NR_BAND_INFO).map(b => (
                    <option key={b} value={b}>n{b} — {NR_BAND_INFO[Number(b)].minFreq}–{NR_BAND_INFO[Number(b)].maxFreq} MHz</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-xs text-nms-text-dim whitespace-nowrap w-14">Bandwidth</label>
                <div className="flex flex-wrap gap-1">
                  {CALC_BWS.map(b => (
                    <button key={b} onClick={() => setBw(b)}
                      className={clsx(
                        'px-2.5 py-1 rounded text-xs font-mono transition-colors',
                        bw === b
                          ? 'bg-nms-accent text-white'
                          : 'bg-nms-surface border border-nms-border text-nms-text-dim hover:text-nms-text hover:border-nms-accent/50',
                      )}>
                      {b} MHz
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-nms-text-dim font-mono">
                {options.length} valid center{options.length !== 1 ? 's' : ''} for {bw} MHz BW in n{band}
                {NR_BAND_INFO[band] && ` (${NR_BAND_INFO[band].minFreq + bw/2}–${NR_BAND_INFO[band].maxFreq - bw/2} MHz range)`}
              </p>
            </div>

            {/* Results table */}
            <div className="overflow-y-auto flex-1">
              {options.length === 0 ? (
                <p className="text-xs text-red-400 px-5 py-4">{bw} MHz BW does not fit in n{band}</p>
              ) : (
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-nms-bg border-b border-nms-border">
                    <tr className="text-nms-text-dim">
                      <th className="text-left px-5 py-2 font-medium">ARFCN</th>
                      <th className="text-left px-4 py-2 font-medium">Center (MHz)</th>
                      <th className="text-left px-4 py-2 font-medium">Lower Edge</th>
                      <th className="text-left px-4 py-2 font-medium">Upper Edge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {options.map(o => (
                      <tr key={o.arfcn} className="border-b border-nms-border/30 hover:bg-nms-surface transition-colors">
                        <td className="px-5 py-1.5 text-nms-accent font-semibold">{o.arfcn}</td>
                        <td className="px-4 py-1.5 text-nms-text">{o.centerMhz.toFixed(3)}</td>
                        <td className="px-4 py-1.5 text-nms-text-dim">{o.lowerMhz.toFixed(1)}</td>
                        <td className="px-4 py-1.5 text-nms-text-dim">{o.upperMhz.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function validateArfcn(arfcnStr: string, bwMhzStr: string, bandStr: string): ArfcnCheck {
  if (!arfcnStr || arfcnStr === '0') return { valid: true };
  const arfcn = parseInt(arfcnStr);
  const bwMhz = parseInt(bwMhzStr) || 0;
  const band  = parseInt(bandStr);
  if (isNaN(arfcn) || arfcn <= 0) return { valid: false, error: 'ARFCN must be a positive integer' };

  const info = NR_BAND_INFO[band];
  if (!info) {
    // Unknown band — skip deep checks but still flag odd ARFCN for 30 kHz SCS
    if (arfcn % 2 !== 0) {
      return { valid: false, error: `ARFCN ${arfcn} is odd — not on 30 kHz channel raster. Try ${arfcn - 1} or ${arfcn + 1}.` };
    }
    return { valid: true };
  }

  const centerMhz = (arfcn - info.nRefOffs) * info.step + info.freqOffs;
  const lowerMhz  = centerMhz - bwMhz / 2;
  const upperMhz  = centerMhz + bwMhz / 2;

  if (centerMhz < info.minFreq || centerMhz > info.maxFreq) {
    return {
      valid: false,
      error: `ARFCN ${arfcn} → ${centerMhz.toFixed(3)} MHz is outside n${band} (${info.minFreq}–${info.maxFreq} MHz)`,
      centerMhz, lowerMhz, upperMhz,
    };
  }

  // 30 kHz channel raster: ARFCN step = 15 kHz, so 30 kHz raster = even ARFCN
  if (arfcn % 2 !== 0) {
    return {
      valid: false,
      error: `ARFCN ${arfcn} is not on the 30 kHz channel raster — use ${arfcn - 1} or ${arfcn + 1} (${((arfcn - 1 - info.nRefOffs) * info.step + info.freqOffs).toFixed(3)} MHz)`,
      centerMhz, lowerMhz, upperMhz,
    };
  }

  if (bwMhz > 0 && lowerMhz < info.minFreq) {
    return {
      valid: false,
      error: `Lower edge ${lowerMhz.toFixed(1)} MHz is below n${band} minimum ${info.minFreq} MHz — raise ARFCN or reduce BW`,
      centerMhz, lowerMhz, upperMhz,
    };
  }
  if (bwMhz > 0 && upperMhz > info.maxFreq) {
    return {
      valid: false,
      error: `Upper edge ${upperMhz.toFixed(1)} MHz exceeds n${band} maximum ${info.maxFreq} MHz — lower ARFCN or reduce BW`,
      centerMhz, lowerMhz, upperMhz,
    };
  }

  return { valid: true, centerMhz, lowerMhz, upperMhz };
}


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

function getNRRfStatus(d: SercommNRDevice): 'on' | 'off' | 'offline' {
  const fiveMin = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  if (!d.lastInform || d.lastInform < fiveMin) return 'offline';
  return d.nrConfig.adminState === 'UNLOCKED' ? 'on' : 'off';
}

function RfDot({ status }: { status: 'on' | 'off' | 'offline' }) {
  return (
    <span
      title={status === 'on' ? 'RF On (Cell Unlocked)' : status === 'off' ? 'RF Off (Cell Locked)' : 'Offline'}
      className={clsx(
        'inline-block w-2.5 h-2.5 rounded-full flex-shrink-0',
        status === 'on'      && 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]',
        status === 'off'     && 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]',
        status === 'offline' && 'bg-red-500',
      )}
    />
  );
}

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

// ─── Form state ────────────────────────────────────────────────────────────────
interface NRForm {
  mcc: string; mnc: string; tac: string; gnbId: string;
  amfIp: string; upfIp: string;
  snssaiSst: string; snssaiSd: string;
  gNBCUName: string; maxNumUes: string;
  nrPci: string; nrArfcn: string; nrBandWidth: string; nrFreqBand: string;
  txPwr: string; prachCfgIdx: string;
  tddPattern: TddPatternKey;
  numDlSlot: string; numUlSlot: string; numDlSymbol: string; numUlSymbol: string;
  np2Pres: string; numDlSlot2: string; numUlSlot2: string; numDlSymbolP2: string; numUlSymbolP2: string;
  sasEnable: boolean; sasUrl: string; bwAllowList: string[];
  sasCategory: string; sasLocation: string; sasLocationSource: string;
  sasHeightType: string; sasIcgGroupId: string; sasPeerCertVerify: boolean;
  latitude: string; longitude: string;
  antennaGain: string; antennaAzimuth: string; antennaBeamwidth: string;
  antennaDowntilt: string; sasMaxTxPower: string;
  unlockCell: boolean;
  sasUserId: string;
  neaAlgorithm: string; niaAlgorithm: string;
}

function defaultForm(d: SercommNRDevice): NRForm {
  const plmn = d.nrConfig.plmn ?? '';
  const mcc  = plmn.slice(0, 3);
  const mnc  = plmn.slice(3);
  // backend already converts lat/lon from microdegrees to decimal degrees
  const latStr = d.sasConfig.latitude  ? d.sasConfig.latitude.toFixed(6)  : '';
  const lonStr = d.sasConfig.longitude ? d.sasConfig.longitude.toFixed(6) : '';
  return {
    mcc,
    mnc,
    tac:               String(d.nrConfig.tac   || 1),
    gnbId:             String(d.nrConfig.gnbId || 1),
    amfIp:             d.nrConfig.amfIp || '',
    upfIp:             d.nrConfig.upfIp || '',
    snssaiSst:         String(d.nrConfig.snssaiSst ?? 1),
    snssaiSd:          d.nrConfig.snssaiSd || '000001',
    gNBCUName:         d.nrConfig.gNBCUName || 'CU1',
    maxNumUes:         String(d.nrConfig.maxNumUes || 32),
    nrPci:             String(d.nrConfig.nrPci || d.nrConfig.pci || 1),
    nrArfcn:           d.nrConfig.nrArfcn || '',
    nrBandWidth:       String(d.nrConfig.nrBandWidth || 40),
    nrFreqBand:        String(d.nrConfig.nrFreqBand || 48),
    txPwr:             String(d.nrConfig.txPwr || 21),
    prachCfgIdx:       String(d.nrConfig.prachCfgIdx || 154),
    numDlSlot:         String(d.nrConfig.numDlSlot  || 3),
    numUlSlot:         String(d.nrConfig.numUlSlot  || 2),
    numDlSymbol:       String(d.nrConfig.numDlSymbol || 6),
    numUlSymbol:       String(d.nrConfig.numUlSymbol || 4),
    np2Pres:           String(d.nrConfig.np2Pres        ?? 0),
    numDlSlot2:        String(d.nrConfig.numDlSlot2     ?? 0),
    numUlSlot2:        String(d.nrConfig.numUlSlot2     ?? 0),
    numDlSymbolP2:     String(d.nrConfig.numDlSymbolP2  ?? 0),
    numUlSymbolP2:     String(d.nrConfig.numUlSymbolP2  ?? 0),
    tddPattern:        detectTddPattern(
                         String(d.nrConfig.numDlSlot  || 3),
                         String(d.nrConfig.numUlSlot  || 2),
                         String(d.nrConfig.numDlSymbol || 6),
                         String(d.nrConfig.numUlSymbol || 4),
                         String(d.nrConfig.np2Pres       ?? 0),
                         String(d.nrConfig.numDlSlot2    ?? 0),
                         String(d.nrConfig.numUlSlot2    ?? 0),
                         String(d.nrConfig.numDlSymbolP2 ?? 0),
                         String(d.nrConfig.numUlSymbolP2 ?? 0),
                       ),
    sasEnable:         d.sasConfig.enable,
    sasUrl:            d.sasConfig.url || DEFAULT_NR_SAS_URL,
    bwAllowList:       d.sasConfig.bwAllowList
                         ? d.sasConfig.bwAllowList.split(',').map((s: string) => s.trim()).filter(Boolean)
                         : ['100', '40', '20', '10'],
    sasCategory:       d.sasConfig.category   || 'A',
    sasLocation:       d.sasConfig.location   || 'indoor',
    sasLocationSource: '0',
    sasHeightType:     d.sasConfig.heightType || 'AGL',
    sasIcgGroupId:     d.sasConfig.groupId    || '',
    sasPeerCertVerify: d.sasConfig.peerVerify || false,
    latitude:          latStr,
    longitude:         lonStr,
    antennaGain:       String(d.nrConfig.antennaGain ?? 6),
    antennaAzimuth:    String(d.nrConfig.antennaAzimuth ?? 0),
    antennaBeamwidth:  String(d.nrConfig.antennaBeamwidth ?? 60),
    antennaDowntilt:   String(d.nrConfig.antennaDowntilt ?? 0),
    sasMaxTxPower:     String(d.nrConfig.sasMaxTxPower ?? 21),
    unlockCell:        d.nrConfig.adminState === 'UNLOCKED',
    sasUserId:         d.serial,
    neaAlgorithm:      d.nrConfig.encAlg || 'NEA2',
    niaAlgorithm:      d.nrConfig.intAlg || 'NIA2',
  };
}

function computedPlmn(mcc: string, mnc: string): string {
  if (!mcc || !mnc) return '';
  return `${mcc}${mnc.padStart(mnc.length >= 3 ? 3 : 2, '0')}`;
}

function computedNCGI(gnbId: number): string {
  return [1, 2, 3].map(n => (gnbId << 14) | n).join(' / ');
}

// ─── Single radio row ──────────────────────────────────────────────────────────
// ─── N2/N3 status chips from Open5GS interface-status API ───────────────────
function NgChips({ ip }: { ip: string | null }) {
  const ifStatus = useTopologyStore(s => s.interfaceStatus);
  if (!ifStatus || !ip) return null;
  const n2Radio = ifStatus.n2.connectedGnodebs.find(r => r.ip === ip);
  const n3Radio = ifStatus.n3.connectedGnodebs.find(r => r.ip === ip);
  const n2Up = n2Radio?.setupSuccess ?? false;
  const n3Up = n3Radio?.setupSuccess ?? false;
  return (
    <>
      <span title={n2Up ? 'N2 (AMF) connected' : 'N2 not connected'} className={clsx('text-xs font-mono', n2Up ? 'text-green-400' : 'text-red-400')}>
        N2{n2Up ? '✓' : '✗'}
      </span>
      <span title={n3Up ? 'N3 (UPF) active sessions' : 'N3 no active sessions'} className={clsx('text-xs font-mono', n3Up ? 'text-green-400' : 'text-red-400')}>
        N3{n3Up ? '✓' : '✗'}
      </span>
    </>
  );
}

const NRRadioRow: React.FC<{
  device: SercommNRDevice;
  onRefresh: () => void;
  nickname?: string;
}> = ({ device, onRefresh, nickname }) => {
  const rfStatus = getNRRfStatus(device);
  const [expanded, setExpanded]   = useState(false);
  const [form, setForm]           = useState<NRForm>(() => defaultForm(device));
  const [locating, setLocating]   = useState(false);
  const [saving, setSaving]       = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [rfBusy, setRfBusy]       = useState(false);
  const [summoning, setSummoning] = useState(false);
  const pushFreezeUntil  = useRef<number>(0);
  const syncOnNextUpdate = useRef(false);

  useEffect(() => {
    if ((!expanded || syncOnNextUpdate.current) && Date.now() > pushFreezeUntil.current) {
      setForm(defaultForm(device));
      syncOnNextUpdate.current = false;
    }
  }, [device, expanded]);

  const handleExpand = async () => {
    const opening = !expanded;
    setExpanded(e => !e);
    if (!opening) return;
    setSummoning(true);
    syncOnNextUpdate.current = true; // set before await — set() in form changes will clear it
    try {
      await sercommNRApi.refresh(device.id);
      setTimeout(onRefresh, 6000);
    } catch { /* non-critical */ }
    finally { setSummoning(false); }
  };

  const set = (patch: Partial<NRForm>) => {
    syncOnNextUpdate.current = false;
    setForm(f => ({ ...f, ...patch }));
  };

  const handleReboot = async () => {
    if (!confirm(`Reboot ${device.serial}?\n\nThe radio will be unreachable for ~2 minutes.`)) return;
    setRebooting(true);
    try {
      await sercommNRApi.reboot(device.id);
      toast.success(`${device.serial}: reboot queued.`);
    } catch (err: any) {
      toast.error(`Reboot failed: ${err?.message}`);
    } finally { setRebooting(false); }
  };

  const handleRf = async (enable: boolean) => {
    if (!enable && !confirm(`Disable RF on ${device.serial}?`)) return;
    setRfBusy(true);
    try {
      if (enable) await sercommNRApi.unlock(device.id);
      else        await sercommNRApi.lock(device.id);
      toast.success(`${device.serial}: RF ${enable ? 'enabled' : 'disabled'}.`);
      setTimeout(onRefresh, 5000);
    } catch (err: any) {
      toast.error(`RF set failed: ${err?.message}`);
    } finally { setRfBusy(false); }
  };

  const useMyLocation = async () => {
    setLocating(true);
    if (window.isSecureContext && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => {
          set({ latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) });
          toast.success(`Location set: ${pos.coords.latitude.toFixed(5)}°, ${pos.coords.longitude.toFixed(5)}°`);
          setLocating(false);
        },
        () => ipFallback(),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    } else {
      await ipFallback();
    }
  };

  const ipFallback = async () => {
    try {
      const res  = await fetch('https://ipapi.co/json/');
      const data = await res.json();
      if (!data.latitude || !data.longitude) throw new Error('No coordinates');
      set({ latitude: String(data.latitude), longitude: String(data.longitude) });
      toast.success(
        `Location set via IP: ${Number(data.latitude).toFixed(5)}°, ${Number(data.longitude).toFixed(5)}° (${data.city ?? 'approximate'})`,
        { duration: 5000 },
      );
    } catch {
      toast.error('Could not determine location. Enter coordinates manually.');
    } finally {
      setLocating(false);
    }
  };

  const handlePushConfig = async () => {
    if (!form.mcc || !form.mnc || !form.amfIp) {
      toast.error('MCC, MNC, and AMF IP are required');
      return;
    }
    const lat = parseFloat(form.latitude);
    const lon = parseFloat(form.longitude);
    if (form.latitude  && isNaN(lat)) { toast.error('Invalid latitude');  return; }
    if (form.longitude && isNaN(lon)) { toast.error('Invalid longitude'); return; }
    if (form.nrArfcn) {
      const arfcnCheck = validateArfcn(form.nrArfcn, form.nrBandWidth, form.nrFreqBand);
      if (!arfcnCheck.valid) { toast.error(`Cell 1 ARFCN: ${arfcnCheck.error}`); return; }
    }

    setSaving(true);
    try {
      const input: NRConfigInput = {
        mcc:              form.mcc.trim(),
        mnc:              form.mnc.trim(),
        tac:              parseInt(form.tac)       || 1,
        gnbId:            parseInt(form.gnbId)     || 1,
        cellCount:        1,
        amfIp:            form.amfIp.trim(),
        upfIp:            form.upfIp.trim(),
        sasUrl:           form.sasUrl.trim(),
        sasEnable:        form.sasEnable,
        bwAllowList:      form.bwAllowList.join(','),
        sasCategory:      form.sasCategory,
        sasLocation:      form.sasLocation,
        sasLocationSource: form.sasLocationSource,
        sasHeightType:    form.sasHeightType,
        sasIcgGroupId:    form.sasIcgGroupId.trim(),
        sasCellNum:       1,
        sasPeerCertVerify: form.sasPeerCertVerify,
        latitude:         form.latitude  ? lat : 0,
        longitude:        form.longitude ? lon : 0,
        unlockCell:       form.unlockCell,
        sasUserId:        form.sasUserId || device.serial,
        neaAlgorithm:     form.neaAlgorithm,
        niaAlgorithm:     form.niaAlgorithm,
        nrPci:            parseInt(form.nrPci)   || undefined,
        nrArfcn:          form.nrArfcn  ? (parseInt(form.nrArfcn)  || undefined) : undefined,
        nrBandWidth:      parseInt(form.nrBandWidth) || undefined,
        nrFreqBand:       parseInt(form.nrFreqBand)  || undefined,
        txPwr:            parseInt(form.txPwr)       || undefined,
        prachCfgIdx:      parseInt(form.prachCfgIdx) || undefined,
        // NOTE: these 9 fields deliberately use numOrUndef, not `parseInt(x) || undefined`.
        // Several verified presets legitimately need a 0 here (e.g. "3:1"'s numUlSlot=0,
        // "5:5"'s numUlSymbol=0) — `parseInt('0') || undefined` evaluates to undefined
        // (0 is falsy in JS), silently omitting the field, and the backend's hardcoded
        // fallback for that field is non-zero (numUlSlot??2, numUlSymbol??4 etc.), so the
        // wrong value would get pushed even though the form/dropdown showed the right one.
        numDlSlot:        numOrUndef(form.numDlSlot),
        numUlSlot:        numOrUndef(form.numUlSlot),
        numDlSymbol:      numOrUndef(form.numDlSymbol),
        numUlSymbol:      numOrUndef(form.numUlSymbol),
        np2Pres:          numOrUndef(form.np2Pres),
        numDlSlot2:       numOrUndef(form.numDlSlot2),
        numUlSlot2:       numOrUndef(form.numUlSlot2),
        numDlSymbolP2:    numOrUndef(form.numDlSymbolP2),
        numUlSymbolP2:    numOrUndef(form.numUlSymbolP2),
        snssaiSst:        parseInt(form.snssaiSst)   || undefined,
        snssaiSd:         form.snssaiSd.trim()       || undefined,
        gNBCUName:        form.gNBCUName.trim()      || undefined,
        maxNumUes:        parseInt(form.maxNumUes)   || undefined,
        antennaGain:      parseInt(form.antennaGain)      !== undefined ? parseInt(form.antennaGain)      : undefined,
        antennaAzimuth:   parseInt(form.antennaAzimuth)   || undefined,
        antennaBeamwidth: parseInt(form.antennaBeamwidth) || undefined,
        antennaDowntilt:  parseInt(form.antennaDowntilt)  !== undefined ? parseInt(form.antennaDowntilt)  : undefined,
        sasMaxTxPower:    parseInt(form.sasMaxTxPower)    || undefined,
      };
      const r = await sercommNRApi.configure(device.id, input);
      if (r.success) {
        toast.success('Config pushed — summoning radio to apply…');
        pushFreezeUntil.current = Date.now() + 120_000;
        setExpanded(false);
        // After radio has had time to apply the setParameterValues session,
        // trigger a getParameterValues connection_request so GenieACS reads
        // the actual post-config state back from the radio.
        setTimeout(async () => {
          try { await sercommNRApi.refresh(device.id); } catch { /* non-critical */ }
          setTimeout(onRefresh, 8_000);
        }, 7_000);
      } else {
        toast.error(String((r as any).error ?? 'Configure failed'));
      }
    } catch (e: any) {
      toast.error(`Configure failed: ${e?.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSasRestart = async () => {
    try {
      const r = await sercommNRApi.sasRestart(device.id);
      if (r.success) toast.success('SAS client restarted');
      else toast.error('SAS restart failed');
      setTimeout(onRefresh, 5000);
    } catch { toast.error('SAS restart request failed'); }
  };

  const gnbIdNum = parseInt(form.gnbId) || 1;
  const plmn     = computedPlmn(form.mcc, form.mnc);

  return (
    <div className="border border-nms-border rounded-lg overflow-hidden">
      {/* Summary row */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 bg-nms-surface hover:bg-nms-surface-2 transition-colors text-left"
        onClick={handleExpand}
      >
        <RfDot status={rfStatus} />
        <Radio className="w-4 h-4 text-nms-accent flex-shrink-0" />
        <span className="font-mono text-sm text-nms-text truncate">{device.serial}</span>
        <span className="flex-1" />
        {nickname && <span className="text-xs text-nms-text-dim font-mono">{nickname}</span>}
        {device.mac && (
          <span className="hidden sm:flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
            <span className="text-xs text-nms-text-dim font-mono">{device.mac}</span>
            <CopyBtn text={device.mac} />
          </span>
        )}
        {device.ip && (
          <span className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
            <span className="text-xs text-nms-text-dim font-mono">{device.ip}</span>
            <CopyBtn text={device.ip} />
          </span>
        )}
        <span className={clsx(
          'text-xs px-2 py-0.5 rounded-full flex items-center gap-1',
          device.lastInform ? 'bg-green-500/15 text-green-400' : 'bg-nms-surface-2 text-nms-text-dim',
        )}>
          <Clock className="w-3 h-3" />
          {formatLastInform(device.lastInform)}
        </span>
        {summoning && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20 flex items-center gap-1">
            <RefreshCw className="w-3 h-3 animate-spin" />syncing
          </span>
        )}
        {expanded && !summoning && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />editing
          </span>
        )}
        <span className="text-xs text-nms-text-dim font-mono hidden md:inline">
          ARFCN {device.sasStatus.grantedArfcn || '—'}
        </span>
        <NgChips ip={device.ip} />
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

          {/* 1. Core Network */}
          <div>
            <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-nms-accent" />
              Core Network (N2/N3)
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><label className="nms-label">MCC</label>
                <input className="nms-input font-mono" placeholder="999" maxLength={3} value={form.mcc} onChange={e => set({ mcc: e.target.value })} /></div>
              <div><label className="nms-label">MNC</label>
                <input className="nms-input font-mono" placeholder="70" maxLength={3} value={form.mnc} onChange={e => set({ mnc: e.target.value })} /></div>
              <div><label className="nms-label">TAC</label>
                <input className="nms-input font-mono" placeholder="1" value={form.tac} onChange={e => set({ tac: e.target.value })} /></div>
              <div><label className="nms-label">gNB ID</label>
                <input className="nms-input font-mono" placeholder="1" value={form.gnbId} onChange={e => set({ gnbId: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div><label className="nms-label">AMF IP (N2)</label>
                <input className="nms-input font-mono" placeholder="10.0.1.155" value={form.amfIp} onChange={e => set({ amfIp: e.target.value })} /></div>
              <div><label className="nms-label">UPF IP (N3)</label>
                <input className="nms-input font-mono" placeholder="10.0.1.156" value={form.upfIp} onChange={e => set({ upfIp: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              <div>
                <label className="nms-label">S-NSSAI SST <span className="text-nms-text-dim font-normal">(slice type)</span></label>
                <input className="nms-input font-mono" placeholder="1" value={form.snssaiSst} onChange={e => set({ snssaiSst: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">S-NSSAI SD <span className="text-nms-text-dim font-normal">(hex)</span></label>
                <input className="nms-input font-mono" placeholder="19cde1" maxLength={6} value={form.snssaiSd} onChange={e => set({ snssaiSd: e.target.value.toLowerCase() })} />
              </div>
              <div>
                <label className="nms-label">gNB CU Name</label>
                <input className="nms-input font-mono" placeholder="CU1" value={form.gNBCUName} onChange={e => set({ gNBCUName: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">Max UEs</label>
                <input className="nms-input font-mono" placeholder="32" value={form.maxNumUes} onChange={e => set({ maxNumUes: e.target.value })} />
              </div>
            </div>
            {plmn && (
              <div className="text-xs text-nms-text-dim font-mono mt-2 space-y-0.5">
                <div>PLMN: <span className="text-nms-accent">{plmn}</span></div>
                <div>nCGI (cells 1/2/3): <span className="text-nms-accent">{computedNCGI(gnbIdNum)}</span></div>
                {form.snssaiSst && form.snssaiSd && (
                  <div>S-NSSAI: <span className="text-nms-accent">SST:{form.snssaiSst} SD:0x{form.snssaiSd}</span></div>
                )}
              </div>
            )}
          </div>

          {/* 2. Radio (NR) */}
          <div>
            <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
              <Wifi className="w-3.5 h-3.5 text-nms-accent" />
              Radio (NR)
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="nms-label">Center NR-ARFCN</label>
                <input
                  className={clsx(
                    'nms-input font-mono',
                    form.nrArfcn && !validateArfcn(form.nrArfcn, form.nrBandWidth, form.nrFreqBand).valid
                      ? 'border-red-500/70 focus:border-red-500' : '',
                  )}
                  placeholder="641666"
                  value={form.nrArfcn}
                  onChange={e => set({ nrArfcn: e.target.value.replace(/\D/g, '') })}
                />
              </div>
              <div>
                <label className="nms-label">Channel BW <span className="text-nms-text-dim font-normal">(MHz)</span></label>
                <select className="nms-input" value={form.nrBandWidth} onChange={e => set({ nrBandWidth: e.target.value })}>
                  {[10,20,25,30,40,50,60,80,100].map(bw => (
                    <option key={bw} value={String(bw)}>{bw} MHz</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="nms-label">NR Band</label>
                <input className="nms-input font-mono" placeholder="48" value={form.nrFreqBand} onChange={e => set({ nrFreqBand: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">TX Power <span className="text-nms-text-dim font-normal">(dBm)</span></label>
                <input className="nms-input font-mono" placeholder="21" value={form.txPwr} onChange={e => set({ txPwr: e.target.value })} />
              </div>
            </div>

            {/* ARFCN validation + SAS granted display — Cell 1 */}
            {(() => {
              const check = form.nrArfcn ? validateArfcn(form.nrArfcn, form.nrBandWidth, form.nrFreqBand) : null;
              const sasArfcn = device.sasStatus.grantedArfcn;
              const mismatch = sasArfcn && form.nrArfcn && sasArfcn !== form.nrArfcn;
              return (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono">
                  {check && !check.valid && (
                    <span className="text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      {check.error}
                    </span>
                  )}
                  {check && check.valid && check.centerMhz != null && (
                    <span className="text-green-400">
                      ✓ {check.centerMhz.toFixed(3)} MHz · {check.lowerMhz!.toFixed(1)}–{check.upperMhz!.toFixed(1)} MHz
                    </span>
                  )}
                  <span className="text-nms-text-dim">
                    Radio cfg: <span className="text-nms-text">{form.nrArfcn || '—'}</span>
                  </span>
                  <span className="text-nms-text-dim">
                    SAS granted: <span className={mismatch ? 'text-amber-400' : 'text-nms-text'}>{sasArfcn || '—'}</span>
                    {mismatch && <span className="text-amber-400 ml-1">(SAS overrode config)</span>}
                  </span>
                </div>
              );
            })()}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
              <div>
                <label className="nms-label">PCI</label>
                <input className="nms-input font-mono" placeholder="1" value={form.nrPci} onChange={e => set({ nrPci: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">PRACH Cfg Index</label>
                <input className="nms-input font-mono" placeholder="154" value={form.prachCfgIdx} onChange={e => set({ prachCfgIdx: e.target.value })} />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 cursor-pointer group w-full pb-2">
                  <input type="checkbox" checked={form.unlockCell} onChange={e => set({ unlockCell: e.target.checked })}
                    className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                  <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">Unlock Cell</span>
                </label>
              </div>
            </div>
          </div>

          {/* 3. TDD Slot Configuration */}
          <div>
            <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-nms-accent" />
              TDD Slot Configuration <span className="text-nms-text-dim font-normal ml-1">(TimeSlotConfiguration)</span>
            </p>
            <div className="mb-3">
              <label className="nms-label">Pattern Preset</label>
              <select
                className="nms-input"
                value={form.tddPattern}
                onChange={e => {
                  const p = TDD_PATTERNS.find(x => x.key === e.target.value);
                  if (p && p.numDlSlot !== null) {
                    set({
                      tddPattern:    e.target.value as TddPatternKey,
                      numDlSlot:     String(p.numDlSlot),
                      numUlSlot:     String(p.numUlSlot),
                      numDlSymbol:   String(p.numDlSymbol),
                      numUlSymbol:   String(p.numUlSymbol),
                      np2Pres:       String(p.np2Pres ?? 0),
                      numDlSlot2:    String(p.numDlSlot2 ?? 0),
                      numUlSlot2:    String(p.numUlSlot2 ?? 0),
                      numDlSymbolP2: String(p.numDlSymbolP2 ?? 0),
                      numUlSymbolP2: String(p.numUlSymbolP2 ?? 0),
                    });
                  } else {
                    set({ tddPattern: e.target.value as TddPatternKey });
                  }
                }}
              >
                {TDD_PATTERNS.map(p => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="nms-label">DL Slots <span className="text-nms-text-dim font-normal">(numDlSlot)</span></label>
                <input className="nms-input font-mono" placeholder="3" value={form.numDlSlot}
                  onChange={e => set({ numDlSlot: e.target.value, tddPattern: 'custom', np2Pres: '0', numDlSlot2: '0', numUlSlot2: '0', numDlSymbolP2: '0', numUlSymbolP2: '0' })} />
              </div>
              <div>
                <label className="nms-label">UL Slots <span className="text-nms-text-dim font-normal">(numUlSlot)</span></label>
                <input className="nms-input font-mono" placeholder="2" value={form.numUlSlot}
                  onChange={e => set({ numUlSlot: e.target.value, tddPattern: 'custom', np2Pres: '0', numDlSlot2: '0', numUlSlot2: '0', numDlSymbolP2: '0', numUlSymbolP2: '0' })} />
              </div>
              <div>
                <label className="nms-label">DL Symbols <span className="text-nms-text-dim font-normal">(numDlSymbol)</span></label>
                <input className="nms-input font-mono" placeholder="6" value={form.numDlSymbol}
                  onChange={e => set({ numDlSymbol: e.target.value, tddPattern: 'custom', np2Pres: '0', numDlSlot2: '0', numUlSlot2: '0', numDlSymbolP2: '0', numUlSymbolP2: '0' })} />
              </div>
              <div>
                <label className="nms-label">UL Symbols <span className="text-nms-text-dim font-normal">(numUlSymbol)</span></label>
                <input className="nms-input font-mono" placeholder="4" value={form.numUlSymbol}
                  onChange={e => set({ numUlSymbol: e.target.value, tddPattern: 'custom', np2Pres: '0', numDlSlot2: '0', numUlSlot2: '0', numDlSymbolP2: '0', numUlSymbolP2: '0' })} />
              </div>
            </div>
            <p className="text-xs text-nms-text-dim mt-1.5">
              Active: <span className="font-mono text-nms-text">{form.numDlSlot}DL + 1SP + {form.numUlSlot}UL</span> per period · special slot: <span className="font-mono text-nms-text">{form.numDlSymbol}↓ / {form.numUlSymbol}↑ symbols</span>
              {form.np2Pres === '1' && (
                <> · pattern 2: <span className="font-mono text-nms-accent">+{form.numDlSlot2}DL{parseInt(form.numUlSlot2) > 0 ? ` + ${form.numUlSlot2}UL` : ''}</span> appended</>
              )}
            </p>
          </div>

          {/* 4. Location & SAS */}
          <div>
            <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5 text-nms-accent" />
              Location &amp; SAS
            </p>

            {/* Row 1 — SAS deployment fields */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><label className="nms-label">Category</label>
                <select className="nms-input" value={form.sasCategory} onChange={e => set({ sasCategory: e.target.value })}>
                  <option value="A">A — Indoor / low power</option>
                  <option value="B">B — Outdoor / high power</option>
                </select></div>
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
            </div>

            {/* Row 2 — Lat/Lon + location button */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
              <div><label className="nms-label">Latitude (decimal degrees)</label>
                <input className="nms-input font-mono" placeholder="41.570738" value={form.latitude} onChange={e => set({ latitude: e.target.value })} /></div>
              <div><label className="nms-label">Longitude (decimal degrees)</label>
                <input className="nms-input font-mono" placeholder="-90.602715" value={form.longitude} onChange={e => set({ longitude: e.target.value })} /></div>
              <div className="flex items-end">
                <button onClick={useMyLocation} disabled={locating}
                  className="nms-btn border border-nms-accent/30 hover:border-nms-accent/60 text-nms-accent text-xs flex items-center gap-2 w-full justify-center">
                  <Locate className={clsx('w-3.5 h-3.5', locating && 'animate-spin')} />
                  {locating ? 'Locating…' : 'Use My Location'}
                </button>
              </div>
            </div>
            <p className="text-xs text-nms-text-dim mt-1">Decimal degrees — converted to microdegrees automatically on push.</p>

            {/* Row 3 — SAS URL + ICG Group ID */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <div>
                <label className="nms-label">SAS Server URL</label>
                <input className="nms-input font-mono text-xs" value={form.sasUrl}
                  onChange={e => set({ sasUrl: e.target.value })}
                  placeholder={DEFAULT_NR_SAS_URL} />
                <p className="text-xs text-nms-text-dim mt-1">Port 8899 = NMS SAS proxy (accepts Host-less HTTP/1.1 from Sercomm NR)</p>
              </div>
              <div>
                <label className="nms-label">ICG Group ID <span className="text-nms-text-dim font-normal">(groupParamGroupID)</span></label>
                <input className="nms-input font-mono" value={form.sasIcgGroupId}
                  onChange={e => set({ sasIcgGroupId: e.target.value })}
                  placeholder="Leave blank for no group" />
              </div>
            </div>

            {/* Row 4 — Antenna (for SAS EIRP calculation) */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3">
              <div>
                <label className="nms-label">Antenna Gain <span className="text-nms-text-dim font-normal">(dBi)</span></label>
                <input className="nms-input font-mono" placeholder="6" value={form.antennaGain} onChange={e => set({ antennaGain: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">Azimuth <span className="text-nms-text-dim font-normal">(°)</span></label>
                <input className="nms-input font-mono" placeholder="0" value={form.antennaAzimuth} onChange={e => set({ antennaAzimuth: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">Beamwidth <span className="text-nms-text-dim font-normal">(°)</span></label>
                <input className="nms-input font-mono" placeholder="60" value={form.antennaBeamwidth} onChange={e => set({ antennaBeamwidth: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">Downtilt <span className="text-nms-text-dim font-normal">(°)</span></label>
                <input className="nms-input font-mono" placeholder="0" value={form.antennaDowntilt} onChange={e => set({ antennaDowntilt: e.target.value })} />
              </div>
              <div>
                <label className="nms-label">Max TX Power <span className="text-nms-text-dim font-normal">(dBm)</span></label>
                <input className="nms-input font-mono" placeholder="21" value={form.sasMaxTxPower} onChange={e => set({ sasMaxTxPower: e.target.value })} />
              </div>
            </div>

            {/* Row 5 — BW Allow List */}
            <div className="mt-3">
              <label className="nms-label mb-1.5">SAS Bandwidth Allow List <span className="text-nms-text-dim font-normal">(bwAllowList — SAS requests largest available)</span></label>
              <div className="flex items-center gap-4 flex-wrap">
                {['10', '20', '30', '40', '50', '60', '70', '80', '90', '100'].map(bw => {
                  const checked = form.bwAllowList.includes(bw);
                  return (
                    <label key={bw} className="flex items-center gap-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? form.bwAllowList.filter(b => b !== bw)
                            : [...form.bwAllowList, bw].sort((a, b) => Number(b) - Number(a));
                          set({ bwAllowList: next });
                        }}
                        className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent"
                      />
                      <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors font-mono">{bw} MHz</span>
                    </label>
                  );
                })}
                <span className="text-xs text-nms-text-dim font-mono ml-2">→ <span className="text-nms-accent">{[...form.bwAllowList].sort((a,b) => Number(b)-Number(a)).join(',')}</span></span>
              </div>
            </div>

            {/* Row 6 — Checkboxes */}
            <div className="flex flex-wrap gap-5 mt-3">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input type="checkbox" checked={form.sasEnable} onChange={e => set({ sasEnable: e.target.checked })}
                  className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">Enable SAS</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer group">
                <input type="checkbox" checked={form.sasPeerCertVerify} onChange={e => set({ sasPeerCertVerify: e.target.checked })}
                  className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent focus:ring-nms-accent" />
                <span className="text-xs text-nms-text group-hover:text-nms-accent transition-colors">
                  Verify SAS Cert <span className="text-nms-text-dim">(disable for self-signed)</span>
                </span>
              </label>
            </div>
          </div>

          {/* 5. Security Algorithms (AS layer — gNB↔UE) */}
          <div>
            <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-nms-accent" />
              Security Algorithms <span className="text-nms-text-dim font-normal ml-1">(AS layer, gNB↔UE)</span>
            </p>
            <p className="text-xs text-nms-text-dim mb-3">
              Single value per cell — pushed to all 3 cells on configure. NEA2/NIA2 (AES) required for iOS 5G SA.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="nms-label">Ciphering Algorithm <span className="text-nms-text-dim font-normal">(encAlg)</span></label>
                <select className="nms-input" value={form.neaAlgorithm} onChange={e => set({ neaAlgorithm: e.target.value })}>
                  <option value="NEA0">NEA0 — null cipher (not recommended)</option>
                  <option value="NEA1">NEA1 — SNOW 3G</option>
                  <option value="NEA2">NEA2 — AES CTR (required for iOS SA)</option>
                  <option value="NEA3">NEA3 — ZUC</option>
                </select>
              </div>
              <div>
                <label className="nms-label">Integrity Algorithm <span className="text-nms-text-dim font-normal">(intAlg)</span></label>
                <select className="nms-input" value={form.niaAlgorithm} onChange={e => set({ niaAlgorithm: e.target.value })}>
                  <option value="NIA1">NIA1 — SNOW 3G</option>
                  <option value="NIA2">NIA2 — AES CMAC (required for iOS SA)</option>
                  <option value="NIA3">NIA3 — ZUC</option>
                </select>
              </div>
            </div>
          </div>

          {/* 6. Live Status */}
          <div className="text-xs text-nms-text-dim bg-nms-surface rounded px-3 py-2 border border-nms-border">
            <span className="font-semibold text-nms-text">Live Status: </span>
            SAS {device.sasStatus.state || '—'} &middot; Registered {device.sasStatus.registered || '—'} &middot;
            CBSD {device.sasStatus.cbsdId || '—'} &middot; ARFCN {device.sasStatus.grantedArfcn || '—'} &middot;
            Admin <span className={device.nrConfig.adminState === 'UNLOCKED' ? 'text-green-400' : 'text-amber-400'}>
              {device.nrConfig.adminState || '—'}
            </span>
          </div>

          {/* 7. Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => handleRf(false)}
              disabled={rfBusy || rfStatus === 'offline'}
              className="nms-btn border border-red-500/40 text-red-400 hover:bg-red-500/10 flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <WifiOff className="w-4 h-4" />RF Off (Lock Cell)
            </button>
            <button
              onClick={() => handleRf(true)}
              disabled={rfBusy || rfStatus === 'on'}
              className="nms-btn border border-green-500/40 text-green-400 hover:bg-green-500/10 flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Wifi className="w-4 h-4" />RF On (Unlock Cell)
            </button>
            <button onClick={handleSasRestart}
              className="nms-btn border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 flex items-center gap-2 text-sm">
              <RefreshCw className="w-4 h-4" />Restart SAS
            </button>
            <button onClick={handleReboot} disabled={rebooting}
              className="nms-btn border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed">
              <RotateCw className={clsx('w-4 h-4', rebooting && 'animate-spin')} />
              {rebooting ? 'Rebooting…' : 'Reboot'}
            </button>
            <div className="flex-1" />
            <button onClick={handlePushConfig} disabled={saving} className="nms-btn-primary flex items-center gap-2">
              {saving
                ? <><RefreshCw className="w-4 h-4 animate-spin" />Queuing…</>
                : <><Send className="w-4 h-4" />Push Config via ACS</>
              }
            </button>
          </div>

        </div>
      )}
    </div>
  );
};

// ─── Main tab ──────────────────────────────────────────────────────────────────
export function SercommNRTab() {
  const [devices, setDevices]       = useState<SercommNRDevice[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [radioTags, setRadioTags]   = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchInterfaceStatus = useTopologyStore(s => s.fetchInterfaceStatus);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const r = await sercommNRApi.listDevices();
      if (r.success) setDevices(r.devices);
      else if (!silent) setError(String((r as any).error ?? 'Failed to fetch NR devices'));
    } catch (err: any) {
      if (!silent) setError(err?.response?.data?.error ?? err?.message ?? 'Failed to reach GenieACS NBI');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { radioTagsApi.getAll().then(setRadioTags).catch(() => {}); }, []);

  useEffect(() => {
    load();
    fetchInterfaceStatus();
    pollRef.current = setInterval(() => { load(true); fetchInterfaceStatus(); }, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load, fetchInterfaceStatus]);

  const handleRebootAll = async () => {
    if (!confirm(`Reboot ALL ${devices.length} NR radio(s)?\n\nAll radios will be unreachable for ~2 minutes.`)) return;
    setGlobalBusy(true);
    try {
      const results = await Promise.allSettled(devices.map(d => sercommNRApi.reboot(d.id)));
      const failed  = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) toast.success(`All ${devices.length} radios queued for reboot.`);
      else toast.error(`${failed} reboot(s) failed.`);
    } catch (err: any) {
      toast.error(`Reboot all failed: ${err?.message}`);
    } finally { setGlobalBusy(false); }
  };

  const handleRfAll = async (enable: boolean) => {
    const warn = enable ? '' : '\n\n⚠️ This will lock all NR cells immediately.';
    if (!confirm(`${enable ? 'Enable' : 'Disable'} RF on ALL ${devices.length} NR radio(s)?${warn}`)) return;
    setGlobalBusy(true);
    try {
      const results = await Promise.allSettled(
        devices.map(d => enable ? sercommNRApi.unlock(d.id) : sercommNRApi.lock(d.id)),
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) toast.success(`RF ${enable ? 'On' : 'Off'} queued for all ${devices.length} radio(s).`);
      else toast.error(`${failed} RF action(s) failed.`);
      setTimeout(() => load(true), 5000);
    } catch (err: any) {
      toast.error(`RF all failed: ${err?.message}`);
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
            Tested on Sercomm SCE5164-B48 only — other models or firmware versions may not work correctly.
          </p>
        </div>
      </div>

      {/* Description */}
      <div className="nms-card border-nms-accent/30 bg-nms-accent/5">
        <div className="flex items-start gap-3">
          <Radio className="w-5 h-5 text-nms-accent mt-0.5 flex-shrink-0" />
          <div className="w-full">
            <h3 className="text-sm font-semibold text-nms-text mb-1">Sercomm SCE5164-B48 5G NR gNB Provisioning via GenieACS</h3>
            <p className="text-xs text-nms-text-dim leading-relaxed mb-3">
              Provision <span className="text-nms-text font-medium">Sercomm SCE5164-B48</span> CBRS 5G NR small cells
              via GenieACS TR-069. Point the radio at this ACS, then select it from the list below and click Push Config.
            </p>

            {/* ACS URL */}
            <div className="bg-nms-bg border border-nms-border rounded-md px-3 py-2.5 mb-4">
              <p className="text-xs font-medium text-nms-text mb-1">ACS URL (set on radio TR-069 page)</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm text-nms-accent select-all flex-1">
                  {`http://${window.location.hostname}:7547`}
                </p>
                <CopyBtn text={`http://${window.location.hostname}:7547`} />
              </div>
            </div>

            {/* Two-column setup */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-nms-bg border border-nms-border rounded-md px-3 py-3 space-y-2">
                <p className="text-xs font-semibold text-nms-text">Setup Steps</p>
                <div className="text-xs text-nms-text-dim space-y-0.5">
                  <p>1. Connect radio to management network</p>
                  <p>2. Log into radio WebUI → Management → TR-069</p>
                  <p>3. Set ACS URL to the URL above</p>
                  <p>4. Enable CWMP, set periodic inform interval to 60s</p>
                  <p>5. Save &amp; reboot — radio appears in list below</p>
                  <p>6. Expand radio row, fill in fields, click Push Config</p>
                  <p>7. After push completes, click <strong className="text-nms-text">RF On (Unlock Cell)</strong></p>
                </div>
              </div>
              <div className="bg-nms-bg border border-nms-border rounded-md px-3 py-3 space-y-2">
                <p className="text-xs font-semibold text-nms-text">SAS Proxy (Port 8899)</p>
                <div className="text-xs text-nms-text-dim space-y-1">
                  <p>Sercomm NR radios send HTTP/1.1 <em>without</em> a Host header — standard nginx/proxies reject this with 400.</p>
                  <p>The NMS runs a Node.js SAS proxy on port 8899 that accepts these requests and forwards them to the built-in SAS protocol handler.</p>
                  <div className="bg-nms-surface rounded px-2 py-1 font-mono text-nms-accent flex items-center justify-between mt-1">
                    <span>{`http://${window.location.hostname}:8899/sas`}</span>
                    <CopyBtn text={`http://${window.location.hostname}:8899/sas`} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Header + action buttons */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-base font-semibold text-nms-text flex items-center gap-2">
            <Radio className="w-4 h-4 text-nms-accent" />
            Connected NR Radios
            {devices.length > 0 && (
              <span className="text-xs text-nms-text-dim font-normal">({devices.length})</span>
            )}
          </h2>
          <p className="text-xs text-nms-text-dim mt-0.5">Status refreshes every 30s · click a row to edit · <span className="text-amber-400">auto-refresh pauses while a card is open</span></p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ArfcnCalculator />
          <a
            href={`http://${window.location.hostname}:7000`}
            target="_blank" rel="noopener noreferrer"
            className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 flex items-center gap-2 text-sm"
          >
            <ExternalLink className="w-4 h-4" />GenieACS UI
          </a>
          <button onClick={() => load()} disabled={loading}
            className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2 flex items-center gap-2 text-sm">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />Refresh
          </button>
          <button onClick={() => handleRfAll(false)} disabled={globalBusy || devices.length === 0}
            className="nms-btn border border-red-500/40 text-red-400 hover:bg-red-500/10 flex items-center gap-2 text-sm">
            <WifiOff className="w-4 h-4" />RF Off — All
          </button>
          <button onClick={() => handleRfAll(true)} disabled={globalBusy || devices.length === 0}
            className="nms-btn border border-green-500/40 text-green-400 hover:bg-green-500/10 flex items-center gap-2 text-sm">
            <Wifi className="w-4 h-4" />RF On — All
          </button>
          <button onClick={handleRebootAll} disabled={globalBusy || devices.length === 0}
            className="nms-btn border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 flex items-center gap-2 text-sm">
            <RotateCw className={clsx('w-4 h-4', globalBusy && 'animate-spin')} />Reboot All
          </button>
        </div>
      </div>

      {/* Status dot legend */}
      <div className="flex items-center gap-4 text-xs text-nms-text-dim">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> RF On (Cell Unlocked)</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> RF Off (Cell Locked)</span>
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
      {!loading && !error && devices.length === 0 && (
        <div className="flex flex-col items-center justify-center h-40 text-nms-text-dim border border-dashed border-nms-border rounded-lg">
          <Radio className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-sm">No Sercomm NR radios found in GenieACS</p>
          <p className="text-xs mt-1 opacity-60">Point a radio at ACS port 7547 — OUI 00C002 with X_00C002_gNB tree</p>
        </div>
      )}

      {/* Radio list */}
      {!loading && !error && devices.length > 0 && (
        <div className="space-y-2">
          {devices.map(d => (
            <NRRadioRow
              key={d.id}
              device={d}
              onRefresh={() => load(true)}
              nickname={d.ip ? radioTags[d.ip] : undefined}
            />
          ))}
        </div>
      )}

      {/* Info box */}
      <div className="nms-card bg-amber-500/5 border-amber-500/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-nms-text-dim space-y-1">
            <p><span className="font-semibold text-nms-text">Push Config via ACS</span> queues SetParameterValues for all NR parameters via GenieACS NBI. The radio applies settings on the next TR-069 inform (connection_request triggered immediately).</p>
            <p>Cell adminState resets to LOCKED on every reboot — use <strong className="text-nms-text">RF On (Unlock Cell)</strong> after each reboot to restore service.</p>
            <p>Security algorithms (encAlg/intAlg) are pushed to all 3 NRCellCU cells on configure. NEA2/NIA2 required for iOS 5G SA registration.</p>
          </div>
        </div>
      </div>

    </div>
  );
}
