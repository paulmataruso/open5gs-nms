// Sercomm NR provisioning — sercomm-nr-controller.ts, mounted at
// /api/femto/nr, 7 routes. Every mutating route here commands a real,
// physically-attached 5G NR radio directly (configure/unlock/lock/reboot/
// refresh/sas-restart) — none are exercised, same standing reasoning as
// genieacs.test.mjs's header comment. Only the read-only device list is
// covered.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'sercomm-nr';

export const CASES = [
  { name: 'All mutating routes (not exercised)', async run() { return skip('every one commands a real, physically-attached 5G NR radio directly (configure/unlock/lock/reboot/refresh/sas-restart) — see this file\'s header comment'); } },

  {
    name: 'GET /devices (read-only)',
    async run({ client }) {
      const res = await client.get('/api/femto/nr/devices');
      assertOk(res, 'GET /api/femto/nr/devices');
      if (!Array.isArray(res.data?.devices)) return fail('response missing "devices" array', res.data);
      return pass(`${res.data.devices.length} device(s)`);
    },
  },
];
