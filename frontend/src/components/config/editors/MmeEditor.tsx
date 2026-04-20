import type { AllConfigs } from '../../../types';
import { LoggerSection } from './SharedComponents';
import { Plus, X } from 'lucide-react';
import { FieldWithTooltip } from '../FieldsWithTooltips';
import { MME_TOOLTIPS, COMMON_TOOLTIPS } from '../../../data/tooltips';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

// Returns true if value looks like an IPv4, IPv6, or has no dots/colons (pure hostname)
const isHostname = (val: string): boolean => {
  if (!val) return false;
  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(val)) return false;
  // IPv6
  if (val.includes(':')) return false;
  // Has a dot — likely a hostname/FQDN
  return val.includes('.');
};

// Default empty map object (Open5GS expects map as an object, NOT an array)
const defaultMap = () => ({
  tai: { plmn_id: { mcc: '001', mnc: '01' }, tac: 1 },
  lai: { plmn_id: { mcc: '001', mnc: '01' }, lac: 1 },
});

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

  // Update a TAI or LAI field within a client's map object.
  // Open5GS map is a plain object { tai: {...}, lai: {...} }, NOT an array.
  const updateMapField = (
    clientIdx: number,
    isFirstAndEmpty: boolean,
    side: 'tai' | 'lai',
    subfield: 'mcc' | 'mnc' | 'tac' | 'lac',
    value: string,
  ) => {
    const numVal = parseInt(value) || 1;
    if (isFirstAndEmpty) {
      const m = defaultMap();
      if (subfield === 'tac' || subfield === 'lac') {
        (m[side] as any)[subfield] = numVal;
      } else {
        m[side].plmn_id[subfield as 'mcc' | 'mnc'] = value;
      }
      updateMme({ sgsap: { client: [{ address: '', local_address: '', map: m }] } });
    } else {
      const updated = [...(mme.sgsap?.client || [])];
      const existingMap = updated[clientIdx].map || defaultMap();
      const newMap = {
        ...existingMap,
        [side]: {
          ...existingMap[side],
          ...(subfield === 'tac' || subfield === 'lac'
            ? { [subfield]: numVal }
            : { plmn_id: { ...existingMap[side]?.plmn_id, [subfield]: value } }),
        },
      };
      updated[clientIdx] = { ...updated[clientIdx], map: newMap };
      updateMme({ sgsap: { client: updated } });
    }
  };

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

      {/* SGs-AP Configuration (CSFB) */}
      <div>
        <div className="mb-3">
          <h3 className="text-sm font-semibold font-display text-nms-accent">SGs-AP Configuration (Circuit Switched FallBack)</h3>
          <p className="text-xs text-nms-text-dim mt-1">
            {MME_TOOLTIPS.sgsap_overview}
          </p>
        </div>

        {/* Render clients — always show at least one placeholder row */}
        {(mme.sgsap?.client?.length > 0 ? mme.sgsap.client : [null]).map((client: any, clientIdx: number) => {
          const isFirstAndEmpty = client === null;
          const actualClient = client || {};
          // map is a plain object { tai, lai } — NOT an array
          // hasRealMap = true only when the client actually has saved map data
          const hasRealMap = !isFirstAndEmpty && actualClient.map != null;
          const mapping: any = hasRealMap ? actualClient.map : defaultMap();

          // Helper: return real value if map data exists, otherwise '' so placeholder shows
          const mapVal = (val: any) => hasRealMap ? (val ?? '') : '';

          return (
            <div key={clientIdx} className="relative border border-nms-border rounded-lg p-4 mb-4 bg-nms-surface-2/30">
              {!isFirstAndEmpty && mme.sgsap?.client?.length > 1 && (
                <button
                  onClick={() => {
                    const updated = (mme.sgsap?.client || []).filter((_: any, idx: number) => idx !== clientIdx);
                    updateMme({ sgsap: { client: updated } });
                  }}
                  className="absolute top-3 right-3 text-nms-text-dim hover:text-nms-red transition-colors"
                  title="Remove MSC/VLR Client"
                >
                  <X className="w-4 h-4" />
                </button>
              )}

              <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-3">
                MSC/VLR Client {clientIdx + 1}
              </div>

              {/* Server and Local Addresses */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <FieldWithTooltip
                  label="MSC/VLR Server Address"
                  value={isFirstAndEmpty ? '' : (Array.isArray(actualClient.address) ? actualClient.address.join(', ') : actualClient.address || '')}
                  onChange={(v) => {
                    if (isFirstAndEmpty) {
                      updateMme({ sgsap: { client: [{ address: v, local_address: '', map: defaultMap() }] } });
                    } else {
                      const updated = [...(mme.sgsap?.client || [])];
                      updated[clientIdx] = { ...updated[clientIdx], address: v };
                      updateMme({ sgsap: { client: updated } });
                    }
                  }}
                  placeholder="msc.open5gs.org or 127.0.0.88"
                  tooltip={MME_TOOLTIPS.sgsap_server_address}
                />
                {/* Warn if hostname — Open5GS resolves at startup, unresolvable = fatal crash */}
                {isHostname(isFirstAndEmpty ? '' : (Array.isArray(actualClient.address) ? actualClient.address[0] : actualClient.address || '')) && (
                  <div className="col-span-2 flex items-start gap-2 mt-1 px-3 py-2 rounded bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 text-xs">
                    <span className="mt-0.5">⚠</span>
                    <span>
                      <strong>Hostname detected.</strong> Open5GS MME resolves this address via DNS at startup.
                      If <code className="font-mono bg-black/20 px-1 rounded">{Array.isArray(actualClient.address) ? actualClient.address[0] : actualClient.address}</code> is
                      not resolvable from the MME host at boot time, the MME will abort with a fatal error.
                      Use an IP address if DNS is not guaranteed.
                    </span>
                  </div>
                )}
                <FieldWithTooltip
                  label="MME Local Address"
                  value={isFirstAndEmpty ? '' : (Array.isArray(actualClient.local_address) ? actualClient.local_address.join(', ') : actualClient.local_address || '')}
                  onChange={(v) => {
                    if (isFirstAndEmpty) {
                      updateMme({ sgsap: { client: [{ address: '', local_address: v, map: defaultMap() }] } });
                    } else {
                      const updated = [...(mme.sgsap?.client || [])];
                      updated[clientIdx] = { ...updated[clientIdx], local_address: v };
                      updateMme({ sgsap: { client: updated } });
                    }
                  }}
                  placeholder="127.0.0.2"
                  tooltip={MME_TOOLTIPS.sgsap_local_address}
                />
              </div>

              {/* TAI → LAI Mapping */}
              <div>
                <div className="mb-3">
                  <h4 className="text-sm font-semibold text-nms-text">TAI → LAI Mapping</h4>
                  <p className="text-xs text-nms-text-dim mt-0.5">
                    {MME_TOOLTIPS.sgsap_mapping_explanation}
                  </p>
                </div>

                {/* 4G TAI section */}
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                    <h5 className="text-xs font-semibold text-blue-400 uppercase tracking-wider">
                      4G Tracking Area (TAI)
                    </h5>
                  </div>
                  <p className="text-xs text-nms-text-dim mb-2 ml-5">
                    {MME_TOOLTIPS.sgsap_tai_header}
                  </p>
                  <div className="grid grid-cols-3 gap-3 ml-5 p-3 bg-blue-500/5 border border-blue-500/20 rounded">
                    <FieldWithTooltip
                      label="MCC"
                      value={mapVal(mapping.tai?.plmn_id?.mcc)}
                      onChange={(v) => updateMapField(clientIdx, isFirstAndEmpty, 'tai', 'mcc', v)}
                      placeholder="001"
                      tooltip={MME_TOOLTIPS.sgsap_tai_mcc}
                    />
                    <FieldWithTooltip
                      label="MNC"
                      value={mapVal(mapping.tai?.plmn_id?.mnc)}
                      onChange={(v) => updateMapField(clientIdx, isFirstAndEmpty, 'tai', 'mnc', v)}
                      placeholder="01"
                      tooltip={MME_TOOLTIPS.sgsap_tai_mnc}
                    />
                    <FieldWithTooltip
                      label="TAC"
                      type="number"
                      value={mapVal(mapping.tai?.tac)}
                      onChange={(v) => updateMapField(clientIdx, isFirstAndEmpty, 'tai', 'tac', v)}
                      placeholder="4131"
                      tooltip={MME_TOOLTIPS.sgsap_tai_tac}
                    />
                  </div>
                </div>

                {/* Arrow */}
                <div className="flex items-center justify-center my-2">
                  <div className="text-nms-text-dim text-xs font-semibold flex items-center gap-2">
                    <div className="h-px w-16 bg-nms-border"></div>
                    ▼ Maps to ▼
                    <div className="h-px w-16 bg-nms-border"></div>
                  </div>
                </div>

                {/* 2G/3G LAI section */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-3 h-3 rounded-full bg-green-500"></div>
                    <h5 className="text-xs font-semibold text-green-400 uppercase tracking-wider">
                      2G/3G Location Area (LAI)
                    </h5>
                  </div>
                  <p className="text-xs text-nms-text-dim mb-2 ml-5">
                    {MME_TOOLTIPS.sgsap_lai_header}
                  </p>
                  <div className="grid grid-cols-3 gap-3 ml-5 p-3 bg-green-500/5 border border-green-500/20 rounded">
                    <FieldWithTooltip
                      label="MCC"
                      value={mapVal(mapping.lai?.plmn_id?.mcc)}
                      onChange={(v) => updateMapField(clientIdx, isFirstAndEmpty, 'lai', 'mcc', v)}
                      placeholder="001"
                      tooltip={MME_TOOLTIPS.sgsap_lai_mcc}
                    />
                    <FieldWithTooltip
                      label="MNC"
                      value={mapVal(mapping.lai?.plmn_id?.mnc)}
                      onChange={(v) => updateMapField(clientIdx, isFirstAndEmpty, 'lai', 'mnc', v)}
                      placeholder="01"
                      tooltip={MME_TOOLTIPS.sgsap_lai_mnc}
                    />
                    <FieldWithTooltip
                      label="LAC"
                      type="number"
                      value={mapVal(mapping.lai?.lac)}
                      onChange={(v) => updateMapField(clientIdx, isFirstAndEmpty, 'lai', 'lac', v)}
                      placeholder="43691"
                      tooltip={MME_TOOLTIPS.sgsap_lai_lac}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Add Button */}
        <button
          onClick={() => {
            const newClient = { address: '', local_address: '', map: defaultMap() };
            updateMme({ sgsap: { client: [...(mme.sgsap?.client || []), newClient] } });
          }}
          className="nms-btn-ghost text-sm flex items-center gap-2 w-full justify-center py-3"
        >
          <Plus className="w-4 h-4" /> Add Additional MSC/VLR Client
        </button>
      </div>

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

      {/* Metrics Server */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Metrics Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip
            label="Address"
            value={mme.metrics?.server?.[0]?.address || ''}
            onChange={(v) => updateMme({ metrics: { server: [{ address: v, port: mme.metrics?.server?.[0]?.port || 9090 }] } })}
            tooltip={COMMON_TOOLTIPS.metrics_address}
          />
          <FieldWithTooltip
            label="Port"
            type="number"
            value={mme.metrics?.server?.[0]?.port || 9090}
            onChange={(v) => updateMme({ metrics: { server: [{ address: mme.metrics?.server?.[0]?.address || '', port: parseInt(v) || 9090 }] } })}
            tooltip={COMMON_TOOLTIPS.metrics_port}
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
