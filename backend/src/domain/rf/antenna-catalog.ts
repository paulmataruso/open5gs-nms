// Antenna model library.
//
// Picking a sector's pattern from a list of real panels beats typing four
// numbers, because the four numbers are not independent: gain, horizontal
// beamwidth and vertical beamwidth are tied together by the aperture, and a
// hand-entered combination that violates that relation produces a sector the
// simulation will happily model and no vendor will ever sell you.
//
// Every CATALOG entry is a real, orderable panel whose figures come from the
// vendor's own published specification, and each carries the `source` URL it
// was taken from so an operator can check it rather than trust us. Anything
// this project could not source is NOT in here — the two GENERIC entries are
// labelled generic precisely so they cannot be mistaken for a datasheet.
//
// `verticalBeamwidthDeg` is the field web datasheets most often omit. Where it
// is missing it is DERIVED from the standard aperture relation (below) and
// flagged `verticalDerived`, so the UI can say "derived" instead of presenting
// an estimate as a measurement. That distinction earns its keep: vertical
// beamwidth is what sets how fast the pattern falls away below the horizon, so
// a wrong value quietly changes every close-in result while the far field still
// looks plausible.
//
// Where a datasheet quotes a gain RANGE across its band, `gainDbi` is the
// mid-band figure and the range is kept verbatim in `notes` rather than being
// averaged away silently.

/** A selectable antenna, or the shape a custom one is entered in. */
export interface AntennaModel {
  id: string;
  vendor: string;
  model: string;
  /** Short display name: vendor + model, already combined for a <select>. */
  label: string;
  /** Human band description, e.g. '3.3–3.8 GHz (CBRS n48/B48)'. */
  bandLabel: string;
  freqMinMhz: number;
  freqMaxMhz: number;
  gainDbi: number;
  /** Horizontal (azimuth) half-power beamwidth. 360 for an omni. */
  beamWidthDeg: number;
  /** Vertical (elevation) half-power beamwidth. */
  verticalBeamwidthDeg: number;
  /** True when verticalBeamwidthDeg came from the aperture relation, not a datasheet. */
  verticalDerived: boolean;
  /**
   * Front-to-back ratio at 180°. Omitted when the vendor does not publish one;
   * the engine then falls back to its own DEFAULT_FRONT_TO_BACK_DB.
   */
  frontToBackDb?: number;
  /** Fixed electrical downtilt, or the low end of an adjustable range. */
  electricalDowntiltDeg: number;
  /** Top of an adjustable (RET/variable) electrical tilt range; equals electricalDowntiltDeg when fixed. */
  electricalDowntiltMaxDeg: number;
  ports: number;
  polarization: string;
  /** Where every number above was read from. */
  source: string;
  notes?: string;
  /** True for the deliberately non-branded reference patterns. */
  generic?: boolean;
}

/**
 * Vertical beamwidth implied by a gain and a horizontal beamwidth.
 *
 *     G (linear) ≈ 32400 / (H_bw · V_bw)     →     V_bw ≈ 32400 / (H_bw · G)
 *
 * The 32400 form (deg², i.e. 41253 derated for a real aperture's efficiency)
 * is the usual engineering approximation for a sectorised panel. It assumes a
 * lossless aperture, so it UNDER-estimates slightly: a real panel with 1–2 dB
 * of ohmic and feed loss has a somewhat wider vertical beam than this returns.
 * That is the right direction to be wrong in for a planning tool — a narrower
 * assumed vertical beam is the pessimistic case for close-in coverage — but it
 * is an estimate, which is why callers must surface `verticalDerived`.
 */
export function derivedVerticalBeamwidthDeg(gainDbi: number, horizontalBeamwidthDeg: number): number {
  if (!(horizontalBeamwidthDeg > 0) || !Number.isFinite(gainDbi)) return 0;
  const linearGain = 10 ** (gainDbi / 10);
  const value = 32400 / (horizontalBeamwidthDeg * linearGain);
  return Math.round(Math.min(90, Math.max(1, value)) * 10) / 10;
}

