import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Plus, Search, Trash2, Edit, X, Save, CreditCard, Copy, Download, Upload, Shield, Network, List, ArrowUp, ArrowDown, ChevronDown, Users, ChevronRight, Pencil, Unlink, Smartphone } from 'lucide-react';
import { clsx } from 'clsx';
import { EsimGeneratorModal } from './EsimGeneratorModal';
import { useSubscriberStore, useSuciStore } from '../../stores';
import { subscriberApi, subscriberGroupsApi } from '../../api';
import type { SubscriberGroup } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import type { Subscriber, SubscriberListItem, SubscriberSession, PccRule, FramedRouteEntry } from '../../types';
import toast from 'react-hot-toast';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

const DEFAULT_SUB: Subscriber = {
  imsi: '', 
  security: { k: '', opc: '', amf: '8000' },
  ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
  subscriber_status: 0,  // SERVICE_GRANTED
  operator_determined_barring: 0,
  network_access_mode: 0,  // PACKET_AND_CIRCUIT
  subscribed_rau_tau_timer: 12,  // 12 minutes default
  access_restriction_data: 32,  // Default value from Open5GS
  slice: [{
    sst: 1,
    default_indicator: true,
    session: [{
      name: 'internet',
      type: 3,  // IPv4v6
      ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
      qos: { 
        index: 9, 
        arp: { 
          priority_level: 8, 
          pre_emption_capability: 1,
          pre_emption_vulnerability: 1 
        } 
      },
      pcc_rule: [],
    }]
  }],
};

const SESSION_TYPES = [
  { value: 1, label: 'IPv4' },
  { value: 2, label: 'IPv6' },
  { value: 3, label: 'IPv4v6' },
];

const AMBR_UNITS = [
  { value: 0, label: 'bps' },
  { value: 1, label: 'Kbps' },
  { value: 2, label: 'Mbps' },
  { value: 3, label: 'Gbps' },
];

const DEFAULT_PCC_RULE: PccRule = {
  qos: {
    index: 1,
    arp: { priority_level: 2, pre_emption_capability: 2, pre_emption_vulnerability: 2 },
    mbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
    gbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
  },
};

