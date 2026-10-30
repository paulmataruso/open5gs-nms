import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Activity, Users, Wifi, AlertTriangle, Play, Square, Zap, Clock, Radio, Shield, ShieldCheck, ShieldOff, Globe, PhoneCall, Phone, MessageSquare, Smartphone, Lock } from 'lucide-react';
import { useServiceStore, useSubscriberStore } from '../../stores';
import { configApi, serviceApi, interfaceApi, radioBlockApi, gnbBlockApi, hnbBlockApi } from '../../api';
import { ConfirmModal } from '../common/ConfirmModal';
import { sasApi, type SasStatus } from '../../api/sas';
import { recentNtpClients, type ChronyClient } from '../../api/chrony';
import { imsApi, type ImsStatus, type ImsCallStats } from '../../api/ims';
import { vowifiApi, type VowifiStatus, type VectorcoreStats } from '../../api/vowifi';
import { pstnApi, type PstnStatus } from '../../api/pstn';
import { asterisk2gApi, type Asterisk2gStatus } from '../../api/asterisk-2g';
import { secgwApi, type SecGwStatus } from '../../api/secgw';
import { mmsApi, type MmsStatus } from '../../api/mms';
import { vectorcoreSmscApi, type VectorcoreSmscStatus } from '../../api/vectorcoreSmsc';
import type { ValidationResult, ServiceStatus } from '../../types';
import { gsmApi } from '../../api/gsm';
import { FEATURES } from '../../config/features';
import axios from 'axios';
import toast from 'react-hot-toast';

