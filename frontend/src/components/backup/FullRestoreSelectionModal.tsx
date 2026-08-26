import { useState } from 'react';
import { X, CheckSquare, Square, AlertTriangle, Database, FileCog, KeyRound, Puzzle, Network, Globe, ShieldCheck, RadioTower } from 'lucide-react';
import { BackupCategory, BackupCategoryInfo } from '../../api/backup';

interface FullRestoreSelectionModalProps {
  uploadId: string;
  categories: BackupCategoryInfo[];
  createdAt?: string;
  onClose: () => void;
  onConfirm: (uploadId: string, categories: BackupCategory[]) => Promise<void>;
}

// L3/network, DNS, and GenieACS default OFF. L3/DNS: a restore commonly
// happens onto a host whose physical IP topology differs from the one the
// backup was taken on, and silently overwriting frr.conf/netplan/BIND could
// break connectivity to the box entirely. GenieACS: a full separate-database
// restore that overwrites live radio provisioning/session state — the same
// "be deliberate about this one" posture, not because it's less important.
// Everything else (including secgw-pki, despite also being irreplaceable
// like suci-keys) defaults ON.
const DEFAULT_UNCHECKED: BackupCategory[] = ['l3-network', 'dns', 'genieacs'];

const ICONS: Record<BackupCategory, React.ReactNode> = {
  subscribers: <Database className="w-4 h-4" />,
  'core-configs': <FileCog className="w-4 h-4" />,
  'suci-keys': <KeyRound className="w-4 h-4" />,
  'secgw-pki': <ShieldCheck className="w-4 h-4" />,
  'optional-modules': <Puzzle className="w-4 h-4" />,
  'l3-network': <Network className="w-4 h-4" />,
  dns: <Globe className="w-4 h-4" />,
  genieacs: <RadioTower className="w-4 h-4" />,
};

export const FullRestoreSelectionModal: React.FC<FullRestoreSelectionModalProps> = ({
  uploadId, categories, createdAt, onClose, onConfirm,
}) => {
  const [selected, setSelected] = useState<Set<BackupCategory>>(
    new Set(categories.filter(c => c.present && !DEFAULT_UNCHECKED.includes(c.id)).map(c => c.id)),
  );
  const [restoring, setRestoring] = useState(false);

  const toggle = (id: BackupCategory) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const selectAll = () => setSelected(new Set(categories.filter(c => c.present).map(c => c.id)));
  const deselectAll = () => setSelected(new Set());

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    const list = Array.from(selected);
    const label = categories.filter(c => list.includes(c.id)).map(c => c.label).join(', ');
    if (!confirm(`Restore ${selected.size} categor${selected.size === 1 ? 'y' : 'ies'} (${label})?\n\nThis will overwrite the selected live data/config. Anything not checked is left untouched.`)) {
      return;
    }
    setRestoring(true);
    try {
      await onConfirm(uploadId, list);
      onClose();
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-nms-surface border border-nms-border rounded-lg w-full max-w-2xl flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-nms-border">
          <div>
            <h2 className="text-xl font-bold font-display text-nms-text">Choose What to Restore</h2>
            {createdAt && (
              <p className="text-xs text-nms-text-dim">Backup taken: {new Date(createdAt).toLocaleString()}</p>
            )}
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {categories.map((cat) => {
            const isSelected = selected.has(cat.id);
            const disabled = !cat.present;
            return (
              <button
                key={cat.id}
                onClick={() => !disabled && toggle(cat.id)}
                disabled={disabled}
                className={`w-full flex items-start gap-3 px-3 py-3 rounded-md text-left transition-colors border ${
                  disabled
                    ? 'bg-nms-bg text-nms-text-dim/50 border-nms-border cursor-not-allowed'
                    : isSelected
                      ? 'bg-nms-accent/10 text-nms-text border-nms-accent/30'
                      : 'bg-nms-surface text-nms-text-dim hover:bg-nms-surface-2 border-nms-border'
                }`}
              >
                {disabled ? <Square className="w-4 h-4 shrink-0 mt-0.5" /> : isSelected ? <CheckSquare className="w-4 h-4 shrink-0 mt-0.5 text-nms-accent" /> : <Square className="w-4 h-4 shrink-0 mt-0.5" />}
                <span className="shrink-0 mt-0.5">{ICONS[cat.id]}</span>
                <span className="flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{cat.label}</span>
                    {!disabled && cat.itemCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-nms-bg border border-nms-border text-nms-text-dim">
                        {cat.itemCount} item{cat.itemCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {disabled && <span className="text-[10px] text-nms-text-dim">not in this backup</span>}
                  </span>
                  <span className="block text-xs text-nms-text-dim mt-0.5">{cat.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        {(selected.has('l3-network') || selected.has('dns')) && (
          <div className="mx-4 mb-2 flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Restoring L3/IP or DNS config can break connectivity to this host if it differs from the host the backup was taken on. Only restore these onto the same physical box, or one with identical network topology.</span>
          </div>
        )}

        <div className="border-t border-nms-border bg-nms-bg p-4 flex items-center justify-between">
          <div className="flex gap-2">
            <button onClick={selectAll} className="nms-btn-ghost text-xs">Select All</button>
            <button onClick={deselectAll} className="nms-btn-ghost text-xs">Deselect All</button>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="nms-btn-ghost">Cancel</button>
            <button
              onClick={handleConfirm}
              disabled={restoring || selected.size === 0}
              className="nms-btn-primary"
            >
              {restoring ? 'Restoring...' : `Restore ${selected.size} Selected`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
