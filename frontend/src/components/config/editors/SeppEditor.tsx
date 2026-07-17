import { useState, useEffect } from 'react';
import { stringify as stringifyYaml } from 'yaml';
import { Copy, Check, KeyRound, Loader2, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import type { AllConfigs } from '../../../types';
import { LoggerSection, SbiClientSection, FunctionInfoBox } from './SharedComponents';
import { LabelWithTooltip } from '../../common/UniversalTooltipWrappers';
import { COMMON_TOOLTIPS } from '../../../data/tooltips';
import { seppApi } from '../../../api/sepp';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';

interface Props {
  configs: AllConfigs;
  onChange: (c: AllConfigs) => void;
}

const TLS_PATHS = {
  server: {
    private_key: '/etc/open5gs/tls/sepp.key',
    cert: '/etc/open5gs/tls/sepp.crt',
    verify_client: true,
    verify_client_cacert: '/etc/open5gs/tls/sepp-peer-ca.crt',
  },
  client: {
    cacert: '/etc/open5gs/tls/sepp-peer-ca.crt',
    client_private_key: '/etc/open5gs/tls/sepp.key',
    client_cert: '/etc/open5gs/tls/sepp.crt',
  },
};

export function SeppEditor({ configs, onChange }: Props): JSX.Element {
  const fullYaml = configs.sepp1 as any;
  const sepp = fullYaml?.sepp || {};

  const [existingCert, setExistingCert] = useState<string | null>(null);
  const [generatingCerts, setGeneratingCerts] = useState(false);
  const [peerCertInput, setPeerCertInput] = useState('');
  const [savingPeerCert, setSavingPeerCert] = useState(false);
  const [copiedCert, setCopiedCert] = useState(false);
  const copyToClipboard = useCopyToClipboard();

  // Visited-PLMN config generator — separate, ephemeral form state
  const [vpFqdn, setVpFqdn] = useState('sepp2.localdomain');
  const [vpAddress, setVpAddress] = useState('10.10.2.251');
  const [vpPort, setVpPort] = useState(7777);
  const [vpN32fAddress, setVpN32fAddress] = useState('10.10.2.252');
  const [vpN32fPort, setVpN32fPort] = useState(7777);
  const [generatedYaml, setGeneratedYaml] = useState<string | null>(null);
  const [copiedYaml, setCopiedYaml] = useState(false);

  useEffect(() => {
    seppApi.getCert().then(r => { if (r.exists && r.cert) setExistingCert(r.cert); }).catch(() => {});
    seppApi.getPeerCert().then(r => { if (r.exists && r.cert) setPeerCertInput(r.cert); }).catch(() => {});
  }, []);

  if (!sepp?.sbi?.server || sepp.sbi.server.length === 0) {
    return <div className="text-nms-text-dim">Loading SEPP configuration...</div>;
  }

  const server   = sepp.sbi.server[0] || { address: '127.0.1.250', port: 7777 };
  const n32Server = sepp.n32?.server?.[0] || { sender: 'sepp1.localdomain', scheme: 'http', address: '', port: 7777 };
  const n32f     = n32Server.n32f || {};
  const peer     = sepp.n32?.client?.sepp?.[0] || { receiver: '', uri: '', resolve: '', n32f: { uri: '', resolve: '' } };
  const tlsEnabled = n32Server.scheme === 'https';

  const updateSepp = (partial: any) => {
    onChange({ ...configs, sepp1: { ...fullYaml, sepp: { ...sepp, ...partial } } });
  };
  const updateLogger = (logger: any) => {
    onChange({ ...configs, sepp1: { ...fullYaml, logger } });
  };
  const updateN32Server = (partial: any) => {
    updateSepp({ n32: { ...sepp.n32, server: [{ ...n32Server, ...partial }] } });
  };
  const updateN32f = (partial: any) => {
    updateN32Server({ n32f: { ...n32f, ...partial } });
  };
  const updatePeer = (partial: any) => {
    updateSepp({ n32: { ...sepp.n32, client: { sepp: [{ ...peer, ...partial }] } } });
  };
  const updatePeerN32f = (partial: any) => {
    updatePeer({ n32f: { ...peer.n32f, ...partial } });
  };

  const setTlsEnabled = (enabled: boolean) => {
    updateSepp({
      n32: {
        server: [{ ...n32Server, scheme: enabled ? 'https' : 'http', n32f: { ...n32f, scheme: enabled ? 'https' : 'http' } }],
        client: { sepp: [{ ...peer, uri: peer.uri, n32f: peer.n32f }] },
      },
      default: enabled ? { ...sepp.default, tls: TLS_PATHS } : undefined,
    });
  };

  const handleGenerateCerts = async () => {
    if (!n32Server.sender) { toast.error('Set your SEPP FQDN identity (N32 sender) first'); return; }
    setGeneratingCerts(true);
    try {
      const r = await seppApi.generateCerts(n32Server.sender);
      if (r.success && r.cert) {
        setExistingCert(r.cert);
        toast.success('Certificate generated — remember to Save & Apply so the paths take effect');
      } else {
        toast.error(r.error || 'Certificate generation failed');
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.error ?? e?.message ?? String(e));
    } finally {
      setGeneratingCerts(false);
    }
  };

  const handleSavePeerCert = async () => {
    setSavingPeerCert(true);
    try {
      const r = await seppApi.savePeerCert(peerCertInput);
      if (r.success) toast.success('Peer certificate saved');
      else toast.error(r.error || 'Failed to save peer certificate');
    } catch (e: any) {
      toast.error(e?.response?.data?.error ?? e?.message ?? String(e));
    } finally {
      setSavingPeerCert(false);
    }
  };

  const copyCert = async () => {
    if (!existingCert) return;
    const ok = await copyToClipboard(existingCert);
    if (ok) { setCopiedCert(true); setTimeout(() => setCopiedCert(false), 2000); toast.success('Copied'); }
  };

  const handleGenerateVisitedConfig = () => {
    const scheme = tlsEnabled ? 'https' : 'http';
    const visitedYamlObj: any = {
      logger: { file: { path: '/var/log/open5gs/sepp2.log' } },
      sepp: {
        sbi: {
          server: [{ address: '127.0.2.250', port: 7777 }],
          client: { scp: [{ uri: 'http://127.0.0.200:7777' }] },
        },
        n32: {
          server: [{
            sender: vpFqdn,
            scheme,
            address: vpAddress,
            port: vpPort,
            n32f: { scheme, address: vpN32fAddress, port: vpN32fPort },
          }],
          client: {
            sepp: [{
              receiver: n32Server.sender,
              uri: `${scheme}://${n32Server.sender}:${n32Server.port || 7777}`,
              resolve: n32Server.address || undefined,
              n32f: {
                uri: `${scheme}://${n32Server.sender}:${n32f.port || 7777}`,
                resolve: n32f.address || undefined,
              },
            }],
          },
        },
      },
    };
    if (tlsEnabled) {
      visitedYamlObj.sepp.default = {
        tls: {
          server: { private_key: '/etc/open5gs/tls/sepp2.key', cert: '/etc/open5gs/tls/sepp2.crt', verify_client: true, verify_client_cacert: '/etc/open5gs/tls/sepp-peer-ca.crt' },
          client: { cacert: '/etc/open5gs/tls/sepp-peer-ca.crt', client_private_key: '/etc/open5gs/tls/sepp2.key', client_cert: '/etc/open5gs/tls/sepp2.crt' },
        },
      };
    }

    let yaml = stringifyYaml(visitedYamlObj, { indent: 2, lineWidth: 120 });
    if (tlsEnabled && existingCert) {
      yaml += `\n# ── Our home SEPP's public certificate ──────────────────────────────────\n`;
      yaml += `# Save this as /etc/open5gs/tls/sepp-peer-ca.crt on the visited network's\n`;
      yaml += `# host — it's referenced above as cacert/verify_client_cacert.\n`;
      yaml += `#\n`;
      yaml += existingCert.split('\n').map(l => `# ${l}`).join('\n') + '\n';
    }
    setGeneratedYaml(yaml);
  };

  const copyGeneratedYaml = async () => {
    if (!generatedYaml) return;
    const ok = await copyToClipboard(generatedYaml);
    if (ok) { setCopiedYaml(true); setTimeout(() => setCopiedYaml(false), 2000); toast.success('Copied'); }
  };

  const downloadGeneratedYaml = () => {
    if (!generatedYaml) return;
    const blob = new Blob([generatedYaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sepp2.yaml';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <FunctionInfoBox
        title="Security Edge Protection Proxy (SEPP)"
        generation="5G"
        description="The SEPP protects the boundary between our 5G core (home PLMN) and a visited network's core during roaming. It exchanges signaling with the visited network's own SEPP over the N32 interface — N32-c (control) negotiates the security parameters, N32-f (forwarding) actually carries the inter-PLMN SBI traffic. This is a 5G-only concept; 4G EPC roaming uses S6a/S9 instead, unrelated to SEPP."
      />

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">SBI Server</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_address}>Address</LabelWithTooltip></label>
            <input
              className="nms-input font-mono text-xs"
              value={server.address}
              onChange={(e) => updateSepp({ sbi: { ...sepp.sbi, server: [{ ...server, address: e.target.value }] } })}
            />
          </div>
          <div>
            <label className="nms-label"><LabelWithTooltip tooltip={COMMON_TOOLTIPS.sbi_port}>Port</LabelWithTooltip></label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={server.port}
              onChange={(e) => updateSepp({ sbi: { ...sepp.sbi, server: [{ ...server, port: parseInt(e.target.value) || 7777 }] } })}
            />
          </div>
        </div>
      </div>

      <SbiClientSection
        client={sepp.sbi?.client}
        onChange={(client) => updateSepp({ sbi: { ...sepp.sbi, client } })}
      />

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">N32 — Our Home Identity</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label">Sender FQDN (our SEPP identity)</label>
            <input
              className="nms-input font-mono text-xs"
              value={n32Server.sender}
              onChange={(e) => updateN32Server({ sender: e.target.value })}
              placeholder="sepp.5gc.mnc070.mcc999.3gppnetwork.org"
            />
          </div>
          <div>
            <label className="nms-label">N32-c Address</label>
            <input
              className="nms-input font-mono text-xs"
              value={n32Server.address || ''}
              onChange={(e) => updateN32Server({ address: e.target.value })}
            />
          </div>
          <div>
            <label className="nms-label">N32-c Port</label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={n32Server.port || 7777}
              onChange={(e) => updateN32Server({ port: parseInt(e.target.value) || 7777 })}
            />
          </div>
          <div>
            <label className="nms-label">N32-f Address</label>
            <input
              className="nms-input font-mono text-xs"
              value={n32f.address || ''}
              onChange={(e) => updateN32f({ address: e.target.value })}
            />
          </div>
          <div>
            <label className="nms-label">N32-f Port</label>
            <input
              type="number"
              className="nms-input font-mono text-xs"
              value={n32f.port || 7777}
              onChange={(e) => updateN32f({ port: parseInt(e.target.value) || 7777 })}
            />
          </div>
        </div>
      </div>

      <div className="border border-nms-border rounded-md p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="sepp-tls-enabled"
            className="nms-checkbox"
            checked={tlsEnabled}
            onChange={(e) => setTlsEnabled(e.target.checked)}
          />
          <label htmlFor="sepp-tls-enabled" className="text-sm font-semibold text-nms-text">
            Enable TLS / mutual-TLS on N32
          </label>
        </div>
        <p className="text-xs text-nms-text-dim">
          Uses a self-signed certificate as its own trust anchor (a real GSMA-IPX-backed roaming
          PKI is out of scope here). Generate our certificate below, share its public key with the
          visited-network operator, and paste theirs in return — each side trusts the other's exact
          certificate directly.
        </p>
        {tlsEnabled && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2">
              <button
                onClick={handleGenerateCerts}
                disabled={generatingCerts}
                className="nms-btn-primary flex items-center gap-2 text-sm disabled:opacity-50"
              >
                {generatingCerts ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                Generate Certs
              </button>
              {existingCert && <span className="text-xs text-green-400">Certificate present</span>}
            </div>
            {existingCert && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="nms-label mb-0">Our Public Certificate (share with visited operator)</label>
                  <button onClick={copyCert} className="flex items-center gap-1.5 text-xs text-nms-accent hover:text-nms-accent-hover">
                    {copiedCert ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCert ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre className="bg-nms-surface-2 border border-nms-border rounded-md p-2 text-xs font-mono text-nms-text-dim overflow-x-auto max-h-32 overflow-y-auto">{existingCert}</pre>
              </div>
            )}
            <div>
              <label className="nms-label">Visited SEPP's Public Certificate (paste PEM)</label>
              <textarea
                className="nms-input font-mono text-xs w-full h-24"
                value={peerCertInput}
                onChange={(e) => setPeerCertInput(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
              />
              <button
                onClick={handleSavePeerCert}
                disabled={savingPeerCert || !peerCertInput.trim()}
                className="nms-btn-ghost text-xs mt-2 disabled:opacity-50"
              >
                {savingPeerCert ? 'Saving...' : 'Save Peer Certificate'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">N32 — Visited PLMN Peer</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="nms-label">Receiver FQDN (their SEPP identity)</label>
            <input
              className="nms-input font-mono text-xs"
              value={peer.receiver}
              onChange={(e) => updatePeer({ receiver: e.target.value })}
              placeholder="sepp.5gc.mnc001.mcc001.3gppnetwork.org"
            />
          </div>
          <div>
            <label className="nms-label">N32-c URI</label>
            <input
              className="nms-input font-mono text-xs"
              value={peer.uri}
              onChange={(e) => updatePeer({ uri: e.target.value })}
              placeholder={`${tlsEnabled ? 'https' : 'http'}://<their N32-c host>:7777`}
            />
          </div>
          <div>
            <label className="nms-label">N32-c Resolve IP (optional)</label>
            <input
              className="nms-input font-mono text-xs"
              value={peer.resolve || ''}
              onChange={(e) => updatePeer({ resolve: e.target.value || undefined })}
              placeholder="only needed if the URI host isn't DNS-resolvable"
            />
          </div>
          <div>
            <label className="nms-label">N32-f URI</label>
            <input
              className="nms-input font-mono text-xs"
              value={peer.n32f?.uri || ''}
              onChange={(e) => updatePeerN32f({ uri: e.target.value })}
              placeholder={`${tlsEnabled ? 'https' : 'http'}://<their N32-f host>:7777`}
            />
          </div>
          <div>
            <label className="nms-label">N32-f Resolve IP (optional)</label>
            <input
              className="nms-input font-mono text-xs"
              value={peer.n32f?.resolve || ''}
              onChange={(e) => updatePeerN32f({ resolve: e.target.value || undefined })}
            />
          </div>
        </div>
      </div>

      <LoggerSection logger={fullYaml.logger || {}} onChange={updateLogger} />

      <div className="border-t border-nms-border pt-6">
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-1">Generate Visited PLMN Config</h3>
        <p className="text-xs text-nms-text-dim mb-3">
          Builds a complete <span className="font-mono">sepp.yaml</span> for the visited network's operator,
          pointing back at our home SEPP's identity/address configured above (save this page first so the
          values below reflect what's actually configured).
        </p>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="nms-label">Visited SEPP FQDN Identity</label>
            <input className="nms-input font-mono text-xs" value={vpFqdn} onChange={(e) => setVpFqdn(e.target.value)} />
          </div>
          <div />
          <div>
            <label className="nms-label">Visited N32-c Address</label>
            <input className="nms-input font-mono text-xs" value={vpAddress} onChange={(e) => setVpAddress(e.target.value)} />
          </div>
          <div>
            <label className="nms-label">Visited N32-c Port</label>
            <input type="number" className="nms-input font-mono text-xs" value={vpPort} onChange={(e) => setVpPort(parseInt(e.target.value) || 7777)} />
          </div>
          <div>
            <label className="nms-label">Visited N32-f Address</label>
            <input className="nms-input font-mono text-xs" value={vpN32fAddress} onChange={(e) => setVpN32fAddress(e.target.value)} />
          </div>
          <div>
            <label className="nms-label">Visited N32-f Port</label>
            <input type="number" className="nms-input font-mono text-xs" value={vpN32fPort} onChange={(e) => setVpN32fPort(parseInt(e.target.value) || 7777)} />
          </div>
        </div>
        <button onClick={handleGenerateVisitedConfig} className="nms-btn-primary text-sm">Generate</button>

        {generatedYaml && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="nms-label mb-0">Generated sepp.yaml (for the visited operator)</label>
              <div className="flex items-center gap-3">
                <button onClick={copyGeneratedYaml} className="flex items-center gap-1.5 text-xs text-nms-accent hover:text-nms-accent-hover">
                  {copiedYaml ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedYaml ? 'Copied!' : 'Copy'}
                </button>
                <button onClick={downloadGeneratedYaml} className="flex items-center gap-1.5 text-xs text-nms-accent hover:text-nms-accent-hover">
                  <Download className="w-3.5 h-3.5" /> Download
                </button>
              </div>
            </div>
            <pre className="bg-nms-surface-2 border border-nms-border rounded-md p-3 text-xs font-mono text-nms-text overflow-x-auto max-h-96 overflow-y-auto whitespace-pre">{generatedYaml}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
