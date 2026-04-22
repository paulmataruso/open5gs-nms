import type { AllConfigs } from '../../../types';
import { LoggerSection, SbiClientSection } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';
import { Plus, X } from 'lucide-react';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function NssfEditor({ configs, onChange }: Props): JSX.Element {
  const fullYaml = configs.nssf as any;
  const nssf = fullYaml.nssf || {};

  if (!nssf?.sbi?.server || nssf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading NSSF configuration...</div>;
  }

  const server = nssf.sbi.server[0] || { address: '127.0.0.14', port: 7777 };
  // NSI entries: each is { uri, s_nssai: { sst, sd? } }
  const nsiClients: any[] = nssf.sbi?.client?.nsi || [];

  const updateNssf = (partial: any) => {
    onChange({ ...configs, nssf: { ...fullYaml, nssf: { ...nssf, ...partial } } });
  };

  const updateNsiList = (updated: any[]) => {
    updateNssf({ sbi: { ...nssf.sbi, client: { ...nssf.sbi.client, nsi: updated } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, nssf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      {/* SBI Server */}
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

      {/* SBI Client — NRF / SCP */}
      <SbiClientSection
        client={nssf.sbi?.client}
        onChange={(client) => updateNssf({ sbi: { ...nssf.sbi, client: { ...nssf.sbi.client, ...client } } })}
      />

      {/* NSI Clients */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <div>
            <h3 className="text-sm font-semibold font-display text-nms-accent">NSI Clients</h3>
            <p className="text-xs text-nms-text-dim mt-0.5">
              Each entry maps one NRF URI to one network slice. Add one entry per slice.
              SD will be quoted in the YAML (e.g. <span className="font-mono">sd: "000001"</span>).
            </p>
          </div>
          <button
            onClick={() => updateNsiList([...nsiClients, { uri: 'http://127.0.0.10:7777', s_nssai: { sst: 1 } }])}
            className="nms-btn-ghost text-xs flex items-center gap-1 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> Add NSI Entry
          </button>
        </div>

        {nsiClients.length === 0 && (
          <div className="text-xs text-nms-text-dim italic px-3 py-2 border border-dashed border-nms-border rounded">
            No NSI clients configured. Click "Add NSI Entry" to map an NRF to a network slice.
          </div>
        )}

        {nsiClients.map((nsi: any, i: number) => {
          const sst = nsi.s_nssai?.sst ?? 1;
          const sd  = nsi.s_nssai?.sd  ?? '';

          const updateEntry = (uri: string, newSst: number, newSd: string) => {
            const updated = [...nsiClients];
            const snssai: any = { sst: newSst };
            if (newSd) snssai.sd = newSd;
            updated[i] = { uri, s_nssai: snssai };
            updateNsiList(updated);
          };

          return (
            <div key={i} className="relative border border-nms-border rounded-lg p-4 mb-2 bg-nms-surface-2/20">
              <button
                onClick={() => updateNsiList(nsiClients.filter((_: any, idx: number) => idx !== i))}
                className="absolute top-3 right-3 text-nms-text-dim hover:text-nms-red transition-colors"
                title="Remove NSI entry"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-3">
                NSI {i + 1}
              </div>

              {/* URI */}
              <div className="mb-3">
                <label className="nms-label">NRF URI</label>
                <input
                  className="nms-input font-mono text-xs w-full"
                  value={nsi.uri || ''}
                  onChange={(e) => updateEntry(e.target.value, sst, sd)}
                  placeholder="http://127.0.0.10:7777"
                />
              </div>

              {/* SST + SD */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="nms-label">SST (Slice/Service Type)</label>
                  <input
                    type="number"
                    className="nms-input font-mono text-xs"
                    value={sst}
                    min={1}
                    max={255}
                    onChange={(e) => updateEntry(nsi.uri || '', parseInt(e.target.value) || 1, sd)}
                    placeholder="1"
                  />
                </div>
                <div>
                  <label className="nms-label">SD (optional, 6 hex chars)</label>
                  <input
                    className="nms-input font-mono text-xs"
                    value={sd}
                    onChange={(e) => {
                      const cleaned = e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
                      updateEntry(nsi.uri || '', sst, cleaned);
                    }}
                    placeholder="000001"
                  />
                  {sd && (
                    <p className="text-xs text-nms-text-dim mt-1">
                      Will be written as <span className="font-mono text-nms-text">sd: "{sd}"</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
