// GenieACS radio provisioning — genieacs-controller.ts, mounted at
// /api/genieacs, 19 routes. This module manages REAL, physically-attached
// CBRS radios over TR-069 — most of its routes actively command real
// hardware (reboot the radio, change its RF transmit parameters, change
// which MME it registers to, or wake it with a connection_request to run a
// provisioning script) and are NOT exercised here at all, consistent with
// CLAUDE.md's standing instruction never to touch a real radio without
// explicit confirmation:
//   - POST /reboot/:deviceId, /reboot-all — reboots a real radio outright.
//   - POST /rf/:deviceId, /rf-all, /rf-sercomm/:deviceId, /rf-sercomm-all —
//     changes a real radio's actual RF transmit parameters (power,
//     frequency/EARFCN, bandwidth) — real spectrum impact, SAS-grant-
//     relevant.
//   - POST /mme-pool/:deviceId, /mme-pool-config/:deviceId — repoints a
//     real radio's core-network connection; a mistake here can disconnect
//     it from the network entirely.
//   - POST /refresh/:deviceId, /refresh-sercomm/:deviceId — issues a real
//     TR-069 connection_request that wakes the device NOW and runs a
//     `provisions` task (a GenieACS provisioning *script*, not just a
//     passive parameter read) — not safe to assume side-effect-free without
//     reading that script's own logic against this specific firmware.
//   - POST /execute-tasks — fires an arbitrary caller-supplied TR-069 task
//     array at a real device; this is literally the "apply real config to a
//     real radio" primitive every one of the above routes is built on top
//     of.
//
// What IS exercised: every route that only reads GenieACS's own already-
// collected device state, or performs a pure local computation with no
// network call to the device at all (/preview*, confirmed by reading the
// source — it just builds a task object in memory and returns it).
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'genieacs';

