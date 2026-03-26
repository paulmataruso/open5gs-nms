import type { AllConfigs } from '../../../types';
import { LoggerSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function SgwuEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.sgwu as any;
  const sgwu = fullYaml.sgwu || {};
  
  if (!sgwu?.pfcp?.server || sgwu.pfcp.server.length === 0) {
    return <div className="text-nms-text-dim">Loading SGWU configuration...</div>;
  }
  
  const pfcpServer = sgwu.pfcp.server[0] || { address: '127.0.0.6', port: 8805 };
  const gtpuServer = sgwu.gtpu?.server?.[0] || { address: '10.0.1.175', port: 2152 };

  const updateSgwu = (partial: any) => {
    onChange({ ...configs, sgwu: { ...fullYaml, sgwu: { ...sgwu, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, sgwu: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">PFCP Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_address}>Address</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={pfcpServer.address}
              onChange={(e) => updateSgwu({ pfcp: { server: [{ ...pfcpServer, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={pfcpServer.port || 8805}
              onChange={(e) => updateSgwu({ pfcp: { server: [{ ...pfcpServer, port: parseInt(e.target.value) || 8805 }] } })}
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-U Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label">Address</label>
            <input
              className="nms-input font-mono text-xs"
              value={gtpuServer.address}
              onChange={(e) => updateSgwu({ gtpu: { server: [{ ...gtpuServer, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label">Port</label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={gtpuServer.port || 2152}
              onChange={(e) => updateSgwu({ gtpu: { server: [{ ...gtpuServer, port: parseInt(e.target.value) || 2152 }] } })}
            />
          </div>
        </div>
      </div>

      {fullYaml.session && fullYaml.session.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Session Pools</h3>
          {fullYaml.session.map((sess: any, i: number) => (
            <div key={i} className="grid grid-cols-2 gap-4 mb-2">
              <div>
                <label className="nms-label">Subnet</label>
                <input
                  className="nms-input font-mono text-xs"
                  value={sess.subnet || ''}
                  onChange={(e) => {
                    const updated = [...fullYaml.session];
                    updated[i] = { ...updated[i], subnet: e.target.value };
                    onChange({ ...configs, sgwu: { ...fullYaml, session: updated } });
                  }}
                  placeholder="10.45.0.0/16"
                />
              </div>
              <div>
                <label className="nms-label">Gateway</label>
                <input
                  className="nms-input font-mono text-xs"
                  value={sess.gateway || ''}
                  onChange={(e) => {
                    const updated = [...fullYaml.session];
                    updated[i] = { ...updated[i], gateway: e.target.value };
                    onChange({ ...configs, sgwu: { ...fullYaml, session: updated } });
                  }}
                  placeholder="10.45.0.1"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
