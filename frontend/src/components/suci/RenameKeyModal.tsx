import { useState } from 'react';
import { X, Pencil } from 'lucide-react';
import { useSuciStore } from '../../stores/suci';
import type { HnetKey } from '../../types/suci';
import toast from 'react-hot-toast';

interface RenameKeyModalProps {
  keyData: HnetKey;
  onClose: () => void;
}

export function RenameKeyModal({ keyData, onClose }: RenameKeyModalProps): JSX.Element {
  const { fetchKeys } = useSuciStore();
  const [newId, setNewId] = useState<string>(String(keyData.id));
  const [loading, setLoading] = useState(false);

  const handleRename = async () => {
    const newIdNum = parseInt(newId, 10);

    if (isNaN(newIdNum) || newIdNum < 0 || newIdNum > 255) {
      toast.error('PKI ID must be an integer between 0 and 255');
      return;
    }

    if (newIdNum === keyData.id) {
      toast.error('New ID is the same as the current ID');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/suci/keys/${keyData.id}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newId: newIdNum }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Rename failed');
      }

      await fetchKeys();
      toast.success(`PKI ID changed from ${keyData.id} → ${newIdNum}`);
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename key');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="nms-card w-full max-w-sm">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Pencil className="w-4 h-4 text-nms-accent" />
            <h2 className="text-base font-semibold font-display text-nms-text">
              Change PKI ID
            </h2>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-nms-text-dim mb-4">
          Rename the PKI ID without regenerating the key. The key file will also be
          renamed to match the new ID. The existing public/private keypair is preserved.
        </p>

        {/* Current ID */}
        <div className="mb-3">
          <label className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
            Current PKI ID
          </label>
          <div className="mt-1 px-3 py-2 rounded bg-nms-surface-2/50 border border-nms-border text-sm font-mono text-nms-text-dim">
            {keyData.id}
          </div>
        </div>

        {/* New ID input */}
        <div className="mb-5">
          <label className="text-xs font-semibold text-nms-text uppercase tracking-wider">
            New PKI ID <span className="text-nms-accent">*</span>
          </label>
          <input
            type="number"
            min={0}
            max={255}
            className="nms-input w-full mt-1 font-mono"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="0–255"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          />
          <p className="text-xs text-nms-text-dim mt-1">Must be 0–255 and not already in use</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="nms-btn-ghost text-sm" disabled={loading}>
            Cancel
          </button>
          <button
            onClick={handleRename}
            disabled={loading || newId === String(keyData.id) || !newId}
            className="nms-btn-primary text-sm flex items-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Renaming...
              </>
            ) : (
              <>
                <Pencil className="w-3.5 h-3.5" />
                Change ID
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
