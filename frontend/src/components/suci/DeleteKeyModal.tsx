import { useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import type { HnetKey } from '../../types/suci';
import { useSuciStore } from '../../stores/suci';
import toast from 'react-hot-toast';
import { LabelWithTooltip } from '../common/UniversalTooltipWrappers';
import { SUCI_TOOLTIPS } from '../../data/tooltips';

interface DeleteKeyModalProps {
  keyData: HnetKey;
  onClose: () => void;
}

export function DeleteKeyModal({ keyData, onClose }: DeleteKeyModalProps): JSX.Element {
  const { deleteKey } = useSuciStore();
  const [deleteFile, setDeleteFile] = useState(true);
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteKey(keyData.id, deleteFile);
      toast.success(`PKI ${keyData.id} deleted successfully`);
      onClose();
    } catch (error) {
      toast.error(`Failed to delete key: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="nms-card max-w-md w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-nms-red" />
            <h3 className="text-lg font-semibold font-display">Delete SUCI Key</h3>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Confirmation Message */}
          <div className="text-sm text-nms-text">
            <p>
              Delete PKI ID <strong>{keyData.id}</strong> (Profile {keyData.profile})?
            </p>
            <p className="text-nms-text-dim mt-2">
              This will remove the key entry from <code className="text-nms-accent">udm.yaml</code>.
            </p>
          </div>

          {/* Delete File Option */}
          <div className="bg-nms-surface-2/30 rounded p-3 border border-nms-border/30">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="nms-checkbox mt-0.5"
                checked={deleteFile}
                onChange={(e) => setDeleteFile(e.target.checked)}
              />
              <div className="flex-1">
                <div className="text-sm text-nms-text font-medium">
                  <LabelWithTooltip tooltip={SUCI_TOOLTIPS.delete_file}>
                    Also delete key file from disk
                  </LabelWithTooltip>
                </div>
                <div className="text-xs text-nms-text-dim mt-1">
                  <code className="text-nms-accent">{keyData.keyFile}</code>
                </div>
                <p className="text-xs text-nms-text-dim mt-2">
                  If unchecked, the key file will remain on disk but will not be used by Open5GS.
                </p>
              </div>
            </label>
          </div>

          {/* Warning */}
          {keyData.fileExists && deleteFile && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 text-xs text-nms-text-dim">
              <strong className="text-amber-500">⚠️ Warning:</strong> This will permanently delete the
              private key file. Make sure no eSIMs are currently using this key before deletion.
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="nms-btn-ghost flex-1">
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={loading}
            className="nms-btn-primary bg-nms-red hover:bg-nms-red/80 flex-1 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>Deleting...</>
            ) : (
              <>
                <Trash2 className="w-4 h-4" />
                Delete
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