const IMS_SESSION_TEMPLATE: SubscriberSession = {
  name: 'ims',
  type: 1,
  ambr: { uplink: { value: 1530, unit: 1 }, downlink: { value: 3850, unit: 1 } },
  qos: { index: 5, arp: { priority_level: 1, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
  pcc_rule: [
    {
      qos: {
        index: 1,
        arp: { priority_level: 2, pre_emption_capability: 2, pre_emption_vulnerability: 2 },
        mbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
        gbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
      },
    },
    {
      qos: {
        index: 2,
        arp: { priority_level: 4, pre_emption_capability: 2, pre_emption_vulnerability: 2 },
        mbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
        gbr: { downlink: { value: 128, unit: 1 }, uplink: { value: 128, unit: 1 } },
      },
    },
  ],
};

const SUBSCRIBER_STATUS_OPTIONS = [
  { value: 0, label: 'Service Granted' },
  { value: 1, label: 'Operator Determined Barring' },
];

const NETWORK_ACCESS_MODE_OPTIONS = [
  { value: 0, label: 'Packet and Circuit' },
  { value: 2, label: 'Only Packet' },
];

// Common MCC (Mobile Country Code) values
const COMMON_MCC_OPTIONS = [
  { value: '001', label: 'Test Network (001)' },
  { value: '999', label: 'Test Network (999)' },
  { value: '310', label: 'United States (310)' },
  { value: '315', label: 'United States CBRS (315)' },
  { value: '311', label: 'United States (311)' },
  { value: '312', label: 'United States (312)' },
  { value: '313', label: 'United States (313)' },
  { value: '316', label: 'United States (316)' },
  { value: '302', label: 'Canada (302)' },
  { value: '334', label: 'Mexico (334)' },
  { value: '234', label: 'United Kingdom (234)' },
  { value: '235', label: 'United Kingdom (235)' },
  { value: '208', label: 'France (208)' },
  { value: '262', label: 'Germany (262)' },
  { value: '222', label: 'Italy (222)' },
  { value: '214', label: 'Spain (214)' },
  { value: '240', label: 'Sweden (240)' },
  { value: '244', label: 'Finland (244)' },
  { value: '242', label: 'Norway (242)' },
  { value: '238', label: 'Denmark (238)' },
  { value: '228', label: 'Switzerland (228)' },
  { value: '232', label: 'Austria (232)' },
  { value: '204', label: 'Netherlands (204)' },
  { value: '206', label: 'Belgium (206)' },
  { value: '268', label: 'Portugal (268)' },
  { value: '202', label: 'Greece (202)' },
  { value: '272', label: 'Ireland (272)' },
  { value: '250', label: 'Russia (250)' },
  { value: '255', label: 'Ukraine (255)' },
  { value: '260', label: 'Poland (260)' },
  { value: '216', label: 'Hungary (216)' },
  { value: '230', label: 'Czech Republic (230)' },
  { value: '460', label: 'China (460)' },
  { value: '440', label: 'Japan (440)' },
  { value: '441', label: 'Japan (441)' },
  { value: '450', label: 'South Korea (450)' },
  { value: '525', label: 'Singapore (525)' },
  { value: '502', label: 'Malaysia (502)' },
  { value: '520', label: 'Thailand (520)' },
  { value: '510', label: 'Indonesia (510)' },
  { value: '515', label: 'Philippines (515)' },
  { value: '454', label: 'Hong Kong (454)' },
  { value: '466', label: 'Taiwan (466)' },
  { value: '404', label: 'India (404)' },
  { value: '405', label: 'India (405)' },
  { value: '410', label: 'Pakistan (410)' },
  { value: '470', label: 'Bangladesh (470)' },
  { value: '505', label: 'Australia (505)' },
  { value: '530', label: 'New Zealand (530)' },
  { value: '724', label: 'Brazil (724)' },
  { value: '722', label: 'Argentina (722)' },
  { value: '730', label: 'Chile (730)' },
  { value: '732', label: 'Colombia (732)' },
  { value: '716', label: 'Peru (716)' },
  { value: '710', label: 'Nicaragua (710)' },
  { value: '704', label: 'Guatemala (704)' },
  { value: '330', label: 'Puerto Rico (330)' },
  { value: '655', label: 'South Africa (655)' },
  { value: '602', label: 'Egypt (602)' },
  { value: '624', label: 'Cameroon (624)' },
  { value: '621', label: 'Nigeria (621)' },
  { value: '636', label: 'Ethiopia (636)' },
  { value: '413', label: 'Sri Lanka (413)' },
  { value: '427', label: 'Qatar (427)' },
  { value: '424', label: 'UAE (424)' },
  { value: '420', label: 'Saudi Arabia (420)' },
  { value: '425', label: 'Israel (425)' },
  { value: '286', label: 'Turkey (286)' },
  { value: 'custom', label: 'Custom MCC...' },
];

// Generate random hex string of specified length
function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

// Generate ICCID (Integrated Circuit Card Identifier)
// Format: 89 (Telecom) + CC (Country Code) + II (Issuer) + XXXXXXXXXXXX (Account) + C (Checksum)
// Standard is 19-20 digits total
function generateICCID(mcc: string, issuer: string, accountNumber?: string): string {
  const mii = '89'; // Major Industry Identifier - Telecom
  
  // Country code from MCC
  // For 3-digit MCC, use all 3; for 2-digit, use 2
  const countryCode = mcc.length === 3 ? mcc : mcc.substring(0, 2).padStart(2, '0');
  
  // If no account number provided, generate random
  // Total should be 19 digits before checksum (20 total with checksum)
  // 89 (2) + CC (2-3) + Issuer (2-3) + Account (11-12) = 19
  const usedLength = mii.length + countryCode.length + issuer.length;
  const accountLength = 19 - usedLength;
  const account = accountNumber || Array.from({ length: accountLength }, () => Math.floor(Math.random() * 10)).join('');
  
  const partial = mii + countryCode + issuer + account;
  
  // Luhn checksum algorithm
  let sum = 0;
  for (let i = partial.length - 1; i >= 0; i--) {
    let digit = parseInt(partial[i]);
    if ((partial.length - i) % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  const checksum = (10 - (sum % 10)) % 10;
  
  return partial + checksum;
}

// IP Assignments Modal Component
function FramedRoutesModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [routes, setRoutes] = useState<FramedRouteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        setRoutes(await subscriberApi.getFramedRoutes());
      } catch {
        toast.error('Failed to load framed routes');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Flatten to one row per CIDR
  const rows = routes.flatMap(r => [
    ...r.ipv4.map(cidr => ({ ...r, cidr, family: 'v4' as const })),
    ...r.ipv6.map(cidr => ({ ...r, cidr, family: 'v6' as const })),
  ]);

  const filteredRows = rows.filter(r =>
    r.imsi.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.cidr.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (r.nickname ?? '').toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="nms-card max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold font-display">Framed Routes Registry</h3>
            <p className="text-sm text-nms-text-dim mt-1">
              {rows.length} subnet{rows.length !== 1 ? 's' : ''} routed behind {routes.length} subscriber{routes.length !== 1 ? 's' : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nms-text-dim" />
          <input
            className="nms-input pl-10"
            placeholder="Search IMSI, nickname, or subnet..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="text-center py-12 text-nms-text-dim">
              Loading framed routes...
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="text-center py-12 text-nms-text-dim">
              {searchTerm ? 'No matching routes found' : 'No framed routes configured'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-nms-surface-1 border-b border-nms-border">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Subnet</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Subscriber</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">APN</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Static Route</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, i) => (
                  <tr key={`${r.imsi}-${r.cidr}-${i}`} className="border-b border-nms-border/50 hover:bg-nms-surface-2/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-nms-accent">{r.cidr}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {r.nickname ? <span className="text-nms-accent font-medium">{r.nickname}</span> : r.imsi}
                    </td>
                    <td className="px-4 py-3 text-xs text-nms-text-dim">{r.apn}</td>
                    <td className="px-4 py-3 text-right">
                      {r.static
                        ? <span className="bg-nms-green/10 text-nms-green text-xs px-2 py-0.5 rounded-full">Applied</span>
                        : <span className="bg-nms-surface-2 text-nms-text-dim text-xs px-2 py-0.5 rounded-full">Not applied</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-nms-border flex justify-end">
          <button onClick={onClose} className="nms-btn-ghost">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function IPAssignmentsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [assignments, setAssignments] = useState<Array<{ imsi: string; ipv4: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const copyToClipboard = useCopyToClipboard();

  useEffect(() => {
    const load = async () => {
      try {
        const result = await subscriberApi.getIPAssignments();
        if (result.success) {
          setAssignments(result.data);
        }
      } catch (error) {
        toast.error('Failed to load IP assignments');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const filteredAssignments = assignments.filter(a => 
    a.imsi.toLowerCase().includes(searchTerm.toLowerCase()) ||
    a.ipv4.includes(searchTerm)
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="nms-card max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold font-display">IP Address Assignments</h3>
            <p className="text-sm text-nms-text-dim mt-1">
              {assignments.length} subscriber{assignments.length !== 1 ? 's' : ''} with assigned IPs
            </p>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nms-text-dim" />
          <input 
            className="nms-input pl-10" 
            placeholder="Search IMSI or IP address..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="text-center py-12 text-nms-text-dim">
              Loading IP assignments...
            </div>
          ) : filteredAssignments.length === 0 ? (
            <div className="text-center py-12 text-nms-text-dim">
              {searchTerm ? 'No matching assignments found' : 'No IP assignments found'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-nms-surface-1 border-b border-nms-border">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">IMSI</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssignments.map(a => (
                  <tr key={a.imsi} className="border-b border-nms-border/50 hover:bg-nms-surface-2/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{a.imsi}</td>
                    <td className="px-4 py-3 font-mono text-sm text-nms-accent">{a.ipv4}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={async () => {
                          const ok = await copyToClipboard(a.ipv4);
                          if (ok) toast.success('IP copied to clipboard');
                          else toast.error('Copy failed — please copy manually');
                        }}
                        className="text-nms-text-dim hover:text-nms-accent text-xs flex items-center gap-1 ml-auto"
                      >
                        <Copy className="w-3 h-3" /> Copy
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-nms-border flex justify-end">
          <button onClick={onClose} className="nms-btn-ghost">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk Subscriber Tools (Auto-Assign IPs + MSISDN + Bulk Add APN, one card) ──
type PoolInfo = {
  ipPool: string; startIp: string; endIp: string; gatewayIp: string | null;
  totalSubscribers: number; withIp: number; withoutIp: number;
  imsApn?: string; imsPool?: string; imsStartIp?: string; imsEndIp?: string;
  imsGatewayIp?: string | null; imsWithIp?: number; imsWithoutIp?: number;
};

// Self-contained subscriber picker — fetches the full subscriber list itself
// (not just the current page), independent of the main table's row checkboxes,
// so a tool run can be scoped to specific UEs without pre-selecting them on the
// table first. Existing checked-on-table selections just seed the initial pick.
function SubscriberPickerBox({ initialSelected, onConfirm, onCancel }: {
  initialSelected: Set<string>;
  onConfirm: (imsis: Set<string>) => void;
  onCancel: () => void;
}): JSX.Element {
  const [all, setAll] = useState<SubscriberListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set(initialSelected));

  useEffect(() => {
    subscriberApi.list(0, 100000).then(r => setAll(r.subscribers)).catch(() => toast.error('Failed to load subscribers')).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(s =>
      s.imsi.toLowerCase().includes(q) ||
      s.nickname?.toLowerCase().includes(q) ||
      s.msisdn?.some(m => m.includes(q)) ||
      s.ue_ipv4?.includes(q),
    );
  }, [all, query]);

  const toggle = (imsi: string) => setChosen(prev => {
    const next = new Set(prev);
    next.has(imsi) ? next.delete(imsi) : next.add(imsi);
    return next;
  });

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-nms-border shrink-0">
          <h3 className="text-sm font-semibold text-nms-text">Select Subscribers <span className="text-nms-text-dim font-normal">({chosen.size} chosen)</span></h3>
          <button onClick={onCancel} className="text-nms-text-dim hover:text-nms-text transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3 border-b border-nms-border shrink-0 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-nms-text-dim" />
            <input
              className="nms-input pl-8 text-sm"
              placeholder="Search IMSI, nickname, MSISDN, IP…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <button onClick={() => setChosen(new Set(filtered.map(s => s.imsi)))} className="nms-btn-ghost text-xs shrink-0">Select shown</button>
          <button onClick={() => setChosen(new Set())} className="nms-btn-ghost text-xs shrink-0">Clear</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5 min-h-[200px]">
          {loading ? (
            <div className="text-sm text-nms-text-dim animate-pulse p-4 text-center">Loading subscribers…</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-nms-text-dim p-4 text-center">No subscribers match.</div>
          ) : (
            filtered.map(s => (
              <label key={s.imsi} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-nms-surface-2 cursor-pointer select-none">
                <input type="checkbox" checked={chosen.has(s.imsi)} onChange={() => toggle(s.imsi)} className="w-4 h-4 accent-nms-accent shrink-0" />
                <span className="font-mono text-xs text-nms-text">{s.imsi}</span>
                {s.nickname && <span className="text-xs text-nms-text-dim truncate">{s.nickname}</span>}
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {s.msisdn?.[0] && <span className="text-xs font-mono text-nms-text-dim">{s.msisdn[0]}</span>}
                  {s.ue_ipv4 && <span className="text-xs font-mono text-nms-text-dim">{s.ue_ipv4}</span>}
                </span>
              </label>
            ))
          )}
        </div>
        <div className="px-5 py-3 border-t border-nms-border shrink-0 flex justify-end gap-2">
          <button onClick={onCancel} className="nms-btn-ghost">Cancel</button>
          <button onClick={() => onConfirm(chosen)} className="nms-btn-primary">Use {chosen.size} Selected</button>
        </div>
      </div>
    </div>
  );
}

function BulkToolsDialog({
  totalSubscribers,
  initialSelectedImsis,
  onClose,
  onDone,
}: {
  totalSubscribers: number;
  initialSelectedImsis: string[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  // ── Scope ──
  const [scope, setScope] = useState<'all' | 'selected'>(initialSelectedImsis.length > 0 ? 'selected' : 'all');
  const [chosenImsis, setChosenImsis] = useState<Set<string>>(new Set(initialSelectedImsis));
  const [showPicker, setShowPicker] = useState(false);
  const scopedCount = scope === 'selected' ? chosenImsis.size : totalSubscribers;
  const scopedImsis = scope === 'selected' ? [...chosenImsis] : undefined;

  // ── Section enable toggles ──
  const [enableApn, setEnableApn]       = useState(false);
  const [enableIp, setEnableIp]         = useState(false);
  const [enableMsisdn, setEnableMsisdn] = useState(false);

  // ── Bulk Add APN fields ──
  const [addCustom, setAddCustom] = useState(true);
  const [apnName, setApnName]     = useState('internet');
  const [apnType, setApnType]     = useState(3);
  const [ulValue, setUlValue]     = useState(1);
  const [ulUnit, setUlUnit]       = useState(3);
  const [dlValue, setDlValue]     = useState(1);
  const [dlUnit, setDlUnit]       = useState(3);
  const [qosIndex, setQosIndex]   = useState(9);
  const [sst, setSst]             = useState(1);
  const [sd, setSd]               = useState('');
  const [addIms, setAddIms]       = useState(false);
  const [apnOverwrite, setApnOverwrite] = useState(false);

  // ── Auto-Assign IPs fields ──
  const [pool, setPool]           = useState<PoolInfo | null>(null);
  const [startIp, setStartIp]     = useState('');
  const [endIp, setEndIp]         = useState('');
  const [ipOverwrite, setIpOverwrite] = useState(false);
  const [assignIms, setAssignIms] = useState(false);
  const [imsStartIp, setImsStartIp] = useState('');
  const [imsEndIp, setImsEndIp]     = useState('');
  const [imsOverwrite, setImsOverwrite] = useState(false);

  // ── Auto-Assign MSISDN fields ──
  const [startingNumber, setStartingNumber] = useState('15550000001');
  const [msisdnOverwrite, setMsisdnOverwrite] = useState(false);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    apn?: { updated: number; skipped: number; errors: string[] };
    ips?: { assigned: number; skipped: number; failed: number };
    msisdn?: { assigned: number; skipped: number };
  } | null>(null);

  useEffect(() => {
    subscriberApi.getAutoAssignIPsPool().then(r => {
      if (r.success) {
        setPool(r.data);
        setStartIp(r.data.startIp);
        setEndIp(r.data.endIp);
        if (r.data.imsStartIp) setImsStartIp(r.data.imsStartIp);
        if (r.data.imsEndIp)   setImsEndIp(r.data.imsEndIp);
      }
    }).catch(() => { /* IP section just won't have pool info; still usable if IPs typed manually */ });
  }, []);

  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const apnValid = !enableApn || (addCustom && apnName.trim().length > 0) || addIms;
  const ipValid = !enableIp || (ipRegex.test(startIp) && ipRegex.test(endIp) && (!assignIms || (ipRegex.test(imsStartIp) && ipRegex.test(imsEndIp))));
  const msisdnValid = !enableMsisdn || (/^\d+$/.test(startingNumber) && startingNumber.length >= 5);
  const canRun = (enableApn || enableIp || enableMsisdn) && apnValid && ipValid && msisdnValid
    && (scope === 'all' || chosenImsis.size > 0);

  const handleRun = async () => {
    if (!canRun) return;
    setRunning(true);
    try {
      let apnRes, ipsRes, msisdnRes;

      // Order matters: APN creates the session an IP gets attached to, so it
      // must run before the IP tool if both are enabled.
      if (enableApn) {
        const sessions: any[] = [];
        if (addCustom && apnName.trim()) {
          sessions.push({
            name: apnName.trim(),
            type: apnType,
            ambr: { uplink: { value: ulValue, unit: ulUnit }, downlink: { value: dlValue, unit: dlUnit } },
            qos: { index: qosIndex, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
            pcc_rule: [],
          });
        }
        if (addIms) sessions.push({ ...IMS_SESSION_TEMPLATE });
        if (sessions.length) {
          try { apnRes = (await subscriberApi.bulkAddApn(sessions, apnOverwrite, sst, sd || undefined, scopedImsis)).data; }
          catch (err: any) { toast.error(`Bulk Add APN failed: ${err?.response?.data?.error ?? err.message}`); }
        }
      }

      if (enableIp) {
        try {
          const r = await subscriberApi.autoAssignIPs({
            startIp, endIp, overwrite: ipOverwrite,
            ...(assignIms ? { imsStartIp, imsEndIp, imsOverwrite } : {}),
            ...(scopedImsis ? { imsis: scopedImsis } : {}),
          });
          if (r.success) ipsRes = r.data; else toast.error('Auto-Assign IPs failed');
        } catch (err: any) { toast.error(`Auto-Assign IPs failed: ${err?.response?.data?.error ?? err.message}`); }
      }

      if (enableMsisdn) {
        try { msisdnRes = (await subscriberApi.autoAssignMsisdn(startingNumber, msisdnOverwrite, scopedImsis)).data; }
        catch (err: any) { toast.error(`Auto-Assign MSISDN failed: ${err?.response?.data?.error ?? err.message}`); }
      }

      setResult({ apn: apnRes, ips: ipsRes, msisdn: msisdnRes });
      onDone();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-nms-surface border border-nms-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold font-display">Bulk Subscriber Tools</h2>
            <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {!result ? (
            <div className="space-y-4">
              {/* Scope */}
              <div className="flex rounded-lg border border-nms-border overflow-hidden text-sm">
                <button type="button" onClick={() => setScope('all')}
                  className={clsx('flex-1 px-3 py-1.5 transition-colors', scope === 'all' ? 'bg-nms-accent text-white' : 'bg-nms-surface-2 text-nms-text-dim hover:text-nms-text')}>
                  All subscribers ({totalSubscribers})
                </button>
                <button type="button" onClick={() => { setScope('selected'); setShowPicker(true); }}
                  className={clsx('flex-1 px-3 py-1.5 transition-colors flex items-center justify-center gap-1.5', scope === 'selected' ? 'bg-nms-accent text-white' : 'bg-nms-surface-2 text-nms-text-dim hover:text-nms-text')}>
                  <Users className="w-3.5 h-3.5 shrink-0" />
                  {chosenImsis.size > 0 ? `${chosenImsis.size} selected` : 'Select subscribers…'}
                </button>
              </div>
              {scope === 'selected' && (
                <button onClick={() => setShowPicker(true)} className="text-xs text-nms-accent hover:underline -mt-2">
                  {chosenImsis.size > 0 ? 'Change selection' : 'Choose which subscribers…'}
                </button>
              )}

              {/* Bulk Add APN */}
              <div className="border border-nms-border rounded-lg overflow-hidden">
                <label className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none bg-nms-surface-2/50">
                  <input type="checkbox" checked={enableApn} onChange={e => setEnableApn(e.target.checked)} className="w-4 h-4 accent-nms-accent shrink-0" />
                  <div>
                    <span className="text-sm font-medium text-nms-text">Bulk Add APN</span>
                    <p className="text-xs text-nms-text-dim">Add a session/APN to many subscribers at once</p>
                  </div>
                </label>
                {enableApn && (
                  <div className="p-3 space-y-3 border-t border-nms-border">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={addCustom} onChange={e => setAddCustom(e.target.checked)} className="w-4 h-4 accent-nms-accent" />
                      <span className="text-sm font-semibold text-nms-text">Custom APN</span>
                    </label>
                    {addCustom && (
                      <div className="space-y-3 ml-2">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="nms-label">APN Name (DNN)</label>
                            <input className="nms-input" value={apnName} onChange={e => setApnName(e.target.value)} placeholder="internet" />
                          </div>
                          <div>
                            <label className="nms-label">Type</label>
                            <select className="nms-input" value={apnType} onChange={e => setApnType(Number(e.target.value))}>
                              {SESSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="nms-label">AMBR Uplink</label>
                            <div className="flex gap-2">
                              <input type="number" className="nms-input flex-1" min={1} value={ulValue} onChange={e => setUlValue(Number(e.target.value))} />
                              <select className="nms-input w-20" value={ulUnit} onChange={e => setUlUnit(Number(e.target.value))}>
                                {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="nms-label">AMBR Downlink</label>
                            <div className="flex gap-2">
                              <input type="number" className="nms-input flex-1" min={1} value={dlValue} onChange={e => setDlValue(Number(e.target.value))} />
                              <select className="nms-input w-20" value={dlUnit} onChange={e => setDlUnit(Number(e.target.value))}>
                                {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                              </select>
                            </div>
                          </div>
                        </div>
                        <div>
                          <label className="nms-label">QoS Index (QCI)</label>
                          <input type="number" className="nms-input w-24" min={1} max={9} value={qosIndex} onChange={e => setQosIndex(Number(e.target.value))} />
                        </div>
                      </div>
                    )}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={addIms} onChange={e => setAddIms(e.target.checked)} className="w-4 h-4 accent-nms-accent" />
                      <span className="text-sm text-nms-text">Add IMS APN session</span>
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="nms-label">SST</label>
                        <input type="number" className="nms-input" min={1} max={255} value={sst} onChange={e => setSst(Number(e.target.value))} />
                      </div>
                      <div>
                        <label className="nms-label">SD <span className="text-nms-text-dim font-normal">(optional)</span></label>
                        <input className="nms-input font-mono" value={sd} onChange={e => setSd(e.target.value)} placeholder="e.g. 000001" maxLength={6} />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={apnOverwrite} onChange={e => setApnOverwrite(e.target.checked)} className="w-4 h-4 accent-nms-accent" />
                      <span className="text-sm text-nms-text">Overwrite APN if it already exists in subscriber</span>
                    </label>
                  </div>
                )}
              </div>

              {/* Auto-Assign IPs */}
              <div className="border border-nms-border rounded-lg overflow-hidden">
                <label className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none bg-nms-surface-2/50">
                  <input type="checkbox" checked={enableIp} onChange={e => setEnableIp(e.target.checked)} className="w-4 h-4 accent-nms-accent shrink-0" />
                  <div>
                    <span className="text-sm font-medium text-nms-text">Auto-Assign IPs</span>
                    <p className="text-xs text-nms-text-dim">
                      Assign IPv4 from the UPF pool{pool ? ` (${pool.ipPool})` : ''} — fills any gaps left by existing assignments
                    </p>
                  </div>
                </label>
                {enableIp && (
                  <div className="p-3 space-y-3 border-t border-nms-border">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="nms-label">Start IP</label>
                        <input value={startIp} onChange={e => setStartIp(e.target.value.trim())} className="nms-input font-mono mt-1" placeholder="10.45.0.2" spellCheck={false} />
                      </div>
                      <div>
                        <label className="nms-label">End IP</label>
                        <input value={endIp} onChange={e => setEndIp(e.target.value.trim())} className="nms-input font-mono mt-1" placeholder="10.45.255.254" spellCheck={false} />
                      </div>
                    </div>
                    <label className="flex items-center gap-2.5 cursor-pointer select-none">
                      <input type="checkbox" checked={ipOverwrite} onChange={e => setIpOverwrite(e.target.checked)} className="w-4 h-4 rounded border-nms-border accent-nms-accent" />
                      <span className="text-sm text-nms-text">Overwrite existing IPs</span>
                    </label>
                    {pool?.imsApn && (
                      <div className="border border-nms-border/60 rounded-lg overflow-hidden">
                        <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none bg-nms-surface-2/30">
                          <input type="checkbox" checked={assignIms} onChange={e => setAssignIms(e.target.checked)} className="w-4 h-4 rounded border-nms-border accent-rose-500" />
                          <span className="text-sm text-nms-text">Also assign IMS ({pool.imsApn}) IPs</span>
                        </label>
                        {assignIms && (
                          <div className="p-3 space-y-3 border-t border-nms-border/60">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="nms-label">IMS Start IP</label>
                                <input value={imsStartIp} onChange={e => setImsStartIp(e.target.value.trim())} className="nms-input font-mono mt-1" placeholder="10.46.0.1" spellCheck={false} />
                              </div>
                              <div>
                                <label className="nms-label">IMS End IP</label>
                                <input value={imsEndIp} onChange={e => setImsEndIp(e.target.value.trim())} className="nms-input font-mono mt-1" placeholder="10.46.255.254" spellCheck={false} />
                              </div>
                            </div>
                            <label className="flex items-center gap-2.5 cursor-pointer select-none">
                              <input type="checkbox" checked={imsOverwrite} onChange={e => setImsOverwrite(e.target.checked)} className="w-4 h-4 rounded border-nms-border accent-rose-500" />
                              <span className="text-sm text-nms-text">Overwrite existing IMS IPs</span>
                            </label>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Auto-Assign MSISDN */}
              <div className="border border-nms-border rounded-lg overflow-hidden">
                <label className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none bg-nms-surface-2/50">
                  <input type="checkbox" checked={enableMsisdn} onChange={e => setEnableMsisdn(e.target.checked)} className="w-4 h-4 accent-nms-accent shrink-0" />
                  <div>
                    <span className="text-sm font-medium text-nms-text">Auto-Assign MSISDN</span>
                    <p className="text-xs text-nms-text-dim">Assign phone numbers — fills any gaps left by existing assignments</p>
                  </div>
                </label>
                {enableMsisdn && (
                  <div className="p-3 space-y-3 border-t border-nms-border">
                    <div>
                      <label className="nms-label">Starting Number</label>
                      <input
                        value={startingNumber}
                        onChange={e => setStartingNumber(e.target.value.replace(/\D/g, ''))}
                        placeholder="15550000001"
                        className="nms-input font-mono mt-1"
                        maxLength={15}
                      />
                      <p className="text-xs text-nms-text-dim mt-1">Digits only. Include country code (e.g. 1 for US).</p>
                    </div>
                    <label className="flex items-center gap-2.5 cursor-pointer select-none">
                      <input type="checkbox" checked={msisdnOverwrite} onChange={e => setMsisdnOverwrite(e.target.checked)} className="w-4 h-4 rounded border-nms-border bg-nms-surface text-nms-accent" />
                      <span className="text-sm text-nms-text">Overwrite existing MSISDNs</span>
                    </label>
                  </div>
                )}
              </div>

              <p className="text-xs text-nms-text-dim">
                Enabled tools will run on <strong>{scopedCount}</strong> {scope === 'selected' ? 'selected ' : ''}subscriber{scopedCount !== 1 ? 's' : ''}, in order: Bulk Add APN → Auto-Assign IPs → Auto-Assign MSISDN.
              </p>

              <div className="flex gap-3 pt-1">
                <button onClick={onClose} className="nms-btn-ghost flex-1">Cancel</button>
                <button onClick={handleRun} disabled={running || !canRun} className="nms-btn-primary flex-1">
                  {running ? 'Running…' : `Run on ${scopedCount} Subscriber${scopedCount !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {result.apn && (
                <div className="p-4 rounded-lg bg-nms-surface-2 border border-nms-border">
                  <p className="text-sm font-semibold text-nms-text mb-3">Bulk Add APN</p>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-nms-text-dim">Updated</span><span className="font-mono text-green-400">{result.apn.updated}</span></div>
                    <div className="flex justify-between"><span className="text-nms-text-dim">Skipped</span><span className="font-mono text-nms-text-dim">{result.apn.skipped}</span></div>
                    {result.apn.errors.length > 0 && <p className="text-xs text-nms-red mt-2">{result.apn.errors.slice(0, 3).join('\n')}</p>}
                  </div>
                </div>
              )}
              {result.ips && (
                <div className="p-4 rounded-lg bg-nms-surface-2 border border-nms-border">
                  <p className="text-sm font-semibold text-nms-text mb-3">Auto-Assign IPs</p>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-nms-text-dim">Assigned</span><span className="font-mono text-green-400">{result.ips.assigned}</span></div>
                    <div className="flex justify-between"><span className="text-nms-text-dim">Skipped</span><span className="font-mono text-nms-text-dim">{result.ips.skipped}</span></div>
                    {result.ips.failed > 0 && <div className="flex justify-between"><span className="text-nms-text-dim">Failed</span><span className="font-mono text-red-400">{result.ips.failed}</span></div>}
                  </div>
                </div>
              )}
              {result.msisdn && (
                <div className="p-4 rounded-lg bg-nms-surface-2 border border-nms-border">
                  <p className="text-sm font-semibold text-nms-text mb-3">Auto-Assign MSISDN</p>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-nms-text-dim">Assigned</span><span className="font-mono text-green-400">{result.msisdn.assigned}</span></div>
                    <div className="flex justify-between"><span className="text-nms-text-dim">Skipped</span><span className="font-mono text-nms-text-dim">{result.msisdn.skipped}</span></div>
                  </div>
                </div>
              )}
              <button onClick={onClose} className="nms-btn-primary w-full">Done</button>
            </div>
          )}
        </div>
      </div>

      {showPicker && (
        <SubscriberPickerBox
          initialSelected={chosenImsis}
          onConfirm={imsis => { setChosenImsis(imsis); setScope(imsis.size > 0 ? 'selected' : 'all'); setShowPicker(false); }}
          onCancel={() => { setShowPicker(false); if (chosenImsis.size === 0) setScope('all'); }}
        />
      )}
    </div>
  );
}

// ── Subscriber Group Colors ──────────────────────────────────────────────────
const GROUP_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#f97316', '#8b5cf6', '#06b6d4',
];

// ── Group Modal (create / rename) ────────────────────────────────────────────
function GroupModal({
  initial,
  onConfirm,
  onClose,
}: {
  initial?: { name: string; color: string };
  onConfirm: (name: string, color: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? GROUP_COLORS[0]);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-nms-surface border border-nms-border rounded-xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-nms-border">
          <h2 className="text-base font-semibold font-display">
            {initial ? 'Rename Group' : 'Create Group'}
          </h2>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="nms-label">Group Name</label>
            <input
              autoFocus
              className="nms-input mt-1"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Paul's iPhone, Lab phones"
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onConfirm(name.trim(), color); }}
            />
          </div>
          <div>
            <label className="nms-label mb-2 block">Color</label>
            <div className="flex gap-2 flex-wrap">
              {GROUP_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className="w-7 h-7 rounded-full transition-transform hover:scale-110 focus:outline-none"
                  style={{ backgroundColor: c, boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : undefined }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="px-5 py-4 border-t border-nms-border flex justify-end gap-2">
          <button onClick={onClose} className="nms-btn-ghost">Cancel</button>
          <button
            onClick={() => { if (name.trim()) onConfirm(name.trim(), color); }}
            disabled={!name.trim()}
            className="nms-btn-primary"
          >
            {initial ? 'Rename' : 'Create Group'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Decode ICCID for display
function decodeICCID(iccid: string): string {
  if (iccid.length < 10) return 'Invalid ICCID';
  
  const mii = iccid.substring(0, 2);
  const country = iccid.substring(2, 5);
  const issuer = iccid.substring(5, 7);
  const account = iccid.substring(7, iccid.length - 1);
  const check = iccid.substring(iccid.length - 1);
  
  return `MII:${mii} | Country:${country} | Issuer:${issuer} | Account:${account} | Check:${check}`;
}

// Generate IMSI (International Mobile Subscriber Identity)
// Format: MCC (3 digits) + MNC (2-3 digits) + MSIN (9-10 digits)
function generateIMSI(mcc: string, mnc: string): string {
  const msinLength = 15 - mcc.length - mnc.length; // Total IMSI is 15 digits
  const msin = Array.from({ length: msinLength }, () => Math.floor(Math.random() * 10)).join('');
  return mcc + mnc + msin;
}

interface GeneratedSIMData {
  // SUCI fields
  suci_enabled?: boolean;
  suci_profile?: 'A' | 'B' | null;
  pki_id?: number | null;
  home_network_public_key?: string | null;
  routing_indicator?: string;
  // SIM fields
  iccid: string;
  imsi: string;
  ki: string;
  opc: string;
  adm1: string;
  pin1: string;
  puk1: string;
  // Optional fields for production use
  acc?: string;  // Access Control Class (2 hex chars)
  msisdn?: string;  // Phone number
  // Provisioning status
  provisioned?: boolean;
  provisionError?: string;
}

function SIMGeneratorDialog({ onClose }: {
  onClose: () => void;
}): JSX.Element {
  const { keys, fetchKeys } = useSuciStore();
  const copyToClipboard = useCopyToClipboard();
  const [mccOption, setMccOption] = useState('001');
  const [customMcc, setCustomMcc] = useState('');
  const [mnc, setMnc] = useState('01');
  
  // Compute actual MCC to use
  const mcc = mccOption === 'custom' ? customMcc : mccOption;
  const [count, setCount] = useState(1);
  const [generated, setGenerated] = useState<GeneratedSIMData[]>([]);
  
  // Production settings
  const [useCustomAdm, setUseCustomAdm] = useState(false);
  const [customAdm, setCustomAdm] = useState('');
  const [useCustomPin, setUseCustomPin] = useState(false);
  const [customPin, setCustomPin] = useState('1234');
  const [useCustomPuk, setUseCustomPuk] = useState(false);
  const [customPuk, setCustomPuk] = useState('12345678');
  const [sequentialImsi, setSequentialImsi] = useState(true);
  const [startingMsin, setStartingMsin] = useState('0000000001');
  const [issuerCode, setIssuerCode] = useState('01');
  const [showIccidBreakdown, setShowIccidBreakdown] = useState(false);
  
  // SUCI settings
  const [suciEnabled, setSuciEnabled] = useState(false);
  const [suciProfile, setSuciProfile] = useState<'A' | 'B' | null>(null);
  const [pkiId, setPkiId] = useState<number | null>(null);
  const [routingIndicator, setRoutingIndicator] = useState('0000');
  
  // Auto-provision settings
  const [autoProvision, setAutoProvision] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  
  // Load SUCI keys on mount
  useEffect(() => {
    fetchKeys().catch(() => {});
  }, [fetchKeys]);
  
  // Auto-select PKI when profile changes
  useEffect(() => {
    if (suciProfile && keys.length > 0) {
      const matchingKey = keys.find(k => k.profile === suciProfile);
      if (matchingKey) {
        setPkiId(matchingKey.id);
      }
    }
  }, [suciProfile, keys]);
  
  // Get selected key
  const selectedKey = keys.find(k => k.id === pkiId);

  // Helper function to convert generated SIM to Subscriber object
  const simToSubscriber = (sim: GeneratedSIMData): Subscriber => ({
    imsi: sim.imsi,
    iccid: sim.iccid,
    msisdn: [],
    security: {
      k: sim.ki,
      opc: sim.opc,
      amf: '8000',
    },
    ambr: {
      uplink: { value: 1, unit: 3 },   // 1 Gbps
      downlink: { value: 1, unit: 3 }  // 1 Gbps
    },
    subscriber_status: 0,  // SERVICE_GRANTED
    operator_determined_barring: 0,
    network_access_mode: 0,  // PACKET_AND_CIRCUIT
    subscribed_rau_tau_timer: 12,
    access_restriction_data: 32,
    slice: [{
      sst: 1,
      default_indicator: true,
      session: [{
        name: 'internet',  // Default APN
        type: 3,  // IPv4v6
        ambr: {
          uplink: { value: 1, unit: 3 },
          downlink: { value: 1, unit: 3 }
        },
        qos: {
          index: 9,
          arp: {
            priority_level: 8,
            pre_emption_capability: 1,
            pre_emption_vulnerability: 1
          }
        }
      }]
    }]
  });

  const generate = async () => {
    const sims: GeneratedSIMData[] = [];
    
    // Validate custom ADM if provided
    if (useCustomAdm && customAdm.length !== 16) {
      toast.error('ADM1 must be exactly 16 hex characters (64 bits)');
      return;
    }
    
    // Validate custom PIN/PUK
    if (useCustomPin && (customPin.length < 4 || customPin.length > 8)) {
      toast.error('PIN1 must be 4-8 digits');
      return;
    }
    
    if (useCustomPuk && customPuk.length !== 8) {
      toast.error('PUK1 must be exactly 8 digits');
      return;
    }
    
    const msinLength = 15 - mcc.length - mnc.length;
    let currentMsin = sequentialImsi ? BigInt(startingMsin) : null;
    
    for (let i = 0; i < count; i++) {
      let imsi: string;
      
      if (sequentialImsi && currentMsin !== null) {
        // Sequential IMSI generation
        const msinStr = currentMsin.toString().padStart(msinLength, '0');
        imsi = mcc + mnc + msinStr;
        currentMsin++;
      } else {
        // Random IMSI generation
        imsi = generateIMSI(mcc, mnc);
      }
      
      sims.push({
        iccid: generateICCID(mcc, issuerCode),
        imsi: imsi,
        ki: randomHex(32),  // Always use crypto-secure random for Ki
        opc: randomHex(32), // Always use crypto-secure random for OPc
        adm1: useCustomAdm ? customAdm : randomHex(16),
        pin1: useCustomPin ? customPin : Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join(''),
        puk1: useCustomPuk ? customPuk : Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join(''),
        acc: '0001', // Default Access Control Class
        // SUCI fields
        suci_enabled: suciEnabled,
        suci_profile: suciEnabled ? suciProfile : null,
        pki_id: suciEnabled ? pkiId : null,
        home_network_public_key: suciEnabled && selectedKey ? selectedKey.publicKeyHex : null,
        routing_indicator: suciEnabled ? routingIndicator : undefined,
      });
    }
    
    // Auto-provision if checkbox is enabled
    if (autoProvision) {
      setProvisioning(true);
      let successCount = 0;
      let failCount = 0;
      
      for (let i = 0; i < sims.length; i++) {
        try {
          const subscriber = simToSubscriber(sims[i]);
          console.log('Attempting to provision subscriber:', JSON.stringify(subscriber, null, 2));
          await subscriberApi.create(subscriber);
          sims[i].provisioned = true;
          successCount++;
        } catch (error: any) {
          sims[i].provisioned = false;
          // Extract detailed error message from axios error response
          const errorMsg = error?.response?.data?.error || error?.message || 'Failed to provision';
          sims[i].provisionError = errorMsg;
          console.error('Provisioning error for IMSI', sims[i].imsi, ':', errorMsg, error?.response?.data);
          failCount++;
        }
      }
      
      setProvisioning(false);
      
      // Show summary toast
      if (failCount === 0) {
        toast.success(`✅ Generated and provisioned ${successCount} SIM${successCount > 1 ? 's' : ''} successfully`);
      } else if (successCount > 0) {
        toast.error(`⚠️ Generated ${sims.length} SIMs. Provisioned: ${successCount} ✅ | Failed: ${failCount} ❌`, { duration: 6000 });
      } else {
        toast.error(`❌ Failed to provision all SIMs. Generated credentials saved for manual import.`, { duration: 6000 });
      }
    } else {
      toast.success(`Generated ${sims.length} SIM credential${sims.length > 1 ? 's' : ''}`);
    }
    
    setGenerated(sims);
  };

  const handleCopyToClipboard = async (text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) toast.success('Copied to clipboard');
    else toast.error('Copy failed — please copy manually');
  };

  const downloadCSV = () => {
    const headers = ['ICCID', 'IMSI', 'Ki', 'OPc', 'ADM1', 'PIN1', 'PUK1', 'ACC', 'SUCI_Profile', 'PKI', 'HomeNetPubKey', 'RoutingIndicator'];
    const rows = generated.map(s => [
      s.iccid, s.imsi, s.ki, s.opc, s.adm1, s.pin1, s.puk1, s.acc || '0001',
      s.suci_profile || '', s.pki_id || '', s.home_network_public_key || '', s.routing_indicator || ''
    ]);
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sim-credentials-${mcc}${mnc}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('SIM credentials downloaded');
  };
  
  const downloadJSON = () => {
    const json = JSON.stringify(generated, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sim-credentials-${mcc}${mnc}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('SIM credentials downloaded');
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="nms-card max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold font-display">SIM Generator</h3>
            <p className="text-sm text-nms-text-dim mt-1">Generate SIM credentials</p>
          </div>
          <button onClick={onClose} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">PLMN Configuration</h4>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="nms-label">MCC (Mobile Country Code) *</label>
                <select
                  className="nms-input"
                  value={mccOption}
                  onChange={e => {
                    setMccOption(e.target.value);
                    if (e.target.value === 'custom') {
                      setCustomMcc('001');
                    }
                  }}
                >
                  {COMMON_MCC_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {mccOption === 'custom' && (
                  <input 
                    className="nms-input font-mono mt-2" 
                    value={customMcc}
                    onChange={e => setCustomMcc(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    placeholder="Enter 3-digit MCC"
                    maxLength={3}
                  />
                )}
                <p className="text-xs text-nms-text-dim mt-1">
                  {mccOption === 'custom' ? 'Enter custom 3-digit MCC' : 'Select country or use custom'}
                </p>
              </div>
              <div>
                <label className="nms-label">MNC (Mobile Network Code) *</label>
                <input 
                  className="nms-input font-mono" 
                  value={mnc}
                  onChange={e => setMnc(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  placeholder="01"
                  maxLength={3}
                />
                <p className="text-xs text-nms-text-dim mt-1">2-3 digits (e.g., 01, 070)</p>
              </div>
              <div>
                <label className="nms-label">Issuer Identifier</label>
                <input 
                  className="nms-input font-mono" 
                  value={issuerCode}
                  onChange={e => setIssuerCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  placeholder="01"
                  maxLength={3}
                />
                <p className="text-xs text-nms-text-dim mt-1">2-3 digits (your carrier/MVNO ID)</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div>
                <label className="nms-label">Number of SIMs to Generate</label>
                <input 
                  className="nms-input font-mono" 
                  type="number"
                  value={count}
                  onChange={e => setCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                  min={1}
                  max={100}
                />
                <p className="text-xs text-nms-text-dim mt-1">Max 100 SIMs</p>
              </div>
              <div>
                <label className="flex items-center gap-2 cursor-pointer pt-6">
                  <input 
                    type="checkbox"
                    className="nms-checkbox"
                    checked={showIccidBreakdown}
                    onChange={e => setShowIccidBreakdown(e.target.checked)}
                  />
                  <span className="text-sm text-nms-text">Show ICCID Breakdown</span>
                </label>
              </div>
            </div>
          </div>

          {/* Production Settings */}
          <div>
            <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">Production Settings</h4>
            
            {/* Sequential IMSI */}
            <div className="mb-4">
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input 
                  type="checkbox"
                  className="nms-checkbox"
                  checked={sequentialImsi}
                  onChange={e => setSequentialImsi(e.target.checked)}
                />
                <span className="text-sm text-nms-text">Generate Sequential IMSI Numbers</span>
              </label>
              {sequentialImsi && (
                <div className="ml-6">
                  <label className="nms-label">Starting MSIN (Subscriber Number)</label>
                  <input 
                    className="nms-input font-mono w-64" 
                    value={startingMsin}
                    onChange={e => setStartingMsin(e.target.value.replace(/\D/g, '').slice(0, 15 - mcc.length - mnc.length))}
                    placeholder="0000000001"
                  />
                  <p className="text-xs text-nms-text-dim mt-1">
                    SIMs will have consecutive IMSI numbers: {mcc}{mnc}{startingMsin}, {mcc}{mnc}{(BigInt(startingMsin) + 1n).toString().padStart(startingMsin.length, '0')}, ...
                  </p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Custom ADM1 */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input 
                    type="checkbox"
                    className="nms-checkbox"
                    checked={useCustomAdm}
                    onChange={e => setUseCustomAdm(e.target.checked)}
                  />
                  <span className="text-sm text-nms-text">Use Custom ADM1 Key</span>
                </label>
                {useCustomAdm && (
                  <div>
                    <input 
                      className="nms-input font-mono text-xs" 
                      value={customAdm}
                      onChange={e => setCustomAdm(e.target.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 16))}
                      placeholder="16 hex chars (64-bit)"
                      maxLength={16}
                    />
                    <p className="text-xs text-nms-text-dim mt-1">All SIMs will share this ADM1</p>
                  </div>
                )}
                {!useCustomAdm && (
                  <p className="text-xs text-nms-text-dim">Random secure ADM1 per SIM</p>
                )}
              </div>

              {/* Custom PIN1 */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input 
                    type="checkbox"
                    className="nms-checkbox"
                    checked={useCustomPin}
                    onChange={e => setUseCustomPin(e.target.checked)}
                  />
                  <span className="text-sm text-nms-text">Use Custom PIN1</span>
                </label>
                {useCustomPin && (
                  <div>
                    <input 
                      className="nms-input font-mono" 
                      value={customPin}
                      onChange={e => setCustomPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      placeholder="4-8 digits"
                      maxLength={8}
                    />
                    <p className="text-xs text-nms-text-dim mt-1">All SIMs will share this PIN</p>
                  </div>
                )}
                {!useCustomPin && (
                  <p className="text-xs text-nms-text-dim">Random 4-digit PIN per SIM</p>
                )}
              </div>

              {/* Custom PUK1 */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input 
                    type="checkbox"
                    className="nms-checkbox"
                    checked={useCustomPuk}
                    onChange={e => setUseCustomPuk(e.target.checked)}
                  />
                  <span className="text-sm text-nms-text">Use Custom PUK1</span>
                </label>
                {useCustomPuk && (
                  <div>
                    <input 
                      className="nms-input font-mono" 
                      value={customPuk}
                      onChange={e => setCustomPuk(e.target.value.replace(/\D/g, '').slice(0, 8))}
                      placeholder="8 digits"
                      maxLength={8}
                    />
                    <p className="text-xs text-nms-text-dim mt-1">All SIMs will share this PUK</p>
                  </div>
                )}
                {!useCustomPuk && (
                  <p className="text-xs text-nms-text-dim">Random 8-digit PUK per SIM</p>
                )}
              </div>
            </div>
          </div>

          {/* SUCI Configuration */}
          <div>
            <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider flex items-center gap-2">
              <Shield className="w-4 h-4" />
              5G SUCI Configuration (Optional)
            </h4>
            
            <div className="bg-nms-surface-2/30 rounded-lg p-4 border border-nms-border/30">
              <label className="flex items-center gap-2 cursor-pointer mb-4">
                <input 
                  type="checkbox"
                  className="nms-checkbox"
                  checked={suciEnabled}
                  onChange={e => {
                    setSuciEnabled(e.target.checked);
                    if (!e.target.checked) {
                      setSuciProfile(null);
                      setPkiId(null);
                    }
                  }}
                />
                <span className="text-sm text-nms-text font-medium">Enable SUCI (5G Privacy Protection)</span>
              </label>

              {suciEnabled && (
                <div className="space-y-4 ml-6">
                  {/* Profile Selection */}
                  <div>
                    <label className="nms-label">SUCI Profile</label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="flex items-center gap-2 p-3 border border-nms-border rounded cursor-pointer hover:bg-nms-surface-2/50 transition-colors">
                        <input
                          type="radio"
                          name="suci-profile"
                          value="A"
                          checked={suciProfile === 'A'}
                          onChange={() => setSuciProfile('A')}
                        />
                        <div>
                          <div className="text-sm font-medium text-nms-text">Profile A (X25519)</div>
                          <div className="text-xs text-nms-text-dim">Most common for 5G</div>
                        </div>
                      </label>
                      <label className="flex items-center gap-2 p-3 border border-nms-border rounded cursor-pointer hover:bg-nms-surface-2/50 transition-colors">
                        <input
                          type="radio"
                          name="suci-profile"
                          value="B"
                          checked={suciProfile === 'B'}
                          onChange={() => setSuciProfile('B')}
                        />
                        <div>
                          <div className="text-sm font-medium text-nms-text">Profile B (secp256r1)</div>
                          <div className="text-xs text-nms-text-dim">Alternative encryption</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* PKI Selection */}
                  {suciProfile && (
                    <div>
                      <label className="nms-label">Home Network PKI</label>
                      <select
                        className="nms-input"
                        value={pkiId || ''}
                        onChange={e => setPkiId(parseInt(e.target.value) || null)}
                      >
                        <option value="">Select PKI...</option>
                        {keys
                          .filter(k => k.profile === suciProfile)
                          .map(k => (
                            <option key={k.id} value={k.id}>
                              PKI {k.id} - {k.schemeLabel} {!k.fileExists ? '(⚠️ Key file missing)' : ''}
                            </option>
                          ))}
                      </select>
                      {keys.filter(k => k.profile === suciProfile).length === 0 && (
                        <p className="text-xs text-amber-500 mt-1">
                          No Profile {suciProfile} keys found. Go to SUCI Keys page to generate one.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Public Key Display */}
                  {selectedKey && (
                    <div>
                      <label className="nms-label">Public Key (for eSIM Provisioning)</label>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-nms-bg/50 rounded p-2 border border-nms-border/30">
                          <code className="text-xs font-mono text-nms-accent break-all">
                            {selectedKey.publicKeyHex || 'N/A'}
                          </code>
                        </div>
                        {selectedKey.publicKeyHex && (
                          <button
                            onClick={() => handleCopyToClipboard(selectedKey.publicKeyHex!)}
                            className="nms-btn-ghost text-xs flex items-center gap-1"
                          >
                            <Copy className="w-3 h-3" />
                            Copy
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Routing Indicator */}
                  <div>
                    <label className="nms-label">Routing Indicator</label>
                    <input
                      className="nms-input font-mono w-32"
                      value={routingIndicator}
                      onChange={e => setRoutingIndicator(e.target.value.replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 4))}
                      placeholder="0000"
                      maxLength={4}
                    />
                    <p className="text-xs text-nms-text-dim mt-1">
                      4 hex chars (default: 0000 for single-UDM deployments)
                    </p>
                  </div>
                </div>
              )}

              {!suciEnabled && (
                <p className="text-xs text-nms-text-dim ml-6">
                  SUCI provides privacy protection by encrypting IMSI during 5G network attachment.
                  Enable this for VoLTE and advanced 5G deployments.
                </p>
              )}
            </div>
          </div>

          {/* Auto-Provision Checkbox */}
          <div className="bg-nms-surface-2/30 rounded-lg p-4 border border-nms-border/30">
            <label className="flex items-start gap-3 cursor-pointer">
              <input 
                type="checkbox"
                className="nms-checkbox mt-0.5"
                checked={autoProvision}
                onChange={e => setAutoProvision(e.target.checked)}
              />
              <div>
                <span className="text-sm text-nms-text font-medium">Auto-provision to Open5GS database</span>
                <p className="text-xs text-nms-text-dim mt-1">
                  Automatically add generated SIMs to subscriber database with default 'internet' APN (1 Gbps up/down, SST 1, QoS 9)
                </p>
              </div>
            </label>
          </div>

          <div className="flex gap-3">
            <button onClick={generate} disabled={provisioning} className="nms-btn-primary flex items-center gap-2">
              <CreditCard className="w-4 h-4" />
              {provisioning ? 'Provisioning...' : 'Generate SIM Data'}
            </button>
            {generated.length > 0 && (
              <>
                <button onClick={downloadCSV} className="nms-btn-ghost flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Download CSV
                </button>
                <button onClick={downloadJSON} className="nms-btn-ghost flex items-center gap-2">
                  <Download className="w-4 h-4" />
                  Download JSON
                </button>
              </>
            )}
          </div>

          {/* Generated Data Display */}
          {generated.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">
                Generated SIM Data ({generated.length})
              </h4>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {generated.map((sim, idx) => (
                  <div key={idx} className="bg-nms-surface-2/50 rounded-lg p-4 border border-nms-border">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <h5 className="text-sm font-semibold text-nms-text">SIM #{idx + 1}</h5>
                        {autoProvision && (
                          sim.provisioned === true ? (
                            <span className="bg-nms-green/10 text-nms-green text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
                              <span className="w-1.5 h-1.5 bg-nms-green rounded-full"></span>
                              Provisioned
                            </span>
                          ) : sim.provisioned === false ? (
                            <span className="bg-nms-red/10 text-nms-red text-xs px-2 py-0.5 rounded-full flex items-center gap-1" title={sim.provisionError}>
                              <span className="w-1.5 h-1.5 bg-nms-red rounded-full"></span>
                              Failed
                            </span>
                          ) : null
                        )}
                      </div>
                      <button
                        onClick={() => handleCopyToClipboard(JSON.stringify(sim, null, 2))}
                        className="text-nms-accent hover:text-nms-accent/80 text-xs flex items-center gap-1"
                      >
                        <Copy className="w-3 h-3" />
                        Copy JSON
                      </button>
                    </div>
                    {sim.provisioned === false && sim.provisionError && (
                      <div className="mb-3 p-2 bg-nms-red/5 border border-nms-red/20 rounded text-xs text-nms-red">
                      <strong>Provisioning Error:</strong> {sim.provisionError}
                    </div>
                      )}
                      <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <span className="text-nms-text-dim">ICCID:</span>
                        <div className="font-mono text-nms-text mt-1 bg-nms-bg/50 px-2 py-1 rounded">{sim.iccid}</div>
                        {showIccidBreakdown && (
                          <div className="text-[10px] text-nms-text-dim mt-1 font-mono">
                            {decodeICCID(sim.iccid)}
                          </div>
                        )}
                      </div>
                      <div>
                        <span className="text-nms-text-dim">IMSI:</span>
                        <div className="font-mono text-nms-text mt-1 bg-nms-bg/50 px-2 py-1 rounded">{sim.imsi}</div>
                      </div>
                      <div>
                        <span className="text-nms-text-dim">Ki (128-bit):</span>
                        <div className="font-mono text-nms-text mt-1 bg-nms-bg/50 px-2 py-1 rounded break-all">{sim.ki}</div>
                      </div>
                      <div>
                        <span className="text-nms-text-dim">OPc (128-bit):</span>
                        <div className="font-mono text-nms-text mt-1 bg-nms-bg/50 px-2 py-1 rounded break-all">{sim.opc}</div>
                      </div>
                      <div>
                        <span className="text-nms-text-dim">ADM1 (64-bit):</span>
                        <div className="font-mono text-nms-text mt-1 bg-nms-bg/50 px-2 py-1 rounded break-all">{sim.adm1}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="text-nms-text-dim">PIN1:</span>
                          <div className="font-mono text-nms-text mt-1 bg-nms-bg/50 px-2 py-1 rounded">{sim.pin1}</div>
                        </div>
                        <div>
                          <span className="text-nms-text-dim">PUK1:</span>
                          <div className="font-mono text-nms-text mt-1 bg-nms-bg/50 px-2 py-1 rounded">{sim.puk1}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SubForm({ sub, onSave, onCancel, isNew }: {
  sub: Subscriber; onSave: (s: Subscriber) => Promise<void>; onCancel: () => void; isNew: boolean;
}): JSX.Element {
  const [form, setForm] = useState<Subscriber>(sub);
  const [saving, setSaving] = useState(false);
  const save = async () => { setSaving(true); try { await onSave(form); } finally { setSaving(false); } };

  // Open5GS caps framed routes at 8 per address family per session
  // (OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDN) — block Save client-side rather than
  // letting the operator find out only after the backend rejects it.
  const framedRouteOverflow = form.slice.some(sl =>
    sl.session.some(sess =>
      (sess.ipv4_framed_routes?.length ?? 0) > 8 || (sess.ipv6_framed_routes?.length ?? 0) > 8,
    ),
  );

  const updateSession = (sliceIdx: number, sessIdx: number, updates: Partial<SubscriberSession>) => {
    const newSlices = [...form.slice];
    newSlices[sliceIdx] = {
      ...newSlices[sliceIdx],
      session: newSlices[sliceIdx].session.map((s, i) => 
        i === sessIdx ? { ...s, ...updates } : s
      )
    };
    setForm({ ...form, slice: newSlices });
  };

  const addSession = (sliceIdx: number, template?: SubscriberSession) => {
    const newSlices = [...form.slice];
    newSlices[sliceIdx] = {
      ...newSlices[sliceIdx],
      session: [
        ...newSlices[sliceIdx].session,
        template ?? {
          name: 'internet',
          type: 3,
          ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
          qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
          pcc_rule: [],
        },
      ]
    };
    setForm({ ...form, slice: newSlices });
  };

  const addPccRule = (sliceIdx: number, sessIdx: number) => {
    const newSlices = [...form.slice];
    const sess = newSlices[sliceIdx].session[sessIdx];
    newSlices[sliceIdx].session[sessIdx] = {
      ...sess,
      pcc_rule: [...(sess.pcc_rule ?? []), { ...DEFAULT_PCC_RULE, qos: { ...DEFAULT_PCC_RULE.qos } }],
    };
    setForm({ ...form, slice: newSlices });
  };

  const updatePccRule = (sliceIdx: number, sessIdx: number, ruleIdx: number, rule: PccRule) => {
    const newSlices = [...form.slice];
    const sess = newSlices[sliceIdx].session[sessIdx];
    const rules = [...(sess.pcc_rule ?? [])];
    rules[ruleIdx] = rule;
    newSlices[sliceIdx].session[sessIdx] = { ...sess, pcc_rule: rules };
    setForm({ ...form, slice: newSlices });
  };

  const removePccRule = (sliceIdx: number, sessIdx: number, ruleIdx: number) => {
    const newSlices = [...form.slice];
    const sess = newSlices[sliceIdx].session[sessIdx];
    newSlices[sliceIdx].session[sessIdx] = {
      ...sess,
      pcc_rule: (sess.pcc_rule ?? []).filter((_, i) => i !== ruleIdx),
    };
    setForm({ ...form, slice: newSlices });
  };

  const removeSession = (sliceIdx: number, sessIdx: number) => {
    const newSlices = [...form.slice];
    newSlices[sliceIdx] = {
      ...newSlices[sliceIdx],
      session: newSlices[sliceIdx].session.filter((_, i) => i !== sessIdx)
    };
    setForm({ ...form, slice: newSlices });
  };

  return (
    <div className="nms-card border-nms-accent/30 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold font-display">{isNew ? 'New Subscriber' : `Edit ${sub.imsi}`}</h3>
        <button onClick={onCancel} className="text-nms-text-dim hover:text-nms-text"><X className="w-4 h-4" /></button>
      </div>

      <div className="space-y-6">
        {/* Basic Info */}
        <div>
          <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">Basic Information</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="nms-label">IMSI *</label>
              <input
                className="nms-input font-mono text-sm"
                value={form.imsi}
                onChange={e => setForm({...form, imsi: e.target.value})}
                placeholder="001010000000001"
              />
              {!isNew && (
                <p className="text-xs text-nms-text-dim mt-1">
                  Changing this renames the subscriber everywhere it's referenced (subscriber groups). Re-sync IMS/SMS afterward if those modules are configured.
                </p>
              )}
            </div>
            <div>
              <label className="nms-label">Nickname</label>
              <input 
                className="nms-input text-sm" 
                value={(form as any).nickname || ''}
                onChange={e => setForm({...form, nickname: e.target.value || undefined} as any)} 
                placeholder="e.g. iPhone 15 Pro, Lab UE #1"
              />
            </div>
            <div>
              <label className="nms-label">ICCID</label>
              <input 
                className="nms-input font-mono text-sm" 
                value={(form as any).iccid || ''}
                onChange={e => setForm({...form, iccid: e.target.value || undefined} as any)} 
                placeholder="e.g. 8901234567890123456"
                maxLength={22}
              />
            </div>
            <div>
              <label className="nms-label">MSISDN</label>
              <input 
                className="nms-input font-mono text-sm" 
                value={form.msisdn?.join(', ') || ''}
                onChange={e => setForm({...form, msisdn: e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})} 
                placeholder="8210000000000"
              />
            </div>
            <div>
              <label className="nms-label">IMEISV (auto-generated on first attach)</label>
              <input 
                className="nms-input font-mono text-sm bg-nms-surface-2/50" 
                value={form.imeisv || 'Not yet attached'}
                disabled
                placeholder="Auto-generated"
              />
            </div>
          </div>
        </div>

        {/* Security */}
        <div>
          <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">Security (TS 33.401)</h4>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="nms-label">K (128-bit) *</label>
              <input 
                className="nms-input font-mono text-xs" 
                value={form.security.k} 
                onChange={e => setForm({...form, security:{...form.security, k:e.target.value}})} 
                placeholder="32 hex characters"
                maxLength={32}
              />
            </div>
            <div>
              <label className="nms-label">OPc (128-bit) *</label>
              <input 
                className="nms-input font-mono text-xs" 
                value={form.security.opc} 
                onChange={e => setForm({...form, security:{...form.security, opc:e.target.value}})} 
                placeholder="32 hex characters"
                maxLength={32}
              />
            </div>
            <div>
              <label className="nms-label">AMF *</label>
              <input 
                className="nms-input font-mono text-xs" 
                value={form.security.amf} 
                onChange={e => setForm({...form, security:{...form.security, amf:e.target.value}})} 
                placeholder="8000"
                maxLength={4}
              />
            </div>
          </div>
        </div>

        {/* Subscriber Status & Barring */}
        <div>
          <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">Subscriber Status (TS 29.272 7.3.29)</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="nms-label">Status</label>
              <select 
                className="nms-input"
                value={form.subscriber_status ?? 0}
                onChange={e => setForm({...form, subscriber_status: parseInt(e.target.value)})}
              >
                {SUBSCRIBER_STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="nms-label">Network Access Mode</label>
              <select 
                className="nms-input"
                value={form.network_access_mode ?? 0}
                onChange={e => setForm({...form, network_access_mode: parseInt(e.target.value)})}
              >
                {NETWORK_ACCESS_MODE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Operator Determined Barring */}
        <div>
          <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">Operator Determined Barring (TS 29.272 7.3.30)</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="nms-label">Barring Bitmask</label>
              <input 
                type="number"
                className="nms-input font-mono" 
                value={form.operator_determined_barring ?? 0}
                onChange={e => setForm({...form, operator_determined_barring: parseInt(e.target.value) || 0})}
                placeholder="0 = no barring"
              />
              <p className="text-xs text-nms-text-dim mt-1">
                0=all packet services barred, 1=roamer access HPLMN-AP barred, 2=roamer access VPLMN-AP barred
              </p>
            </div>
            <div>
              <label className="nms-label">RAU/TAU Timer (minutes)</label>
              <input 
                type="number"
                className="nms-input font-mono" 
                value={form.subscribed_rau_tau_timer ?? 12}
                onChange={e => setForm({...form, subscribed_rau_tau_timer: parseInt(e.target.value) || 12})}
                placeholder="12"
              />
            </div>
          </div>
        </div>

        {/* UE-AMBR */}
        <div>
          <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">UE-AMBR (Aggregate Maximum Bit Rate)</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="nms-label">Uplink (Gbps)</label>
              <input 
                className="nms-input font-mono" 
                type="number" 
                value={form.ambr.uplink.value}
                onChange={e => setForm({...form, ambr:{...form.ambr, uplink:{value:parseInt(e.target.value)||1, unit:3}}})} 
              />
            </div>
            <div>
              <label className="nms-label">Downlink (Gbps)</label>
              <input 
                className="nms-input font-mono" 
                type="number" 
                value={form.ambr.downlink.value}
                onChange={e => setForm({...form, ambr:{...form.ambr, downlink:{value:parseInt(e.target.value)||1, unit:3}}})} 
              />
            </div>
          </div>
        </div>

        {/* Slices */}
        {form.slice.map((sl, sliceIdx) => (
          <div key={sliceIdx} className="bg-nms-surface-2/50 rounded-lg p-4 border border-nms-border">
            <h4 className="text-xs font-semibold text-nms-accent mb-3 uppercase tracking-wider">
              Slice {sliceIdx + 1} (S-NSSAI)
            </h4>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <label className="nms-label">SST *</label>
                <input 
                  className="nms-input font-mono" 
                  type="number" 
                  value={sl.sst}
                  onChange={e => {
                    const s=[...form.slice];
                    s[sliceIdx]={...s[sliceIdx], sst:parseInt(e.target.value)||1};
                    setForm({...form, slice:s});
                  }}
                  min={0}
                  max={255}
                />
              </div>
              <div>
                <label className="nms-label">SD (hex)</label>
                <input 
                  className="nms-input font-mono" 
                  value={sl.sd||''}
                  placeholder="Optional (6 hex chars)"
                  maxLength={6}
                  onChange={e => {
                    const s=[...form.slice];
                    s[sliceIdx]={...s[sliceIdx], sd:e.target.value||undefined};
                    setForm({...form, slice:s});
                  }}
                />
              </div>
              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input 
                    type="checkbox"
                    className="nms-checkbox"
                    checked={sl.default_indicator ?? false}
                    onChange={e => {
                      const s=[...form.slice];
                      s[sliceIdx]={...s[sliceIdx], default_indicator:e.target.checked};
                      setForm({...form, slice:s});
                    }}
                  />
                  <span className="text-xs text-nms-text-dim">Default Slice</span>
                </label>
              </div>
            </div>

            {/* Sessions */}
            <div className="space-y-4">
              {sl.session.map((sess, sessIdx) => (
                <div key={sessIdx} className="bg-nms-bg/80 rounded-md p-3 border border-nms-border/30">
                  <div className="flex items-center justify-between mb-3">
                    <h5 className="text-xs font-semibold text-nms-text">Session {sessIdx + 1}</h5>
                    {sl.session.length > 1 && (
                      <button
                        onClick={() => removeSession(sliceIdx, sessIdx)}
                        className="text-nms-red hover:text-nms-red/80 text-xs"
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <div>
                      <label className="nms-label">DNN/APN *</label>
                      <input 
                        className="nms-input font-mono text-sm"
                        value={sess.name}
                        onChange={e => updateSession(sliceIdx, sessIdx, { name: e.target.value })}
                        placeholder="internet"
                      />
                    </div>
                    <div>
                      <label className="nms-label">Type *</label>
                      <select
                        className="nms-input"
                        value={sess.type}
                        onChange={e => updateSession(sliceIdx, sessIdx, { type: parseInt(e.target.value) })}
                      >
                        {SESSION_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="nms-label">5QI/QCI *</label>
                      <input 
                        className="nms-input font-mono"
                        type="number"
                        value={sess.qos.index}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          qos: { ...sess.qos, index: parseInt(e.target.value) || 9 }
                        })}
                        min={1}
                        max={255}
                      />
                    </div>
                  </div>

                  {/* ARP */}
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <div>
                      <label className="nms-label">ARP Priority (1-15) *</label>
                      <input
                        className="nms-input font-mono"
                        type="number"
                        value={sess.qos.arp.priority_level}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          qos: { ...sess.qos, arp: { ...sess.qos.arp, priority_level: parseInt(e.target.value) || 8 } }
                        })}
                        min={1} max={15}
                      />
                    </div>
                    <div>
                      <label className="nms-label">Capability *</label>
                      <select
                        className="nms-input"
                        value={sess.qos.arp.pre_emption_capability}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          qos: { ...sess.qos, arp: { ...sess.qos.arp, pre_emption_capability: parseInt(e.target.value) } }
                        })}
                      >
                        <option value={1}>Disabled</option>
                        <option value={2}>Enabled</option>
                      </select>
                    </div>
                    <div>
                      <label className="nms-label">Vulnerability *</label>
                      <select
                        className="nms-input"
                        value={sess.qos.arp.pre_emption_vulnerability}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          qos: { ...sess.qos, arp: { ...sess.qos.arp, pre_emption_vulnerability: parseInt(e.target.value) } }
                        })}
                      >
                        <option value={1}>Disabled</option>
                        <option value={2}>Enabled</option>
                      </select>
                    </div>
                  </div>

                  {/* Session AMBR */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="nms-label">Session-AMBR Uplink *</label>
                      <div className="flex gap-1">
                        <input
                          className="nms-input font-mono"
                          type="number" min={0}
                          value={sess.ambr.uplink.value}
                          onChange={e => updateSession(sliceIdx, sessIdx, {
                            ambr: { ...sess.ambr, uplink: { value: parseInt(e.target.value) || 0, unit: sess.ambr.uplink.unit } }
                          })}
                        />
                        <select
                          className="nms-input w-24 flex-shrink-0"
                          value={sess.ambr.uplink.unit}
                          onChange={e => updateSession(sliceIdx, sessIdx, {
                            ambr: { ...sess.ambr, uplink: { value: sess.ambr.uplink.value, unit: parseInt(e.target.value) } }
                          })}
                        >
                          {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="nms-label">Session-AMBR Downlink *</label>
                      <div className="flex gap-1">
                        <input
                          className="nms-input font-mono"
                          type="number" min={0}
                          value={sess.ambr.downlink.value}
                          onChange={e => updateSession(sliceIdx, sessIdx, {
                            ambr: { ...sess.ambr, downlink: { value: parseInt(e.target.value) || 0, unit: sess.ambr.downlink.unit } }
                          })}
                        />
                        <select
                          className="nms-input w-24 flex-shrink-0"
                          value={sess.ambr.downlink.unit}
                          onChange={e => updateSession(sliceIdx, sessIdx, {
                            ambr: { ...sess.ambr, downlink: { value: sess.ambr.downlink.value, unit: parseInt(e.target.value) } }
                          })}
                        >
                          {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* UE Addresses */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="nms-label">UE IPv4 Address</label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={sess.ue?.ipv4 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, { ue: { ...sess.ue, ipv4: e.target.value || undefined } })}
                        placeholder="10.45.0.2"
                      />
                    </div>
                    <div>
                      <label className="nms-label">UE IPv6 Address</label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={sess.ue?.ipv6 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, { ue: { ...sess.ue, ipv6: e.target.value || undefined } })}
                        placeholder="2001:db8:cafe::1"
                      />
                    </div>
                  </div>

                  {/* SMF Addresses */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="nms-label">SMF IPv4 Address</label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={sess.smf?.ipv4 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, { smf: { ...sess.smf, ipv4: e.target.value || undefined } })}
                        placeholder="127.0.0.4"
                      />
                    </div>
                    <div>
                      <label className="nms-label">SMF IPv6 Address</label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={sess.smf?.ipv6 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, { smf: { ...sess.smf, ipv6: e.target.value || undefined } })}
                        placeholder="::1"
                      />
                    </div>
                  </div>

                  {/* Framed Routes (TS 23.501 §5.6.14) — IP subnets routed behind the UE.
                      Open5GS caps this at 8 per address family per session
                      (OGS_MAX_NUM_OF_FRAMED_ROUTES_IN_PDN) — a 9th entry isn't rejected by
                      the core NFs, it's silently dropped, so the count is surfaced live here
                      rather than only failing on save. */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="nms-label">Framed Routes IPv4</label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={sess.ipv4_framed_routes?.join(', ') || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          ipv4_framed_routes: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        })}
                        placeholder="10.45.33.0/24, 10.45.34.0/24"
                      />
                      <p className={clsx('text-xs mt-1', (sess.ipv4_framed_routes?.length ?? 0) > 8 ? 'text-red-400' : 'text-nms-text-dim')}>
                        {sess.ipv4_framed_routes?.length ?? 0}/8 routes
                        {(sess.ipv4_framed_routes?.length ?? 0) > 8 ? ' — exceeds Open5GS\'s per-session limit' : ''}
                      </p>
                    </div>
                    <div>
                      <label className="nms-label">Framed Routes IPv6</label>
                      <input
                        className="nms-input font-mono text-sm"
                        value={sess.ipv6_framed_routes?.join(', ') || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          ipv6_framed_routes: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                        })}
                        placeholder="2001:db8:cafe:1::/64"
                      />
                      <p className={clsx('text-xs mt-1', (sess.ipv6_framed_routes?.length ?? 0) > 8 ? 'text-red-400' : 'text-nms-text-dim')}>
                        {sess.ipv6_framed_routes?.length ?? 0}/8 routes
                        {(sess.ipv6_framed_routes?.length ?? 0) > 8 ? ' — exceeds Open5GS\'s per-session limit' : ''}
                      </p>
                    </div>
                  </div>

                  {((sess.ipv4_framed_routes?.length ?? 0) > 0 || (sess.ipv6_framed_routes?.length ?? 0) > 0) && (
                    <div className="mb-3">
                      <label
                        className="flex items-center gap-2 text-xs text-nms-text-secondary cursor-pointer"
                        title="Adds/removes a local ip route on this host automatically. The rest of your network still needs its own route to this subnet — pointing at THIS Open5GS host's IP, never the UE's IP — either via a dynamic routing advertisement (e.g. EIGRP) or a manual static route on your core/edge router."
                      >
                        <input
                          type="checkbox"
                          checked={!!sess.framed_routes_static}
                          onChange={e => updateSession(sliceIdx, sessIdx, { framed_routes_static: e.target.checked })}
                          className="w-4 h-4 rounded border-nms-border accent-nms-accent cursor-pointer"
                        />
                        Apply static route on host (adds/removes <code>ip route</code> on the DNN's tun device automatically)
                      </label>
                      {sess.framed_routes_static && (
                        <div className="mt-2 text-xs text-nms-text-dim bg-nms-surface-2/50 rounded px-3 py-2 space-y-2">
                          <p>
                            This adds the local route on this host only. Traffic still has to get routed <em>to</em> this
                            host from the rest of your network — that's a separate step, done one of two ways:
                          </p>
                          <div>
                            <span className="font-semibold text-nms-text-secondary">Option A — dynamic routing (e.g. EIGRP):</span> add
                            this to <code>frr.conf</code>'s <code>router eigrp 1</code> block yourself (not automated):
                            <div className="font-mono mt-1">
                              {[...(sess.ipv4_framed_routes ?? []), ...(sess.ipv6_framed_routes ?? [])].map(cidr => (
                                <div key={cidr}>network {cidr}</div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <span className="font-semibold text-nms-text-secondary">Option B — manual static route:</span> on your
                            core/edge router, point the route at <strong>this Open5GS host's own IP</strong> on the link
                            to that router — <strong>never the UE's IP</strong> (the UE isn't a direct L3 hop from outside
                            this host; this host is what forwards into the UE's tunnel). Example, if this host's IP toward
                            your router is <code>192.168.253.2</code>:
                            <div className="font-mono mt-1">
                              {[...(sess.ipv4_framed_routes ?? []), ...(sess.ipv6_framed_routes ?? [])].map(cidr => (
                                <div key={cidr}>ip route {cidr} 192.168.253.2  <span className="text-nms-text-dim">(replace with this host's real IP)</span></div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Dedicated Bearers / PCC Rules */}
                  <div className="border-t border-nms-border/30 pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <h6 className="text-xs font-semibold text-nms-text-dim uppercase tracking-wide">Dedicated Bearers</h6>
                      <button
                        onClick={() => addPccRule(sliceIdx, sessIdx)}
                        className="nms-btn-ghost text-xs"
                      >
                        + Add Bearer
                      </button>
                    </div>
                    {(sess.pcc_rule ?? []).length === 0 && (
                      <p className="text-xs text-nms-text-dim italic">No dedicated bearers — add for IMS voice/video (QCI 1/2)</p>
                    )}
                    {(sess.pcc_rule ?? []).map((rule, ruleIdx) => (
                      <div key={ruleIdx} className="bg-nms-bg/60 rounded border border-nms-border/20 p-3 mb-2">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-nms-text-dim">Bearer {ruleIdx + 1} (QCI {rule.qos.index})</span>
                          <button onClick={() => removePccRule(sliceIdx, sessIdx, ruleIdx)} className="text-nms-red hover:text-nms-red/80 text-xs">Remove</button>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mb-2">
                          <div>
                            <label className="nms-label">5QI/QCI</label>
                            <input
                              className="nms-input font-mono"
                              type="number" min={1} max={255}
                              value={rule.qos.index}
                              onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                ...rule, qos: { ...rule.qos, index: parseInt(e.target.value) || 1 }
                              })}
                            />
                          </div>
                          <div>
                            <label className="nms-label">ARP Priority</label>
                            <input
                              className="nms-input font-mono"
                              type="number" min={1} max={15}
                              value={rule.qos.arp.priority_level}
                              onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                ...rule, qos: { ...rule.qos, arp: { ...rule.qos.arp, priority_level: parseInt(e.target.value) || 1 } }
                              })}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-1">
                            <div>
                              <label className="nms-label">Capability</label>
                              <select
                                className="nms-input"
                                value={rule.qos.arp.pre_emption_capability}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, arp: { ...rule.qos.arp, pre_emption_capability: parseInt(e.target.value) } }
                                })}
                              >
                                <option value={1}>Disabled</option>
                                <option value={2}>Enabled</option>
                              </select>
                            </div>
                            <div>
                              <label className="nms-label">Vulnerability</label>
                              <select
                                className="nms-input"
                                value={rule.qos.arp.pre_emption_vulnerability}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, arp: { ...rule.qos.arp, pre_emption_vulnerability: parseInt(e.target.value) } }
                                })}
                              >
                                <option value={1}>Disabled</option>
                                <option value={2}>Enabled</option>
                              </select>
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mb-2">
                          <div>
                            <label className="nms-label">MBR Uplink</label>
                            <div className="flex gap-1">
                              <input
                                className="nms-input font-mono"
                                type="number" min={0}
                                value={rule.qos.mbr.uplink.value}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, mbr: { ...rule.qos.mbr, uplink: { value: parseInt(e.target.value) || 0, unit: rule.qos.mbr.uplink.unit } } }
                                })}
                              />
                              <select
                                className="nms-input w-20 flex-shrink-0"
                                value={rule.qos.mbr.uplink.unit}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, mbr: { ...rule.qos.mbr, uplink: { value: rule.qos.mbr.uplink.value, unit: parseInt(e.target.value) } } }
                                })}
                              >
                                {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="nms-label">MBR Downlink</label>
                            <div className="flex gap-1">
                              <input
                                className="nms-input font-mono"
                                type="number" min={0}
                                value={rule.qos.mbr.downlink.value}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, mbr: { ...rule.qos.mbr, downlink: { value: parseInt(e.target.value) || 0, unit: rule.qos.mbr.downlink.unit } } }
                                })}
                              />
                              <select
                                className="nms-input w-20 flex-shrink-0"
                                value={rule.qos.mbr.downlink.unit}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, mbr: { ...rule.qos.mbr, downlink: { value: rule.qos.mbr.downlink.value, unit: parseInt(e.target.value) } } }
                                })}
                              >
                                {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                              </select>
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="nms-label">GBR Uplink</label>
                            <div className="flex gap-1">
                              <input
                                className="nms-input font-mono"
                                type="number" min={0}
                                value={rule.qos.gbr.uplink.value}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, gbr: { ...rule.qos.gbr, uplink: { value: parseInt(e.target.value) || 0, unit: rule.qos.gbr.uplink.unit } } }
                                })}
                              />
                              <select
                                className="nms-input w-20 flex-shrink-0"
                                value={rule.qos.gbr.uplink.unit}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, gbr: { ...rule.qos.gbr, uplink: { value: rule.qos.gbr.uplink.value, unit: parseInt(e.target.value) } } }
                                })}
                              >
                                {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="nms-label">GBR Downlink</label>
                            <div className="flex gap-1">
                              <input
                                className="nms-input font-mono"
                                type="number" min={0}
                                value={rule.qos.gbr.downlink.value}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, gbr: { ...rule.qos.gbr, downlink: { value: parseInt(e.target.value) || 0, unit: rule.qos.gbr.downlink.unit } } }
                                })}
                              />
                              <select
                                className="nms-input w-20 flex-shrink-0"
                                value={rule.qos.gbr.downlink.unit}
                                onChange={e => updatePccRule(sliceIdx, sessIdx, ruleIdx, {
                                  ...rule, qos: { ...rule.qos, gbr: { ...rule.qos.gbr, downlink: { value: rule.qos.gbr.downlink.value, unit: parseInt(e.target.value) } } }
                                })}
                              >
                                {AMBR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                              </select>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="flex gap-2">
                <button
                  onClick={() => addSession(sliceIdx)}
                  className="nms-btn-ghost text-xs flex-1"
                >
                  + Internet APN
                </button>
                <button
                  onClick={() => addSession(sliceIdx, { ...IMS_SESSION_TEMPLATE })}
                  className="nms-btn-ghost text-xs flex-1"
                >
                  + IMS APN
                </button>
              </div>
            </div>
          </div>
        ))}

        {framedRouteOverflow && (
          <p className="text-xs text-red-400 pt-2">
            One or more sessions exceed Open5GS's 8-route-per-family framed routing limit — remove routes before saving.
          </p>
        )}
        <div className="flex gap-3 pt-3 border-t border-nms-border">
          <button onClick={save} disabled={saving || framedRouteOverflow} className="nms-btn-primary flex items-center gap-2">
            <Save className="w-4 h-4" />
            {isNew ? 'Create' : 'Update'}
          </button>
          <button onClick={onCancel} className="nms-btn-ghost">Cancel</button>
        </div>
      </div>
    </div>
  );
}


interface SubscriberPageProps {
  initialImsiToEdit?: string;
}

export function SubscriberPage({ initialImsiToEdit }: SubscriberPageProps = {}): JSX.Element {
  const { user } = useAuth();
  const isViewer = user?.role === 'viewer';
  const subscribers = useSubscriberStore(s => s.subscribers);
  const total      = useSubscriberStore(s => s.total);
  const page       = useSubscriberStore(s => s.page);
  const fetch      = useSubscriberStore(s => s.fetchSubscribers);
  const setPage    = useSubscriberStore(s => s.setPage);
  const setSearch  = useSubscriberStore(s => s.setSearch);
  const sortBy     = useSubscriberStore(s => s.sortBy);
  const sortOrder  = useSubscriberStore(s => s.sortOrder);
  const setSort    = useSubscriberStore(s => s.setSort);

  // ── Grouping state (must be declared before useMemos that reference them) ──
  const [groups, setGroups] = useState<SubscriberGroup[]>([]);
  const [selectedImsis, setSelectedImsis] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupModal, setGroupModal] = useState<{ mode: 'create' } | { mode: 'rename'; group: SubscriberGroup } | null>(null);

  const fetchGroups = useCallback(async () => {
    try { setGroups(await subscriberGroupsApi.list()); } catch { /* silent */ }
  }, []);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const toggleSelect = (imsi: string) => {
    setSelectedImsis(prev => {
      const next = new Set(prev);
      next.has(imsi) ? next.delete(imsi) : next.add(imsi);
      return next;
    });
  };

  const clearSelection = () => setSelectedImsis(new Set());

  // Client-side sort — no backend call, instant
  const sortedSubscribers = useMemo(() => {
    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...subscribers].sort((a, b) => {
      let av = '', bv = '';
      if (sortBy === 'imsi')    { av = a.imsi    || ''; bv = b.imsi    || ''; }
      if (sortBy === 'ue_ipv4') { av = a.ue_ipv4 || ''; bv = b.ue_ipv4 || ''; }
      if (sortBy === 'apn')     { av = a.apn     || ''; bv = b.apn     || ''; }
      return dir * av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [subscribers, sortBy, sortOrder]);

  // Build the rendered list: grouped clusters first, then ungrouped
  type RenderedItem =
    | { type: 'group-header'; group: SubscriberGroup }
    | { type: 'group-member'; sub: SubscriberListItem; group: SubscriberGroup }
    | { type: 'ungrouped'; sub: SubscriberListItem };

  const renderedItems = useMemo((): RenderedItem[] => {
    const groupedImsiSet = new Set(groups.flatMap(g => g.imsis));
    const subMap = new Map(sortedSubscribers.map(s => [s.imsi, s]));
    const items: RenderedItem[] = [];
    for (const group of groups) {
      const members = group.imsis.map(imsi => subMap.get(imsi)).filter(Boolean) as SubscriberListItem[];
      if (members.length === 0) continue;
      items.push({ type: 'group-header', group });
      if (!collapsedGroups.has(group._id)) {
        for (const sub of members) items.push({ type: 'group-member', sub, group });
      }
    }
    for (const sub of sortedSubscribers) {
      if (!groupedImsiSet.has(sub.imsi)) items.push({ type: 'ungrouped', sub });
    }
    return items;
  }, [sortedSubscribers, groups, collapsedGroups]);

  const [showForm, setShowForm] = useState(false);
  const [editImsi, setEditImsi] = useState<string|null>(null);
  const [editSub, setEditSub] = useState<Subscriber|null>(null);
  const [si, setSi] = useState('');
  const [showGenerator, setShowGenerator] = useState(false);
  const [showEsimModal, setShowEsimModal] = useState(false);
  const [esimSubscriber, setEsimSubscriber] = useState<Subscriber | undefined>(undefined);
  const [showIPAssignments, setShowIPAssignments] = useState(false);
  const [showFramedRoutes, setShowFramedRoutes] = useState(false);
  const [showAddressMenu, setShowAddressMenu] = useState(false);
  const [showBulkTools, setShowBulkTools]     = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<'skip' | 'overwrite'>('skip');
  const importRef = useRef<HTMLInputElement>(null);

  // Handle navigation from other pages (e.g., RAN page)
  useEffect(() => {
    if (initialImsiToEdit) {
      // Load and edit the subscriber
      subscriberApi.get(initialImsiToEdit)
        .then(s => {
          setEditSub(s);
          setEditImsi(initialImsiToEdit);
        })
        .catch(() => {
          toast.error('Failed to load subscriber');
        });
    }
  }, [initialImsiToEdit]);

  useEffect(() => { fetch(); }, [fetch]);

  const handleExport = () => {
    const a = document.createElement('a');
    a.href = subscriberApi.exportCSV('csv');
    a.click();
  };

  const handleImport = async (file: File) => {
    const text = await file.text();
    setImporting(true);
    try {
      const result = await subscriberApi.importCSV(text, importMode);
      const msg = `Imported: ${result.imported} | Skipped: ${result.skipped} | Overwritten: ${result.overwritten}`;
      if (result.errors.length > 0) {
        toast.error(`${msg}\n${result.errors.slice(0, 3).join('\n')}`, { duration: 8000 });
      } else {
        toast.success(msg);
      }
      fetch();
    } catch {
      toast.error('Import failed');
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="shrink-0">
          <h1 className="text-2xl font-semibold font-display">Subscribers</h1>
          <p className="text-sm text-nms-text-dim mt-1">{total} provisioned</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          {/* Export — available to all */}
          <button onClick={handleExport} className="nms-btn-ghost flex items-center gap-1.5" title="Export all subscribers to CSV">
            <Download className="w-4 h-4 shrink-0" /><span className="hidden sm:inline">Export CSV</span>
          </button>

          {/* Generate eSIM (Simlessly) — available to all */}
          <button
            onClick={() => { setEsimSubscriber(undefined); setShowEsimModal(true); }}
            className="nms-btn-ghost flex items-center gap-1.5"
            title="Generate an eSIM activation-code JSON via Simlessly"
          >
            <Smartphone className="w-4 h-4 shrink-0" /><span className="hidden sm:inline">Generate eSIM</span>
          </button>

          {/* Import — admin only */}
          {!isViewer && (
            <>
              <select value={importMode} onChange={e => setImportMode(e.target.value as 'skip' | 'overwrite')}
                className="nms-input text-xs w-auto sm:w-32 hidden sm:block" title="Import mode">
                <option value="skip">Skip duplicates</option>
                <option value="overwrite">Overwrite duplicates</option>
              </select>
              <button onClick={() => importRef.current?.click()} disabled={importing}
                className="nms-btn-ghost flex items-center gap-1.5" title="Import subscribers from CSV">
                <Upload className="w-4 h-4 shrink-0" /><span className="hidden sm:inline">{importing ? 'Importing…' : 'Import CSV'}</span>
              </button>
              <input ref={importRef} type="file" accept=".csv,.tsv,.txt" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); }} />
            </>
          )}

          {/* Bulk Tools dropdown — IP Assignments, Framed Routes, Auto-Assign IPs, Auto-Assign MSISDN, Bulk Add APN */}
          <div className="relative">
            {showAddressMenu && (
              <div className="fixed inset-0 z-10" onClick={() => setShowAddressMenu(false)} />
            )}
            <button
              onClick={() => setShowAddressMenu(v => !v)}
              className="nms-btn-ghost flex items-center gap-1.5 relative z-20"
              title="Bulk subscriber tools"
            >
              <Network className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">Bulk Tools</span>
              <ChevronDown className="w-3 h-3 shrink-0" />
            </button>
            {showAddressMenu && (
              <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-nms-surface border border-nms-border rounded-lg shadow-2xl py-1 overflow-hidden">
                <button
                  onClick={() => { setShowIPAssignments(true); setShowAddressMenu(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nms-text hover:bg-nms-surface-2 transition-colors text-left"
                >
                  <List className="w-4 h-4 text-nms-text-dim shrink-0" />
                  <div>
                    <div className="font-medium">IP Assignments</div>
                    <div className="text-xs text-nms-text-dim">View current UE IP addresses</div>
                  </div>
                </button>
                <button
                  onClick={() => { setShowFramedRoutes(true); setShowAddressMenu(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nms-text hover:bg-nms-surface-2 transition-colors text-left"
                >
                  <Network className="w-4 h-4 text-nms-text-dim shrink-0" />
                  <div>
                    <div className="font-medium">Framed Routes</div>
                    <div className="text-xs text-nms-text-dim">Registry of subnets routed behind UEs</div>
                  </div>
                </button>
                {!isViewer && (
                  <>
                    <div className="border-t border-nms-border/40 my-1" />
                    <button
                      onClick={() => { setShowBulkTools(true); setShowAddressMenu(false); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-nms-text hover:bg-nms-surface-2 transition-colors text-left"
                    >
                      <Network className="w-4 h-4 text-nms-text-dim shrink-0" />
                      <div>
                        <div className="font-medium">Bulk Subscriber Tools</div>
                        <div className="text-xs text-nms-text-dim">Auto-Assign IPs, MSISDN, Bulk Add APN</div>
                      </div>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {!isViewer && (
            <>
              <button onClick={() => setShowGenerator(true)} className="nms-btn-ghost flex items-center gap-1.5" title="SIM Generator">
                <CreditCard className="w-4 h-4 shrink-0" /><span className="hidden sm:inline">SIM Generator</span>
              </button>
              <button onClick={() => { setShowForm(true); setEditImsi(null); }} className="nms-btn-primary flex items-center gap-1.5">
                <Plus className="w-4 h-4 shrink-0" /><span className="hidden xs:inline">Add Subscriber</span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nms-text-dim" />
        <input 
          className="nms-input pl-10" 
          placeholder="Search IMSI or MSISDN..." 
          value={si} 
          onChange={e => { setSi(e.target.value); setSearch(e.target.value); }} 
        />
      </div>

      {showGenerator && !isViewer && (
        <SIMGeneratorDialog onClose={() => setShowGenerator(false)} />
      )}


      {showIPAssignments && <IPAssignmentsModal onClose={() => setShowIPAssignments(false)} />}
      {showFramedRoutes && <FramedRoutesModal onClose={() => setShowFramedRoutes(false)} />}
      {showEsimModal && (
        <EsimGeneratorModal
          subscriber={esimSubscriber}
          onClose={() => { setShowEsimModal(false); setEsimSubscriber(undefined); }}
        />
      )}
      {showBulkTools && !isViewer && (
        <BulkToolsDialog
          totalSubscribers={total}
          initialSelectedImsis={[...selectedImsis]}
          onClose={() => setShowBulkTools(false)}
          onDone={() => fetch()}
        />
      )}

      {groupModal && !isViewer && (
        <GroupModal
          initial={groupModal.mode === 'rename' ? { name: groupModal.group.name, color: groupModal.group.color ?? GROUP_COLORS[0] } : undefined}
          onConfirm={async (name, color) => {
            if (groupModal.mode === 'create') {
              const imsis = [...selectedImsis];
              await subscriberGroupsApi.create(name, imsis, color);
              clearSelection();
            } else {
              await subscriberGroupsApi.update(groupModal.group._id, { name, color });
            }
            await fetchGroups();
            setGroupModal(null);
          }}
          onClose={() => setGroupModal(null)}
        />
      )}

      {showForm && !isViewer && (
        <SubForm 
          sub={DEFAULT_SUB} 
          onSave={async s => {
            try {
              const result = await subscriberApi.create(s);
              toast.success('Subscriber created');
              result?.warnings?.forEach(w => toast(w, { icon: '⚠️', duration: 8000 }));
              setShowForm(false);
              fetch();
            } catch(e:any) {
              toast.error(e?.message || 'Failed to create subscriber');
            }
          }}
          onCancel={() => setShowForm(false)} 
          isNew 
        />
      )}

      {editSub && editImsi && (
        <SubForm 
          sub={editSub} 
          onSave={async s => {
            try {
              const result = await subscriberApi.update(editImsi, s);
              toast.success('Subscriber updated');
              result?.warnings?.forEach(w => toast(w, { icon: '⚠️', duration: 8000 }));
              setEditImsi(null);
              setEditSub(null);
              fetch();
            } catch(e:any) {
              toast.error(e?.message || 'Failed to update subscriber');
            }
          }}
          onCancel={() => { setEditImsi(null); setEditSub(null); }} 
          isNew={false} 
        />
      )}

      {/* Floating selection toolbar */}
      {selectedImsis.size > 0 && !isViewer && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-nms-surface border border-nms-accent/40 rounded-xl px-5 py-3 shadow-2xl">
          <span className="text-sm font-semibold text-nms-accent">{selectedImsis.size} selected</span>
          <div className="w-px h-4 bg-nms-border" />
          <button
            onClick={() => setGroupModal({ mode: 'create' })}
            className="nms-btn-primary text-xs flex items-center gap-1.5"
          >
            <Users className="w-3.5 h-3.5" />
            Group selected
          </button>
          {/* Add selected to existing group */}
          {groups.length > 0 && (
            <div className="relative group">
              <button className="nms-btn-ghost text-xs flex items-center gap-1.5">
                Add to group <ChevronDown className="w-3 h-3" />
              </button>
              <div className="absolute bottom-full mb-1 left-0 hidden group-hover:block bg-nms-surface border border-nms-border rounded-lg shadow-2xl py-1 min-w-40 z-50">
                {groups.map(g => (
                  <button
                    key={g._id}
                    onClick={async () => {
                      const merged = [...new Set([...g.imsis, ...selectedImsis])];
                      await subscriberGroupsApi.update(g._id, { imsis: merged });
                      await fetchGroups();
                      clearSelection();
                      toast.success(`Added to "${g.name}"`);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-nms-surface-2 text-left"
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color ?? '#6366f1' }} />
                    {g.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="w-px h-4 bg-nms-border" />
          <button
            onClick={async () => {
              const imsis = [...selectedImsis];
              if (!confirm(`Delete ${imsis.length} selected subscriber${imsis.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
              let deleted = 0;
              const errors: string[] = [];
              for (const imsi of imsis) {
                try {
                  await subscriberApi.delete(imsi);
                  deleted++;
                } catch {
                  errors.push(imsi);
                }
              }
              clearSelection();
              fetch();
              if (errors.length === 0) {
                toast.success(`${deleted} subscriber${deleted !== 1 ? 's' : ''} deleted`);
              } else {
                toast.error(`Deleted ${deleted}, failed ${errors.length} (${errors.slice(0, 3).join(', ')}${errors.length > 3 ? '…' : ''})`);
              }
            }}
            className="nms-btn text-xs flex items-center gap-1.5 border border-nms-red/40 text-nms-red hover:bg-nms-red/10"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete selected
          </button>
          <button onClick={clearSelection} className="text-nms-text-dim hover:text-nms-text">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="nms-card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-nms-border">
              {!isViewer && <th className="w-10 px-3 py-3" />}
              {[
                { key: 'imsi',    label: 'IMSI' },
                { key: null,      label: 'Nickname' },
                { key: null,      label: 'ICCID' },
                { key: null,      label: 'MSISDN' },
                { key: 'apn',     label: 'APN' },
                { key: 'ue_ipv4', label: 'UE IPv4' },
                { key: null,      label: 'Status' },
                { key: null,      label: 'Slices' },
                { key: null,      label: 'Actions' },
              ].map(({ key, label }) => (
                <th key={label} className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                  {key ? (
                    <button
                      onClick={() => {
                        const newOrder = sortBy === key && sortOrder === 'asc' ? 'desc' : 'asc';
                        setSort(key as 'imsi' | 'ue_ipv4' | 'apn', newOrder);
                      }}
                      className="flex items-center gap-1 hover:text-nms-text transition-colors"
                    >
                      {label}
                      {sortBy === key
                        ? sortOrder === 'asc'
                          ? <ArrowUp   className="w-3 h-3 text-nms-accent" />
                          : <ArrowDown className="w-3 h-3 text-nms-accent" />
                        : <span className="w-3 h-3 opacity-20">↕</span>}
                    </button>
                  ) : label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {renderedItems.map((item) => {
              if (item.type === 'group-header') {
                const { group } = item;
                const collapsed = collapsedGroups.has(group._id);
                const memberCount = group.imsis.filter(imsi => sortedSubscribers.some(s => s.imsi === imsi)).length;
                return (
                  <tr key={`group-${group._id}`} className="border-b border-nms-border" style={{ backgroundColor: (group.color ?? '#6366f1') + '14' }}>
                    {!isViewer && <td className="w-10 px-3 py-2" />}
                    <td colSpan={9} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setCollapsedGroups(prev => {
                            const next = new Set(prev);
                            next.has(group._id) ? next.delete(group._id) : next.add(group._id);
                            return next;
                          })}
                          className="text-nms-text-dim hover:text-nms-text transition-colors"
                        >
                          <ChevronRight className={`w-4 h-4 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
                        </button>
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: group.color ?? '#6366f1' }} />
                        <span className="text-sm font-semibold text-nms-text">{group.name}</span>
                        <span className="text-xs text-nms-text-dim">({memberCount} SIM{memberCount !== 1 ? 's' : ''})</span>
                        {!isViewer && (
                          <div className="ml-auto flex items-center gap-1">
                            <button
                              title="Rename group"
                              onClick={() => setGroupModal({ mode: 'rename', group })}
                              className="text-nms-text-dim hover:text-nms-accent p-1 transition-colors"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              title="Dissolve group (members stay, group removed)"
                              onClick={async () => {
                                if (!confirm(`Dissolve group "${group.name}"? Members will remain as ungrouped subscribers.`)) return;
                                await subscriberGroupsApi.delete(group._id);
                                await fetchGroups();
                                toast.success(`Group "${group.name}" dissolved`);
                              }}
                              className="text-nms-text-dim hover:text-nms-red p-1 transition-colors"
                            >
                              <Unlink className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              }

              const sub = item.type === 'group-member' ? item.sub : item.sub;
              const inGroup = item.type === 'group-member';
              const groupColor = inGroup ? (item.group.color ?? '#6366f1') : null;
              const isSelected = selectedImsis.has(sub.imsi);

              return (
                <tr
                  key={sub.imsi}
                  className={`border-b border-nms-border/50 hover:bg-nms-surface-2/50 transition-colors ${isSelected ? 'bg-nms-accent/5' : ''}`}
                  style={inGroup ? { borderLeft: `3px solid ${groupColor}` } : undefined}
                >
                  {!isViewer && (
                    <td className="w-10 px-3 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(sub.imsi)}
                        className="w-4 h-4 rounded border-nms-border accent-nms-accent cursor-pointer"
                      />
                    </td>
                  )}
                  <td className={`px-4 py-3 font-mono text-xs ${inGroup ? 'pl-5' : ''}`}>{sub.imsi}</td>
                  <td className="px-4 py-3 text-xs">
                    {sub.nickname
                      ? <span className="text-nms-accent font-medium">{sub.nickname}</span>
                      : <span className="text-nms-text-dim">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-nms-text-dim">
                    {sub.iccid || <span className="text-nms-text-dim">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-nms-text-dim">{sub.msisdn?.join(', ') || '—'}</td>
                  <td className="px-4 py-3 text-xs font-mono text-nms-text-dim">
                    {sub.sessions && sub.sessions.length > 0
                      ? sub.sessions.map((s, i) => <div key={i}>{s.apn || '—'}</div>)
                      : (sub.apn || '—')}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-nms-accent">
                    {sub.sessions && sub.sessions.length > 0
                      ? sub.sessions.map((s, i) => (
                          <div key={i}>
                            {s.ipv4 || '—'}
                            {s.framedRoutes && s.framedRoutes.length > 0 && (
                              <div className="text-nms-text-dim">↳ {s.framedRoutes.join(', ')}</div>
                            )}
                          </div>
                        ))
                      : (sub.ue_ipv4 || '—')}
                  </td>
                  <td className="px-4 py-3">
                    <span className="bg-nms-green/10 text-nms-green text-xs px-2 py-0.5 rounded-full">Active</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="bg-nms-accent/10 text-nms-accent text-xs px-2 py-0.5 rounded-full">{sub.slice_count}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isViewer && (
                      <div className="flex items-center justify-end gap-2">
                        {inGroup && (
                          <button
                            title="Remove from group"
                            onClick={async () => {
                              const updated = item.group.imsis.filter(i => i !== sub.imsi);
                              if (updated.length === 0) {
                                await subscriberGroupsApi.delete(item.group._id);
                              } else {
                                await subscriberGroupsApi.update(item.group._id, { imsis: updated });
                              }
                              await fetchGroups();
                            }}
                            className="text-nms-text-dim hover:text-nms-text-dim/60 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Unlink className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={async () => {
                            try {
                              const s = await subscriberApi.get(sub.imsi);
                              setEditSub(s);
                              setEditImsi(sub.imsi);
                            } catch {
                              toast.error('Failed to load subscriber');
                            }
                          }}
                          className="text-nms-text-dim hover:text-nms-accent"
                        >
                          <Edit className="w-4 h-4 inline" />
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              const s = await subscriberApi.get(sub.imsi);
                              setEsimSubscriber(s);
                              setShowEsimModal(true);
                            } catch {
                              toast.error('Failed to load subscriber');
                            }
                          }}
                          className="text-nms-text-dim hover:text-nms-accent"
                          title="Generate eSIM (Simlessly)"
                        >
                          <Smartphone className="w-4 h-4 inline" />
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(`Delete subscriber ${sub.imsi}?`)) return;
                            try {
                              await subscriberApi.delete(sub.imsi);
                              toast.success('Subscriber deleted');
                              fetch();
                            } catch {
                              toast.error('Failed to delete subscriber');
                            }
                          }}
                          className="text-nms-text-dim hover:text-nms-red"
                        >
                          <Trash2 className="w-4 h-4 inline" />
                        </button>
                      </div>
                    )}
                    {isViewer && <span className="text-xs text-nms-text-dim">view only</span>}
                  </td>
                </tr>
              );
            })}
            {subscribers.length === 0 && (
              <tr>
                <td colSpan={isViewer ? 9 : 10} className="px-4 py-12 text-center text-nms-text-dim">
                  No subscribers found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {total > 50 && (
        <div className="flex items-center justify-center gap-3">
          <button 
            onClick={() => setPage(Math.max(0, page - 1))} 
            disabled={page === 0} 
            className="nms-btn-ghost text-xs"
          >
            Previous
          </button>
          <span className="text-xs text-nms-text-dim">
            Page {page + 1} of {Math.ceil(total / 50)}
          </span>
          <button 
            onClick={() => setPage(page + 1)} 
            disabled={(page + 1) * 50 >= total} 
            className="nms-btn-ghost text-xs"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
