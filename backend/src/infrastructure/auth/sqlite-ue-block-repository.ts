import type { Database } from 'better-sqlite3';

interface UeBlockRow {
  imsi: string;
  last_ip: string | null;
  blocked_by: string;
  blocked_at: number;
}

export interface UeBlockInfo {
  imsi: string;
  lastIp: string | null;
  blockedBy: string;
  blockedAt: number;
}

export class SqliteUeBlockRepository {
  constructor(private readonly db: Database) {}

  getAll(): UeBlockInfo[] {
    const rows = this.db
      .prepare('SELECT imsi, last_ip, blocked_by, blocked_at FROM ue_blocks ORDER BY imsi')
      .all() as UeBlockRow[];
    return rows.map(r => ({ imsi: r.imsi, lastIp: r.last_ip, blockedBy: r.blocked_by, blockedAt: r.blocked_at }));
  }

  add(imsi: string, blockedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO ue_blocks (imsi, last_ip, blocked_by, blocked_at)
         VALUES (?, NULL, ?, ?)
         ON CONFLICT(imsi) DO UPDATE SET blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at`,
      )
      .run(imsi, blockedBy, Date.now());
  }

  remove(imsi: string): void {
    this.db.prepare('DELETE FROM ue_blocks WHERE imsi = ?').run(imsi);
  }

  setLastIp(imsi: string, ip: string): void {
    this.db.prepare('UPDATE ue_blocks SET last_ip = ? WHERE imsi = ?').run(ip, imsi);
  }
}
