import { useEffect, useState } from 'react';
import { Save, AlertTriangle, RefreshCw, Shield, FileText, Layout, Plus, X } from 'lucide-react';
import { useConfigStore } from '../../stores';
import { configApi } from '../../api';
import type { AllConfigs, ValidationResult } from '../../types';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { YamlTextEditor } from './YamlTextEditor';
import { FieldWithTooltip, SelectWithTooltip } from './FieldsWithTooltips';
import { NRF_TOOLTIPS, AMF_TOOLTIPS, SMF_TOOLTIPS, UPF_TOOLTIPS, COMMON_TOOLTIPS } from '../../data/tooltips';

// Import all editors
// import { SbiEditor } from './editors/SbiEditor'; // Not used directly in this file
import { ScpEditor } from './editors/ScpEditor';
import { BsfEditor } from './editors/BsfEditor';
import { UdrEditor } from './editors/UdrEditor';
import { UdmEditor } from './editors/UdmEditor';
import { NssfEditor } from './editors/NssfEditor';
import { PcfEditor } from './editors/PcfEditor';
import { HssEditor } from './editors/HssEditor';
import { PcrfEditor } from './editors/PcrfEditor';
import { SgwcEditor } from './editors/SgwcEditor';
import { SgwuEditor } from './editors/SgwuEditor';
import { MmeEditor } from './editors/MmeEditor';

type Tab = 'nrf' | 'scp' | 'amf' | 'smf' | 'upf' | 'ausf' | 'udm' | 'udr' | 'pcf' | 'nssf' | 'bsf' | 'mme' | 'hss' | 'pcrf' | 'sgwc' | 'sgwu';

