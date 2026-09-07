// NTIA Irregular Terrain Model (ITM / Longley-Rice), point-to-point mode —
// wraps the compiled WASM module (backend/src/domain/rf/wasm/itm/, built
// from backend/vendor/itm-src/ via build-wasm.sh; see VENDOR_NOTES.md for
// the pinned commit and portability patches) rather than reimplementing
// this notoriously statistics-heavy algorithm from a description. The user
// explicitly chose this over porting an existing Python port, for
// bit-for-bit fidelity to NTIA's own reference binary — verified live: the
// compiled module reproduces all 5 of NTIA's own p2p.csv/pfls.csv reference
// vectors to within 0.005dB (the CSV's own display precision).
//
// Only point-to-point mode is exposed — area mode trades away this
// project's real terrain profiles for a coarse single "irregularity"
// number, which is a strict downgrade given terrain-profile.ts already
// provides a real profile for every call site that could use ITM.

import { CalculationError, EquationRecord, ItmRadioClimate, ItmPolarization, ItmVariabilityMode } from './rf-types';
import { TerrainProfilePoint } from './diffraction';

const RADIO_CLIMATE_CODES: Record<ItmRadioClimate, number> = {
  equatorial: 1, 'continental-subtropical': 2, 'maritime-subtropical': 3, desert: 4,
  'continental-temperate': 5, 'maritime-temperate-land': 6, 'maritime-temperate-sea': 7,
};
const POLARIZATION_CODES: Record<ItmPolarization, number> = { horizontal: 0, vertical: 1 };
const VARIABILITY_MODE_CODES: Record<ItmVariabilityMode, number> = {
  'single-message': 0, accidental: 1, mobile: 2, broadcast: 3,
};

// Standard "average ground" / "average atmosphere" reference values —
// cross-checked against two independent, agreeing technical sources
// (Softwright's Longley-Rice FAQ and MathWorks' rfprop.LongleyRice
// reference) during this feature's research pass, not invented.
export const ITM_DEFAULT_GROUND_CONDUCTIVITY_S_PER_M = 0.005;
export const ITM_DEFAULT_GROUND_PERMITTIVITY = 15;
export const ITM_DEFAULT_SURFACE_REFRACTIVITY_N0 = 301;
export const ITM_DEFAULT_RADIO_CLIMATE: ItmRadioClimate = 'continental-temperate';
export const ITM_DEFAULT_POLARIZATION: ItmPolarization = 'horizontal';
export const ITM_DEFAULT_VARIABILITY_MODE: ItmVariabilityMode = 'broadcast';
export const ITM_DEFAULT_TIME_PERCENT = 50;
export const ITM_DEFAULT_LOCATION_PERCENT = 50;
export const ITM_DEFAULT_SITUATION_PERCENT = 50;

// Hard validity bounds, read directly from the vendored source's own
// ValidateInputs.cpp (not the less-precise prose in README.md/itm.h's
// comments) — used for a fail-fast, constant-across-a-whole-grid check by
// coverage-grid.ts/interference.ts, mirroring hata-model.ts's
// HATA_FREQ_RANGE_MHZ pattern. Distance has no such constant range (it's
// validated per-call, inside the WASM module itself, against a
// terrain-dependent minimum) so there's no exported distance range here —
// same reasoning as HATA_DISTANCE_RANGE_KM being checked per-cell instead.
export const ITM_FREQ_RANGE_MHZ: [number, number] = [20, 20000];
export const ITM_HEIGHT_RANGE_M: [number, number] = [0.5, 3000];
export const ITM_REFRACTIVITY_RANGE_N0: [number, number] = [250, 400];
// ITM's own bounds are strictly exclusive (0 < x < 100) — this inclusive
// [0,100] is a close approximation for the fail-fast pre-check only; the
// WASM call itself is the authoritative validator and still rejects
// exactly 0 or 100 per-point the same as any other out-of-range input.
export const ITM_VARIABILITY_PERCENT_RANGE: [number, number] = [0, 100];

