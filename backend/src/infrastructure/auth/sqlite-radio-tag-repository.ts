import type { Database } from 'better-sqlite3';

interface RadioTagRow {
  ip: string;
  nickname: string;
  updated_at: number;
}

export class SqliteRadioTagRepository {
  constructor(private readonly db: Database) {}

  getAll(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT ip, nickname FROM radio_tags ORDER BY ip')
      .all() as RadioTagRow[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.ip] = row.nickname;
    }
    return result;
  }

  upsert(ip: string, nickname: string): void {
    this.db
      .prepare(
        `INSERT INTO radio_tags (ip, nickname, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at`,
      )
      .run(ip, nickname.trim(), Date.now());
  }

  delete(ip: string): void {
    this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
  }
}
