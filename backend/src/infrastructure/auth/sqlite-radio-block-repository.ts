import type { Database } from 'better-sqlite3';

interface RadioBlockRow {
  ip: string;
  blocked_by: string;
  blocked_at: number;
}

export interface RadioBlockInfo {
  ip: string;
  blockedBy: string;
  blockedAt: number;
}

export class SqliteRadioBlockRepository {
  constructor(private readonly db: Database) {}

  getAll(): RadioBlockInfo[] {
    const rows = this.db
      .prepare('SELECT ip, blocked_by, blocked_at FROM radio_blocks ORDER BY ip')
      .all() as RadioBlockRow[];
    return rows.map(r => ({ ip: r.ip, blockedBy: r.blocked_by, blockedAt: r.blocked_at }));
  }

  add(ip: string, blockedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO radio_blocks (ip, blocked_by, blocked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at`,
      )
      .run(ip, blockedBy, Date.now());
  }

  remove(ip: string): void {
    this.db.prepare('DELETE FROM radio_blocks WHERE ip = ?').run(ip);
  }
}
