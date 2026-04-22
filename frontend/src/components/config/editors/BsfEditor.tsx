import type { AllConfigs } from '../../../types';
import { LoggerSection, SbiClientSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function BsfEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.bsf as any;
  const bsf = fullYaml.bsf || {};
  
  if (!bsf?.sbi?.server || bsf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading BSF configuration...</div>;
  }
  
  const server = bsf.sbi.server[0] || { address: '127.0.0.15', port: 7777 };

  const updateBsf = (partial: any) => {
    onChange({ ...configs, bsf: { ...fullYaml, bsf: { ...bsf, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, bsf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_address}>Address</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={server.address}
              onChange={(e) => updateBsf({ sbi: { ...bsf.sbi, server: [{ ...server, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={server.port}
              onChange={(e) => updateBsf({ sbi: { ...bsf.sbi, server: [{ ...server, port: parseInt(e.target.value) || 7777 }] } })}
            />
          </div>
        </div>
      </div>

      <SbiClientSection
        client={bsf.sbi?.client}
        onChange={(client) => updateBsf({ sbi: { ...bsf.sbi, client } })}
      />

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
