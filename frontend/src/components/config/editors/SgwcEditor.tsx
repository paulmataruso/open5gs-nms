import { useState } from 'react';
import { Plus, X, AlertTriangle, Info, Map } from 'lucide-react';
import type { AllConfigs } from '../../../types';
import { LoggerSection, FunctionInfoBox } from './SharedComponents';
import { TopologyModal } from './TopologyModal';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
  onEditSgwu?: (data: { pfcpAddress: string; gtpuAddress: string; tac: string; label: string }) => void;
}

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

function displayMultiValue(v: string | number | string[] | number[] | undefined): string {
  if (!v && v !== 0) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function parseMultiNumber(v: string): number | number[] {
  const parts = v.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  return parts.length === 1 ? parts[0] : parts;
}

function parseMultiString(v: string): string | string[] {
  const parts = v.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length === 1 ? parts[0] : parts;
}

function parseHexList(v: string): string | string[] {
  // Cell IDs are hex — keep as strings
  const parts = v.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length === 1 ? parts[0] : parts;
}

export function SgwcEditor({ configs, onChange, onEditSgwu }: Props): JSX.Element {
  const fullYaml = configs.sgwc as any;
  const sgwc = fullYaml?.sgwc || {};

  if (!sgwc?.gtpc?.server || sgwc.gtpc.server.length === 0) {
    return <div className="text-nms-text-dim">Loading SGW-C configuration...</div>;
  }

  const gtpcServer   = sgwc.gtpc.server[0] || { address: '127.0.0.3' };
  const pfcpServers: Array<{ address: string; port?: number }> = sgwc.pfcp?.server || [{ address: '127.0.0.3' }];
  const sgwuClients: Array<{ address: string; tac?: number | number[]; apn?: string | string[]; e_cell_id?: string | string[] }> = sgwc.pfcp?.client?.sgwu || [{ address: '127.0.0.6' }];

  // Detect ALL local SGW-U addresses from sgwu.yaml pfcp.server list
  const localSgwuPfcpAddresses: string[] = (
    (configs.sgwu as any)?.sgwu?.pfcp?.server ?? []
  ).map((s: any) => s.address).filter(Boolean);

  const isLocalSgwu = (address: string): boolean => {
    if (!address) return false;
    if (isLoopback(address)) return true;
    // Match any address the local SGW-U is bound to
    if (localSgwuPfcpAddresses.includes(address)) return true;
    return false;
  };

  const routableAddresses = pfcpServers.map(s => s.address).filter(a => a && !isLoopback(a));
  const hasRoutableAddress = routableAddresses.length > 0;
  const remoteSgwuCount = sgwuClients.filter(c => !isLocalSgwu(c.address)).length;

  const [selectedSgwcAddress, setSelectedSgwcAddress] = useState<string>('');
  const [showTopology, setShowTopology] = useState(false);
  const effectiveSgwcAddress = selectedSgwcAddress || routableAddresses[0] || '';

  // ── Updaters ──────────────────────────────────────────────────────────────

  const updateSgwc = (partial: any) => {
    // Sort PFCP servers so routable addresses are always first
    if (partial.pfcp?.server) {
      partial = { ...partial, pfcp: { ...partial.pfcp, server: sortPfcpServers(partial.pfcp.server) } };
    }
    onChange({ ...configs, sgwc: { ...fullYaml, sgwc: { ...sgwc, ...partial } } });
  };

  const updateLogger = (logger: any) => {
    onChange({ ...configs, sgwc: { ...fullYaml, logger } });
  };

  const updateSgwuClients = (clients: typeof sgwuClients) => {
    updateSgwc({ pfcp: { ...sgwc.pfcp, client: { ...sgwc.pfcp?.client, sgwu: clients } } });
  };

  const updateSgwuClient = (idx: number, patch: Partial<typeof sgwuClients[0]>) => {
    const updated = [...sgwuClients];
    updated[idx] = { ...updated[idx], ...patch };
    // Clean up undefined selection criteria
    if (!updated[idx].tac)      delete updated[idx].tac;
    if (!updated[idx].apn)      delete updated[idx].apn;
    if (!updated[idx].e_cell_id) delete updated[idx].e_cell_id;
    updateSgwuClients(updated);
  };

  const removeRemoteSgwu = (idx: number) => {
    updateSgwuClients(sgwuClients.filter((_, i) => i !== idx));
  };

  const removeAllRemoteSgwus = () => {
    updateSgwuClients(sgwuClients.filter(c => isLocalSgwu(c.address)));
  };

  return (
    <div className="space-y-8">
      {showTopology && <TopologyModal focus="sgwu" onClose={() => setShowTopology(false)} />}

      <FunctionInfoBox
        title="Serving Gateway — Control Plane (SGW-C)"
        generation="4G"
        description="The SGW-C is the control-plane component of the Serving Gateway in a CUPS (Control and User Plane Separation) architecture. It manages GTP tunnel signalling between the MME (S11), the PGW-C/SMF (S5/S8-C), and the SGW-U data plane (via PFCP/Sxa). The SGW-C handles session setup and teardown but passes no user traffic itself — all data flows through the SGW-U."
      />

      {/* ── Section 1: GTP-C Server ── */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">GTP-C Server</h3>
        <div>
          <label className="nms-label">Address</label>
          <input
            className="nms-input font-mono text-sm"
            value={gtpcServer.address}
            onChange={e => updateSgwc({ gtpc: { ...sgwc.gtpc, server: [{ ...gtpcServer, address: e.target.value }] } })}
          />
        </div>
      </div>

      {/* ── Section 2: PFCP Server ── */}
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-1">PFCP Server</h3>
        <p className="text-xs text-nms-text-dim mb-3">
          SGW-C listens here for PFCP/Gxc sessions. Keep loopback for the local SGW-U.
          Add a routable IP if you have remote SGW-Us — they connect here over the WAN.
        </p>
        <div className="space-y-2">
          {pfcpServers.map((srv, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="nms-input font-mono text-sm flex-1"
                value={srv.address}
                onChange={e => {
                  const updated = [...pfcpServers];
                  updated[i] = { ...updated[i], address: e.target.value };
                  updateSgwc({ pfcp: { ...sgwc.pfcp, server: updated } });
                }}
                placeholder={i === 0 ? '127.0.0.3' : '10.0.1.156'}
              />
              <span className="text-xs text-nms-text-dim shrink-0">
                {isLoopback(srv.address) ? '🔵 loopback (local SGW-U)' : '🟢 routable (remote SGW-U)'}
              </span>
              {pfcpServers.length > 1 && i > 0 && (
                <button
                  onClick={() => updateSgwc({ pfcp: { ...sgwc.pfcp, server: pfcpServers.filter((_, idx) => idx !== i) } })}
                  className="text-nms-text-dim hover:text-red-400 transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => updateSgwc({ pfcp: { ...sgwc.pfcp, server: [...pfcpServers, { address: '' }] } })}
            className="nms-btn-ghost text-xs flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> Add PFCP Server Address
          </button>
        </div>
      </div>

      {/* ── Section 3: SGW-U Routing ── */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="flex-1">
            <h3 className="text-base font-semibold font-display text-nms-text">SGW-U Routing Configuration</h3>
            <p className="text-xs text-nms-text-dim mt-0.5">
              SGW-C selects which SGW-U handles each eNodeB session. Without TAC rules the SGW-C uses
              the first SGW-U for all traffic.
            </p>
          </div>
          {remoteSgwuCount > 0 && (
            <button
              onClick={() => {
                if (confirm(`Remove all ${remoteSgwuCount} remote SGW-U(s)? Local SGW-U will not be affected.`)) {
                  removeAllRemoteSgwus();
                }
              }}
              className="nms-btn-ghost text-xs flex items-center gap-1.5 text-red-400 hover:text-red-300 shrink-0"
            >
              <X className="w-3.5 h-3.5" /> Remove All Remote SGW-Us
            </button>
          )}
          <button
            onClick={() => setShowTopology(true)}
            className="nms-btn-ghost text-xs flex items-center gap-1.5 text-nms-text-dim hover:text-nms-accent shrink-0"
            title="Show remote SGW-U topology diagram"
          >
            <Map className="w-3.5 h-3.5" /> How it works
          </button>
        </div>

        {/* No routable address warning */}
        {!hasRoutableAddress && remoteSgwuCount === 0 && (
          <div className="mb-4 p-3 rounded-lg border border-nms-border bg-nms-surface-2/30 flex items-start gap-2">
            <Info className="w-3.5 h-3.5 text-nms-accent shrink-0 mt-0.5" />
            <p className="text-xs text-nms-text-dim">
              All SGW-Us are on loopback — single-server deployment. To add a remote SGW-U,
              first add a routable IP to the PFCP Server section above, then click Add SGW-U below.
            </p>
          </div>
        )}

        {!hasRoutableAddress && remoteSgwuCount > 0 && (
          <div className="mb-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-300">
              <p className="font-semibold mb-1">No routable PFCP address configured</p>
              <p>Remote SGW-Us cannot connect. Add a routable IP in the PFCP Server section above.</p>
            </div>
          </div>
        )}

        {/* SMF address selector */}
        {routableAddresses.length > 1 && (
          <div className="mb-4 p-3 rounded-lg border border-blue-500/20 bg-blue-500/5">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-semibold text-nms-text mb-2">
                  Multiple routable SGW-C addresses found. Select the one remote SGW-Us can reach:
                </p>
                <div className="space-y-1">
                  {routableAddresses.map(addr => (
                    <label key={addr} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="sgwc-address"
                        value={addr}
                        checked={(selectedSgwcAddress || routableAddresses[0]) === addr}
                        onChange={() => setSelectedSgwcAddress(addr)}
                        className="accent-nms-accent"
                      />
                      <span className="font-mono text-sm text-nms-text">{addr}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {routableAddresses.length === 1 && (
          <div className="mb-4 p-3 rounded-lg border border-nms-border bg-nms-surface-2/30 text-xs text-nms-text-dim flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-nms-accent shrink-0" />
            <span>
              Remote SGW-Us will connect to SGW-C at{' '}
              <span className="font-mono text-nms-accent">{effectiveSgwcAddress}</span>.
              This address will be used in generated remote SGW-U configs.
            </span>
          </div>
        )}

        {/* SGW-U client list */}
        <div className="space-y-3">
          {sgwuClients.map((client, idx) => {
            const isLocal = isLocalSgwu(client.address);
            return (
              <div key={idx} className="border border-nms-border rounded-lg p-4 bg-nms-surface-2/30 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isLocal ? 'bg-green-400' : 'bg-blue-400'}`} />
                    <span className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                      {isLocal ? 'Local SGW-U' : `Remote SGW-U ${idx}`}
                    </span>
                    {isLocal && (
                      <span className="text-[10px] bg-green-400/10 text-green-400 border border-green-400/20 rounded px-1.5 py-0.5">
                        same host
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {!isLocal && onEditSgwu && client.address && (
                      <button
                        onClick={() => onEditSgwu({
                          pfcpAddress: client.address,
                          gtpuAddress: '',
                          tac: displayMultiValue(client.tac),
                          label: '',
                        })}
                        className="nms-btn-ghost text-xs flex items-center gap-1 text-blue-400 hover:text-blue-300"
                      >
                        Edit in Generator
                      </button>
                    )}
                    {!isLocal && (
                      <button
                        onClick={() => {
                          if (confirm(`Remove Remote SGW-U (${client.address})?`)) removeRemoteSgwu(idx);
                        }}
                        className="text-nms-text-dim hover:text-red-400 transition-colors"
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
                    onChange={e => updateSgwuClient(idx, { address: e.target.value })}
                    placeholder={isLocal ? '127.0.0.6' : '10.0.1.158'}
                  />
                  {!isLocal && client.address && isLoopback(client.address) && (
                    <p className="text-xs text-amber-400 mt-1 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Remote SGW-U cannot use a loopback address
                    </p>
                  )}
                </div>

                {/* Routing criteria — remote only */}
                {!isLocal && (
                  <div className="pt-2 border-t border-nms-border space-y-3">
                    <p className="text-xs font-semibold text-nms-text-dim">Routing Criteria <span className="font-normal">(optional — leave all blank to receive all traffic)</span></p>
                    <p className="text-xs text-nms-text-dim">Only one criterion should be set per SGW-U entry. Multiple values are comma-separated.</p>

                    {/* TAC */}
                    <div>
                      <label className="nms-label">TAC <span className="text-nms-text-dim font-normal">(decimal, e.g. 1 or 3,5,8)</span></label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={displayMultiValue(client.tac)}
                        onChange={e => {
                          const v = e.target.value;
                          updateSgwuClient(idx, {
                            tac:       v ? parseMultiNumber(v) : undefined,
                            apn:       undefined,
                            e_cell_id: undefined,
                          });
                        }}
                        placeholder="1  or  3, 5, 8"
                      />
                      <p className="text-xs text-nms-text-dim mt-1">Route eNodeBs with these Tracking Area Codes to this SGW-U.</p>
                    </div>

                    {/* APN */}
                    <div>
                      <label className="nms-label">APN <span className="text-nms-text-dim font-normal">(e.g. internet or ims,internet)</span></label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={displayMultiValue(client.apn)}
                        onChange={e => {
                          const v = e.target.value;
                          updateSgwuClient(idx, {
                            apn:       v ? parseMultiString(v) : undefined,
                            tac:       undefined,
                            e_cell_id: undefined,
                          });
                        }}
                        placeholder="internet  or  ims, internet"
                      />
                      <p className="text-xs text-nms-text-dim mt-1">Route UEs on these APNs to this SGW-U.</p>
                    </div>

                    {/* Cell ID */}
                    <div>
                      <label className="nms-label">Cell ID / e_cell_id <span className="text-nms-text-dim font-normal">(hex, 28-bit, e.g. 463 or 123456789,9413)</span></label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={displayMultiValue(client.e_cell_id)}
                        onChange={e => {
                          const v = e.target.value;
                          updateSgwuClient(idx, {
                            e_cell_id: v ? parseHexList(v) : undefined,
                            tac:       undefined,
                            apn:       undefined,
                          });
                        }}
                        placeholder="463  or  123456789, 9413"
                      />
                      <p className="text-xs text-nms-text-dim mt-1">Route eNodeBs with these Cell IDs to this SGW-U. Hex representation.</p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <button
            onClick={() => updateSgwuClients([...sgwuClients, { address: '' }])}
            className="nms-btn-ghost w-full flex items-center justify-center gap-2 text-sm py-3"
          >
            <Plus className="w-4 h-4" /> Add SGW-U
          </button>
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />
    </div>
  );
}