export const CASES = [
  { name: 'POST /reboot/:deviceId, /reboot-all (not exercised)', async run() { return skip('reboots a real, physically-attached radio outright — see this file\'s header comment'); } },
  { name: 'POST /rf/:deviceId, /rf-all, /rf-sercomm/:deviceId, /rf-sercomm-all (not exercised)', async run() { return skip('changes a real radio\'s actual RF transmit parameters — see this file\'s header comment'); } },
  { name: 'POST /mme-pool/:deviceId, /mme-pool-config/:deviceId (not exercised)', async run() { return skip('repoints a real radio\'s core-network connection — see this file\'s header comment'); } },
  { name: 'POST /refresh/:deviceId, /refresh-sercomm/:deviceId (not exercised)', async run() { return skip('wakes a real device and runs a GenieACS provisioning script against it, not just a passive read — see this file\'s header comment'); } },
  { name: 'POST /execute-tasks (not exercised)', async run() { return skip('fires an arbitrary caller-supplied TR-069 task array at a real device — see this file\'s header comment'); } },

  {
    name: 'GET /devices and /devices/sercomm',
    async run({ client }) {
      const res = await client.get('/api/genieacs/devices');
      assertOk(res, 'GET /api/genieacs/devices');
      if (!Array.isArray(res.data?.devices)) return fail('response missing "devices" array', res.data);
      const sercommRes = await client.get('/api/genieacs/devices/sercomm');
      assertOk(sercommRes, 'GET /api/genieacs/devices/sercomm');
      if (!Array.isArray(sercommRes.data?.devices)) return fail('sercomm response missing "devices" array', sercommRes.data);
      return pass(`${res.data.devices.length} Baicells device(s), ${sercommRes.data.devices.length} Sercomm device(s)`);
    },
  },
  {
    name: 'GET /tasks/:deviceId for a real existing device',
    async run({ client }) {
      const devicesRes = await client.get('/api/genieacs/devices');
      const device = devicesRes.data.devices[0];
      if (!device) return skip('no GenieACS devices registered on this instance');
      const res = await client.get(`/api/genieacs/tasks/${encodeURIComponent(device.id)}`);
      assertOk(res, 'GET /api/genieacs/tasks/:deviceId');
      return pass(`tasks read successfully for device ${device.id}`);
    },
  },
  {
    // Pure in-memory computation — confirmed by reading the source, this
    // never contacts the device. Passes the device's own CURRENT values
    // back to itself, so even in principle there's nothing to revert.
    name: 'POST /preview/:deviceId (Baicells) — pure computation, never contacts the device',
    async run({ client }) {
      const devicesRes = await client.get('/api/genieacs/devices');
      const device = devicesRes.data.devices[0];
      if (!device) return skip('no Baicells devices registered on this instance');
      if (!device.mcc || !device.mmeIp) return skip('device is missing required fields to build a preview payload');

      const res = await client.post(`/api/genieacs/preview/${encodeURIComponent(device.id)}`, {
        mcc: device.mcc, mnc: device.mnc, tac: device.tac, mmeIp: device.mmeIp,
        bandwidthMhz: device.bandwidthMhz, earfcn: device.earfcn ?? 55240,
        cellId: device.cellId ?? 1, pci: device.pci ?? 1, band: device.band ?? 48, txPower: device.txPower ?? 20,
      });
      assertOk(res, 'POST /api/genieacs/preview/:deviceId');
      if (!Array.isArray(res.data?.tasks)) return fail('response missing "tasks" array', res.data);

      const missingRes = await client.post(`/api/genieacs/preview/${encodeURIComponent(device.id)}`, { mcc: device.mcc });
      if (missingRes.status !== 400) return fail(`expected HTTP 400 for missing required fields, got ${missingRes.status}`);

      return pass(`computed ${res.data.tasks.length} task(s) with zero device contact; missing-field case correctly rejected`);
    },
  },
  {
    // Real bug found and fixed while building this suite: buildSercommTasks()
    // unconditionally called input.freqBand.split(...) / input.txPower.split(...)
    // with no caller-side guard, unlike its Baicells sibling above — a request
    // missing either field crashed with an unhandled TypeError (generic 500)
    // instead of a clean validation error. Fixed by adding the same required-
    // fields check the Baicells route already has. Verified both paths: a
    // complete payload now succeeds, and an incomplete one gets a clean 400
    // instead of a 500.
    name: 'POST /preview-sercomm/:deviceId — pure computation, never contacts the device',
    async run({ client }) {
      const devicesRes = await client.get('/api/genieacs/devices/sercomm');
      const device = devicesRes.data.devices[0];
      if (!device) return skip('no Sercomm devices registered on this instance');

      const missingRes = await client.post(`/api/genieacs/preview-sercomm/${encodeURIComponent(device.id)}`, {
        sasUserId: 'api-regression-test', sasEnable: false,
      });
      if (missingRes.status !== 400) return fail(`expected HTTP 400 for an incomplete payload, got ${missingRes.status}`, missingRes.data);

      const res = await client.post(`/api/genieacs/preview-sercomm/${encodeURIComponent(device.id)}`, {
        mcc: '001', mnc: '01', tac: '1', mmeIp: '10.0.1.175', mmeCfgIdList: '1',
        earfcn: '55240', earfcn2: '55240', pci: '1', cellIdentity: '1', cellIdentity2: '2',
        txPower: '20', bandwidth: '20', freqBand: '48', syncSource: '0', carrierNumber: '1',
        caEnable: false, contiguousCC: false, sasEnable: false, sasMethod: '0',
        sasManufacturerPrefix: false, sasInstallMethod: '0', sasCpiEnable: false,
        sasCategory: 'A', sasChannelType: 'GAA', sasLocation: '', sasLocationSource: '0',
        sasHeightType: 'AGL', sasUserId: 'api-regression-test', sasIcgGroupId: '',
        sasPeerCertVerify: false, sasGrantMethod: 'FREQ_GRANT_BY_CARRIER',
        latitude: '0', longitude: '0', enable256QAM: false,
      });
      assertOk(res, 'POST /api/genieacs/preview-sercomm/:deviceId');
      if (!Array.isArray(res.data?.tasks)) return fail('response missing "tasks" array', res.data);
      return pass(`computed ${res.data.tasks.length} task(s) with zero device contact; incomplete payload correctly rejected (400, previously crashed with 500)`);
    },
  },
  {
    // Passive — confirmed by reading backupDeviceById(): a plain GET against
    // GenieACS's own already-collected device DB, no live RPC to the
    // physical radio. Creates a real backup file that's left in place
    // afterward (a genuine, accurate backup, not test pollution — there's
    // no delete-backup endpoint to revert through anyway).
    name: 'POST /backup/:deviceId + GET /backups/:deviceId (passive — reads GenieACS\'s own cached device state, not the live device)',
    async run({ client }) {
      const devicesRes = await client.get('/api/genieacs/devices');
      const device = devicesRes.data.devices[0];
      if (!device) return skip('no GenieACS devices registered on this instance');

      const backupRes = await client.post(`/api/genieacs/backup/${encodeURIComponent(device.id)}`, {});
      assertOk(backupRes, 'POST /api/genieacs/backup/:deviceId');
      if (!backupRes.data?.filename) return fail('backup response missing "filename"', backupRes.data);

      const listRes = await client.get(`/api/genieacs/backups/${encodeURIComponent(device.id)}`);
      assertOk(listRes, 'GET /api/genieacs/backups/:deviceId');
      if (!listRes.data.backups.some(b => b.filename === backupRes.data.filename)) {
        return fail('newly-created backup not found in subsequent list');
      }

      const contentRes = await client.get(`/api/genieacs/backups/${encodeURIComponent(device.id)}/${backupRes.data.filename}`);
      if (contentRes.status !== 200) return fail(`expected HTTP 200 reading the backup file content, got ${contentRes.status}`);

      const badFilenameRes = await client.get(`/api/genieacs/backups/${encodeURIComponent(device.id)}/../../etc/passwd`);
      if (badFilenameRes.status !== 400 && badFilenameRes.status !== 404) {
        return fail(`expected a path-traversal filename to be rejected (400/404), got ${badFilenameRes.status}`);
      }

      return pass(`backup "${backupRes.data.filename}" created and read back successfully; path traversal correctly rejected`);
    },
  },
];