/**
 * Angular width of the contour where the pattern has fallen `dropDb` below
 * boresight, for a panel whose 3 dB beamwidth is `beamWidthDeg`.
 *
 * Inverts the engine's own roll-off (antenna-pattern.ts: loss = 12·(θ/bw)²),
 * so anything drawn or reported from this can never imply a shape the
 * simulation does not actually produce. The 3 dB case returns beamWidthDeg
 * exactly, as it must.
 *
 * This is what answers "why is there a gap between my sectors": a standard
 * 3 × 65° site on 120° spacing has 55° between the 3 dB wedges, but its −10 dB
 * width is 2·65·√(10/12) ≈ 119°, so at the 60° crossover each neighbour is
 * only about 10 dB down and still serving. The seam is covered by the pattern
 * tails, not left empty.
 */
export function patternWidthDeg(beamWidthDeg: number, dropDb: number): number {
  if (!(beamWidthDeg > 0) || !(dropDb > 0)) return beamWidthDeg;
  return Math.min(360, 2 * beamWidthDeg * Math.sqrt(dropDb / 12));
}

/**
 * Pattern loss at the crossover between two sectors `spacingDeg` apart, for a
 * panel of the given 3 dB beamwidth. Capped at the front-to-back floor, same
 * as the engine.
 */
export function crossoverLossDb(beamWidthDeg: number, spacingDeg: number, frontToBackDb: number): number {
  const offset = spacingDeg / 2;
  return Math.min(12 * (offset / beamWidthDeg) ** 2, frontToBackDb);
}

