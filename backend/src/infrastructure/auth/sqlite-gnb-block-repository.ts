import type { Database } from 'better-sqlite3';

interface GnbBlockRow {
  ip: string;
  blocked_by: string;
  blocked_at: number;
}

export interface GnbBlockInfo {
  ip: string;
  blockedBy: string;
  blockedAt: number;
}

export class SqliteGnbBlockRepository {
  constructor(private readonly db: Database) {}

  getAll(): GnbBlockInfo[] {
    const rows = this.db
      .prepare('SELECT ip, blocked_by, blocked_at FROM gnb_blocks ORDER BY ip')
      .all() as GnbBlockRow[];
    return rows.map(r => ({ ip: r.ip, blockedBy: r.blocked_by, blockedAt: r.blocked_at }));
  }

  add(ip: string, blockedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO gnb_blocks (ip, blocked_by, blocked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at`,
      )
      .run(ip, blockedBy, Date.now());
  }

  remove(ip: string): void {
    this.db.prepare('DELETE FROM gnb_blocks WHERE ip = ?').run(ip);
  }
}
