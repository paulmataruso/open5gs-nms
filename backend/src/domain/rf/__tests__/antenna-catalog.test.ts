import {
  ANTENNA_CATALOG,
  antennaCoversFrequency,
  crossoverLossDb,
  derivedVerticalBeamwidthDeg,
  findAntenna,
  patternWidthDeg,
} from '../antenna-catalog';
import { DEFAULT_FRONT_TO_BACK_DB, horizontalPatternLossDb } from '../antenna-pattern';

describe('derivedVerticalBeamwidthDeg', () => {
  it('inverts the aperture relation', () => {
    // 32400 / (65 * 10^1.8) = 7.9
    expect(derivedVerticalBeamwidthDeg(18, 65)).toBeCloseTo(7.9, 1);
  });

  it('narrows the vertical beam as gain rises for a fixed azimuth width', () => {
    const low = derivedVerticalBeamwidthDeg(14, 65);
    const high = derivedVerticalBeamwidthDeg(20, 65);
    expect(high).toBeLessThan(low);
  });

  it('narrows the vertical beam as the azimuth width widens for a fixed gain', () => {
    expect(derivedVerticalBeamwidthDeg(17, 90)).toBeLessThan(derivedVerticalBeamwidthDeg(17, 65));
  });

  it('clamps to a physically plausible band rather than returning absurd values', () => {
    expect(derivedVerticalBeamwidthDeg(40, 65)).toBeGreaterThanOrEqual(1);
    expect(derivedVerticalBeamwidthDeg(1, 360)).toBeLessThanOrEqual(90);
  });

  it('returns 0 for unusable input instead of NaN or Infinity', () => {
    expect(derivedVerticalBeamwidthDeg(17, 0)).toBe(0);
    expect(derivedVerticalBeamwidthDeg(Number.NaN, 65)).toBe(0);
  });
});

describe('patternWidthDeg', () => {
  it('returns the 3 dB beamwidth exactly at a 3 dB drop', () => {
    expect(patternWidthDeg(65, 3)).toBeCloseTo(65, 6);
    expect(patternWidthDeg(45, 3)).toBeCloseTo(45, 6);
  });

  it('agrees with the engine roll-off it inverts', () => {
    // Half of the -10 dB width is the offset at which the engine reports 10 dB.
    const halfWidth = patternWidthDeg(65, 10) / 2;
    expect(horizontalPatternLossDb(halfWidth, 65, DEFAULT_FRONT_TO_BACK_DB)).toBeCloseTo(10, 6);
  });

  it('explains the apparent gap on a standard 3-sector site', () => {
    // 3 x 65 deg panels on 120 deg spacing: the 3 dB wedges leave 55 deg
    // between them, but the -10 dB contours very nearly touch, which is why
    // the seam is covered rather than empty.
    expect(patternWidthDeg(65, 10)).toBeGreaterThan(115);
    expect(patternWidthDeg(65, 10)).toBeLessThan(120);
  });

  it('never claims more than a full circle', () => {
    expect(patternWidthDeg(200, 10)).toBe(360);
  });
});

describe('crossoverLossDb', () => {
  it('reports about 10 dB at the crossover of 65 deg panels on 120 deg spacing', () => {
    expect(crossoverLossDb(65, 120, DEFAULT_FRONT_TO_BACK_DB)).toBeCloseTo(10.2, 1);
  });

  it('reports a shallower crossover for a wider panel', () => {
    expect(crossoverLossDb(90, 120, DEFAULT_FRONT_TO_BACK_DB))
      .toBeLessThan(crossoverLossDb(65, 120, DEFAULT_FRONT_TO_BACK_DB));
  });

  it('is capped at the front-to-back floor, as the engine is', () => {
    expect(crossoverLossDb(33, 120, 20)).toBe(20);
  });
});

