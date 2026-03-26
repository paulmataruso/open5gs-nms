import { useEffect, useState } from 'react';
import { Plus, AlertTriangle } from 'lucide-react';
import { useSuciStore } from '../../stores/suci';
import { KeyCard } from './KeyCard';
import { GenerateKeyModal } from './GenerateKeyModal';
import toast from 'react-hot-toast';

export function SuciManagementPage(): JSX.Element {
  const { keys, hnetDir, loading, fetchKeys } = useSuciStore();
  const [showGenerateModal, setShowGenerateModal] = useState(false);

  useEffect(() => {
    fetchKeys().catch((err) => {
      toast.error(`Failed to load SUCI keys: ${err.message}`);
    });
  }, [fetchKeys]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-display">SUCI Key Management</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Home Network Public Keys for 5G Privacy Protection
          </p>
        </div>
        <button 
          onClick={() => setShowGenerateModal(true)} 
          className="nms-btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Generate New Key
        </button>
      </div>

      {/* Info Box */}
      <div className="nms-card bg-nms-surface-2/30 border-nms-accent/20">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-nms-accent mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-nms-text mb-1">About SUCI Keys</h3>
            <p className="text-xs text-nms-text-dim leading-relaxed">
              SUCI (Subscription Concealed Identifier) provides privacy protection in 5G networks by encrypting the IMSI
              during initial network attachment. Each key pair consists of a private key stored in Open5GS UDM and a public
              key provisioned to eSIMs. <strong>Profile A (X25519)</strong> and <strong>Profile B (secp256r1)</strong> are
              both supported encryption schemes defined in 3GPP TS 33.501.
            </p>
            <p className="text-xs text-nms-text-dim mt-2">
              Key directory: <code className="text-nms-accent font-mono">{hnetDir}</code>
            </p>
          </div>
        </div>
      </div>

      {/* Keys List */}
      {loading && keys.length === 0 ? (
        <div className="nms-card text-center py-12">
          <div className="text-nms-text-dim">Loading SUCI keys...</div>
        </div>
      ) : keys.length === 0 ? (
        <div className="nms-card text-center py-12">
          <div className="text-nms-text-dim mb-4">No SUCI keys configured</div>
          <button 
            onClick={() => setShowGenerateModal(true)} 
            className="nms-btn-primary inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Generate Your First Key
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {keys.map((key) => (
            <KeyCard key={key.id} keyData={key} />
          ))}
        </div>
      )}

      {showGenerateModal && (
        <GenerateKeyModal onClose={() => setShowGenerateModal(false)} />
      )}
    </div>
  );
}
