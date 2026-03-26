import { useState } from 'react';
import { X, AlertTriangle, RefreshCw } from 'lucide-react';
import type { HnetKey } from '../../types/suci';
import { useSuciStore } from '../../stores/suci';
import toast from 'react-hot-toast';

interface RegenerateKeyModalProps {
  keyData: HnetKey;
  onClose: () => void;
}

export function RegenerateKeyModal({ keyData, onClose }: RegenerateKeyModalProps): JSX.Element {
  const { regenerateKey } = useSuciStore();
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegenerate = async () => {
    if (confirmation !== 'REGENERATE') {
      toast.error('Please type REGENERATE to confirm');
      return;
    }

    setLoading(true);
    try {
      await regenerateKey(keyData.id, keyData.scheme);
      toast.success(`PKI ${keyData.id} regenerated successfully`);
      onClose();
    } catch (error) {
      toast.error(`Failed to regenerate key: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="nms-card max-w-lg w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <h3 className="text-lg font-semibold font-display">Regenerate SUCI Key</h3>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Warning */}
          <div className="bg-amber-500/10 border-2 border-amber-500/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-amber-500 mb-2">Critical Warning</h4>
                <div className="text-sm text-nms-text-dim space-y-2">
                  <p>
                    This will <strong className="text-nms-text">permanently replace</strong> PKI ID{' '}
                    {keyData.id} (Profile {keyData.profile}).
                  </p>
                  <p className="text-amber-400 font-semibold">
                    ⚠️ All eSIMs using this key will need to be reprovisioned with the new public key!
                  </p>
                  <p>
                    Current deployments will <strong className="text-nms-text">fail to authenticate</strong>{' '}
                    until SIMs are updated.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Current Key Info */}
          <div className="bg-nms-surface-2/30 rounded p-3 text-xs space-y-2">
            <div>
              <span className="text-nms-text-dim">Current Key File:</span>
              <div className="font-mono text-nms-text mt-1">{keyData.keyFile}</div>
            </div>
            <div>
              <span className="text-nms-text-dim">Current Public Key:</span>
              <div className="font-mono text-nms-accent mt-1 break-all">
                {keyData.publicKeyHex || 'N/A'}
              </div>
            </div>
          </div>

          {/* Confirmation */}
          <div>
            <label className="nms-label">
              Type <strong className="text-amber-500">REGENERATE</strong> to confirm:
            </label>
            <input
              type="text"
              className="nms-input font-mono"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="REGENERATE"
              autoFocus
            />
          </div>

          {/* Process Info */}
          <div className="text-xs text-nms-text-dim bg-nms-surface-2/30 rounded p-3">
            <strong className="text-nms-text">What happens:</strong>
            <ol className="list-decimal list-inside mt-2 space-y-1 ml-2">
              <li>Old private key file will be deleted</li>
              <li>New private key will be generated with same PKI ID</li>
              <li>udm.yaml will be updated</li>
              <li>New public key will be extracted and displayed</li>
            </ol>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="nms-btn-ghost flex-1">
            Cancel
          </button>
          <button
            onClick={handleRegenerate}
            disabled={loading || confirmation !== 'REGENERATE'}
            className="nms-btn-primary bg-amber-600 hover:bg-amber-700 disabled:bg-amber-600/50 flex-1 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>Regenerating...</>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Regenerate Key
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
