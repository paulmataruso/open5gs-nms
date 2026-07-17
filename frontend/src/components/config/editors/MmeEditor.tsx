import type { AllConfigs } from '../../../types';
import { LoggerSection, FunctionInfoBox } from './SharedComponents';
import { Plus, X, Shield } from 'lucide-react';
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
    // Keep maps as an array (plural); normalize any legacy map: object to maps: array.
    if (partial.sgsap?.client) {
      partial.sgsap.client = partial.sgsap.client.map((client: any) => {
        const { map: _legacy, ...rest } = client;
        const maps = client.maps ?? (_legacy ? [_legacy] : undefined);
        return maps !== undefined ? { ...rest, maps } : rest;
      });
    }
    onChange({ ...configs, mme: { ...fullYaml, mme: { ...mme, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, mme: { ...fullYaml, logger } });
  };

  const s1apServer = mme.s1ap?.server?.[0] || { address: '10.0.1.175' };
  const gtpcServer = mme.gtpc?.server?.[0] || { address: '127.0.0.2' };

  // Normalize a client's map entries to an array (handles legacy map: object and maps: array).
  const getClientMaps = (client: any): any[] =>
    client?.maps ?? (client?.map ? [client.map] : [defaultMap()]);

  // Update a field within a specific TAI→LAI mapping in a client.
  const updateMapField = (
    clientIdx: number,
    mapIdx: number,
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
      updateMme({ sgsap: { client: [{ address: '', local_address: '', maps: [m] }] } });
    } else {
      const updatedClients = [...(mme.sgsap?.client || [])];
      const clientMaps = [...getClientMaps(updatedClients[clientIdx])];
      const existingMap = clientMaps[mapIdx] || defaultMap();
      clientMaps[mapIdx] = {
        ...existingMap,
        [side]: {
          ...existingMap[side],
          ...(subfield === 'tac' || subfield === 'lac'
            ? { [subfield]: numVal }
            : { plmn_id: { ...existingMap[side]?.plmn_id, [subfield]: value } }),
        },
      };
      updatedClients[clientIdx] = { ...updatedClients[clientIdx], maps: clientMaps };
      updateMme({ sgsap: { client: updatedClients } });
    }
  };

  return (
    <div className="space-y-6">
      <FunctionInfoBox
        title="Mobility Management Entity (MME)"
        generation="4G"
        description="The MME is the central control-plane node of the 4G (LTE) core network. It handles UE attachment and authentication, manages tracking areas and paging, and coordinates with the HSS (via Diameter/S6a), the Serving Gateway (via GTP-C/S11), and the SMF/PGW (via S5/S8). Every 4G device registers, authenticates, and establishes sessions through the MME."
      />
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
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-1">S1AP Server</h3>
        <p className="text-xs text-nms-text-dim mb-3">
          Bind to an IP <strong>or</strong> an interface name — not both.
          When <span className="font-mono">Interface</span> is set it takes priority and Address is ignored.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip
            label="Address (IP)"
            value={s1apServer.dev ? '' : (s1apServer.address || '')}
            onChange={(v) => {
              const { dev: _dev, ...rest } = s1apServer;
              updateMme({ s1ap: { server: [v ? { ...rest, address: v } : rest] } });
            }}
            placeholder="10.0.1.175"
            tooltip="Bind S1AP listener to this IP. Leave blank if using Interface binding."
          />
          <div>
            <FieldWithTooltip
              label="Interface / dev (alternative to Address)"
              value={s1apServer.dev || ''}
              onChange={(v) => {
                const { address: _addr, ...rest } = s1apServer;
                updateMme({ s1ap: { server: [v ? { ...rest, dev: v } : { ...rest, address: s1apServer.address || '' }] } });
              }}
              placeholder="eth0"
              tooltip="Bind S1AP to all IPs on this interface. Use instead of Address."
            />
            {s1apServer.dev && (
              <p className="text-xs text-blue-400 mt-1">
                ℹ️ Will write: <span className="font-mono">dev: {s1apServer.dev}</span> (address field omitted)
              </p>
            )}
          </div>
        </div>
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
          const clientMaps: any[] = isFirstAndEmpty ? [defaultMap()] : getClientMaps(actualClient);

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
                      updateMme({ sgsap: { client: [{ address: v, local_address: '', maps: [defaultMap()] }] } });
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
                      updateMme({ sgsap: { client: [{ address: '', local_address: v, maps: [defaultMap()] }] } });
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

              {/* TAI → LAI Mappings */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="text-sm font-semibold text-nms-text">TAI → LAI Mappings</h4>
                    <p className="text-xs text-nms-text-dim mt-0.5">
                      {MME_TOOLTIPS.sgsap_mapping_explanation}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (isFirstAndEmpty) {
                        // Initialize the client with two default mappings
                        updateMme({ sgsap: { client: [{ address: '', local_address: '', maps: [defaultMap(), defaultMap()] }] } });
                      } else {
                        const updatedClients = [...(mme.sgsap?.client || [])];
                        updatedClients[clientIdx] = {
                          ...updatedClients[clientIdx],
                          maps: [...getClientMaps(updatedClients[clientIdx]), defaultMap()],
                        };
                        updateMme({ sgsap: { client: updatedClients } });
                      }
                    }}
                    className="nms-btn-ghost text-xs flex items-center gap-1 shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Mapping
                  </button>
                </div>

                {clientMaps.map((mapping: any, mapIdx: number) => (
                  <div key={mapIdx} className="relative mb-3 border border-dashed border-nms-border/60 rounded-lg p-3 bg-nms-surface-2/20">
                    {/* Remove mapping button — only when > 1 mapping and not placeholder */}
                    {!isFirstAndEmpty && clientMaps.length > 1 && (
                      <button
                        onClick={() => {
                          const updatedClients = [...(mme.sgsap?.client || [])];
                          updatedClients[clientIdx] = {
                            ...updatedClients[clientIdx],
                            maps: getClientMaps(updatedClients[clientIdx]).filter((_: any, idx: number) => idx !== mapIdx),
                          };
                          updateMme({ sgsap: { client: updatedClients } });
                        }}
                        className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                        title="Remove Mapping"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {clientMaps.length > 1 && (
                      <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-3">
                        Mapping {mapIdx + 1}
                      </div>
                    )}

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
                          value={isFirstAndEmpty ? '' : (mapping.tai?.plmn_id?.mcc ?? '')}
                          onChange={(v) => updateMapField(clientIdx, mapIdx, isFirstAndEmpty, 'tai', 'mcc', v)}
                          placeholder="001"
                          tooltip={MME_TOOLTIPS.sgsap_tai_mcc}
                        />
                        <FieldWithTooltip
                          label="MNC"
                          value={isFirstAndEmpty ? '' : (mapping.tai?.plmn_id?.mnc ?? '')}
                          onChange={(v) => updateMapField(clientIdx, mapIdx, isFirstAndEmpty, 'tai', 'mnc', v)}
                          placeholder="01"
                          tooltip={MME_TOOLTIPS.sgsap_tai_mnc}
                        />
                        <FieldWithTooltip
                          label="TAC"
                          type="number"
                          value={isFirstAndEmpty ? '' : (mapping.tai?.tac ?? '')}
                          onChange={(v) => updateMapField(clientIdx, mapIdx, isFirstAndEmpty, 'tai', 'tac', v)}
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
                          value={isFirstAndEmpty ? '' : (mapping.lai?.plmn_id?.mcc ?? '')}
                          onChange={(v) => updateMapField(clientIdx, mapIdx, isFirstAndEmpty, 'lai', 'mcc', v)}
                          placeholder="001"
                          tooltip={MME_TOOLTIPS.sgsap_lai_mcc}
                        />
                        <FieldWithTooltip
                          label="MNC"
                          value={isFirstAndEmpty ? '' : (mapping.lai?.plmn_id?.mnc ?? '')}
                          onChange={(v) => updateMapField(clientIdx, mapIdx, isFirstAndEmpty, 'lai', 'mnc', v)}
                          placeholder="01"
                          tooltip={MME_TOOLTIPS.sgsap_lai_mnc}
                        />
                        <FieldWithTooltip
                          label="LAC"
                          type="number"
                          value={isFirstAndEmpty ? '' : (mapping.lai?.lac ?? '')}
                          onChange={(v) => updateMapField(clientIdx, mapIdx, isFirstAndEmpty, 'lai', 'lac', v)}
                          placeholder="43691"
                          tooltip={MME_TOOLTIPS.sgsap_lai_lac}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* Add Button */}
        <button
          onClick={() => {
            const newClient = { address: '', local_address: '', maps: [defaultMap()] };
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

      {/* NAS Security Configuration */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          NAS Security Algorithms
        </h3>
        <p className="text-xs text-nms-text-dim mb-4">
          Configure encryption and integrity protection algorithm preference order for 4G NAS security.
          Algorithms are tried in order — the first one supported by both the UE and the network is selected.
        </p>

        {/* Integrity Protection (EIA) */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2 block">
            Integrity Protection Order (EIA)
          </label>
          <div className="space-y-2">
            {(mme.security?.integrity_order || ['EIA2', 'EIA1', 'EIA0']).map((alg: string, idx: number) => (
              <div key={idx} className="flex items-center gap-3 bg-nms-surface-2/50 rounded p-3 border border-nms-border">
                <div className="flex items-center justify-center w-8 h-8 rounded bg-nms-accent/10 text-nms-accent font-semibold text-sm">
                  {idx + 1}
                </div>
                <select
                  className="nms-input flex-1 font-mono text-sm"
                  value={alg}
                  onChange={(e) => {
                    const updated = [...(mme.security?.integrity_order || [])];
                    updated[idx] = e.target.value;
                    updateMme({ security: { ...mme.security, integrity_order: updated } });
                  }}
                >
                  <option value="EIA0">EIA0 (Null — No Protection)</option>
                  <option value="EIA1">EIA1 (128-EIA1 SNOW 3G)</option>
                  <option value="EIA2">EIA2 (128-EIA2 AES) — Recommended</option>
                </select>
                {(mme.security?.integrity_order || []).length > 1 && (
                  <button
                    onClick={() => {
                      const updated = (mme.security?.integrity_order || []).filter((_: string, i: number) => i !== idx);
                      updateMme({ security: { ...mme.security, integrity_order: updated } });
                    }}
                    className="text-nms-text-dim hover:text-nms-red transition-colors"
                    title="Remove algorithm"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => {
                const current = mme.security?.integrity_order || ['EIA2', 'EIA1', 'EIA0'];
                updateMme({ security: { ...mme.security, integrity_order: [...current, 'EIA2'] } });
              }}
              className="nms-btn-ghost text-xs w-full flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Integrity Algorithm
            </button>
          </div>
        </div>

        {/* Ciphering (EEA) */}
        <div>
          <label className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2 block">
            Ciphering Order (EEA)
          </label>
          <div className="space-y-2">
            {(mme.security?.ciphering_order || ['EEA0', 'EEA1', 'EEA2']).map((alg: string, idx: number) => (
              <div key={idx} className="flex items-center gap-3 bg-nms-surface-2/50 rounded p-3 border border-nms-border">
                <div className="flex items-center justify-center w-8 h-8 rounded bg-nms-accent/10 text-nms-accent font-semibold text-sm">
                  {idx + 1}
                </div>
                <select
                  className="nms-input flex-1 font-mono text-sm"
                  value={alg}
                  onChange={(e) => {
                    const updated = [...(mme.security?.ciphering_order || [])];
                    updated[idx] = e.target.value;
                    updateMme({ security: { ...mme.security, ciphering_order: updated } });
                  }}
                >
                  <option value="EEA0">EEA0 (Null — No Encryption)</option>
                  <option value="EEA1">EEA1 (128-EEA1 SNOW 3G)</option>
                  <option value="EEA2">EEA2 (128-EEA2 AES) — Recommended</option>
                </select>
                {(mme.security?.ciphering_order || []).length > 1 && (
                  <button
                    onClick={() => {
                      const updated = (mme.security?.ciphering_order || []).filter((_: string, i: number) => i !== idx);
                      updateMme({ security: { ...mme.security, ciphering_order: updated } });
                    }}
                    className="text-nms-text-dim hover:text-nms-red transition-colors"
                    title="Remove algorithm"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => {
                const current = mme.security?.ciphering_order || ['EEA0', 'EEA1', 'EEA2'];
                updateMme({ security: { ...mme.security, ciphering_order: [...current, 'EEA2'] } });
              }}
              className="nms-btn-ghost text-xs w-full flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Ciphering Algorithm
            </button>
          </div>
        </div>

        <div className="mt-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded text-xs text-nms-text-dim">
          <strong className="text-blue-400">ℹ️ Note:</strong> For production 4G networks, it is recommended to prioritize:
          <ul className="list-disc list-inside mt-1 ml-2">
            <li><strong>EIA2/EEA2 (AES)</strong> — Most secure and widely supported</li>
            <li><strong>EIA1/EEA1 (SNOW 3G)</strong> — Fallback for older UEs</li>
            <li><strong>EIA0/EEA0 (Null)</strong> — Only for testing, provides no security</li>
          </ul>
        </div>
      </div>

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

      {/* Timer Configuration */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-1">Timer Configuration</h3>
        <p className="text-xs text-nms-text-dim mb-3">
          3GPP mobility timers. Leave blank to omit from config (Open5GS uses built-in defaults).
          Values are in seconds.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <FieldWithTooltip
            label="T3402 (seconds)"
            type="number"
            value={mme.time?.t3402?.value ?? ''}
            onChange={(v) => {
              const val = v === '' ? undefined : parseInt(v);
              const updated: any = { ...mme.time };
              if (val === undefined) {
                delete updated.t3402;
              } else {
                updated.t3402 = { value: val };
              }
              updateMme({ time: Object.keys(updated).length ? updated : undefined });
            }}
            placeholder="720"
            tooltip={(MME_TOOLTIPS as any).t3402}
          />
          <FieldWithTooltip
            label="T3412 (seconds)"
            type="number"
            value={mme.time?.t3412?.value ?? ''}
            onChange={(v) => {
              const val = v === '' ? undefined : parseInt(v);
              const updated: any = { ...mme.time };
              if (val === undefined) {
                delete updated.t3412;
              } else {
                updated.t3412 = { value: val };
              }
              updateMme({ time: Object.keys(updated).length ? updated : undefined });
            }}
            placeholder="3240"
            tooltip={(MME_TOOLTIPS as any).t3412}
          />
          <FieldWithTooltip
            label="T3423 (seconds)"
            type="number"
            value={mme.time?.t3423?.value ?? ''}
            onChange={(v) => {
              const val = v === '' ? undefined : parseInt(v);
              const updated: any = { ...mme.time };
              if (val === undefined) {
                delete updated.t3423;
              } else {
                updated.t3423 = { value: val };
              }
              updateMme({ time: Object.keys(updated).length ? updated : undefined });
            }}
            placeholder="720"
            tooltip={(MME_TOOLTIPS as any).t3423}
          />
        </div>
      </div>

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

      {/* Global Parameters */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-1 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          Global Parameters
        </h3>
        <p className="text-xs text-nms-text-dim mb-3">
          Settings under <code className="font-mono bg-nms-surface-2 px-1 rounded">global.parameter</code> that apply network-wide.
        </p>
        <div className="border border-nms-border rounded-lg p-4 space-y-4">
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative mt-0.5 shrink-0">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={!!(fullYaml.global?.parameter?.use_openair)}
                onChange={(e) => {
                  const global = fullYaml.global || {};
                  const parameter = { ...(global.parameter || {}) };
                  if (e.target.checked) {
                    parameter.use_openair = true;
                  } else {
                    delete parameter.use_openair;
                  }
                  onChange({ ...configs, mme: { ...fullYaml, global: { ...global, parameter } } });
                }}
              />
              <div className="w-10 h-6 bg-nms-border peer-checked:bg-nms-accent rounded-full transition-colors duration-200"></div>
              <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-transform duration-200 peer-checked:translate-x-4 pointer-events-none"></div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-nms-text group-hover:text-nms-accent transition-colors font-mono">use_openair</span>
                <span className={`text-xs px-1.5 py-0.5 rounded border ${fullYaml.global?.parameter?.use_openair ? 'bg-green-500/15 text-green-400 border-green-500/30' : 'bg-nms-surface-2 text-nms-text-dim border-nms-border'}`}>
                  {fullYaml.global?.parameter?.use_openair ? 'enabled' : 'disabled'}
                </span>
              </div>
              <p className="text-xs text-nms-text-dim leading-relaxed">
                Omit the <strong>HashMME</strong> IE from Security Mode Commands.
                Enable this if iPhones or 5G-capable UEs fail attachment with EMM Cause 24 (Security Mode Reject).
                Per 3GPP TS 24.301 §5.4.3.4, a failed HashMME verification mandates Cause 24.
              </p>
            </div>
          </label>
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
