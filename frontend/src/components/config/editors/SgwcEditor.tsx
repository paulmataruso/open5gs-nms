import type { AllConfigs } from '../../../types';
import { LoggerSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function SgwcEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.sgwc as any;
  const sgwc = fullYaml.sgwc || {};
  
  if (!sgwc?.gtpc?.server || sgwc.gtpc.server.length === 0) {
    return <div className="text-nms-text-dim">Loading SGWC configuration...</div>;
  }
  
  const gtpcServer = sgwc.gtpc.server[0] || { address: '127.0.0.3' };
  const pfcpServer = sgwc.pfcp?.server?.[0] || { address: '127.0.0.3', port: 8805 };

  const updateSgwc = (partial: any) => {
    onChange({ ...configs, sgwc: { ...fullYaml, sgwc: { ...sgwc, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, sgwc: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-C Server</h3>
        <div>
          <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_address}>Address</LabelWithTooltip></label>
          <input
            className="nms-input font-mono text-xs"
            value={gtpcServer.address}
            onChange={(e) => updateSgwc({ gtpc: { server: [{ address: e.target.value }] } })}
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">PFCP Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label">Address</label>
            <input
              className="nms-input font-mono text-xs"
              value={pfcpServer.address}
              onChange={(e) => updateSgwc({ pfcp: { ...sgwc.pfcp, server: [{ ...pfcpServer, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={pfcpServer.port || 8805}
              onChange={(e) => updateSgwc({ pfcp: { ...sgwc.pfcp, server: [{ ...pfcpServer, port: parseInt(e.target.value) || 8805 }] } })}
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">PFCP Client</h3>
        <div>
          <label className="nms-label">SGWU Address</label>
          <input
            className="nms-input font-mono text-xs"
            value={sgwc.pfcp?.client?.sgwu?.[0]?.address || ''}
            onChange={(e) => updateSgwc({ pfcp: { ...sgwc.pfcp, client: { ...sgwc.pfcp.client, sgwu: [{ address: e.target.value }] } } })}
            placeholder="127.0.0.6"
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
