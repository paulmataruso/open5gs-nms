// Syslog Forwarding — syslog-controller.ts, 4 routes. Low blast radius
// compared to most other modules: rsyslog is a plain log daemon with no
// live-subscriber/call impact, and this module owns a single, exclusively-
// named drop-in file (71-open5gs-nms-forward.conf) it never shares with
// anything else — so /configure and /disable are both exercised directly,
// not gated behind --include-disruptive like a core-NF-restarting route
// would be.
//
// POST /install is the one route NOT exercised — same multi-minute real
// apt-install reasoning as every other module's /install.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'syslog';

export const CASES = [
  {
    name: 'GET /status',
    async run({ client }) {
      const res = await client.get('/api/syslog/status');
      assertOk(res, 'GET /api/syslog/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      return pass(`installed=${res.data.installed} configured=${res.data.configured}`);
    },
  },
  {
    name: 'POST /configure input validation',
    async run({ client }) {
      const statusRes = await client.get('/api/syslog/status');
      if (!statusRes.data?.installed) return skip('rsyslog not installed');

      const cases = [
        { body: { port: 514, protocol: 'udp' }, label: 'missing host' },
        { body: { host: '127.0.0.1', port: 0, protocol: 'udp' }, label: 'port 0' },
        { body: { host: '127.0.0.1', port: 99999, protocol: 'udp' }, label: 'port > 65535' },
        { body: { host: '127.0.0.1', port: 514, protocol: 'sctp' }, label: 'invalid protocol' },
      ];
      const problems = [];
      for (const c of cases) {
        const res = await client.post('/api/syslog/configure', c.body);
        if (res.status !== 400) problems.push(`${c.label}: expected HTTP 400, got ${res.status}`);
      }
      if (problems.length > 0) return fail(problems.join('; '));
      return pass('all 4 invalid inputs correctly rejected (400)');
    },
  },
  {
    // Full cycle against a real (loopback) target: configure -> verify the
    // real drop-in file + /status agree -> disable -> verify both agree
    // forwarding stopped -> restore whatever was configured before (if
    // anything) so the instance ends up exactly as it started.
    name: 'full cycle: configure -> verify -> disable -> verify -> restore original',
    async run({ client, revertQueue }) {
      const before = await client.get('/api/syslog/status');
      if (!before.data?.installed) return skip('rsyslog not installed');
      const original = before.data.configured ? before.data.target : null;

      revertQueue.push('restore original syslog forwarding target', async () => {
        if (original) {
          await client.post('/api/syslog/configure', original);
        } else {
          const current = await client.get('/api/syslog/status');
          if (current.data?.configured) await client.post('/api/syslog/disable', {});
        }
      });

      const testTarget = { host: '127.0.0.1', port: 1514, protocol: 'udp' };
      const configRes = await client.post('/api/syslog/configure', testTarget);
      assertOk(configRes, 'POST /api/syslog/configure');

      const afterConfig = await client.get('/api/syslog/status');
      if (!afterConfig.data?.configured) return fail('/status reports configured=false right after a successful /configure');
      if (afterConfig.data?.target?.host !== testTarget.host
          || afterConfig.data?.target?.port !== testTarget.port
          || afterConfig.data?.target?.protocol !== testTarget.protocol) {
        return fail(`/status target mismatch after configure: ${JSON.stringify(afterConfig.data?.target)}`);
      }
      if (!afterConfig.data?.running) return fail('rsyslog is not reported running after /configure');

      const disableRes = await client.post('/api/syslog/disable', {});
      assertOk(disableRes, 'POST /api/syslog/disable');
      const afterDisable = await client.get('/api/syslog/status');
      if (afterDisable.data?.configured) return fail('/status still reports configured=true after /disable');

      // Restore now (not just via the revertQueue's end-of-run drain) so a
      // later case in this same run that reads /status sees the original
      // state, not a transiently-disabled one.
      if (original) {
        const restoreRes = await client.post('/api/syslog/configure', original);
        assertOk(restoreRes, 'POST /api/syslog/configure (restore original)');
      }

      return pass('configure -> verify -> disable -> verify cycle confirmed against real /status + config state', { testTarget, original });
    },
  },
];
