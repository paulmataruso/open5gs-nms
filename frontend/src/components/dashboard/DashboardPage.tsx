import { useEffect, useState } from 'react';
import { Activity, Users, Wifi, AlertTriangle, Play, Square, Zap, Clock, Radio, Shield, ShieldCheck, ShieldOff, Globe, PhoneCall, Phone, MessageSquare, Smartphone } from 'lucide-react';
import { useServiceStore, useSubscriberStore } from '../../stores';
import { configApi, serviceApi, interfaceApi, radioBlockApi } from '../../api';
import { ConfirmModal } from '../common/ConfirmModal';
import { sasApi } from '../../api/sas';
import { imsApi, type ImsStatus, type ImsCallStats } from '../../api/ims';
import { vowifiApi, type VowifiStatus, type VectorcoreStats } from '../../api/vowifi';
import { pstnApi, type PstnStatus } from '../../api/pstn';
import { secgwApi, type SecGwStatus } from '../../api/secgw';
import { mmsApi, type MmsStatus } from '../../api/mms';
import { vectorcoreSmscApi, type VectorcoreSmscStatus } from '../../api/vectorcoreSmsc';
import type { ValidationResult, ServiceStatus } from '../../types';
import axios from 'axios';
import toast from 'react-hot-toast';

type SasBand = {
  bandLow: number; bandHigh: number; label: string;
  slots: Array<{ low: number; high: number; cbsdId?: string; serial?: string; state?: string }>;
};

// Compact single-band frequency bar for the dashboard's split SAS Grants card —
// same underlying slot data as the full SpectrumChart on the SAS page, but
// stripped to just color blocks + a hover tooltip (no legend/table — no room for it here).
function MiniSpectrumBar({ band }: { band: SasBand }): JSX.Element {
  const bandWidth = band.bandHigh - band.bandLow;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-nms-text-dim">{band.label}</span>
        <span className="text-xs font-mono text-nms-text-dim/50">{(band.bandLow / 1e6).toFixed(0)}–{(band.bandHigh / 1e6).toFixed(0)} MHz</span>
      </div>
      <div className="relative h-3 rounded-sm overflow-hidden bg-nms-surface-2 border border-nms-border">
        {band.slots.map((s, i) => {
          const leftPct = ((s.low - band.bandLow) / bandWidth) * 100;
          const widthPct = ((s.high - s.low) / bandWidth) * 100;
          if (!s.cbsdId) {
            return (
              <div key={i} className="absolute inset-y-0 opacity-20"
                style={{
                  left: `${leftPct}%`, width: `${widthPct}%`,
                  backgroundImage: 'repeating-linear-gradient(-45deg, #6b7280 0, #6b7280 1px, transparent 0, transparent 50%)',
                  backgroundSize: '4px 4px',
                }} />
            );
          }
          const color = s.state === 'AUTHORIZED' ? '#4ade80' : '#38bdf8';
          return (
            <div key={i} className="absolute inset-y-0"
              style={{ left: `${leftPct}%`, width: `${widthPct}%`, backgroundColor: color }}
              title={`${s.serial ?? s.cbsdId}\n${(s.low / 1e6).toFixed(1)}–${(s.high / 1e6).toFixed(1)} MHz\n${s.state}`} />
          );
        })}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  subValue?: string;
  color: string;
}): JSX.Element {
  return (
    <div className="nms-card animate-fade-in">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-nms-text-dim uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-semibold font-display mt-1">{value}</p>
          {subValue && <p className="text-xs text-nms-text-dim mt-1">{subValue}</p>}
        </div>
        <div className={`p-2.5 rounded-lg bg-${color}/10`}>
          <Icon className={`w-5 h-5 text-${color}`} />
        </div>
      </div>
    </div>
  );
}

// Same underlying service list ServicesPage.tsx groups under its "Osmocom"
// section header (osmo-stp/osmo-hlr/osmo-msc, the SMS-over-SGs stack) shows
// up here too, unfiltered — this grid renders every entry the backend
// reports, not just the core-17. Every core-17 NF (plus sepp1) really is
// Open5GS's own software; mongodb and the osmo-* trio are not, and were
// previously both getting the blanket "Open5GS" fallback below, mislabeling
// real Osmocom services as this project's own code.
const SERVICES_OSMO = ['osmo-stp', 'osmo-hlr', 'osmo-msc'];
function vendorLabel(serviceName: string): string {
  if (serviceName === 'mongodb') return 'MongoDB';
  if (SERVICES_OSMO.includes(serviceName)) return 'Osmocom';
  return 'Open5GS';
}