// How many NTP clients the Time Server card lists before deferring to the
// Time Server page. Four is what fits without making this column taller than
// its three siblings, which is what leaves the dead space the cards are
// sized to avoid.
const NTP_CLIENT_ROWS = 4;

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
const SERVICES_OSMO = [
  'osmo-stp', 'osmo-hlr', 'osmo-msc',
  'osmo-bsc', 'osmo-mgw', 'osmo-bts-virtual', 'osmo-pcu', 'osmo-sgsn', 'osmo-ggsn', 'osmo-meas-udp2db',
  'osmo-sip-connector', 'osmo-hnbgw', 'osmo-mgw-hnbgw',
];
function vendorLabel(serviceName: string): string {
  if (serviceName === 'mongodb') return 'MongoDB';
  if (serviceName === 'ocs') return 'SigScale';
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

// One of the 5 header kill-switch buttons (Block RAN / 2G / 3G / 4G / 5G).
// Doubles as the unblock-all action once count > 0 — flashes red
// (animate-flash-red, the same utility RANPage.tsx/SubscriberPage.tsx
// already use for an individual blocked radio/UE's own row) as a standing
// alarm until every radio of that generation is unblocked, same as clicking
// Unblock directly on the RAN page would clear it.
function BlockGenButton({ icon: Icon, label, count, disabled, blockTitle, unblockTitle, onBlock, onUnblock }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; count: number; disabled: boolean;
  blockTitle: string; unblockTitle: string;
  onBlock: () => void; onUnblock: () => void;
}): JSX.Element {
  const isBlocked = count > 0;
  return (
    <button
      onClick={isBlocked ? onUnblock : onBlock}
      disabled={disabled}
      className={clsx('nms-btn-danger text-xs flex items-center gap-1.5 px-2.5 py-1.5', isBlocked && 'animate-flash-red')}
      title={isBlocked ? unblockTitle : blockTitle}
    >
      <Icon className="w-3 h-3" /> {isBlocked ? `${label} Blocked (${count})` : `Block ${label}`}
    </button>
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
  // Who is actually taking time from this server. Fetched once alongside the
  // chrony status above, not polled: the list is "seen in the last hour", so
  // a reading a few minutes old says the same thing.
  const [chronyClients, setChronyClients] = useState<ChronyClient[]>([]);
  // CBRS SAS — one read of SASBench's own status. It is the SAS; the NMS has
  // no SAS state of its own to blend in, so one object covers both SAS cards.
  const [sasStatus, setSasStatus] = useState<SasStatus | null>(null);
  // Grant counts come from SASBench keyed by state; GRANTED means "has a
  // grant, not yet cleared to transmit" and AUTHORIZED means "transmitting".
  const sasAuthorized = sasStatus?.counts?.grantsByState?.AUTHORIZED ?? 0;
  const sasGranted = sasStatus?.counts?.grantsByState?.GRANTED ?? 0;
  // Band occupancy and the radio breakdowns the backend derives from the real
  // grant ranges — see sas-controller.ts: SASBench's own authorizedMHz sums
  // grant widths and so overstates how much of the band is actually in use.
  const sasDerived = sasStatus?.derived;
  // Per-RAT UE counts, each { active, total } where active = communicating
  // right now (ECM/RR-connected), total = registered on that RAT (idle +
  // connected). NOT denominated against the whole subscriber pool — a UE
  // attached on 5G isn't a "4G UE".
  const [ues4G, setUes4G] = useState<{ active: number; total: number }>({ active: 0, total: 0 });
  const [ues5G, setUes5G] = useState<{ active: number; total: number }>({ active: 0, total: 0 });
  const [ues2G, setUes2G] = useState<{ active: number; total: number }>({ active: 0, total: 0 });
  const [imsStatus, setImsStatus] = useState<ImsStatus | null>(null);
  const [imsCallStats, setImsCallStats] = useState<ImsCallStats | null>(null);
  const [vowifiStatus, setVowifiStatus] = useState<VowifiStatus | null>(null);
  const [vowifiStats, setVowifiStats] = useState<VectorcoreStats | null>(null);
  const [pstnStatus, setPstnStatus] = useState<PstnStatus | null>(null);
  const [asterisk2gStatus, setAsterisk2gStatus] = useState<Asterisk2gStatus | null>(null);
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
    axios.get(`${API}/chrony/clients`)
      .then(res => setChronyClients(res.data.clients ?? []))
      .catch(() => setChronyClients([]));
    // CBRS SAS — SASBench. getStatus() resolves even when SASBench is down
    // (reachable:false), so an unreachable SAS renders as a real state rather
    // than two cards stuck on a dash.
    sasApi.getStatus().then(s => setSasStatus(s)).catch(() => setSasStatus(null));
    // Active UEs — InterfaceStatus has no top-level count field, it returns
    // activeUEs4G/activeUEs5G arrays (see get-interface-status.ts); sum their lengths.
    interfaceApi.getStatus().then((s: any) => {
      const u4 = (s?.activeUEs4G ?? []) as Array<{ cmState?: string }>;
      const u5 = (s?.activeUEs5G ?? []) as Array<{ cmState?: string }>;
      setUes4G({ active: u4.filter(u => u.cmState === 'connected').length, total: u4.length });
      setUes5G({ active: u5.filter(u => u.cmState === 'connected').length, total: u5.length });
    }).catch(() => {});
    if (FEATURES.gsm) {
      gsmApi.getSignalOverview().then(r => setUes2G(p => ({ ...p, active: r.samples.length }))).catch(() => {});
      gsmApi.listSubscribers().then(r => setUes2G(p => ({ ...p, total: r.subscribers.length }))).catch(() => {});
    }
    // IMS status — service health, live S-CSCF registrar count, active IPsec SAs
    imsApi.getStatus().then(setImsStatus).catch(() => {});
    // VoWiFi status — service health, for the split half of the IMS Status card below.
    vowifiApi.getStatus().then(setVowifiStatus).catch(() => {});
    // PSTN Gateway status — just need services.asterisk for the Network
    // Functions grid below (P/I/S-CSCF come from imsStatus.services above).
    pstnApi.getStatus().then(setPstnStatus).catch(() => {});
    // Asterisk-2G (2G-to-2G internal voice) — a real, separate Asterisk
    // instance from PSTN Gateway's own (see the ASTERISK mini-card above),
    // so it gets its own fetch/card rather than being folded into that one.
    asterisk2gApi.getStatus().then(setAsterisk2gStatus).catch(() => {});
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

  // Real NTP clients only, most recent first — recentNtpClients() drops the
  // command-mode `localhost` entry that this NMS's own chronyc call creates.
  const ntpClients = recentNtpClients(chronyClients);
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

  // "Block RAN" kill switch — bulk-blocks every currently connected radio,
  // across all four generations at once, each via its own generation's own
  // mechanism: 3G/4G/5G sever their radio-facing paths to the core via
  // nftables (this host only, radio itself untouched — radio-block-service.ts
  // /gnb-block-service.ts/hnb-block-service.ts). 2G is genuinely different —
  // it reuses the same real osmo-bsc OML admin-lock as the per-BTS Block
  // button on the RAN page (see Gsm2GBlockButton's own comment there for why
  // that's deliberately never visually conflated with the mild nftables
  // block), which drops camped UEs immediately and takes each BTS off the
  // air. "Block 2G/3G/4G/5G" below are the same four calls individually, for
  // an operator who only wants to cut one generation.
  type BlockGen = '2g' | '3g' | '4g' | '5g' | 'all';
  const BLOCK_GEN_LABEL: Record<BlockGen, string> = { '2g': '2G', '3g': '3G', '4g': '4G', '5g': '5G', all: 'RAN' };
  const BLOCK_GEN_CONFIRM: Record<BlockGen, { title: string; message: string }> = {
    all: {
      title: 'Block RAN?',
      message: "This immediately blocks every currently connected radio across all four generations. 3G/4G/5G are severed at this host only (nftables — no radio config touched, Iuh/S1-MME+S1-U/N2+N3 paths cut). 2G is different: it locks every configured BTS at osmo-bsc itself, which drops any camped UEs immediately and takes each one off the air. Each generation can be restored individually from its own page, or unblocked here.",
    },
    '2g': {
      title: 'Block 2G?',
      message: 'This administratively locks every configured BTS at osmo-bsc — real hardware, not a host-only network rule. Any camped UEs drop immediately and each BTS stops broadcasting until unlocked from the RAN page.',
    },
    '3g': {
      title: 'Block 3G?',
      message: 'This immediately severs Iuh for every currently registered HNB (nftables, this host only) — no HNB config is touched, and each one can be restored from the RAN page.',
    },
    '4g': {
      title: 'Block 4G?',
      message: "This immediately severs S1-MME and S1-U for every currently connected eNodeB (nftables, this host only) — no radio config is touched, and each one can be restored from the RAN page.",
    },
    '5g': {
      title: 'Block 5G?',
      message: 'This immediately severs N2 and N3 for every currently connected gNodeB (nftables, this host only) — no radio config is touched, and each one can be restored from the RAN page.',
    },
  };
  const [confirmBlockGen, setConfirmBlockGen] = useState<BlockGen | null>(null);
  const [blockingGen, setBlockingGen] = useState<BlockGen | null>(null);
  const doBlockGeneration = async (gen: BlockGen): Promise<void> => {
    setBlockingGen(gen);
    try {
      if (gen === 'all') {
        const [r4, r5, r2, r3] = await Promise.allSettled([
          radioBlockApi.blockAll(),
          gnbBlockApi.blockAll(),
          gsmApi.blockAllBts(),
          hnbBlockApi.blockAll(),
        ]);
        const n4 = r4.status === 'fulfilled' ? r4.value.ips.length : 0;
        const n5 = r5.status === 'fulfilled' ? r5.value.ips.length : 0;
        const n2 = r2.status === 'fulfilled' ? r2.value.results.filter(x => x.success).length : 0;
        const n3 = r3.status === 'fulfilled' ? r3.value.ips.length : 0;
        const anyFailed = [r4, r5, r2, r3].some(r => r.status === 'rejected');
        const total = n2 + n3 + n4 + n5;
        const summary = `2G:${n2} 3G:${n3} 4G:${n4} 5G:${n5}`;
        if (anyFailed) toast.error(`Blocked ${total} radio${total === 1 ? '' : 's'} (${summary}) — one or more generations failed, check individually`);
        else toast.success(total > 0 ? `Blocked ${total} radio${total === 1 ? '' : 's'} (${summary})` : 'No radios currently connected to block');
      } else if (gen === '2g') {
        const { results } = await gsmApi.blockAllBts();
        const okCount = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success);
        if (failed.length > 0) toast.error(`Blocked ${okCount}, failed ${failed.length} (${failed.map(f => f.name).join(', ')})`);
        else toast.success(okCount > 0 ? `Blocked ${okCount} BTS${okCount === 1 ? '' : 's'}` : 'No BTS configured to block');
      } else {
        const api = gen === '3g' ? hnbBlockApi : gen === '4g' ? radioBlockApi : gnbBlockApi;
        const { ips } = await api.blockAll();
        toast.success(ips.length > 0 ? `Blocked ${ips.length} radio${ips.length === 1 ? '' : 's'}` : `No ${BLOCK_GEN_LABEL[gen]} radios currently connected to block`);
      }
    } catch (err) {
      toast.error(`Failed to block ${BLOCK_GEN_LABEL[gen]}`);
    } finally {
      setBlockingGen(null);
      fetchBlockedCounts();
    }
  };

  // Per-generation "is anything currently blocked" counts — drive the
  // flash-red alarm state on the buttons below (animate-flash-red, the same
  // utility RANPage.tsx/SubscriberPage.tsx already use for a blocked radio's
  // own row) and let the same button double as the unblock-all action once
  // blocked, since there's no separate bulk-unblock button anywhere else.
  const [blocked2G, setBlocked2G] = useState(0);
  const [blocked3G, setBlocked3G] = useState(0);
  const [blocked4G, setBlocked4G] = useState(0);
  const [blocked5G, setBlocked5G] = useState(0);
  const BLOCKED_COUNT: Record<BlockGen, number> = {
    '2g': blocked2G, '3g': blocked3G, '4g': blocked4G, '5g': blocked5G,
    all: blocked2G + blocked3G + blocked4G + blocked5G,
  };
  const fetchBlockedCounts = useCallback(() => {
    radioBlockApi.getAll().then(l => setBlocked4G(l.length)).catch(() => {});
    gnbBlockApi.getAll().then(l => setBlocked5G(l.length)).catch(() => {});
    hnbBlockApi.getAll().then(l => setBlocked3G(l.length)).catch(() => {});
    gsmApi.listBts().then(r => setBlocked2G(r.btsEntries.filter(e => e.blocked).length)).catch(() => {});
  }, []);

  const doUnblockGeneration = async (gen: BlockGen): Promise<void> => {
    setBlockingGen(gen);
    try {
      if (gen === 'all') {
        const [r4, r5, r3] = await Promise.allSettled([
          radioBlockApi.getAll().then(l => Promise.allSettled(l.map(b => radioBlockApi.unblock(b.ip)))),
          gnbBlockApi.getAll().then(l => Promise.allSettled(l.map(b => gnbBlockApi.unblock(b.ip)))),
          hnbBlockApi.getAll().then(l => Promise.allSettled(l.map(b => hnbBlockApi.unblock(b.ip)))),
        ]);
        const { btsEntries } = await gsmApi.listBts();
        const r2 = await Promise.allSettled(btsEntries.filter(e => e.blocked).map(e => gsmApi.unblockBts(e.id)));
        const anyFailed = [r4, r5, r3].some(r => r.status === 'rejected') || r2.some(r => r.status === 'rejected');
        toast[anyFailed ? 'error' : 'success'](anyFailed ? 'Unblocked most radios — one or more generations failed, check individually' : 'Unblocked all radios');
      } else if (gen === '2g') {
        const { btsEntries } = await gsmApi.listBts();
        const blocked = btsEntries.filter(e => e.blocked);
        const results = await Promise.allSettled(blocked.map(e => gsmApi.unblockBts(e.id)));
        const okCount = results.filter(r => r.status === 'fulfilled').length;
        toast.success(okCount > 0 ? `Unblocked ${okCount} BTS${okCount === 1 ? '' : 's'}` : 'No BTS currently blocked');
      } else {
        const api = gen === '3g' ? hnbBlockApi : gen === '4g' ? radioBlockApi : gnbBlockApi;
        const list = await api.getAll();
        await Promise.allSettled(list.map(b => api.unblock(b.ip)));
        toast.success(list.length > 0 ? `Unblocked ${list.length} radio${list.length === 1 ? '' : 's'}` : `No ${BLOCK_GEN_LABEL[gen]} radios currently blocked`);
      }
    } catch (err) {
      toast.error(`Failed to unblock ${BLOCK_GEN_LABEL[gen]}`);
    } finally {
      setBlockingGen(null);
      fetchBlockedCounts();
    }
  };

  useEffect(() => {
    fetchBlockedCounts();
    const iv = setInterval(fetchBlockedCounts, 5000);
    return () => clearInterval(iv);
  }, [fetchBlockedCounts]);

  return (
    <div className="p-4 space-y-4 md:p-6 md:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">Dashboard</h1>
          <p className="text-sm text-nms-text-dim mt-1">Open5GS 5G Core Network Overview</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            onClick={() => doBulkAction('start')}
            disabled={bulkActing}
            className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5"
          >
            <Play className="w-3 h-3" /> Start All
          </button>
          <button
            onClick={() => doBulkAction('stop')}
            disabled={bulkActing}
            className="nms-btn-danger text-xs flex items-center gap-1.5 px-2.5 py-1.5"
          >
            <Square className="w-3 h-3" /> Stop All
          </button>
          <button
            onClick={() => doBulkAction('restart')}
            disabled={bulkActing}
            className="nms-btn-primary text-xs flex items-center gap-1.5 px-2.5 py-1.5"
          >
            <Zap className="w-3 h-3" /> Restart All
          </button>
          <div className="h-5 w-px bg-nms-border" />
          <BlockGenButton
            icon={ShieldOff} label="RAN" count={BLOCKED_COUNT.all} disabled={blockingGen !== null}
            blockTitle="Block every currently connected radio across all generations (2G/3G/4G/5G)"
            unblockTitle="Unblock every currently blocked radio across all generations"
            onBlock={() => setConfirmBlockGen('all')} onUnblock={() => doUnblockGeneration('all')}
          />
          <BlockGenButton
            icon={Lock} label="2G" count={BLOCKED_COUNT['2g']} disabled={blockingGen !== null}
            blockTitle="Lock every configured 2G BTS at osmo-bsc — drops camped UEs immediately, real device impact (not a mild host-only rule like 3G/4G/5G)"
            unblockTitle="Unlock every currently blocked 2G BTS at osmo-bsc"
            onBlock={() => setConfirmBlockGen('2g')} onUnblock={() => doUnblockGeneration('2g')}
          />
          <BlockGenButton
            icon={ShieldOff} label="3G" count={BLOCKED_COUNT['3g']} disabled={blockingGen !== null}
            blockTitle="Sever Iuh for every connected 3G HNB (nftables, this host only) — HNBs themselves are not touched"
            unblockTitle="Restore Iuh for every currently blocked 3G HNB"
            onBlock={() => setConfirmBlockGen('3g')} onUnblock={() => doUnblockGeneration('3g')}
          />
          <BlockGenButton
            icon={ShieldOff} label="4G" count={BLOCKED_COUNT['4g']} disabled={blockingGen !== null}
            blockTitle="Sever S1-MME and S1-U for every connected 4G eNodeB (nftables, this host only) — radios themselves are not touched"
            unblockTitle="Restore S1-MME and S1-U for every currently blocked 4G eNodeB"
            onBlock={() => setConfirmBlockGen('4g')} onUnblock={() => doUnblockGeneration('4g')}
          />
          <BlockGenButton
            icon={ShieldOff} label="5G" count={BLOCKED_COUNT['5g']} disabled={blockingGen !== null}
            blockTitle="Sever N2 and N3 for every connected 5G gNodeB (nftables, this host only) — radios themselves are not touched"
            unblockTitle="Restore N2 and N3 for every currently blocked 5G gNodeB"
            onBlock={() => setConfirmBlockGen('5g')} onUnblock={() => doUnblockGeneration('5g')}
          />
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
        {/* CBRS SAS — ONE card for every SAS reading. SASBench *is* the SAS
            here, and all of this comes from its single /api/v1/status, so
            splitting it across two cards in two grid columns read as two
            subsystems that could disagree. Grants and radios share the header
            row (they are the two counts an operator checks first); the band,
            traffic and listener detail sits underneath. */}
        <div className="nms-card animate-fade-in !p-0 divide-y divide-nms-border flex flex-col">
          <div className="grid grid-cols-2 divide-x divide-nms-border">
            <div className="flex items-start justify-between p-4">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">SAS Grants</p>
                <p className="text-2xl font-semibold font-display mt-1">
                  {sasStatus?.reachable ? sasGranted + sasAuthorized : '—'}
                </p>
                <p className="text-xs text-nms-text-dim mt-1">
                  {sasStatus?.reachable ? (
                    <>
                      <span className="text-nms-green">{sasAuthorized} authorized</span>
                      {sasGranted > 0 && (
                        <span className="text-nms-amber ml-1">{sasGranted} granted</span>
                      )}
                    </>
                  ) : (
                    <span className="text-nms-red">unreachable</span>
                  )}
                </p>
              </div>
              <div className="p-2.5 rounded-lg bg-purple-500/10">
                <Shield className="w-5 h-5 text-purple-400" />
              </div>
            </div>
            <div className="flex items-start justify-between p-4">
              <div>
                <p className="text-xs text-nms-text-dim uppercase tracking-wider">CBRS Radios</p>
                <p className="text-2xl font-semibold font-display mt-1">
                  {sasStatus?.reachable ? (sasStatus.counts?.cbsdsRegistered ?? 0) : '—'}
                </p>
                <div className="flex flex-wrap gap-x-2 mt-1 text-xs">
                  {sasStatus?.reachable ? (
                    <>
                      {/* "On air" is the number that matters: a radio can be
                          registered with the SAS and still hold no grant, in
                          which case it is not allowed to transmit at all. */}
                      <span className="text-nms-green">{sasDerived?.radiosWithGrant ?? 0} on air</span>
                      {(sasDerived?.radiosIdle ?? 0) > 0 && (
                        <span className="text-nms-text-dim">{sasDerived?.radiosIdle} idle</span>
                      )}
                      {(sasStatus.counts?.cbsdsPending ?? 0) > 0 && (
                        <span className="text-nms-amber">{sasStatus.counts?.cbsdsPending} pending</span>
                      )}
                    </>
                  ) : (
                    <span className="text-nms-text-dim">—</span>
                  )}
                </div>
              </div>
              <div className="p-2.5 rounded-lg bg-blue-500/10">
                <Radio className="w-5 h-5 text-blue-400" />
              </div>
            </div>
          </div>
          {/* flex-1 + justify-between: this is the card's last section, so
              whatever row-stretch height is left over lands here and spreads
              these rows apart rather than pooling as dead space under the
              last one. */}
          <div className="p-4 flex-1 flex flex-col justify-between gap-1.5">
            {sasStatus?.reachable ? (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nms-text-dim">Band in use</span>
                  <span className="font-mono text-nms-text">
                    {sasDerived
                      ? `${sasDerived.occupancy.distinctMHz.toFixed(0)} / ${sasDerived.occupancy.bandMHz.toFixed(0)} MHz`
                        + ` (${sasDerived.occupancy.occupancyPct.toFixed(0)}%)`
                      : `${(sasStatus.counts?.authorizedMHz ?? 0).toFixed(1)} MHz`}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nms-text-dim">Spectrum granted</span>
                  <span className="font-mono text-nms-text">
                    {(sasStatus.counts?.authorizedMHz ?? 0).toFixed(0)} MHz
                    {/* Above the band width whenever GAA grants overlap, which
                        is normal — so the overlap depth is shown next to it
                        rather than leaving the number looking impossible. */}
                    {(sasDerived?.occupancy.maxOverlap ?? 0) > 1 && (
                      <span className="text-nms-amber">
                        {' '}· {sasDerived?.occupancy.maxOverlap} deep
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nms-text-dim">Largest free block</span>
                  <span className="font-mono text-nms-text">
                    {sasDerived ? `${sasDerived.occupancy.largestGapMHz.toFixed(0)} MHz` : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nms-text-dim">By FCC category</span>
                  <span className="font-mono text-nms-text">
                    {sasDerived
                      ? [
                          sasDerived.byCategory.A ? `${sasDerived.byCategory.A} A` : null,
                          sasDerived.byCategory.B ? `${sasDerived.byCategory.B} B` : null,
                          sasDerived.byCategory.unknown ? `${sasDerived.byCategory.unknown} ?` : null,
                        ].filter(Boolean).join(' · ') || '—'
                      : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nms-text-dim">Messages / errors (1h)</span>
                  <span className="font-mono text-nms-text">
                    {sasStatus.counts?.messagesLastHour ?? 0}
                    <span className={(sasStatus.counts?.errorsLastHour ?? 0) > 0 ? 'text-nms-amber' : 'text-nms-text-dim'}>
                      {' / '}{sasStatus.counts?.errorsLastHour ?? 0}
                    </span>
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nms-text-dim">Listeners</span>
                  <span className="font-mono text-nms-text">
                    {[
                      sasStatus.listeners?.http?.listening ? `:${sasStatus.listeners.http.port}` : null,
                      sasStatus.listeners?.https?.listening ? `:${sasStatus.listeners.https.port}` : null,
                    ].filter(Boolean).join(' ') || <span className="text-nms-red">none</span>}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-nms-text-dim">Settings profile</span>
                  <span className="font-mono text-nms-text">{sasStatus.profile ?? 'custom'}</span>
                </div>
              </>
            ) : (
              <p className="text-xs text-nms-text-dim">
                SASBench is not answering — no radio can register, get a grant or heartbeat.
              </p>
            )}
          </div>
        </div>

        {/* Primary PLMN + UEs group — one grid slot. The CBRS card that used
            to lead this column moved into the SAS card above, so the UE
            counts moved up here from the GTP/Time column to keep this
            column's natural height alongside its three siblings. */}
        <div className="flex flex-col gap-4">
          {/* Primary PLMN card — split top/bottom: 5G (AMF) over 4G (MME). */}
          <div className="nms-card animate-fade-in !p-0 divide-y divide-nms-border">
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

          {/* flex-1 absorbs this row's leftover stretch height. The label
              keeps its place at the top edge like every other card's; the
              counts below it take the leftover height and centre in it, so
              the remainder is split above and below them instead of pooling
              at the bottom as a band of empty card surface. */}
          <div className="nms-card animate-fade-in flex-1 flex flex-col">
            <p className="text-xs text-nms-text-dim uppercase tracking-wider mb-1.5">UEs — active / total</p>
            {/* 2-across on a phone, 4 on desktop. Four columns inside a ~343px
                card leaves ~85px each, which truncates both the label and the
                count. `divide-x` is dropped in the collapsed state on purpose:
                it sets border-left on every child but the first, so once the
                grid wraps, the item starting row 2 draws a stray vertical line
                at the card's left edge. Gap does the separating instead. */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-3 divide-x-0 md:grid-cols-4 md:gap-x-0 md:gap-y-0 md:divide-x divide-nms-border flex-1 content-center">
              {[
                { label: 'Total', active: ues4G.active + ues5G.active + ues2G.active, total: subscriberTotal, tone: 'text-nms-text' },
                { label: '2G', active: ues2G.active, total: ues2G.total, tone: 'text-teal-400' },
                { label: '4G', active: ues4G.active, total: ues4G.total, tone: 'text-purple-400' },
                { label: '5G', active: ues5G.active, total: ues5G.total, tone: 'text-nms-accent' },
              ].map((c, i) => (
                // Horizontal padding is for the desktop divider rhythm; on a
                // phone the grid gap handles it, so it is zeroed to buy back
                // width rather than paying it twice.
                <div key={c.label} className={i === 0 ? 'px-0 md:pl-0 md:pr-3' : 'px-0 md:px-3'}>
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">{c.label}</p>
                  <p className={`text-base font-semibold font-display leading-tight ${c.tone}`}>
                    {c.active}<span className="text-nms-text-dim text-xs font-normal">/{c.total ?? '—'}</span>
                  </p>
                </div>
              ))}
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

        {/* GTP U-Plane Traffic + Time Server group. The UE counts that used
            to lead this column moved to the PLMN column when the Time Server
            card gained its client table — the table is what now makes this
            column's natural height match its three siblings. */}
        <div className="flex flex-col gap-4">
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
          <div className="nms-card animate-fade-in flex-1 flex flex-col">
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
                {chronyStatus && !chronyStatus.installed && (
                  <p className="text-xs text-amber-400 mt-1">Install it from the Time Server page</p>
                )}
              </div>
              <div className="p-2.5 rounded-lg bg-nms-accent/10">
                <Clock className="w-5 h-5 text-nms-accent" />
              </div>
            </div>
            {/* Who is taking time from this server right now — the radios are
                the ones that matter, since a CBRS/NR radio with a drifting
                clock is a real RF problem, not a cosmetic one. Only the
                busiest few fit here; the Time Server page has the full table
                with drop counts and poll intervals. */}
            {chronyStatus?.active && (
              <div className="mt-3 pt-3 border-t border-nms-border flex-1 flex flex-col">
                <div className="flex items-baseline justify-between mb-1.5">
                  <p className="text-xs text-nms-text-dim uppercase tracking-wider">Connected clients</p>
                  <span className="text-xs text-nms-text-dim">
                    {ntpClients.length === 0 ? 'none' : `${ntpClients.length} in the last hour`}
                  </span>
                </div>
                {ntpClients.length === 0 ? (
                  <p className="text-xs text-nms-text-dim">
                    Nothing has asked this server for time in the last hour.
                  </p>
                ) : (
                  <div className="nms-table-scroll">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-nms-text-dim">
                          <th scope="col" className="text-left font-normal pb-1">Client</th>
                          <th scope="col" className="text-right font-normal pb-1 pl-2">Requests</th>
                          <th scope="col" className="text-right font-normal pb-1 pl-2">Last</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-nms-border/40">
                        {ntpClients.slice(0, NTP_CLIENT_ROWS).map((c) => (
                          <tr key={c.hostname}>
                            <td className="py-1 text-nms-text whitespace-nowrap">{c.hostname}</td>
                            <td className="py-1 pl-2 text-right text-nms-text-dim whitespace-nowrap">
                              {c.ntpRequests.toLocaleString()}
                            </td>
                            <td className="py-1 pl-2 text-right text-nms-text-dim whitespace-nowrap">
                              {c.ntpLast === '-' ? '—' : c.ntpLast}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {ntpClients.length > NTP_CLIENT_ROWS && (
                  <p className="text-xs text-nms-text-dim mt-1.5">
                    +{ntpClients.length - NTP_CLIENT_ROWS} more on the Time Server page
                  </p>
                )}
              </div>
            )}
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
          {/* Both are real, separate Asterisk instances (see asterisk-2g-
              controller.ts's module header) — lead with the shared product
              name and use the subtitle to tell them apart, rather than two
              differently-named cards that don't visually read as "the same
              software, two instances." */}
          <AddonServiceMiniCard name="Asterisk" vendor="IMS / 4G-5G" active={!!pstnStatus?.services?.asterisk} loading={!pstnStatus} />
          <AddonServiceMiniCard name="Asterisk" vendor="2G GSM" active={!!asterisk2gStatus?.serviceActive} loading={!asterisk2gStatus} />
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
        open={confirmBlockGen !== null}
        title={confirmBlockGen ? BLOCK_GEN_CONFIRM[confirmBlockGen].title : ''}
        message={confirmBlockGen ? BLOCK_GEN_CONFIRM[confirmBlockGen].message : ''}
        confirmLabel={confirmBlockGen ? `Block ${BLOCK_GEN_LABEL[confirmBlockGen]}` : ''}
        danger
        onConfirm={() => { const gen = confirmBlockGen!; setConfirmBlockGen(null); doBlockGeneration(gen); }}
        onCancel={() => setConfirmBlockGen(null)}
      />
    </div>
  );
}
