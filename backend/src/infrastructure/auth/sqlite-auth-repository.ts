import BetterSqlite3, { type Database } from 'better-sqlite3';
import { Lucia, type Adapter, type DatabaseSession, type DatabaseUser } from 'lucia';
import type { Logger } from 'pino';
import type { IAuthRepository } from '../../domain/interfaces/auth-repository';
import type { User } from '../../domain/entities/user';

// ─────────────────────────────────────────────────────────────
// Row types matching our SQLite schema
// ─────────────────────────────────────────────────────────────

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: number;
  last_login_at: number | null;
}

interface SessionRow {
  id: string;
  expires_at: number;
  user_id: string;
}

// ─────────────────────────────────────────────────────────────
// Lucia Adapter — better-sqlite3 implementation
// ─────────────────────────────────────────────────────────────

class BetterSqlite3Adapter implements Adapter {
  constructor(private db: Database) {}

  async getSessionAndUser(
    sessionId: string,
  ): Promise<[DatabaseSession | null, DatabaseUser | null]> {
    const row = this.db
      .prepare(
        `SELECT s.id as session_id, s.expires_at, s.user_id,
                u.id as uid, u.username, u.role, u.created_at, u.last_login_at
         FROM session s
         JOIN user u ON s.user_id = u.id
         WHERE s.id = ?`,
      )
      .get(sessionId) as any;

    if (!row) return [null, null];

    const session: DatabaseSession = {
      id: row.session_id,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at),
      attributes: {},
    };

    const user: DatabaseUser = {
      id: row.uid,
      attributes: {
        username: row.username,
        role: row.role,
        created_at: row.created_at,
        last_login_at: row.last_login_at,
      },
    };

    return [session, user];
  }

  async getUserSessions(userId: string): Promise<DatabaseSession[]> {
    const rows = this.db
      .prepare('SELECT * FROM session WHERE user_id = ?')
      .all(userId) as SessionRow[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      expiresAt: new Date(r.expires_at),
      attributes: {},
    }));
  }

  async setSession(session: DatabaseSession): Promise<void> {
    this.db
      .prepare('INSERT INTO session (id, expires_at, user_id) VALUES (?, ?, ?)')
      .run(session.id, session.expiresAt.getTime(), session.userId);
  }

  async updateSessionExpiration(sessionId: string, expiresAt: Date): Promise<void> {
    this.db
      .prepare('UPDATE session SET expires_at = ? WHERE id = ?')
      .run(expiresAt.getTime(), sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM session WHERE id = ?').run(sessionId);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM session WHERE user_id = ?').run(userId);
  }

  async deleteExpiredSessions(): Promise<void> {
    this.db.prepare('DELETE FROM session WHERE expires_at < ?').run(Date.now());
  }
}

// ─────────────────────────────────────────────────────────────
// Auth Repository
// ─────────────────────────────────────────────────────────────

export class SqliteAuthRepository implements IAuthRepository {
  private db: Database;

  constructor(dbPath: string, private logger: Logger) {
    this.db = new BetterSqlite3(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user (
        id TEXT NOT NULL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS session (
        id TEXT NOT NULL PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id);
      CREATE INDEX IF NOT EXISTS idx_session_expires_at ON session(expires_at);
    `);
    this.logger.info('Auth database schema initialised');
  }

  async findUserByUsername(username: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT * FROM user WHERE username = ?')
      .get(username) as UserRow | undefined;
    return row ? this.rowToUser(row) : null;
  }

  async findUserById(id: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT * FROM user WHERE id = ?')
      .get(id) as UserRow | undefined;
    return row ? this.rowToUser(row) : null;
  }

  async createUser(id: string, username: string, passwordHash: string): Promise<User> {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO user (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, username, passwordHash, 'admin', now);

    return {
      id,
      username,
      passwordHash,
      role: 'admin',
      createdAt: new Date(now),
      lastLoginAt: null,
    };
  }

  async updateLastLogin(userId: string): Promise<void> {
    this.db
      .prepare('UPDATE user SET last_login_at = ? WHERE id = ?')
      .run(Date.now(), userId);
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    this.db
      .prepare('UPDATE user SET password_hash = ? WHERE id = ?')
      .run(passwordHash, userId);
  }

  async deleteUser(userId: string): Promise<void> {
    // Sessions are deleted automatically via ON DELETE CASCADE
    this.db.prepare('DELETE FROM user WHERE id = ?').run(userId);
  }

  async listUsers(): Promise<User[]> {
    const rows = this.db
      .prepare('SELECT * FROM user ORDER BY created_at ASC')
      .all() as UserRow[];
    return rows.map((r) => this.rowToUser(r));
  }

  async userCount(): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM user')
      .get() as { count: number };
    return row.count;
  }

  private rowToUser(row: UserRow): User {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role as 'admin',
      createdAt: new Date(row.created_at),
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
    };
  }

  getLuciaAdapter(): Adapter {
    return new BetterSqlite3Adapter(this.db);
  }
}

// ─────────────────────────────────────────────────────────────
// Lucia instance factory
// ─────────────────────────────────────────────────────────────

// Augment Lucia's type registry for full typing across the app
declare module 'lucia' {
  interface Register {
    Lucia: ReturnType<typeof createLucia>;
    DatabaseUserAttributes: {
      username: string;
      role: string;
      created_at: number;
      last_login_at: number | null;
    };
  }
}

export function createLucia(
  adapter: Adapter,
  sessionMaxAge: number,
  isProduction: boolean,
) {
  return new Lucia(adapter, {
    sessionExpiresIn: new (require('lucia').TimeSpan)(sessionMaxAge, 's'),
    sessionCookie: {
      name: 'nms_session',
      attributes: {
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
      },
    },
    getUserAttributes(attributes) {
      return {
        username: attributes.username,
        role: attributes.role,
        createdAt: new Date(attributes.created_at),
        lastLoginAt: attributes.last_login_at
          ? new Date(attributes.last_login_at)
          : null,
      };
    },
  });
}

export type AppLucia = ReturnType<typeof createLucia>;
