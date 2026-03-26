import { AuditLogEntry, AuditAction } from '../entities/audit-log';

export interface IAuditLogger {
  log(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void>;
  getAll(skip?: number, limit?: number): Promise<AuditLogEntry[]>;
  getByAction(action: AuditAction, skip?: number, limit?: number): Promise<AuditLogEntry[]>;
  count(): Promise<number>;
}
