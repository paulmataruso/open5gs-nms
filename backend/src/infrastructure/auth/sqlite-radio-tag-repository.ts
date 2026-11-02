import type { Database } from 'better-sqlite3';

interface RadioTagRow {
  ip: string;
  nickname: string;
  band: string | null;
  group_name: string | null;
  updated_at: number;
}

export interface RadioTagFull {
  nickname: string;
  band: string | null;
  group: string | null;
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

  // Nickname + band + group together — used by the RAN page's per-radio band
  // tagging/filter and its collapsible radio groups. `group_name` is exposed as
  // `group` so callers never have to know about the SQL-keyword workaround.
  getAllFull(): Record<string, RadioTagFull> {
    const rows = this.db
      .prepare('SELECT ip, nickname, band, group_name FROM radio_tags ORDER BY ip')
      .all() as RadioTagRow[];
    const result: Record<string, RadioTagFull> = {};
    for (const row of rows) {
      result[row.ip] = { nickname: row.nickname, band: row.band, group: row.group_name ?? null };
    }
    return result;
  }

  // Sets nickname without touching an existing band value. Deletes the row
  // entirely only once both nickname and band are empty — a radio tagged
  // with a band alone shouldn't disappear just because its nickname was cleared.
  upsertNickname(ip: string, nickname: string): void {
    const trimmed = nickname.trim();
    const existing = this.db
      .prepare('SELECT band, group_name FROM radio_tags WHERE ip = ?')
      .get(ip) as { band: string | null; group_name: string | null } | undefined;
    // Checks EVERY other field, not just band. Clearing a nickname must not
    // delete a row that still carries a band or a group assignment.
    if (!trimmed && !existing?.band && !existing?.group_name) {
      this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO radio_tags (ip, nickname, band, group_name, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at`,
      )
      .run(ip, trimmed, existing?.band ?? null, existing?.group_name ?? null, Date.now());
  }

  // Same partial-update contract as upsertNickname, mirrored for band.
  upsertBand(ip: string, band: string | null): void {
    const normalized = band && band.trim() ? band.trim() : null;
    const existing = this.db
      .prepare('SELECT nickname, group_name FROM radio_tags WHERE ip = ?')
      .get(ip) as { nickname: string; group_name: string | null } | undefined;
    // Same every-other-field rule as upsertNickname above.
    if (!normalized && !existing?.nickname && !existing?.group_name) {
      this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO radio_tags (ip, nickname, band, group_name, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET band = excluded.band, updated_at = excluded.updated_at`,
      )
      .run(ip, existing?.nickname ?? '', normalized, existing?.group_name ?? null, Date.now());
  }

  // Same partial-update contract as upsertNickname/upsertBand, mirrored for the
  // operator-named group.
  upsertGroup(ip: string, group: string | null): void {
    const normalized = group && group.trim() ? group.trim() : null;
    const existing = this.db
      .prepare('SELECT nickname, band FROM radio_tags WHERE ip = ?')
      .get(ip) as { nickname: string; band: string | null } | undefined;
    if (!normalized && !existing?.nickname && !existing?.band) {
      this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO radio_tags (ip, nickname, band, group_name, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET group_name = excluded.group_name, updated_at = excluded.updated_at`,
      )
      .run(ip, existing?.nickname ?? '', existing?.band ?? null, normalized, Date.now());
  }

  /** Distinct group names currently in use, for the assignment dropdown. */
  listGroups(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT group_name FROM radio_tags WHERE group_name IS NOT NULL AND group_name <> '' ORDER BY group_name COLLATE NOCASE")
      .all() as { group_name: string }[];
    return rows.map(r => r.group_name);
  }

  delete(ip: string): void {
    this.db.prepare('DELETE FROM radio_tags WHERE ip = ?').run(ip);
  }
}
