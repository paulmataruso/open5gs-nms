// Auto-Configuration Wizard — auto-config-controller.ts, mounted at
// /api/auto-config, 2 routes. POST /apply runs the exact same
// AutoConfigUseCase.execute() the IP Plan Tool's own /apply uses under the
// hood (confirmed by reading both controllers) — the same bulk, multi-
// module, potentially-core-17-NF-restarting live-apply mechanism, so it is
// NOT exercised here, same reasoning as ip-plan.test.mjs's own exclusion of
// its /apply. POST /preview is a pure dry-run (computes a diff, applies
// nothing) and is exercised directly.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'auto-config';

export const CASES = [
  { name: 'POST /apply (not exercised)', async run() { return skip('the same bulk, potentially-core-17-NF-restarting live-apply mechanism as the IP Plan Tool\'s own /apply — see this file\'s header comment'); } },

  {
    name: 'POST /preview — pure dry-run, applies nothing',
    async run({ client }) {
      const invalidRes = await client.post('/api/auto-config/preview', {});
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for an empty/invalid input, got ${invalidRes.status}`);
      return pass('invalid/empty input correctly rejected (400) — confirms this route validates before computing a preview');
    },
  },
];
