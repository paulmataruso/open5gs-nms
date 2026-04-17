import { useEffect, useState } from 'react';
import { Plus, Search, Trash2, Edit, X, Save, CreditCard, Copy, Download, Shield } from 'lucide-react';
import { useSubscriberStore, useSuciStore } from '../../stores';
import { subscriberApi } from '../../api';
import type { Subscriber, SubscriberListItem, SubscriberSession } from '../../types';
import toast from 'react-hot-toast';

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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
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
                            onClick={() => copyToClipboard(selectedKey.publicKeyHex!)}
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
                        onClick={() => copyToClipboard(JSON.stringify(sim, null, 2))}
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

  const addSession = (sliceIdx: number) => {
    const newSlices = [...form.slice];
    newSlices[sliceIdx] = {
      ...newSlices[sliceIdx],
      session: [
        ...newSlices[sliceIdx].session,
        {
          name: 'internet',
          type: 3,
          ambr: { uplink: { value: 1, unit: 3 }, downlink: { value: 1, unit: 3 } },
          qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
        }
      ]
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
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="nms-label">IMSI *</label>
              <input 
                className="nms-input font-mono text-sm" 
                value={form.imsi} 
                disabled={!isNew}
                onChange={e => setForm({...form, imsi: e.target.value})} 
                placeholder="001010000000001" 
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
                          qos: { 
                            ...sess.qos, 
                            arp: { ...sess.qos.arp, priority_level: parseInt(e.target.value) || 8 }
                          }
                        })}
                        min={1}
                        max={15}
                      />
                    </div>
                    <div>
                      <label className="nms-label">Capability *</label>
                      <select
                        className="nms-input"
                        value={sess.qos.arp.pre_emption_capability}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          qos: { 
                            ...sess.qos, 
                            arp: { ...sess.qos.arp, pre_emption_capability: parseInt(e.target.value) }
                          }
                        })}
                      >
                        <option value={1}>Enabled</option>
                        <option value={2}>Disabled</option>
                      </select>
                    </div>
                    <div>
                      <label className="nms-label">Vulnerability *</label>
                      <select
                        className="nms-input"
                        value={sess.qos.arp.pre_emption_vulnerability}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          qos: { 
                            ...sess.qos, 
                            arp: { ...sess.qos.arp, pre_emption_vulnerability: parseInt(e.target.value) }
                          }
                        })}
                      >
                        <option value={1}>Enabled</option>
                        <option value={2}>Disabled</option>
                      </select>
                    </div>
                  </div>

                  {/* Session AMBR */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="nms-label">Session-AMBR Uplink (Gbps) *</label>
                      <input 
                        className="nms-input font-mono"
                        type="number"
                        value={sess.ambr.uplink.value}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          ambr: { 
                            ...sess.ambr, 
                            uplink: { value: parseInt(e.target.value) || 1, unit: 3 }
                          }
                        })}
                      />
                    </div>
                    <div>
                      <label className="nms-label">Session-AMBR Downlink (Gbps) *</label>
                      <input 
                        className="nms-input font-mono"
                        type="number"
                        value={sess.ambr.downlink.value}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          ambr: { 
                            ...sess.ambr, 
                            downlink: { value: parseInt(e.target.value) || 1, unit: 3 }
                          }
                        })}
                      />
                    </div>
                  </div>

                  {/* UE Addresses */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="nms-label">UE IPv4 Address</label>
                      <input 
                        className="nms-input font-mono text-sm"
                        value={sess.ue?.ipv4 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          ue: { ...sess.ue, ipv4: e.target.value || undefined }
                        })}
                        placeholder="10.45.0.2"
                      />
                    </div>
                    <div>
                      <label className="nms-label">UE IPv6 Address</label>
                      <input 
                        className="nms-input font-mono text-sm"
                        value={sess.ue?.ipv6 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          ue: { ...sess.ue, ipv6: e.target.value || undefined }
                        })}
                        placeholder="2001:db8:cafe::1"
                      />
                    </div>
                  </div>

                  {/* SMF Addresses */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="nms-label">SMF IPv4 Address</label>
                      <input 
                        className="nms-input font-mono text-sm"
                        value={sess.smf?.ipv4 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          smf: { ...sess.smf, ipv4: e.target.value || undefined }
                        })}
                        placeholder="127.0.0.4"
                      />
                    </div>
                    <div>
                      <label className="nms-label">SMF IPv6 Address</label>
                      <input 
                        className="nms-input font-mono text-sm"
                        value={sess.smf?.ipv6 || ''}
                        onChange={e => updateSession(sliceIdx, sessIdx, {
                          smf: { ...sess.smf, ipv6: e.target.value || undefined }
                        })}
                        placeholder="::1"
                      />
                    </div>
                  </div>
                </div>
              ))}

              <button
                onClick={() => addSession(sliceIdx)}
                className="nms-btn-ghost text-xs w-full"
              >
                + Add Session
              </button>
            </div>
          </div>
        ))}

        <div className="flex gap-3 pt-3 border-t border-nms-border">
          <button onClick={save} disabled={saving} className="nms-btn-primary flex items-center gap-2">
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
  const subscribers = useSubscriberStore(s => s.subscribers);
  const total = useSubscriberStore(s => s.total);
  const page = useSubscriberStore(s => s.page);
  const fetch = useSubscriberStore(s => s.fetchSubscribers);
  const setPage = useSubscriberStore(s => s.setPage);
  const setSearch = useSubscriberStore(s => s.setSearch);
  const [showForm, setShowForm] = useState(false);
  const [editImsi, setEditImsi] = useState<string|null>(null);
  const [editSub, setEditSub] = useState<Subscriber|null>(null);
  const [si, setSi] = useState('');
  const [showGenerator, setShowGenerator] = useState(false);

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

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold font-display">Subscribers</h1>
          <p className="text-sm text-nms-text-dim mt-1">{total} provisioned</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setShowGenerator(true)} className="nms-btn-ghost flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> SIM Generator
          </button>
          <button onClick={() => { setShowForm(true); setEditImsi(null); }} className="nms-btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> Add Subscriber
          </button>
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

      {showGenerator && (
        <SIMGeneratorDialog
          onClose={() => setShowGenerator(false)}
        />
      )}

      {showForm && (
        <SubForm 
          sub={DEFAULT_SUB} 
          onSave={async s => {
            try {
              await subscriberApi.create(s);
              toast.success('Subscriber created');
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
              await subscriberApi.update(editImsi, s);
              toast.success('Subscriber updated');
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

      <div className="nms-card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-nms-border">
              <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">IMSI</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">MSISDN</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Slices</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Sessions</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((sub: SubscriberListItem) => (
              <tr key={sub.imsi} className="border-b border-nms-border/50 hover:bg-nms-surface-2/50 transition-colors">
                <td className="px-4 py-3 font-mono text-xs">{sub.imsi}</td>
                <td className="px-4 py-3 text-xs text-nms-text-dim">{sub.msisdn?.join(', ') || '—'}</td>
                <td className="px-4 py-3">
                  <span className="bg-nms-green/10 text-nms-green text-xs px-2 py-0.5 rounded-full">Active</span>
                </td>
                <td className="px-4 py-3">
                  <span className="bg-nms-accent/10 text-nms-accent text-xs px-2 py-0.5 rounded-full">{sub.slice_count}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="bg-nms-surface-2 text-nms-text-dim text-xs px-2 py-0.5 rounded-full">{sub.session_count}</span>
                </td>
                <td className="px-4 py-3 text-right">
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
                    className="text-nms-text-dim hover:text-nms-accent mr-2"
                  >
                    <Edit className="w-4 h-4 inline" />
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
                </td>
              </tr>
            ))}
            {subscribers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-nms-text-dim">
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
