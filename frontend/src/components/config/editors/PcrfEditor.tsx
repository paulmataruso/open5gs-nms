import type { AllConfigs } from '../../../types';
import { LoggerSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function PcrfEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.pcrf as any;
  const pcrf = fullYaml.pcrf || {};
  
  if (!pcrf?.freeDiameter) {
    return <div className="text-nms-text-dim">Loading PCRF configuration...</div>;
  }

  const updatePcrf = (partial: any) => {
    onChange({ ...configs, pcrf: { ...fullYaml, pcrf: { ...pcrf, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, pcrf: { ...fullYaml, logger } });
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
              onChange={(e) => onChange({ ...configs, pcrf: { ...fullYaml, db_uri: e.target.value } })}
              placeholder="mongodb://localhost/open5gs"
            />
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">FreeDiameter Configuration</h3>
        <div>
          <label className="nms-label">Config File Path</label>
          <input
            className="nms-input font-mono text-xs"
            value={pcrf.freeDiameter || '/etc/freeDiameter/pcrf.conf'}
            onChange={(e) => updatePcrf({ freeDiameter: e.target.value })}
            placeholder="/etc/freeDiameter/pcrf.conf"
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
