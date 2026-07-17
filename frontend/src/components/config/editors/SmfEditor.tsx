import { useState } from 'react';
import { Plus, X, AlertTriangle, Info, Network, ExternalLink, Map } from 'lucide-react';
import type { AllConfigs } from '../../../types';
import { LoggerSection, SbiClientSection, FunctionInfoBox } from './SharedComponents';
import { FieldWithTooltip, SelectWithTooltip } from '../FieldsWithTooltips';
import { SMF_TOOLTIPS, COMMON_TOOLTIPS } from '../../../data/tooltips';
import { TopologyModal } from './TopologyModal';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
  onEditUpf?: (data: {
    pfcpAddress: string;
    dnn: string;
    tac: string;
    eCellId: string;
    nrCellId: string;
    subnet: string;
    gateway: string;
  }) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLoopback(ip: string): boolean {
  return ip.startsWith('127.') || ip === 'localhost' || ip === '::1';
}

// Routable addresses must come FIRST in the PFCP server list.
// Open5GS binds its PFCP socket to the first address — if that's a loopback
// it cannot send packets to remote routable peers (sendto returns EINVAL).
function sortPfcpServers<T extends { address: string }>(servers: T[]): T[] {
  return [...servers].sort((a, b) => {
    const aLoop = isLoopback(a.address);
    const bLoop = isLoopback(b.address);
    if (aLoop === bLoop) return 0;
    return aLoop ? 1 : -1;  // routable first, loopback last
  });
}

function getRoutableSmfPfcpAddresses(smf: any): string[] {
  const servers: Array<{ address: string }> = smf.pfcp?.server || [];
  return servers.map(s => s.address).filter(addr => addr && !isLoopback(addr));
}

// ── Main Component ────────────────────────────────────────────────────────────