function ServiceMiniCard({ status }: { status: ServiceStatus }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 px-2.5 rounded-md bg-nms-bg/50 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <div className={status.active ? 'status-dot-active' : 'status-dot-inactive'} />
        <div className="min-w-0">
          <span className="text-xs font-medium truncate block">{status.name.toUpperCase()}</span>
          <span className="text-[9px] text-nms-text-dim uppercase tracking-wide block">{vendorLabel(status.name)}</span>
        </div>
      </div>
      <span className={`text-xs shrink-0 ${status.active ? 'text-nms-green' : 'text-nms-red'}`}>
        {status.state}
      </span>
    </div>
  );
}

// IMS (P/I/S-CSCF) and PSTN Gateway (Asterisk) aren't part of the core-17
// ServiceName union (they're optional add-on modules, gated separately —
// see CLAUDE.md point 3), so they can't be fed through ServiceMiniCard's
// ServiceStatus prop without an awkward cast. This is a lighter twin fed
// straight from imsApi/pstnApi's own /status responses, which already
// compute exactly the booleans needed (ims-controller.ts, pstn-controller.ts).
// vendor is required (not inferred) since, unlike the core-17 NFs, these
// names don't map to a single project 1:1 — e.g. MMSC and MM1 PROXY sit
// right next to each other but are VectorCore vs. this project's own code.
function AddonServiceMiniCard({ name, vendor, active, loading }: { name: string; vendor: string; active: boolean; loading: boolean }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 px-2.5 rounded-md bg-nms-bg/50 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <div className={loading ? 'status-dot-inactive opacity-40' : active ? 'status-dot-active' : 'status-dot-inactive'} />
        <div className="min-w-0">
          <span className="text-xs font-medium truncate block">{name}</span>
          <span className="text-[9px] text-nms-text-dim uppercase tracking-wide block">{vendor}</span>
        </div>
      </div>
      <span className={`text-xs shrink-0 ${loading ? 'text-nms-text-dim' : active ? 'text-nms-green' : 'text-nms-red'}`}>
        {loading ? '…' : active ? 'active' : 'inactive'}
      </span>
    </div>
  );
}

