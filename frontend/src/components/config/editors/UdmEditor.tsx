import type { AllConfigs } from '../../../types';
import { LoggerSection, SbiClientSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function UdmEditor({ configs, onChange }: Props): JSX.Element {
  const fullYaml = configs.udm as any;
  const udm = fullYaml.udm || {};

  if (!udm?.sbi?.server || udm.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading UDM configuration...</div>;
  }

  const server = udm.sbi.server[0] || { address: '127.0.0.12', port: 7777 };

  const updateUdm = (partial: any) => {
    onChange({ ...configs, udm: { ...fullYaml, udm: { ...udm, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, udm: { ...fullYaml, logger } });
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
              onChange={(e) => updateUdm({ sbi: { ...udm.sbi, server: [{ ...server, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={server.port}
              onChange={(e) => updateUdm({ sbi: { ...udm.sbi, server: [{ ...server, port: parseInt(e.target.value) || 7777 }] } })}
            />
          </div>
        </div>
      </div>

      <SbiClientSection
        client={udm.sbi?.client}
        onChange={(client) => updateUdm({ sbi: { ...udm.sbi, client } })}
      />

      {udm.hnet && udm.hnet.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">
            Home Network Public Keys
          </h3>
          <div className="text-xs text-nms-text-dim">
            {udm.hnet.length} key(s) configured
          </div>
        </div>
      )}

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
