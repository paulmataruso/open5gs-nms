// COST-231 Walfisch-Ikegami (WI) urban propagation model — genuinely distinct from
// Hata/COST-231-Hata, not a renamed version of either: explicitly separates a
// street-canyon LOS case from a rooftop-diffraction-driven NLOS case, and requires
// real street/building geometry the Hata family never asks for.
//
// Equations verified directly against the actual COST 231 Final Report (European
// Commission, 1999), Chapter 4, "Propagation Prediction Models," equations
// (4.4.5)-(4.4.17), pp. 135-140 — the PDF's own text streams were decompressed and
// read verbatim, not summarized by a tool or recalled from memory, per this
// project's standing rule against unverified numeric claims (see hata-model.ts's
// own header for the same practice). Cross-checked against two independent
// open-source implementations, which caught three real transcription bugs in
// lower-quality secondary sources along the way:
//   - The LOS constant is 42.6, not 42.64 (verified: equals free-space loss at
//     exactly d=20m to within 0.006dB — a low-provenance web source had 42.64).
//   - Lrts's leading constant/frequency term is -16.9 with +10*log10(f), not -8.8
//     or -8.2 with a bare log10(f) (confirmed against the primary source AND an
//     independent library's actual source code, matching exactly).
//   - L_ori's middle branch is 2.5 + 0.075*(phi-35) WITH the -35 offset, not a bare
//     2.5 + 0.075*phi — confirmed both from the primary text and because only the
//     with-offset version is continuous with the third branch at phi=55 (both give
//     4.0dB there; the without-offset version has a 2.6dB discontinuity, which is
//     inconsistent with how every other boundary in this model behaves).
//
// Unit convention (the single easiest place to introduce a silent, catastrophic
// bug in this model): f in MHz, d in KM in every sub-formula (not meters anywhere),
// all heights/widths/separations in meters.

import { CalculationError, Cost231CityType, EquationRecord, WalfischIkegamiMode } from './rf-types';

export const WI_FREQ_RANGE_MHZ: [number, number] = [800, 2000];
export const WI_BASE_HEIGHT_RANGE_M: [number, number] = [4, 50];
export const WI_MOBILE_HEIGHT_RANGE_M: [number, number] = [1, 3];
export const WI_DISTANCE_RANGE_KM: [number, number] = [0.02, 5];

// The standard's own documented defaults, applied by the CALLER (linkbudget.ts /
// site-signal.ts), not this file — matching this codebase's established pattern of
// keeping model files purely mathematical and pushing Assumption bookkeeping to the
// dispatch layer (see e.g. how linkbudget.ts resolves Hata's `environment` default
// before calling hataPathLossDb). `WI_DEFAULT_BUILDING_SEPARATION_M` is NOT a
// COST-231-specified value — the standard only gives a 20-50m range — it's this
// project's own disclosed midpoint convention; callers must label it as such via
// Assumption.reason, never present it as "the COST-231 default."
export const WI_DEFAULT_STREET_ORIENTATION_DEG = 90;
export const WI_DEFAULT_BUILDING_SEPARATION_M = 35;
export const wiDefaultStreetWidthM = (buildingSeparationM: number): number => buildingSeparationM / 2;

type ModelResult =
  | { ok: true; pathLossDb: number; equation: EquationRecord }
  | { ok: false; error: CalculationError };

function rangeCheck(value: number, range: [number, number], label: string, unit: string, problems: string[]): void {
  if (value < range[0] || value > range[1]) {
    problems.push(`${label} ${value}${unit} is outside the model's valid range [${range[0]}, ${range[1]}]${unit}`);
  }
}

function streetOrientationLossDb(phiDeg: number): number {
  if (phiDeg < 35) return -10 + 0.354 * phiDeg;
  if (phiDeg < 55) return 2.5 + 0.075 * (phiDeg - 35);
  return 4.0 - 0.114 * (phiDeg - 55);
}

