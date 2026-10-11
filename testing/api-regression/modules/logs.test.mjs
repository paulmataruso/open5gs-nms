// Logs / Major Events / Debug Bundle — log-download-controller.ts, mounted at
// /api/logs, 4 routes. This is the real backing API for both the Unified
// Logs page and the Major Events view (major-event-classifier.ts has no
// routes of its own — classifyMajorEvent()/extractEventDetails() are called
// directly from /context and /recent-radios below).
//
// All 4 routes are pure reads (log files, system info via read-only
// commands like `uname`/`df`/`systemctl status`/`iptables -L`) assembled
// into a response or a temp tarball that's always cleaned up in a
// `finally` — nothing here writes to any persistent host state, so there's
// nothing to revert and nothing is gated behind --include-disruptive.
import { assertOk, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'logs';

export const CASES = [
  {
    name: 'POST /download — single service, small line range',
    async run({ client }) {
      const res = await client.post('/api/logs/download', {
        services: ['mme'], source: 'open5gs', range: { type: 'lines', lines: 5 },
      });
      // 404 is a legitimate outcome too (mme.log empty/rotated/not present on
      // this instance) — only a 5xx or an unexpected 4xx is a real problem.
      if (res.status !== 200 && res.status !== 404) {
        return fail(`unexpected HTTP ${res.status}`, res.data);
      }
      return pass(`HTTP ${res.status}`);
    },
  },
  {
    name: 'POST /download — input validation (no valid services)',
    async run({ client }) {
      const res = await client.post('/api/logs/download', {
        services: ['not-a-real-service'], source: 'open5gs', range: { type: 'lines', lines: 5 },
      });
      if (res.status !== 400) return fail(`expected HTTP 400 for an unrecognized service, got ${res.status}`, res.data);

      // Security regression check: a docker-source "service" containing shell
      // metacharacters must be filtered out by the allowlist regex, not passed
      // through to the docker-logs spawn call.
      const injectionRes = await client.post('/api/logs/download', {
        services: ['; rm -rf /'], source: 'docker', range: { type: 'lines', lines: 5 },
      });
      if (injectionRes.status !== 400) {
        return fail(`expected a shell-metacharacter service name to be rejected (400), got ${injectionRes.status}`, injectionRes.data);
      }
      return pass('unrecognized service and shell-metacharacter service name both correctly rejected (400)');
    },
  },
  {
    name: 'GET /context input validation + not-found handling',
    async run({ client }) {
      const badService = await client.get('/api/logs/context?service=not-a-real-service&ts=2026-01-01T00:00:00&message=x');
      if (badService.status !== 400) return fail(`expected HTTP 400 for an unsupported service, got ${badService.status}`, badService.data);

      const missingFields = await client.get('/api/logs/context?service=mme');
      if (missingFields.status !== 400) return fail(`expected HTTP 400 for a missing ts/message, got ${missingFields.status}`, missingFields.data);

      // A well-formed request against a timestamp/message that (almost
      // certainly) never occurred — confirms the route reaches the real log
      // file and returns a clean 404, not a crash.
      const notFound = await client.get('/api/logs/context?service=mme&ts=01%2F01+00%3A00%3A00.000&message=api-regression-suite-sentinel-that-will-never-match');
      if (notFound.status !== 404 && notFound.status !== 200) {
        return fail(`expected HTTP 404 (not found) or 200 for a well-formed but non-matching lookup, got ${notFound.status}`, notFound.data);
      }
      return pass(`validation correct; well-formed non-matching lookup returned HTTP ${notFound.status}`);
    },
  },
  {
    name: 'GET /recent-radios',
    async run({ client }) {
      const res = await client.get('/api/logs/recent-radios?days=3');
      assertOk(res, 'GET /api/logs/recent-radios');
      if (!Array.isArray(res.data?.radios)) return fail('response missing "radios" array', res.data);
      for (const r of res.data.radios) {
        if (!r.ip || !r.lastSeen || !r.lastEvent) return fail('a radio entry is missing ip/lastSeen/lastEvent', r);
      }
      return pass(`${res.data.radios.length} radio(s) seen in the last 3 days`);
    },
  },
  {
    name: 'GET /debug-bundle',
    async run({ client }) {
      const res = await client.get('/api/logs/debug-bundle');
      if (res.status !== 200) return fail(`expected HTTP 200, got ${res.status}`, res.data);
      // The client parses the gzip binary as text (and will usually fail to
      // JSON-parse it, landing in __nonJsonBody) — just confirm SOMETHING
      // came back, since we can't meaningfully inspect binary gzip content
      // through a JSON-oriented client.
      const bodyLooksEmpty = res.data === null || (typeof res.data === 'object' && res.data?.__nonJsonBody === '');
      if (bodyLooksEmpty) return fail('debug bundle response body was empty');
      return pass('debug bundle generated and returned HTTP 200');
    },
  },
];
