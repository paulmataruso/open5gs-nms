// RF Planning calculators — rf-planning-controller.ts, mounted at
// /api/rf-planning, 6 routes. Pure calculation over backend/src/domain/rf/ —
// no I/O, no persisted state, no radio hardware involved at all (this is a
// deterministic link-budget/coverage engine, not a provisioning module) —
// so every route here is safe to call freely, no disruptive gating needed.
// useTerrainData is deliberately omitted/false in every case to keep this
// fast and avoid depending on an external elevation data source being
// reachable from this host.
import { assertOk, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'rf-planning';

const BASE_RADIO = {
  txPowerDbm: 43, cableLossDb: 1.5, connectorLossDb: 0.5, antennaGainDbi: 17,
  frequencyMhz: 2130, distanceM: 1500,
};

export const CASES = [
  {
    name: 'POST /link-budget',
    async run({ client }) {
      const res = await client.post('/api/rf-planning/link-budget', BASE_RADIO);
      assertOk(res, 'POST /api/rf-planning/link-budget');
      if (res.data?.ok !== true) return fail('expected ok:true for a well-formed link budget', res.data);
      if (typeof res.data?.result?.totalReceivedPowerDbm !== 'number') return fail('response missing numeric result.totalReceivedPowerDbm', res.data);
      return pass(`totalReceivedPowerDbm=${res.data.result.totalReceivedPowerDbm.toFixed(1)}`);
    },
  },
  {
    name: 'POST /link-budget — missing required field is reported, not a 500',
    async run({ client }) {
      const res = await client.post('/api/rf-planning/link-budget', { cableLossDb: 1.5 });
      if (res.status === 500) return fail('a missing-field input should be a handled validation error, not a 500', res.data);
      if (res.data?.ok !== false) return fail('expected ok:false for an incomplete input', res.data);
      return pass('incomplete input correctly reported as ok:false, not a crash');
    },
  },
  {
    name: 'POST /point-analysis',
    async run({ client }) {
      const res = await client.post('/api/rf-planning/point-analysis', {
        siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
        targetLat: 37.7849, targetLon: -122.4094, targetHeightM: 1.5,
        useTerrainData: false,
      });
      assertOk(res, 'POST /api/rf-planning/point-analysis');
      if (res.data?.ok !== true) return fail('expected ok:true', res.data);
      if (typeof res.data?.result?.distanceM !== 'number') return fail('response missing numeric result.distanceM', res.data);
      return pass(`distanceM=${Math.round(res.data.result.distanceM)}`);
    },
  },
  {
    name: 'POST /path-loss',
    async run({ client }) {
      const res = await client.post('/api/rf-planning/path-loss', { distanceM: 1000, frequencyMhz: 2100 });
      assertOk(res, 'POST /api/rf-planning/path-loss');
      if (res.data?.ok !== true || typeof res.data?.result?.pathLossDb !== 'number') {
        return fail('expected ok:true with a numeric result.pathLossDb', res.data);
      }
      const invalidRes = await client.post('/api/rf-planning/path-loss', { distanceM: 1000 });
      if (invalidRes.status !== 400) return fail(`missing frequencyMhz should be HTTP 400, got ${invalidRes.status}`);
      return pass(`pathLossDb=${res.data.result.pathLossDb.toFixed(1)}; missing-field case correctly 400`);
    },
  },
  {
    name: 'POST /coverage-grid (small grid)',
    async run({ client }) {
      const res = await client.post('/api/rf-planning/coverage-grid', {
        ...BASE_RADIO, siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
        azimuthDeg: 90, horizontalBeamwidthDeg: 65,
        radiusM: 500, resolution: 100, useTerrainData: false,
      });
      assertOk(res, 'POST /api/rf-planning/coverage-grid');
      if (res.data?.ok !== true) return fail('expected ok:true', res.data);
      if (!Array.isArray(res.data?.result?.cells) || res.data.result.cells.length === 0) {
        return fail('response missing a non-empty result.cells grid', res.data);
      }
      return pass(`${res.data.result.cells.length} cell(s) computed`);
    },
  },
  {
    name: 'POST /interference-grid (small grid, 2 sites)',
    async run({ client }) {
      const site = (lon) => ({
        ...BASE_RADIO, siteLat: 37.7749, siteLon: lon, siteHeightM: 30,
        azimuthDeg: 90, horizontalBeamwidthDeg: 65,
      });
      const res = await client.post('/api/rf-planning/interference-grid', {
        sites: [{ ...site(-122.42), id: 'site-a' }, { ...site(-122.41), id: 'site-b' }],
        centerLat: 37.7749, centerLon: -122.415, radiusM: 500, resolution: 100,
        bandwidthHz: 20_000_000, useTerrainData: false,
      });
      assertOk(res, 'POST /api/rf-planning/interference-grid');
      if (res.data?.ok !== true) return fail('expected ok:true', res.data);
      if (!Array.isArray(res.data?.result?.cells) || res.data.result.cells.length === 0) {
        return fail('response missing a non-empty result.cells grid', res.data);
      }
      return pass(`${res.data.result.cells.length} cell(s) computed across 2 sites`);
    },
  },
  {
    name: 'GET /lte-bands',
    async run({ client }) {
      const res = await client.get('/api/rf-planning/lte-bands');
      assertOk(res, 'GET /api/rf-planning/lte-bands');
      if (!Array.isArray(res.data?.bands) || res.data.bands.length === 0) return fail('response missing a non-empty "bands" array', res.data);
      return pass(`${res.data.bands.length} band(s)`);
    },
  },
];
