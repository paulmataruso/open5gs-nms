// Backup & Restore Page Tooltips

export const BACKUP_TOOLTIPS = {
  config_backups_to_keep: "Number of configuration backups to retain before automatic cleanup. Older backups beyond this limit will be deleted. Minimum: 1. Recommended: 10 for adequate restore points.",
  mongo_backups_to_keep: "Number of MongoDB (subscriber data) backups to retain. Each backup contains complete subscriber collection with IMSI, K, OPc, and slice configurations. Minimum: 1. Recommended: 5 to balance disk space and recovery options.",
};
