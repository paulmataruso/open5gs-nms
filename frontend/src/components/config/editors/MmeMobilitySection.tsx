import { useEffect, useState } from 'react';
import { ExternalLink, Plus, RefreshCw, X } from 'lucide-react';
import { configApi } from '../../../api';
import type { MmeMobilityPeer, MmeMobilitySupport, YamlPlmnId } from '../../../types';
import { FieldWithTooltip } from '../FieldsWithTooltips';
import { asList } from './address-field';
import { HostnameWarning } from './hostname-warning';

interface Props {
  peers: MmeMobilityPeer[];
  onChange: (peers: MmeMobilityPeer[]) => void;
}

const numeric = (value: string): number => value === '' ? NaN : Number(value);
const shown = (value: number | undefined): number | string =>
  value !== undefined && Number.isFinite(value) ? value : '';
const DEFAULT_PLMN = { mcc: '001', mnc: '01' };

// MmeMobilityPeer is the YAML DOCUMENT shape, where every field is optional --
// a hand-edited file, or one written by an older NMS, may be missing any of
// them, and open5gs-yaml.ts's own rules say a present field is the exception to
// prove. These read a peer for DISPLAY without inventing values: an absent
// GUMMEI shows as blank fields the operator must fill, not as a fabricated
// default that would then be saved back as if they had chosen it.
type PeerGummei = NonNullable<MmeMobilityPeer['gummei']>;
const gummeiOf = (peer: MmeMobilityPeer): PeerGummei => peer.gummei ?? {};
const plmnOf = (value: { plmn_id?: YamlPlmnId } | undefined): YamlPlmnId => value?.plmn_id ?? {};

