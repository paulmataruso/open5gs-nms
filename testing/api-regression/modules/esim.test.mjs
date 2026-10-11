// eSIM generation (Simlessly API) — esim-controller.ts, 1 route.
//
// POST /api/esim/generate is NOT exercised, under any flag, on any
// instance — this is different from this suite's other "not exercised"
// routes (which have no *safe revert*). This one has no safe way to even
// PROBE whether calling it is safe in the first place: esim-generator.ts's
// generateAc() checks SIMLESSLY_ACCESS_KEY/SIMLESSLY_SECRET_KEY as its very
// first line and throws before touching the request body if either is
// unset — so on an instance with no real Simlessly account configured,
// calling this is harmless. But on an instance that DOES have real
// credentials configured, this creates a real, likely-billable eSIM
// activation code on that account's real Simlessly balance — a genuine
// third-party financial side effect, not just a live-system risk this
// suite could revert. Because this suite is designed to run unmodified
// against ANY open5gs-nms instance, and there's no way to distinguish
// "safe to call" from "will cost real money" without just calling it, the
// only safe answer is to never call it at all, from outside, ever.
import { skip } from '../lib/test-case.mjs';

export const MODULE = 'esim';

export const CASES = [
  {
    name: 'POST /generate (not exercised)',
    async run() {
      return skip('real, likely-billable external Simlessly API call with no way to safely detect from outside whether a given instance has live credentials configured — see this file\'s header comment');
    },
  },
];
