import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Shield, Radio, Wifi, Server, Settings, RefreshCw,
  AlertCircle, CheckCircle, Activity, ScrollText, Trash2, Plus, BookOpen, X, Download, Lock, Users,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { sasApi } from '../api/sas';
import { interfaceApi } from '../api';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';

const SAS_BASE = `http://${window.location.hostname}:8888/sas/v1.2`;

// ─── EARFCN ↔ Hz helpers (Band 48 / CBRS, 3GPP TS 36.101) ──────────────────
// Band 48 DL: F(MHz) = 3550 + 0.1 × (EARFCN - 55240)
// EARFCN = 55240 + 10 × (F_MHz - 3550)
// EARFCN range: 55240 (3550 MHz) to 56739 (3699.9 MHz)
function earfcnToHz(earfcn: number): number {
  return Math.round((3550 + (earfcn - 55240) * 0.1) * 1e6);
}
function hzToEarfcn(hz: number): number {
  return Math.round(55240 + (hz / 1e6 - 3550) / 0.1);
}
// ─── NR-ARFCN ↔ Hz helpers (n48, 3GPP TS 38.101-1, FR1 3000–24250 MHz) ─────
// F(MHz) = 3000 + 0.015 × (NR-ARFCN − 600000)   step = 15 kHz
// NR-ARFCN = (F_MHz − 3000) / 0.015 + 600000
function hzToNrArfcn(hz: number): number {
  return Math.round((hz / 1e6 - 3000) / 0.015 + 600000);
}
function nrArfcnToHz(arfcn: number): number {
  return Math.round((3000 + 0.015 * (arfcn - 600000)) * 1e6);
}
function hzToMhz(hz: number): number { return hz / 1e6; }
function mhzToHz(mhz: number): number { return Math.round(mhz * 1e6); }

