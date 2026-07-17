import type { AllConfigs } from '../../../types';
import { LoggerSection, SbiClientSection, FunctionInfoBox } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function UdrEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.udr as any;
  const udr = fullYaml.udr || {};
  
  if (!udr?.sbi?.server || udr.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading UDR configuration...</div>;
  }
  
  const server = udr.sbi.server[0] || { address: '127.0.0.20', port: 7777 };

  const updateUdr = (partial: any) => {
    onChange({ ...configs, udr: { ...fullYaml, udr: { ...udr, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, udr: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <FunctionInfoBox
        title="Unified Data Repository (UDR)"
        generation="5G"
        description="The UDR is the raw storage backend for all 5G subscriber data. It acts as a structured database service that the UDM (N35) and PCF (N36) query to read and write subscriber profiles, authentication credentials, and policy data. The UDR has no business logic — it is a pure storage layer backed by MongoDB in Open5GS."
      />
      {fullYaml.db_uri !== undefined && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Database</h3>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.mongodb_uri}>MongoDB URI</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={fullYaml.db_uri || 'mongodb://localhost/open5gs'}
              onChange={(e) => onChange({ ...configs, udr: { ...fullYaml, db_uri: e.target.value } })}
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
              onChange={(e) => updateUdr({ sbi: { ...udr.sbi, server: [{ ...server, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={server.port}
              onChange={(e) => updateUdr({ sbi: { ...udr.sbi, server: [{ ...server, port: parseInt(e.target.value) || 7777 }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_advertise}>Advertise (optional)</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={server.advertise || ''}
              onChange={(e) => updateUdr({ sbi: { ...udr.sbi, server: [{ ...server, advertise: e.target.value || undefined }] } })}
              placeholder="udr.5gc.mnc070.mcc999.3gppnetwork.org:7777"
            />
          </div>
        </div>
      </div>

      <SbiClientSection
        client={udr.sbi?.client}
        onChange={(client) => updateUdr({ sbi: { ...udr.sbi, client } })}
      />

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
