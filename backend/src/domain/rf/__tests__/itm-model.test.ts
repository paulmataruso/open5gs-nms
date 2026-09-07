import * as fs from 'fs';
import * as path from 'path';
import { itmPathLossDb } from '../itm-model';
import { TerrainProfilePoint } from '../diffraction';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const createItmModule = require('../wasm/itm/itm.js');

interface RawItmModule {
  VectorDouble: new () => { push_back(v: number): void; delete(): void };
  itmP2pTls(
    txHeightM: number, rxHeightM: number, profile: unknown, climate: number, n0: number, freqMhz: number,
    polarization: number, epsilon: number, sigma: number, mdvar: number,
    timePercent: number, locationPercent: number, situationPercent: number,
  ): { returnCode: number; pathLossDb: number; warnings: number };
}

const VENDOR_DIR = path.join(__dirname, '..', '..', '..', '..', 'vendor', 'itm-src');

interface P2pRow {
  hTxM: number; hRxM: number; epsilon: number; sigma: number; n0: number; freqMhz: number;
  pol: number; climate: number; time: number; location: number; situation: number; mdvar: number; aDb: number;
}

function parseP2pCsv(): P2pRow[] {
  const text = fs.readFileSync(path.join(VENDOR_DIR, 'p2p.csv'), 'utf8').trim();
  return text.split('\n').slice(1).map(line => {
    const [hTxM, hRxM, epsilon, sigma, n0, freqMhz, pol, climate, time, location, situation, mdvar, aDb] =
      line.split(',').map(Number);
    return { hTxM, hRxM, epsilon, sigma, n0, freqMhz, pol, climate, time, location, situation, mdvar, aDb };
  });
}

function parsePflsCsv(): number[][] {
  const text = fs.readFileSync(path.join(VENDOR_DIR, 'pfls.csv'), 'utf8').trim();
  return text.split('\n').map(line => line.split(',').map(Number));
}

// This suite tests the COMPILED WASM MODULE directly (raw ints and a raw
// pfl[] array via VectorDouble, bypassing itm-model.ts's named-enum
// wrapper) rather than itmPathLossDb() — NTIA's own p2p.csv uses a raw
// mdvar value (12) that decomposes into a base variability mode (2 =
// "mobile") plus a legacy "+10" flag bit that disables a random location
// draw (see ValidateInputs.cpp's mdvar range check: 0-3/10-13/20-23/30-33
// are the only valid bands). This codebase's own ItmVariabilityMode enum
// deliberately exposes only the four base modes (see itm-model.ts's header
// comment on why area mode / the raw legacy encoding isn't exposed) — so
// reproducing NTIA's exact reference vectors requires calling the module's
// raw binding directly. That's a distinct, narrower concern from the
// higher-level API tests below: this proves the compiled module faithfully
// reproduces the actual reference *binary's* output, not just that
// itm-model.ts's own defaulting/error-handling logic works.
describe('ITM WASM module vs NTIA\'s own reference vectors (vendor/itm-src/p2p.csv + pfls.csv)', () => {
  let mod: RawItmModule;
  beforeAll(async () => {
    mod = await createItmModule();
  });

  const p2pRows = parseP2pCsv();
  const pflRows = parsePflsCsv();

  test('p2p.csv and pfls.csv have the same row count (NTIA\'s own README: the two files are row-index-paired)', () => {
    expect(pflRows.length).toBe(p2pRows.length);
    expect(p2pRows.length).toBeGreaterThan(0);
  });

  p2pRows.forEach((row, i) => {
    test(`row ${i}: h_tx=${row.hTxM}m h_rx=${row.hRxM}m f=${row.freqMhz}MHz matches NTIA's own A__db=${row.aDb}dB to within 0.005dB`, () => {
      const pfl = pflRows[i];
      const vec = new mod.VectorDouble();
      try {
        for (const v of pfl) vec.push_back(v);
        const result = mod.itmP2pTls(
          row.hTxM, row.hRxM, vec, row.climate, row.n0, row.freqMhz,
          row.pol, row.epsilon, row.sigma, row.mdvar, row.time, row.location, row.situation,
        );
        // 0 = SUCCESS, 1 = SUCCESS_WITH_WARNINGS (still a real result);
        // >=1000 would be a genuine computation error, which NTIA's own
        // reference vectors should never trigger.
        expect(result.returnCode).toBeLessThan(1000);
        expect(result.pathLossDb).toBeCloseTo(row.aDb, 2);
      } finally {
        vec.delete();
      }
    });
  });
});

