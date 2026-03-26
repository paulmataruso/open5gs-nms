import { useState, useEffect } from 'react';
import { X, Key } from 'lucide-react';
import { useSuciStore } from '../../stores/suci';
import toast from 'react-hot-toast';
import { LabelWithTooltip } from '../common/UniversalTooltipWrappers';
import { SUCI_TOOLTIPS } from '../../data/tooltips';

interface GenerateKeyModalProps {
  onClose: () => void;
}

export function GenerateKeyModal({ onClose }: GenerateKeyModalProps): JSX.Element {
  const { generateKey, getNextId } = useSuciStore();
  const [id, setId] = useState(1);
  const [scheme, setScheme] = useState<1 | 2>(1);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Auto-suggest next available ID
    getNextId().then(nextId => setId(nextId)).catch(() => {});
  }, [getNextId]);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      await generateKey(id, scheme);
      toast.success(`SUCI key PKI ${id} (Profile ${scheme === 1 ? 'A' : 'B'}) generated successfully`);
      onClose();
    } catch (error) {
      toast.error(`Failed to generate key: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="nms-card max-w-md w-full">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-nms-accent" />
            <h3 className="text-lg font-semibold font-display">Generate New SUCI Key</h3>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* PKI ID */}
          <div>
            <label className="nms-label">
              <LabelWithTooltip tooltip={SUCI_TOOLTIPS.pki_id}>
                PKI ID (Home Network Public Key Identifier)
              </LabelWithTooltip>
            </label>
            <input
              type="number"
              className="nms-input font-mono"
              value={id}
              onChange={(e) => setId(Math.max(1, Math.min(255, parseInt(e.target.value) || 1)))}
              min={1}
              max={255}
            />
            <p className="text-xs text-nms-text-dim mt-1">
              Value between 1-255. This identifies the key when provisioning SIMs.
            </p>
          </div>

          {/* Profile Selection */}
          <div>
            <label className="nms-label">
              <LabelWithTooltip tooltip={SUCI_TOOLTIPS.profile}>
                SUCI Profile
              </LabelWithTooltip>
            </label>
            <div className="space-y-2">
              <label className="flex items-start gap-3 p-3 border border-nms-border rounded-lg cursor-pointer hover:bg-nms-surface-2/30 transition-colors">
                <input
                  type="radio"
                  name="scheme"
                  value={1}
                  checked={scheme === 1}
                  onChange={() => setScheme(1)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="font-semibold text-sm text-nms-text">Profile A (X25519)</div>
                  <div className="text-xs text-nms-text-dim mt-1">
                    ECIES scheme profile A using curve25519 elliptic curve cryptography.
                    Most commonly used for 5G networks.
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 border border-nms-border rounded-lg cursor-pointer hover:bg-nms-surface-2/30 transition-colors">
                <input
                  type="radio"
                  name="scheme"
                  value={2}
                  checked={scheme === 2}
                  onChange={() => setScheme(2)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="font-semibold text-sm text-nms-text">Profile B (secp256r1)</div>
                  <div className="text-xs text-nms-text-dim mt-1">
                    ECIES scheme profile B using secp256r1 (prime256v1) elliptic curve.
                    Alternative encryption scheme for specialized deployments.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Info */}
          <div className="bg-nms-surface-2/30 rounded p-3 text-xs text-nms-text-dim">
            <strong className="text-nms-text">Note:</strong> The private key will be generated in{' '}
            <code className="text-nms-accent">/etc/open5gs/hnet/</code> and automatically added to{' '}
            <code className="text-nms-accent">udm.yaml</code>. The public key will be extracted and
            displayed for use in eSIM provisioning.
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="nms-btn-ghost flex-1">
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="nms-btn-primary flex-1 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>Generating...</>
            ) : (
              <>
                <Key className="w-4 h-4" />
                Generate Key
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
