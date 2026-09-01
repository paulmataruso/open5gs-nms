import type { Database } from 'better-sqlite3';

interface RadioTagRow {
  ip: string;
  nickname: string;
  band: string | null;
  updated_at: number;
}

export class SqliteRadioTagRepository {
  constructor(private readonly db: Database) {}

  // Nickname-only — unchanged shape, kept for every existing consumer
  // (BaicellsAcsTab.tsx, FemtoConfigTab.tsx, SercommNRTab.tsx, MajorEventsView.tsx).
  getAll(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT ip, nickname FROM radio_tags ORDER BY ip')
      .all() as RadioTagRow[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.nickname) result[row.ip] = row.nickname;
    }
    return result;
  }

  // Nickname + band together — used by the RAN page's per-radio band tagging/filter.
  getAllFull(): Record<string, { nickname: string; band: string | null }> {
    const rows = this.db
      .prepare('SELECT ip, nickname, band FROM radio_tags ORDER BY ip')
      .all() as RadioTagRow[];
    const result: Record<string, { nickname: string; band: string | null }> = {};
    for (const row of rows) {
      result[row.ip] = { nickname: row.nickname, band: row.band };
    }
    return result;
  }

  // Sets nickname without touching an existing band value. Deletes the row
  // entirely only once both nickname and band are empty — a radio tagged
  // with a band alone shouldn't disappear just because its nickname was cleared.
  upsertNickname(ip: string, nickname: string): void {
    const trimmed = nickname.trim();
    const existing = this.db.prepare('SELECT band FROM radio_tags WHERE ip = ?').get(ip) as { band: string | null } | undefined;
    if (!trimmed && !existing?.band) {
      this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO radio_tags (ip, nickname, band, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at`,
      )
      .run(ip, trimmed, existing?.band ?? null, Date.now());
  }

  // Same partial-update contract as upsertNickname, mirrored for band.
  upsertBand(ip: string, band: string | null): void {
    const normalized = band && band.trim() ? band.trim() : null;
    const existing = this.db.prepare('SELECT nickname FROM radio_tags WHERE ip = ?').get(ip) as { nickname: string } | undefined;
    if (!normalized && !existing?.nickname) {
      this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO radio_tags (ip, nickname, band, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET band = excluded.band, updated_at = excluded.updated_at`,
      )
      .run(ip, existing?.nickname ?? '', normalized, Date.now());
  }

  delete(ip: string): void {
    this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
  }
}
