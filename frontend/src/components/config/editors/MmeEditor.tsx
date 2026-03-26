import type { AllConfigs } from '../../../types';
import { LoggerSection } from './SharedComponents';
import { Plus, X } from 'lucide-react';
import { FieldWithTooltip } from '../FieldsWithTooltips';
import { MME_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

export function MmeEditor({ configs, onChange }: Props): JSX.Element {
  // configs.mme is the full YAML: { mme: {...}, logger: {...}, global: {...} }
  const fullYaml = configs.mme as any;
  const mme = fullYaml.mme || {};

  const updateMme = (partial: any) => {
    onChange({ ...configs, mme: { ...fullYaml, mme: { ...mme, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, mme: { ...fullYaml, logger } });
  };

  const s1apServer = mme.s1ap?.server?.[0] || { address: '10.0.1.175' };
  const gtpcServer = mme.gtpc?.server?.[0] || { address: '127.0.0.2' };

  return (
    <div className="space-y-6">
      {mme.freeDiameter && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">
            FreeDiameter Configuration
          </h3>
          <FieldWithTooltip
            label="Config File Path"
            value={mme.freeDiameter}
            onChange={(v) => updateMme({ freeDiameter: v })}
            placeholder="/etc/freeDiameter/mme.conf"
            tooltip={MME_TOOLTIPS.freediameter}
          />
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">S1AP Server</h3>
        <FieldWithTooltip
          label="Address"
          value={s1apServer.address}
          onChange={(v) => {
            const updated = { ...mme, s1ap: { server: [{ address: v }] } };
            updateMme(updated);
          }}
          placeholder="10.0.1.175"
          tooltip={MME_TOOLTIPS.s1ap_address}
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-C Server</h3>
        <FieldWithTooltip
          label="Server Address"
          value={gtpcServer.address}
          onChange={(v) => {
            const updated = { ...mme, gtpc: { ...mme.gtpc, server: [{ address: v }] } };
            updateMme(updated);
          }}
          placeholder="127.0.0.2"
          tooltip={MME_TOOLTIPS.gtpc_server}
        />
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-C Clients</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip
            label="SGWC Address"
            value={mme.gtpc?.client?.sgwc?.[0]?.address || ''}
            onChange={(v) => {
              const updated = { ...mme, gtpc: { ...mme.gtpc, client: { ...mme.gtpc?.client, sgwc: [{ address: v }] } } };
              updateMme(updated);
            }}
            placeholder="127.0.0.3"
            tooltip={MME_TOOLTIPS.gtpc_sgwc}
          />
          <FieldWithTooltip
            label="SMF Address"
            value={mme.gtpc?.client?.smf?.[0]?.address || ''}
            onChange={(v) => {
              const updated = { ...mme, gtpc: { ...mme.gtpc, client: { ...mme.gtpc?.client, smf: [{ address: v }] } } };
              updateMme(updated);
            }}
            placeholder="127.0.0.4"
            tooltip={MME_TOOLTIPS.gtpc_smf}
          />
        </div>
      </div>

      {mme.metrics && mme.metrics.server && mme.metrics.server.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Metrics</h3>
          <div className="text-xs font-mono text-nms-text-dim">
            {mme.metrics.server[0].address}:{mme.metrics.server[0].port}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold font-display text-nms-accent">GUMMEI</h3>
          <button
            onClick={() => {
              const newEntry = {
                plmn_id: { mcc: '001', mnc: '01' },
                mme_gid: 2,
                mme_code: 1,
              };
              updateMme({ gummei: [...mme.gummei, newEntry] });
            }}
            className="nms-btn-ghost text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add PLMN
          </button>
        </div>
        {mme.gummei.map((g: any, i: number) => (
          <div key={i} className="relative border border-nms-border rounded-lg p-3 mb-2">
            {mme.gummei.length > 1 && (
              <button
                onClick={() => {
                  const updated = mme.gummei.filter((_: any, idx: number) => idx !== i);
                  updateMme({ gummei: updated });
                }}
                className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                title="Remove PLMN"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <div className="grid grid-cols-4 gap-4">
              <FieldWithTooltip
                label="MCC"
                value={g.plmn_id.mcc}
                onChange={(v) => {
                  const updated = [...mme.gummei];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mcc: v } };
                  updateMme({ gummei: updated });
                }}
                tooltip={MME_TOOLTIPS.gummei_mcc}
              />
              <FieldWithTooltip
                label="MNC"
                value={g.plmn_id.mnc}
                onChange={(v) => {
                  const updated = [...mme.gummei];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mnc: v } };
                  updateMme({ gummei: updated });
                }}
                tooltip={MME_TOOLTIPS.gummei_mnc}
              />
              <FieldWithTooltip
                label="MME GID"
                type="number"
                value={g.mme_gid}
                onChange={(v) => {
                  const updated = [...mme.gummei];
                  updated[i] = { ...updated[i], mme_gid: parseInt(v) || 2 };
                  updateMme({ gummei: updated });
                }}
                placeholder="2"
                tooltip={MME_TOOLTIPS.mme_gid}
              />
              <FieldWithTooltip
                label="MME Code"
                type="number"
                value={g.mme_code}
                onChange={(v) => {
                  const updated = [...mme.gummei];
                  updated[i] = { ...updated[i], mme_code: parseInt(v) || 1 };
                  updateMme({ gummei: updated });
                }}
                placeholder="1"
                tooltip={MME_TOOLTIPS.mme_code}
              />
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold font-display text-nms-accent">TAI</h3>
          <button
            onClick={() => {
              const newEntry = {
                plmn_id: { mcc: '001', mnc: '01' },
                tac: 1,
              };
              updateMme({ tai: [...mme.tai, newEntry] });
            }}
            className="nms-btn-ghost text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add TAI
          </button>
        </div>
        {mme.tai.map((t: any, i: number) => (
          <div key={i} className="relative border border-nms-border rounded-lg p-3 mb-2">
            {mme.tai.length > 1 && (
              <button
                onClick={() => {
                  const updated = mme.tai.filter((_: any, idx: number) => idx !== i);
                  updateMme({ tai: updated });
                }}
                className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                title="Remove TAI"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            <div className="grid grid-cols-3 gap-4">
              <FieldWithTooltip
                label="MCC"
                value={t.plmn_id.mcc}
                onChange={(v) => {
                  const updated = [...mme.tai];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mcc: v } };
                  updateMme({ tai: updated });
                }}
                tooltip={MME_TOOLTIPS.tai_mcc}
              />
              <FieldWithTooltip
                label="MNC"
                value={t.plmn_id.mnc}
                onChange={(v) => {
                  const updated = [...mme.tai];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mnc: v } };
                  updateMme({ tai: updated });
                }}
                tooltip={MME_TOOLTIPS.tai_mnc}
              />
              <FieldWithTooltip
                label="TAC"
                type="number"
                value={Array.isArray(t.tac) ? t.tac[0] : t.tac}
                onChange={(v) => {
                  const updated = [...mme.tai];
                  updated[i] = { ...updated[i], tac: parseInt(v) || 1 };
                  updateMme({ tai: updated });
                }}
                placeholder="1"
                tooltip={MME_TOOLTIPS.tai_tac}
              />
            </div>
          </div>
        ))}
      </div>

      {mme.security && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Security Algorithms</h3>
          <div className="text-xs font-mono text-nms-text-dim space-y-1">
            <div>Integrity: {mme.security.integrity_order?.join(', ') || 'Not configured'}</div>
            <div>Ciphering: {mme.security.ciphering_order?.join(', ') || 'Not configured'}</div>
          </div>
        </div>
      )}

      {mme.network_name && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Network Name</h3>
          <div className="grid grid-cols-2 gap-4">
            <FieldWithTooltip
              label="Full Name"
              value={mme.network_name.full || ''}
              onChange={(v) => updateMme({ network_name: { ...mme.network_name, full: v } })}
              tooltip={MME_TOOLTIPS.network_name_full}
            />
            <FieldWithTooltip
              label="Short Name"
              value={mme.network_name.short || ''}
              onChange={(v) => updateMme({ network_name: { ...mme.network_name, short: v } })}
              tooltip={MME_TOOLTIPS.network_name_short}
            />
          </div>
        </div>
      )}

      {mme.mme_name !== undefined && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">MME Name</h3>
          <FieldWithTooltip
            label="MME Name"
            value={mme.mme_name || ''}
            onChange={(v) => updateMme({ mme_name: v })}
            placeholder="open5gs-mme0"
            tooltip={MME_TOOLTIPS.mme_name}
          />
        </div>
      )}

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
