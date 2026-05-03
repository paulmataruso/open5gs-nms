import { useState } from 'react';
import { Copy, Trash2, RefreshCw, CheckCircle, AlertCircle, Pencil } from 'lucide-react';
import type { HnetKey } from '../../types/suci';
import { RegenerateKeyModal } from './RegenerateKeyModal';
import { DeleteKeyModal } from './DeleteKeyModal';
import { RenameKeyModal } from './RenameKeyModal';
import toast from 'react-hot-toast';

interface KeyCardProps {
  keyData: HnetKey;
}

function CopyableKey({ label, sublabel, value, copyLabel, accentColor = 'text-nms-accent' }: {
  label: string;
  sublabel: string;
  value: string | null;
  copyLabel: string;
  accentColor?: string;
}) {
  const handleCopy = () => {
    if (value) {
      navigator.clipboard.writeText(value);
      toast.success(`${copyLabel} copied to clipboard`);
    }
  };

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <label className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
          {label}
        </label>
        <span className="text-xs text-nms-text-dim normal-case">{sublabel}</span>
      </div>
      {value ? (
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1 bg-nms-surface-2/50 rounded p-2 border border-nms-border/30">
            <code className={`text-xs font-mono break-all ${accentColor}`}>
              {value}
            </code>
          </div>
          <button
            onClick={handleCopy}
            className="nms-btn-ghost text-xs flex items-center gap-1 flex-shrink-0"
            title={`Copy ${copyLabel}`}
          >
            <Copy className="w-3.5 h-3.5" />
            Copy
          </button>
        </div>
      ) : (
        <div className="text-xs text-nms-text-dim italic mt-1">
          Could not be extracted
        </div>
      )}
    </div>
  );
}

export function KeyCard({ keyData }: KeyCardProps): JSX.Element {
  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);

  const profileColor = keyData.profile === 'A' ? 'text-blue-400' : 'text-purple-400';
  const profileBg = keyData.profile === 'A' ? 'bg-blue-500/10' : 'bg-purple-500/10';

  // Labels vary by profile.
  // Profile A (X25519): both UDM and SIM tools use the same raw 32-byte (64 hex) key.
  // Profile B (secp256r1): UDM wants compressed (66 hex), SIM tools want uncompressed (130 hex).
  const udmKeyLabel = keyData.profile === 'A' ? '64 hex — raw X25519' : '66 hex — compressed secp256r1';
  const simKeyLabel = keyData.profile === 'A' ? '64 hex — raw X25519 (same as UDM)' : '130 hex — uncompressed secp256r1';

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
                Profile {keyData.profile} — {keyData.algorithm}
              </h3>
              <p className="text-xs text-nms-text-dim mt-0.5">{keyData.schemeLabel}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowRenameModal(true)}
              className="nms-btn-ghost text-xs flex items-center gap-1"
              title="Change PKI ID"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit ID
            </button>
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

          {/* Open5GS UDM Key */}
          <CopyableKey
            label="Open5GS UDM Key"
            sublabel={`udm.yaml hnet — ${udmKeyLabel}`}
            value={keyData.publicKeyHex}
            copyLabel="UDM key"
            accentColor="text-nms-accent"
          />

          {/* SIM Provisioning Key */}
          <CopyableKey
            label="SIM Provisioning Key"
            sublabel={`pySIM / sysmoUSIM — ${simKeyLabel}`}
            value={keyData.publicKeyUncompressed}
            copyLabel="SIM provisioning key"
            accentColor="text-green-400"
          />

          {/* Usage Info */}
          <div className="text-xs text-nms-text-dim bg-nms-surface-2/30 rounded p-3 border-l-2 border-nms-accent/50 space-y-1">
            <p><strong className="text-nms-text">Open5GS UDM Key</strong> — paste into <code className="text-nms-accent">udm.yaml</code> hnet block with <code className="text-nms-accent">scheme: {keyData.scheme}</code> and <code className="text-nms-accent">id: {keyData.id}</code>.</p>
            <p><strong className="text-nms-text">SIM Provisioning Key</strong> — use when programming eSIMs with tools like pySIM or sysmoUSIM. Set PKI ID = {keyData.id}, Profile {keyData.profile}.</p>
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

      {showRenameModal && (
        <RenameKeyModal
          keyData={keyData}
          onClose={() => setShowRenameModal(false)}
        />
      )}
    </>
  );
}