// A small, gently-rolling synthetic terrain profile for the higher-level
// API tests below, where the exact path-loss value isn't the point (that's
// what the NTIA-vector suite above already nails down) — these tests are
// about itm-model.ts's own defaulting, error-handling, and warning-decode
// behavior around the compiled module.
function syntheticProfile(pointCount: number, stepM: number, baseElevationM: number): TerrainProfilePoint[] {
  return Array.from({ length: pointCount }, (_, i) => ({
    distanceM: i * stepM,
    elevationM: baseElevationM + 5 * Math.sin(i / 3),
  }));
}

describe('itmPathLossDb (higher-level API: itm-model.ts)', () => {
  test('a realistic profile returns ok:true with a well-formed equation record', async () => {
    const profile = syntheticProfile(20, 200, 250);
    const r = await itmPathLossDb(
      profile, 30, 1.5, 1900,
      0.005, 15, 301, 'continental-temperate', 'horizontal', 'broadcast', 50, 50, 50,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Number.isFinite(r.pathLossDb)).toBe(true);
    expect(r.pathLossDb).toBeGreaterThan(0);
    expect(r.equation.variables.f.value).toBe(1900);
    expect(r.equation.variables.h_tx.value).toBe(30);
    expect(r.equation.variables.h_rx.value).toBe(1.5);
    expect(r.equation.source).toMatch(/NTIA/);
  });

  test('fewer than 2 profile points is rejected with a named error, not a WASM call', async () => {
    const r = await itmPathLossDb(
      [{ distanceM: 0, elevationM: 250 }], 30, 1.5, 1900,
      0.005, 15, 301, 'continental-temperate', 'horizontal', 'broadcast', 50, 50, 50,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toMatch(/terrain profile/i);
  });

  // Regression test — found live via a coverage-grid API smoke test: a grid
  // cell that lands exactly on the site's own coordinates (any odd grid
  // resolution's center cell does this) produces a profile where every
  // point sits at distance 0, so toItmProfile()'s xi is exactly 0. ITM_P2P_TLS
  // doesn't treat xi=0 as an input error — it silently returns
  // SUCCESS_WITH_WARNINGS with a NaN pathLossDb, which leaked into the API
  // response as totalReceivedPowerDbm:null instead of the cell being
  // cleanly skipped like every other model's "too close" case.
  test('a degenerate (zero-length) terrain profile is rejected, not silently passed to the module as a NaN result', async () => {
    const zeroLengthProfile = [
      { distanceM: 0, elevationM: 250 },
      { distanceM: 0, elevationM: 251 },
      { distanceM: 0, elevationM: 249 },
    ];
    const r = await itmPathLossDb(
      zeroLengthProfile, 30, 1.5, 1900,
      0.005, 15, 301, 'continental-temperate', 'horizontal', 'broadcast', 50, 50, 50,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toMatch(/nonzero distance/i);
  });

  test('TX height far outside ITM\'s valid range (0.5-3000m) is rejected via the module\'s own validation', async () => {
    const profile = syntheticProfile(10, 200, 250);
    const r = await itmPathLossDb(
      profile, 5000, 1.5, 1900,
      0.005, 15, 301, 'continental-temperate', 'horizontal', 'broadcast', 50, 50, 50,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toMatch(/TX terminal height/i);
  });

  test('frequency far outside ITM\'s valid range (20-20000MHz) is rejected via the module\'s own validation', async () => {
    const profile = syntheticProfile(10, 200, 250);
    const r = await itmPathLossDb(
      profile, 30, 1.5, 100000,
      0.005, 15, 301, 'continental-temperate', 'horizontal', 'broadcast', 50, 50, 50,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toMatch(/frequency/i);
  });

  test('a near-limit TX height (0.7m, inside the hard error bound but outside the "typical" band) decodes a human-readable warning', async () => {
    const profile = syntheticProfile(10, 200, 250);
    const r = await itmPathLossDb(
      profile, 0.7, 1.5, 1900,
      0.005, 15, 301, 'continental-temperate', 'horizontal', 'broadcast', 50, 50, 50,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toMatch(/TX terminal height/i);
    expect(r.equation.limitations).toMatch(/TX terminal height/i);
  });
});
