import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { AuditLogEntry, AuditAction } from '../../domain/entities/audit-log';

export class FileAuditLogger implements IAuditLogger {
  private entries: AuditLogEntry[] = [];
  private readonly maxEntries = 10000;

  constructor(
    private readonly logDir: string,
    private readonly logger: pino.Logger,
  ) {}

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      const filePath = path.join(this.logDir, 'audit.json');
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        this.entries = JSON.parse(content) as AuditLogEntry[];
      } catch {
        this.entries = [];
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to initialize audit logger');
    }
  }

  async log(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    const fullEntry: AuditLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.unshift(fullEntry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(0, this.maxEntries);
    }
    await this.persist();
    this.logger.info({ action: entry.action, target: entry.target }, 'Audit log entry');
  }

  // These three read an in-memory array behind an async interface, so there is
  // nothing to await. `Promise.resolve(...)` rather than `async`: each body is
  // a single expression that already produces the value, so wrapping it reads
  // no worse and leaves the linter's "async with no await" signal intact for
  // cases where it means something. (sqlite-auth-repository.ts makes the
  // opposite call for the same rule, and says why: its sixteen are mostly void
  // side-effects, where `return Promise.resolve()` would be pure noise.)
  getAll(skip: number = 0, limit: number = 100): Promise<AuditLogEntry[]> {
    return Promise.resolve(this.entries.slice(skip, skip + limit));
  }

  getByAction(action: AuditAction, skip: number = 0, limit: number = 100): Promise<AuditLogEntry[]> {
    return Promise.resolve(this.entries.filter((e) => e.action === action).slice(skip, skip + limit));
  }

  count(): Promise<number> {
    return Promise.resolve(this.entries.length);
  }

  private async persist(): Promise<void> {
    try {
      const filePath = path.join(this.logDir, 'audit.json');
      const tmpPath = `${filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(this.entries, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      this.logger.error({ err }, 'Failed to persist audit log');
    }
  }
}
