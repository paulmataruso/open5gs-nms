// Backup/Restore — backup-controller.ts, mounted at /api/backup, 19
// routes. This is the single highest-stakes write surface in the whole
// product: every /restore* route overwrites real, live production data or
// config from a backup, POST /restore-defaults resets to factory defaults,
// and — a real trap found reading this file — PUT /settings doesn't just
// save a preference, it immediately calls cleanupOldBackups() with
// whatever retention numbers were posted, which DELETES real backup files
// beyond the new limit as a side effect of what looks like a plain settings
// save. POST /cleanup does the same thing directly. None of these are
// exercised, nor is POST /full/upload (stages a file for a restore this
// suite never performs, so there's nothing gained by exercising upload in
// isolation).
//
// What IS exercised: the two backup-CREATION routes (purely additive — a
// new file, nothing existing is touched) and every genuinely read-only
// route.
import { assertOk, pass, fail, skip } from '../lib/test-case.mjs';

export const MODULE = 'backup';

export const CASES = [
  { name: 'All restore routes, /restore-defaults, PUT /settings, /cleanup, /full/upload (not exercised)', async run() { return skip('overwrites real production data/config, resets to factory defaults, or (for /settings and /cleanup specifically) deletes real backup files as a side effect — see this file\'s header comment'); } },

  {
    name: 'POST /mongo and POST /config — create real backups (additive, nothing existing is touched)',
    async run({ client }) {
      const beforeRes = await client.get('/api/backup/list');
      assertOk(beforeRes, 'GET /api/backup/list (before)');

      const mongoRes = await client.post('/api/backup/mongo', {});
      assertOk(mongoRes, 'POST /api/backup/mongo');
      if (!mongoRes.data?.success || !mongoRes.data?.backupName) return fail('mongo backup response missing success/backupName', mongoRes.data);

      const configRes = await client.post('/api/backup/config', {});
      assertOk(configRes, 'POST /api/backup/config');
      if (!configRes.data?.success || !configRes.data?.backupName) return fail('config backup response missing success/backupName', configRes.data);

      // Mongo backups are named per-DAY (confirmed live: "Open5Gs_DD-MM-YYYY"),
      // so a second call the same day legitimately overwrites the same
      // filename rather than growing the list — check presence, not count,
      // for the mongo side. Config backups carry a full timestamp, so the
      // count check is meaningful there.
      const afterRes = await client.get('/api/backup/list');
      if (!afterRes.data.mongoBackups.some(b => b.name === mongoRes.data.backupName)) {
        return fail(`mongo backup "${mongoRes.data.backupName}" not found in the list after creating it`);
      }
      if (afterRes.data.configBackups.length <= beforeRes.data.configBackups.length) return fail('config backup count did not increase');

      return pass(`created "${mongoRes.data.backupName}" and "${configRes.data.backupName}"`, { mongoBackup: mongoRes.data.backupName, configBackup: configRes.data.backupName });
    },
  },
  {
    name: 'GET /list, /settings, /last-config, /restore-reapply/status, /full/restore/status (read-only)',
    async run({ client }) {
      const listRes = await client.get('/api/backup/list');
      assertOk(listRes, 'GET /api/backup/list');
      const settingsRes = await client.get('/api/backup/settings');
      assertOk(settingsRes, 'GET /api/backup/settings');
      const lastConfigRes = await client.get('/api/backup/last-config');
      assertOk(lastConfigRes, 'GET /api/backup/last-config');
      const reapplyRes = await client.get('/api/backup/restore-reapply/status');
      assertOk(reapplyRes, 'GET /api/backup/restore-reapply/status');
      const fullStatusRes = await client.get('/api/backup/full/restore/status');
      assertOk(fullStatusRes, 'GET /api/backup/full/restore/status');
      return pass(`${listRes.data.mongoBackups.length} mongo + ${listRes.data.configBackups.length} config backup(s) on record`);
    },
  },
  {
    name: 'POST /diff (read-only comparison against a real existing backup)',
    async run({ client }) {
      const listRes = await client.get('/api/backup/list');
      const backup = listRes.data?.configBackups?.[0];
      if (!backup) return skip('no config backups available to diff against');

      const missingRes = await client.post('/api/backup/diff', {});
      if (missingRes.status !== 400) return fail(`expected HTTP 400 for a missing backupName, got ${missingRes.status}`);

      const res = await client.post('/api/backup/diff', { backupName: backup.name });
      assertOk(res, 'POST /api/backup/diff');
      return pass(`diffed against "${backup.name}"; missing-backupName case correctly rejected (400)`);
    },
  },
  {
    name: 'GET /full/download (packages current state into a downloadable archive — read-only, nothing is modified)',
    async run({ client }) {
      const res = await client.get('/api/backup/full/download');
      if (res.status !== 200) return fail(`expected HTTP 200, got ${res.status}`, res.data);
      return pass('full backup archive generated and downloaded successfully');
    },
  },
];
