export type AuditAction =
  | 'config_load'
  | 'config_save'
  | 'config_apply'
  | 'config_rollback'
  | 'service_restart'
  | 'service_stop'
  | 'service_start'
  | 'subscriber_create'
  | 'subscriber_update'
  | 'subscriber_delete'
  | 'validation_error'
  | 'system_command'
  | 'restore_defaults';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  action: AuditAction;
  user: string;
  target?: string;
  details?: string;
  diffSummary?: string;
  validationResult?: {
    valid: boolean;
    errors: string[];
  };
  restartResult?: {
    success: boolean;
    services: string[];
    errors: string[];
  };
  success: boolean;
}