// ─── Band editor row ──────────────────────────────────────────────────────────
function BandRow({ band, onChange, onDelete }: {
  band: any;
  onChange: (updated: any) => void;
  onDelete: () => void;
}) {
  const [inputMode, setInputMode] = useState<'hz' | 'mhz' | 'earfcn' | 'nrarfcn'>('earfcn');

  const lowMhz      = hzToMhz(band.lowFrequency);
  const highMhz     = hzToMhz(band.highFrequency);
  const lowEarfcn   = hzToEarfcn(band.lowFrequency);
  const highEarfcn  = hzToEarfcn(band.highFrequency);
  const lowNrArfcn  = hzToNrArfcn(band.lowFrequency);
  const highNrArfcn = hzToNrArfcn(band.highFrequency);
  const bwMhz       = (band.highFrequency - band.lowFrequency) / 1e6;

  const handleLow = (val: string) => {
    const n = parseFloat(val);
    if (isNaN(n)) return;
    const hz = inputMode === 'hz' ? n : inputMode === 'mhz' ? mhzToHz(n) : inputMode === 'nrarfcn' ? nrArfcnToHz(n) : earfcnToHz(n);
    onChange({ ...band, lowFrequency: hz });
  };

  const handleHigh = (val: string) => {
    const n = parseFloat(val);
    if (isNaN(n)) return;
    const hz = inputMode === 'hz' ? n : inputMode === 'mhz' ? mhzToHz(n) : inputMode === 'nrarfcn' ? nrArfcnToHz(n) : earfcnToHz(n);
    onChange({ ...band, highFrequency: hz });
  };

  const dispLow  = inputMode === 'hz' ? band.lowFrequency  : inputMode === 'mhz' ? lowMhz  : inputMode === 'nrarfcn' ? lowNrArfcn  : lowEarfcn;
  const dispHigh = inputMode === 'hz' ? band.highFrequency : inputMode === 'mhz' ? highMhz : inputMode === 'nrarfcn' ? highNrArfcn : highEarfcn;
  const unit     = inputMode === 'hz' ? 'Hz' : inputMode === 'mhz' ? 'MHz' : inputMode === 'nrarfcn' ? 'NR-ARFCN' : 'EARFCN';

  return (
    <div className="border border-nms-border rounded-lg p-3 space-y-3 bg-nms-surface-2">

      {/* Label row */}
      <div className="flex items-center gap-2">
        <input
          className="nms-input text-sm font-medium flex-1"
          placeholder="Label (e.g. Baicells Nova 436)"
          value={band.label}
          onChange={e => onChange({ ...band, label: e.target.value })}
        />
        <button onClick={onDelete} className="text-nms-text-dim hover:text-red-400 transition-colors shrink-0" title="Remove band">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Input mode toggle */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-nms-text-dim mr-1">Input as:</span>
        {(['earfcn', 'nrarfcn', 'mhz', 'hz'] as const).map(mode => (
          <button key={mode} onClick={() => setInputMode(mode)}
            className={clsx(
              'px-2 py-0.5 rounded text-xs font-medium transition-all',
              inputMode === mode
                ? mode === 'nrarfcn'
                  ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
                  : 'bg-nms-accent/15 text-nms-accent border border-nms-accent/30'
                : 'text-nms-text-dim hover:text-nms-text border border-transparent',
            )}>
            {mode === 'nrarfcn' ? 'NR-ARFCN' : mode.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Editable inputs */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="nms-label text-xs">Low {unit}</label>
          <input className="nms-input font-mono text-xs" type="number"
            value={dispLow} onChange={e => handleLow(e.target.value)} />
        </div>
        <div>
          <label className="nms-label text-xs">High {unit}</label>
          <input className="nms-input font-mono text-xs" type="number"
            value={dispHigh} onChange={e => handleHigh(e.target.value)} />
        </div>
        <div>
          <label className="nms-label text-xs">Max Grant BW (MHz)</label>
          <input className="nms-input font-mono text-xs" type="number"
            value={band.maxBandwidthMhz}
            onChange={e => onChange({ ...band, maxBandwidthMhz: Number(e.target.value) })} />
        </div>
      </div>

      {/* Read-only computed values — always visible regardless of input mode */}
      <div className="rounded-md bg-nms-bg border border-nms-border/60 px-3 py-2 space-y-1.5">
        <div className="grid grid-cols-4 gap-x-4">
          <div>
            <p className="text-xs text-nms-text-dim mb-0.5">EARFCN (LTE)</p>
            <p className="font-mono text-xs text-nms-text">{lowEarfcn} – {highEarfcn}</p>
          </div>
          <div>
            <p className="text-xs text-nms-text-dim mb-0.5">NR-ARFCN (5G)</p>
            <p className="font-mono text-xs text-nms-text">{hzToNrArfcn(band.lowFrequency)} – {hzToNrArfcn(band.highFrequency)}</p>
          </div>
          <div>
            <p className="text-xs text-nms-text-dim mb-0.5">MHz</p>
            <p className="font-mono text-xs text-nms-text">{lowMhz.toFixed(1)} – {highMhz.toFixed(1)}</p>
          </div>
          <div>
            <p className="text-xs text-nms-text-dim mb-0.5">Hz (sent to radio)</p>
            <p className="font-mono text-xs text-nms-text break-all">{band.lowFrequency.toLocaleString()} – {band.highFrequency.toLocaleString()}</p>
          </div>
        </div>
        <div className="border-t border-nms-border/40 pt-1">
          <p className="text-xs text-nms-text-dim">
            Band width: <span className="text-nms-text font-mono">{bwMhz.toFixed(1)} MHz</span>
            &nbsp;·&nbsp;
            Max grant: <span className="text-nms-text font-mono">{band.maxBandwidthMhz} MHz</span>
            &nbsp;·&nbsp;
            Grants fit in band: <span className="text-nms-text font-mono">{Math.floor(bwMhz / band.maxBandwidthMhz)}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── EARFCN Reference modal ──────────────────────────────────────────────────
function EarfcnReferenceModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 bg-nms-bg border border-nms-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nms-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-nms-text">EARFCN / NR-ARFCN / Frequency Reference</h2>
              <p className="text-xs text-nms-text-dim">3GPP TS 36.101 — Band 48 (CBRS 3550–3700 MHz)</p>
            </div>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors p-1 rounded-md hover:bg-nms-surface">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          <EarfcnReference />
        </div>
      </div>
    </div>
  );
}

// ─── EARFCN Reference content ─────────────────────────────────────────────────
function EarfcnReference() {
  const [calcEarfcn, setCalcEarfcn] = useState(56060);
  const calcMhz       = 3550 + (calcEarfcn - 55240) * 0.1;
  const calcHz        = Math.round(calcMhz * 1e6);
  const calcNrArfcn   = hzToNrArfcn(calcHz);

  const [calcMhzIn, setCalcMhzIn] = useState(3632);
  const calcEarfcnOut = Math.round(55240 + (calcMhzIn - 3550) * 10);
  const calcNrArfcnOut = hzToNrArfcn(mhzToHz(calcMhzIn));

  // Also allow entering NR-ARFCN directly
  const [calcNrIn, setCalcNrIn] = useState(638000);
  const calcNrMhz  = 3000 + 0.015 * (calcNrIn - 600000);
  const calcNrHz   = nrArfcnToHz(calcNrIn);
  const calcNrEarfcn = hzToEarfcn(calcNrHz);

  const EXAMPLES = [
    { earfcn: 55240, mhz: 3550.0, note: 'CBRS band start' },
    { earfcn: 55340, mhz: 3560.0, note: 'Baicells low end' },
    { earfcn: 55540, mhz: 3580.0, note: '' },
    { earfcn: 55990, mhz: 3625.0, note: '' },
    { earfcn: 56060, mhz: 3632.0, note: 'Baicells example' },
    { earfcn: 56190, mhz: 3645.0, note: '' },
    { earfcn: 56490, mhz: 3675.0, note: '' },
    { earfcn: 56640, mhz: 3690.0, note: 'Baicells high end' },
    { earfcn: 56739, mhz: 3699.9, note: 'CBRS band end' },
  ];

  return (
    <div className="space-y-6 max-w-2xl">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
          <BookOpen className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-nms-text">EARFCN / NR-ARFCN / Frequency Reference</h2>
          <p className="text-xs text-nms-text-dim">3GPP TS 36.101 — Band 48 (CBRS 3550–3700 MHz)</p>
        </div>
      </div>

      {/* Formulas */}
      <div className="nms-card space-y-5">
        <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Conversion Formulas</h3>

        {/* EARFCN → Frequency */}
        <div className="space-y-2">
          <p className="text-xs text-nms-text-dim">EARFCN → Frequency</p>
          <div className="bg-nms-surface rounded-lg px-4 py-3 border border-nms-border">
            {/* F_DL = F_DL,low + 0.1 × (N_DL − N_Offs-DL) */}
            <div className="flex items-center gap-1.5 flex-wrap font-mono text-sm">
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">DL</sub>
              <span className="text-nms-text-dim mx-1">=</span>
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">DL,low</sub>
              <span className="text-nms-text mx-1">+</span>
              <span className="text-amber-400">0.1</span>
              <span className="text-nms-text-dim mx-1">×</span>
              <span className="text-nms-text">(</span>
              <span className="text-green-400 italic">N</span>
              <sub className="text-green-300 text-xs -ml-1">DL</sub>
              <span className="text-nms-text-dim mx-1">−</span>
              <span className="text-green-400 italic">N</span>
              <sub className="text-green-300 text-xs -ml-1">Offs‑DL</sub>
              <span className="text-nms-text">)</span>
            </div>
            <div className="mt-2 pt-2 border-t border-nms-border/50 flex items-center gap-1.5 flex-wrap font-mono text-sm">
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">MHz</sub>
              <span className="text-nms-text-dim mx-1">=</span>
              <span className="text-amber-400">3550</span>
              <span className="text-nms-text mx-1">+</span>
              <span className="text-amber-400">0.1</span>
              <span className="text-nms-text-dim mx-1">×</span>
              <span className="text-nms-text">(</span>
              <span className="text-green-400">EARFCN</span>
              <span className="text-nms-text-dim mx-1">−</span>
              <span className="text-amber-400">55240</span>
              <span className="text-nms-text">)</span>
            </div>
          </div>
          <p className="text-xs text-nms-text-dim pl-1">
            Where <span className="font-mono text-amber-400">3550</span> = F<sub>DL,low</sub> (MHz),&nbsp;
            <span className="font-mono text-amber-400">55240</span> = N<sub>Offs‑DL</sub>,&nbsp;
            each step = <span className="font-mono text-amber-400">0.1 MHz = 100 kHz</span>
          </p>
        </div>

        {/* Frequency → EARFCN */}
        <div className="space-y-2">
          <p className="text-xs text-nms-text-dim">Frequency → EARFCN</p>
          <div className="bg-nms-surface rounded-lg px-4 py-3 border border-nms-border">
            <div className="flex items-center gap-1.5 flex-wrap font-mono text-sm">
              <span className="text-green-400 italic">N</span>
              <sub className="text-green-300 text-xs -ml-1">DL</sub>
              <span className="text-nms-text-dim mx-1">=</span>
              <span className="text-green-400 italic">N</span>
              <sub className="text-green-300 text-xs -ml-1">Offs‑DL</sub>
              <span className="text-nms-text mx-1">+</span>
              <span className="text-amber-400">10</span>
              <span className="text-nms-text-dim mx-1">×</span>
              <span className="text-nms-text">(</span>
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">DL</sub>
              <span className="text-nms-text-dim mx-1">−</span>
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">DL,low</sub>
              <span className="text-nms-text">)</span>
            </div>
            <div className="mt-2 pt-2 border-t border-nms-border/50 flex items-center gap-1.5 flex-wrap font-mono text-sm">
              <span className="text-green-400">EARFCN</span>
              <span className="text-nms-text-dim mx-1">=</span>
              <span className="text-amber-400">55240</span>
              <span className="text-nms-text mx-1">+</span>
              <span className="text-amber-400">10</span>
              <span className="text-nms-text-dim mx-1">×</span>
              <span className="text-nms-text">(</span>
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">MHz</sub>
              <span className="text-nms-text-dim mx-1">−</span>
              <span className="text-amber-400">3550</span>
              <span className="text-nms-text">)</span>
            </div>
          </div>
        </div>

        {/* MHz → Hz */}
        <div className="space-y-2">
          <p className="text-xs text-nms-text-dim">MHz → Hz (what the SAS sends to the radio)</p>
          <div className="bg-nms-surface rounded-lg px-4 py-3 border border-nms-border">
            <div className="flex items-center gap-1.5 flex-wrap font-mono text-sm">
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">Hz</sub>
              <span className="text-nms-text-dim mx-1">=</span>
              <span className="text-indigo-400 italic">F</span>
              <sub className="text-indigo-300 text-xs -ml-1">MHz</sub>
              <span className="text-nms-text-dim mx-1">×</span>
              <span className="text-amber-400">10</span>
              <sup className="text-amber-300 text-xs">6</sup>
            </div>
          </div>
          <p className="text-xs text-nms-text-dim pl-1">
            Example: <span className="font-mono text-nms-text">3632 MHz × 10⁶ = 3,632,000,000 Hz</span>
          </p>
        </div>
      </div>

      {/* Interactive calculators */}
      <div className="grid grid-cols-3 gap-4">

        {/* EARFCN → Frequency */}
        <div className="nms-card space-y-3">
          <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">EARFCN → Frequency</h3>
          <div>
            <label className="nms-label text-xs">EARFCN (Band 48 LTE)</label>
            <input className="nms-input font-mono" type="number"
              value={calcEarfcn}
              onChange={e => setCalcEarfcn(Number(e.target.value))}
              min={55240} max={56739} />
            <p className="text-xs text-nms-text-dim mt-1">Valid range: 55240 – 56739</p>
          </div>
          <div className="bg-nms-surface rounded-lg px-3 py-2 border border-nms-border space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-nms-text-dim">MHz</span>
              <span className="font-mono text-nms-text">{calcMhz.toFixed(3)} MHz</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-nms-text-dim">Hz (SAS grant)</span>
              <span className="font-mono text-nms-text">{calcHz.toLocaleString()} Hz</span>
            </div>
            <div className="flex justify-between text-xs text-purple-400">
              <span>NR-ARFCN (n48)</span>
              <span className="font-mono">{calcNrArfcn}</span>
            </div>
            <div className="flex justify-between text-xs border-t border-nms-border/40 pt-1 mt-1">
              <span className="text-nms-text-dim">Calc</span>
              <span className="font-mono text-nms-text-dim text-xs">3550 + 0.1×({calcEarfcn}−55240)</span>
            </div>
          </div>
        </div>

        {/* NR-ARFCN → Frequency */}
        <div className="nms-card space-y-3">
          <h3 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">NR-ARFCN → Frequency</h3>
          <div>
            <label className="nms-label text-xs">NR-ARFCN (n48 5G NR)</label>
            <input className="nms-input font-mono" type="number"
              value={calcNrIn}
              onChange={e => setCalcNrIn(Number(e.target.value))}
              min={620000} max={653333} />
            <p className="text-xs text-nms-text-dim mt-1">Valid range: 620000 – 653333</p>
          </div>
          <div className="bg-nms-surface rounded-lg px-3 py-2 border border-nms-border space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-nms-text-dim">MHz</span>
              <span className="font-mono text-nms-text">{calcNrMhz.toFixed(3)} MHz</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-nms-text-dim">Hz (SAS grant)</span>
              <span className="font-mono text-nms-text">{calcNrHz.toLocaleString()} Hz</span>
            </div>
            <div className="flex justify-between text-xs text-nms-accent">
              <span>EARFCN (Band 48 LTE)</span>
              <span className="font-mono">{calcNrEarfcn}</span>
            </div>
            <div className="flex justify-between text-xs border-t border-nms-border/40 pt-1 mt-1">
              <span className="text-nms-text-dim">Calc</span>
              <span className="font-mono text-nms-text-dim text-xs">3000 + 0.015×({calcNrIn}−600000)</span>
            </div>
          </div>
        </div>

        {/* MHz → Both */}
        <div className="nms-card space-y-3">
          <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Frequency → ARFCN</h3>
          <div>
            <label className="nms-label text-xs">Frequency (MHz)</label>
            <input className="nms-input font-mono" type="number"
              value={calcMhzIn}
              onChange={e => setCalcMhzIn(Number(e.target.value))}
              min={3550} max={3700} step={0.1} />
            <p className="text-xs text-nms-text-dim mt-1">Valid range: 3550 – 3700 MHz</p>
          </div>
          <div className="bg-nms-surface rounded-lg px-3 py-2 border border-nms-border space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-nms-text-dim">EARFCN (LTE)</span>
              <span className="font-mono text-nms-accent">{calcEarfcnOut}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-purple-400">NR-ARFCN (5G)</span>
              <span className="font-mono text-purple-400">{calcNrArfcnOut}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-nms-text-dim">Hz</span>
              <span className="font-mono text-nms-text">{mhzToHz(calcMhzIn).toLocaleString()} Hz</span>
            </div>
          </div>
        </div>
      </div>

      {/* Reference table */}
      <div className="nms-card space-y-3">
        <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Band 48 Reference Points</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-nms-border text-nms-text-dim">
              <th className="text-left py-2 pr-4">EARFCN (LTE)</th>
              <th className="text-left py-2 pr-4 text-purple-400">NR-ARFCN (5G)</th>
              <th className="text-left py-2 pr-4">MHz</th>
              <th className="text-left py-2 pr-4">Hz</th>
              <th className="text-left py-2">Note</th>
            </tr>
          </thead>
          <tbody>
            {EXAMPLES.map(ex => (
              <tr key={ex.earfcn} className="border-b border-nms-border/50 hover:bg-nms-surface-2">
                <td className="py-1.5 pr-4 font-mono text-nms-accent">{ex.earfcn}</td>
                <td className="py-1.5 pr-4 font-mono text-purple-400">{hzToNrArfcn(mhzToHz(ex.mhz))}</td>
                <td className="py-1.5 pr-4 font-mono text-nms-text">{ex.mhz.toFixed(1)}</td>
                <td className="py-1.5 pr-4 font-mono text-nms-text-dim">{mhzToHz(ex.mhz).toLocaleString()}</td>
                <td className="py-1.5 text-nms-text-dim">{ex.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* SAS grant workflow */}
      <div className="nms-card space-y-3">
        <h3 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">SAS Grant Frequency Workflow</h3>
        <div className="space-y-2">
          {[
            { n: 1, text: 'Radio sends grant request with lowFrequency / highFrequency in Hz' },
            { n: 2, text: 'SAS matches request against configured frequency bands' },
            { n: 3, text: 'SAS clamps grant to band\'s maxBandwidthMhz (e.g. 20 MHz)' },
            { n: 4, text: 'SAS returns approved lowFrequency / highFrequency in Hz' },
            { n: 5, text: 'Radio maps Hz back to EARFCN internally for RF tuning' },
            { n: 6, text: 'Radio heartbeats every heartbeatInterval seconds to keep grant alive' },
          ].map(step => (
            <div key={step.n} className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-nms-accent/20 border border-nms-accent/30 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-xs font-semibold text-nms-accent">{step.n}</span>
              </div>
              <p className="text-xs text-nms-text-dim pt-0.5">{step.text}</p>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}

// ─── Dot legend — shared by both chart types ─────────────────────────────────
function DotLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-nms-text-dim">
      <span className="font-semibold text-nms-text-dim/60 uppercase tracking-wider text-[10px]">Legend:</span>
      {/* SAS state — circles */}
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-green-400 shadow-[0_0_5px_rgba(74,222,128,0.9)] inline-block shrink-0" />
        SAS Authorized
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-sky-400 inline-block shrink-0" />
        SAS Granted
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full bg-nms-text-dim/30 border border-nms-text-dim/50 inline-block shrink-0" />
        SAS Idle
      </span>
      {/* RF state — squares */}
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.8)] inline-block shrink-0" />
        RF ON
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block shrink-0" />
        RF OFF
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-nms-text-dim/20 border border-nms-text-dim/40 inline-block shrink-0" />
        RF Unknown
      </span>
    </div>
  );
}

// ─── Frequency Spectrum Chart ──────────────────────────────────────────────────────

const SLOT_COLORS = [
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#3b82f6', // blue
  '#ec4899', // pink
  '#84cc16', // lime
];

function SpectrumChart({ slots, bandLow, bandHigh, slotWidthHz, filterGroupIds, rfStatus = new Map() }: {
  slots:          Array<{ low: number; high: number; earfcn: number; nrArfcn?: number; displayArfcn?: number; arfcnLabel?: string; radioTech?: string; cbsdId?: string; serial?: string; fccId?: string; state?: string; groupId?: string }>;
  bandLow:        number;
  bandHigh:       number;
  slotWidthHz:    number;
  filterGroupIds?: string[];
  rfStatus?:      Map<string, boolean | null>;
}) {
  const bandWidthHz = bandHigh - bandLow;
  const bandMhz     = bandWidthHz / 1e6;
  const lowMhz      = bandLow  / 1e6;
  const highMhz     = bandHigh / 1e6;

  // Filter slots: if filterGroupIds is set, hide slots not belonging to any assigned group.
  // Slots with no groupId are also hidden — ungrouped radios have no business in a group-filtered band.
  const visibleSlots = filterGroupIds && filterGroupIds.length > 0
    ? slots.map(s => (s.cbsdId && (!s.groupId || !filterGroupIds.includes(s.groupId)))
        ? { ...s, cbsdId: undefined, serial: undefined, fccId: undefined, state: undefined, groupId: undefined, _dimmed: true }
        : { ...s, _dimmed: false })
    : slots.map(s => ({ ...s, _dimmed: false }));

  // Map cbsdId -> color index for consistent coloring
  const cbsdColorMap = new Map<string, number>();
  let colorIdx = 0;
  for (const s of visibleSlots) {
    if (s.cbsdId && !cbsdColorMap.has(s.cbsdId)) {
      cbsdColorMap.set(s.cbsdId, colorIdx % SLOT_COLORS.length);
      colorIdx++;
    }
  }

  const usedSlots   = visibleSlots.filter(s => s.cbsdId);
  const unusedSlots = visibleSlots.filter(s => !s.cbsdId);
  const dimmedCount = filterGroupIds && filterGroupIds.length > 0
    ? slots.filter(s => s.cbsdId && (!s.groupId || !filterGroupIds.includes(s.groupId))).length
    : 0;

  return (
    <div className="space-y-3">
      {/* Chart bar */}
      <div className="relative h-16 rounded-lg overflow-hidden bg-nms-surface border border-nms-border">
        {/* Unused slot hatching */}
        {unusedSlots.map((s, i) => {
          const leftPct  = ((s.low  - bandLow) / bandWidthHz) * 100;
          const widthPct = ((s.high - s.low)   / bandWidthHz) * 100;
          return (
            <div key={i} className="absolute inset-y-0 flex items-center justify-center"
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}>
              <div className="w-full h-full opacity-20"
                style={{ backgroundImage: 'repeating-linear-gradient(-45deg, #6b7280 0, #6b7280 1px, transparent 0, transparent 50%)', backgroundSize: '6px 6px' }} />
            </div>
          );
        })}

        {/* Used slots */}
        {usedSlots.map((s) => {
          const leftPct   = ((s.low  - bandLow) / bandWidthHz) * 100;
          const widthPct  = ((s.high - s.low)   / bandWidthHz) * 100;
          const color     = SLOT_COLORS[cbsdColorMap.get(s.cbsdId!)! % SLOT_COLORS.length];
          const isAuth    = s.state === 'AUTHORIZED';
          const label     = s.serial ? s.serial.slice(-6) : s.cbsdId?.slice(0, 6);
          const bwMhz     = (s.high - s.low) / 1e6;
          return (
            <div key={s.cbsdId} className="absolute inset-y-0 flex flex-col items-center justify-center px-1 overflow-hidden"
              style={{ left: `${leftPct}%`, width: `${widthPct}%`, backgroundColor: color + '33', borderLeft: `2px solid ${color}`, borderRight: `2px solid ${color}` }}
              title={`${s.serial ?? s.cbsdId}\n${(s.low/1e6).toFixed(1)}–${(s.high/1e6).toFixed(1)} MHz (${bwMhz.toFixed(1)} MHz)\n${s.arfcnLabel ?? 'EARFCN'} ${s.displayArfcn ?? s.earfcn}\n${s.state}${s.groupId ? `\nGroup: ${s.groupId}` : ''}`}>
              <span className="text-xs font-bold truncate w-full text-center" style={{ color }}>{label}</span>
              <span className="text-xs font-mono truncate w-full text-center" style={{ color: color + 'cc' }}>{(s.low/1e6).toFixed(0)}–{(s.high/1e6).toFixed(0)}</span>
              <span className="text-xs font-mono truncate w-full text-center opacity-70" style={{ color }}>{bwMhz % 1 === 0 ? bwMhz.toFixed(0) : bwMhz.toFixed(1)} MHz</span>
              {isAuth && <div className="absolute top-1 right-1 flex items-center gap-0.5">
                {/* SAS state — circle */}
                <div className={`w-2 h-2 rounded-full ${
                  s.state === 'AUTHORIZED' ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.9)]'
                  : s.state === 'GRANTED'  ? 'bg-sky-400'
                  : 'bg-nms-text-dim/40'
                }`} title={`SAS: ${s.state}`} />
                {/* RF state — square */}
                {(() => {
                  const rf = rfStatus.get(s.cbsdId!);
                  if (rf === true)  return <div className="w-2 h-2 rounded-sm bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.8)]" title="RF: ON" />;
                  if (rf === false) return <div className="w-2 h-2 rounded-sm bg-red-500" title="RF: OFF" />;
                  return <div className="w-2 h-2 rounded-sm bg-nms-text-dim/30 border border-nms-text-dim/40" title="RF: Unknown" />;
                })()}
              </div>}
            </div>
          );
        })}

        {/* Slot divider lines */}
        {visibleSlots.slice(0, -1).map((s, i) => {
          const leftPct = ((s.high - bandLow) / bandWidthHz) * 100;
          return <div key={i} className="absolute inset-y-0 w-px bg-nms-border/60" style={{ left: `${leftPct}%` }} />;
        })}
      </div>

      {/* X-axis labels */}
      <div className="relative h-4">
        {slots.map((s, i) => {
          const centerPct = ((s.low + s.high) / 2 - bandLow) / bandWidthHz * 100;
          return (
            <span key={i} className="absolute text-xs font-mono text-nms-text-dim -translate-x-1/2"
              style={{ left: `${centerPct}%` }}>
              {s.displayArfcn ?? s.earfcn}
            </span>
          );
        })}
        <span className="absolute left-0 text-xs font-mono text-nms-text-dim">{lowMhz.toFixed(0)}</span>
        <span className="absolute right-0 text-xs font-mono text-nms-text-dim translate-x-0">{highMhz.toFixed(0)} MHz</span>
      </div>

      {/* Legend */}
      {usedSlots.length > 0 && (
        <div className="flex flex-wrap gap-3 pt-1">
          {usedSlots.map(s => {
            const color = SLOT_COLORS[cbsdColorMap.get(s.cbsdId!)! % SLOT_COLORS.length];
            return (
              <div key={s.cbsdId} className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color + '55', border: `1.5px solid ${color}` }} />
                <span className="text-xs text-nms-text-dim">
                  {s.serial ? s.serial.slice(-8) : s.cbsdId?.slice(0, 8)}
                  <span className="font-mono ml-1 text-nms-text-dim/60">
                    {(s.low/1e6).toFixed(1)}–{(s.high/1e6).toFixed(1)} MHz
                  </span>
                  {s.state === 'AUTHORIZED' && <span className="ml-1 text-green-400">●</span>}
                </span>
              </div>
            );
          })}
          {unusedSlots.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-nms-text-dim/20 border border-nms-border" />
              <span className="text-xs text-nms-text-dim">{unusedSlots.length} unassigned slot{unusedSlots.length > 1 ? 's' : ''}</span>
            </div>
          )}
          {dimmedCount > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm bg-nms-text-dim/10 border border-dashed border-nms-border" />
              <span className="text-xs text-nms-text-dim/60">{dimmedCount} grant{dimmedCount > 1 ? 's' : ''} from other group{dimmedCount > 1 ? 's' : ''} (hidden)</span>
            </div>
          )}
        </div>
      )}

      {/* Slot detail table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-nms-border text-nms-text-dim">
              <th className="text-left py-1.5 pr-4">Slot</th>
              <th className="text-left py-1.5 pr-4">Frequency Range</th>
              <th className="text-left py-1.5 pr-4">ARFCN</th>
              <th className="text-left py-1.5 pr-4">Assigned To</th>
              <th className="text-left py-1.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s, i) => {
              const color = s.cbsdId ? SLOT_COLORS[cbsdColorMap.get(s.cbsdId)! % SLOT_COLORS.length] : undefined;
              return (
                <tr key={i} className="border-b border-nms-border/50 hover:bg-nms-surface-2">
                  <td className="py-1.5 pr-4">
                    <div className="flex items-center gap-1.5">
                      {color && <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color + '55', border: `1.5px solid ${color}` }} />}
                      <span className="font-mono text-nms-text-dim">Slot {i + 1}</span>
                    </div>
                  </td>
                  <td className="py-1.5 pr-4 font-mono text-nms-text">
                    {(s.low/1e6).toFixed(1)}–{(s.high/1e6).toFixed(1)} MHz
                  </td>
                  <td className="py-1.5 pr-4 font-mono">
                    <span className="text-nms-accent">{s.displayArfcn ?? s.earfcn}</span>
                    <span className="text-nms-text-dim text-xs ml-1">{s.arfcnLabel ?? 'EARFCN'}</span>
                    {s.nrArfcn && s.arfcnLabel !== 'NR-ARFCN' && (
                      <span className="text-nms-text-dim/60 text-xs ml-2">/ {s.nrArfcn} <span className="text-purple-400/70">NR</span></span>
                    )}
                    {s.arfcnLabel === 'NR-ARFCN' && s.earfcn && (
                      <span className="text-nms-text-dim/60 text-xs ml-2">/ {s.earfcn} <span className="text-nms-accent/60">LTE</span></span>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 font-mono">
                    {s.serial
                      ? <span style={{ color }}>{s.serial}</span>
                      : <span className="text-nms-text-dim italic">unassigned</span>}
                  </td>
                  <td className="py-1.5">
                    {s.state
                      ? <span className={clsx('inline-flex items-center gap-1',
                          s.state === 'AUTHORIZED' ? 'text-green-400' : 'text-amber-400')}>
                          <span className={clsx('w-1.5 h-1.5 rounded-full',
                            s.state === 'AUTHORIZED' ? 'bg-green-400' : 'bg-amber-400')} />
                          {s.state}
                        </span>
                      : <span className="text-nms-text-dim">free</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-nms-text-dim">
        Band: <span className="font-mono text-nms-text">{lowMhz.toFixed(1)}–{highMhz.toFixed(1)} MHz ({bandMhz.toFixed(0)} MHz)</span>
        &nbsp;·&nbsp;
        Slot width: <span className="font-mono text-nms-text">{(slotWidthHz/1e6).toFixed(0)} MHz</span>
        &nbsp;·&nbsp;
        Total slots: <span className="font-mono text-nms-text">{slots.length}</span>
        &nbsp;·&nbsp;
        In use: <span className="font-mono text-nms-text">{usedSlots.length}</span>
      </p>
    </div>
  );
}

// ─── Stacked Band Chart — one row per band, all on same 3550–3700 MHz axis ──
// Each row only shows grants from the groups assigned to that band.
// This cleanly handles overlapping bands without visual collision.
function StackedBandChart({ bands, rfStatus = new Map() }: {
  bands: Array<{
    bandLow: number; bandHigh: number; label: string; slotWidthHz: number;
    bandId: string; assignedGroupIds: string[];
    slots: Array<{ low: number; high: number; earfcn: number; nrArfcn?: number; displayArfcn?: number; arfcnLabel?: string; radioTech?: string; cbsdId?: string; serial?: string; fccId?: string; state?: string; groupId?: string }>;
  }>;
  rfStatus?: Map<string, boolean | null>;
}) {
  const FULL_LOW   = 3_550_000_000;
  const FULL_HIGH  = 3_700_000_000;
  const FULL_WIDTH = FULL_HIGH - FULL_LOW;
  const pct = (hz: number) => ((hz - FULL_LOW) / FULL_WIDTH) * 100;

  // Assign stable colors per CBSD across all bands
  // Also scan grants[] array inside each slot so Nokia radios (which may only
  // appear in uniqueGlobalSlots) get a colour assigned before rendering.
  const cbsdColorMap = new Map<string, number>();
  let colorIdx = 0;
  for (const band of bands) {
    for (const s of band.slots) {
      if (s.cbsdId && !cbsdColorMap.has(s.cbsdId)) {
        cbsdColorMap.set(s.cbsdId, colorIdx++ % SLOT_COLORS.length);
      }
      for (const g of (s as any).grants ?? []) {
        if (g.cbsdId && !cbsdColorMap.has(g.cbsdId)) {
          cbsdColorMap.set(g.cbsdId, colorIdx++ % SLOT_COLORS.length);
        }
      }
    }
  }
  // Helper — never returns undefined
  const getColor = (cbsdId: string) => {
    if (!cbsdColorMap.has(cbsdId)) cbsdColorMap.set(cbsdId, colorIdx++ % SLOT_COLORS.length);
    return SLOT_COLORS[cbsdColorMap.get(cbsdId)! % SLOT_COLORS.length];
  };

  // Tick marks every 10 MHz
  const ticks: number[] = [];
  for (let f = 3560; f <= 3700; f += 10) ticks.push(f * 1e6);

  // Collect all CBSDs with active grants that aren't covered by any band's assignedGroupIds
  const allAssignedGroups = new Set(bands.flatMap(b => b.assignedGroupIds));
  const globalSlots = bands.flatMap(b => b.slots).filter(s =>
    s.cbsdId && (!s.groupId || !allAssignedGroups.has(s.groupId))
  );
  // Deduplicate by cbsdId
  const seenGlobal = new Set<string>();
  const uniqueGlobalSlots = globalSlots.filter(s => {
    if (seenGlobal.has(s.cbsdId!)) return false;
    seenGlobal.add(s.cbsdId!);
    return true;
  });

  const totalGrants = bands.reduce((acc, b) => {
    const groupFilter = b.assignedGroupIds.length > 0 ? b.assignedGroupIds : null;
    return acc + b.slots.filter(s => s.cbsdId && (!groupFilter || (s.groupId && groupFilter.includes(s.groupId)))).length;
  }, 0);

  return (
    <div className="space-y-4">
      {bands.map((band, bi) => {
        const bandColor = SLOT_COLORS[bi % SLOT_COLORS.length];
        const groupFilter = band.assignedGroupIds.length > 0 ? band.assignedGroupIds : null;

        // Build expanded entries — one per grant per slot so multiple CBSDs
        // on the same frequency all appear (e.g. two Sercomm radios with same CA channels)
        const expandedEntries: Array<{ low: number; high: number; earfcn: number; nrArfcn?: number; displayArfcn?: number; arfcnLabel?: string; radioTech?: string; cbsdId?: string; serial?: string; fccId?: string; state?: string; groupId?: string }> = [];
        const seenUnassigned = new Set<string>();
        for (const s of band.slots) {
          const grants: Array<{ cbsdId: string; serial?: string; fccId?: string; state: string; groupId?: string }> =
            (s as any).grants ?? (s.cbsdId ? [{ cbsdId: s.cbsdId, serial: s.serial, fccId: s.fccId, state: s.state, groupId: s.groupId }] : []);
          const slotKey = `${s.low}-${s.high}`;
          if (grants.length === 0) {
            if (!seenUnassigned.has(slotKey)) {
              seenUnassigned.add(slotKey);
              expandedEntries.push({ ...s });
            }
          } else {
            for (const g of grants) {
              if (!groupFilter || (g.groupId && groupFilter.includes(g.groupId))) {
                expandedEntries.push({ ...s, ...g });
              }
            }
          }
        }
        const activeInRow = expandedEntries.filter(s => s.cbsdId);

        return (
          <div key={bi} className="flex items-stretch gap-3">
            {/* Band label — left side */}
            <div className="w-44 shrink-0 flex flex-col justify-center py-1">
              <p className="text-xs font-semibold break-words leading-snug" style={{ color: bandColor }} title={band.label}>{band.label}</p>
              <p className="text-xs font-mono text-nms-text-dim/60">
                {(band.bandLow/1e6).toFixed(0)}–{(band.bandHigh/1e6).toFixed(0)} MHz
              </p>
              {band.assignedGroupIds.length > 0 && (
                <p className="text-xs text-purple-400/70 break-words leading-snug" title={band.assignedGroupIds.join(', ')}>
                  {band.assignedGroupIds.join(', ')}
                </p>
              )}
            </div>

            {/* Chart row */}
            <div className="flex-1 relative h-16 rounded overflow-hidden bg-nms-surface border border-nms-border">
              {/* Band span indicator */}
              <div className="absolute inset-y-0 pointer-events-none"
                style={{
                  left:       `${pct(band.bandLow)}%`,
                  width:      `${pct(band.bandHigh) - pct(band.bandLow)}%`,
                  background: `${bandColor}08`,
                  borderLeft:  `1px solid ${bandColor}40`,
                  borderRight: `1px solid ${bandColor}40`,
                }}
              />

              {/* Unassigned slot hatching within band */}
              {expandedEntries.filter(s => !s.cbsdId).map((s, i) => (
                <div key={i} className="absolute inset-y-0"
                  style={{ left: `${pct(s.low)}%`, width: `${pct(s.high) - pct(s.low)}%` }}>
                  <div className="w-full h-full opacity-15"
                    style={{ backgroundImage: 'repeating-linear-gradient(-45deg,#6b7280 0,#6b7280 1px,transparent 0,transparent 50%)', backgroundSize: '5px 5px' }} />
                </div>
              ))}

              {/* Active grants — stacked vertically if multiple CBSDs share same slot */}
              {activeInRow.map((s, entryIdx) => {
                const sameSlot = activeInRow.filter(e => e.low === s.low && e.high === s.high);
                const pos      = sameSlot.indexOf(s);
                const count    = sameSlot.length;
                const slotW    = pct(s.high) - pct(s.low);
                const subW     = slotW / count;
                const subLeft  = pct(s.low) + pos * subW;
                const color    = getColor(s.cbsdId!);
                const label    = s.serial ? s.serial.slice(-6) : s.cbsdId?.slice(0, 6);
                const bwMhz    = (s.high - s.low) / 1e6;
                return (
                  <div key={`${s.cbsdId}-${entryIdx}`}
                    className="absolute inset-y-0 flex flex-col items-center justify-center px-0.5 overflow-hidden"
                    style={{ left: `${subLeft}%`, width: `${subW}%`, backgroundColor: color + '33', borderLeft: `2px solid ${color}`, borderRight: `2px solid ${color}` }}
                    title={`${s.serial ?? s.cbsdId}\n${(s.low/1e6).toFixed(1)}\u2013${(s.high/1e6).toFixed(1)} MHz (${bwMhz.toFixed(1)} MHz)\n${s.arfcnLabel ?? 'EARFCN'} ${s.displayArfcn ?? s.earfcn}\n${s.state}${s.groupId ? `\nGroup: ${s.groupId}` : ''}`}
                  >
                    <span className="text-xs font-bold truncate w-full text-center leading-tight" style={{ color }}>{label}</span>
                    <span className="text-xs font-mono truncate w-full text-center leading-tight" style={{ color: color + 'cc' }}>
                      {(s.low/1e6).toFixed(0)}–{(s.high/1e6).toFixed(0)}
                    </span>
                    <span className="text-xs font-mono truncate w-full text-center leading-tight opacity-70" style={{ color }}>
                      {bwMhz % 1 === 0 ? bwMhz.toFixed(0) : bwMhz.toFixed(1)} MHz
                    </span>
                    {/* Two status dots: SAS state (circle) + RF on/off (square) */}
                    <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5">
                      {/* SAS — circle */}
                      <div
                        className={`w-2 h-2 rounded-full ${
                          s.state === 'AUTHORIZED'
                            ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.9)]'
                            : s.state === 'GRANTED'
                            ? 'bg-sky-400'
                            : 'bg-nms-text-dim/40'
                        }`}
                        title={`SAS: ${s.state}`}
                      />
                      {/* RF — square */}
                      {(() => {
                        const rf = rfStatus.get(s.cbsdId!);
                        if (rf === true)  return <div className="w-2 h-2 rounded-sm bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.8)]" title="RF: ON" />;
                        if (rf === false) return <div className="w-2 h-2 rounded-sm bg-red-500" title="RF: OFF" />;
                        return <div className="w-2 h-2 rounded-sm bg-nms-text-dim/30 border border-nms-text-dim/40" title="RF: Unknown" />;
                      })()}
                    </div>
                  </div>
                );
              })}

              {/* Tick lines */}
              {ticks.map(hz => (
                <div key={hz} className="absolute inset-y-0 w-px bg-nms-border/20"
                  style={{ left: `${pct(hz)}%` }} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Global default row — always shown; displays CBSDs on global default (no group pinned to a band) */}
      {uniqueGlobalSlots.length > 0 && (
        <div className="flex items-stretch gap-3">
          <div className="w-44 shrink-0 flex flex-col justify-center py-1">
            <p className="text-xs font-semibold text-nms-text-dim">Global Default</p>
            <p className="text-xs font-mono text-nms-text-dim/60">no group</p>
          </div>
          <div className="flex-1 relative h-16 rounded overflow-hidden bg-nms-surface border border-nms-border border-dashed">
            {uniqueGlobalSlots.map((s, entryIdx) => {
              const color = getColor(s.cbsdId!);
              const label = s.serial ? s.serial.slice(-6) : s.cbsdId?.slice(0, 6);
              const leftPct = pct(s.low);
              const widthPct = pct(s.high) - pct(s.low);
              const bwMhz = (s.high - s.low) / 1e6;
              return (
                <div key={`global-${s.cbsdId}-${entryIdx}`}
                  className="absolute inset-y-0 flex flex-col items-center justify-center px-0.5 overflow-hidden"
                  style={{ left: `${leftPct}%`, width: `${widthPct}%`, backgroundColor: color + '33', borderLeft: `2px solid ${color}`, borderRight: `2px solid ${color}` }}
                  title={`${s.serial ?? s.cbsdId}\n${(s.low/1e6).toFixed(1)}\u2013${(s.high/1e6).toFixed(1)} MHz (${bwMhz.toFixed(1)} MHz)\n${s.state}\nGlobal default`}
                >
                  <span className="text-xs font-bold truncate w-full text-center leading-tight" style={{ color }}>{label}</span>
                  <span className="text-xs font-mono truncate w-full text-center leading-tight" style={{ color: color + 'cc' }}>
                    {(s.low/1e6).toFixed(0)}\u2013{(s.high/1e6).toFixed(0)}
                  </span>
                  <span className="text-xs font-mono truncate w-full text-center leading-tight opacity-70" style={{ color }}>
                    {bwMhz % 1 === 0 ? bwMhz.toFixed(0) : bwMhz.toFixed(1)} MHz
                  </span>
                  <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5">
                    <div className={`w-2 h-2 rounded-full ${
                      s.state === 'AUTHORIZED' ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.9)]'
                      : s.state === 'GRANTED'  ? 'bg-sky-400'
                      : 'bg-nms-text-dim/40'
                    }`} title={`SAS: ${s.state}`} />
                    {(() => {
                      const rf = rfStatus.get(s.cbsdId!);
                      if (rf === true)  return <div className="w-2 h-2 rounded-sm bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.8)]" title="RF: ON" />;
                      if (rf === false) return <div className="w-2 h-2 rounded-sm bg-red-500" title="RF: OFF" />;
                      return <div className="w-2 h-2 rounded-sm bg-nms-text-dim/30 border border-nms-text-dim/40" title="RF: Unknown" />;
                    })()}
                  </div>
                </div>
              );
            })}
            {ticks.map(hz => (
              <div key={hz} className="absolute inset-y-0 w-px bg-nms-border/20" style={{ left: `${pct(hz)}%` }} />
            ))}
          </div>
        </div>
      )}
      <div className="flex items-stretch gap-3">
        <div className="w-44 shrink-0" />
        <div className="flex-1 relative h-4">
          {ticks.map(hz => (
            <span key={hz} className="absolute text-xs font-mono text-nms-text-dim -translate-x-1/2"
              style={{ left: `${pct(hz)}%` }}>
              {(hz/1e6).toFixed(0)}
            </span>
          ))}
          <span className="absolute right-0 text-xs font-mono text-nms-text-dim">MHz</span>
        </div>
      </div>

      {/* Legend — all active grants across all rows */}
      {totalGrants > 0 && (
        <div className="flex flex-wrap gap-3 pt-2">
          {bands.map((band, bi) => {
            const groupFilter = band.assignedGroupIds.length > 0 ? band.assignedGroupIds : null;
            return band.slots
              .filter(s => s.cbsdId && (!groupFilter || (s.groupId && groupFilter.includes(s.groupId))))
              .map(s => {
                const color = getColor(s.cbsdId!);
                return (
                  <div key={`${bi}-${s.cbsdId}`} className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color + '55', border: `1.5px solid ${color}` }} />
                    <span className="text-xs text-nms-text-dim">
                      {s.serial ? s.serial.slice(-8) : s.cbsdId?.slice(0, 8)}
                      <span className="font-mono ml-1 text-nms-text-dim/60">{(s.low/1e6).toFixed(1)}–{(s.high/1e6).toFixed(1)} MHz</span>
                      {s.state === 'AUTHORIZED' && <span className="ml-1 text-green-400">●</span>}
                    </span>
                  </div>
                );
              });
          })}
        </div>
      )}

      <p className="text-xs text-nms-text-dim">
        Full CBRS band: <span className="font-mono text-nms-text">3550–3700 MHz (150 MHz)</span>
        &nbsp;·&nbsp;
        Configured bands: <span className="font-mono text-nms-text">{bands.length}</span>
        &nbsp;·&nbsp;
        Active grants: <span className="font-mono text-nms-text">{totalGrants}</span>
      </p>
    </div>
  );
}

// ─── CBSD Policy Editor — inline popover for the table row ─────────────────────────────────
function CbsdPolicyEditor({ cbsd, bands, currentBandId, notes, isSaving, onSave }: {
  cbsd: any;
  bands: Array<{ id: string; label: string; lowFrequency: number; highFrequency: number; maxBandwidthMhz: number }>;
  currentBandId: string;
  notes: string;
  isSaving: boolean;
  onSave: (bandId: string, notes: string) => void;
}) {
  const [open, setOpen]     = useState(false);
  const [bandId, setBandId] = useState(currentBandId);
  const [note, setNote]     = useState(notes);

  useEffect(() => { setBandId(currentBandId); setNote(notes); }, [currentBandId, notes]);

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-accent text-xs px-2 py-1 flex items-center gap-1"
      >
        <Settings className="w-3 h-3" />
        {currentBandId ? 'Edit' : 'Set'}
      </button>

      {/* Fixed-position modal — never clipped by table overflow */}
      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Modal */}
          <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 bg-nms-bg border border-nms-border rounded-lg shadow-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-nms-text truncate flex-1 mr-2">{cbsd.cbsdSerialNumber}</p>
              <button onClick={() => setOpen(false)} className="text-nms-text-dim hover:text-nms-text">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div>
              <label className="nms-label text-xs">Band Override</label>
              <select className="nms-input font-mono text-xs" value={bandId} onChange={e => setBandId(e.target.value)}>
                <option value="">— Global default / group policy —</option>
                {bands.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.label} ({(b.lowFrequency/1e6).toFixed(1)}–{(b.highFrequency/1e6).toFixed(1)} MHz)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="nms-label text-xs">Notes (optional)</label>
              <input className="nms-input text-xs" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Building A Sercomm" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => { onSave(bandId, note); setOpen(false); }} disabled={isSaving}
                className="nms-btn-primary text-xs flex-1 flex items-center justify-center gap-1">
                {isSaving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                Save
              </button>
              <button onClick={() => setOpen(false)} className="nms-btn border border-nms-border text-nms-text-dim text-xs px-3">
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ─── Band Policy Tab ────────────────────────────────────────────────────────────────────────────
function BandPolicyTab({ config, cbsds }: { config: any; cbsds: any[] }) {
  const bands: Array<{ id: string; label: string; lowFrequency: number; highFrequency: number; maxBandwidthMhz: number }> =
    config?.frequencyBands ?? [];

  const [groupPolicies, setGroupPolicies] = useState<Record<string, string>>({}); // groupId -> bandId
  const [cbsdPolicies,  setCbsdPolicies]  = useState<Record<string, string>>({}); // "fccId:serial" -> bandId
  const [cbsdNotes,     setCbsdNotes]     = useState<Record<string, string>>({});
  const [groupNotes,    setGroupNotes]    = useState<Record<string, string>>({});
  const [groupCustomSlots, setGroupCustomSlots] = useState<Record<string, Array<{low:number;high:number;label?:string}> | undefined>>({});
  // Snapshot of groupCustomSlots as of the last successful load()/save — only ever
  // written there, never by editing. Used to detect whether the live editing state
  // actually differs from what's persisted (see the "Unsaved" banner below).
  const [savedGroupCustomSlots, setSavedGroupCustomSlots] = useState<Record<string, Array<{low:number;high:number;label?:string}> | undefined>>({});
  // _key is a client-only, never-edited snapshot of _id taken at load/creation time —
  // used purely for React's list `key` and for sort stability. Without it, both the
  // row's key and its sort position tracked the live _id text, so every keystroke in
  // the name field re-sorted the list alphabetically AND forced React to unmount/
  // remount the row's <input> (new key = new DOM node), which drops focus mid-word —
  // the exact "jumps around while typing" symptom. All actual save/policy logic still
  // keys off the live `_id`; only ordering/identity for React is pinned to `_key`.
  const [manualGroups,  setManualGroups]  = useState<Array<{ _id: string; cbsdIds: string[]; _key: string }>>([]);
  const [saving,        setSaving]        = useState<Record<string, boolean>>({});
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set());
  const toggleMembers = (groupId: string) => setExpandedMembers(s => {
    const n = new Set(s); n.has(groupId) ? n.delete(groupId) : n.add(groupId); return n;
  });

  const load = useCallback(async () => {
    try {
      const [gp, cp, mg] = await Promise.all([sasApi.listGroupPolicies(), sasApi.listCbsdPolicies(), sasApi.listManualGroups()]);
      setGroupPolicies(Object.fromEntries(gp.map((p: any) => [p._id, p.bandId])));
      setGroupNotes(Object.fromEntries(gp.map((p: any) => [p._id, p.notes ?? ''])));
      setGroupCustomSlots(Object.fromEntries(gp.map((p: any) => [p._id, p.customSlots])));
      setSavedGroupCustomSlots(Object.fromEntries(gp.map((p: any) => [p._id, p.customSlots])));
      setCbsdPolicies(Object.fromEntries(cp.map((p: any) => [p._id, p.bandId])));
      setCbsdNotes(Object.fromEntries(cp.map((p: any) => [p._id, p.notes ?? ''])));
      setManualGroups(mg.map((m: any) => ({ ...m, _key: m._id })));
    } catch { /* silent */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Group CBSDs by interference group
  const groups = useMemo(() => {
    const map: Record<string, typeof cbsds> = {};
    for (const c of cbsds) {
      const gid = c.groupingParam?.find((p: any) => p.groupType === 'INTERFERENCE_COORDINATION')?.groupId;
      const key = gid ?? '__none__';
      (map[key] ??= []).push(c);
    }
    return map;
  }, [cbsds]);

  const GROUP_STALE_MS = 60 * 60 * 1000; // hide native groups inactive > 1 hour
  const groupIds = [...new Set([
    ...Object.keys(groups).filter(k => {
      if (k === '__none__') return false;
      if (manualGroups.some(mg => mg._id === k)) return false; // added separately below
      const members = groups[k] ?? [];
      return members.some(c => c.lastSeen && (Date.now() - new Date(c.lastSeen).getTime()) < GROUP_STALE_MS);
    }),
    ...manualGroups.map(mg => mg._id),
    // Groups with a saved band policy but zero current CBSD members — e.g. a
    // native group whose last radio was reconfigured/removed, or a manual
    // group whose members were all deleted. These have nothing deriving them
    // from live CBSDs, so without this they're invisible and un-prunable.
    ...Object.keys(groupPolicies),
  ])].sort((a, b) => {
    // Sort by each manual group's stable _key (not its live-edited _id) so a group
    // being renamed doesn't jump position in the list on every keystroke.
    const ka = manualGroups.find(mg => mg._id === a)?._key ?? a;
    const kb = manualGroups.find(mg => mg._id === b)?._key ?? b;
    return ka.localeCompare(kb);
  });
  const unassigned = groups['__none__']?.filter(c => !manualGroups.some(mg => mg.cbsdIds.includes(c.cbsdId))) ?? [];

  const mhz = (hz: number) => (hz / 1e6).toFixed(1);

  const saveGroup = async (groupId: string) => {
    const mg = manualGroups.find(g => g._id === groupId);
    const bandId = groupPolicies[groupId] ?? '';
    setSaving(s => ({ ...s, [groupId]: true }));
    try {
      if (mg) await sasApi.setManualGroup(mg._id, mg.cbsdIds);
      if (bandId) await sasApi.setGroupPolicy(groupId, bandId, groupNotes[groupId], groupCustomSlots[groupId]);
      else        await sasApi.deleteGroupPolicy(groupId).catch(() => {});
      await load();
      toast.success(`Group "${groupId}" saved`);
    } catch { toast.error('Failed to save group'); }
    finally { setSaving(s => ({ ...s, [groupId]: false })); }
  };

  const saveCbsdPolicy = async (fccId: string, serial: string, bandId: string) => {
    const key = `${fccId}:${serial}`;
    setSaving(s => ({ ...s, [key]: true }));
    try {
      if (!bandId) { await sasApi.deleteCbsdPolicy(fccId, serial); }
      else         { await sasApi.setCbsdPolicy(fccId, serial, bandId, cbsdNotes[key]); }
      await load();
      toast.success(`CBSD ${serial} policy saved`);
    } catch { toast.error('Failed to save CBSD policy'); }
    finally { setSaving(s => ({ ...s, [key]: false })); }
  };

  if (bands.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-nms-text-dim">
        <Wifi className="w-10 h-10 mb-3 opacity-30" />
        <p className="text-sm">No frequency bands configured</p>
        <p className="text-xs mt-1">Add bands in the Configuration tab first, then assign them here.</p>
      </div>
    );
  }

  const BandSelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select className="nms-input font-mono text-xs" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">— Global default —</option>
      {bands.map(b => (
        <option key={b.id} value={b.id}>
          {b.label}  ({mhz(b.lowFrequency)}–{mhz(b.highFrequency)} MHz, max {b.maxBandwidthMhz} MHz)
        </option>
      ))}
    </select>
  );

  const SlotPreview = ({ bandId, memberCount }: { bandId: string; memberCount: number }) => {
    const band = bands.find(b => b.id === bandId);
    if (!band) return null;
    const slotWidth = band.maxBandwidthMhz;
    const totalMhz  = (band.highFrequency - band.lowFrequency) / 1e6;
    const numSlots  = Math.floor(totalMhz / slotWidth);
    return (
      <div className="text-xs text-nms-text-dim mt-1">
        <span className="font-mono text-nms-text">{mhz(band.lowFrequency)}–{mhz(band.highFrequency)} MHz</span>
        {' · '}{numSlots} × {slotWidth} MHz slots
        {memberCount > 0 && numSlots > 0 && (
          <span className={clsx('ml-1', memberCount > numSlots ? 'text-red-400' : 'text-green-400')}>
            ({memberCount} member{memberCount > 1 ? 's' : ''}
            {memberCount > numSlots ? ` — ⚠ more members than slots, ${memberCount - numSlots} will share` : ` — ✓ fits in ${numSlots} slots`})
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">

      <div className="px-3 py-2 rounded-lg bg-nms-accent/5 border border-nms-accent/20 text-xs text-nms-text-dim">
        <p className="font-semibold text-nms-text mb-1">How band assignment works</p>
        <p><span className="text-nms-accent font-medium">1. Per-CBSD override</span> — pin one specific radio to a specific band (highest priority)</p>
        <p><span className="text-purple-400 font-medium">2. Interference group assignment</span> — assign all radios in a group to the same band; each gets a unique non-overlapping slot</p>
        <p><span className="text-nms-text-dim">3. Global default</span> — SAS picks the best-matching band based on what frequency the radio asks for</p>
      </div>

      {/* ── Interference Groups ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-nms-text flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-400 inline-block" />
            Interference Groups
          </h3>
          <button onClick={() => {
            const id = `group-${Date.now()}`;
            setManualGroups(g => [...g, { _id: id, cbsdIds: [], _key: id }]);
            setExpandedMembers(s => new Set([...s, id]));
          }} className="nms-btn-ghost flex items-center gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" /> New Group
          </button>
        </div>
        <p className="text-xs text-nms-text-dim">Radios in the same interference coordination group are all served spectrum from the assigned band. Create manual groups for radios that don't send a native group ID (e.g. Nokia). Manual group assignments take priority over native IDs.</p>
        {groupIds.length === 0 && <p className="text-xs text-nms-text-dim italic">No interference groups yet — create one above or wait for CBSDs to register with a group ID.</p>}
        {groupIds.map(groupId => {
          const manualEntry = manualGroups.find(mg => mg._id === groupId);
          const isManual = !!manualEntry;
          const nativeMembers = groups[groupId] ?? [];
          const allMembers = [
            ...nativeMembers,
            ...(manualEntry?.cbsdIds ?? [])
              .map(id => cbsds.find(c => c.cbsdId === id))
              .filter(Boolean)
              .filter(c => !nativeMembers.find(n => n.cbsdId === c!.cbsdId)),
          ];
          const currentBandId = groupPolicies[groupId] ?? '';
          const isSaving = saving[groupId];
          const showMembers = expandedMembers.has(groupId);
          const rowKey = manualEntry?._key ?? groupId;
          return (
            <div key={rowKey} className={clsx('nms-card space-y-3', isManual && 'border-amber-500/40 bg-amber-950/10')}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-2">

                  {/* Group name row */}
                  <div className="flex items-center gap-2">
                    {isManual ? (
                      <input
                        value={manualEntry._id}
                        onChange={e => setManualGroups(gs => gs.map(g => g._id === groupId ? { ...g, _id: e.target.value } : g))}
                        className="nms-input font-mono text-xs flex-1"
                        placeholder="e.g. nokia-sector-a"
                      />
                    ) : (
                      <p className="text-xs font-semibold text-purple-400 font-mono flex-1">{groupId}</p>
                    )}
                    <span className={clsx(
                      'text-xs px-1.5 py-0.5 rounded shrink-0 border',
                      isManual ? 'bg-amber-500/15 text-amber-400 border-amber-500/20' : 'bg-purple-500/15 text-purple-400 border-purple-500/20',
                    )}>{isManual ? 'Manual' : 'Native'}</span>
                  </div>

                  {/* Members summary + manage button */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-nms-text-dim">{allMembers.length} radio{allMembers.length !== 1 ? 's' : ''}:</span>
                    {allMembers.slice(0, 5).map(c => (
                      <span key={c!.cbsdId} className="text-xs font-mono text-nms-accent bg-nms-surface px-1.5 py-0.5 rounded border border-nms-border">{c!.cbsdSerialNumber}</span>
                    ))}
                    {allMembers.length > 5 && <span className="text-xs text-nms-text-dim">+{allMembers.length - 5} more</span>}
                    {allMembers.length === 0 && <span className="text-xs text-nms-text-dim italic">no members yet</span>}
                    {isManual && (
                      <button onClick={() => toggleMembers(groupId)}
                        className="text-xs text-nms-accent hover:text-nms-accent/80 flex items-center gap-1 ml-auto">
                        <Users className="w-3 h-3" />
                        {showMembers ? 'Done' : 'Add / Remove Radios'}
                        {showMembers ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>
                    )}
                  </div>

                  {/* CBSD picker panel */}
                  {isManual && showMembers && (
                    <div className="border border-nms-border rounded-lg p-2 bg-nms-bg space-y-1">
                      {cbsds.length === 0 && <p className="text-xs text-nms-text-dim italic px-1">No CBSDs registered yet.</p>}
                      {cbsds.map(c => {
                        const isAssigned = manualEntry.cbsdIds.includes(c.cbsdId);
                        const assignedElsewhere = !isAssigned && manualGroups.some(g => g._id !== groupId && g.cbsdIds.includes(c.cbsdId));
                        return (
                          <label key={c.cbsdId} className={clsx('flex items-center gap-2 cursor-pointer text-xs p-1.5 rounded hover:bg-nms-surface-2', assignedElsewhere && 'opacity-50')}>
                            <input type="checkbox"
                              checked={isAssigned}
                              disabled={assignedElsewhere}
                              onChange={e => setManualGroups(gs => gs.map(g => g._id !== groupId ? g : {
                                ...g,
                                cbsdIds: e.target.checked ? [...g.cbsdIds, c.cbsdId] : g.cbsdIds.filter(id => id !== c.cbsdId),
                              }))}
                              className="w-3.5 h-3.5 rounded"
                            />
                            <span className="font-mono text-nms-accent">{c.cbsdSerialNumber}</span>
                            <span className="text-nms-text-dim">{c.fccId}</span>
                            {c.groupingParam?.some((p: any) => p.groupType === 'INTERFERENCE_COORDINATION')
                              ? <span className="text-green-400/60 text-xs">(has native group)</span>
                              : <span className="text-amber-400/70 text-xs">(no native group)</span>}
                            {assignedElsewhere && <span className="text-red-400/70 text-xs ml-auto">in another group</span>}
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {/* Band selector */}
                  <div>
                    <label className="nms-label text-xs">Serve spectrum from this band</label>
                    <BandSelect value={currentBandId} onChange={v => setGroupPolicies(p => ({ ...p, [groupId]: v }))} />
                    {!currentBandId && <p className="text-xs text-amber-400 mt-1">Using global default — select a band above and click Save to pin this group.</p>}
                    <SlotPreview bandId={currentBandId} memberCount={allMembers.length} />
                    <div className="mt-2">
                      <input className="nms-input text-xs" placeholder="Notes (optional)" value={groupNotes[groupId] ?? ''}
                        onChange={e => setGroupNotes(n => ({ ...n, [groupId]: e.target.value }))} />
                    </div>
                  </div>
                </div>

                {/* Save + Delete */}
                <div className="flex gap-2 shrink-0 mt-0.5">
                  <button
                    onClick={() => saveGroup(groupId)}
                    disabled={isSaving || (isManual && !manualEntry._id.trim())}
                    className="nms-btn-primary text-xs flex items-center gap-1.5"
                  >
                    {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                    Save
                  </button>
                  {isManual ? (
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete group "${groupId}"?`)) return;
                        try {
                          await Promise.all([
                            sasApi.deleteManualGroup(groupId),
                            sasApi.deleteGroupPolicy(groupId).catch(() => {}),
                          ]);
                          await load();
                          toast.success('Group deleted');
                        } catch { toast.error('Failed to delete group'); }
                      }}
                      className="nms-btn-ghost text-xs text-red-400 flex items-center gap-1"
                      title="Delete this manual group"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        const memberList = nativeMembers.map(c => c.cbsdSerialNumber).join(', ') || 'none';
                        if (!confirm(
                          `Prune native group "${groupId}"?\n\n` +
                          `This removes ${nativeMembers.length} CBSD registration(s) and their grants ` +
                          `from the SAS server (${memberList}), plus any saved band policy for this group.\n\n` +
                          `If a radio in this group is still actually in use, it will simply re-register ` +
                          `and recreate the group the next time it checks in or reboots — this is safe to ` +
                          `use for groups you believe are stale.`
                        )) return;
                        try {
                          await Promise.all([
                            ...nativeMembers.map(c => sasApi.deleteCbsd(c.cbsdId)),
                            sasApi.deleteGroupPolicy(groupId).catch(() => {}),
                          ]);
                          await load();
                          toast.success(`Group "${groupId}" pruned`);
                        } catch { toast.error('Failed to prune group'); }
                      }}
                      className="nms-btn-ghost text-xs text-red-400 flex items-center gap-1"
                      title="Prune this native group — removes its CBSD registrations; still-active radios simply re-register"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Custom slots editor — shown whenever a band is assigned */}
              {currentBandId && (() => {
                  const band = bands.find(b => b.id === currentBandId);
                  const customSlots = groupCustomSlots[groupId];
                  // undefined = auto mode (use maxBandwidthMhz), [] = full band, [...] = custom slots
                  const isFullBand = Array.isArray(customSlots) && customSlots.length === 0;
                  const isCustom   = Array.isArray(customSlots) && customSlots.length > 0;
                  // Was previously `!isAuto` — true forever once a group has ANY custom
                  // slots configured, saved or not, since isAuto never flips back to true
                  // just from saving. Confirmed live: "Unsaved" stayed lit no matter how
                  // many times Save was clicked. Compare against the last-loaded snapshot
                  // instead, so it clears once the save actually round-trips.
                  const isDirty = JSON.stringify(customSlots) !== JSON.stringify(savedGroupCustomSlots[groupId]);
                  const isAuto     = customSlots === undefined;

                  // Compute display slots — what will actually appear in spectrumInquiry responses
                  const displaySlots: Array<{low:number;high:number;label?:string}> = isFullBand
                    ? band ? [{ low: band.lowFrequency, high: band.highFrequency, label: 'Full Band' }] : []
                    : isCustom
                      ? customSlots
                      : band ? (() => {
                          const bw = band.maxBandwidthMhz * 1_000_000;
                          const auto: Array<{low:number;high:number;label?:string}> = [];
                          let cur = band.lowFrequency, i = 1;
                          while (cur + bw <= band.highFrequency + 1) {
                            auto.push({ low: cur, high: cur + bw, label: `Slot ${i++}` });
                            cur += bw;
                          }
                          return auto;
                        })() : [];

                  const autoSlice = (mhz: number) => {
                    if (!band) return;
                    const bw = mhz * 1_000_000;
                    const slices: Array<{low:number;high:number;label?:string}> = [];
                    let cur = band.lowFrequency, i = 1;
                    while (cur + bw <= band.highFrequency + 1) {
                      slices.push({ low: cur, high: cur + bw, label: `${mhz} MHz Slot ${i++}` });
                      cur += bw;
                    }
                    setGroupCustomSlots(s => ({ ...s, [groupId]: slices }));
                  };

                  return (
                    <div className="border border-nms-border rounded-lg p-3 space-y-3">
                      {/* Header + mode indicator */}
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Slot Configuration</p>
                          {isFullBand && <span className="text-xs bg-purple-500/15 text-purple-300 border border-purple-500/30 rounded px-1.5 py-0.5">Full Band</span>}
                          {isCustom   && <span className="text-xs bg-nms-accent/10 text-nms-accent border border-nms-accent/20 rounded px-1.5 py-0.5">{customSlots.length} custom slot{customSlots.length !== 1 ? 's' : ''}</span>}
                          {isAuto     && <span className="text-xs bg-nms-surface-2 text-nms-text-dim border border-nms-border rounded px-1.5 py-0.5">Auto ({band?.maxBandwidthMhz ?? 20} MHz)</span>}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {/* Auto-slice buttons */}
                          <span className="text-xs text-nms-text-dim">Slice by:</span>
                          {[5, 10, 20, 40, 50, 80, 100].map(mhz => (
                            <button key={mhz} type="button" onClick={() => autoSlice(mhz)}
                              className="text-xs font-mono text-nms-accent border border-nms-accent/30 rounded px-2 py-0.5 hover:bg-nms-accent/10 transition-colors">
                              {mhz} MHz
                            </button>
                          ))}
                          <span className="text-nms-border">|</span>
                          <button type="button"
                            onClick={() => setGroupCustomSlots(s => ({ ...s, [groupId]: [] }))}
                            className={`text-xs border rounded px-2 py-0.5 transition-colors ${
                              isFullBand
                                ? 'text-purple-300 border-purple-500/40 bg-purple-500/10'
                                : 'text-purple-400 border-purple-500/30 hover:bg-purple-500/10'
                            }`}>
                            Full Band
                          </button>
                          {!isAuto && (
                            <button type="button"
                              onClick={() => setGroupCustomSlots(s => ({ ...s, [groupId]: undefined }))}
                              className="text-xs text-nms-text-dim border border-nms-border rounded px-2 py-0.5 hover:text-amber-400 transition-colors">
                              Reset Auto
                            </button>
                          )}
                          {(isCustom || isAuto) && (
                            <button type="button"
                              onClick={() => setGroupCustomSlots(s => ({ ...s, [groupId]: [...displaySlots] }))}
                              className="text-xs text-nms-text-dim border border-nms-border rounded px-2 py-0.5 hover:text-nms-text transition-colors">
                              + Add Slot
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Slot rows — always visible */}
                      {isFullBand ? (
                        <div className="px-3 py-2 rounded bg-purple-500/10 border border-purple-500/20">
                          <p className="text-xs text-purple-300">Every CBSD in this group receives the entire band: <span className="font-mono">{band ? `${(band.lowFrequency/1e6).toFixed(1)}–${(band.highFrequency/1e6).toFixed(1)} MHz` : ''}</span> — no slicing.</p>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {displaySlots.map((slot, si) => (
                            <div key={si} className="flex items-center gap-2 px-2 py-1.5 rounded border border-nms-border bg-nms-surface-2 text-xs">
                              <span className="text-nms-text-dim w-16 shrink-0 font-mono">{si + 1}.</span>
                              <input
                                className="nms-input text-xs w-28 py-0.5"
                                placeholder="Label"
                                value={slot.label ?? ''}
                                onChange={e => {
                                  const next = [...displaySlots];
                                  next[si] = { ...next[si], label: e.target.value };
                                  setGroupCustomSlots(s => ({ ...s, [groupId]: next }));
                                }}
                              />
                              <input
                                className="nms-input font-mono text-xs w-32 py-0.5"
                                type="number" placeholder="Low Hz"
                                value={slot.low}
                                onChange={e => {
                                  const next = [...displaySlots];
                                  next[si] = { ...next[si], low: Number(e.target.value) };
                                  setGroupCustomSlots(s => ({ ...s, [groupId]: next }));
                                }}
                              />
                              <span className="text-nms-text-dim">–</span>
                              <input
                                className="nms-input font-mono text-xs w-32 py-0.5"
                                type="number" placeholder="High Hz"
                                value={slot.high}
                                onChange={e => {
                                  const next = [...displaySlots];
                                  next[si] = { ...next[si], high: Number(e.target.value) };
                                  setGroupCustomSlots(s => ({ ...s, [groupId]: next }));
                                }}
                              />
                              <span className="text-nms-text-dim font-mono text-xs w-16">{((slot.high - slot.low)/1e6).toFixed(1)} MHz</span>
                              <button type="button"
                                onClick={() => {
                                  const next = displaySlots.filter((_, i) => i !== si);
                                  setGroupCustomSlots(s => ({ ...s, [groupId]: next }));
                                }}
                                className="text-nms-text-dim hover:text-red-400 ml-auto shrink-0" title="Delete slot">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          {displaySlots.length === 0 && (
                            <p className="text-xs text-nms-text-dim italic px-2">No slots — use the slice buttons above or add manually.</p>
                          )}
                        </div>
                      )}

                      {isDirty && (
                        <p className="text-xs text-amber-400/80">Unsaved — click Save to apply these slots.</p>
                      )}
                    </div>
                  );
                })()}
            </div>
          );
        })}
      </div>

      {/* ── Per-CBSD Overrides ── */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-nms-text flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-nms-accent inline-block" />
          Per-CBSD Overrides
          <span className="text-xs text-nms-text-dim font-normal">— takes priority over group policy</span>
        </h3>
        {cbsds.length === 0 && (
          <p className="text-xs text-nms-text-dim">No CBSDs registered yet.</p>
        )}
        {cbsds.length > 0 && (
          <div className="border border-nms-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-nms-surface-2">
                <tr>
                  <th className="px-3 py-2 text-left text-nms-text-dim font-medium">Serial</th>
                  <th className="px-3 py-2 text-left text-nms-text-dim font-medium">FCC ID</th>
                  <th className="px-3 py-2 text-left text-nms-text-dim font-medium">Group</th>
                  <th className="px-3 py-2 text-left text-nms-text-dim font-medium">Resolved Band</th>
                  <th className="px-3 py-2 text-left text-nms-text-dim font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nms-border">
                {cbsds.map(c => {
                  const key        = `${c.fccId}:${c.cbsdSerialNumber}`;
                  const overrideId = cbsdPolicies[key] ?? '';
                  const groupId    = c.groupingParam?.find((p: any) => p.groupType === 'INTERFERENCE_COORDINATION')?.groupId;
                  const groupBandId = groupId ? (groupPolicies[groupId] ?? '') : '';
                  const resolvedBand = overrideId
                    ? bands.find(b => b.id === overrideId)
                    : groupBandId
                      ? bands.find(b => b.id === groupBandId)
                      : null;
                  return (
                    <tr key={c.cbsdId} className="hover:bg-nms-surface-2/40">
                      <td className="px-3 py-2 font-mono text-nms-accent">
                        {c.cbsdSerialNumber}
                        {overrideId && <span className="ml-1.5 text-nms-accent">★</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-nms-text-dim">{c.fccId}</td>
                      <td className="px-3 py-2">
                        {groupId
                          ? <span className="text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded font-mono">{groupId}</span>
                          : <span className="text-nms-text-dim italic">none</span>}
                      </td>
                      <td className="px-3 py-2">
                        {overrideId
                          ? <span className="text-nms-accent">{resolvedBand?.label ?? overrideId} <span className="text-nms-text-dim">(override)</span></span>
                          : groupBandId
                            ? <span className="text-purple-400">{resolvedBand?.label ?? groupBandId} <span className="text-nms-text-dim">(group)</span></span>
                            : <span className="text-nms-text-dim">Global default</span>}
                      </td>
                      <td className="px-3 py-2">
                        <CbsdPolicyEditor
                          cbsd={c}
                          bands={bands}
                          currentBandId={overrideId}
                          notes={cbsdNotes[key] ?? ''}
                          isSaving={!!saving[key]}
                          onSave={(bandId, notes) => {
                            setCbsdPolicies(p => ({ ...p, [key]: bandId }));
                            setCbsdNotes(n => ({ ...n, [key]: notes }));
                            saveCbsdPolicy(c.fccId, c.cbsdSerialNumber, bandId);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Unassigned CBSDs ── */}
      {unassigned.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-nms-text flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-nms-text-dim inline-block" />
            No Interference Group
            <span className="text-xs text-nms-text-dim font-normal">— {unassigned.length} CBSD{unassigned.length > 1 ? 's' : ''} with no coordination group</span>
          </h3>
          <p className="text-xs text-nms-text-dim">These CBSDs have no interference coordination group. Assign a per-CBSD band override above, or they will use the global default.</p>
        </div>
      )}
    </div>
  );
}

function GrantStateDot({ state }: { state: string }) {
  return (
    <span className={clsx(
      'inline-block w-2 h-2 rounded-full mr-1.5',
      state === 'AUTHORIZED' && 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]',
      state === 'GRANTED'    && 'bg-amber-400',
      state === 'TERMINATED' && 'bg-red-500',
    )} />
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function SASPage() {
  const copyToClipboard = useCopyToClipboard();
  const [stats, setStats]     = useState<any>(null);
  const [cbsds, setCbsds]     = useState<any[]>([]);
  const [config, setConfig]   = useState<any>(null);
  const [slots, setSlots]     = useState<any>(null);
  const [rfStatus, setRfStatus] = useState<Map<string, boolean | null>>(new Map());
  const [ueCount, setUeCount]   = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<'dashboard' | 'config' | 'policy' | 'api'>('dashboard');
  const [verbose, setVerboseState] = useState(false);

  const toggleVerbose = async () => {
    try {
      const result = await sasApi.setVerbose(!verbose);
      setVerboseState(result.verbose);
      toast.success(`SAS logging: ${result.verbose ? 'verbose' : 'sparse'}`);
    } catch { toast.error('Failed to toggle verbose logging'); }
  };

  useEffect(() => {
    sasApi.getVerbose().then(r => setVerboseState(r.verbose)).catch(() => {});
  }, []);
  const [saving, setSaving]   = useState(false);
  const [cfgForm, setCfgForm] = useState<any>(null);
  const [showRefModal, setShowRefModal] = useState(false);
  const [paused, setPaused]   = useState(false);
  const [cert, setCert]       = useState<{ exists: boolean; size?: number; modified?: string; message?: string } | null>(null);
  useEffect(() => {
    sasApi.getStatus().then(s => setPaused(s.paused)).catch(() => {});
    sasApi.getCert().then(c => setCert(c)).catch(() => {});
  }, []);

  const [showFreqDebug, setShowFreqDebug] = useState(false);
  const [freqDebugData, setFreqDebugData]   = useState<any[]>([]);
  const [freqDebugLoading, setFreqDebugLoading] = useState(false);

  const openFreqDebug = async () => {
    setFreqDebugLoading(true);
    setShowFreqDebug(true);
    try {
      const data = await sasApi.getLastRequests();
      setFreqDebugData(data);
    } catch { toast.error('Failed to load freq debug data'); }
    finally { setFreqDebugLoading(false); }
  };

  const [cbsdSort, setCbsdSort] = useState<'asc' | 'desc' | null>('asc');

  const sortedCbsds = cbsdSort === null ? cbsds : [...cbsds].sort((a, b) => {
    const ag = (a.grants ?? []).find((g: any) => g.state === 'AUTHORIZED' || g.state === 'GRANTED');
    const bg = (b.grants ?? []).find((g: any) => g.state === 'AUTHORIZED' || g.state === 'GRANTED');
    const aLow = ag?.operationParam?.operationFrequencyRange?.lowFrequency ?? Infinity;
    const bLow = bg?.operationParam?.operationFrequencyRange?.lowFrequency ?? Infinity;
    return cbsdSort === 'asc' ? aLow - bLow : bLow - aLow;
  });
  // SAS logs moved to Unified Logs page — use the SAS Logs button there

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [s, c, cfg, sl, rf, iface] = await Promise.all([
        sasApi.getStats(),
        sasApi.getCbsds(),
        sasApi.getConfig(),
        sasApi.getSlots(),
        sasApi.getRfStatus().catch(() => []),
        interfaceApi.getStatus().catch(() => null),
      ]);
      setStats(s);
      setCbsds(c.cbsds ?? []);
      setConfig(cfg);
      setSlots(sl);
      setRfStatus(new Map((rf as any[]).map((r: any) => [r.cbsdId, r.rfOn])));
      if (iface) setUeCount((iface as any).activeSessions ?? (iface as any).ueCount ?? null);
      setCfgForm((prev: any) => prev ?? cfg);
    } catch {
      if (!silent) toast.error('Failed to load SAS data');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const updated = await sasApi.updateConfig(cfgForm);
      setConfig(updated);
      setCfgForm(updated);
      toast.success('SAS configuration saved');
    } catch {
      toast.error('Failed to save configuration');
    } finally { setSaving(false); }
  };

  const addBand = () => {
    const newBand = { id: `band-${Date.now()}`, label: 'New Band', lowFrequency: 3619000000, highFrequency: 3700000000, maxBandwidthMhz: 20 };
    setCfgForm((f: any) => ({ ...f, frequencyBands: [...(f.frequencyBands ?? []), newBand] }));
  };
  const updateBand = (index: number, updated: any) => {
    setCfgForm((f: any) => ({ ...f, frequencyBands: f.frequencyBands.map((b: any, i: number) => i === index ? updated : b) }));
  };
  const deleteBand = (index: number) => {
    setCfgForm((f: any) => ({ ...f, frequencyBands: f.frequencyBands.filter((_: any, i: number) => i !== index) }));
  };

  const ENDPOINTS = [
    { method: 'POST', path: '/registration',    desc: 'Register a CBSD with the SAS' },
    { method: 'POST', path: '/spectrumInquiry', desc: 'Query available CBRS spectrum' },
    { method: 'POST', path: '/grant',           desc: 'Request authorization to transmit' },
    { method: 'POST', path: '/heartbeat',       desc: 'Keep grant alive, get transmit expire time' },
    { method: 'POST', path: '/relinquishment',  desc: 'Voluntarily give up a grant' },
    { method: 'POST', path: '/deregistration',  desc: 'Remove CBSD from the SAS' },
  ];

  const TAB_LABELS: Record<string, string> = {
    dashboard: 'Dashboard',
    config:    'Configuration',
    policy:    'Band Assignment',
    api:       'API Reference',
  };

  return (
    <div className="p-6 space-y-6">

      {/* EARFCN Reference modal */}
      {showRefModal && <EarfcnReferenceModal onClose={() => setShowRefModal(false)} />}

      {/* Freq Debug modal */}
      {showFreqDebug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowFreqDebug(false)} />
          <div className="relative z-10 bg-nms-bg border border-nms-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-nms-border shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-nms-accent/20 border border-nms-accent/30 flex items-center justify-center">
                  <Activity className="w-4 h-4 text-nms-accent" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-nms-text">Last Requested Frequencies</h2>
                  <p className="text-xs text-nms-text-dim">Most recent spectrumInquiry / grant frequency per radio — resets on restart</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={openFreqDebug} disabled={freqDebugLoading}
                  className="nms-btn border border-nms-border text-nms-text-dim hover:text-nms-text text-xs flex items-center gap-1">
                  <RefreshCw className={clsx('w-3.5 h-3.5', freqDebugLoading && 'animate-spin')} />
                  Refresh
                </button>
                <button onClick={() => setShowFreqDebug(false)} className="text-nms-text-dim hover:text-nms-text">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* Body */}
            <div className="overflow-y-auto flex-1 p-4">
              {freqDebugLoading && (
                <div className="flex items-center justify-center h-32 text-nms-text-dim">
                  <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
                </div>
              )}
              {!freqDebugLoading && freqDebugData.length === 0 && (
                <div className="flex flex-col items-center justify-center h-32 text-nms-text-dim">
                  <Activity className="w-7 h-7 mb-2 opacity-30" />
                  <p className="text-sm">No requests recorded yet</p>
                  <p className="text-xs mt-1">Radios must send at least one spectrumInquiry or grant request after this page loads</p>
                </div>
              )}
              {!freqDebugLoading && freqDebugData.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-nms-border text-nms-text-dim">
                      <th className="text-left py-2 pr-4">Serial</th>
                      <th className="text-left py-2 pr-4">Radio IP</th>
                      <th className="text-left py-2 pr-4">Requested Low</th>
                      <th className="text-left py-2 pr-4">Requested High</th>
                      <th className="text-left py-2 pr-4">BW</th>
                      <th className="text-left py-2 pr-4">Type</th>
                      <th className="text-left py-2">Last Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {freqDebugData.map(r => {
                      const isNR       = r.radioTech === 'NR';
                      const lowMhz     = (r.lowFrequency  / 1e6).toFixed(1);
                      const highMhz    = (r.highFrequency / 1e6).toFixed(1);
                      const bwMhz      = ((r.highFrequency - r.lowFrequency) / 1e6).toFixed(0);
                      const arfcnLabel = isNR ? 'NR-ARFCN' : 'EARFCN';
                      const lowArfcn   = isNR
                        ? Math.round((r.lowFrequency  / 1e6 - 3000) / 0.015 + 600000)
                        : Math.round(55240 + (r.lowFrequency  / 1e6 - 3550) * 10);
                      const highArfcn  = isNR
                        ? Math.round((r.highFrequency / 1e6 - 3000) / 0.015 + 600000)
                        : Math.round(55240 + (r.highFrequency / 1e6 - 3550) * 10);
                      return (
                        <tr key={r.cbsdId} className="border-b border-nms-border/50 hover:bg-nms-surface-2">
                          <td className="py-2 pr-4 font-mono text-nms-accent">
                            {r.serial}
                            {isNR && <span className="ml-1.5 text-xs px-1 py-0.5 rounded bg-purple-500/20 text-purple-400">NR</span>}
                          </td>
                          <td className="py-2 pr-4 font-mono text-nms-text-dim">{r.ip || '—'}</td>
                          <td className="py-2 pr-4">
                            <span className="font-mono text-nms-text">{lowMhz} MHz</span>
                            <span className="text-nms-text-dim ml-1.5 font-mono text-xs">{arfcnLabel} {lowArfcn}</span>
                          </td>
                          <td className="py-2 pr-4">
                            <span className="font-mono text-nms-text">{highMhz} MHz</span>
                            <span className="text-nms-text-dim ml-1.5 font-mono text-xs">{arfcnLabel} {highArfcn}</span>
                          </td>
                          <td className="py-2 pr-4 font-mono text-nms-text-dim">{bwMhz} MHz</td>
                          <td className="py-2 pr-4">
                            <span className={clsx(
                              'px-1.5 py-0.5 rounded text-xs font-medium',
                              r.type === 'grant' ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'
                            )}>{r.type}</span>
                          </td>
                          <td className="py-2 text-nms-text-dim">{new Date(r.ts).toLocaleTimeString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">Spectrum Access System</h1>
          <p className="text-sm text-nms-text-dim mt-1">WinnForum CBRS SAS-CBSD Interface — WINNF-TS-0016 V1.2.7</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={toggleVerbose}
            className={clsx(
              'nms-btn-ghost flex items-center gap-2 text-sm',
              verbose && 'text-amber-400'
            )}
          >
            <ScrollText className="w-4 h-4" />
            {verbose ? 'Verbose ON' : 'Verbose OFF'}
          </button>
          <button onClick={openFreqDebug} className="nms-btn-ghost flex items-center gap-2 text-sm">
            <Activity className="w-4 h-4" /> Freq Debug
          </button>
          <button onClick={() => load()} disabled={loading} className="nms-btn-ghost flex items-center gap-2 text-sm">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} /> Refresh
          </button>
          <button
            onClick={async () => {
              if (!confirm('Clear all SAS grants and CBSDs?\n\nThis deletes all grants and registered CBSDs from the database. Radios will re-register on next contact.')) return;
              try {
                const r = await sasApi.reset();
                toast.success(`Cleared — deleted ${r.deletedGrants} grants, ${r.deletedCbsds} CBSDs`);
                load(true);
              } catch { toast.error('Clear failed'); }
            }}
            className="nms-btn-ghost flex items-center gap-2 text-sm text-amber-400"
          >
            <Trash2 className="w-4 h-4" /> Clear DB
          </button>
          <button
            onClick={async () => {
              try {
                if (paused) {
                  await sasApi.resume();
                  setPaused(false);
                  toast.success('SAS resumed — radios will re-register');
                } else {
                  await sasApi.pause();
                  setPaused(true);
                  toast.success('SAS paused — radios will stop transmitting');
                }
              } catch { toast.error('Failed to change SAS state'); }
            }}
            className={clsx(
              'flex items-center gap-2 text-sm',
              paused ? 'nms-btn-primary' : 'nms-btn-danger'
            )}
          >
            {paused ? <>▶ Resume SAS</> : <>⏸ Pause SAS</>}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex justify-center">
        <div className="flex flex-wrap gap-1 bg-nms-surface rounded-lg p-1">
        {(['dashboard', 'config', 'policy', 'api'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={clsx(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
              tab === t
                ? 'bg-nms-accent/10 text-nms-accent border border-nms-accent/20'
                : 'text-nms-text-dim hover:text-nms-text',
            )}>
            {TAB_LABELS[t]}
          </button>
        ))}
        </div>
      </div>

      {/* ── Dashboard ── */}
      {tab === 'dashboard' && (
        <div className="space-y-5">
          {paused && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-red-400">⏸ SAS is PAUSED</p>
                <p className="text-xs text-red-300/70">All radio requests are returning DEREGISTER. Radios have stopped transmitting. Click Resume SAS to restore normal operation.</p>
              </div>
            </div>
          )}
          {/* Stats grid — 4 cards */}
          {(() => {
            const totalRadios  = stats?.registeredCbsds ?? 0;
            const rfOnCount    = [...rfStatus.values()].filter(v => v === true).length;
            const rfOffCount   = [...rfStatus.values()].filter(v => v === false).length;
            const offlineCount = totalRadios - rfStatus.size; // in SAS but not in GenieACS
            return (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* SAS Grants */}
                <div className="nms-card">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs text-nms-text-dim uppercase tracking-wider">Active Grants</p>
                      <p className="text-2xl font-bold text-nms-text mt-1">{stats?.activeGrants ?? '—'}</p>
                      <p className="text-xs text-nms-text-dim mt-1">
                        <span className="text-green-400">{stats?.authorizedGrants ?? 0} authorized</span>
                        {stats?.activeGrants != null && stats?.authorizedGrants != null && stats.activeGrants > stats.authorizedGrants && (
                          <span className="text-amber-400 ml-1">{stats.activeGrants - stats.authorizedGrants} granted</span>
                        )}
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-amber-500/10"><Wifi className="w-5 h-5 text-amber-400" /></div>
                  </div>
                </div>

                {/* Radio RF status */}
                <div className="nms-card">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs text-nms-text-dim uppercase tracking-wider">Radios</p>
                      <p className="text-2xl font-bold text-nms-text mt-1">{totalRadios}</p>
                      <div className="flex flex-wrap gap-x-2 mt-1 text-xs">
                        {rfOnCount  > 0 && <span className="text-cyan-400">{rfOnCount} RF on</span>}
                        {rfOffCount > 0 && <span className="text-red-400">{rfOffCount} RF off</span>}
                        {offlineCount > 0 && <span className="text-nms-text-dim">{offlineCount} no ACS</span>}
                        {totalRadios === 0 && <span className="text-nms-text-dim">none registered</span>}
                      </div>
                    </div>
                    <div className="p-2.5 rounded-lg bg-blue-500/10"><Radio className="w-5 h-5 text-blue-400" /></div>
                  </div>
                </div>

                {/* Authorized (SAS) */}
                <div className="nms-card">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs text-nms-text-dim uppercase tracking-wider">SAS Authorized</p>
                      <p className="text-2xl font-bold text-nms-text mt-1">{stats?.authorizedGrants ?? '—'}</p>
                      <p className="text-xs text-nms-text-dim mt-1">Transmit permission active</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-green-500/10"><CheckCircle className="w-5 h-5 text-green-400" /></div>
                  </div>
                </div>

                {/* Active UEs */}
                <div className="nms-card">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs text-nms-text-dim uppercase tracking-wider">Active UEs</p>
                      <p className="text-2xl font-bold text-nms-text mt-1">{ueCount ?? '—'}</p>
                      <p className="text-xs text-nms-text-dim mt-1">Connected devices</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-purple-500/10"><Users className="w-5 h-5 text-purple-400" /></div>
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="nms-card space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <Wifi className="w-4 h-4 text-nms-accent" />
                Frequency Spectrum
              </h2>
              <DotLegend />
            </div>
            {slots && (slots.bands?.length > 0 || slots.slots?.length > 0)
              ? (() => {
                  const bandList = slots.bands ?? [{ bandLow: slots.bandLow, bandHigh: slots.bandHigh, label: 'Band', slotWidthHz: slots.slotWidthHz, slots: slots.slots }];
                  return (
                    <div className="space-y-6">
                      {/* Per-band charts — each filtered to its assigned groups only */}
                      {bandList.map((band: any, i: number) => (
                        <div key={i}>
                          <p className="text-xs font-medium text-nms-text-dim mb-2">
                            {band.label}
                            <span className="text-nms-text-dim/60 font-mono ml-2">{(band.bandLow/1e6).toFixed(1)}–{(band.bandHigh/1e6).toFixed(1)} MHz</span>
                            {band.assignedGroupIds?.length > 0 && (
                              <span className="ml-2 text-purple-400/80">— group: {band.assignedGroupIds.join(', ')}</span>
                            )}
                          </p>
                          <SpectrumChart
                            slots={band.slots}
                            bandLow={band.bandLow}
                            bandHigh={band.bandHigh}
                            slotWidthHz={band.slotWidthHz}
                            filterGroupIds={band.assignedGroupIds?.length > 0 ? band.assignedGroupIds : undefined}
                            rfStatus={rfStatus}
                          />
                        </div>
                      ))}
                      {/* Stacked full CBRS view — always shown, one row per band */}
                      <div className="pt-2">
                        <p className="text-xs font-medium text-nms-text-dim mb-3">
                          All Bands — Full CBRS View
                          <span className="text-nms-text-dim/60 font-mono ml-2">3550–3700 MHz</span>
                        </p>
                        <StackedBandChart bands={bandList} rfStatus={rfStatus} />
                      </div>
                    </div>
                  );
                })()
              : <p className="text-xs text-nms-text-dim py-4 text-center">No frequency bands configured — add a band in the Configuration tab</p>
            }
          </div>

          <div className="nms-card space-y-3">
            <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
              <Activity className="w-4 h-4 text-nms-accent" />
              Registered CBSDs
            </h2>
            {loading && <div className="flex items-center justify-center h-24 text-nms-text-dim"><RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…</div>}
            {!loading && cbsds.length === 0 && (
              <div className="flex flex-col items-center justify-center h-24 text-nms-text-dim border border-dashed border-nms-border rounded-lg">
                <Shield className="w-7 h-7 mb-1.5 opacity-30" />
                <p className="text-sm">No CBSDs registered yet</p>
              </div>
            )}
            {!loading && cbsds.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-nms-border text-nms-text-dim">
                      <th className="text-left py-2 pr-4">CBSD ID</th>
                      <th className="text-left py-2 pr-4">FCC ID</th>
                      <th className="text-left py-2 pr-4">Serial</th>
                      <th className="text-left py-2 pr-4">Category</th>
                      <th className="text-left py-2 pr-4">Assigned Channel</th>
                      <th className="text-left py-2 pr-4">
                        <button
                          onClick={() => setCbsdSort(s => s === 'asc' ? 'desc' : 'asc')}
                          className="flex items-center gap-1 hover:text-nms-accent transition-colors"
                          title="Sort by ARFCN">
                          ARFCN
                          <span className="text-nms-text-dim">
                            {cbsdSort === 'asc' ? '↑' : cbsdSort === 'desc' ? '↓' : '⇅'}
                          </span>
                        </button>
                      </th>
                      <th className="text-left py-2 pr-4">Grants</th>
                      <th className="text-left py-2 pr-4">Last Seen</th>
                      <th className="text-left py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCbsds.map(c => {
                      // Find active grant for this CBSD
                      const activeGrant = (c.grants ?? []).find((g: any) => g.state === 'AUTHORIZED' || g.state === 'GRANTED');
                      const grantLow    = activeGrant?.operationParam?.operationFrequencyRange?.lowFrequency;
                      const grantHigh   = activeGrant?.operationParam?.operationFrequencyRange?.highFrequency;
                      const isNrCbsd    = c.airInterface?.radioTechnology === 'NR';
                      const centerMhz   = grantLow && grantHigh ? (grantLow + grantHigh) / 2 / 1e6 : null;
                      const earfcn      = centerMhz
                        ? isNrCbsd
                          ? Math.round((centerMhz - 3000) / 0.015 + 600000)
                          : Math.round(55240 + (centerMhz - 3550) * 10)
                        : null;
                      const earfcnLabel = isNrCbsd ? 'NR-ARFCN' : 'EARFCN';
                      const channelStr  = grantLow && grantHigh
                        ? `${(grantLow/1e6).toFixed(1)}–${(grantHigh/1e6).toFixed(1)} MHz`
                        : null;
                      // Match slot color
                      const slotEntry   = slots?.slots?.find((s: any) => s.cbsdId === c.cbsdId);
                      const slotIdx     = slotEntry ? slots?.slots?.filter((s: any) => s.cbsdId).indexOf(slotEntry) : -1;
                      const color       = slotIdx >= 0 ? SLOT_COLORS[slotIdx % SLOT_COLORS.length] : undefined;
                      return (
                      <tr key={c.cbsdId} className="border-b border-nms-border/50 hover:bg-nms-surface-2">
                        <td className="py-2 pr-4 font-mono text-nms-accent">{c.cbsdId.slice(0, 8)}…</td>
                        <td className="py-2 pr-4 font-mono">{c.fccId}</td>
                        <td className="py-2 pr-4 font-mono text-nms-text-dim">{c.cbsdSerialNumber}</td>
                        <td className="py-2 pr-4">{c.cbsdCategory ?? 'A'}</td>
                        <td className="py-2 pr-4 font-mono">
                          {channelStr
                            ? <span style={{ color }}>{channelStr}</span>
                            : <span className="text-nms-text-dim">—</span>}
                        </td>
                        <td className="py-2 pr-4 font-mono">
                          {earfcn
                            ? <span className="text-nms-accent">{earfcn}<span className="text-nms-text-dim text-xs ml-1">{earfcnLabel}</span></span>
                            : <span className="text-nms-text-dim">—</span>}
                        </td>
                        <td className="py-2 pr-4">
                          {(c.grants ?? []).length === 0
                            ? <span className="text-nms-text-dim">—</span>
                            : (c.grants as any[]).map((g: any) => (
                              <span key={g.grantId} className="inline-flex items-center gap-1 mr-2">
                                <GrantStateDot state={g.state} />
                                <span className={clsx(
                                  g.state === 'AUTHORIZED' && 'text-green-400',
                                  g.state === 'GRANTED'    && 'text-amber-400',
                                  g.state === 'TERMINATED' && 'text-red-400',
                                )}>{g.state}</span>
                                <button onClick={async () => {
                                  if (!confirm(`Delete grant ${g.grantId.slice(0,8)}…?`)) return;
                                  try { await sasApi.deleteGrant(g.grantId); toast.success('Grant deleted'); load(true); }
                                  catch { toast.error('Failed to delete grant'); }
                                }} className="text-nms-text-dim hover:text-red-400 transition-colors ml-0.5" title="Delete grant">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </span>
                            ))
                          }
                        </td>
                        <td className="py-2 pr-4 text-nms-text-dim">{c.lastSeen ? new Date(c.lastSeen).toLocaleTimeString() : '—'}</td>
                        <td className="py-2">
                          <button onClick={async () => {
                            if (!confirm(`Remove CBSD ${c.cbsdSerialNumber} and all its grants?`)) return;
                            try { await sasApi.deleteCbsd(c.cbsdId); toast.success('CBSD removed'); load(true); }
                            catch { toast.error('Failed to remove CBSD'); }
                          }} className="text-nms-text-dim hover:text-red-400 transition-colors" title="Remove CBSD">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="nms-card bg-nms-accent/5 border-nms-accent/20">
            <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-nms-accent" />
              SAS Endpoint — configure this on your CBSDs
            </p>
            <p className="font-mono text-sm text-nms-accent select-all bg-nms-bg border border-nms-border rounded px-3 py-2">
              {SAS_BASE.replace('/v1.2', '')}
            </p>
            <p className="text-xs text-nms-text-dim mt-1.5">
              CBSDs append the method path — e.g. <span className="font-mono text-nms-text">{SAS_BASE}/registration</span>
            </p>
          </div>

          {/* HTTPS / TLS endpoint */}
          <div className={clsx('nms-card', cert?.exists ? 'bg-green-500/5 border-green-500/20' : 'bg-amber-500/5 border-amber-500/20')}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-nms-text mb-2 flex items-center gap-2">
                  <Lock className={clsx('w-3.5 h-3.5', cert?.exists ? 'text-green-400' : 'text-amber-400')} />
                  HTTPS SAS Endpoint — for radios that require TLS (Sercomm, FreedomFi)
                  {cert?.exists
                    ? <span className="text-green-400 text-xs font-normal">✓ Certificate ready</span>
                    : <span className="text-amber-400 text-xs font-normal">⚠ Certificate not yet generated</span>}
                </p>
                {cert?.exists ? (
                  <p className="font-mono text-sm text-green-400 select-all bg-nms-bg border border-nms-border rounded px-3 py-2">
                    https://{window.location.hostname}:8443/sas/v1.2
                  </p>
                ) : (
                  <div className="bg-nms-bg border border-nms-border rounded px-3 py-2 space-y-1">
                    <p className="text-xs text-amber-300 font-semibold">Run this on the server to generate the certificate:</p>
                    <p className="font-mono text-xs text-nms-text select-all">cd /DOCKER/open5gs-nms && bash nginx/setup-sas-cert.sh</p>
                    <p className="text-xs text-nms-text-dim">Then restart nginx: <span className="font-mono">docker compose restart nginx</span></p>
                  </div>
                )}
                {cert?.exists && (
                  <p className="text-xs text-nms-text-dim mt-1.5">
                    Cert generated: <span className="font-mono text-nms-text">{cert.modified ? new Date(cert.modified).toLocaleDateString() : 'unknown'}</span>
                    &nbsp;·&nbsp;
                    Size: <span className="font-mono text-nms-text">{cert.size} bytes</span>
                  </p>
                )}
              </div>
              {cert?.exists && (
                <a
                  href="/api/sas/admin/cert/download"
                  download="sas.crt"
                  className="nms-btn border border-green-500/40 text-green-400 hover:bg-green-500/10 flex items-center gap-2 text-xs shrink-0"
                  title="Download the SAS TLS certificate to upload to your radio's trusted CA store"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download sas.crt
                </a>
              )}
            </div>
            {cert?.exists && (
              <div className="mt-3 px-3 py-2 bg-nms-surface-2/50 rounded border border-nms-border text-xs text-nms-text-dim space-y-1">
                <p className="font-semibold text-nms-text">Upload cert to Sercomm radio:</p>
                <p>1. Click <span className="font-semibold text-green-400">Download sas.crt</span> above</p>
                <p>2. In the radio web UI go to <span className="font-mono">Administration → Certificate Management → Trusted CA</span></p>
                <p>3. Upload <span className="font-mono">sas.crt</span> and set the SAS URL to <span className="font-mono text-green-400">https://{window.location.hostname}:8443/sas/v1.2</span></p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Config ── */}
      {tab === 'config' && cfgForm && (
        <div className="space-y-5 max-w-2xl mx-auto">
          <div className="nms-card space-y-4">
            <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
              <Settings className="w-4 h-4 text-nms-accent" />
              Global Settings
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="nms-label">Max EIRP GAA (dBm/MHz)</label>
                <input className="nms-input font-mono" type="number" value={cfgForm.maxEirpGAA}
                  onChange={e => setCfgForm((f: any) => ({ ...f, maxEirpGAA: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="nms-label">Heartbeat Interval (sec)</label>
                <input className="nms-input font-mono" type="number" value={cfgForm.heartbeatInterval}
                  onChange={e => setCfgForm((f: any) => ({ ...f, heartbeatInterval: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="nms-label">Grant Expire (hours)</label>
                <input className="nms-input font-mono" type="number" value={cfgForm.grantExpireHours}
                  onChange={e => setCfgForm((f: any) => ({ ...f, grantExpireHours: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="nms-label">Default Max BW (MHz)</label>
                <input className="nms-input font-mono" type="number" value={cfgForm.defaultGrantBandwidthMhz ?? 20}
                  onChange={e => setCfgForm((f: any) => ({ ...f, defaultGrantBandwidthMhz: Number(e.target.value) }))} />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer group">
              <input type="checkbox" checked={cfgForm.autoApprove}
                onChange={e => setCfgForm((f: any) => ({ ...f, autoApprove: e.target.checked }))}
                className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent" />
              <span className="text-sm text-nms-text group-hover:text-nms-accent transition-colors">Auto-approve all grants</span>
              <span className="text-xs text-nms-text-dim">(recommended for private CBRS)</span>
            </label>
          </div>

          <div className="nms-card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <Wifi className="w-4 h-4 text-nms-accent" />
                Auto-Configure Frequency Band
              </h2>
            </div>
            <p className="text-xs text-nms-text-dim">
              Replaces all frequency bands with a safe, non-overlapping 20 MHz channel for the selected band.
              Band boundaries are strictly enforced — grants will never cross into another band.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { band: 42, label: 'Band 42', channel: '3400–3420 MHz', note: 'Pure Band 42 — no overlap with B43/B48', low: 3400000000, high: 3420000000, maxBw: 20, color: 'border-blue-500/30 hover:bg-blue-500/5', labelColor: 'text-blue-400' },
                { band: 43, label: 'Band 43', channel: '3600–3620 MHz', note: 'Pure Band 43 — starts above Band 48 overlap zone', low: 3600000000, high: 3620000000, maxBw: 20, color: 'border-purple-500/30 hover:bg-purple-500/5', labelColor: 'text-purple-400' },
                { band: 48, label: 'Band 48 / CBRS (LTE)', channel: '3560–3580 MHz', note: 'Safe zone: below 3600 MHz so radio uses B48 not B43', low: 3560000000, high: 3580000000, maxBw: 20, color: 'border-nms-accent/30 hover:bg-nms-accent/5', labelColor: 'text-nms-accent' },
                { band: 48, label: 'n48 / CBRS (5G NR)', channel: '3550–3700 MHz', note: 'Full CBRS band for 5G NR — 40 MHz grant (NR-ARFCN 638000)', low: 3550000000, high: 3700000000, maxBw: 40, color: 'border-purple-500/30 hover:bg-purple-500/5', labelColor: 'text-purple-400' },
              ].map((preset, pi) => (
                <button key={`${preset.band}-${pi}`} type="button"
                  onClick={() => {
                    if (!confirm(`Replace all frequency bands with this preset?\n\nChannel: ${preset.channel}\n${preset.note}\n\nThis removes existing bands.`)) return;
                    setCfgForm((f: any) => ({ ...f, frequencyBands: [{ id: `band-${Date.now()}`, label: `${preset.label} — ${preset.channel}`, lowFrequency: preset.low, highFrequency: preset.high, maxBandwidthMhz: preset.maxBw }] }));
                    toast.success(`${preset.label} preset applied — click Save to activate`);
                  }}
                  className={`text-left p-3 rounded-lg border transition-colors ${preset.color}`}>
                  <p className={`text-sm font-semibold mb-1 ${preset.labelColor}`}>{preset.label}</p>
                  <p className="text-xs text-nms-text font-mono">{preset.channel}</p>
                  <p className="text-xs text-nms-text-dim mt-1">{preset.note}</p>
                </button>
              ))}
            </div>
            <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/5 border border-amber-500/20">
              <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-300/80">
                After applying a preset, also update <span className="font-mono text-amber-300">reqLow/reqHighFrequency</span> and{' '}
                <span className="font-mono text-amber-300">PreferredFrequency</span> on each radio via the Baicells ACS module Auto-fill button.
              </p>
            </div>
          </div>

          <div className="nms-card space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
                <Wifi className="w-4 h-4 text-nms-accent" />
                Frequency Bands
                <span className="text-xs text-nms-text-dim font-normal">— one per eNB hardware type</span>
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowRefModal(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10 transition-colors"
                  title="EARFCN / Frequency conversion reference">
                  <BookOpen className="w-3.5 h-3.5" />
                  EARFCN Ref
                </button>
                <button type="button" onClick={addBand}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium border border-nms-accent/40 text-nms-accent hover:bg-nms-accent/10 transition-colors">
                  <Plus className="w-3.5 h-3.5" />
                  Add Band
                </button>
              </div>
            </div>
            {(cfgForm.frequencyBands ?? []).length === 0 && (
              <p className="text-xs text-nms-text-dim py-2">No bands configured. Click Add Band to define a frequency range for your eNB hardware.</p>
            )}
            <div className="space-y-2">
              {(cfgForm.frequencyBands ?? []).map((band: any, i: number) => (
                <BandRow key={band.id ?? i} band={band} onChange={(u) => updateBand(i, u)} onDelete={() => deleteBand(i)} />
              ))}
            </div>
          </div>

          <button type="button" onClick={saveConfig} disabled={saving} className="nms-btn-primary flex items-center gap-2">
            {saving ? <><RefreshCw className="w-4 h-4 animate-spin" />Saving…</> : 'Save Configuration'}
          </button>
        </div>
      )}

      {/* ── Band Policy ── */}
      {tab === 'policy' && (
        <BandPolicyTab config={config} cbsds={cbsds} />
      )}
      {tab === 'api' && (
        <div className="space-y-4">
          <div className="nms-card space-y-3">
            <h2 className="text-sm font-semibold text-nms-text flex items-center gap-2">
              <Server className="w-4 h-4 text-nms-accent" />
              WinnForum SAS-CBSD Endpoints
            </h2>
            <p className="text-xs text-nms-text-dim">All endpoints accept and return JSON arrays per WINNF-TS-0016 section 9. HTTP POST, no authentication required from CBSDs.</p>
            <div className="border border-nms-border rounded-lg overflow-hidden">
              {ENDPOINTS.map((ep, i) => (
                <div key={ep.path} className={clsx('flex items-start gap-3 px-4 py-3 hover:bg-nms-surface-2 transition-colors', i < ENDPOINTS.length - 1 && 'border-b border-nms-border')}>
                  <span className="font-mono text-xs font-semibold text-blue-400 bg-blue-400/10 border border-blue-400/20 rounded px-1.5 py-0.5 shrink-0 mt-0.5">{ep.method}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm text-nms-accent break-all">{SAS_BASE}{ep.path}</p>
                    <p className="text-xs text-nms-text-dim mt-0.5">{ep.desc}</p>
                  </div>
                  <button
                    onClick={async () => {
                      const ok = await copyToClipboard(`${SAS_BASE}${ep.path}`);
                      if (ok) toast.success('Copied');
                      else toast.error('Copy failed — please copy manually');
                    }}
                    className="text-xs text-nms-text-dim hover:text-nms-accent shrink-0">Copy</button>
                </div>
              ))}
            </div>
          </div>
          <div className="nms-card bg-amber-500/5 border-amber-500/20">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-nms-text-dim space-y-1">
                <p><span className="font-semibold text-nms-text">For Sercomm/FreedomFi radios:</span> Enable SAS in the Auto Config → Sercomm ACS module and set the SAS server URL to the endpoint shown on the Dashboard tab.</p>
                <p>Set <span className="font-mono text-nms-text">SAS Category = A</span>, <span className="font-mono text-nms-text">Protection Level = GAA</span>, and disable CPI for private CBRS use.</p>
                <p>The radio will register on boot, request a spectrum grant, and send heartbeats every {config?.heartbeatInterval ?? 240} seconds to maintain its grant.</p>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
