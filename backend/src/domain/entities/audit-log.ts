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
  | 'restore_defaults'
  | 'radio_provision'
  | 'radio_reboot'
  | 'radio_reboot_all'
  | 'radio_rf_enable'
  | 'radio_rf_disable'
  | 'radio_rf_all'
  | 'chrony_config_update'
  | 'chrony_install'
  | 'chrony_restart'
  | 'chrony_start'
  | 'chrony_stop'
  | 'frr_backup'
  | 'frr_install'
  | 'frr_transit'
  | 'frr_neighbor_config'
  | 'frr_neighbor_up'
  | 'frr_dummies'
  | 'frr_advertise'
  | 'frr_cutover'
  | 'frr_confirm'
  | 'frr_rollback'
  | 'frr_ue_subnets';

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