function LoggerSection({
  logger,
  onChange,
}: {
  logger: { file?: { path?: string } | string; level?: string };
  onChange: (logger: any) => void;
}): JSX.Element {
  const logPath = typeof logger?.file === 'object' ? logger.file?.path || '' : logger?.file || '';
  const logLevel = logger?.level || 'info';

  const levels = [
    { value: 'fatal', label: 'fatal' },
    { value: 'error', label: 'error' },
    { value: 'warn', label: 'warn' },
    { value: 'info', label: 'info (default)' },
    { value: 'debug', label: 'debug' },
    { value: 'trace', label: 'trace' },
  ];

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
          options={levels}
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
        </div>
      </div>

      {nrf.serving && nrf.serving.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Serving PLMN</h3>
          {nrf.serving.map((s: any, i: number) => (
            <div key={i} className="grid grid-cols-2 gap-4 mb-2">
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
      )}

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}

// AMF Editor - COMPLETE with all 6 missing fields
function AmfEditor({ configs, onChange }: { configs: AllConfigs; onChange: (c: AllConfigs) => void }): JSX.Element {
  const fullYaml = configs.amf as any;
  const amf = fullYaml.amf || {};
  const sbiServer = amf.sbi?.server?.[0] || { address: '127.0.0.5', port: 7777 };
  const scpUri = amf.sbi?.client?.scp?.[0]?.uri || '';
  const nrfUri = amf.sbi?.client?.nrf?.[0]?.uri || '';
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
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={sbiServer.address} onChange={(v) => updateAmf({ sbi: { ...amf.sbi, server: [{ ...sbiServer, address: v }] } })} tooltip={AMF_TOOLTIPS.sbi_address} />
          <FieldWithTooltip label="Port" type="number" value={sbiServer.port} onChange={(v) => updateAmf({ sbi: { ...amf.sbi, server: [{ ...sbiServer, port: parseInt(v) || 7777 }] } })} tooltip={AMF_TOOLTIPS.sbi_port} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SCP Client</h3>
        <FieldWithTooltip label="SCP URI" value={scpUri} onChange={(v) => updateAmf({ sbi: { ...amf.sbi, client: { ...amf.sbi.client, scp: [{ uri: v }] } } })} placeholder="http://127.0.0.200:7777" tooltip={AMF_TOOLTIPS.scp_uri} />
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">NRF Client</h3>
        <FieldWithTooltip label="NRF URI" value={nrfUri} onChange={(v) => updateAmf({ sbi: { ...amf.sbi, client: { ...amf.sbi.client, nrf: [{ uri: v }] } } })} placeholder="http://127.0.0.10:7777" tooltip={COMMON_TOOLTIPS.nrf_uri} />
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">NGAP Server</h3>
        <FieldWithTooltip label="Address" value={ngapServer.address} onChange={(v) => updateAmf({ ngap: { server: [{ address: v }] } })} tooltip={AMF_TOOLTIPS.ngap_address} />
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
                const newEntry = {
                  plmn_id: { mcc: '001', mnc: '01' },
                  tac: 1,
                };
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
                  title="Remove TAI"
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
            <h3 className="text-sm font-semibold font-display text-nms-accent">PLMN Support</h3>
            <div className="flex gap-2">
              <button
                onClick={handleSyncSD}
                disabled={syncingSD || !amf.plmn_support?.[0]?.s_nssai?.[0]?.sd}
                className="nms-btn-primary text-xs flex items-center gap-1"
                title="Sync SD value to SMF and all subscribers"
              >
                {syncingSD ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {syncingSD ? 'Syncing...' : 'Sync SD'}
              </button>
              <button
                onClick={() => {
                  const newEntry = {
                    plmn_id: { mcc: '001', mnc: '01' },
                    s_nssai: [{ sst: 1 }],
                  };
                  updateAmf({ plmn_support: [...amf.plmn_support, newEntry] });
                }}
                className="nms-btn-ghost text-xs flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add PLMN
              </button>
            </div>
          </div>
          {amf.plmn_support.map((p: any, i: number) => (
            <div key={i} className="relative border border-nms-border rounded-lg p-3 mb-2">
              {amf.plmn_support.length > 1 && (
                <button
                  onClick={() => {
                    const updated = amf.plmn_support.filter((_: any, idx: number) => idx !== i);
                    updateAmf({ plmn_support: updated });
                  }}
                  className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                  title="Remove PLMN"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className="grid grid-cols-2 gap-4">
                <FieldWithTooltip label="MCC" value={p.plmn_id.mcc} onChange={(v) => {
                  const updated = [...amf.plmn_support];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mcc: v } };
                  updateAmf({ plmn_support: updated });
                }} tooltip={AMF_TOOLTIPS.plmn_mcc} />
                <FieldWithTooltip label="MNC" value={p.plmn_id.mnc} onChange={(v) => {
                  const updated = [...amf.plmn_support];
                  updated[i] = { ...updated[i], plmn_id: { ...updated[i].plmn_id, mnc: v } };
                  updateAmf({ plmn_support: updated });
                }} tooltip={AMF_TOOLTIPS.plmn_mnc} />
              </div>
              <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2 mt-3">S-NSSAI (Network Slice Selection Assistance Info)</div>
              <div className="grid grid-cols-2 gap-4">
                <FieldWithTooltip 
                  label="SST (Slice/Service Type)" 
                  type="number" 
                  value={p.s_nssai?.[0]?.sst || 1} 
                  onChange={(v) => {
                    const updated = [...amf.plmn_support];
                    const currentSd = updated[i].s_nssai?.[0]?.sd;
                    updated[i] = { 
                      ...updated[i], 
                      s_nssai: [{ 
                        sst: parseInt(v) || 1,
                        ...(currentSd ? { sd: currentSd } : {})
                      }] 
                    };
                    updateAmf({ plmn_support: updated });
                  }} 
                  placeholder="1" 
                  tooltip={AMF_TOOLTIPS.plmn_sst} 
                />
                <FieldWithTooltip 
                  label="SD (Slice Differentiator)" 
                  value={p.s_nssai?.[0]?.sd || ''} 
                  onChange={(v) => {
                    const updated = [...amf.plmn_support];
                    const currentSst = updated[i].s_nssai?.[0]?.sst || 1;
                    const cleanedSd = v.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
                    updated[i] = { 
                      ...updated[i], 
                      s_nssai: [{ 
                        sst: currentSst,
                        ...(cleanedSd ? { sd: cleanedSd } : {})
                      }] 
                    };
                    updateAmf({ plmn_support: updated });
                  }} 
                  placeholder="010203 (optional)" 
                  tooltip={AMF_TOOLTIPS.plmn_sd}
                  mono={true}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* NAS Security Configuration */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          NAS Security Algorithms
        </h3>
        <p className="text-xs text-nms-text-dim mb-4">
          Configure encryption and integrity protection algorithm preference order for NAS (Non-Access Stratum) security.
          Algorithms are tried in order - first supported algorithm by both UE and network is selected.
        </p>
        
        {/* Integrity Protection */}
        <div className="mb-4">
          <label className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2 block">
            Integrity Protection Order (NIA)
          </label>
          <div className="space-y-2">
            {(amf.security?.integrity_order || ['NIA2', 'NIA1', 'NIA0']).map((alg: string, idx: number) => (
              <div key={idx} className="flex items-center gap-3 bg-nms-surface-2/50 rounded p-3 border border-nms-border">
                <div className="flex items-center justify-center w-8 h-8 rounded bg-nms-accent/10 text-nms-accent font-semibold text-sm">
                  {idx + 1}
                </div>
                <select
                  className="nms-input flex-1 font-mono text-sm"
                  value={alg}
                  onChange={(e) => {
                    const updated = [...(amf.security?.integrity_order || [])];
                    updated[idx] = e.target.value;
                    updateAmf({
                      security: { ...amf.security, integrity_order: updated },
                    });
                  }}
                >
                  <option value="NIA0">NIA0 (Null - No Protection)</option>
                  <option value="NIA1">NIA1 (128-EIA1 SNOW 3G)</option>
                  <option value="NIA2">NIA2 (128-EIA2 AES) - Recommended</option>
                  <option value="NIA3">NIA3 (128-EIA3 ZUC)</option>
                </select>
                {(amf.security?.integrity_order || []).length > 1 && (
                  <button
                    onClick={() => {
                      const updated = (amf.security?.integrity_order || []).filter((_: string, i: number) => i !== idx);
                      updateAmf({
                        security: { ...amf.security, integrity_order: updated },
                      });
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
                const current = amf.security?.integrity_order || ['NIA2', 'NIA1', 'NIA0'];
                updateAmf({
                  security: { ...amf.security, integrity_order: [...current, 'NIA2'] },
                });
              }}
              className="nms-btn-ghost text-xs w-full flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Integrity Algorithm
            </button>
          </div>
        </div>

        {/* Ciphering */}
        <div>
          <label className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2 block">
            Ciphering Order (NEA)
          </label>
          <div className="space-y-2">
            {(amf.security?.ciphering_order || ['NEA0', 'NEA1', 'NEA2']).map((alg: string, idx: number) => (
              <div key={idx} className="flex items-center gap-3 bg-nms-surface-2/50 rounded p-3 border border-nms-border">
                <div className="flex items-center justify-center w-8 h-8 rounded bg-nms-accent/10 text-nms-accent font-semibold text-sm">
                  {idx + 1}
                </div>
                <select
                  className="nms-input flex-1 font-mono text-sm"
                  value={alg}
                  onChange={(e) => {
                    const updated = [...(amf.security?.ciphering_order || [])];
                    updated[idx] = e.target.value;
                    updateAmf({
                      security: { ...amf.security, ciphering_order: updated },
                    });
                  }}
                >
                  <option value="NEA0">NEA0 (Null - No Encryption)</option>
                  <option value="NEA1">NEA1 (128-EEA1 SNOW 3G)</option>
                  <option value="NEA2">NEA2 (128-EEA2 AES) - Recommended</option>
                  <option value="NEA3">NEA3 (128-EEA3 ZUC)</option>
                </select>
                {(amf.security?.ciphering_order || []).length > 1 && (
                  <button
                    onClick={() => {
                      const updated = (amf.security?.ciphering_order || []).filter((_: string, i: number) => i !== idx);
                      updateAmf({
                        security: { ...amf.security, ciphering_order: updated },
                      });
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
                const current = amf.security?.ciphering_order || ['NEA0', 'NEA1', 'NEA2'];
                updateAmf({
                  security: { ...amf.security, ciphering_order: [...current, 'NEA2'] },
                });
              }}
              className="nms-btn-ghost text-xs w-full flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Ciphering Algorithm
            </button>
          </div>
        </div>

        <div className="mt-3 p-3 bg-blue-500/10 border border-blue-500/30 rounded text-xs text-nms-text-dim">
          <strong className="text-blue-400">ℹ️ Note:</strong> For production 5G networks, it's recommended to prioritize:
          <ul className="list-disc list-inside mt-1 ml-2">
            <li><strong>NIA2/NEA2 (AES)</strong> - Most secure and widely supported</li>
            <li><strong>NIA1/NEA1 (SNOW 3G)</strong> - Fallback for older UEs</li>
            <li><strong>NIA0/NEA0 (Null)</strong> - Only for testing, provides no security</li>
          </ul>
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

      {/* Metrics Server */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Metrics Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip 
            label="Address" 
            value={amf.metrics?.server?.[0]?.address || ''} 
            onChange={(v) => updateAmf({ metrics: { server: [{ address: v, port: amf.metrics?.server?.[0]?.port || 9090 }] } })} 
            tooltip={COMMON_TOOLTIPS.metrics_address} 
          />
          <FieldWithTooltip 
            label="Port" 
            type="number" 
            value={amf.metrics?.server?.[0]?.port || 9090} 
            onChange={(v) => updateAmf({ metrics: { server: [{ address: amf.metrics?.server?.[0]?.address || '', port: parseInt(v) || 9090 }] } })} 
            tooltip={COMMON_TOOLTIPS.metrics_port} 
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}

// SMF Editor - COMPLETE with all 8 fields
function SmfEditor({ configs, onChange }: { configs: AllConfigs; onChange: (c: AllConfigs) => void }): JSX.Element {
  const fullYaml = configs.smf as any;
  const smf = fullYaml.smf || {};
  if (!smf?.sbi?.server || smf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading SMF configuration...</div>;
  }
  const sbiServer = smf.sbi.server[0] || { address: '127.0.0.4', port: 7777 };
  const scpUri = smf.sbi?.client?.scp?.[0]?.uri || '';
  const nrfUri = smf.sbi?.client?.nrf?.[0]?.uri || '';
  const pfcpServer = smf.pfcp?.server?.[0] || { address: '127.0.0.4' };
  const upfAddress = smf.pfcp?.client?.upf?.[0]?.address || '';
  const gtpcServer = smf.gtpc?.server?.[0]?.address || '';
  const gtpuServer = smf.gtpu?.server?.[0]?.address || '';

  const updateSmf = (partial: any): void => {
    onChange({ ...configs, smf: { ...fullYaml, smf: { ...smf, ...partial } } });
  };

  const updateLogger = (logger: any): void => {
    onChange({ ...configs, smf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={sbiServer.address} onChange={(v) => updateSmf({ sbi: { ...smf.sbi, server: [{ ...sbiServer, address: v }] } })} tooltip={COMMON_TOOLTIPS.sbi_address} />
          <FieldWithTooltip label="Port" type="number" value={sbiServer.port} onChange={(v) => updateSmf({ sbi: { ...smf.sbi, server: [{ ...sbiServer, port: parseInt(v) || 7777 }] } })} tooltip={COMMON_TOOLTIPS.sbi_port} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SCP Client</h3>
        <FieldWithTooltip label="SCP URI" value={scpUri} onChange={(v) => updateSmf({ sbi: { ...smf.sbi, client: { ...smf.sbi.client, scp: [{ uri: v }] } } })} placeholder="http://127.0.0.200:7777" tooltip={COMMON_TOOLTIPS.scp_uri} />
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">NRF Client</h3>
        <FieldWithTooltip label="NRF URI" value={nrfUri} onChange={(v) => updateSmf({ sbi: { ...smf.sbi, client: { ...smf.sbi.client, nrf: [{ uri: v }] } } })} placeholder="http://127.0.0.10:7777" tooltip={COMMON_TOOLTIPS.nrf_uri} />
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">PFCP</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Server Address" value={pfcpServer.address} onChange={(v) => updateSmf({ pfcp: { ...smf.pfcp, server: [{ address: v }] } })} tooltip={SMF_TOOLTIPS.pfcp_server} />
          <FieldWithTooltip label="UPF Client Address" value={upfAddress} onChange={(v) => updateSmf({ pfcp: { ...smf.pfcp, client: { upf: [{ address: v }] } } })} placeholder="127.0.0.7" tooltip={SMF_TOOLTIPS.upf_address} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-C / GTP-U Servers</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="GTP-C Address" value={gtpcServer} onChange={(v) => updateSmf({ gtpc: { server: [{ address: v }] } })} placeholder="127.0.0.4" tooltip={SMF_TOOLTIPS.gtpc_address} />
          <FieldWithTooltip label="GTP-U Address" value={gtpuServer} onChange={(v) => updateSmf({ gtpu: { server: [{ address: v }] } })} placeholder="127.0.0.4" tooltip={SMF_TOOLTIPS.gtpu_address} />
        </div>
      </div>

      {smf.session && smf.session.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Session Pools</h3>
          {smf.session.map((sess: any, i: number) => (
            <div key={i} className="grid grid-cols-2 gap-4 mb-2">
              <FieldWithTooltip label="Subnet" value={sess.subnet} onChange={(v) => {
                const updated = [...smf.session];
                updated[i] = { ...updated[i], subnet: v };
                updateSmf({ session: updated });
              }} tooltip={SMF_TOOLTIPS.session_subnet} />
              <FieldWithTooltip label="Gateway" value={sess.gateway} onChange={(v) => {
                const updated = [...smf.session];
                updated[i] = { ...updated[i], gateway: v };
                updateSmf({ session: updated });
              }} tooltip={SMF_TOOLTIPS.session_gateway} />
            </div>
          ))}
        </div>
      )}

      {smf.dns && smf.dns.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">DNS Servers</h3>
          <div className="grid grid-cols-2 gap-4">
            {smf.dns.map((dns: string, i: number) => (
              <FieldWithTooltip key={i} label={`DNS ${i + 1}`} value={dns} onChange={(v) => {
                const updated = [...smf.dns];
                updated[i] = v;
                updateSmf({ dns: updated });
              }} tooltip={i === 0 ? SMF_TOOLTIPS.dns_primary : SMF_TOOLTIPS.dns_secondary} />
            ))}
          </div>
        </div>
      )}

      {/* S-NSSAI Configuration */}
      {smf.s_nssai && smf.s_nssai.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold font-display text-nms-accent">S-NSSAI (Network Slice Configuration)</h3>
            <button
              onClick={() => {
                const newSlice = { sst: 1, dnn: ['internet'] };
                updateSmf({ s_nssai: [...smf.s_nssai, newSlice] });
              }}
              className="nms-btn-ghost text-xs flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Slice
            </button>
          </div>
          {smf.s_nssai.map((slice: any, i: number) => (
            <div key={i} className="relative border border-nms-border rounded-lg p-3 mb-3">
              {smf.s_nssai.length > 1 && (
                <button
                  onClick={() => {
                    const updated = smf.s_nssai.filter((_: any, idx: number) => idx !== i);
                    updateSmf({ s_nssai: updated });
                  }}
                  className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                  title="Remove Slice"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              
              <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">Slice {i + 1}</div>
              
              <div className="grid grid-cols-2 gap-4 mb-3">
                <FieldWithTooltip
                  label="SST (Slice/Service Type)"
                  type="number"
                  value={slice.sst || 1}
                  onChange={(v) => {
                    const updated = [...smf.s_nssai];
                    updated[i] = { ...updated[i], sst: parseInt(v) || 1 };
                    updateSmf({ s_nssai: updated });
                  }}
                  placeholder="1"
                  tooltip={SMF_TOOLTIPS.s_nssai_sst}
                />
                <FieldWithTooltip
                  label="SD (Slice Differentiator)"
                  value={slice.sd || ''}
                  onChange={(v) => {
                    const updated = [...smf.s_nssai];
                    const cleanedSd = v.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
                    updated[i] = {
                      ...updated[i],
                      ...(cleanedSd ? { sd: cleanedSd } : { sd: undefined })
                    };
                    // Remove sd property if empty
                    if (!cleanedSd && updated[i].sd !== undefined) {
                      const { sd, ...rest } = updated[i];
                      updated[i] = rest;
                    }
                    updateSmf({ s_nssai: updated });
                  }}
                  placeholder="010203 (optional)"
                  tooltip={SMF_TOOLTIPS.s_nssai_sd}
                  mono={true}
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-nms-text uppercase tracking-wider mb-2 block">
                  DNN (Data Network Names)
                </label>
                <div className="space-y-2">
                  {(slice.dnn || []).map((dnn: string, dnnIdx: number) => (
                    <div key={dnnIdx} className="flex items-center gap-2">
                      <input
                        type="text"
                        className="nms-input flex-1 font-mono text-xs"
                        value={dnn}
                        onChange={(e) => {
                          const updated = [...smf.s_nssai];
                          const updatedDnn = [...(updated[i].dnn || [])];
                          updatedDnn[dnnIdx] = e.target.value;
                          updated[i] = { ...updated[i], dnn: updatedDnn };
                          updateSmf({ s_nssai: updated });
                        }}
                        placeholder="internet"
                      />
                      {(slice.dnn || []).length > 1 && (
                        <button
                          onClick={() => {
                            const updated = [...smf.s_nssai];
                            const updatedDnn = (updated[i].dnn || []).filter((_: string, idx: number) => idx !== dnnIdx);
                            updated[i] = { ...updated[i], dnn: updatedDnn };
                            updateSmf({ s_nssai: updated });
                          }}
                          className="text-nms-text-dim hover:text-nms-red transition-colors"
                          title="Remove DNN"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      const updated = [...smf.s_nssai];
                      const currentDnn = updated[i].dnn || [];
                      updated[i] = { ...updated[i], dnn: [...currentDnn, 'internet'] };
                      updateSmf({ s_nssai: updated });
                    }}
                    className="nms-btn-ghost text-xs w-full flex items-center justify-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add DNN
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Advanced Settings</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="MTU" type="number" value={smf.mtu || 1400} onChange={(v) => updateSmf({ mtu: parseInt(v) || 1400 })} tooltip={SMF_TOOLTIPS.mtu} />
          {smf.freeDiameter && (
            <FieldWithTooltip label="FreeDiameter Config" value={smf.freeDiameter} onChange={(v) => updateSmf({ freeDiameter: v })} placeholder="/etc/freeDiameter/smf.conf" tooltip={SMF_TOOLTIPS.freediameter} />
          )}
        </div>
      </div>

      {/* Metrics Server */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Metrics Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip 
            label="Address" 
            value={smf.metrics?.server?.[0]?.address || ''} 
            onChange={(v) => updateSmf({ metrics: { server: [{ address: v, port: smf.metrics?.server?.[0]?.port || 9090 }] } })} 
            tooltip={COMMON_TOOLTIPS.metrics_address} 
          />
          <FieldWithTooltip 
            label="Port" 
            type="number" 
            value={smf.metrics?.server?.[0]?.port || 9090} 
            onChange={(v) => updateSmf({ metrics: { server: [{ address: smf.metrics?.server?.[0]?.address || '', port: parseInt(v) || 9090 }] } })} 
            tooltip={COMMON_TOOLTIPS.metrics_port} 
          />
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}

// UPF Editor
function UpfEditor({ configs, onChange }: { configs: AllConfigs; onChange: (c: AllConfigs) => void }): JSX.Element {
  const fullYaml = configs.upf as any;
  const upf = fullYaml.upf || {};
  if (!upf?.pfcp?.server || upf.pfcp.server.length === 0) {
    return <div className="text-nms-text-dim">Loading UPF configuration...</div>;
  }
  const pfcpServer = upf.pfcp.server[0] || { address: '127.0.0.7', port: 8805 };
  const gtpuServer = upf.gtpu?.server?.[0] || { address: '10.0.1.175', port: 2152 };

  const updateUpf = (partial: any): void => {
    onChange({ ...configs, upf: { ...fullYaml, upf: { ...upf, ...partial } } });
  };

  const updateLogger = (logger: any): void => {
    onChange({ ...configs, upf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">PFCP Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={pfcpServer.address} onChange={(v) => updateUpf({ pfcp: { server: [{ ...pfcpServer, address: v }] } })} tooltip={COMMON_TOOLTIPS.sbi_address} />
          <FieldWithTooltip label="Port" type="number" value={pfcpServer.port || 8805} onChange={(v) => updateUpf({ pfcp: { server: [{ ...pfcpServer, port: parseInt(v) || 8805 }] } })} tooltip={COMMON_TOOLTIPS.sbi_port} />
        </div>
      </div>
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-U Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={gtpuServer.address} onChange={(v) => updateUpf({ gtpu: { server: [{ ...gtpuServer, address: v }] } })} tooltip={UPF_TOOLTIPS.gtpu_address} />
          <FieldWithTooltip label="Port" type="number" value={gtpuServer.port || 2152} onChange={(v) => updateUpf({ gtpu: { server: [{ ...gtpuServer, port: parseInt(v) || 2152 }] } })} tooltip={UPF_TOOLTIPS.gtpu_port} />
        </div>
      </div>
      {upf.session && upf.session.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Session Pools</h3>
          {upf.session.map((sess: any, i: number) => (
            <div key={i} className="grid grid-cols-2 gap-4 mb-2">
              <FieldWithTooltip label="Subnet" value={sess.subnet} onChange={(v) => {
                const updated = [...upf.session];
                updated[i] = { ...updated[i], subnet: v };
                updateUpf({ session: updated });
              }} tooltip={UPF_TOOLTIPS.session_subnet} />
              <FieldWithTooltip label="Gateway" value={sess.gateway} onChange={(v) => {
                const updated = [...upf.session];
                updated[i] = { ...updated[i], gateway: v };
                updateUpf({ session: updated });
              }} tooltip={UPF_TOOLTIPS.session_gateway} />
            </div>
          ))}
        </div>
      )}

      {/* Metrics Server */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Metrics Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip 
            label="Address" 
            value={upf.metrics?.server?.[0]?.address || ''} 
            onChange={(v) => updateUpf({ metrics: { server: [{ address: v, port: upf.metrics?.server?.[0]?.port || 9090 }] } })} 
            tooltip={COMMON_TOOLTIPS.metrics_address} 
          />
          <FieldWithTooltip 
            label="Port" 
            type="number" 
            value={upf.metrics?.server?.[0]?.port || 9090} 
            onChange={(v) => updateUpf({ metrics: { server: [{ address: upf.metrics?.server?.[0]?.address || '', port: parseInt(v) || 9090 }] } })} 
            tooltip={COMMON_TOOLTIPS.metrics_port} 
          />
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
  const scpUri = ausf.sbi?.client?.scp?.[0]?.uri || '';
  const nrfUri = ausf.sbi?.client?.nrf?.[0]?.uri || '';

  const updateAusf = (partial: any): void => {
    onChange({ ...configs, ausf: { ...fullYaml, ausf: { ...ausf, ...partial } } });
  };

  const updateLogger = (logger: any): void => {
    onChange({ ...configs, ausf: { ...fullYaml, logger } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip label="Address" value={server.address} onChange={(v) => updateAusf({ sbi: { ...ausf.sbi, server: [{ ...server, address: v }] } })} tooltip={COMMON_TOOLTIPS.sbi_address} />
          <FieldWithTooltip label="Port" type="number" value={server.port} onChange={(v) => updateAusf({ sbi: { ...ausf.sbi, server: [{ ...server, port: parseInt(v) || 7777 }] } })} tooltip={COMMON_TOOLTIPS.sbi_port} />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SCP Client</h3>
        <FieldWithTooltip label="SCP URI" value={scpUri} onChange={(v) => updateAusf({ sbi: { ...ausf.sbi, client: { ...ausf.sbi.client, scp: [{ uri: v }] } } })} placeholder="http://127.0.0.200:7777" tooltip={COMMON_TOOLTIPS.scp_uri} />
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">NRF Client</h3>
        <FieldWithTooltip label="NRF URI" value={nrfUri} onChange={(v) => updateAusf({ sbi: { ...ausf.sbi, client: { ...ausf.sbi.client, nrf: [{ uri: v }] } } })} placeholder="http://127.0.0.10:7777" tooltip={COMMON_TOOLTIPS.nrf_uri} />
      </div>

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

  const handleApply = async (): Promise<void> => {
    if (!configs) return;
    setApplying(true);
    try {
      const result = await configApi.apply(configs);
      console.log('Apply result:', result);
      console.log('result.success type:', typeof result.success, 'value:', result.success);
      if (result.success) {
        console.log('SUCCESS BRANCH');
        toast.success('Configuration applied successfully');
        useConfigStore.getState().setDirty(false);
        setValidation(null);
      } else if (result.rollback) {
        console.log('ROLLBACK BRANCH');
        toast.error('Apply failed - configuration rolled back');
      } else {
        console.log('FAILED BRANCH');
        toast.error('Apply failed');
      }
    } catch (err) {
      console.error('CATCH BRANCH:', err);
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

  const fiveGTabs: Tab[] = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf'];
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
          <button onClick={handleValidate} className="nms-btn-ghost flex items-center gap-2">
            <Shield className="w-4 h-4" /> Validate
          </button>
          <button
            onClick={handleApply}
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
            {activeTab === 'smf' && <SmfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'upf' && <UpfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'ausf' && <AusfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'udm' && <UdmEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'udr' && <UdrEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'pcf' && <PcfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'nssf' && <NssfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'bsf' && <BsfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'mme' && <MmeEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'hss' && <HssEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'pcrf' && <PcrfEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'sgwc' && <SgwcEditor configs={configs} onChange={updateConfigs} />}
            {activeTab === 'sgwu' && <SgwuEditor configs={configs} onChange={updateConfigs} />}
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
