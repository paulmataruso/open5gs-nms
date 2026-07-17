import * as fs from 'fs';
import * as path from 'path';

// ─── Radio backup helpers ─────────────────────────────────────────────────────
// Shared across every radio vendor controller (Baicells + Sercomm 4G in
// genieacs-controller.ts, Sercomm NR in sercomm-nr-controller.ts). Snapshots
// the device's full GenieACS parameter tree by deviceId — vendor-agnostic,
// since the NBI /devices?query={_id} lookup works the same for every OUI.
export function radioBackupDir(backupRoot: string, deviceId: string): string {
  const safe = deviceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(backupRoot, 'radio-backups', safe);
}

export async function saveRadioBackup(backupRoot: string, deviceId: string, data: Record<string, any>): Promise<string> {
  const dir      = radioBackupDir(backupRoot, deviceId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
  return filename;
}

export async function backupDeviceById(nbiUrl: string, backupRoot: string, deviceId: string): Promise<string> {
  const resp = await fetch(`${nbiUrl}/devices?query=${encodeURIComponent(JSON.stringify({ _id: deviceId }))}`);
  if (!resp.ok) throw new Error(`NBI returned ${resp.status}`);
  const devices = (await resp.json()) as Record<string, any>[];
  if (!devices || devices.length === 0) throw new Error(`Device not found: ${deviceId}`);
  return saveRadioBackup(backupRoot, deviceId, devices[0]);
}
