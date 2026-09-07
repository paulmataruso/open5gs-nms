import { walfischIkegamiPathLossDb } from '../walfisch-ikegami-model';

describe('walfisch-ikegami-model', () => {
  describe('LOS (street canyon)', () => {
    test('worked example: f=1800MHz, d=1km -> ~107.705dB', () => {
      // L = 42.6 + 26*log10(1) + 20*log10(1800) = 42.6 + 0 + 65.10545 = 107.70545
      const r = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'los', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.pathLossDb).toBeCloseTo(107.705, 2);
    });

    test('reduces to the model\'s own free-space term at d=0.02km (the LOS constant is calibrated for exactly this)', () => {
      // The report's own words: "the first constant is determined in such a way
      // that Lb is equal to free-space loss for d = 20 m" — using this model's
      // own free-space form (L0 = 32.4 + 20*log10(d_km) + 20*log10(f_MHz)),
      // not the codebase's separately-verified, more precise 32.44 FSPL constant.
      const l0At20m = 32.4 + 20 * Math.log10(0.02) + 20 * Math.log10(1800);
      const r = walfischIkegamiPathLossDb(1800, 30, 1.5, 0.02, 'los', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.pathLossDb).toBeCloseTo(l0At20m, 1);
    });

    test('LOS mode ignores NLOS-only geometry entirely (result unaffected by absurd building values)', () => {
      const a = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'los', 20, 17.5, 35, 90, 'medium');
      const b = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'los', 999, 1, 999, 0, 'metropolitan');
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.pathLossDb).toBeCloseTo(b.pathLossDb, 9);
    });
  });

  describe('NLOS', () => {
    test('worked example: base station ABOVE rooftop -> ~136.574dB', () => {
      // hand-derived: f=1800, d=1km, hBase=30, hRoof=20 (aboveRoof), hMobile=1.5,
      // w=17.5, b=35, phi=90 (Lori=0.01), medium city.
      // L0=97.50545, Lrts=28.575765, Lbsh=-18.745069, ka=54, kd=18,
      // kf(medium,1800)=-3.337838, Lmsd=10.492820, sum=L0+Lrts+Lmsd=136.574035
      const r = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'nlos', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.pathLossDb).toBeCloseTo(136.574, 2);
    });

    test('worked example: base station AT/BELOW rooftop, d<0.5km -> ~135.889dB', () => {
      // hand-derived: f=1800, d=0.3km (<0.5, exercises ka's third branch), hBase=15,
      // hRoof=20 (hBase<=hRoof), hMobile=1.5, w=17.5, b=35, phi=90, medium city.
      // L0=87.047871, Lrts=28.575765 (unchanged — independent of hBase/d),
      // Lbsh=0, ka=56.4, kd=21.75, Lmsd=20.265271, sum=135.888907
      const r = walfischIkegamiPathLossDb(1800, 15, 1.5, 0.3, 'nlos', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.pathLossDb).toBeCloseTo(135.889, 2);
    });

    test('rejects hRoof <= hMobile — rooftop diffraction is undefined at or below mobile height', () => {
      const r = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'nlos', 1.0, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(false);
    });

    test('metropolitan and medium city types produce genuinely different results (kf branch actually taken)', () => {
      const medium = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'nlos', 20, 17.5, 35, 90, 'medium');
      const metro = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'nlos', 20, 17.5, 35, 90, 'metropolitan');
      expect(medium.ok && metro.ok).toBe(true);
      if (medium.ok && metro.ok) expect(medium.pathLossDb).not.toBeCloseTo(metro.pathLossDb, 3);
    });

    test('L_ori is continuous at the phi=55 branch boundary (regression guard)', () => {
      const below = walfischIkegamiPathLossDb(1800, 15, 1.5, 0.3, 'nlos', 20, 17.5, 35, 54.999, 'medium');
      const above = walfischIkegamiPathLossDb(1800, 15, 1.5, 0.3, 'nlos', 20, 17.5, 35, 55.001, 'medium');
      expect(below.ok && above.ok).toBe(true);
      if (below.ok && above.ok) expect(Math.abs(below.pathLossDb - above.pathLossDb)).toBeLessThan(0.01);
    });

    test('ka is continuous at the d=0.5km branch boundary when base station is at/below rooftop (regression guard)', () => {
      // A very small delta around the boundary — log10(d) itself keeps moving
      // continuously with d regardless of which ka branch is active, so a wider
      // delta would mix that natural drift in with what this test actually checks:
      // whether the two ka branches themselves agree at the seam. A real
      // discontinuity would show up as a fixed jump independent of how small the
      // delta gets; natural log10(d) drift shrinks to ~0 as the delta shrinks.
      const below = walfischIkegamiPathLossDb(1800, 15, 1.5, 0.5 - 1e-7, 'nlos', 20, 17.5, 35, 90, 'medium');
      const above = walfischIkegamiPathLossDb(1800, 15, 1.5, 0.5 + 1e-7, 'nlos', 20, 17.5, 35, 90, 'medium');
      expect(below.ok && above.ok).toBe(true);
      if (below.ok && above.ok) expect(Math.abs(below.pathLossDb - above.pathLossDb)).toBeLessThan(0.0001);
    });

    test('taller effective obstruction (larger dhMobile) produces more Lrts loss, all else equal', () => {
      const shortRoof = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'nlos', 5, 17.5, 35, 90, 'medium');
      const tallRoof = walfischIkegamiPathLossDb(1800, 30, 1.5, 1, 'nlos', 25, 17.5, 35, 90, 'medium');
      expect(shortRoof.ok && tallRoof.ok).toBe(true);
      if (shortRoof.ok && tallRoof.ok) expect(tallRoof.pathLossDb).toBeGreaterThan(shortRoof.pathLossDb);
    });
  });

  describe('validity range checks', () => {
    test('rejects frequency outside [800, 2000] MHz', () => {
      const r = walfischIkegamiPathLossDb(700, 30, 1.5, 1, 'los', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(false);
    });
    test('rejects distance outside [0.02, 5] km', () => {
      const r = walfischIkegamiPathLossDb(1800, 30, 1.5, 10, 'los', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(false);
    });
    test('rejects base station height outside [4, 50] m', () => {
      const r = walfischIkegamiPathLossDb(1800, 2, 1.5, 1, 'los', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(false);
    });
    test('rejects mobile height outside [1, 3] m', () => {
      const r = walfischIkegamiPathLossDb(1800, 30, 10, 1, 'los', 20, 17.5, 35, 90, 'medium');
      expect(r.ok).toBe(false);
    });
  });
});