export function DashboardPage(): JSX.Element {
  const statuses = useServiceStore((s) => s.statuses) || [];
  const fetchStatuses = useServiceStore((s) => s.fetchStatuses);
  const fetchSubscribers = useSubscriberStore((s) => s.fetchSubscribers);
  const subscriberTotal = useSubscriberStore((s) => s.total);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [bulkActing, setBulkActing] = useState(false);
  const [chronyStatus, setChronyStatus] = useState<{ installed: boolean; active: boolean; refSource?: string; sysTimeOffset?: string } | null>(null);
  const [sasStats, setSasStats] = useState<{ activeGrants: number; authorizedGrants: number; registeredCbsds: number } | null>(null);
  const [sasRfStatus, setSasRfStatus] = useState<{ rfOn: number; rfOff: number; unknown: number } | null>(null);
  const [sasBands, setSasBands] = useState<SasBand[] | null>(null);
  const [activeUes, setActiveUes] = useState<number | null>(null);
  const [imsStatus, setImsStatus] = useState<ImsStatus | null>(null);
  const [imsCallStats, setImsCallStats] = useState<ImsCallStats | null>(null);
  const [vowifiStatus, setVowifiStatus] = useState<VowifiStatus | null>(null);
  const [vowifiStats, setVowifiStats] = useState<VectorcoreStats | null>(null);
  const [pstnStatus, setPstnStatus] = useState<PstnStatus | null>(null);
  const [secgwStatus, setSecgwStatus] = useState<SecGwStatus | null>(null);
  const [mmsStatus, setMmsStatus] = useState<MmsStatus | null>(null);
  const [vectorcoreSmscStatus, setVectorcoreSmscStatus] = useState<VectorcoreSmscStatus | null>(null);
  const [amfPlmn, setAmfPlmn] = useState<{ mcc: string; mnc: string } | null>(null);
  const [mmePlmn, setMmePlmn] = useState<{ mcc: string; mnc: string } | null>(null);
  const [gtpBandwidth, setGtpBandwidth] = useState<{ upMbps: number; downMbps: number } | null>(null);
  const [mmsMessagesSent, setMmsMessagesSent] = useState<number | null>(null);

  useEffect(() => {
    fetchStatuses();
    fetchSubscribers();
    configApi.validate().then(setValidation).catch(() => {});
    // Fetch chrony status for dashboard widget
    const API = import.meta.env.VITE_API_URL || '/api';
    axios.get(`${API}/chrony/status`)
      .then(res => {
        const d = res.data;
        setChronyStatus({
          installed: d.installed,
          active: d.active,
          refSource: d.tracking?.refSource || d.tracking?.refId || '',
          sysTimeOffset: d.tracking?.sysTimeOffset?.split(' ')[0] || '',
        });
      })
      .catch(() => setChronyStatus({ installed: false, active: false }));
    // SAS stats
    sasApi.getStats().then(s => setSasStats(s)).catch(() => {});
    sasApi.getSlots().then(s => {
      const bands = s.bands ?? (s.slots?.length ? [{ bandLow: s.bandLow, bandHigh: s.bandHigh, label: 'Band', slots: s.slots }] : []);
      setSasBands(bands);
    }).catch(() => {});
    sasApi.getRfStatus().then(rf => {
      const vals = rf.map((r: any) => r.rfOn);
      setSasRfStatus({
        rfOn:    vals.filter((v: any) => v === true).length,
        rfOff:   vals.filter((v: any) => v === false).length,
        unknown: vals.filter((v: any) => v === null).length,
      });
    }).catch(() => {});
    // Active UEs — InterfaceStatus has no top-level count field, it returns
    // activeUEs4G/activeUEs5G arrays (see get-interface-status.ts); sum their lengths.
    interfaceApi.getStatus().then((s: any) => {
      const count = (s?.activeUEs4G?.length ?? 0) + (s?.activeUEs5G?.length ?? 0);
      setActiveUes(count);
    }).catch(() => {});
    // IMS status — service health, live S-CSCF registrar count, active IPsec SAs
    imsApi.getStatus().then(setImsStatus).catch(() => {});
    // VoWiFi status — service health, for the split half of the IMS Status card below.
    vowifiApi.getStatus().then(setVowifiStatus).catch(() => {});
    // PSTN Gateway status — just need services.asterisk for the Network
    // Functions grid below (P/I/S-CSCF come from imsStatus.services above).
    pstnApi.getStatus().then(setPstnStatus).catch(() => {});
    // Security Gateway status — service health + radio/tunnel counts for its
    // own mini-card in the Network Functions grid below.
    secgwApi.getStatus().then(setSecgwStatus).catch(() => {});
    // MMS (VectorCore MMSC + MM1 MSISDN proxy) status — services.serviceActive/
    // proxyActive for the Network Functions grid below (message-count stats
    // already come from mmsApi.getAdmin() above, this is just service health).
    mmsApi.getStatus().then(setMmsStatus).catch(() => {});
    // VectorCore SMSC status — one of the three SMS Delivery Mode options
    // (see ims-controller.ts's smsDeliveryMode) — for its own mini-card in
    // the Network Functions grid below.
    vectorcoreSmscApi.getStatus().then(setVectorcoreSmscStatus).catch(() => {});
    // Primary PLMN — shown separately for AMF (5G) and MME (4G) since the two
    // are configured independently (kept in sync by the PLMN Migration Wizard,
    // but worth surfacing both in case they ever drift). Every entry in
    // AllConfigsDto is the raw YAML including its own top-level wrapper key
    // (ConfigMapper.toAllDto returns `{ amf: rawYaml, mme: rawYaml, ... }`
    // where rawYaml itself still has its own "amf:"/"mme:" key) — so the
    // real path is cfg.amf.amf.guami, not cfg.amf.guami.
    configApi.getAll().then(cfg => {
      const amfPlmnId = (cfg as any)?.amf?.amf?.guami?.[0]?.plmn_id;
      const mmePlmnId = (cfg as any)?.mme?.mme?.gummei?.[0]?.plmn_id;
      if (amfPlmnId?.mcc && amfPlmnId?.mnc) setAmfPlmn({ mcc: String(amfPlmnId.mcc), mnc: String(amfPlmnId.mnc) });
      if (mmePlmnId?.mcc && mmePlmnId?.mnc) setMmePlmn({ mcc: String(mmePlmnId.mcc), mnc: String(mmePlmnId.mnc) });
    }).catch(() => {});
    // GTP U-Plane bandwidth — backend samples this continuously in the
    // background, so poll it on a short interval to keep the card live.
    const fetchGtpBandwidth = () => {
      interfaceApi.getGtpBandwidth().then(b => setGtpBandwidth({ upMbps: b.upMbps, downMbps: b.downMbps })).catch(() => {});
    };
    fetchGtpBandwidth();
    const gtpInterval = setInterval(fetchGtpBandwidth, 3000);
    // IMS call stats — backend samples this continuously in the background
    // (active calls + durable cumulative total), poll it the same way as GTP
    // bandwidth so the IMS Status card stays live without a full page refresh.
    const fetchImsCallStats = () => {
      imsApi.getCallStats().then(setImsCallStats).catch(() => {});
    };
    fetchImsCallStats();
    const callStatsInterval = setInterval(fetchImsCallStats, 5000);
    // VoWiFi live stats (active_clients/active_ike_sas/...) — straight from
    // VectorCore ePDG's own admin API (proxied), same poll cadence as IMS call
    // stats. Only succeeds while vowifi-vectorcore-epdg is actually running;
    // a stopped/not-installed deployment just keeps the last-known (or null)
    // value, same as every other optional-module card on this dashboard.
    const fetchVowifiStats = () => {
      vowifiApi.getStats().then(setVowifiStats).catch(() => {});
    };
    fetchVowifiStats();
    const vowifiStatsInterval = setInterval(fetchVowifiStats, 5000);
    // MMS total sent — sum of VectorCore's own message_counts. Unlike the
    // SMS/call counters above, this is already a durable, sqlite-DB-backed
    // count (not an in-process counter reset by a service restart), so it
    // needs no accumulation logic of its own — just read and sum. Silently
    // stays null (rendered as —) if MMS isn't installed/configured.
    const fetchMmsStats = () => {
      mmsApi.getAdmin<{ message_counts?: Record<string, number> }>('api/v1/system/status')
        .then(d => {
          const counts = d.message_counts ?? {};
          setMmsMessagesSent(Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0));
        })
        .catch(() => {});
    };
    fetchMmsStats();
    const mmsStatsInterval = setInterval(fetchMmsStats, 5000);
    // SecGW status — radioCount/activeTunnels are computed server-side in the
    // same /status call, so no separate admin-proxy stats endpoint is needed
    // (unlike VoWiFi's vowifiStats above) — just poll the one endpoint.
    const fetchSecgwStatus = () => {
      secgwApi.getStatus().then(setSecgwStatus).catch(() => {});
    };
    const secgwStatusInterval = setInterval(fetchSecgwStatus, 5000);
    return () => { clearInterval(gtpInterval); clearInterval(callStatsInterval); clearInterval(vowifiStatsInterval); clearInterval(mmsStatsInterval); clearInterval(secgwStatusInterval); };
  }, [fetchStatuses, fetchSubscribers]);

  const activeCount = statuses.filter((s) => s.active).length;
  const totalCount = statuses.length || 5;
  const errorCount = validation?.errors?.filter((e) => e.severity === 'error').length || 0;


  const doBulkAction = async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
    if (!confirm(`Are you sure you want to ${action} ALL services?`)) return;

    setBulkActing(true);
    try {
      const result = await serviceApi.bulkAction(action);
      if (result.success) {
        toast.success(`All services ${action} successful`);
      } else {
        toast.error(result.message);
      }
      window.location.reload();
    } catch (err) {
      toast.error(`Failed to ${action} all services`);
    } finally {
      setBulkActing(false);
    }
  };

  // "Block RAN" kill switch — severs S1-MME/S1-U (nftables, this host only) for every
  // currently connected 4G eNodeB at once, without touching any radio's own config. Same
  // mechanism as the per-radio Block button on the RAN page — see radio-block-service.ts.
  const [confirmBlockRan, setConfirmBlockRan] = useState(false);
  const [blockingRan, setBlockingRan] = useState(false);
  const doBlockAllRadios = async (): Promise<void> => {
    setBlockingRan(true);
    try {
      const { ips } = await radioBlockApi.blockAll();
      toast.success(ips.length > 0 ? `Blocked ${ips.length} radio${ips.length === 1 ? '' : 's'}` : 'No radios currently connected to block');
    } catch (err) {
      toast.error('Failed to block RAN');
    } finally {
      setBlockingRan(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-display">Dashboard</h1>
          <p className="text-sm text-nms-text-dim mt-1">Open5GS 5G Core Network Overview</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => doBulkAction('start')}
            disabled={bulkActing}
            className="nms-btn-ghost flex items-center gap-2 text-sm"
          >
            <Play className="w-4 h-4" /> Start All
          </button>
          <button
            onClick={() => doBulkAction('stop')}
            disabled={bulkActing}
            className="nms-btn-danger flex items-center gap-2 text-sm"
          >
            <Square className="w-4 h-4" /> Stop All
          </button>
          <button
            onClick={() => doBulkAction('restart')}
            disabled={bulkActing}
            className="nms-btn-primary flex items-center gap-2 text-sm"
          >
            <Zap className="w-4 h-4" /> Restart All
          </button>
          <button
            onClick={() => setConfirmBlockRan(true)}
            disabled={blockingRan}
            className="nms-btn-danger flex items-center gap-2 text-sm"
            title="Sever S1-MME and S1-U for every connected radio (nftables, this host only) — radios themselves are not touched"
          >
            <ShieldOff className="w-4 h-4" /> Block RAN
          </button>
        </div>
      </div>

      {/* Stats Grid — default align-items:stretch (columns fill the row's
          tallest natural height), now safe since the 4 second-row column
          groups below were rebalanced to have close natural heights on
          their own. Each multi-card column's LAST card gets flex-1 so any
          small leftover stretch is absorbed by growing that card's own
          body (bottom edges line up), not by appending blank margin below
          it or force-splitting evenly across cards that don't need it. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Activity}
          label="Active Services"
          value={`${activeCount}/${totalCount}`}
          subValue={activeCount === totalCount ? 'All services operational' : 'Some services down'}
          color={activeCount === totalCount ? 'nms-green' : 'nms-amber'}
        />
        <StatCard
          icon={Users}
          label="Subscribers"
          value={subscriberTotal}
          subValue="Total provisioned"
          color="nms-accent"
        />
        <StatCard
          icon={AlertTriangle}
          label="Config Issues"
          value={errorCount}
          subValue={errorCount === 0 ? 'No issues found' : 'Review required'}
          color={errorCount === 0 ? 'nms-green' : 'nms-red'}
        />
        <div className="nms-card animate-fade-in">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-nms-text-dim uppercase tracking-wider">SecGW Tunnels</p>
              <div className="flex items-baseline gap-3 mt-1">
                <span>
                  <span className="text-2xl font-semibold font-display text-green-400">{secgwStatus?.activeTunnelCount ?? 0}</span>
                  <span className="text-xs text-nms-text-dim ml-1">active</span>
                </span>
                <span>
                  <span className="text-2xl font-semibold font-display text-red-400">
                    {Math.max((secgwStatus?.radioCount ?? 0) - (secgwStatus?.activeTunnelCount ?? 0), 0)}
                  </span>
                  <span className="text-xs text-nms-text-dim ml-1">down</span>
                </span>
              </div>
              <p className="text-xs text-nms-text-dim mt-1">{secgwStatus?.radioCount ?? 0} total radios seen</p>
            </div>
            <div className="p-2.5 rounded-lg bg-nms-accent/10">
              <ShieldCheck className="w-5 h-5 text-nms-accent" />
            </div>
          </div>
        </div>
        {/* SAS Grants card — split: stats on top, mini spectrum map on bottom */}
        <div className="nms-card animate-fade-in !p-0 divide-y divide-nms-border">
          <div className="flex items-start justify-between p-4">
            <div>
              <p className="text-xs text-nms-text-dim uppercase tracking-wider">SAS Grants</p>
              <p className="text-2xl font-semibold font-display mt-1">{sasStats?.activeGrants ?? '—'}</p>
              <p className="text-xs text-nms-text-dim mt-1">
                <span className="text-green-400">{sasStats?.authorizedGrants ?? 0} authorized</span>
                {sasStats != null && sasStats.activeGrants > sasStats.authorizedGrants && (
                  <span className="text-amber-400 ml-1">{sasStats.activeGrants - sasStats.authorizedGrants} granted</span>
                )}
              </p>
            </div>
            <div className="p-2.5 rounded-lg bg-purple-500/10">
              <Shield className="w-5 h-5 text-purple-400" />
            </div>
          </div>
          <div className="p-4">
            {sasBands && sasBands.length > 0 ? (
              <div className="space-y-2">
                {sasBands.map((band, i) => <MiniSpectrumBar key={i} band={band} />)}
              </div>
            ) : (
              <p className="text-xs text-nms-text-dim">No spectrum data</p>
            )}
          </div>
        </div>

        {/* CBRS Radios + Primary PLMN group — one grid slot, CBRS on top and the
            combined PLMN card stacked below it (same pattern as the GTP/Time group). */}
        <div className="flex flex-col gap-4">
          <div className="nms-card animate-fade-in">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">CBRS Radios</p>
                <p className="text-2xl font-semibold font-display mt-1">{sasStats?.registeredCbsds ?? '—'}</p>
                <div className="flex flex-wrap gap-x-2 mt-1 text-xs">
                  {sasRfStatus ? (
                    <>
                      {sasRfStatus.rfOn   > 0 && <span className="text-cyan-400">{sasRfStatus.rfOn} RF on</span>}
                      {sasRfStatus.rfOff  > 0 && <span className="text-red-400">{sasRfStatus.rfOff} RF off</span>}
                      {sasRfStatus.unknown > 0 && <span className="text-nms-text-dim">{sasRfStatus.unknown} unknown</span>}
                    </>
                  ) : <span className="text-nms-text-dim">Loading…</span>}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-blue-500/10">
                <Radio className="w-5 h-5 text-blue-400" />
              </div>
            </div>
          </div>

          {/* Primary PLMN card — split top/bottom: 5G (AMF) over 4G (MME).
              flex-1: last card in this column, absorbs any leftover
              row-stretch height so this column's bottom edge lines up
              with its siblings. */}
          <div className="nms-card animate-fade-in !p-0 divide-y divide-nms-border flex-1">
            <div className="flex items-start justify-between p-4">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">5G Primary PLMN</p>
                <p className="text-2xl font-semibold font-display font-mono mt-1 text-emerald-400">
                  {amfPlmn ? `${amfPlmn.mcc}/${amfPlmn.mnc}` : '—'}
                </p>
                <p className="text-xs text-nms-text-dim mt-1">MCC / MNC — 5G core</p>
              </div>
              <div className="p-2.5 rounded-lg bg-emerald-500/10">
                <Globe className="w-5 h-5 text-emerald-400" />
              </div>
            </div>
            <div className="flex items-start justify-between p-4">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">4G Primary PLMN</p>
                <p className="text-2xl font-semibold font-display font-mono mt-1 text-nms-accent">
                  {mmePlmn ? `${mmePlmn.mcc}/${mmePlmn.mnc}` : '—'}
                </p>
                <p className="text-xs text-nms-text-dim mt-1">MCC / MNC — 4G core</p>
              </div>
              <div className="p-2.5 rounded-lg bg-nms-accent/10">
                <Globe className="w-5 h-5 text-nms-accent" />
              </div>
            </div>
          </div>
        </div>

        {/* IMS Status group — its own grid slot now (previously paired with
            the UEs stat card, but adding the Registered/Active split grew
            this to 3 stacked sections, tall enough on its own to no longer
            need a partner — see the GTP/Time/UEs group below for where UEs
            moved to, keeping this row's 4 columns close in natural height
            without forcing any of them to stretch). Split: service/
            registrar health on top, registered/active UEs in the middle,
            call volume (live + durable cumulative) on bottom. The bottom
            section is fed by the backend's ImsCallStatsMonitor background
            sampler (call-stats-monitor.ts), not computed here — S-CSCF's
            own cumulative dialog stat resets on every kamailio-scscf
            restart, so "total calls placed" has to be persisted
            server-side. */}
        <div className="nms-card animate-fade-in !p-0 divide-y divide-nms-border">
            {/* Top row split in half: IMS service health (left, unchanged) +
                VoWiFi service health/session counts (right, new) — same
                overall card height as before, just two contents sharing the
                row's grid slot instead of one. VoWiFi's counts come straight
                from VectorCore ePDG's own admin API (active_clients/
                active_ike_sas — no "total ever seen" cumulative counter
                exists there, unlike IMS's persisted call-stats monitor, so
                "Total" here means "IKE SAs right now", which runs at or
                above active_clients since it also counts in-progress/
                half-open attempts). */}
            <div className="grid grid-cols-2 divide-x divide-nms-border">
              <div className="flex items-start justify-between p-4">
                <div>
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">IMS Status</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`w-2.5 h-2.5 rounded-full inline-block ${
                      !imsStatus ? 'bg-nms-text-dim/40' :
                      imsStatus.imsEnabled ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.7)]' : 'bg-red-500'
                    }`} />
                    <p className="text-2xl font-semibold font-display">
                      {!imsStatus ? '…' : imsStatus.imsEnabled ? 'Active' : imsStatus.installed ? 'Stopped' : 'Not Installed'}
                    </p>
                  </div>
                  <p className="text-xs text-nms-text-dim mt-1">
                    {imsStatus?.ipsecSaCount ?? 0} IPsec SAs
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-nms-accent/10">
                  <PhoneCall className="w-5 h-5 text-nms-accent" />
                </div>
              </div>
              <div className="flex items-start justify-between p-4">
                <div>
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">VoWiFi Status</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`w-2.5 h-2.5 rounded-full inline-block ${
                      !vowifiStatus ? 'bg-nms-text-dim/40' :
                      vowifiStatus.services?.['vowifi-vectorcore-epdg'] ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.7)]' : 'bg-red-500'
                    }`} />
                    <p className="text-2xl font-semibold font-display">
                      {vowifiStats?.active_clients ?? 0}
                    </p>
                  </div>
                  <p className="text-xs text-nms-text-dim mt-1">
                    Active <span className="ml-1 text-nms-accent">{vowifiStats?.active_ike_sas ?? 0} Total</span>
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-nms-accent/10">
                  <Wifi className="w-5 h-5 text-nms-accent" />
                </div>
              </div>
            </div>
            {/* Registered vs Active UEs — split per subscriber count vs
                real recent activity. "Registered" dedupes each UE's 3
                IMPU bindings (tel:X/sip:X/sip:imsi@domain) down to one
                distinct Contact, classified by device type from its
                User-Agent. "Active" = that UE's IPsec SA passed real
                traffic in the last 5 minutes (see ims-controller.ts's
                getRegisteredUesWithActivity) — distinguishes a UE that's
                actually doing something right now from one just holding
                a still-valid-but-idle registration. */}
            <div className="grid grid-cols-2 divide-x divide-nms-border">
              <div className="flex items-start justify-between p-4">
                <div>
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">Registered</p>
                  <p className="text-2xl font-semibold font-display mt-1">{imsStatus?.registeredUes ?? 0}</p>
                  <p className="text-xs text-nms-text-dim mt-1">
                    <span className="text-nms-accent">{imsStatus?.registeredUesByType?.iphone ?? 0} iPhone</span>
                    <span className="ml-2">{imsStatus?.registeredUesByType?.android ?? 0} Android</span>
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-nms-accent/10">
                  <Smartphone className="w-5 h-5 text-nms-accent" />
                </div>
              </div>
              <div className="flex items-start justify-between p-4">
                <div>
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">Active</p>
                  <p className="text-2xl font-semibold font-display mt-1">{imsStatus?.activeUes ?? 0}</p>
                  <p className="text-xs text-nms-text-dim mt-1">last 5 min</p>
                </div>
                <div className="p-2.5 rounded-lg bg-nms-accent/10">
                  <Activity className="w-5 h-5 text-nms-accent" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-nms-border">
              <div className="flex items-start justify-between p-4">
                <div>
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">Call Volume</p>
                  <p className="text-2xl font-semibold font-display mt-1">
                    {imsCallStats?.activeCalls ?? '—'}
                  </p>
                  <p className="text-xs text-nms-text-dim mt-1">
                    active
                    <span className="ml-2 text-nms-accent">{imsCallStats?.totalCallsPlaced ?? 0} placed total</span>
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-nms-accent/10">
                  <Phone className="w-5 h-5 text-nms-accent" />
                </div>
              </div>
              {/* Total SMS+MMS sent — SMS side is IMS-path only (this
                  project's default delivery path; SGs-path SMS has no
                  durable counter yet, see call-stats-monitor.ts), MMS side
                  sums VectorCore's own message_counts. */}
              <div className="flex items-start justify-between p-4">
                <div>
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">Messages Sent</p>
                  <p className="text-2xl font-semibold font-display mt-1">
                    {(imsCallStats || mmsMessagesSent !== null)
                      ? (imsCallStats?.totalSmsSent ?? 0) + (mmsMessagesSent ?? 0)
                      : '—'}
                  </p>
                  <p className="text-xs text-nms-text-dim mt-1">
                    <span className="text-nms-accent">{imsCallStats?.totalSmsSent ?? 0} SMS</span>
                    <span className="ml-2">{mmsMessagesSent ?? 0} MMS</span>
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-nms-accent/10">
                  <MessageSquare className="w-5 h-5 text-nms-accent" />
                </div>
              </div>
            </div>
          </div>

        {/* UEs + GTP U-Plane Traffic + Time Server group — 3 short single-
            stat cards stacked, regrouped here (UEs moved from the IMS
            Status group above) so this column's natural height stays
            close to its 3 siblings instead of standing out short. */}
        <div className="flex flex-col gap-4">
          <div className="nms-card animate-fade-in">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">UEs</p>
                <p className="text-2xl font-semibold font-display mt-1">{activeUes ?? '—'}/{subscriberTotal ?? '—'}</p>
                <p className="text-xs text-nms-text-dim mt-1">Active / total subscribers</p>
              </div>
              <div className="p-2.5 rounded-lg bg-nms-accent/10">
                <Users className="w-5 h-5 text-nms-accent" />
              </div>
            </div>
          </div>

          <div className="nms-card animate-fade-in">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">GTP U-Plane Traffic</p>
                <div className="flex items-baseline gap-4 mt-1">
                  <span>
                    <span className="text-2xl font-semibold font-display text-cyan-400">
                      {gtpBandwidth ? gtpBandwidth.upMbps.toFixed(1) : '—'}
                    </span>
                    <span className="text-xs text-nms-text-dim ml-1">↑ Mbps</span>
                  </span>
                  <span>
                    <span className="text-2xl font-semibold font-display text-nms-accent">
                      {gtpBandwidth ? gtpBandwidth.downMbps.toFixed(1) : '—'}
                    </span>
                    <span className="text-xs text-nms-text-dim ml-1">↓ Mbps</span>
                  </span>
                </div>
                <p className="text-xs text-nms-text-dim mt-1">UE payload only — excludes signaling</p>
              </div>
              <div className="p-2.5 rounded-lg bg-cyan-500/10">
                <Activity className="w-5 h-5 text-cyan-400" />
              </div>
            </div>
          </div>

          {/* flex-1: last card in this column, absorbs any leftover
              row-stretch height so this column's bottom edge lines up
              with its siblings. */}
          <div className="nms-card animate-fade-in flex-1">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">Time Server</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`w-2.5 h-2.5 rounded-full inline-block ${
                    !chronyStatus ? 'bg-nms-text-dim/40' :
                    chronyStatus.active ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.7)]' : 'bg-red-500'
                  }`} />
                  <p className="text-2xl font-semibold font-display">
                    {!chronyStatus ? '…' : chronyStatus.active ? 'Active' : chronyStatus.installed ? 'Stopped' : 'Not Installed'}
                  </p>
                </div>
                {chronyStatus?.refSource && (
                  <p className="text-xs text-nms-text-dim mt-1 font-mono truncate">
                    {chronyStatus.refSource}{chronyStatus.sysTimeOffset ? ` · ${chronyStatus.sysTimeOffset}` : ''}
                  </p>
                )}
                {!chronyStatus?.installed && (
                  <p className="text-xs text-amber-400 mt-1">Click to install chrony</p>
                )}
              </div>
              <div className="p-2.5 rounded-lg bg-nms-accent/10">
                <Clock className="w-5 h-5 text-nms-accent" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Service Status Table */}
      <div className="nms-card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold font-display uppercase tracking-wider text-nms-text-dim">
            Network Functions
          </h2>
          <div className="flex items-center gap-2">
            <div className="status-dot-active" />
            <span className="text-xs text-nms-text-dim">{activeCount} active</span>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5">
          {statuses.length > 0 ? (
            statuses.map((s) => <ServiceMiniCard key={s.name} status={s} />)
          ) : (
            <div className="col-span-full text-center py-8 text-nms-text-dim text-sm">
              Loading service statuses...
            </div>
          )}
          <AddonServiceMiniCard name="P-CSCF" vendor="Kamailio" active={!!imsStatus?.services?.pcscf} loading={!imsStatus} />
          <AddonServiceMiniCard name="I-CSCF" vendor="Kamailio" active={!!imsStatus?.services?.icscf} loading={!imsStatus} />
          <AddonServiceMiniCard name="S-CSCF" vendor="Kamailio" active={!!imsStatus?.services?.scscf} loading={!imsStatus} />
          <AddonServiceMiniCard name="ASTERISK" vendor="Asterisk" active={!!pstnStatus?.services?.asterisk} loading={!pstnStatus} />
          <AddonServiceMiniCard
            name="SECGW"
            vendor="strongSwan"
            active={!!secgwStatus?.serviceActive}
            loading={!secgwStatus}
          />
          <AddonServiceMiniCard name="EPDG" vendor="VectorCore" active={!!vowifiStatus?.services?.['vowifi-vectorcore-epdg']} loading={!vowifiStatus} />
          <AddonServiceMiniCard name="AAA" vendor="VectorCore" active={!!vowifiStatus?.services?.['vowifi-vectorcore-aaa']} loading={!vowifiStatus} />
          <AddonServiceMiniCard name="MMSC" vendor="VectorCore" active={!!mmsStatus?.serviceActive} loading={!mmsStatus} />
          <AddonServiceMiniCard name="MM1 PROXY" vendor="Open5GS NMS" active={!!mmsStatus?.proxyActive} loading={!mmsStatus} />
          <AddonServiceMiniCard name="SMSC" vendor="VectorCore" active={!!vectorcoreSmscStatus?.serviceActive} loading={!vectorcoreSmscStatus} />
        </div>
      </div>

      {/* Validation Warnings */}
      {validation && validation.errors && validation.errors.length > 0 && (
        <div className="nms-card border-nms-amber/30">
          <h2 className="text-sm font-semibold font-display uppercase tracking-wider text-nms-amber mb-3">
            Configuration Validation
          </h2>
          <div className="space-y-2">
            {validation.errors.slice(0, 10).map((err, i) => (
              <div
                key={i}
                className={`text-xs px-3 py-2 rounded ${
                  err.severity === 'error'
                    ? 'bg-nms-red/10 text-nms-red'
                    : 'bg-nms-amber/10 text-nms-amber'
                }`}
              >
                <span className="font-mono">{err.field}</span>: {err.message}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmBlockRan}
        title="Block RAN?"
        message="This immediately severs S1-MME and S1-U for every currently connected radio (nftables, this host only) — no radio's own config is touched, and each one can be restored individually from the RAN page, or all at once by unblocking them there."
        confirmLabel="Block RAN"
        danger
        onConfirm={() => { setConfirmBlockRan(false); doBlockAllRadios(); }}
        onCancel={() => setConfirmBlockRan(false)}
      />
    </div>
  );
}
