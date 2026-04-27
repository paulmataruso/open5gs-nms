import { useState, useMemo } from 'react';
import { X, FileJson, Copy, Check, Terminal } from 'lucide-react';
import type { HnetKey } from '../../types/suci';
import toast from 'react-hot-toast';

interface PysimJsonModalProps {
  keys: HnetKey[];
  onClose: () => void;
}

function buildPysimJson(keys: HnetKey[]) {
  // Only include keys that have a valid extracted public key
  const validKeys = keys.filter(k => k.publicKeyHex && k.fileExists);

  // prot_scheme_id_list — ordered by priority:
  //   Profile B (scheme 2, identifier 2) first — most secure
  //   Profile A (scheme 1, identifier 1) second
  //   Null (identifier 0) last — always present as fallback
  //
  // key_index is the 1-based index into hnet_pubkey_list below.
  // Null scheme always uses key_index 0 (no key).

  const schemeB = validKeys.filter(k => k.scheme === 2);
  const schemeA = validKeys.filter(k => k.scheme === 1);

  const hnetPubkeyList = [
    ...schemeB.map(k => ({
      hnet_pubkey_identifier: k.id,
      hnet_pubkey: k.publicKeyHex!.toUpperCase(),
    })),
    ...schemeA.map(k => ({
      hnet_pubkey_identifier: k.id,
      hnet_pubkey: k.publicKeyHex!.toUpperCase(),
    })),
  ];

  // Build priority list — Profile B entries first, then A, then null
  const protSchemeIdList: Array<{ priority: number; identifier: number; key_index: number }> = [];
  let priority = 0;
  let keyIndex = 1; // 1-based into hnetPubkeyList

  for (const key of schemeB) {
    if (key.publicKeyHex) {
      protSchemeIdList.push({ priority: priority++, identifier: 2, key_index: keyIndex++ });
    }
  }
  for (const key of schemeA) {
    if (key.publicKeyHex) {
      protSchemeIdList.push({ priority: priority++, identifier: 1, key_index: keyIndex++ });
    }
  }
  // Null scheme always last
  protSchemeIdList.push({ priority: priority, identifier: 0, key_index: 0 });

  return {
    prot_scheme_id_list: protSchemeIdList,
    hnet_pubkey_list: hnetPubkeyList,
  };
}

export function PysimJsonModal({ keys, onClose }: PysimJsonModalProps): JSX.Element {
  const [copiedPretty, setCopiedPretty] = useState(false);
  const [copiedOneline, setCopiedOneline] = useState(false);

  const json = useMemo(() => buildPysimJson(keys), [keys]);
  const prettyJson = JSON.stringify(json, null, 2);
  const onelineJson = JSON.stringify(json);

  const copy = async (text: string, which: 'pretty' | 'oneline') => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'pretty') {
        setCopiedPretty(true);
        setTimeout(() => setCopiedPretty(false), 2000);
      } else {
        setCopiedOneline(true);
        setTimeout(() => setCopiedOneline(false), 2000);
      }
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const validKeys = keys.filter(k => k.publicKeyHex && k.fileExists);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="nms-card w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileJson className="w-5 h-5 text-nms-accent" />
            <h2 className="text-base font-semibold font-display text-nms-text">
              pySIM SUCI Config Generator
            </h2>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {validKeys.length === 0 ? (
          <div className="text-center py-8 text-nms-text-dim text-sm">
            No keys with extracted public keys found. Generate keys first.
          </div>
        ) : (
          <div className="overflow-y-auto flex-1 space-y-5">
            {/* Summary of what's included */}
            <div className="bg-nms-surface-2/50 border border-nms-border rounded-md p-3">
              <p className="text-xs font-semibold text-nms-text mb-2">Keys included:</p>
              <div className="space-y-1">
                {validKeys.map((k, i) => (
                  <div key={k.id} className="flex items-center gap-2 text-xs text-nms-text-dim">
                    <span className="font-mono text-nms-accent">PKI {k.id}</span>
                    <span>—</span>
                    <span>{k.schemeLabel}</span>
                    <span className="text-nms-text-dim/50">→ key_index {i + 1} in list</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-nms-text-dim mt-2 pt-2 border-t border-nms-border">
                Protection priority: {validKeys.filter(k => k.scheme === 2).length > 0 ? 'Profile B (secp256r1) → ' : ''}
                {validKeys.filter(k => k.scheme === 1).length > 0 ? 'Profile A (X25519) → ' : ''}
                Null scheme
              </p>
            </div>

            {/* Pretty JSON */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-nms-text uppercase tracking-wider">
                  Pretty JSON (human readable)
                </label>
                <button
                  onClick={() => copy(prettyJson, 'pretty')}
                  className="flex items-center gap-1.5 text-xs text-nms-accent hover:text-nms-accent-hover transition-colors"
                >
                  {copiedPretty ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedPretty ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="bg-nms-surface-2 border border-nms-border rounded-md p-3 text-xs font-mono text-nms-text overflow-x-auto whitespace-pre">
                {prettyJson}
              </pre>
            </div>

            {/* Single-line for pySIM */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-nms-text uppercase tracking-wider flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-nms-accent" />
                  Single-line (for pySIM --suci-data argument)
                </label>
                <button
                  onClick={() => copy(onelineJson, 'oneline')}
                  className="flex items-center gap-1.5 text-xs text-nms-accent hover:text-nms-accent-hover transition-colors"
                >
                  {copiedOneline ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedOneline ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="bg-nms-surface-2 border border-nms-border rounded-md p-3 text-xs font-mono text-nms-text break-all">
                {onelineJson}
              </div>
            </div>

            {/* pySIM command example */}
            <div>
              <label className="text-xs font-semibold text-nms-text uppercase tracking-wider block mb-2">
                pySIM-shell command
              </label>
              <div className="bg-nms-surface-2 border border-nms-border rounded-md p-3 text-xs font-mono text-nms-text-dim break-all">
                <span className="text-nms-accent">update_binary_decoded</span>{' '}
                <span className="text-yellow-400">'{onelineJson}'</span>
              </div>
              <p className="text-xs text-nms-text-dim mt-1.5">
                Run this inside pySIM-shell after navigating to
                <code className="text-nms-accent mx-1">MF/ADF.USIM/DF.5GS/EF.SUCI_Calc_Info</code>.
                The single quotes wrap the JSON so the shell treats it as one argument.
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end mt-4 flex-shrink-0">
          <button onClick={onClose} className="nms-btn-ghost text-sm">Close</button>
        </div>
      </div>
    </div>
  );
}