/** Real, sourced panels. CBRS-weighted, because that is the band this deployment runs. */
export const ANTENNA_CATALOG: AntennaModel[] = [
  {
    id: 'baicells-nova430i',
    vendor: 'Baicells',
    model: 'Nova430i (integrated)',
    label: 'Baicells Nova430i — integrated 4-port',
    bandLabel: '3550–3700 MHz (CBRS B48)',
    freqMinMhz: 3550,
    freqMaxMhz: 3700,
    gainDbi: 13.5,
    beamWidthDeg: 65,
    verticalBeamwidthDeg: 17,
    verticalDerived: false,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 4,
    polarization: '±45° slant',
    source: 'https://cdn.shopify.com/s/files/1/0447/5633/6807/files/nova430i.pdf',
    notes: 'Gain 13.5 ±0.8 dB; horizontal beamwidth specified as 65 ±10°. The radio\'s own built-in antenna — pick this when the eNB has no external panel. Front-to-back not published.',
  },
  {
    id: 'alpha-aw3161-e-f-v2',
    vendor: 'Alpha Wireless',
    model: 'AW3161-E-F-V2',
    label: 'Alpha Wireless AW3161 — 65°, 18 dBi',
    bandLabel: '3300–3800 MHz (CBRS n48/B48)',
    freqMinMhz: 3300,
    freqMaxMhz: 3800,
    gainDbi: 18,
    beamWidthDeg: 65,
    verticalBeamwidthDeg: derivedVerticalBeamwidthDeg(18, 65),
    verticalDerived: true,
    frontToBackDb: 30,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 10,
    ports: 4,
    polarization: '±45° slant',
    source: 'https://alphawireless.com/product/aw3161-e-f-v2/',
    notes: 'Quoted 17.9–18 dBi. 4×4 MIMO, 0–10° electrical tilt, >20 dB upper sidelobe suppression. Vertical beamwidth not published — derived.',
  },
  {
    id: 'kp-kpp-3sx8-65',
    vendor: 'KP Performance',
    model: 'KPP-3SX8-65 (ProLine)',
    label: 'KP KPP-3SX8-65 — 65°, 17 dBi, 8-port',
    bandLabel: '3300–4200 MHz (CBRS + C-band)',
    freqMinMhz: 3300,
    freqMaxMhz: 4200,
    gainDbi: 17,
    beamWidthDeg: 65,
    verticalBeamwidthDeg: 8.8,
    verticalDerived: false,
    frontToBackDb: 40,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 8,
    polarization: '±45° slant',
    source: 'https://kpperformance.com/product/33ghz-42ghz-proline-65deg-sector-antenna-8-port-17dbi-gain-45-slant-kpp-3sx8-65',
    notes: 'Gain quoted 16–17.5 dBi across the band. KP\'s product page lists 65° horizontal; some channel listings say 67° — the 1–2° does not change a plan. 40 dB front-to-back is unusually good, which shows up as less inter-sector interference.',
  },
  {
    id: 'kp-3sx4-90',
    vendor: 'KP Performance',
    model: 'KP-3SX4-90',
    label: 'KP KP-3SX4-90 — 90°, 17 dBi',
    bandLabel: '3300–3800 MHz (CBRS n48/B48)',
    freqMinMhz: 3300,
    freqMaxMhz: 3800,
    gainDbi: 17,
    beamWidthDeg: 90,
    verticalBeamwidthDeg: 6,
    verticalDerived: false,
    frontToBackDb: 30,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 4,
    polarization: '±45° slant',
    source: 'https://www.kpperformance.com/3-3ghz-to-3-8ghz-90-degree-17-dbi-slant-polarization-4-port-sector-antenna-kp-3sx4-90',
    notes: 'Wider azimuth for the same gain, bought with a narrower 6° vertical beam — so it needs its downtilt set more carefully than a 65° panel.',
  },
  {
    id: 'kp-3scx4-65',
    vendor: 'KP Performance',
    model: 'KP-3SCX4-65 (small cell)',
    label: 'KP KP-3SCX4-65 — 65°, 15 dBi, small cell',
    bandLabel: '3300–3800 MHz (CBRS n48/B48)',
    freqMinMhz: 3300,
    freqMaxMhz: 3800,
    gainDbi: 15,
    beamWidthDeg: 65,
    verticalBeamwidthDeg: derivedVerticalBeamwidthDeg(15, 65),
    verticalDerived: true,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 4,
    polarization: '±45° slant',
    source: 'https://kpperformance.com/product/33ghz-38ghz-65degree-sector-antenna-15dbi-4-port-45-slant-kp-3scx4-65',
    notes: 'Small-cell enclosure: less gain than a macro panel, and a correspondingly wider vertical beam, which suits a low mast on a short street. Vertical beamwidth and front-to-back not published.',
  },
  {
    id: 'kp-3dp33s-45',
    vendor: 'KP Performance',
    model: 'KP-3DP33S-45',
    label: 'KP KP-3DP33S-45 — 33°, 18.8 dBi',
    bandLabel: '3400–4200 MHz (CBRS + C-band)',
    freqMinMhz: 3400,
    freqMaxMhz: 4200,
    gainDbi: 18.8,
    beamWidthDeg: 33,
    verticalBeamwidthDeg: 8,
    verticalDerived: false,
    frontToBackDb: 35,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 2,
    polarization: '±45° slant',
    source: 'https://kpperformance.com/product/35ghz-42ghz-33degree-sector-antenna-188dbi-2-port-45-slant-kp-3dp33s-45',
    notes: 'A narrow panel for reaching down one corridor or road rather than covering a sector. Three of these do NOT cover a circle — at 120° spacing the crossover sits about 40 dB down, i.e. past the front-to-back floor.',
  },
  {
    id: 'kp-3qomni-8',
    vendor: 'KP Performance',
    model: 'KP-3QOMNI-8',
    label: 'KP KP-3QOMNI-8 — omni, 8.5 dBi',
    bandLabel: '3500–3800 MHz (CBRS n48/B48)',
    freqMinMhz: 3500,
    freqMaxMhz: 3800,
    gainDbi: 8.5,
    beamWidthDeg: 360,
    verticalBeamwidthDeg: derivedVerticalBeamwidthDeg(8.5, 360),
    verticalDerived: true,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 4,
    polarization: '±45° slant',
    source: 'https://shopdoubleradius.com/products/kp-performance-kp-3qomni-8-4-port-3-5-3-8ghz-omni-8-5db-kp-3qomni-8',
    notes: 'Omnidirectional: azimuth is meaningless for this one, so a single-sector site is the right layout. Vertical beamwidth not published — derived.',
  },
  {
    id: 'commscope-hbx-6516ds-vtm',
    vendor: 'CommScope',
    model: 'HBX-6516DS-VTM',
    label: 'CommScope HBX-6516DS-VTM — 65°, 17.6 dBi',
    bandLabel: '1710–2180 MHz (B1/B2/B3/B66)',
    freqMinMhz: 1710,
    freqMaxMhz: 2180,
    gainDbi: 17.6,
    beamWidthDeg: 65,
    verticalBeamwidthDeg: 6.9,
    verticalDerived: false,
    frontToBackDb: 35,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 10,
    ports: 2,
    polarization: '±45° slant',
    source: 'https://www.commscope.com/catalog/antennas/product_details.aspx?id=15648',
    notes: 'Mid-band rather than CBRS — the one to pick for a B66 sector. Published per sub-band: 17.4 dBi / 7.4° at 1710–1880, 17.6 / 6.9 at 1850–1990, 17.8 / 6.4 at 1920–2180; the mid figures are used here. Discontinued March 2024 but very widely installed.',
  },
  {
    id: 'generic-65',
    vendor: 'Generic',
    model: '65° macro panel',
    label: 'Generic 65° macro panel',
    bandLabel: 'Any — not band-limited',
    freqMinMhz: 0,
    freqMaxMhz: 100000,
    gainDbi: 17,
    beamWidthDeg: 65,
    verticalBeamwidthDeg: 9,
    verticalDerived: false,
    frontToBackDb: 25,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 2,
    polarization: '±45° slant',
    source: '',
    generic: true,
    notes: 'A typical three-sector macro panel, not a specific product. Use it to sketch, then switch to the real model or enter your own spec sheet before the numbers matter.',
  },
  {
    id: 'generic-45',
    vendor: 'Generic',
    model: '45° high-capacity panel',
    label: 'Generic 45° high-capacity panel',
    bandLabel: 'Any — not band-limited',
    freqMinMhz: 0,
    freqMaxMhz: 100000,
    gainDbi: 18.5,
    beamWidthDeg: 45,
    verticalBeamwidthDeg: 9,
    verticalDerived: false,
    frontToBackDb: 28,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 2,
    polarization: '±45° slant',
    source: '',
    generic: true,
    notes: 'A typical four-sector panel, not a specific product. Narrower panels buy capacity with a deeper crossover between sectors — about 5 dB at 90° spacing here.',
  },
  {
    id: 'generic-90',
    vendor: 'Generic',
    model: '90° small-cell panel',
    label: 'Generic 90° small-cell panel',
    bandLabel: 'Any — not band-limited',
    freqMinMhz: 0,
    freqMaxMhz: 100000,
    gainDbi: 14,
    beamWidthDeg: 90,
    verticalBeamwidthDeg: 12,
    verticalDerived: false,
    frontToBackDb: 22,
    electricalDowntiltDeg: 0,
    electricalDowntiltMaxDeg: 0,
    ports: 2,
    polarization: '±45° slant',
    source: '',
    generic: true,
    notes: 'A typical small-cell panel, not a specific product. Matches this tool\'s own built-in defaults.',
  },
];

export function findAntenna(id: string): AntennaModel | undefined {
  return ANTENNA_CATALOG.find(a => a.id === id);
}

/**
 * Whether an antenna actually covers a frequency, with the reason if not.
 *
 * Worth checking and surfacing rather than silently simulating: a 3.5 GHz
 * panel on a 700 MHz carrier is a plan that cannot be built, and the
 * simulation has no way to notice on its own — it only ever sees the pattern
 * numbers, never the band they were measured in.
 */
export function antennaCoversFrequency(antenna: AntennaModel, frequencyGhz: number): { ok: boolean; reason?: string } {
  const mhz = frequencyGhz * 1000;
  if (antenna.freqMaxMhz <= 0) return { ok: true };
  if (mhz < antenna.freqMinMhz || mhz > antenna.freqMaxMhz) {
    return {
      ok: false,
      reason: `${antenna.vendor} ${antenna.model} is specified for ${antenna.freqMinMhz}–${antenna.freqMaxMhz} MHz; this sector is on ${Math.round(mhz)} MHz. Its published gain and pattern do not apply there.`,
    };
  }
  return { ok: true };
}
