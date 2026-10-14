import type { EquationRecord } from './rf-types';

// 3GPP TR 38.901 Urban Macrocell (UMa) median path loss.
//
// This is the model 3GPP itself specifies for cellular planning in urban
// macro environments, and it is the one piece our engine was missing: we
// already had Hata/COST-231 (1980s macrocell era, <=2000 MHz, 30-200 m
// towers), Walfisch-Ikegami, close-in/UMi street canyon (low-height small
// cell), log-distance and ITM. UMa fills the gap between UMi street canyon
// and the Hata family, and unlike Hata it is explicitly valid at CBRS
// frequencies.
//
// Applicability (TR 38.901 Table 7.4.1-1):
//   0.5 GHz < f_c < 100 GHz          <- covers CBRS 3.55-3.7 GHz
//   10 m <= d_2D <= 5000 m
//   1.5 m <= h_UT <= 22.5 m
//   h_BS = 25 m nominal
//   outdoor-to-outdoor
//
// Two properties of this model matter in practice and are easy to get wrong:
//
//   1. It is a function of 3D distance, not ground distance. At short range
//      (the whole point of a small-cell plan) the height difference dominates,
//      and using d_2D understates loss materially.
//
//   2. NLOS is floored at the LOS value: PL_NLOS = max(PL_LOS, PL'_NLOS).
//      Without that floor the raw NLOS expression returns LESS loss than LOS
//      at short range, which renders as a bright coverage bubble hugging the
//      site -- physically impossible and an obvious-looking "bug" in output
//      that is actually a missing clamp.
//
// Source: 3GPP TR 38.901, "Study on channel model for frequencies from 0.5 to
// 100 GHz", Table 7.4.1-1 (UMa LOS / UMa NLOS). Median path loss only; the
// shadow-fading sigma terms (4 dB LOS, 6 dB NLOS) are reported for context but
// never sampled, so results stay deterministic and reproducible.

/** Speed of light, m/s — used for the breakpoint distance. */
const SPEED_OF_LIGHT_M_S = 3e8;

export const UMA_FREQ_RANGE_GHZ: [number, number] = [0.5, 100];
export const UMA_DISTANCE_RANGE_M: [number, number] = [10, 5000];
export const UMA_RX_HEIGHT_RANGE_M: [number, number] = [1.5, 22.5];

/** Reference shadow-fading sigmas. Reported, never sampled. */
export const UMA_LOS_SHADOW_SIGMA_DB = 4.0;
export const UMA_NLOS_SHADOW_SIGMA_DB = 6.0;

export type UmaLosState = 'los' | 'nlos';

/**
 * Breakpoint distance d'_BP (TR 38.901 Table 7.4.1-1 note 1), using effective
 * antenna heights (actual height minus 1 m).
 */
export function umaBreakpointDistanceM(
  frequencyGhz: number,
  txHeightM: number,
  rxHeightM: number,
): number {
  const effectiveTx = Math.max(txHeightM - 1, 0);
  const effectiveRx = Math.max(rxHeightM - 1, 0);
  return (4 * effectiveTx * effectiveRx * (frequencyGhz * 1e9)) / SPEED_OF_LIGHT_M_S;
}

/** 3D (slant) separation from ground distance and the height difference. */
export function slantDistanceM(groundDistanceM: number, txHeightM: number, rxHeightM: number): number {
  return Math.hypot(Math.max(groundDistanceM, 0), txHeightM - rxHeightM);
}

/** UMa LOS median path loss, dB. */
export function umaLosPathLossDb(
  groundDistanceM: number,
  frequencyGhz: number,
  txHeightM: number,
  rxHeightM: number,
): number {
  const d3d = slantDistanceM(groundDistanceM, txHeightM, rxHeightM);
  // Clamp inside log10 so d -> 0 stays finite rather than producing -Infinity.
  const logDistance = Math.log10(Math.max(d3d, 1));
  const logFrequency = Math.log10(frequencyGhz);
  const breakpointM = umaBreakpointDistanceM(frequencyGhz, txHeightM, rxHeightM);

  const pl1 = 28 + 22 * logDistance + 20 * logFrequency;
  if (groundDistanceM <= breakpointM) return pl1;

  const heightDelta = txHeightM - rxHeightM;
  return (
    28 +
    40 * logDistance +
    20 * logFrequency -
    9 * Math.log10(breakpointM * breakpointM + heightDelta * heightDelta)
  );
}

/** UMa NLOS median path loss, dB — floored at the LOS value (see header). */
export function umaNlosPathLossDb(
  groundDistanceM: number,
  frequencyGhz: number,
  txHeightM: number,
  rxHeightM: number,
): number {
  const d3d = slantDistanceM(groundDistanceM, txHeightM, rxHeightM);
  const raw =
    13.54 +
    39.08 * Math.log10(Math.max(d3d, 1)) +
    20 * Math.log10(frequencyGhz) -
    0.6 * (rxHeightM - 1.5);
  const los = umaLosPathLossDb(groundDistanceM, frequencyGhz, txHeightM, rxHeightM);
  return Math.max(raw, los);
}