// ITM's own error/warning codes (Errors.h/Warnings.h) — 0 = SUCCESS,
// 1 = SUCCESS_WITH_WARNINGS (a real result is still returned), >=1000 = a
// genuine error (no usable result). Mirrored here rather than re-exported
// from the WASM module so this file stays the single source of truth for
// what each code means in this codebase's own error/warning text.
const ERROR_MESSAGES: Record<number, string> = {
  1000: 'TX terminal height is out of range',
  1001: 'RX terminal height is out of range',
  1002: 'Invalid value for radio climate',
  1003: 'Time percentage is out of range',
  1004: 'Location percentage is out of range',
  1005: 'Situation percentage is out of range',
  1008: 'Refractivity is out of range',
  1009: 'Frequency is out of range',
  1010: 'Invalid value for polarization',
  1011: 'Epsilon (ground permittivity) is out of range',
  1012: 'Sigma (ground conductivity) is out of range',
  1013: 'The imaginary portion of the complex ground impedance is larger than the real portion',
  1014: 'Invalid value for mode of variability',
  1016: 'Internally computed effective earth radius is invalid',
  1017: 'Path distance is out of range',
  1018: 'Delta H (terrain irregularity parameter) is out of range',
  1021: 'Internally computed surface refractivity value is too small',
  1022: 'Internally computed surface refractivity value is too large',
};
const WARNING_MESSAGES: [number, string][] = [
  [0x0001, 'TX terminal height is near its limits'],
  [0x0002, 'RX terminal height is near its limits'],
  [0x0004, 'Frequency is near its limits'],
  [0x0008, 'Path distance is near its upper limit'],
  [0x0010, 'Path distance is large — care must be taken with this result'],
  [0x0020, 'Path distance is near its lower limit'],
  [0x0040, 'Path distance is small — care must be taken with this result'],
  [0x0080, 'TX horizon angle is large — small angle approximations could break down'],
  [0x0100, 'RX horizon angle is large — small angle approximations could break down'],
  [0x0200, 'TX horizon distance is less than 1/10 of the smooth earth horizon distance'],
  [0x0400, 'RX horizon distance is less than 1/10 of the smooth earth horizon distance'],
  [0x0800, 'TX horizon distance is greater than 3 times the smooth earth horizon distance'],
  [0x1000, 'RX horizon distance is greater than 3 times the smooth earth horizon distance'],
  [0x2000, 'One of the provided variabilities is located far in the tail of its distribution'],
  [0x4000, 'Internally computed surface refractivity value is small — care must be taken with this result'],
];

function decodeWarnings(bitmask: number): string[] {
  return WARNING_MESSAGES.filter(([bit]) => (bitmask & bit) !== 0).map(([, msg]) => msg);
}

interface ItmWasmModule {
  VectorDouble: new () => { push_back(v: number): void; delete(): void };
  itmP2pTls(
    txHeightM: number, rxHeightM: number, profile: unknown, climate: number, n0: number, freqMhz: number,
    polarization: number, epsilon: number, sigma: number, mdvar: number,
    timePercent: number, locationPercent: number, situationPercent: number,
  ): { returnCode: number; pathLossDb: number; warnings: number };
}

let modulePromise: Promise<ItmWasmModule> | null = null;
function loadModule(): Promise<ItmWasmModule> {
  if (modulePromise == null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const createItmModule = require('./wasm/itm/itm.js');
    modulePromise = createItmModule() as Promise<ItmWasmModule>;
  }
  const promise: Promise<ItmWasmModule> = modulePromise;
  return promise;
}

// pfl[] format exactly as ITM defines it (confirmed directly against the
// vendored source, src/QuickPfl.cpp): [0]=np (point count - 1), [1]=xi
// (constant step distance in meters), [2..]=elevation in meters. Requires
// the profile to already be evenly spaced — exactly what terrain-profile.ts
// already produces (even sampling intervals), so this is a direct,
// near-zero-adaptation conversion, not a resampling.
function toItmProfile(profile: TerrainProfilePoint[]): number[] {
  const np = profile.length - 1;
  const xi = profile[1].distanceM - profile[0].distanceM;
  return [np, xi, ...profile.map(p => p.elevationM)];
}

export type ItmResult =
  | { ok: true; pathLossDb: number; warnings: string[]; equation: EquationRecord }
  | { ok: false; error: CalculationError };

