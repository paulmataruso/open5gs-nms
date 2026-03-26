import { Plus, X } from 'lucide-react';
import type { PlmnConfig } from '../../api';
import { LabelWithTooltip } from '../common/UniversalTooltipWrappers';
import { PLMN_INPUT_TOOLTIPS } from '../../data/tooltips';

interface PlmnInputProps {
  label: string;
  plmns: PlmnConfig[];
  onChange: (plmns: PlmnConfig[]) => void;
  showAdvanced?: boolean; // Show MME GID, MME Code, TAC fields
  mode: '4g' | '5g';
}

export const PlmnInput: React.FC<PlmnInputProps> = ({
  label,
  plmns,
  onChange,
  showAdvanced = false,
  mode,
}) => {
  const addPlmn = () => {
    const newPlmn: PlmnConfig = {
      mcc: '',
      mnc: '',
      ...(mode === '4g' && showAdvanced ? { mme_gid: 2, mme_code: plmns.length + 1, tac: 1 } : {}),
      ...(mode === '5g' && showAdvanced ? { tac: 1 } : {}),
    };
    onChange([...plmns, newPlmn]);
  };

  const removePlmn = (index: number) => {
    if (plmns.length === 1) return; // Keep at least one
    onChange(plmns.filter((_, i) => i !== index));
  };

  const updatePlmn = (index: number, field: keyof PlmnConfig, value: string | number) => {
    const updated = [...plmns];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <label className="nms-label">{label}</label>
        <button
          type="button"
          onClick={addPlmn}
          className="text-xs text-nms-accent hover:text-nms-accent-hover flex items-center gap-1 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add PLMN
        </button>
      </div>

      <div className="space-y-3">
        {plmns.map((plmn, index) => (
          <div key={index} className="bg-nms-surface-2 border border-nms-border rounded-md p-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-nms-text">
                PLMN {index + 1}
              </span>
              {plmns.length > 1 && (
                <button
                  type="button"
                  onClick={() => removePlmn(index)}
                  className="text-red-400 hover:text-red-300 transition-colors"
                  title="Remove PLMN"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="nms-label text-xs">
                  <LabelWithTooltip tooltip={PLMN_INPUT_TOOLTIPS.mcc}>MCC</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="999"
                  maxLength={3}
                  value={plmn.mcc}
                  onChange={(e) => updatePlmn(index, 'mcc', e.target.value)}
                  className="nms-input"
                />
              </div>
              <div>
                <label className="nms-label text-xs">
                  <LabelWithTooltip tooltip={PLMN_INPUT_TOOLTIPS.mnc}>MNC</LabelWithTooltip>
                </label>
                <input
                  type="text"
                  placeholder="70"
                  maxLength={3}
                  value={plmn.mnc}
                  onChange={(e) => updatePlmn(index, 'mnc', e.target.value)}
                  className="nms-input"
                />
              </div>
            </div>

            {showAdvanced && mode === '4g' && (
              <div className="grid grid-cols-3 gap-3 pt-3 border-t border-nms-border">
                <div>
                  <label className="nms-label text-xs">
                    <LabelWithTooltip tooltip={PLMN_INPUT_TOOLTIPS.mme_gid}>MME GID</LabelWithTooltip>
                  </label>
                  <input
                    type="number"
                    placeholder="2"
                    min={0}
                    max={65535}
                    value={plmn.mme_gid ?? 2}
                    onChange={(e) => updatePlmn(index, 'mme_gid', parseInt(e.target.value) || 2)}
                    className="nms-input"
                  />
                </div>
                <div>
                  <label className="nms-label text-xs">
                    <LabelWithTooltip tooltip={PLMN_INPUT_TOOLTIPS.mme_code}>MME Code</LabelWithTooltip>
                  </label>
                  <input
                    type="number"
                    placeholder="1"
                    min={0}
                    max={255}
                    value={plmn.mme_code ?? 1}
                    onChange={(e) => updatePlmn(index, 'mme_code', parseInt(e.target.value) || 1)}
                    className="nms-input"
                  />
                </div>
                <div>
                  <label className="nms-label text-xs">
                    <LabelWithTooltip tooltip={PLMN_INPUT_TOOLTIPS.tac}>TAC</LabelWithTooltip>
                  </label>
                  <input
                    type="number"
                    placeholder="1"
                    min={0}
                    max={65535}
                    value={plmn.tac ?? 1}
                    onChange={(e) => updatePlmn(index, 'tac', parseInt(e.target.value) || 1)}
                    className="nms-input"
                  />
                </div>
              </div>
            )}

            {showAdvanced && mode === '5g' && (
              <div className="pt-3 border-t border-nms-border">
                <div>
                  <label className="nms-label text-xs">
                    <LabelWithTooltip tooltip={PLMN_INPUT_TOOLTIPS.tac}>TAC</LabelWithTooltip>
                  </label>
                  <input
                    type="number"
                    placeholder="1"
                    min={0}
                    max={65535}
                    value={plmn.tac ?? 1}
                    onChange={(e) => updatePlmn(index, 'tac', parseInt(e.target.value) || 1)}
                    className="nms-input"
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {showAdvanced && mode === '4g' && (
        <p className="text-xs text-nms-text-dim mt-2">
          💡 Tip: All MMEs in same pool should have same MME GID. Each MME needs unique MME Code.
        </p>
      )}
    </div>
  );
};
