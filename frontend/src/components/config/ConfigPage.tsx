import { useEffect, useState } from 'react';
import { Save, AlertTriangle, RefreshCw, Shield, FileText, Layout, Plus, X, BookOpen, Network } from 'lucide-react';
import { useConfigStore } from '../../stores';
import { configApi } from '../../api';
import type { AllConfigs, ValidationResult } from '../../types';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { YamlTextEditor } from './YamlTextEditor';
import { FieldWithTooltip, SelectWithTooltip } from './FieldsWithTooltips';
import { NRF_TOOLTIPS, AMF_TOOLTIPS, COMMON_TOOLTIPS } from '../../data/tooltips';

// Import all editors
// import { SbiEditor } from './editors/SbiEditor'; // Not used directly in this file
import { ScpEditor } from './editors/ScpEditor';
import { BsfEditor } from './editors/BsfEditor';
import { SeppEditor } from './editors/SeppEditor';
import { UdrEditor } from './editors/UdrEditor';
import { UdmEditor } from './editors/UdmEditor';
import { NssfEditor } from './editors/NssfEditor';
import { PcfEditor } from './editors/PcfEditor';
import { HssEditor } from './editors/HssEditor';
import { PcrfEditor } from './editors/PcrfEditor';
import { SgwcEditor } from './editors/SgwcEditor';
import { SgwuEditor } from './editors/SgwuEditor';
import { MmeEditor } from './editors/MmeEditor';
import { UpfEditor } from './editors/UpfEditor';
import { SmfEditor } from './editors/SmfEditor';
import { SbiClientSection, FunctionInfoBox } from './editors/SharedComponents';

type Tab = 'nrf' | 'scp' | 'amf' | 'smf' | 'upf' | 'ausf' | 'udm' | 'udr' | 'pcf' | 'nssf' | 'bsf' | 'sepp1' | 'mme' | 'hss' | 'pcrf' | 'sgwc' | 'sgwu';

// Shared with the global bulk log-level selector in ConfigPage's header.
const LOG_LEVELS = [
  { value: 'fatal', label: 'fatal' },
  { value: 'error', label: 'error' },
  { value: 'warn', label: 'warn' },
  { value: 'info', label: 'info (default)' },
  { value: 'debug', label: 'debug' },
  { value: 'trace', label: 'trace' },
];

function LoggerSection({
  logger,
  onChange,
}: {
  logger: { file?: { path?: string } | string; level?: string };
  onChange: (logger: any) => void;
}): JSX.Element {
  const logPath = typeof logger?.file === 'object' ? logger.file?.path || '' : logger?.file || '';
  const logLevel = logger?.level || 'info';

  return (
    <div>
      <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Logger</h3>
      <div className="grid grid-cols-2 gap-4">
        <FieldWithTooltip
          label="Log File Path"
          value={logPath}
          onChange={(v) => onChange({ ...logger, file: { path: v } })}
          placeholder="/var/log/open5gs/service.log"
          tooltip={COMMON_TOOLTIPS.log_path}
        />
        <SelectWithTooltip
          label="Log Level"
          value={logLevel}
          onChange={(v) => onChange({ ...logger, level: v })}
          options={LOG_LEVELS}
          tooltip={COMMON_TOOLTIPS.log_level}
        />
      </div>
    </div>
  );
}

