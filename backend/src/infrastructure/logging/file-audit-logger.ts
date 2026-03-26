import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
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
      id: uuidv4(),
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

  async getAll(skip: number = 0, limit: number = 100): Promise<AuditLogEntry[]> {
    return this.entries.slice(skip, skip + limit);
  }

  async getByAction(action: AuditAction, skip: number = 0, limit: number = 100): Promise<AuditLogEntry[]> {
    return this.entries.filter((e) => e.action === action).slice(skip, skip + limit);
  }

  async count(): Promise<number> {
    return this.entries.length;
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
