import type { AllConfigs } from '../../../types';
import { LoggerSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function HssEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.hss as any;
  const hss = fullYaml.hss || {};
  
  if (!hss?.freeDiameter) {
    return <div className="text-nms-text-dim">Loading HSS configuration...</div>;
  }

  const updateHss = (partial: any) => {
    onChange({ ...configs, hss: { ...fullYaml, hss: { ...hss, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, hss: { ...fullYaml, logger } });
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
              onChange={(e) => onChange({ ...configs, hss: { ...fullYaml, db_uri: e.target.value } })}
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
            value={hss.freeDiameter || '/etc/freeDiameter/hss.conf'}
            onChange={(e) => updateHss({ freeDiameter: e.target.value })}
            placeholder="/etc/freeDiameter/hss.conf"
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