// NRF Editor
function NrfEditor({ configs, onChange }: { configs: AllConfigs; onChange: (c: AllConfigs) => void }): JSX.Element {
  const fullYaml = configs.nrf as any;
  const nrf = fullYaml.nrf || {};
  if (!nrf?.sbi?.server || nrf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading NRF configuration...</div>;
  }
  const server = nrf.sbi.server[0] || { address: '127.0.0.10', port: 7777 };
  
  const updateNrf = (partial: any) => {
    onChange({ ...configs, nrf: { ...fullYaml, nrf: { ...nrf, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, nrf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <FunctionInfoBox
        title="NF Repository Function (NRF)"
        generation="5G"
        description="The NRF is the service registry and discovery hub of the 5G core. Every other Network Function (AMF, SMF, UDM, etc.) registers itself with the NRF at startup and queries the NRF when it needs to find another NF. The NRF stores NF profiles and exposes the Nnrf interface (HTTP/2 SBI) so NFs can discover and communicate with each other dynamically."
      />
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip
            label="Bind Address"
            value={server.address}
            onChange={(v) => updateNrf({ sbi: { ...nrf.sbi, server: [{ ...server, address: v }] } })}
            tooltip={NRF_TOOLTIPS.sbi_address}
          />
          <FieldWithTooltip
            label="Port"
            type="number"
            value={server.port}
            onChange={(v) => updateNrf({ sbi: { ...nrf.sbi, server: [{ ...server, port: parseInt(v) || 7777 }] } })}
            tooltip={NRF_TOOLTIPS.sbi_port}
          />
          <FieldWithTooltip
            label="Advertise (optional)"
            value={server.advertise || ''}
            onChange={(v) => updateNrf({ sbi: { ...nrf.sbi, server: [{ ...server, advertise: v || undefined }] } })}
            placeholder="nrf.5gc.mnc070.mcc999.3gppnetwork.org:7777"
            tooltip={COMMON_TOOLTIPS.sbi_advertise}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold font-display text-nms-accent">Serving PLMN</h3>
          <button
            onClick={() => updateNrf({ serving: [...(nrf.serving || []), { plmn_id: { mcc: '001', mnc: '01' } }] })}
            className="nms-btn-ghost text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add PLMN
          </button>
        </div>
        {(!nrf.serving || nrf.serving.length === 0) && (
          <p className="text-xs text-nms-text-dim">No serving PLMN configured.</p>
        )}
        {(nrf.serving || []).map((s: any, i: number) => (
          <div key={i} className="relative grid grid-cols-2 gap-4 mb-2 pr-8">
            <button
              onClick={() => updateNrf({ serving: nrf.serving.filter((_: any, idx: number) => idx !== i) })}
              className="absolute top-1/2 -translate-y-1/2 right-0 text-nms-text-dim hover:text-nms-red transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            <FieldWithTooltip
              label="MCC"
              value={s.plmn_id?.mcc || ''}
              onChange={(v) => {
                const updated = [...nrf.serving];
                updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mcc: v } };
                updateNrf({ serving: updated });
              }}
              tooltip={NRF_TOOLTIPS.serving_mcc}
            />
            <FieldWithTooltip
              label="MNC"
              value={s.plmn_id?.mnc || ''}
              onChange={(v) => {
                const updated = [...nrf.serving];
                updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mnc: v } };
                updateNrf({ serving: updated });
              }}
              tooltip={NRF_TOOLTIPS.serving_mnc}
            />
          </div>
        ))}
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}

// AMF Editor
function AmfEditor({ configs, onChange }: { configs: AllConfigs; onChange: (c: AllConfigs) => void }): JSX.Element {
  const fullYaml = configs.amf as any;
  const amf = fullYaml.amf || {};
  const sbiServer = amf.sbi?.server?.[0] || { address: '127.0.0.5', port: 7777 };
  const ngapServer = amf.ngap?.server?.[0] || { address: '10.0.1.175' };
  const [syncingSD, setSyncingSD] = useState(false);

  const updateAmf = (partial: any): void => {
    onChange({ ...configs, amf: { ...fullYaml, amf: { ...amf, ...partial } } });
  };

  const updateLogger = (logger: any): void => {
    onChange({ ...configs, amf: { ...fullYaml, logger } });
  };

  const handleSyncSD = async () => {
    const sd = amf.plmn_support?.[0]?.s_nssai?.[0]?.sd;
    const sst = amf.plmn_support?.[0]?.s_nssai?.[0]?.sst;

    if (!sd) {
      toast.error('No SD value found in AMF PLMN Support configuration');
      return;
    }

    const confirmed = window.confirm(
      `Sync SD value "${sd}" to:\n\n` +
      `✓ SMF s_nssai configuration\n` +
      `✓ All subscribers in database\n\n` +
      `This will update all slices${sst ? ` with SST=${sst}` : ''}.\n\n` +
      `Continue?`
    );

    if (!confirmed) return;

    setSyncingSD(true);
    try {
      const result = await configApi.syncSD(sd, sst);
      if (result.success) {
        toast.success(
          `✅ SD synced successfully!\n` +
          `SMF slices: ${result.data.smf_slices}\n` +
          `Subscribers: ${result.data.subscribers}`
        );
      } else {
        toast.error('SD sync failed');
      }
    } catch (error) {
      toast.error(`SD sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSyncingSD(false);
    }
  };

  return (
    <div className="space-y-6">
      <FunctionInfoBox
        title="Access and Mobility Management Function (AMF)"
        generation="5G"
        description="The AMF is the primary control-plane node of the 5G core, equivalent to the MME in 4G. It handles UE registration, authentication (via AUSF), connection and mobility management, and SMS over NAS. The gNB connects to the AMF over NGAP (N2), and the AMF interfaces with the SMF (N11) to trigger session setup. All UE signalling passes through the AMF."
      />
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={sbiServer.address} onChange={(v) => updateAmf({ sbi: { ...amf.sbi, server: [{ ...sbiServer, address: v }] } })} tooltip={AMF_TOOLTIPS.sbi_address} />
          <FieldWithTooltip label="Port" type="number" value={sbiServer.port} onChange={(v) => updateAmf({ sbi: { ...amf.sbi, server: [{ ...sbiServer, port: parseInt(v) || 7777 }] } })} tooltip={AMF_TOOLTIPS.sbi_port} />
          <FieldWithTooltip label="Advertise (optional)" value={sbiServer.advertise || ''} onChange={(v) => updateAmf({ sbi: { ...amf.sbi, server: [{ ...sbiServer, advertise: v || undefined }] } })} placeholder="amf.5gc.mnc070.mcc999.3gppnetwork.org:7777" tooltip={COMMON_TOOLTIPS.sbi_advertise} />
        </div>
      </div>

      <SbiClientSection
        client={amf.sbi?.client}
        onChange={(client) => updateAmf({ sbi: { ...amf.sbi, client } })}
      />

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-1">NGAP Server (N2)</h3>
        <p className="text-xs text-nms-text-dim mb-3">
          Bind to an IP <strong>or</strong> an interface name — not both.
          When <span className="font-mono">Interface</span> is set it takes priority and Address is ignored.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip
            label="Address (IP)"
            value={ngapServer.dev ? '' : (ngapServer.address || '')}
            onChange={(v) => {
              // Spread existing server entry to preserve any unknown fields;
              // remove dev (mutually exclusive with address)
              const { dev: _dev, ...rest } = ngapServer;
              updateAmf({ ngap: { server: [v ? { ...rest, address: v } : rest] } });
            }}
            placeholder="10.0.1.155"
            tooltip="Bind NGAP listener to this IP. Leave blank if using Interface binding."
          />
          <div>
            <FieldWithTooltip
              label="Interface / dev (alternative to Address)"
              value={ngapServer.dev || ''}
              onChange={(v) => {
                // Spread existing server entry to preserve any unknown fields;
                // remove address (mutually exclusive with dev)
                const { address: _addr, ...rest } = ngapServer;
                updateAmf({ ngap: { server: [v ? { ...rest, dev: v } : { ...rest, address: ngapServer.address || '' }] } });
              }}
              placeholder="eth0"
              tooltip="Bind NGAP to all IPs on this interface. Use instead of Address."
            />
            {ngapServer.dev && (
              <p className="text-xs text-blue-400 mt-1">
                ℹ️ Will write: <span className="font-mono">dev: {ngapServer.dev}</span> (address field omitted)
              </p>
            )}
          </div>
        </div>
      </div>

      {amf.guami && amf.guami.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold font-display text-nms-accent">GUAMI</h3>
            <button
              onClick={() => {
                const newEntry = {
                  plmn_id: { mcc: '001', mnc: '01' },
                  amf_id: { region: 2, set: 1, pointer: 0 },
                };
                updateAmf({ guami: [...amf.guami, newEntry] });
              }}
              className="nms-btn-ghost text-xs flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add PLMN with Slice
            </button>
          </div>
          {amf.guami.map((g: any, i: number) => (
            <div key={i} className="relative border border-nms-border rounded-lg p-3 mb-2">
              {amf.guami.length > 1 && (
                <button
                  onClick={() => {
                    const updated = amf.guami.filter((_: any, idx: number) => idx !== i);
                    updateAmf({ guami: updated });
                  }}
                  className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                  title="Remove PLMN"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className="grid grid-cols-5 gap-4">
                <FieldWithTooltip label="MCC" value={g.plmn_id.mcc} onChange={(v) => {
                  const updated = [...amf.guami];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mcc: v } };
                  updateAmf({ guami: updated });
                }} tooltip={AMF_TOOLTIPS.guami_mcc} />
                <FieldWithTooltip label="MNC" value={g.plmn_id.mnc} onChange={(v) => {
                  const updated = [...amf.guami];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mnc: v } };
                  updateAmf({ guami: updated });
                }} tooltip={AMF_TOOLTIPS.guami_mnc} />
                <FieldWithTooltip label="Region" type="number" value={g.amf_id?.region ?? 2} onChange={(v) => {
                  const updated = [...amf.guami];
                  updated[i] = { ...updated[i], amf_id: { ...updated[i].amf_id, region: v === '' ? '' : (parseInt(v) ?? 0) } };
                  updateAmf({ guami: updated });
                }} placeholder="2" tooltip={AMF_TOOLTIPS.guami_region} />
                <FieldWithTooltip label="Set" type="number" value={g.amf_id?.set ?? 1} onChange={(v) => {
                  const updated = [...amf.guami];
                  updated[i] = { ...updated[i], amf_id: { ...updated[i].amf_id, set: v === '' ? '' : (parseInt(v) ?? 0) } };
                  updateAmf({ guami: updated });
                }} placeholder="1" tooltip={AMF_TOOLTIPS.guami_set} />
                <FieldWithTooltip label="Pointer" type="number" value={g.amf_id?.pointer ?? 0} onChange={(v) => {
                  const updated = [...amf.guami];
                  updated[i] = { ...updated[i], amf_id: { ...updated[i].amf_id, pointer: v === '' ? '' : (parseInt(v) ?? 0) } };
                  updateAmf({ guami: updated });
                }} placeholder="0" tooltip={AMF_TOOLTIPS.guami_pointer} />
              </div>
            </div>
          ))}
        </div>
      )}

      {amf.tai && amf.tai.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold font-display text-nms-accent">TAI (Tracking Area Identity)</h3>
            <button
              onClick={() => {
                const newEntry = { plmn_id: { mcc: '001', mnc: '01' }, tac: 1 };
                updateAmf({ tai: [...amf.tai, newEntry] });
              }}
              className="nms-btn-ghost text-xs flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add TAI
            </button>
          </div>
          {amf.tai.map((t: any, i: number) => (
            <div key={i} className="relative border border-nms-border rounded-lg p-3 mb-2">
              {amf.tai.length > 1 && (
                <button
                  onClick={() => {
                    const updated = amf.tai.filter((_: any, idx: number) => idx !== i);
                    updateAmf({ tai: updated });
                  }}
                  className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className="grid grid-cols-3 gap-4">
                <FieldWithTooltip label="MCC" value={t.plmn_id.mcc} onChange={(v) => {
                  const updated = [...amf.tai];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mcc: v } };
                  updateAmf({ tai: updated });
                }} tooltip={AMF_TOOLTIPS.tai_mcc} />
                <FieldWithTooltip label="MNC" value={t.plmn_id.mnc} onChange={(v) => {
                  const updated = [...amf.tai];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mnc: v } };
                  updateAmf({ tai: updated });
                }} tooltip={AMF_TOOLTIPS.tai_mnc} />
                <FieldWithTooltip label="TAC" type="number" value={t.tac} onChange={(v) => {
                  const updated = [...amf.tai];
                  updated[i] = { ...updated[i], tac: parseInt(v) || 1 };
                  updateAmf({ tai: updated });
                }} placeholder="1" tooltip={AMF_TOOLTIPS.tai_tac} />
              </div>
            </div>
          ))}
        </div>
      )}

      {amf.plmn_support && amf.plmn_support.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold font-display text-nms-accent">PLMN Support</h3>
              <p className="text-xs text-nms-text-dim mt-0.5">Each PLMN can have multiple network slices (S-NSSAI). SD must be a 6-character hex value (e.g. 000001).</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSyncSD}
                disabled={syncingSD || !amf.plmn_support?.[0]?.s_nssai?.[0]?.sd}
                className="nms-btn-primary text-xs flex items-center gap-1"
              >
                {syncingSD ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {syncingSD ? 'Syncing...' : 'Sync SD'}
              </button>
              <button
                onClick={() => updateAmf({ plmn_support: [...amf.plmn_support, { plmn_id: { mcc: '001', mnc: '01' }, s_nssai: [{ sst: 1 }] }] })}
                className="nms-btn-ghost text-xs flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add PLMN
              </button>
            </div>
          </div>

          {amf.plmn_support.map((p: any, pi: number) => (
            <div key={pi} className="relative border border-nms-border rounded-lg p-4 mb-3 bg-nms-surface-2/20">
              {amf.plmn_support.length > 1 && (
                <button
                  onClick={() => updateAmf({ plmn_support: amf.plmn_support.filter((_: any, idx: number) => idx !== pi) })}
                  className="absolute top-3 right-3 text-nms-text-dim hover:text-nms-red transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">PLMN {pi + 1}</div>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <FieldWithTooltip label="MCC" value={p.plmn_id.mcc} onChange={(v) => {
                  const updated = [...amf.plmn_support];
                  updated[pi] = { ...updated[pi], plmn_id: { ...updated[pi].plmn_id, mcc: v } };
                  updateAmf({ plmn_support: updated });
                }} tooltip={AMF_TOOLTIPS.plmn_mcc} />
                <FieldWithTooltip label="MNC" value={p.plmn_id.mnc} onChange={(v) => {
                  const updated = [...amf.plmn_support];
                  updated[pi] = { ...updated[pi], plmn_id: { ...updated[pi].plmn_id, mnc: v } };
                  updateAmf({ plmn_support: updated });
                }} tooltip={AMF_TOOLTIPS.plmn_mnc} />
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">S-NSSAI Slices</span>
                <button
                  onClick={() => {
                    const updated = [...amf.plmn_support];
                    updated[pi] = { ...updated[pi], s_nssai: [...(updated[pi].s_nssai || []), { sst: 1 }] };
                    updateAmf({ plmn_support: updated });
                  }}
                  className="nms-btn-ghost text-xs flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" /> Add Slice
                </button>
              </div>
              {(p.s_nssai || []).map((slice: any, si: number) => (
                <div key={si} className="relative grid grid-cols-2 gap-3 mb-2 pl-3 border-l-2 border-nms-accent/20">
                  {(p.s_nssai || []).length > 1 && (
                    <button
                      onClick={() => {
                        const updated = [...amf.plmn_support];
                        updated[pi] = { ...updated[pi], s_nssai: updated[pi].s_nssai.filter((_: any, idx: number) => idx !== si) };
                        updateAmf({ plmn_support: updated });
                      }}
                      className="absolute -left-3 top-2 w-5 h-5 flex items-center justify-center rounded-full bg-nms-surface text-nms-text-dim hover:text-nms-red transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                  <FieldWithTooltip label={`SST ${si + 1}`} type="number" value={slice.sst || 1} onChange={(v) => {
                    const updated = [...amf.plmn_support];
                    const slices = [...updated[pi].s_nssai];
                    slices[si] = { ...slices[si], sst: parseInt(v) || 1 };
                    updated[pi] = { ...updated[pi], s_nssai: slices };
                    updateAmf({ plmn_support: updated });
                  }} placeholder="1" tooltip={AMF_TOOLTIPS.plmn_sst} />
                  <FieldWithTooltip label="SD (optional, 6 hex chars)" value={slice.sd || ''} onChange={(v) => {
                    const cleaned = v.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
                    const updated = [...amf.plmn_support];
                    const slices = [...updated[pi].s_nssai];
                    if (cleaned) { slices[si] = { ...slices[si], sd: cleaned }; }
                    else { const { sd, ...rest } = slices[si]; slices[si] = rest; }
                    updated[pi] = { ...updated[pi], s_nssai: slices };
                    updateAmf({ plmn_support: updated });
                  }} placeholder="000001" tooltip={AMF_TOOLTIPS.plmn_sd} mono={true} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* NAS Security */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4" /> NAS Security Algorithms
        </h3>
        <div className="mb-4">
          <label className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2 block">Integrity Protection Order (NIA)</label>
          <div className="space-y-2">
            {(amf.security?.integrity_order || ['NIA2', 'NIA1', 'NIA0']).map((alg: string, idx: number) => (
              <div key={idx} className="flex items-center gap-3 bg-nms-surface-2/50 rounded p-3 border border-nms-border">
                <div className="flex items-center justify-center w-8 h-8 rounded bg-nms-accent/10 text-nms-accent font-semibold text-sm">{idx + 1}</div>
                <select className="nms-input flex-1 font-mono text-sm" value={alg} onChange={(e) => {
                  const updated = [...(amf.security?.integrity_order || [])];
                  updated[idx] = e.target.value;
                  updateAmf({ security: { ...amf.security, integrity_order: updated } });
                }}>
                  <option value="NIA0">NIA0 (Null)</option>
                  <option value="NIA1">NIA1 (SNOW 3G)</option>
                  <option value="NIA2">NIA2 (AES) - Recommended</option>
                  <option value="NIA3">NIA3 (ZUC)</option>
                </select>
                {(amf.security?.integrity_order || []).length > 1 && (
                  <button onClick={() => {
                    const updated = (amf.security?.integrity_order || []).filter((_: string, i: number) => i !== idx);
                    updateAmf({ security: { ...amf.security, integrity_order: updated } });
                  }} className="text-nms-text-dim hover:text-nms-red transition-colors"><X className="w-4 h-4" /></button>
                )}
              </div>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2 block">Ciphering Order (NEA)</label>
          <div className="space-y-2">
            {(amf.security?.ciphering_order || ['NEA0', 'NEA1', 'NEA2']).map((alg: string, idx: number) => (
              <div key={idx} className="flex items-center gap-3 bg-nms-surface-2/50 rounded p-3 border border-nms-border">
                <div className="flex items-center justify-center w-8 h-8 rounded bg-nms-accent/10 text-nms-accent font-semibold text-sm">{idx + 1}</div>
                <select className="nms-input flex-1 font-mono text-sm" value={alg} onChange={(e) => {
                  const updated = [...(amf.security?.ciphering_order || [])];
                  updated[idx] = e.target.value;
                  updateAmf({ security: { ...amf.security, ciphering_order: updated } });
                }}>
                  <option value="NEA0">NEA0 (Null)</option>
                  <option value="NEA1">NEA1 (SNOW 3G)</option>
                  <option value="NEA2">NEA2 (AES) - Recommended</option>
                  <option value="NEA3">NEA3 (ZUC)</option>
                </select>
                {(amf.security?.ciphering_order || []).length > 1 && (
                  <button onClick={() => {
                    const updated = (amf.security?.ciphering_order || []).filter((_: string, i: number) => i !== idx);
                    updateAmf({ security: { ...amf.security, ciphering_order: updated } });
                  }} className="text-nms-text-dim hover:text-nms-red transition-colors"><X className="w-4 h-4" /></button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {amf.network_name && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Network Name</h3>
          <div className="grid grid-cols-2 gap-4">
            <FieldWithTooltip label="Full" value={amf.network_name.full || ''} onChange={(v) => updateAmf({ network_name: { ...amf.network_name, full: v } })} mono={false} tooltip={AMF_TOOLTIPS.network_name_full} />
            <FieldWithTooltip label="Short" value={amf.network_name.short || ''} onChange={(v) => updateAmf({ network_name: { ...amf.network_name, short: v } })} mono={false} tooltip={AMF_TOOLTIPS.network_name_short} />
          </div>
        </div>
      )}

      {amf.amf_name !== undefined && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">AMF Name</h3>
          <FieldWithTooltip label="AMF Name" value={amf.amf_name || ''} onChange={(v) => updateAmf({ amf_name: v })} placeholder="open5gs-amf0" tooltip={AMF_TOOLTIPS.amf_name} />
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Metrics Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={amf.metrics?.server?.[0]?.address || ''} onChange={(v) => updateAmf({ metrics: { server: [{ address: v, port: amf.metrics?.server?.[0]?.port || 9090 }] } })} tooltip={COMMON_TOOLTIPS.metrics_address} />
          <FieldWithTooltip label="Port" type="number" value={amf.metrics?.server?.[0]?.port || 9090} onChange={(v) => updateAmf({ metrics: { server: [{ address: amf.metrics?.server?.[0]?.address || '', port: parseInt(v) || 9090 }] } })} tooltip={COMMON_TOOLTIPS.metrics_port} />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}

// AUSF Editor
function AusfEditor({ configs, onChange }: { configs: AllConfigs; onChange: (c: AllConfigs) => void }): JSX.Element {
  const fullYaml = configs.ausf as any;
  const ausf = fullYaml.ausf || {};
  if (!ausf?.sbi?.server || ausf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading AUSF configuration...</div>;
  }
  const server = ausf.sbi.server[0] || { address: '127.0.0.11', port: 7777 };

  const updateAusf = (partial: any): void => {
    onChange({ ...configs, ausf: { ...fullYaml, ausf: { ...ausf, ...partial } } });
  };

  const updateLogger = (logger: any): void => {
    onChange({ ...configs, ausf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <FunctionInfoBox
        title="Authentication Server Function (AUSF)"
        generation="5G"
        description="The AUSF performs UE authentication for 5G networks. When a UE attempts to register, the AMF forwards the authentication request to the AUSF (N12), which fetches authentication vectors from the UDM (N13) and runs the 5G-AKA or EAP-AKA′ authentication procedure. The AUSF produces a security context that the AMF uses to protect NAS signalling."
      />
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={server.address} onChange={(v) => updateAusf({ sbi: { ...ausf.sbi, server: [{ ...server, address: v }] } })} tooltip={COMMON_TOOLTIPS.sbi_address} />
          <FieldWithTooltip label="Port" type="number" value={server.port} onChange={(v) => updateAusf({ sbi: { ...ausf.sbi, server: [{ ...server, port: parseInt(v) || 7777 }] } })} tooltip={COMMON_TOOLTIPS.sbi_port} />
          <FieldWithTooltip label="Advertise (optional)" value={server.advertise || ''} onChange={(v) => updateAusf({ sbi: { ...ausf.sbi, server: [{ ...server, advertise: v || undefined }] } })} placeholder="ausf.5gc.mnc070.mcc999.3gppnetwork.org:7777" tooltip={COMMON_TOOLTIPS.sbi_advertise} />
        </div>
      </div>
      <SbiClientSection client={ausf.sbi?.client} onChange={(client) => updateAusf({ sbi: { ...ausf.sbi, client } })} />
      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}

export function ConfigPage(): JSX.Element {
  const configs = useConfigStore((s) => s.configs);
  const loading = useConfigStore((s) => s.loading);
  const dirty = useConfigStore((s) => s.dirty);
  const fetchConfigs = useConfigStore((s) => s.fetchConfigs);
  const updateConfigs = useConfigStore((s) => s.updateConfigs);

  const [activeTab, setActiveTab] = useState<Tab>('nrf');
  const [editorMode, setEditorMode] = useState<'form' | 'text'>('form');
  const [applying, setApplying] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [editUpfData, setEditUpfData] = useState<any>(null);
  const [editSgwuData, setEditSgwuData] = useState<any>(null);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const getYamlForService = (service: Tab): string => {
    if (!configs || !configs[service]) return '';
    try {
      return stringifyYaml(configs[service], { indent: 2, lineWidth: 120 });
    } catch {
      return '';
    }
  };

  const handleYamlChange = (service: Tab, yamlText: string): void => {
    try {
      const parsed = parseYaml(yamlText) as any;
      if (configs) {
        updateConfigs({ ...configs, [service]: parsed });
      }
    } catch (error) {
      toast.error('Invalid YAML syntax');
    }
  };

  const handleValidate = async (): Promise<void> => {
    if (!configs) return;
    try {
      const result = await configApi.validate(configs);
      setValidation(result);
      if (result.valid) {
        toast.success('Configuration is valid');
      } else {
        toast.error(`${result.errors.length} validation issue(s) found`);
      }
    } catch {
      toast.error('Validation failed');
    }
  };

  const handleApply = async (overrideConfigs?: AllConfigs): Promise<void> => {
    const applyConfigs = overrideConfigs || configs;
    if (!applyConfigs) return;
    setApplying(true);
    try {
      const result = await configApi.apply(applyConfigs);
      if (result.success) {
        toast.success('Configuration applied successfully');
        useConfigStore.getState().setDirty(false);
        setValidation(null);
      } else if (result.rollback) {
        toast.error('Apply failed - configuration rolled back');
      } else {
        toast.error('Apply failed');
      }
    } catch (err) {
      toast.error('Apply failed');
    } finally {
      setApplying(false);
    }
  };

  if (loading || !configs) {
    return (
      <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
        Loading configurations...
      </div>
    );
  }

  const fiveGTabs: Tab[] = ['nrf', 'scp', 'amf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'sepp1'];
  const sharedTabs: Tab[] = ['smf', 'upf'];
  const fourGTabs: Tab[] = ['mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-display">Configuration</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Edit Open5GS network function configurations (5G Core + 4G EPC)
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dirty && (
            <span className="text-xs text-nms-amber flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> Unsaved changes
            </span>
          )}
          <a
            href="/docs/open5gs-yaml-reference.html"
            target="_blank"
            rel="noopener noreferrer"
            className="nms-btn-ghost flex items-center gap-2 text-sm"
          >
            <BookOpen className="w-4 h-4" />
            YAML Config Reference
          </a>
          <a
            href="/docs/open5gs-architecture-guide.html"
            target="_blank"
            rel="noopener noreferrer"
            className="nms-btn-ghost flex items-center gap-2 text-sm"
          >
            <Network className="w-4 h-4" />
            Architecture Guide
          </a>
          <button onClick={handleValidate} className="nms-btn-ghost flex items-center gap-2">
            <Shield className="w-4 h-4" /> Validate
          </button>
          <button
            onClick={() => handleApply()}
            disabled={applying || !dirty}
            className="nms-btn-primary flex items-center gap-2"
          >
            {applying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Apply Changes
          </button>
        </div>
      </div>

      {validation && !validation.valid && (
        <div className="nms-card border-nms-red/30">
          <h3 className="text-sm font-semibold text-nms-red mb-2">Validation Errors</h3>
          <div className="space-y-1 max-h-40 overflow-auto">
            {validation.errors.map((err, i) => (
              <div key={i} className="text-xs font-mono bg-nms-red/5 px-2 py-1.5 rounded text-nms-red">
                [{err.severity}] {err.field}: {err.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Editor Mode Toggle */}
      <div className="flex items-center justify-center">
        <div className="inline-flex rounded-lg bg-nms-surface border border-nms-border p-1">
          <button
            onClick={() => setEditorMode('form')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all',
              editorMode === 'form'
                ? 'bg-nms-accent/10 text-nms-accent'
                : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2'
            )}
          >
            <Layout className="w-4 h-4" />
            Form Editor
          </button>
          <button
            onClick={() => setEditorMode('text')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all',
              editorMode === 'text'
                ? 'bg-nms-accent/10 text-nms-accent'
                : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2'
            )}
          >
            <FileText className="w-4 h-4" />
            Text Editor
          </button>
        </div>
      </div>

      {/* Tab Groups */}
      <div className="space-y-2">
        <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider px-1">5G Core</div>
        <div className="flex gap-1 bg-nms-surface rounded-lg p-1 border border-nms-border flex-wrap">
          {fiveGTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-3 py-2 text-sm font-medium rounded-md transition-all',
                activeTab === tab ? 'bg-nms-accent/10 text-nms-accent' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
              )}
            >
              {tab === 'sepp1' ? 'SEPP' : tab.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider px-1 pt-2">Shared 4G/5G</div>
        <div className="flex gap-1 bg-nms-surface rounded-lg p-1 border border-nms-border flex-wrap">
          {sharedTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-3 py-2 text-sm font-medium rounded-md transition-all',
                activeTab === tab ? 'bg-nms-accent/10 text-nms-accent' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
              )}
            >
              {tab.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider px-1 pt-2">4G EPC</div>
        <div className="flex gap-1 bg-nms-surface rounded-lg p-1 border border-nms-border flex-wrap">
          {fourGTabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-3 py-2 text-sm font-medium rounded-md transition-all',
                activeTab === tab ? 'bg-nms-accent/10 text-nms-accent' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
              )}
            >
              {tab.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="nms-card">
        {editorMode === 'form' ? (
          <>
            {activeTab === 'nrf' && <NrfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'scp' && <ScpEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'amf' && <AmfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'smf' && <SmfEditor configs={configs} onChange={updateConfigs} onEditUpf={(data) => { setEditUpfData(data); setActiveTab('upf'); }} />}
            {activeTab === 'upf' && <UpfEditor configs={configs} onChange={updateConfigs} onApply={handleApply} editUpfData={editUpfData} onEditUpfDataConsumed={() => setEditUpfData(null)} />}
            {activeTab === 'ausf' && <AusfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'udm' && <UdmEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'udr' && <UdrEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'pcf' && <PcfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'nssf' && <NssfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'bsf' && <BsfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'sepp1' && <SeppEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'mme' && <MmeEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'hss' && <HssEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'pcrf' && <PcrfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'sgwc' && <SgwcEditor configs={configs} onChange={updateConfigs} onEditSgwu={(data) => { setEditSgwuData(data); setActiveTab('sgwu'); }} />}
            {activeTab === 'sgwu' && <SgwuEditor configs={configs} onChange={updateConfigs} onApply={handleApply} editSgwuData={editSgwuData} onEditSgwuDataConsumed={() => setEditSgwuData(null)} />}
          </>
        ) : (
          <YamlTextEditor
            serviceName={activeTab}
            value={getYamlForService(activeTab)}
            onChange={(yamlText) => handleYamlChange(activeTab, yamlText)}
          />
        )}
      </div>
    </div>
  );
}