export function walfischIkegamiPathLossDb(
  freqMhz: number, baseHeightM: number, mobileHeightM: number, distanceKm: number, mode: WalfischIkegamiMode,
  buildingHeightM: number, streetWidthM: number, buildingSeparationM: number, streetOrientationDeg: number,
  cityType: Cost231CityType,
): ModelResult {
  const problems: string[] = [];
  rangeCheck(freqMhz, WI_FREQ_RANGE_MHZ, 'frequencyMhz', 'MHz', problems);
  rangeCheck(baseHeightM, WI_BASE_HEIGHT_RANGE_M, 'txHeightM', 'm', problems);
  rangeCheck(mobileHeightM, WI_MOBILE_HEIGHT_RANGE_M, 'rxHeightM', 'm', problems);
  rangeCheck(distanceKm, WI_DISTANCE_RANGE_KM, 'distanceKm', 'km', problems);
  if (problems.length > 0) {
    return { ok: false, error: { reason: `Walfisch-Ikegami model: ${problems.join('; ')}`, missingInputs: [] } };
  }

  if (mode === 'los') {
    const pathLossDb = 42.6 + 26 * Math.log10(distanceKm) + 20 * Math.log10(freqMhz);
    return {
      ok: true,
      pathLossDb,
      equation: {
        name: 'Walfisch-Ikegami Model (LOS street canyon)',
        formula: 'L = 42.6 + 26·log10(d) + 20·log10(f)  [d in km, f in MHz]',
        variables: {
          f: { description: 'Frequency', unit: 'MHz', value: freqMhz },
          d: { description: 'Distance', unit: 'km', value: distanceKm },
          L: { description: 'Path loss', unit: 'dB', value: pathLossDb },
        },
        source: 'COST Telecom Secretariat, "COST Action 231: Digital Mobile Radio Towards Future Generation Systems — Final Report," European Commission (1999), Ch. 4, Eq. (4.4.5)',
        applicableConditions: `Line-of-sight street canyon; valid for f∈[800,2000]MHz, d∈[0.02,5]km (d>=20m — the constant 42.6 is set so this equals free-space loss exactly at d=20m)`,
        limitations: 'Assumes a direct optical path along a street canyon with both antennas visible — switches to the NLOS case the moment that assumption breaks',
      },
    };
  }

  // NLOS: rooftop-to-street diffraction requires h_Roof > h_Mobile — a structural
  // precondition (log10 of a non-positive number is undefined), not a documented
  // range in the report itself, but must be guarded explicitly.
  if (buildingHeightM <= mobileHeightM) {
    return {
      ok: false,
      error: {
        reason: `Walfisch-Ikegami NLOS model requires buildingHeightM (${buildingHeightM}m) to exceed rxHeightM (${mobileHeightM}m) — rooftop-to-street diffraction is undefined when the mobile is at or above rooftop level`,
        missingInputs: [],
      },
    };
  }

  const dhMobile = buildingHeightM - mobileHeightM;
  const dhBase = baseHeightM - buildingHeightM;
  const aboveRoof = baseHeightM > buildingHeightM;

  const L0 = 32.4 + 20 * Math.log10(distanceKm) + 20 * Math.log10(freqMhz);

  const lOri = streetOrientationLossDb(streetOrientationDeg);
  const Lrts = -16.9 - 10 * Math.log10(streetWidthM) + 10 * Math.log10(freqMhz) + 20 * Math.log10(dhMobile) + lOri;

  const Lbsh = aboveRoof ? -18 * Math.log10(1 + dhBase) : 0;
  const ka = aboveRoof ? 54 : (distanceKm >= 0.5 ? 54 - 0.8 * dhBase : 54 - 0.8 * dhBase * (distanceKm / 0.5));
  const kd = aboveRoof ? 18 : 18 - 15 * (dhBase / buildingHeightM);
  // Eq. (4.4.16): distinct coefficient for metropolitan centres vs. medium-sized
  // cities/suburban centres with medium tree density — same cityType concept
  // COST-231-Hata's own Cm constant already uses (Cost231CityType), reused rather
  // than introducing a second medium/metropolitan enum.
  const kf = cityType === 'metropolitan'
    ? -4 + 1.5 * (freqMhz / 925 - 1)
    : -4 + 0.7 * (freqMhz / 925 - 1);
  const Lmsd = Lbsh + ka + kd * Math.log10(distanceKm) + kf * Math.log10(freqMhz) - 9 * Math.log10(buildingSeparationM);

  const sumTerm = Lrts + Lmsd;
  const pathLossDb = sumTerm > 0 ? L0 + Lrts + Lmsd : L0;

  return {
    ok: true,
    pathLossDb,
    equation: {
      name: `Walfisch-Ikegami Model (NLOS, ${aboveRoof ? 'base station above rooftop' : 'base station at/below rooftop'}, ${cityType})`,
      formula: sumTerm > 0
        ? 'L = L0 + Lrts + Lmsd  [Lrts+Lmsd > 0]'
        : 'L = L0  [Lrts+Lmsd <= 0, multi-screen/rooftop terms degenerate to free space]',
      variables: {
        f:        { description: 'Frequency', unit: 'MHz', value: freqMhz },
        d:        { description: 'Distance', unit: 'km', value: distanceKm },
        hBase:    { description: 'Base station height', unit: 'm', value: baseHeightM },
        hMobile:  { description: 'Mobile height', unit: 'm', value: mobileHeightM },
        hRoof:    { description: 'Representative rooftop height', unit: 'm', value: buildingHeightM },
        w:        { description: 'Street width', unit: 'm', value: streetWidthM },
        b:        { description: 'Building separation', unit: 'm', value: buildingSeparationM },
        phi:      { description: 'Street orientation relative to the direct path', unit: 'deg', value: streetOrientationDeg },
        L0:       { description: 'Free-space loss term', unit: 'dB', value: L0 },
        Lrts:     { description: 'Rooftop-to-street diffraction and scatter loss', unit: 'dB', value: Lrts },
        Lmsd:     { description: 'Multi-screen diffraction loss', unit: 'dB', value: Lmsd },
        L:        { description: 'Path loss', unit: 'dB', value: pathLossDb },
      },
      source: 'COST Telecom Secretariat, "COST Action 231: Digital Mobile Radio Towards Future Generation Systems — Final Report," European Commission (1999), Ch. 4, Eqs. (4.4.6)-(4.4.16)',
      applicableConditions: `Non-line-of-sight (rooftop diffraction dominant); valid for f∈[800,2000]MHz, hBase∈[4,50]m, hMobile∈[1,3]m, d∈[0.02,5]km; requires hRoof>hMobile`,
      limitations: 'Mean error ±3dB (σ 4-8dB) for hBase above rooftop level; error grows large as hBase≈hRoof and is poor for hBase<<hRoof; b/w/phi are not physically meaningful for micro-cells (large prediction error there); assumes flat terrain and does not model multipath',
    },
  };
}