describe('ANTENNA_CATALOG', () => {
  it('has unique ids', () => {
    const ids = ANTENNA_CATALOG.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is findable by id', () => {
    for (const antenna of ANTENNA_CATALOG) {
      expect(findAntenna(antenna.id)).toBe(antenna);
    }
    expect(findAntenna('no-such-antenna')).toBeUndefined();
  });

  it('cites a source for every non-generic entry', () => {
    for (const antenna of ANTENNA_CATALOG) {
      if (antenna.generic) continue;
      expect(antenna.source).toMatch(/^https:\/\//);
    }
  });

  it('labels the generic reference patterns as generic and leaves them unsourced', () => {
    const generics = ANTENNA_CATALOG.filter(a => a.generic);
    expect(generics.length).toBeGreaterThan(0);
    for (const antenna of generics) {
      expect(antenna.vendor).toBe('Generic');
      expect(antenna.source).toBe('');
    }
  });

  it('holds physically coherent numbers', () => {
    for (const antenna of ANTENNA_CATALOG) {
      expect(antenna.freqMinMhz).toBeLessThan(antenna.freqMaxMhz);
      expect(antenna.gainDbi).toBeGreaterThan(0);
      expect(antenna.beamWidthDeg).toBeGreaterThan(0);
      expect(antenna.beamWidthDeg).toBeLessThanOrEqual(360);
      expect(antenna.verticalBeamwidthDeg).toBeGreaterThan(0);
      expect(antenna.verticalBeamwidthDeg).toBeLessThanOrEqual(90);
      expect(antenna.ports).toBeGreaterThanOrEqual(1);
      expect(antenna.electricalDowntiltMaxDeg).toBeGreaterThanOrEqual(antenna.electricalDowntiltDeg);
    }
  });

  it('derives the vertical beamwidth it claims to derive', () => {
    for (const antenna of ANTENNA_CATALOG) {
      if (!antenna.verticalDerived) continue;
      expect(antenna.verticalBeamwidthDeg)
        .toBeCloseTo(derivedVerticalBeamwidthDeg(antenna.gainDbi, antenna.beamWidthDeg), 1);
    }
  });

  it('keeps every PUBLISHED vertical beamwidth within reach of its aperture', () => {
    // A transcription slip (6.9 typed as 69, or a decimal point lost) is the
    // realistic failure here, and it would be invisible in the UI while
    // changing every close-in result. The aperture relation under-estimates
    // a real lossy panel, so the tolerance is wide but finite.
    for (const antenna of ANTENNA_CATALOG) {
      if (antenna.verticalDerived) continue;
      const implied = derivedVerticalBeamwidthDeg(antenna.gainDbi, antenna.beamWidthDeg);
      const ratio = antenna.verticalBeamwidthDeg / implied;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2);
    }
  });

  it('covers CBRS, which is the band this deployment runs', () => {
    const cbrs = ANTENNA_CATALOG.filter(a => a.freqMinMhz <= 3600 && a.freqMaxMhz >= 3600 && !a.generic);
    expect(cbrs.length).toBeGreaterThanOrEqual(5);
  });

  it('offers a range of azimuth widths, not just 65 degrees', () => {
    const widths = new Set(ANTENNA_CATALOG.map(a => a.beamWidthDeg));
    expect(widths.size).toBeGreaterThanOrEqual(4);
  });
});

describe('antennaCoversFrequency', () => {
  const cbrs = findAntenna('alpha-aw3161-e-f-v2')!;

  it('accepts a frequency inside the published range', () => {
    expect(antennaCoversFrequency(cbrs, 3.6).ok).toBe(true);
  });

  it('rejects one outside it and says what the range is', () => {
    const verdict = antennaCoversFrequency(cbrs, 0.7);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('3300');
    expect(verdict.reason).toContain('3800');
    expect(verdict.reason).toContain('700');
  });

  it('rejects a mid-band panel used on CBRS', () => {
    const midband = findAntenna('commscope-hbx-6516ds-vtm')!;
    expect(antennaCoversFrequency(midband, 3.6).ok).toBe(false);
  });

  it('treats the generic patterns as band-agnostic', () => {
    const generic = findAntenna('generic-65')!;
    expect(antennaCoversFrequency(generic, 0.7).ok).toBe(true);
    expect(antennaCoversFrequency(generic, 3.6).ok).toBe(true);
  });
});