export function umaPathLossDb(
  groundDistanceM: number,
  frequencyGhz: number,
  txHeightM: number,
  rxHeightM: number,
  losState: UmaLosState,
): number {
  return losState === 'nlos'
    ? umaNlosPathLossDb(groundDistanceM, frequencyGhz, txHeightM, rxHeightM)
    : umaLosPathLossDb(groundDistanceM, frequencyGhz, txHeightM, rxHeightM);
}

export interface UmaApplicability {
  applicable: boolean;
  warnings: string[];
}

/**
 * Range check. Returns warnings rather than throwing: an out-of-range input is
 * still worth computing for a planner, it just must not be presented as if it
 * were inside the model's validated envelope.
 */
export function umaApplicability(
  groundDistanceM: number,
  frequencyGhz: number,
  txHeightM: number,
  rxHeightM: number,
): UmaApplicability {
  const warnings: string[] = [];
  const [fMin, fMax] = UMA_FREQ_RANGE_GHZ;
  const [dMin, dMax] = UMA_DISTANCE_RANGE_M;
  const [hMin, hMax] = UMA_RX_HEIGHT_RANGE_M;
  if (frequencyGhz <= fMin || frequencyGhz >= fMax) {
    warnings.push(`frequency ${frequencyGhz} GHz is outside TR 38.901 UMa's ${fMin}-${fMax} GHz range`);
  }
  if (groundDistanceM < dMin) {
    warnings.push(`distance ${groundDistanceM.toFixed(1)} m is below UMa's ${dMin} m minimum; near-field results are optimistic`);
  }
  if (groundDistanceM > dMax) {
    warnings.push(`distance ${groundDistanceM.toFixed(0)} m exceeds UMa's ${dMax} m maximum`);
  }
  if (rxHeightM < hMin || rxHeightM > hMax) {
    warnings.push(`receiver height ${rxHeightM} m is outside UMa's ${hMin}-${hMax} m range`);
  }
  if (txHeightM <= rxHeightM) {
    warnings.push(`transmitter height ${txHeightM} m is not above receiver height ${rxHeightM} m; UMa assumes an elevated base station`);
  }
  return { applicable: warnings.length === 0, warnings };
}

export function umaEquation(
  groundDistanceM: number,
  frequencyGhz: number,
  txHeightM: number,
  rxHeightM: number,
  losState: UmaLosState,
): EquationRecord {
  const d3d = slantDistanceM(groundDistanceM, txHeightM, rxHeightM);
  const breakpointM = umaBreakpointDistanceM(frequencyGhz, txHeightM, rxHeightM);
  const beyondBreakpoint = groundDistanceM > breakpointM;
  const formula =
    losState === 'nlos'
      ? 'PL_NLOS = max(PL_LOS, 13.54 + 39.08·log10(d_3D) + 20·log10(f_GHz) − 0.6·(h_rx − 1.5))'
      : beyondBreakpoint
        ? 'PL_LOS = 28 + 40·log10(d_3D) + 20·log10(f_GHz) − 9·log10(d_BP² + (h_tx − h_rx)²)'
        : 'PL_LOS = 28 + 22·log10(d_3D) + 20·log10(f_GHz)';
  return {
    name: `TR 38.901 UMa ${losState.toUpperCase()} path loss`,
    formula,
    variables: {
      d_3D: { description: '3D transmitter-to-receiver separation', unit: 'm', value: Number(d3d.toFixed(2)) },
      d_2D: { description: 'ground distance', unit: 'm', value: Number(groundDistanceM.toFixed(2)) },
      f_GHz: { description: 'carrier frequency', unit: 'GHz', value: frequencyGhz },
      h_tx: { description: 'transmitter antenna height', unit: 'm', value: txHeightM },
      h_rx: { description: 'receiver height', unit: 'm', value: rxHeightM },
      d_BP: { description: 'breakpoint distance (4·h\'_tx·h\'_rx·f_c/c)', unit: 'm', value: Number(breakpointM.toFixed(1)) },
      PL: {
        description: 'median path loss',
        unit: 'dB',
        value: Number(umaPathLossDb(groundDistanceM, frequencyGhz, txHeightM, rxHeightM, losState).toFixed(2)),
      },
    },
    source: '3GPP TR 38.901, Table 7.4.1-1 (UMa)',
    applicableConditions: `0.5 < f_c < 100 GHz; 10 m <= d_2D <= 5000 m; 1.5 m <= h_rx <= 22.5 m; outdoor-to-outdoor${beyondBreakpoint ? '; beyond breakpoint (dual-slope branch)' : ''}`,
    limitations:
      'Median path loss only — shadow fading (sigma 4 dB LOS / 6 dB NLOS) is reported but never sampled, so output is deterministic. ' +
      'NLOS is floored at the LOS value, which the raw TR 38.901 expression requires at short range.',
  };
}
