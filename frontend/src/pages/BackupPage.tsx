import { useState, useEffect } from 'react';
import { Database, HardDrive, Settings as SettingsIcon, RotateCw, Check, AlertTriangle } from 'lucide-react';
import { backupApi as legacyBackupApi, BackupListItem, BackupSettings } from '../api/backup';
import { backupApi } from '../api';
import toast from 'react-hot-toast';
import { ConfigRestoreModal } from '../components/backup/ConfigRestoreModal';
import { LabelWithTooltip } from '../components/common/UniversalTooltipWrappers';
import { BACKUP_TOOLTIPS } from '../data/tooltips';

export const BackupPage: React.FC = () => {
  const [mongoBackups, setMongoBackups] = useState<BackupListItem[]>([]);
  const [configBackups, setConfigBackups] = useState<BackupListItem[]>([]);
  const [settings, setSettings] = useState<BackupSettings>({ configBackupsToKeep: 10, mongoBackupsToKeep: 5 });
  const [loading, setLoading] = useState(false);
  
  const [selectedMongoBackup, setSelectedMongoBackup] = useState<string>('');
  const [selectedConfigBackup, setSelectedConfigBackup] = useState<string>('');
  const [showRestoreModal, setShowRestoreModal] = useState(false);

  useEffect(() => {
    loadBackups();
    loadSettings();
  }, []);

  const loadBackups = async () => {
    try {
      const data = await legacyBackupApi.listBackups();
      setMongoBackups(data.mongoBackups);
      setConfigBackups(data.configBackups);
    } catch (err) {
      toast.error('Failed to load backups');
    }
  };

  const loadSettings = async () => {
    try {
      const data = await legacyBackupApi.getSettings();
      setSettings(data);
    } catch (err) {
      toast.error('Failed to load settings');
    }
  };

  const handleCreateMongoBackup = async () => {
    setLoading(true);
    try {
      const result = await legacyBackupApi.createMongoBackup();
      if (result.success) {
        toast.success(`MongoDB backup created: ${result.backupName}`);
        await loadBackups();
      } else {
        toast.error(result.error || 'Backup failed');
      }
    } catch (err) {
      toast.error('Failed to create MongoDB backup');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateConfigBackup = async () => {
    setLoading(true);
    try {
      const result = await legacyBackupApi.createConfigBackup();
      if (result.success) {
        toast.success(`Config backup created: ${result.backupName}`);
        await loadBackups();
      } else {
        toast.error(result.error || 'Backup failed');
      }
    } catch (err) {
      toast.error('Failed to create config backup');
    } finally {
      setLoading(false);
    }
  };

  const handleRestoreMongo = async () => {
    if (!selectedMongoBackup) {
      toast.error('Please select a MongoDB backup to restore');
      return;
    }
    
    if (!confirm(`Are you sure you want to restore MongoDB from "${selectedMongoBackup}"? This will overwrite current subscriber data.`)) {
      return;
    }

    setLoading(true);
    try {
      const result = await legacyBackupApi.restoreMongoBackup(selectedMongoBackup);
      if (result.success) {
        toast.success('MongoDB restored successfully');
      } else {
        toast.error(result.error || 'Restore failed');
      }
    } catch (err) {
      toast.error('Failed to restore MongoDB backup');
    } finally {
      setLoading(false);
    }
  };

  const handleRestoreConfig = () => {
    if (!selectedConfigBackup) {
      toast.error('Please select a config backup to restore');
      return;
    }
    setShowRestoreModal(true);
  };

  const handleRestoreComplete = () => {
    loadBackups();
  };

  const handleRestoreBoth = async () => {
    if (!selectedConfigBackup || !selectedMongoBackup) {
      toast.error('Please select both config and MongoDB backups');
      return;
    }
    
    if (!confirm('Are you sure you want to restore BOTH config and MongoDB? This will overwrite all current data.')) {
      return;
    }

    setLoading(true);
    try {
      const result = await legacyBackupApi.restoreBoth(selectedConfigBackup, selectedMongoBackup);
      if (result.success) {
        toast.success('Both config and MongoDB restored successfully');
      } else {
        toast.error(`Restore failed: ${result.errors.join(', ')}`);
      }
    } catch (err) {
      toast.error('Failed to restore backups');
    } finally {
      setLoading(false);
    }
  };

  const handleRestoreDefaults = async () => {
    if (!confirm('⚠️ WARNING: This will reset ALL Open5GS configuration files to factory defaults!\n\nA safety backup will be created automatically.\n\nAre you absolutely sure?')) {
      return;
    }

    setLoading(true);
    try {
      const result = await backupApi.restoreDefaults();
      if (result.success) {
        toast.success(`✅ ${result.message}`, { duration: 6000 });
        await loadBackups(); // Refresh to show the new safety backup
      } else {
        toast.error(result.message || 'Restore failed');
      }
    } catch (err) {
      toast.error('Failed to restore default configs');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateSettings = async () => {
    setLoading(true);
    try {
      await legacyBackupApi.updateSettings(settings);
      toast.success('Settings updated and old backups cleaned up');
      await loadBackups();
    } catch (err) {
      toast.error('Failed to update settings');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleString();
  };

  return (
    <>
      {showRestoreModal && selectedConfigBackup && (
        <ConfigRestoreModal
          backupName={selectedConfigBackup}
          onClose={() => setShowRestoreModal(false)}
          onRestoreComplete={handleRestoreComplete}
        />
      )}

    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-display text-nms-text mb-1">Backup & Restore</h1>
        <p className="text-sm text-nms-text-dim">Manage configuration and database backups</p>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* MongoDB Section */}
        <div className="nms-card">
          <div className="flex items-center gap-2 mb-4">
            <Database className="w-5 h-5 text-nms-accent" />
            <h2 className="text-lg font-semibold font-display text-nms-text">MongoDB Database</h2>
          </div>
          <p className="text-xs text-nms-text-dim mb-4">
            Backup and restore subscriber data from MongoDB
          </p>
          
          <button
            onClick={handleCreateMongoBackup}
            disabled={loading}
            className="nms-btn-primary w-full mb-4"
          >
            {loading ? 'Creating...' : 'Create MongoDB Backup'}
          </button>

          <label className="nms-label">Available MongoDB Backups</label>
          <div className="border border-nms-border rounded-md max-h-48 overflow-y-auto mb-3">
            {mongoBackups.length === 0 ? (
              <p className="p-3 text-xs text-nms-text-dim text-center">No MongoDB backups found</p>
            ) : (
              mongoBackups.map((backup) => (
                <div
                  key={backup.name}
                  onClick={() => setSelectedMongoBackup(backup.name)}
                  className={`p-3 cursor-pointer border-b border-nms-border last:border-b-0 hover:bg-nms-surface-2 transition-colors ${
                    selectedMongoBackup === backup.name ? 'bg-nms-accent/10 border-l-2 border-l-nms-accent' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-nms-text font-mono">{backup.name}</div>
                      <div className="text-xs text-nms-text-dim">{formatDate(backup.timestamp)}</div>
                    </div>
                    {selectedMongoBackup === backup.name && (
                      <Check className="w-4 h-4 text-nms-accent" />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <button
            onClick={handleRestoreMongo}
            disabled={loading || !selectedMongoBackup}
            className="nms-btn-primary w-full"
          >
            <RotateCw className="w-4 h-4 inline mr-2" />
            Restore Selected
          </button>
        </div>

        {/* Config Section */}
        <div className="nms-card">
          <div className="flex items-center gap-2 mb-4">
            <HardDrive className="w-5 h-5 text-nms-accent" />
            <h2 className="text-lg font-semibold font-display text-nms-text">Configuration Files</h2>
          </div>
          <p className="text-xs text-nms-text-dim mb-4">
            Backup and restore Open5GS YAML configurations
          </p>
          
          <button
            onClick={handleCreateConfigBackup}
            disabled={loading}
            className="nms-btn-primary w-full mb-4"
          >
            {loading ? 'Creating...' : 'Create Config Backup'}
          </button>

          <label className="nms-label">Available Config Backups</label>
          <div className="border border-nms-border rounded-md max-h-48 overflow-y-auto mb-3">
            {configBackups.length === 0 ? (
              <p className="p-3 text-xs text-nms-text-dim text-center">No config backups found</p>
            ) : (
              configBackups.map((backup) => (
                <div
                  key={backup.name}
                  onClick={() => setSelectedConfigBackup(backup.name)}
                  className={`p-3 cursor-pointer border-b border-nms-border last:border-b-0 hover:bg-nms-surface-2 transition-colors ${
                    selectedConfigBackup === backup.name ? 'bg-nms-accent/10 border-l-2 border-l-nms-accent' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-nms-text font-mono">{backup.name}</div>
                      <div className="text-xs text-nms-text-dim">{formatDate(backup.timestamp)}</div>
                    </div>
                    {selectedConfigBackup === backup.name && (
                      <Check className="w-4 h-4 text-nms-accent" />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <button
            onClick={handleRestoreConfig}
            disabled={loading || !selectedConfigBackup}
            className="nms-btn-primary w-full"
          >
            <RotateCw className="w-4 h-4 inline mr-2" />
            Restore Selected
          </button>
        </div>
      </div>

      {/* Combined Restore */}
      <div className="nms-card bg-amber-500/5 border-amber-500/20 mb-6">
        <h2 className="text-lg font-semibold font-display text-nms-text mb-2">Restore Both</h2>
        <p className="text-xs text-nms-text-dim mb-4">
          Restore configuration and database together for complete system recovery
        </p>
        <button
          onClick={handleRestoreBoth}
          disabled={loading || !selectedConfigBackup || !selectedMongoBackup}
          className="nms-btn bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30"
        >
          <RotateCw className="w-4 h-4 inline mr-2" />
          Restore Config + MongoDB
        </button>
      </div>

      {/* Restore Factory Defaults */}
      <div className="nms-card bg-red-500/5 border-red-500/20 mb-6">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <h2 className="text-lg font-semibold font-display text-nms-text">Restore Factory Defaults</h2>
        </div>
        <p className="text-xs text-nms-text-dim mb-3">
          Reset all Open5GS configuration files to factory default settings
        </p>
        <div className="bg-red-500/10 border border-red-500/30 rounded-md p-3 mb-4">
          <p className="text-xs text-red-300 mb-2">
            <AlertTriangle className="w-3 h-3 inline mr-1" />
            <strong>Warning:</strong> This will overwrite ALL configuration files
          </p>
          <ul className="text-xs text-red-300/80 space-y-1 ml-4">
            <li>• All 18 Open5GS config files will be reset to defaults</li>
            <li>• Custom settings (IP addresses, PLMN, etc.) will be lost</li>
            <li>• A safety backup will be created automatically</li>
            <li>• Subscriber data (MongoDB) is NOT affected</li>
          </ul>
        </div>
        <button
          onClick={handleRestoreDefaults}
          disabled={loading}
          className="nms-btn bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30"
        >
          <AlertTriangle className="w-4 h-4 inline mr-2" />
          Restore Factory Defaults
        </button>
      </div>

      {/* Settings */}
      <div className="nms-card">
        <div className="flex items-center gap-2 mb-4">
          <SettingsIcon className="w-5 h-5 text-nms-accent" />
          <h2 className="text-lg font-semibold font-display text-nms-text">Backup Retention</h2>
        </div>
        <p className="text-xs text-nms-text-dim mb-4">
          Configure how many backups to keep. Older backups will be automatically deleted.
        </p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="nms-label">
              <LabelWithTooltip tooltip={BACKUP_TOOLTIPS.config_backups_to_keep}>Config Backups to Keep</LabelWithTooltip>
            </label>
            <input
              type="number"
              min="1"
              value={settings.configBackupsToKeep}
              onChange={(e) => setSettings({ ...settings, configBackupsToKeep: parseInt(e.target.value) || 1 })}
              className="nms-input"
            />
          </div>
          
          <div>
            <label className="nms-label">
              <LabelWithTooltip tooltip={BACKUP_TOOLTIPS.mongo_backups_to_keep}>MongoDB Backups to Keep</LabelWithTooltip>
            </label>
            <input
              type="number"
              min="1"
              value={settings.mongoBackupsToKeep}
              onChange={(e) => setSettings({ ...settings, mongoBackupsToKeep: parseInt(e.target.value) || 1 })}
              className="nms-input"
            />
          </div>
        </div>

        <button
          onClick={handleUpdateSettings}
          disabled={loading}
          className="nms-btn-primary"
        >
          Save Settings & Cleanup Old Backups
        </button>
      </div>
    </div>
    </>
  );
};