export function MmeMobilitySection({ peers, onChange }: Props): JSX.Element {
  const [support, setSupport] = useState<MmeMobilitySupport | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  // The check runs on mount and again whenever `attempt` is bumped by the
  // Check button, and every write to state happens in a settlement callback
  // guarded by `current`. Two reasons, beyond satisfying
  // react-hooks/set-state-in-effect: an operator can press Check while a
  // check is still in flight, and without the guard a slow earlier response
  // landing afterwards would overwrite the newer verdict -- which here means
  // the form could be re-enabled against a stale "supported". The same guard
  // covers unmounting mid-request, since the editor is torn down whenever the
  // config page switches NF tabs.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    configApi.getMmeMobilitySupport().then(
      (result) => { if (current) { setSupport(result); setError(''); setChecking(false); } },
      () => {
        if (!current) return;
        setSupport(null);
        setError('Unable to check the MME. Check the NMS connection and try again.');
        setChecking(false);
      },
    );
    return () => { current = false; };
  }, [attempt]);
  const recheck = () => { setChecking(true); setError(''); setAttempt((n) => n + 1); };
  const enabled = !checking && support?.status === 'supported';

  const update = (index: number, changes: Partial<MmeMobilityPeer>) =>
    onChange(peers.map((peer, i) => i === index ? { ...peer, ...changes } : peer));
  const addPeer = () => onChange([...peers, {
    address: '', port: 2123,
    gummei: { plmn_id: { ...DEFAULT_PLMN }, mme_gid: 2, mme_code: 2 },
  }]);

  return (
    <section className="space-y-3" aria-labelledby="mme-mobility-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="mme-mobility-heading" className="text-sm font-semibold font-display text-nms-accent">Inter-MME Mobility</h3>
        <button type="button" className="nms-btn-ghost text-xs inline-flex items-center gap-2" onClick={recheck} disabled={checking}>
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
          {checking ? 'Checking MME…' : 'Check compatibility'}
        </button>
      </div>
      <p className="text-xs text-nms-text-dim">
        Configure neighboring MMEs for context transfer, tracking-area updates and S1 handover over S10.
        The local endpoint is the GTP-C Server above (UDP 2123 by default), shared with S11.
      </p>
      <div role="status" className="rounded border border-nms-border bg-nms-bg p-3 text-xs space-y-2">
        <p className={enabled ? 'text-nms-green' : 'text-nms-text'}>
          {checking ? 'Verifying the installed and running MME…' : error || support?.message}
        </p>
        {!checking && support && ['unsupported', 'not_installed'].includes(support.status) && (
          <div>
            <p className="font-semibold mb-1">Open5GS update required</p>
            <p>Install a build containing inter-MME mobility support, then restart the MME and check compatibility again. Updating NMS alone does not add this feature to Open5GS.</p>
            <a href="https://github.com/open5gs/open5gs/pull/5019" target="_blank" rel="noopener noreferrer" className="text-nms-accent inline-flex items-center gap-1 mt-2">
              Open5GS implementation and installation guide <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
        {support?.executable && <p className="font-mono break-all text-nms-text-dim">{support.executable}</p>}
      </div>

      <fieldset disabled={!enabled} className="space-y-3 disabled:opacity-60">
        <legend className="sr-only">Neighboring MMEs</legend>
        {peers.length === 0 && <p className="text-xs text-nms-text-dim">No neighboring MMEs configured.</p>}
        {peers.map((peer, index) => {
          // Scalar-or-list, like every other repeatable Open5GS value: a file
          // with one tracking area parses as a plain object, not a list of one.
          const areas = asList(peer.tai);
          const gummei = gummeiOf(peer);
          const identity = plmnOf(gummei);
          const setIdentity = (changes: Partial<PeerGummei>) =>
            update(index, { gummei: { ...gummei, ...changes } });
          return (
            <div key={index} className="rounded border border-nms-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Neighbor MME {index + 1}</h4>
                <button type="button" aria-label={`Remove neighbor MME ${index + 1}`} className="text-nms-red p-1" onClick={() => onChange(peers.filter((_, i) => i !== index))}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <FieldWithTooltip label="Remote MME address" value={peer.address ?? ''} required onChange={address => update(index, { address })} placeholder="192.0.2.20"
                  tooltip="The remote MME's GTP-C listener: an IP address or resolvable host name. Configure this MME as a reciprocal neighbor on the remote system. Both endpoints need UDP connectivity." />
                <FieldWithTooltip label="Remote GTP-C port" type="number" value={shown(peer.port ?? 2123)} onChange={v => update(index, { port: numeric(v) })}
                  tooltip="The remote GTP-C UDP port, normally 2123. It must match the listener on the other MME." />
                {/* Same fatal-at-startup risk as the SGs-AP address above: the
                    MME resolves this peer with a synchronous getaddrinfo() when
                    it parses its config, so an unresolvable name aborts it. */}
                <HostnameWarning address={peer.address ?? ''} />
                <FieldWithTooltip label="Remote MCC" value={identity.mcc ?? ''} required onChange={mcc => setIdentity({ plmn_id: { ...identity, mcc } })} tooltip="Three decimal digits. Match the remote MME's served GUMMEI exactly; keep leading zeroes." />
                <FieldWithTooltip label="Remote MNC" value={identity.mnc ?? ''} required onChange={mnc => setIdentity({ plmn_id: { ...identity, mnc } })} tooltip="Two or three decimal digits. 01 and 001 identify different PLMNs." />
                <FieldWithTooltip label="Remote MME group ID" type="number" value={shown(gummei.mme_gid)} required onChange={v => setIdentity({ mme_gid: numeric(v) })} tooltip="The remote GUMMEI's MME group ID: 0–65535." />
                <FieldWithTooltip label="Remote MME code" type="number" value={shown(gummei.mme_code)} required onChange={v => setIdentity({ mme_code: numeric(v) })} tooltip="The remote GUMMEI's MME code: 0–255. A neighbor GUMMEI must not duplicate another neighbor or this MME." />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h5 className="text-xs font-semibold">Remote tracking areas</h5>
                <button type="button" className="nms-btn-ghost text-xs inline-flex items-center gap-2" onClick={() => update(index, { tai: [...areas, { plmn_id: { ...identity }, tac: 1 }] })}>
                  <Plus className="w-3 h-3" /> Add tracking area
                </button>
              </div>
              <p className="text-xs text-nms-text-dim">These routes select the target MME for S1 handover. Without them, the neighbor can still be located by GUMMEI for idle mobility.</p>
              {areas.map((area, areaIndex) => {
                const changeArea = (value: typeof area) => update(index, { tai: areas.map((item, i) => i === areaIndex ? value : item) });
                const areaPlmn = plmnOf(area);
                return (
                  <div key={areaIndex} className="flex flex-wrap items-end gap-3">
                    <FieldWithTooltip label={`TA ${areaIndex + 1} MCC`} value={areaPlmn.mcc ?? ''} onChange={mcc => changeArea({ ...area, plmn_id: { ...areaPlmn, mcc } })} />
                    <FieldWithTooltip label={`TA ${areaIndex + 1} MNC`} value={areaPlmn.mnc ?? ''} onChange={mnc => changeArea({ ...area, plmn_id: { ...areaPlmn, mnc } })} />
                    <FieldWithTooltip label={`TA ${areaIndex + 1} TAC`} type="number" value={shown(area.tac)} onChange={v => changeArea({ ...area, tac: numeric(v) })} tooltip="Decimal tracking area code, 0–65535. Match the remote MME and eNB configuration." />
                    <button type="button" aria-label={`Remove tracking area ${areaIndex + 1} from neighbor ${index + 1}`} className="text-nms-red p-2" onClick={() => update(index, { tai: areas.length === 1 ? undefined : areas.filter((_, i) => i !== areaIndex) })}>
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
        <button type="button" className="nms-btn-ghost text-xs inline-flex items-center gap-2" onClick={addPeer}><Plus className="w-3.5 h-3.5" /> Add neighbor MME</button>
      </fieldset>
      <p className="text-xs text-nms-text-dim">Use Apply Configuration to save and restart through the existing NMS workflow. Configure the reverse route on each remote MME separately. SGW selection stays in GTP-C Clients; SGW relocation also requires compatible SGW/PGW components. Radio neighbor configuration is managed on the eNBs.</p>
    </section>
  );
}
