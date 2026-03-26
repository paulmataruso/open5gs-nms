import { useState } from 'react';
import { Copy, Trash2, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import type { HnetKey } from '../../types/suci';
import { RegenerateKeyModal } from './RegenerateKeyModal';
import { DeleteKeyModal } from './DeleteKeyModal';
import toast from 'react-hot-toast';

interface KeyCardProps {
  keyData: HnetKey;
}

export function KeyCard({ keyData }: KeyCardProps): JSX.Element {
  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const copyPublicKey = () => {
    if (keyData.publicKeyHex) {
      navigator.clipboard.writeText(keyData.publicKeyHex);
      toast.success('Public key copied to clipboard');
    }
  };

  const profileColor = keyData.profile === 'A' ? 'text-blue-400' : 'text-purple-400';
  const profileBg = keyData.profile === 'A' ? 'bg-blue-500/10' : 'bg-purple-500/10';

  return (
    <>
      <div className="nms-card">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`px-3 py-1 rounded-full ${profileBg} ${profileColor} text-xs font-semibold`}>
              PKI ID {keyData.id}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-nms-text">
                Profile {keyData.profile} - {keyData.algorithm}
              </h3>
              <p className="text-xs text-nms-text-dim mt-0.5">{keyData.schemeLabel}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowRegenerateModal(true)}
              className="nms-btn-ghost text-xs flex items-center gap-1"
              title="Regenerate this key"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Regenerate
            </button>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="nms-btn-ghost text-xs text-nms-red hover:text-nms-red/80 flex items-center gap-1"
              title="Delete this key"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {/* Key File Path */}
          <div>
            <label className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
              Key File
            </label>
            <div className="flex items-center gap-2 mt-1">
              <code className="text-xs font-mono text-nms-text bg-nms-surface-2/50 px-2 py-1 rounded flex-1">
                {keyData.keyFile}
              </code>
              {keyData.fileExists ? (
                <CheckCircle className="w-4 h-4 text-nms-green" />
              ) : (
                <AlertCircle className="w-4 h-4 text-nms-red" />
              )}
            </div>
          </div>

          {/* Public Key */}
          <div>
            <label className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
              Public Key (for eSIM Provisioning)
            </label>
            {keyData.publicKeyHex ? (
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 bg-nms-surface-2/50 rounded p-2 border border-nms-border/30">
                  <code className="text-xs font-mono text-nms-accent break-all">
                    {keyData.publicKeyHex}
                  </code>
                </div>
                <button
                  onClick={copyPublicKey}
                  className="nms-btn-ghost text-xs flex items-center gap-1"
                  title="Copy public key"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy
                </button>
              </div>
            ) : (
              <div className="text-xs text-nms-text-dim italic mt-1">
                Public key could not be extracted
              </div>
            )}
          </div>

          {/* Usage Info */}
          <div className="text-xs text-nms-text-dim bg-nms-surface-2/30 rounded p-3 border-l-2 border-nms-accent/50">
            <strong className="text-nms-text">Usage:</strong> Include this public key when provisioning eSIMs
            with Profile {keyData.profile} SUCI protection. Set PKI={keyData.id} and paste the public key hex
            into your eSIM provisioning system (e.g., Simlessly).
          </div>
        </div>
      </div>

      {showRegenerateModal && (
        <RegenerateKeyModal
          keyData={keyData}
          onClose={() => setShowRegenerateModal(false)}
        />
      )}

      {showDeleteModal && (
        <DeleteKeyModal
          keyData={keyData}
          onClose={() => setShowDeleteModal(false)}
        />
      )}
    </>
  );
}
