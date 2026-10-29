// CBRS SAS — the NMS's read-only view of SASBench, plus the update-tracking
// routes it owns.
//
// This replaces the old suite that exercised 36 routes of this project's own
// home-grown SAS. That module is gone: SASBench is the SAS now, runs as its
// own container, and binds the WINNF-TS-0016 protocol ports itself. Radios
// never touch the NMS, so there are no protocol endpoints here to test — the
// surface is five reads and one admin-only write.
//
// POST /api/sas/update is deliberately NOT exercised even under
// --include-disruptive. Applying an update rebuilds the sasbench image and
// recreates the container, which drops both SAS listeners; every live radio
// misses a heartbeat and a Category B radio can lose its grant as a result.
// Same exclusion class as the old suite's /admin/reset and /admin/pki/root:
// a real, one-way operator decision, not something a suite does on a
// deployment with radios on it. Its refusal guards are covered by the pure
// `updateBlockReason()` in SASPage.tsx instead.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'sas';

export const CASES = [
  {
    name: 'read-only SASBench proxy endpoints respond',
    async run({ client }) {
      const endpoints = ['/api/sas/status', '/api/sas/cbsds', '/api/sas/grants', '/api/sas/spectrum'];
      const failures = [];
      for (const ep of endpoints) {
        const res = await client.get(ep);
        if (!res.ok) failures.push(`${ep} -> HTTP ${res.status}`);
      }
      if (failures.length) return fail(`${failures.length}/${endpoints.length} endpoint(s) failed`, { failures });
      return pass(`all ${endpoints.length} read endpoints responded`);
    },
  },

  {
    // The whole point of the proxy: these routes answer even when SASBench
    // is unreachable, so the SAS page can say "SASBench is not answering"
    // instead of rendering an error boundary. A 5xx here would mean the
    // dashboard card breaks whenever the SAS container is down.
    name: '/status degrades rather than erroring when SASBench is unreachable',
    async run({ client }) {
      const res = await client.get('/api/sas/status');
      assertOk(res, '/api/sas/status');
      const body = res.data ?? {};
      if (typeof body.reachable !== 'boolean') {
        return fail('/status does not report a boolean `reachable`, so the UI cannot tell down from empty', { body });
      }
      return pass(`reachable=${body.reachable}`, { reachable: body.reachable });
    },
  },

  {
    // Occupancy must be DERIVED, not SASBench's own authorizedMHz. That
    // field sums grant widths, so on GAA it exceeds the band itself —
    // measured live at 200 MHz of grants inside a 150 MHz band. If this ever
    // regresses to reporting the sum as occupancy, the page claims >100% of
    // a band is in use.
    name: 'band occupancy is the union of grants, never the sum of their widths',
    async run({ client }) {
      const res = await client.get('/api/sas/spectrum');
      assertOk(res, '/api/sas/spectrum');
      const d = res.data?.derived;
      if (!d?.occupancy) return skip('no derived occupancy (SASBench unreachable or no managed band)');
      const { occupiedMHz, bandwidthMHz, authorizedMHz, peakOverlap, largestGapMHz } = {
        ...d.occupancy, authorizedMHz: d.occupancy.authorizedMHz ?? d.occupancy.sumOfGrantWidthsMHz,
      };
      if (typeof occupiedMHz !== 'number' || typeof bandwidthMHz !== 'number') {
        return fail('occupancy is missing occupiedMHz/bandwidthMHz', { occupancy: d.occupancy });
      }
      if (occupiedMHz > bandwidthMHz + 0.001) {
        return fail(
          `occupied ${occupiedMHz} MHz exceeds the ${bandwidthMHz} MHz band — occupancy has regressed to summing grant widths`,
          { occupancy: d.occupancy },
        );
      }
      return pass(
        `${occupiedMHz}/${bandwidthMHz} MHz occupied, sum-of-widths ${authorizedMHz ?? 'n/a'}, `
        + `peak overlap ${peakOverlap ?? 'n/a'}, largest gap ${largestGapMHz ?? 'n/a'} MHz`,
        { occupancy: d.occupancy },
      );
    },
  },

  {
    // /version must distinguish "not a git checkout" from "up to date". A
    // SASBENCH_DIR with no git history reports managed:false, and the UI has
    // to show that as its own state — reporting it as current would tell the
    // operator their SAS is fine when the NMS cannot actually tell.
    name: '/version reports managed state without contacting the git remote',
    async run({ client }) {
      const res = await client.get('/api/sas/version');
      assertOk(res, '/api/sas/version');
      const v = res.data ?? {};
      if (typeof v.managed !== 'boolean') return fail('/version does not report a boolean `managed`', { body: v });
      if (!v.dir) return fail('/version does not report the checkout directory', { body: v });
      if (!v.managed) {
        if (!v.reason) return fail('managed:false with no `reason`, so the UI cannot explain it', { body: v });
        return pass(`unmanaged, reason given: ${v.reason}`, { dir: v.dir });
      }
      if (typeof v.behind !== 'number' && v.fetchError === undefined) {
        return fail('managed checkout reports neither `behind` nor a `fetchError`', { body: v });
      }
      return pass(
        `managed at ${v.localCommit ?? '?'} on ${v.branch ?? '?'}, behind=${v.behind ?? 'unknown'}`
        + (v.fetchError ? ` (fetch failed: ${v.fetchError})` : ''),
        { dir: v.dir, behind: v.behind, dirty: v.dirty, ahead: v.ahead },
      );
    },
  },

  {
    // A plain /version read must not hit the network: the SAS page polls
    // every 15s, so an unconditional fetch would be four git fetches a
    // minute against GitHub, forever. Only ?refresh=1 or an expired cache
    // may fetch.
    name: 'repeated /version reads do not advance fetchedAt',
    async run({ client }) {
      const a = await client.get('/api/sas/version');
      assertOk(a, '/api/sas/version (first)');
      if (!a.data?.managed) return skip('checkout is unmanaged, so there is no fetch cache to observe');
      const first = a.data.fetchedAt ?? null;
      const b = await client.get('/api/sas/version');
      assertOk(b, '/api/sas/version (second)');
      const second = b.data?.fetchedAt ?? null;
      assertEqual(second, first, 'fetchedAt across two plain reads');
      return pass(`fetchedAt stable at ${first ?? 'null'} across two reads`);
    },
  },

  {
    // The NMS must never be the thing radios talk to, and nginx must never
    // be in front of SASBench — it would hide every radio's source address,
    // which SASBench reads off the socket with no X-Forwarded-For handling.
    name: 'the NMS exposes no SAS-CBSD protocol endpoints',
    async run({ client }) {
      const protocolPaths = [
        '/api/sas/registration', '/api/sas/spectrumInquiry', '/api/sas/grant',
        '/api/sas/heartbeat', '/api/sas/relinquishment', '/api/sas/deregistration',
        '/sas/v1.2/registration',
      ];
      const reachable = [];
      for (const p of protocolPaths) {
        const res = await client.post(p, {});
        // 404/405 are both correct "this is not here"; anything that parses a
        // CBSD request body would mean the old module came back.
        if (res.status !== 404 && res.status !== 405) reachable.push(`${p} -> HTTP ${res.status}`);
      }
      if (reachable.length) {
        return fail('a SAS-CBSD protocol path answered on the NMS — radios must reach SASBench directly', { reachable });
      }
      return pass(`all ${protocolPaths.length} protocol paths correctly absent from the NMS`);
    },
  },
];
