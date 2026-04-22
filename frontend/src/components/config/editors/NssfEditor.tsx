import type { AllConfigs } from '../../../types';
import { LoggerSection, SbiClientSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function NssfEditor({ configs, onChange }: Props): JSX.Element {
  // Extract nested service section from full YAML
  const fullYaml = configs.nssf as any;
  const nssf = fullYaml.nssf || {};
  
  if (!nssf?.sbi?.server || nssf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading NSSF configuration...</div>;
  }
  
  const server = nssf.sbi.server[0] || { address: '127.0.0.14', port: 7777 };
  const nsiClients = nssf.sbi?.client?.nsi || [];

  const updateNssf = (partial: any) => {
    onChange({ ...configs, nssf: { ...fullYaml, nssf: { ...nssf, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, nssf: { ...fullYaml, logger } });
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
              onChange={(e) => updateNssf({ sbi: { ...nssf.sbi, server: [{ ...server, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={server.port}
              onChange={(e) => updateNssf({ sbi: { ...nssf.sbi, server: [{ ...server, port: parseInt(e.target.value) || 7777 }] } })}
            />
          </div>
        </div>
      </div>

      <SbiClientSection
        client={nssf.sbi?.client}
        onChange={(client) => updateNssf({ sbi: { ...nssf.sbi, client: { ...nssf.sbi.client, ...client } } })}
      />

      {nsiClients.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">NSI Clients</h3>
          {nsiClients.map((n: any, i: number) => (
            <div key={i} className="grid grid-cols-2 gap-4 mb-2">
              <div>
                <label className="nms-label">NSI URI</label>
                <input
                  className="nms-input font-mono text-xs"
                  value={n.uri || ''}
                  onChange={(e) => {
                    const updated = [...nssf.sbi.client.nsi];
                    updated[i] = { ...updated[i], uri: e.target.value };
                    updateNssf({ sbi: { ...nssf.sbi, client: { ...nssf.sbi.client, nsi: updated } } });
                  }}
                  placeholder="http://127.0.0.10:7777"
                />
              </div>
              <div>
                <label className="nms-label">S-NSSAI SST</label>
                <input
                  type="number"
                  className="nms-input font-mono text-xs"
                  value={n.s_nssai?.sst || 1}
                  onChange={(e) => {
                    const updated = [...nssf.sbi.client.nsi];
                    updated[i] = { ...updated[i], s_nssai: { sst: parseInt(e.target.value) || 1 } };
                    updateNssf({ sbi: { ...nssf.sbi, client: { ...nssf.sbi.client, nsi: updated } } });
                  }}
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
