import { useState, useEffect } from 'react';
import { X, Check, CheckSquare, Square, AlertCircle } from 'lucide-react';
import { backupApi, ConfigDiffFile } from '../../api/backup';
import toast from 'react-hot-toast';
// Simple diff implementation (no external library needed)
interface Change {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function diffLines(oldStr: string, newStr: string): Change[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const changes: Change[] = [];
  
  // Simple line-by-line comparison
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    
    if (oldLine === newLine) {
      changes.push({ value: (oldLine || '') + '\n' });
    } else if (oldLine && !newLine) {
      changes.push({ value: oldLine + '\n', removed: true });
    } else if (!oldLine && newLine) {
      changes.push({ value: newLine + '\n', added: true });
    } else if (oldLine !== newLine) {
      changes.push({ value: oldLine + '\n', removed: true });
      changes.push({ value: newLine + '\n', added: true });
    }
  }
  
  return changes;
}

interface ConfigRestoreModalProps {
  backupName: string;
  onClose: () => void;
  onRestoreComplete: () => void;
}

const ALL_SERVICES = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];

export const ConfigRestoreModal: React.FC<ConfigRestoreModalProps> = ({ backupName, onClose, onRestoreComplete }) => {
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<Record<string, ConfigDiffFile>>({});
  const [activeTab, setActiveTab] = useState('nrf');
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    loadDiff();
  }, [backupName]);

  const loadDiff = async () => {
    setLoading(true);
    try {
      const result = await backupApi.getConfigDiff(backupName);
      if (result.success && result.files) {
        setFiles(result.files);
        // Auto-select services with changes
        const changedServices = Object.keys(result.files).filter(s => result.files![s].hasDiff);
        setSelectedServices(new Set(changedServices));
      } else {
        toast.error(result.error || 'Failed to load config diff');
        onClose();
      }
    } catch (err) {
      toast.error('Failed to load config diff');
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (selectedServices.size === 0) {
      toast.error('Please select at least one service to restore');
      return;
    }

    if (!confirm(`Restore ${selectedServices.size} config file(s)? This will overwrite current configurations.`)) {
      return;
    }

    setRestoring(true);
    try {
      const result = await backupApi.restoreSelectedConfigs(backupName, Array.from(selectedServices));
      if (result.success) {
        toast.success(`Successfully restored ${result.restored.length} config file(s)`);
        onRestoreComplete();
        onClose();
      } else {
        const errorCount = Object.keys(result.errors).length;
        toast.error(`Restored ${result.restored.length} files, ${errorCount} failed`);
      }
    } catch (err) {
      toast.error('Failed to restore config files');
    } finally {
      setRestoring(false);
    }
  };

  const toggleService = (service: string) => {
    const newSelected = new Set(selectedServices);
    if (newSelected.has(service)) {
      newSelected.delete(service);
    } else {
      newSelected.add(service);
    }
    setSelectedServices(newSelected);
  };

  const selectAll = () => {
    setSelectedServices(new Set(ALL_SERVICES));
  };

  const deselectAll = () => {
    setSelectedServices(new Set());
  };

  const selectOnlyChanged = () => {
    const changed = Object.keys(files).filter(s => files[s]?.hasDiff);
    setSelectedServices(new Set(changed));
  };

  const renderDiff = (service: string) => {
    const file = files[service];
    if (!file) {
      return <div className="p-4 text-nms-text-dim text-sm">Service not found in backup</div>;
    }

    if (!file.hasDiff) {
      return (
        <div className="flex items-center justify-center h-64 text-nms-text-dim">
          <div className="text-center">
            <Check className="w-12 h-12 mx-auto mb-2 text-nms-green" />
            <p>No changes detected</p>
          </div>
        </div>
      );
    }

    const diff = diffLines(file.current, file.backup);

    return (
      <div className="grid grid-cols-2 gap-px bg-nms-border text-xs font-mono">
        {/* Current */}
        <div className="bg-nms-surface p-4">
          <div className="text-nms-text-dim mb-2 font-sans font-semibold">Current (Live)</div>
          <div className="space-y-px">
            {diff.map((part: Change, idx: number) => {
              if (part.removed) {
                return (
                  <div key={idx} className="bg-red-500/10 text-red-400 px-2 py-0.5">
                    {part.value.split('\n').filter(Boolean).map((line: string, i: number) => (
                      <div key={i}>- {line}</div>
                    ))}
                  </div>
                );
              }
              if (!part.added) {
                return (
                  <div key={idx} className="text-nms-text-dim px-2 py-0.5">
                    {part.value.split('\n').filter(Boolean).map((line: string, i: number) => (
                      <div key={i}>  {line}</div>
                    ))}
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>

        {/* Backup */}
        <div className="bg-nms-surface p-4">
          <div className="text-nms-text-dim mb-2 font-sans font-semibold">Backup ({backupName})</div>
          <div className="space-y-px">
            {diff.map((part: Change, idx: number) => {
              if (part.added) {
                return (
                  <div key={idx} className="bg-green-500/10 text-green-400 px-2 py-0.5">
                    {part.value.split('\n').filter(Boolean).map((line: string, i: number) => (
                      <div key={i}>+ {line}</div>
                    ))}
                  </div>
                );
              }
              if (!part.removed) {
                return (
                  <div key={idx} className="text-nms-text-dim px-2 py-0.5">
                    {part.value.split('\n').filter(Boolean).map((line: string, i: number) => (
                      <div key={i}>  {line}</div>
                    ))}
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="nms-card w-64 text-center">
          <p className="text-nms-text">Loading config diff...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-nms-surface border border-nms-border rounded-lg w-full max-w-7xl h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-nms-border">
          <div>
            <h2 className="text-xl font-bold font-display text-nms-text">Config Restore Preview</h2>
            <p className="text-xs text-nms-text-dim">Backup: {backupName}</p>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-4 overflow-x-auto border-b border-nms-border">
          {ALL_SERVICES.map((service) => {
            const file = files[service];
            const hasDiff = file?.hasDiff || false;
            return (
              <button
                key={service}
                onClick={() => setActiveTab(service)}
                className={`px-3 py-2 text-xs font-medium rounded-t-md transition-colors whitespace-nowrap ${
                  activeTab === service
                    ? 'bg-nms-accent/10 text-nms-accent border-b-2 border-nms-accent'
                    : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2'
                }`}
              >
                {service.toUpperCase()}
                {hasDiff && <AlertCircle className="w-3 h-3 inline ml-1 text-amber-400" />}
              </button>
            );
          })}
        </div>

        {/* Diff Viewer */}
        <div className="flex-1 overflow-auto p-4">
          {renderDiff(activeTab)}
        </div>

        {/* Sticky Footer */}
        <div className="border-t border-nms-border bg-nms-bg p-4">
          <label className="nms-label mb-2">Select Files to Restore</label>
          
          {/* Checkboxes Grid */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            {ALL_SERVICES.map((service) => {
              const file = files[service];
              const hasDiff = file?.hasDiff || false;
              const isSelected = selectedServices.has(service);
              
              return (
                <button
                  key={service}
                  onClick={() => toggleService(service)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                    isSelected
                      ? 'bg-nms-accent/10 text-nms-accent border border-nms-accent/30'
                      : 'bg-nms-surface text-nms-text-dim hover:bg-nms-surface-2 border border-nms-border'
                  }`}
                >
                  {isSelected ? (
                    <CheckSquare className="w-4 h-4 shrink-0" />
                  ) : (
                    <Square className="w-4 h-4 shrink-0" />
                  )}
                  <span className="font-mono">{service.toUpperCase()}</span>
                  {hasDiff && <AlertCircle className="w-3 h-3 text-amber-400 ml-auto" />}
                </button>
              );
            })}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <button onClick={selectAll} className="nms-btn-ghost text-xs">
                Select All
              </button>
              <button onClick={deselectAll} className="nms-btn-ghost text-xs">
                Deselect All
              </button>
              <button onClick={selectOnlyChanged} className="nms-btn-ghost text-xs">
                Only Changed Files
              </button>
            </div>

            <div className="flex gap-2">
              <button onClick={onClose} className="nms-btn-ghost">
                Cancel
              </button>
              <button
                onClick={handleRestore}
                disabled={restoring || selectedServices.size === 0}
                className="nms-btn-primary"
              >
                {restoring ? 'Restoring...' : `Restore ${selectedServices.size} Selected File${selectedServices.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
