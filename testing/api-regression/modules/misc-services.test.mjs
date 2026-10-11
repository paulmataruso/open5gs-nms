// Smaller host-utility modules, grouped into one file: chrony (NTP),
// snmp (snmpd monitoring agent), speedtest (self-hosted librespeed
// container), swu-emulator (VoWiFi SWu test client), and dns-migration
// (the DNS/FQDN Migration Wizard).
//
// chrony's PUT /config takes a structured {servers, allowNets, ...} object
// the GET side doesn't expose in that shape (only raw config text) — not
// exercised, since reconstructing it accurately risks a real, host-wide
// time-sync misconfiguration for no real coverage gain over the read-only
// checks already here. snmp and speedtest are both lower-risk, non-core-NF,
// non-RF services (a monitoring agent and a self-hosted speedtest *server*
// container — starting it does not itself run a bandwidth test against
// anything) — both get a real stop/start cycle, speedtest's restoring its
// own exact prior settings. dns-migration's /apply and /rollback are NOT
// exercised at all: per CLAUDE.md's own extensive documentation, a
// misapplied DNS phase can crash-loop every core-17 NF simultaneously, and
// this instance is already fully migrated — there's no safe experiment to
// run here, only a real risk to an already-correct production state.
import { assertOk, assertEqual, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'misc-services';

async function waitForActive(client, statusPath, timeoutMs = 20000, settleMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await client.get(statusPath);
    if (s.data?.active === true || s.data?.running === true) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  await new Promise(r => setTimeout(r, settleMs));
}

export const CASES = [
  { name: 'chrony PUT /config (not exercised)', async run() { return skip('structured config the read side doesn\'t expose in the same shape; host-wide time-sync risk for no real coverage gain — see this file\'s header comment'); } },
  { name: 'dns-migration POST /apply/:phase, /rollback/:backupId (not exercised)', async run() { return skip('a misapplied phase can crash-loop every core-17 NF simultaneously, and this instance is already fully migrated — see this file\'s header comment'); } },

  {
    name: 'chrony: GET /status, /config, /clients (read-only)',
    async run({ client }) {
      const statusRes = await client.get('/api/chrony/status');
      assertOk(statusRes, 'GET /api/chrony/status');
      if (!statusRes.data?.installed) return skip('chrony not installed');
      const cfgRes = await client.get('/api/chrony/config');
      assertOk(cfgRes, 'GET /api/chrony/config');
      const clientsRes = await client.get('/api/chrony/clients');
      assertOk(clientsRes, 'GET /api/chrony/clients');
      return pass(`active=${statusRes.data.active}`);
    },
  },
  {
    name: 'snmp: GET /status, /stats, /mib + stop/start cycle',
    async run({ client }) {
      const statusRes = await client.get('/api/snmp/status');
      assertOk(statusRes, 'GET /api/snmp/status');
      if (!statusRes.data?.installed) return skip('snmp not installed');
      const statsRes = await client.get('/api/snmp/stats');
      assertOk(statsRes, 'GET /api/snmp/stats');
      const mibRes = await client.get('/api/snmp/mib');
      if (mibRes.status !== 200) return fail(`expected HTTP 200 for the MIB download, got ${mibRes.status}`);

      const invalidActionRes = await client.post('/api/snmp/not-a-real-action', {});
      if (invalidActionRes.status !== 400) return fail(`expected HTTP 400 for an invalid action, got ${invalidActionRes.status}`);

      if (!statusRes.data?.active) return pass('snmpd not currently active — skipping the cycle, read-only checks passed');

      const stopRes = await client.post('/api/snmp/stop', {});
      assertOk(stopRes, 'POST /api/snmp/stop');
      await waitForActive(client, '/api/snmp/status', 10000, 1000);
      const startRes = await client.post('/api/snmp/start', {});
      assertOk(startRes, 'POST /api/snmp/start');
      await waitForActive(client, '/api/snmp/status');
      const afterRes = await client.get('/api/snmp/status');
      if (!afterRes.data?.active) return fail('snmpd did not come back active after stop -> start');

      return pass('stop -> start cycle verified; invalid action correctly rejected');
    },
  },
  {
    name: 'speedtest: GET /status, /available-ips + stop/start cycle (restores its own exact prior settings)',
    async run({ client }) {
      const statusRes = await client.get('/api/speedtest/status');
      assertOk(statusRes, 'GET /api/speedtest/status');
      const ipsRes = await client.get('/api/speedtest/available-ips');
      assertOk(ipsRes, 'GET /api/speedtest/available-ips');
      if (!Array.isArray(ipsRes.data?.ips)) return fail('response missing "ips" array', ipsRes.data);

      if (!statusRes.data?.running) return pass(`${ipsRes.data.ips.length} candidate IP(s); speedtest not currently running — skipping the cycle`);
      const originalSettings = statusRes.data.settings;

      const stopRes = await client.post('/api/speedtest/stop', {});
      assertOk(stopRes, 'POST /api/speedtest/stop');
      const afterStop = await client.get('/api/speedtest/status');
      if (afterStop.data?.running) return fail('still reports running immediately after /stop');

      const startRes = await client.post('/api/speedtest/start', originalSettings);
      assertOk(startRes, 'POST /api/speedtest/start (restore original settings)');
      const afterStart = await client.get('/api/speedtest/status');
      if (!afterStart.data?.running) return fail('did not come back running after /start');
      assertEqual(afterStart.data.settings?.bindIp, originalSettings.bindIp, 'bindIp after restore');
      assertEqual(afterStart.data.settings?.httpPort, originalSettings.httpPort, 'httpPort after restore');

      return pass(`${ipsRes.data.ips.length} candidate IP(s); stop -> start cycle verified, original settings (${originalSettings.bindIp}:${originalSettings.httpPort}) restored exactly`);
    },
  },
  {
    name: 'swu-emulator: GET /status, /log (read-only)',
    async run({ client }) {
      const res = await client.get('/api/swu-emulator/status');
      assertOk(res, 'GET /api/swu-emulator/status');
      if (typeof res.data?.installed !== 'boolean') return fail('response missing boolean "installed"', res.data);
      const logRes = await client.get('/api/swu-emulator/log');
      assertOk(logRes, 'GET /api/swu-emulator/log');
      return pass(`installed=${res.data.installed} running=${res.data.running}`);
    },
  },
  {
    name: 'dns-migration: GET /status, /plan, /backups + POST /backup',
    async run({ client }) {
      const statusRes = await client.get('/api/dns-migration/status');
      assertOk(statusRes, 'GET /api/dns-migration/status');
      const planRes = await client.get('/api/dns-migration/plan');
      assertOk(planRes, 'GET /api/dns-migration/plan');
      const backupsBefore = await client.get('/api/dns-migration/backups');
      assertOk(backupsBefore, 'GET /api/dns-migration/backups');

      const backupRes = await client.post('/api/dns-migration/backup', {});
      assertOk(backupRes, 'POST /api/dns-migration/backup');
      const backupsAfter = await client.get('/api/dns-migration/backups');
      if (backupsAfter.data.backups.length <= backupsBefore.data.backups.length) {
        return fail('backup count did not increase after POST /backup');
      }

      return pass(`migrated=${statusRes.data.migrated}; backup created (${backupsBefore.data.backups.length} -> ${backupsAfter.data.backups.length})`);
    },
  },
];
