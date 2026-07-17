import type { AllConfigs } from '../../../types';
import { LoggerSection, FunctionInfoBox } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function ScpEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.scp as any;
  const scp = fullYaml.scp || {};
  
  if (!scp?.sbi?.server || scp.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading SCP configuration...</div>;
  }
  
  const server = scp.sbi.server[0] || { address: '127.0.0.200', port: 7777 };

  const updateScp = (partial: any) => {
    onChange({ ...configs, scp: { ...fullYaml, scp: { ...scp, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, scp: { ...fullYaml, logger } });
  };

  const nrfUri = scp.sbi?.client?.nrf?.[0]?.uri || '';

  return (
    <div className="space-y-6">
      <FunctionInfoBox
        title="Service Communication Proxy (SCP)"
        generation="5G"
        description="The SCP is a service mesh proxy for 5G core NF-to-NF communication. Instead of NFs calling each other directly (via NRF discovery), they route all requests through the SCP, which handles service discovery, load balancing, and routing on their behalf. This is the 3GPP Release 16 'indirect communication' model. The SCP is optional — small deployments typically use direct NRF communication instead."
      />
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_address}>Address</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={server.address}
              onChange={(e) => updateScp({ sbi: { ...scp.sbi, server: [{ ...server, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={server.port}
              onChange={(e) => updateScp({ sbi: { ...scp.sbi, server: [{ ...server, port: parseInt(e.target.value) || 7777 }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_advertise}>Advertise (optional)</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={server.advertise || ''}
              onChange={(e) => updateScp({ sbi: { ...scp.sbi, server: [{ ...server, advertise: e.target.value || undefined }] } })}
              placeholder="scp.5gc.mnc070.mcc999.3gppnetwork.org:7777"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">NRF Client</h3>
        <div>
          <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.nrf_uri}>NRF URI</LabelWithTooltip></label>
          <input
            className="nms-input font-mono text-xs"
            value={nrfUri}
            onChange={(e) => updateScp({ sbi: { ...scp.sbi, client: { ...scp.sbi.client, nrf: [{ uri: e.target.value }] } } })}
            placeholder="http://127.0.0.10:7777"
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