export async function itmPathLossDb(
  profile: TerrainProfilePoint[], txHeightM: number, rxHeightM: number, frequencyMhz: number,
  groundConductivity: number, groundPermittivity: number, surfaceRefractivityN0: number,
  radioClimate: ItmRadioClimate, polarization: ItmPolarization, variabilityMode: ItmVariabilityMode,
  timePercent: number, locationPercent: number, situationPercent: number,
): Promise<ItmResult> {
  if (profile.length < 2) {
    return { ok: false, error: { reason: 'ITM requires a real terrain profile with at least 2 points', missingInputs: ['terrain profile'] } };
  }
  // A degenerate (zero-length) profile — e.g. a coverage-grid cell that
  // lands exactly on the site's own coordinates, which any odd grid
  // resolution's center cell does — produces xi=0 in toItmProfile(). Found
  // live: ITM_P2P_TLS doesn't reject xi=0 as an input error (it's not a
  // scalar-range violation ValidateInputs.cpp checks), it silently returns
  // SUCCESS_WITH_WARNINGS with a NaN pathLossDb, which would otherwise leak
  // into the API response as a corrupted cell instead of being cleanly
  // skipped the way every other model handles "too close" (e.g. Hata's
  // distance-range check). Reject before the WASM call, same treatment.
  const totalSpanM = profile[profile.length - 1].distanceM - profile[0].distanceM;
  if (!(totalSpanM > 0)) {
    return {
      ok: false,
      error: {
        reason: 'ITM requires a terrain profile spanning a real, nonzero distance — this point coincides with (or is degenerately close to) the site itself, so no meaningful path exists to model',
        missingInputs: [],
      },
    };
  }
  const mod = await loadModule();
  const vec = new mod.VectorDouble();
  try {
    for (const v of toItmProfile(profile)) vec.push_back(v);
    const result = mod.itmP2pTls(
      txHeightM, rxHeightM, vec,
      RADIO_CLIMATE_CODES[radioClimate], surfaceRefractivityN0, frequencyMhz,
      POLARIZATION_CODES[polarization], groundPermittivity, groundConductivity,
      VARIABILITY_MODE_CODES[variabilityMode], timePercent, locationPercent, situationPercent,
    );

    if (result.returnCode >= 1000) {
      return {
        ok: false,
        error: {
          reason: `ITM: ${ERROR_MESSAGES[result.returnCode] ?? `error code ${result.returnCode}`}`,
          missingInputs: [],
        },
      };
    }

    const warnings = decodeWarnings(result.warnings);
    return {
      ok: true,
      pathLossDb: result.pathLossDb,
      warnings,
      equation: {
        name: 'NTIA Irregular Terrain Model (ITM / Longley-Rice), point-to-point mode',
        formula: 'A(dB) = ITM_P2P_TLS(h_tx, h_rx, terrain profile, climate, N0, f, polarization, epsilon, sigma, mode of variability, time%, location%, situation%)',
        variables: {
          h_tx: { description: 'TX terminal height', unit: 'm', value: txHeightM },
          h_rx: { description: 'RX terminal height', unit: 'm', value: rxHeightM },
          f: { description: 'Frequency', unit: 'MHz', value: frequencyMhz },
          N0: { description: 'Surface refractivity', unit: 'N-units', value: surfaceRefractivityN0 },
          epsilon: { description: 'Relative ground permittivity', unit: 'dimensionless', value: groundPermittivity },
          sigma: { description: 'Ground conductivity', unit: 'S/m', value: groundConductivity },
          time: { description: 'Time variability', unit: '%', value: timePercent },
          location: { description: 'Location variability', unit: '%', value: locationPercent },
          situation: { description: 'Situation variability', unit: '%', value: situationPercent },
          A: { description: 'Predicted basic transmission loss', unit: 'dB', value: result.pathLossDb },
        },
        source: 'NTIA/ITS Irregular Terrain Model (Longley-Rice), compiled to WebAssembly from the official reference C++ (github.com/NTIA/itm) — see backend/vendor/itm-src/VENDOR_NOTES.md for the pinned commit',
        applicableConditions: `Point-to-point mode, ${radioClimate} climate, ${polarization} polarization — approx. 20 MHz-20 GHz per NTIA's own documented range`,
        limitations: warnings.length > 0
          ? `Statistical terrain-based propagation model — does not model building interiors or channel/waveform behavior. This calculation also raised: ${warnings.join('; ')}`
          : 'Statistical terrain-based propagation model — does not model building interiors or channel/waveform behavior',
      },
    };
  } finally {
    vec.delete();
  }
}
