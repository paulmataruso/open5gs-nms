// Security Gateway (SecGW) — secgw-controller.ts, mounted at /api/secgw,
// 22 routes. This manages real IPsec/strongSwan tunnel state for real,
// physically-attached radios — per CLAUDE.md's own documented history,
// pool/traffic-selector allocation here has previously caused a real,
// confirmed production outage (two radios colliding on one kernel XFRM
// policy slot) when done carelessly. Given the real security/connectivity
// stakes of getting a synthetic test radio's pool/traffic-selector
// allocation subtly wrong in a way that could interfere with an already-
// connected real radio, this module is scoped to read-only routes only —
// unlike most other modules in this suite, no throwaway create/delete
// cycle is attempted here, even against a nominally-fake target.
//
// NOT exercised: /install, /configure, /dns-record, /start, /stop,
// /restart, all of /radios (POST/PUT/DELETE/enable/disable/rotate-
// credential/test-tunnel/bundle), PUT /configs/content, /uninstall.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'secgw';

export const CASES = [
  { name: 'All mutating routes (not exercised)', async run() { return skip('manages real IPsec/strongSwan tunnel state for real, physically-attached radios — see this file\'s header comment'); } },

  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/secgw/status');
      assertOk(res, 'GET /api/secgw/status');
      if (typeof res.data?.installStatus !== 'string') return fail('response missing string "installStatus"', res.data);
      return pass(`installStatus=${res.data.installStatus} configured=${res.data.configured}`);
    },
  },
  {
    name: 'GET /sessions (read-only — real live IPsec SA state)',
    async run({ client }) {
      const statusRes = await client.get('/api/secgw/status');
      if (statusRes.data?.installStatus !== 'complete') return skip('SecGW not installed');
      const res = await client.get('/api/secgw/sessions');
      assertOk(res, 'GET /api/secgw/sessions');
      return pass('sessions read successfully');
    },
  },
  {
    name: 'GET /radios (read-only)',
    async run({ client }) {
      const statusRes = await client.get('/api/secgw/status');
      if (statusRes.data?.installStatus !== 'complete') return skip('SecGW not installed');
      const res = await client.get('/api/secgw/radios');
      assertOk(res, 'GET /api/secgw/radios');
      if (!Array.isArray(res.data?.radios)) return fail('response missing "radios" array', res.data);
      return pass(`${res.data.radios.length} radio(s) configured`);
    },
  },
  {
    name: 'GET /configs + GET /configs/content (read-only)',
    async run({ client }) {
      const manifestRes = await client.get('/api/secgw/configs');
      assertOk(manifestRes, 'GET /api/secgw/configs');
      if (!Array.isArray(manifestRes.data?.configs)) return fail('response missing "configs" array', manifestRes.data);
      let readCount = 0;
      for (const f of manifestRes.data.configs) {
        if (!f.exists) continue;
        const res = await client.get(`/api/secgw/configs/content?path=${encodeURIComponent(f.path)}`);
        assertOk(res, `GET /api/secgw/configs/content (${f.label ?? f.path})`);
        readCount++;
      }
      return pass(`read ${readCount} file(s)`);
    },
  },
];
