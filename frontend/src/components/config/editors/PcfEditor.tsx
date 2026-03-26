import type { AllConfigs } from '../../../types';
import { LoggerSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function PcfEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.pcf as any;
  const pcf = fullYaml.pcf || {};
  
  if (!pcf?.sbi?.server || pcf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading PCF configuration...</div>;
  }
  
  const server = pcf.sbi.server[0] || { address: '127.0.0.13', port: 7777 };
  const scpUri = pcf.sbi?.client?.scp?.[0]?.uri || '';

  const updatePcf = (partial: any) => {
    onChange({ ...configs, pcf: { ...fullYaml, pcf: { ...pcf, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, pcf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      {fullYaml.db_uri !== undefined && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Database</h3>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.mongodb_uri}>MongoDB URI</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={fullYaml.db_uri || 'mongodb://localhost/open5gs'}
              onChange={(e) => onChange({ ...configs, pcf: { ...fullYaml, db_uri: e.target.value } })}
              placeholder="mongodb://localhost/open5gs"
            />
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_address}>Address</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={server.address}
              onChange={(e) => updatePcf({ sbi: { ...pcf.sbi, server: [{ ...server, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={server.port}
              onChange={(e) => updatePcf({ sbi: { ...pcf.sbi, server: [{ ...server, port: parseInt(e.target.value) || 7777 }] } })}
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SCP Client</h3>
        <div>
          <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.scp_uri}>SCP URI</LabelWithTooltip></label>
          <input
            className="nms-input font-mono text-xs"
            value={scpUri}
            onChange={(e) => updatePcf({ sbi: { ...pcf.sbi, client: { ...pcf.sbi.client, scp: [{ uri: e.target.value }] } } })}
            placeholder="http://127.0.0.200:7777"
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