export function SmfEditor({ configs, onChange, onEditUpf }: Props): JSX.Element {
  const fullYaml = configs.smf as any;
  const smf = fullYaml?.smf || {};

  // ── State ──────────────────────────────────────────────────────────────────
  const [selectedSmfAddress, setSelectedSmfAddress] = useState<string>('');
  const [showTopology, setShowTopology] = useState(false);

  if (!smf?.sbi?.server || smf.sbi.server.length === 0) {
    return <div className="text-nms-text-dim py-4">Loading SMF configuration...</div>;
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const sbiServer = smf.sbi.server[0] || { address: '127.0.0.4', port: 7777 };
  const pfcpServers: Array<{ address: string }> = smf.pfcp?.server || [{ address: '127.0.0.4' }];
  const upfClients: Array<{ address: string; dnn?: string | string[]; tac?: number | number[]; e_cell_id?: string | string[]; nr_cell_id?: string | string[] }> =
    smf.pfcp?.client?.upf || [];
  const sessions: Array<{ subnet: string; gateway: string; dnn?: string }> = smf.session || [];
  const routableAddresses = getRoutableSmfPfcpAddresses(smf);

  // Detect ALL local UPF addresses from upf.yaml pfcp.server list
  // so we correctly label routable UPF IPs as local when they match
  const localUpfPfcpAddresses: string[] = (
    (configs.upf as any)?.upf?.pfcp?.server ?? []
  ).map((s: any) => s.address).filter(Boolean);

  const isLocalUpf = (address: string): boolean => {
    if (!address) return false;
    if (isLoopback(address)) return true;
    // Match any address the local UPF is bound to
    if (localUpfPfcpAddresses.includes(address)) return true;
    return false;
  };

  // For display in session pool routing destination badge
  const localUpfPfcpAddress = localUpfPfcpAddresses[0] || '';

  // The address to use in generated remote configs — use selected or first routable
  const effectiveSmfAddress =
    selectedSmfAddress ||
    routableAddresses[0] ||
    '';

  // ── Updaters ───────────────────────────────────────────────────────────────
  const updateSmf = (partial: any) => {
    // Sort PFCP servers so routable addresses are always first
    if (partial.pfcp?.server) {
      partial = { ...partial, pfcp: { ...partial.pfcp, server: sortPfcpServers(partial.pfcp.server) } };
    }
    onChange({ ...configs, smf: { ...fullYaml, smf: { ...smf, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, smf: { ...fullYaml, logger } });
  };

  const updateUpfClients = (clients: typeof upfClients) => {
    updateSmf({ pfcp: { ...smf.pfcp, client: { ...smf.pfcp?.client, upf: clients } } });
  };

  // Sort sessions so DNN-specific pools come before default (no-DNN) pools.
  // Open5GS matches in order — default pool must be last or it catches everything first.
  const sortSessions = (sess: typeof sessions) => [
    ...sess.filter(s => s.dnn),   // DNN-specific first
    ...sess.filter(s => !s.dnn),  // Default (no DNN) last
  ];

  const updateSessions = (sess: typeof sessions) => {
    updateSmf({ session: sortSessions(sess) });
  };

  // ── UPF routing helpers ────────────────────────────────────────────────────

  const addUpfClient = () => {
    updateUpfClients([...upfClients, { address: '' }]);
  };

  // Remove a single remote UPF and its matching sessions
  const removeRemoteUpf = (idx: number) => {
    const client = upfClients[idx];
    const dnns: string[] = client.dnn
      ? (Array.isArray(client.dnn) ? client.dnn : [client.dnn])
      : [];
    const newClients = upfClients.filter((_, i) => i !== idx);
    const newSessions = dnns.length > 0
      ? sessions.filter(s => !s.dnn || !dnns.includes(s.dnn))
      : sessions;
    onChange({
      ...configs,
      smf: { ...fullYaml, smf: { ...smf,
        pfcp: { ...smf.pfcp, client: { ...smf.pfcp?.client, upf: newClients } },
        session: sortSessions(newSessions),
      }},
    });
  };

  // Remove ALL remote UPFs (non-local) and their matching sessions
  const removeAllRemoteUpfs = () => {
    const remoteClients = upfClients.filter(c => !isLocalUpf(c.address));
    const remoteDnns = new Set(
      remoteClients.flatMap(c =>
        c.dnn ? (Array.isArray(c.dnn) ? c.dnn : [c.dnn]) : []
      )
    );
    const newClients = upfClients.filter(c => isLocalUpf(c.address));
    const newSessions = remoteDnns.size > 0
      ? sessions.filter(s => !s.dnn || !remoteDnns.has(s.dnn))
      : sessions;
    onChange({
      ...configs,
      smf: { ...fullYaml, smf: { ...smf,
        pfcp: { ...smf.pfcp, client: { ...smf.pfcp?.client, upf: newClients } },
        session: sortSessions(newSessions),
      }},
    });
  };

  const remoteUpfCount = upfClients.filter(c => !isLocalUpf(c.address)).length;

  const updateUpfClient = (idx: number, patch: Partial<typeof upfClients[0]>) => {
    const updated = [...upfClients];
    updated[idx] = { ...updated[idx], ...patch };
    if (!updated[idx].dnn) delete updated[idx].dnn;
    if (!updated[idx].tac) delete updated[idx].tac;
    if (!updated[idx].e_cell_id) delete updated[idx].e_cell_id;
    if (!updated[idx].nr_cell_id) delete updated[idx].nr_cell_id;
    updateUpfClients(updated);
  };

  // Parse comma-separated values into array or single value
  const parseMultiValue = (v: string): string | string[] => {
    const parts = v.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
  };

  const parseMultiNumber = (v: string): number | number[] => {
    const parts = v.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    return parts.length === 1 ? parts[0] : parts;
  };

  const displayMultiValue = (v: string | string[] | number | number[] | undefined): string => {
    if (!v && v !== 0) return '';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  };

  // When user adds a DNN to a UPF, auto-create a matching session if one doesn't exist
  const autoCreateSession = (dnn: string) => {
    if (!dnn) return;
    const alreadyExists = sessions.some(s => s.dnn === dnn);
    if (alreadyExists) return;

    // Pick next available subnet (10.45, 10.46, 10.47...)
    const usedThirdOctets = sessions
      .map(s => {
        const m = s.subnet?.match(/^10\.(\d+)\./);
        return m ? parseInt(m[1]) : null;
      })
      .filter((n): n is number => n !== null);

    let nextOctet = 45;
    while (usedThirdOctets.includes(nextOctet)) nextOctet++;

    const newSession = {
      subnet: `10.${nextOctet}.0.0/16`,
      gateway: `10.${nextOctet}.0.1`,
      dnn,
    };
    updateSessions([...sessions, newSession]);
  };

  // ── No routable SMF address warning ─────────────────────────────────────
  const hasRoutableAddress = routableAddresses.length > 0;

  // Also read SGW-C SGW-U client list so session pools for 4G APNs
  // are correctly labeled as Remote SGW-U, not Local UPF
  const sgwuClients: Array<{ address: string; apn?: string | string[]; tac?: number | number[]; e_cell_id?: string | string[] }> =
    (configs.sgwc as any)?.sgwc?.pfcp?.client?.sgwu || [];

  // All local SGW-U addresses from sgwu.yaml
  const localSgwuAddresses: string[] = (
    (configs.sgwu as any)?.sgwu?.pfcp?.server ?? []
  ).map((s: any) => s.address).filter(Boolean);

  const isLocalSgwu = (address: string): boolean => {
    if (!address) return false;
    if (isLoopback(address)) return true;
    return localSgwuAddresses.includes(address);
  };

  // Given a session DNN, find which SGW-U handles it (if any)
  const findSgwuForDnn = (dnn: string | undefined): typeof sgwuClients[0] | null => {
    if (!dnn) return null;
    return sgwuClients.find(c => {
      if (isLocalSgwu(c.address)) return false;
      if (!c.apn) return false;
      const apns = Array.isArray(c.apn) ? c.apn : [c.apn];
      return apns.includes(dnn);
    }) || null;
  };

  return (
    <div className="space-y-8">
      {showTopology && <TopologyModal focus="upf" onClose={() => setShowTopology(false)} />}

      <FunctionInfoBox
        title="Session Management Function (SMF)"
        generation="4G + 5G"
        description="The SMF manages the full lifecycle of data sessions. In 5G it handles PDU session establishment, modification, and release for UEs — allocating IP addresses, selecting and controlling the UPF via PFCP (N4), and applying QoS policy from the PCF (N7). In 4G it acts as the PGW-C, connecting to the SGW-C via GTP-C (S5/S8). Each configured DNN/APN session block defines the IP pool, DNS servers, and UPF assignment for a specific network (e.g. internet, ims)."
      />

      {/* ── Section 1: SBI Server ── */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip
            label="Address"
            value={sbiServer.address}
            onChange={(v) => updateSmf({ sbi: { ...smf.sbi, server: [{ ...sbiServer, address: v }] } })}
            tooltip={COMMON_TOOLTIPS.sbi_address}
          />
          <FieldWithTooltip
            label="Port"
            type="number"
            value={sbiServer.port}
            onChange={(v) => updateSmf({ sbi: { ...smf.sbi, server: [{ ...sbiServer, port: parseInt(v) || 7777 }] } })}
            tooltip={COMMON_TOOLTIPS.sbi_port}
          />
          <FieldWithTooltip
            label="Advertise (optional)"
            value={sbiServer.advertise || ''}
            onChange={(v) => updateSmf({ sbi: { ...smf.sbi, server: [{ ...sbiServer, advertise: v || undefined }] } })}
            placeholder="smf.5gc.mnc070.mcc999.3gppnetwork.org:7777"
            tooltip={COMMON_TOOLTIPS.sbi_advertise}
          />
        </div>
      </div>

      <SbiClientSection
        client={smf.sbi?.client}
        onChange={(client) => updateSmf({ sbi: { ...smf.sbi, client } })}
      />

      {/* ── Section 2: PFCP Server ── */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-1">PFCP Server</h3>
        <p className="text-xs text-nms-text-dim mb-3">
          The SMF listens on these addresses for PFCP/N4 sessions. Keep the loopback for the local UPF.
          Add a routable IP if you have remote UPFs — they connect here.
        </p>
        <div className="space-y-2">
          {pfcpServers.map((srv, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="flex-1">
                <input
                  className="nms-input font-mono text-sm w-full"
                  value={srv.address}
                  onChange={(e) => {
                    const updated = [...pfcpServers];
                    updated[i] = { address: e.target.value };
                    updateSmf({ pfcp: { ...smf.pfcp, server: updated } });
                  }}
                  placeholder={i === 0 ? '127.0.0.4' : '10.0.1.155'}
                />
              </div>
              <span className="text-xs text-nms-text-dim shrink-0">
                {isLoopback(srv.address) ? '🔵 loopback (local UPF)' : '🟢 routable (remote UPF)'}
              </span>
              {pfcpServers.length > 1 && i > 0 && (
                <button
                  onClick={() => {
                    const updated = pfcpServers.filter((_, idx) => idx !== i);
                    updateSmf({ pfcp: { ...smf.pfcp, server: updated } });
                  }}
                  className="text-nms-text-dim hover:text-nms-red transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => updateSmf({ pfcp: { ...smf.pfcp, server: [...pfcpServers, { address: '' }] } })}
            className="nms-btn-ghost text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add PFCP Server Address
          </button>
        </div>
      </div>

      {/* ── Section 3: GTP-C / GTP-U ── */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-C / GTP-U Servers</h3>
        <div className="grid grid-cols-2 gap-4">
          <FieldWithTooltip
            label="GTP-C Address"
            value={smf.gtpc?.server?.[0]?.address || ''}
            onChange={(v) => updateSmf({ gtpc: { server: [{ address: v }] } })}
            placeholder="127.0.0.4"
            tooltip={SMF_TOOLTIPS.gtpc_address}
          />
          <FieldWithTooltip
            label="GTP-U Address"
            value={smf.gtpu?.server?.[0]?.address || ''}
            onChange={(v) => updateSmf({ gtpu: { server: [{ address: v }] } })}
            placeholder="127.0.0.4"
            tooltip={SMF_TOOLTIPS.gtpu_address}
          />
        </div>
      </div>

      {/* ── Section 4: UPF Routing ── */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
            <Network className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold font-display text-nms-text">UPF Routing Configuration</h3>
            <p className="text-xs text-nms-text-dim">
              The SMF selects which UPF handles each UE session based on these rules.
              Without routing rules the SMF uses the first UPF for all traffic.
            </p>
          </div>
          {remoteUpfCount > 0 && (
            <button
              onClick={() => {
                if (confirm(`Remove all ${remoteUpfCount} remote UPF(s) and their session pools? Local UPF will not be affected.`)) {
                  removeAllRemoteUpfs();
                }
              }}
              className="nms-btn-ghost text-xs flex items-center gap-1.5 text-nms-red hover:text-red-400 shrink-0"
              title="Remove all remote UPFs and their matching session pools"
            >
              <X className="w-3.5 h-3.5" /> Remove All Remote UPFs
            </button>
          )}
          <button
            onClick={() => setShowTopology(true)}
            className="nms-btn-ghost text-xs flex items-center gap-1.5 text-nms-text-dim hover:text-nms-accent shrink-0"
            title="Show remote UPF topology diagram"
          >
            <Map className="w-3.5 h-3.5" /> How it works
          </button>
        </div>

        {/* Routable address warning */}
        {!hasRoutableAddress && (
          <div className="mb-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-300">
              <p className="font-semibold mb-1">No routable PFCP address configured</p>
              <p>
                Your SMF only has loopback addresses. Remote UPFs won't be able to connect.
                Add a routable IP in the PFCP Server section above before adding remote UPFs.
              </p>
            </div>
          </div>
        )}

        {/* SMF address selector — shown when multiple routable addresses exist */}
        {routableAddresses.length > 1 && (
          <div className="mb-4 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-semibold text-nms-text mb-2">
                  Multiple routable SMF addresses found. Select the one remote UPFs can reach:
                </p>
                <div className="space-y-1">
                  {routableAddresses.map(addr => (
                    <label key={addr} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="smf-address"
                        value={addr}
                        checked={(selectedSmfAddress || routableAddresses[0]) === addr}
                        onChange={() => setSelectedSmfAddress(addr)}
                        className="accent-nms-accent"
                      />
                      <span className="font-mono text-sm text-nms-text">{addr}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-nms-text-dim mt-2">
                  ⚠️ Make sure you select the address that is reachable from the remote UPF's network.
                  The selected address will be used in generated remote UPF configs.
                </p>
              </div>
            </div>
          </div>
        )}

        {routableAddresses.length === 1 && (
          <div className="mb-4 p-3 rounded-lg border border-nms-border bg-nms-surface-2/30 text-xs text-nms-text-dim flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-nms-accent shrink-0" />
            <span>
              Remote UPFs will connect to SMF at{' '}
              <span className="font-mono text-nms-accent">{effectiveSmfAddress}</span>.
              This address will be used in generated remote UPF configs.
            </span>
          </div>
        )}

        {/* UPF client list */}
        <div className="space-y-3">
          {upfClients.length === 0 && (
            <div className="text-xs text-nms-text-dim p-3 border border-dashed border-nms-border rounded-lg text-center">
              No UPFs configured. Add a UPF below.
            </div>
          )}

          {upfClients.map((client, idx) => {
            const isLocal = isLocalUpf(client.address);
            const hasRoutingRules = !!(client.dnn || client.tac || client.e_cell_id || client.nr_cell_id);

            return (
              <div key={idx} className="border border-nms-border rounded-lg p-4 bg-nms-surface-2/30 space-y-4">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isLocal ? 'bg-nms-green' : 'bg-blue-400'}`} />
                    <span className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                      {isLocal ? 'Local UPF' : `Remote UPF ${idx}`}
                    </span>
                    {isLocal && (
                      <span className="text-[10px] bg-nms-green/10 text-nms-green border border-nms-green/20 rounded px-1.5 py-0.5">
                        same host
                      </span>
                    )}
                    {!isLocal && hasRoutingRules && (
                      <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded px-1.5 py-0.5">
                        routing rules set
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {!isLocal && onEditUpf && client.address && (
                      <button
                        onClick={() => {
                          // Find session for this UPF's DNN
                          const dnn = Array.isArray(client.dnn) ? client.dnn[0] : client.dnn || '';
                          const matchingSession = sessions.find((s: any) => s.dnn === dnn);
                          onEditUpf({
                            pfcpAddress: client.address,
                            dnn: displayMultiValue(client.dnn),
                            tac: displayMultiValue(client.tac),
                            eCellId: displayMultiValue(client.e_cell_id),
                            nrCellId: displayMultiValue(client.nr_cell_id),
                            subnet: matchingSession?.subnet || '',
                            gateway: matchingSession?.gateway || '',
                          });
                        }}
                        className="nms-btn-ghost text-xs flex items-center gap-1 text-blue-400 hover:text-blue-300"
                        title="Edit this UPF in the config generator"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Edit in Generator
                      </button>
                    )}
                    {!isLocal && upfClients.length > 1 && (
                      <button
                        onClick={() => {
                          if (confirm(`Remove Remote UPF ${idx} (${client.address}) and its matching session pools?`)) {
                            removeRemoteUpf(idx);
                          }
                        }}
                        className="text-nms-text-dim hover:text-nms-red transition-colors"
                        title="Remove this remote UPF and its session pools"
                        >
                        <X className="w-4 h-4" />
                        </button>
                        )}
                        </div>
                        </div>

                        {/* PFCP Address */}
                        <div>
                        <label className="nms-label">PFCP Address</label>
                        <input
                        className="nms-input font-mono text-sm"
                        value={client.address}
                        onChange={(e) => updateUpfClient(idx, { address: e.target.value })}
                        placeholder={isLocal ? '127.0.0.7 or 10.0.1.157' : '10.50.1.10'}
                        />
                        {!isLocal && client.address && isLoopback(client.address) && (
                    <p className="text-xs text-amber-400 mt-1 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Remote UPF cannot use a loopback address
                    </p>
                  )}
                </div>

                {/* Routing rules — only for remote UPFs */}
                {!isLocal && (
                  <div className="space-y-3 pt-1 border-t border-nms-border">
                    <p className="text-xs text-nms-text-dim pt-1">
                      Routing rules are optional. Without them, this UPF receives all traffic
                      (useful as a default). With rules, the SMF only routes matching sessions here.
                    </p>

                    {/* DNN */}
                    <div>
                      <label className="nms-label">
                        Route by DNN/APN
                        <span className="text-nms-text-dim font-normal ml-1">(optional — comma-separated)</span>
                      </label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={displayMultiValue(client.dnn)}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateUpfClient(idx, { dnn: v ? parseMultiValue(v) : undefined });
                          // Auto-create session for first DNN entered
                          const firstDnn = v.split(',')[0].trim();
                          if (firstDnn) autoCreateSession(firstDnn);
                        }}
                        placeholder="internet, remote, branch"
                      />
                      <p className="text-xs text-nms-text-dim mt-1">
                        Route UEs using this APN/DNN to this UPF. Example: <span className="font-mono">remote</span>
                      </p>
                    </div>

                    {/* TAC */}
                    <div>
                      <label className="nms-label">
                        Route by TAC
                        <span className="text-nms-text-dim font-normal ml-1">(optional — comma-separated, decimal)</span>
                      </label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={displayMultiValue(client.tac)}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateUpfClient(idx, { tac: v ? parseMultiNumber(v) : undefined });
                        }}
                        placeholder="2, 3, 4"
                      />
                      <p className="text-xs text-nms-text-dim mt-1">
                        Route UEs attached to these Tracking Area Codes to this UPF.
                      </p>
                    </div>

                    {/* Cell ID — 4G */}
                    <div>
                      <label className="nms-label">
                        Route by eNodeB Cell ID (4G)
                        <span className="text-nms-text-dim font-normal ml-1">(optional — comma-separated, hex)</span>
                      </label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={displayMultiValue(client.e_cell_id)}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateUpfClient(idx, { e_cell_id: v ? parseMultiValue(v) : undefined });
                        }}
                        placeholder="463, 1CF"
                      />
                      <p className="text-xs text-nms-text-dim mt-1">
                        28-bit eNodeB Cell ID in hex. Route UEs on specific 4G cells to this UPF.
                      </p>
                    </div>

                    {/* Cell ID — 5G */}
                    <div>
                      <label className="nms-label">
                        Route by NR Cell ID (5G)
                        <span className="text-nms-text-dim font-normal ml-1">(optional — comma-separated, hex)</span>
                      </label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={displayMultiValue(client.nr_cell_id)}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateUpfClient(idx, { nr_cell_id: v ? parseMultiValue(v) : undefined });
                        }}
                        placeholder="123456789, 9413"
                      />
                      <p className="text-xs text-nms-text-dim mt-1">
                        36-bit NR Cell ID in hex. Route UEs on specific 5G cells to this UPF.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <button
            onClick={addUpfClient}
            className="nms-btn-ghost w-full flex items-center justify-center gap-2 text-sm py-3"
          >
            <Plus className="w-4 h-4" /> Add UPF
          </button>
        </div>
      </div>

      {/* ── Section 5: Session Pools ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold font-display text-nms-accent">Session Pools (UE IP Ranges)</h3>
            <p className="text-xs text-nms-text-dim mt-0.5">
              IP pools assigned to UEs. Link a pool to a DNN to tie it to a specific UPF.
            </p>
          </div>
          <button
            onClick={() => {
              // Pick next available subnet
              const usedOctets = sessions.map(s => {
                const m = s.subnet?.match(/^10\.(\d+)\./);
                return m ? parseInt(m[1]) : null;
              }).filter((n): n is number => n !== null);
              let next = 45;
              while (usedOctets.includes(next)) next++;
              updateSessions([...sessions, { subnet: `10.${next}.0.0/16`, gateway: `10.${next}.0.1`, dnn: '' }]);
            }}
            className="nms-btn-ghost text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add Session Pool
          </button>
        </div>

        <div className="space-y-2">
          {sessions.map((sess, i) => {
            // Determine which UPF/SGW-U handles this session pool
            const matchingRemoteUpf = sess.dnn
              ? upfClients.find(c => {
                  if (!c.dnn || isLocalUpf(c.address)) return false;
                  const dnns = Array.isArray(c.dnn) ? c.dnn : [c.dnn];
                  return dnns.includes(sess.dnn!);
                })
              : null;

            // Check if this pool is for a 4G remote SGW-U (via sgwc.yaml)
            const matchingSgwu = findSgwuForDnn(sess.dnn);

            // Find the local UPF for display
            const localUpf = upfClients.find(c => isLocalUpf(c.address));
            const localUpfAddr = localUpf?.address || localUpfPfcpAddress || '127.0.0.7';

            return (
              <div key={i} className="border border-nms-border rounded-lg p-3 bg-nms-surface-2/30">
                <div className="grid grid-cols-3 gap-3 mb-2">
                  <FieldWithTooltip
                    label="Subnet"
                    value={sess.subnet || ''}
                    onChange={(v) => {
                      const updated = [...sessions];
                      updated[i] = { ...updated[i], subnet: v };
                      updateSessions(updated);
                    }}
                    placeholder="10.45.0.0/16"
                    tooltip={SMF_TOOLTIPS.session_subnet}
                  />
                  <FieldWithTooltip
                    label="Gateway"
                    value={sess.gateway || ''}
                    onChange={(v) => {
                      const updated = [...sessions];
                      updated[i] = { ...updated[i], gateway: v };
                      updateSessions(updated);
                    }}
                    placeholder="10.45.0.1"
                    tooltip={SMF_TOOLTIPS.session_gateway}
                  />
                  <div>
                    <FieldWithTooltip
                      label="DNN (optional)"
                      value={sess.dnn || ''}
                      onChange={(v) => {
                        const updated = [...sessions];
                        if (v) updated[i] = { ...updated[i], dnn: v };
                        else { const { dnn, ...rest } = updated[i]; updated[i] = rest; }
                        updateSessions(updated);
                      }}
                      placeholder="internet"
                      tooltip="Link this pool to a specific DNN. UEs requesting this APN/DNN get IPs from this range."
                    />
                    {/* Routing destination badge — always shown */}
                    <div className="mt-1">
                      {matchingSgwu ? (
                        <p className="text-xs text-purple-400 flex items-center gap-1">
                          <span>↗</span> Remote SGW-U (4G): <span className="font-mono">{matchingSgwu.address}</span>
                        </p>
                      ) : matchingRemoteUpf ? (
                        <p className="text-xs text-blue-400 flex items-center gap-1">
                          <span>↗</span> Remote UPF: <span className="font-mono">{matchingRemoteUpf.address}</span>
                        </p>
                      ) : (
                        <p className="text-xs text-nms-green flex items-center gap-1">
                          <span>↗</span> Local UPF: <span className="font-mono">{localUpfAddr}</span>
                          {!sess.dnn && <span className="text-nms-text-dim ml-1">(default pool)</span>}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex justify-end">
                  {sessions.length > 1 && (
                    <button
                      onClick={() => updateSessions(sessions.filter((_, idx) => idx !== i))}
                      className="text-nms-text-dim hover:text-nms-red transition-colors text-xs flex items-center gap-1"
                    >
                      <X className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section 6: DNS ── */}
      {smf.dns && smf.dns.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">DNS Servers</h3>
          <div className="grid grid-cols-2 gap-4">
            {smf.dns.map((dns: string, i: number) => (
              <FieldWithTooltip
                key={i}
                label={`DNS ${i + 1}`}
                value={dns}
                onChange={(v) => {
                  const updated = [...smf.dns];
                  updated[i] = v;
                  updateSmf({ dns: updated });
                }}
                tooltip={i === 0 ? SMF_TOOLTIPS.dns_primary : SMF_TOOLTIPS.dns_secondary}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Section 6b: Charging Trigger Function (CTF) ── */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Charging Trigger Function (CTF)</h3>
        <div className="grid grid-cols-2 gap-4">
          <SelectWithTooltip
            label="Enabled"
            value={smf.ctf?.enabled || 'auto'}
            onChange={(v) => updateSmf({ ctf: { enabled: v as 'auto' | 'yes' | 'no' } })}
            options={[
              { value: 'auto', label: 'auto (default) — only when charging is required' },
              { value: 'yes', label: 'yes — always enabled' },
              { value: 'no', label: 'no — disabled' },
            ]}
            tooltip={SMF_TOOLTIPS.ctf_enabled}
          />
        </div>
      </div>

      {/* ── Section 7: S-NSSAI (Network Slices) ── */}
      {(() => {
        // Open5GS stores S-NSSAI under smf.info[0].s_nssai (not smf.s_nssai)
        const infoBlock = smf.info?.[0] || {};
        const nssai: any[] = infoBlock.s_nssai || [{ sst: 1, dnn: ['internet'] }];

        const updateNssai = (updated: any[]) => {
          const newInfo = [{ ...(smf.info?.[0] || {}), s_nssai: updated }];
          updateSmf({ info: newInfo });
        };

        return (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold font-display text-nms-accent">
                S-NSSAI (Network Slice Configuration)
              </h3>
              <p className="text-xs text-nms-text-dim mt-0.5">
                5G only. Registers which DNNs this SMF serves with the NRF. Add all DNNs including remote UPF DNNs.
              </p>
            </div>
            <button
              onClick={() => updateNssai([...nssai, { sst: 1, dnn: ['internet'] }])}
              className="nms-btn-ghost text-xs flex items-center gap-1 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Add Slice
            </button>
          </div>
          {nssai.map((slice: any, i: number) => (
            <div key={i} className="relative border border-nms-border rounded-lg p-3 mb-3">
              {nssai.length > 1 && (
                <button
                  onClick={() => updateNssai(nssai.filter((_: any, idx: number) => idx !== i))}
                  className="absolute top-2 right-2 text-nms-text-dim hover:text-nms-red transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-2">
                Slice {i + 1}
              </div>
              <div className="grid grid-cols-2 gap-4 mb-3">
                <FieldWithTooltip
                  label="SST"
                  type="number"
                  value={slice.sst || 1}
                  onChange={(v) => {
                    const updated = [...nssai];
                    updated[i] = { ...updated[i], sst: parseInt(v) || 1 };
                    updateNssai(updated);
                  }}
                  tooltip={SMF_TOOLTIPS.s_nssai_sst}
                />
                <FieldWithTooltip
                  label="SD (optional)"
                  value={slice.sd || ''}
                  onChange={(v) => {
                    const updated = [...nssai];
                    if (v) updated[i] = { ...updated[i], sd: v };
                    else { const { sd, ...rest } = updated[i]; updated[i] = rest; }
                    updateNssai(updated);
                  }}
                  placeholder="000001"
                  tooltip={SMF_TOOLTIPS.s_nssai_sd}
                />
              </div>
              {/* DNN list for this slice */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                    DNNs advertised to NRF
                  </label>
                  <button
                    onClick={() => {
                      const updated = [...nssai];
                      updated[i] = { ...updated[i], dnn: [...(updated[i].dnn || []), ''] };
                      updateNssai(updated);
                    }}
                    className="nms-btn-ghost text-xs flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> Add DNN
                  </button>
                </div>
                <p className="text-xs text-nms-text-dim mb-2">
                  Add every DNN this SMF serves — including remote UPF DNNs.
                </p>
                <div className="space-y-1">
                  {(slice.dnn || []).map((dnn: string, di: number) => (
                    <div key={di} className="flex items-center gap-2">
                      <input
                        className="nms-input font-mono text-sm flex-1"
                        value={dnn}
                        placeholder="internet"
                        onChange={(e) => {
                          const updated = [...nssai];
                          const dnns = [...(updated[i].dnn || [])];
                          dnns[di] = e.target.value;
                          updated[i] = { ...updated[i], dnn: dnns };
                          updateNssai(updated);
                        }}
                      />
                      {(slice.dnn || []).length > 1 && (
                        <button
                          onClick={() => {
                            const updated = [...nssai];
                            updated[i] = { ...updated[i], dnn: (updated[i].dnn || []).filter((_: string, idx: number) => idx !== di) };
                            updateNssai(updated);
                          }}
                          className="text-nms-text-dim hover:text-nms-red transition-colors shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
        );
      })()}

      {/* ── Section 8: Metrics ── */}
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
