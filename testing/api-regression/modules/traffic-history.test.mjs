// Traffic History — traffic-history-controller.ts, mounted at
// /api/traffic-history, 4 routes, all GET/read-only (this module is a thin
// PromQL proxy over the already-deployed Prometheus — see CLAUDE.md pattern
// #12 — no state to write or revert at all).
import { assertOk, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'traffic-history';

const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-10-02T00:00:00.000Z';

export const CASES = [
  {
    name: 'GET / (aggregate traffic, time range)',
    async run({ client }) {
      const res = await client.get(`/api/traffic-history/?from=${FROM}&to=${TO}`);
      assertOk(res, 'GET /api/traffic-history/');
      if (!Array.isArray(res.data?.points)) return fail('response missing "points" array', res.data);
      return pass(`${res.data.points.length} point(s)`);
    },
  },
  {
    name: 'GET /period-summary',
    async run({ client }) {
      const subsRes = await client.get('/api/subscribers?pageSize=1');
      const imsi = subsRes.data?.subscribers?.[0]?.imsi;
      if (!imsi) return fail('no subscribers available on this instance to query a period summary for');
      const missingRes = await client.get(`/api/traffic-history/period-summary?from=${FROM}&to=${TO}`);
      if (missingRes.status !== 400) return fail(`expected HTTP 400 for a missing imsi, got ${missingRes.status}`);
      const res = await client.get(`/api/traffic-history/period-summary?from=${FROM}&to=${TO}&imsi=${imsi}`);
      assertOk(res, 'GET /api/traffic-history/period-summary');
      return pass('period summary read successfully; missing-imsi case correctly rejected (400)');
    },
  },
  {
    name: 'GET /subscribers (per-subscriber traffic list)',
    async run({ client }) {
      const res = await client.get('/api/traffic-history/subscribers');
      assertOk(res, 'GET /api/traffic-history/subscribers');
      return pass('subscriber traffic list read successfully');
    },
  },
  {
    name: 'GET /radios (per-radio traffic list)',
    async run({ client }) {
      const res = await client.get('/api/traffic-history/radios');
      assertOk(res, 'GET /api/traffic-history/radios');
      return pass('radio traffic list read successfully');
    },
  },
];
