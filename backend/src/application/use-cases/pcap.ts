import pino from 'pino';
import { XMLParser } from 'fast-xml-parser';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { ServiceName } from '../../domain/entities/service-status';
import { parseIpLinkAddr, HostInterface } from '../../infrastructure/network/ip-link-parser';
import { readCurrentImsConfig } from '../../interfaces/rest/ims-controller';
import { readCurrentSmsConfig } from '../../interfaces/rest/sms-controller';
import { loadState as loadVowifiState } from '../../interfaces/rest/vowifi-controller';

// ─── Storage ────────────────────────────────────────────────────────────────
// Bind-mounted identically on host and in-container (matching the existing
// backups/config + backups/mongodb convention) — dumpcap runs as a genuine HOST
// process (via systemd-run, see startCapture()) and writes here directly; the
// backend container reads/serves the same files back out through the mount.
export const PCAP_DIR = '/etc/open5gs/backups/pcap-captures';

const UNIT_PREFIX = 'nms-pcap-';
const ID_RE = /^\d+$/;

// ─── Types ──────────────────────────────────────────────────────────────────

export type PcapGroup = '4G' | '5G' | 'IMS' | 'VoWiFi' | 'SMS' | 'Infra';

export interface PcapHostPort {
  proto: 'tcp' | 'udp' | 'sctp';
  addr: string;
  port: number;
  role: string;
}

export interface NfCaptureDescriptor {
  nf: string;
  label: string;
  group: PcapGroup;
  hostPorts: PcapHostPort[];
}

export type CaptureScopeMode = 'all' | 'nf' | 'functionType' | 'gtpAll' | 'custom';

export interface CaptureScopeInput {
  mode: CaptureScopeMode;
  nfs?: string[];
  functionType?: string;
  customBpf?: string;
}

export type CaptureStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface PcapManifest {
  id: string;
  label: string;
  createdAt: string;
  interfaces: string[];
  scopeMode: CaptureScopeMode;
  scopeDescription: string;
  bpf: string;
  unitName: string;
  status: CaptureStatus;
  startedAt: string;
  stoppedAt?: string;
  sizeBytes?: number;
  error?: string;
}

export interface DecodePreset {
  id: string;
  label: string;
  filter: string;
}

export interface PacketRow {
  frameNumber: number;
  timeEpoch: number;
  src: string;
  dst: string;
  protocol: string;
  length: number;
  info: string;
}

// One node of a Wireshark-style Packet Details tree — a protocol layer (Frame,
// Ethernet II, Internet Protocol, ...) or a field/sub-field within one. `label` is
// PDML's own "showname" (the full human-readable line Wireshark's GUI displays,
// e.g. "Destination: 00:00:00_00:00:00 (00:00:00:00:00:00)"), so no re-formatting
// of raw values is needed client-side.
export interface PacketTreeNode {
  name: string;
  label: string;
  children: PacketTreeNode[];
}

const PACKET_ROW_LIMIT = 20000;

// Always applied on every decode invocation — Open5GS's SBI is plain HTTP/2
// cleartext on port 7777, which isn't a well-known HTTP/2 port to Wireshark's
// default dissector table, so without this hint SBI traffic renders as raw TCP
// instead of decoded HTTP/2. Harmless no-op on a capture with no SBI traffic.
const SBI_PORT = 7777;
const DECODE_AS_ARGS = ['-d', `tcp.port==${SBI_PORT},http2`];

const DECODE_PRESETS: DecodePreset[] = [
  { id: '5g-core', label: '5G Core', filter: 'gtpv2 || gtp || ngap || s1ap || pfcp || diameter || http2' },
  { id: 'ims', label: 'IMS / VoLTE / VoWiFi', filter: 'sip || diameter || pfcp || gtp' },
  { id: '4g-epc', label: '4G EPC', filter: 'gtpv2 || gtp || s1ap || diameter' },
  { id: 'gtp-only', label: 'GTP only', filter: 'gtp || gtpv2' },
  { id: 'none', label: 'None / raw (everything, undecoded filter)', filter: '' },
];

// Friendlier bundles over the same NF roster — purely a selection convenience,
// not a separate filter mechanism. Keys are freeform ids shown in the UI.
const FUNCTION_TYPE_GROUPS: Record<string, ServiceName[]> = {
  mme: ['mme'],
  amf: ['amf'],
  upf: ['upf'],
  sgw: ['sgwc', 'sgwu'],
  hss: ['hss'],
  pcrf: ['pcrf'],
  core5g: ['nrf', 'scp', 'amf', 'smf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'sepp1'],
  core4g: ['mme', 'hss', 'pcrf', 'sgwc', 'sgwu'],
};

function rejectUnsafeBpf(bpf: string): void {
  if (/[`$;|&]/.test(bpf) || bpf.includes('$(')) {
    throw new Error('Custom BPF filter contains disallowed characters');
  }
}

function validateId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`Invalid capture id "${id}"`);
}

// PDML (tshark -T pdml) is the same format Wireshark's own "Export Packet
// Dissection as XML" produces — <proto>/<field> elements nest exactly the way the
// GUI's Packet Details tree does, and each carries a "showname" attribute that's
// already the final human-readable line (value formatting, unit conversion, bit
// annotations, all done by the dissector, not re-derived here). isArray forces both
// tags to always parse as arrays regardless of how many siblings exist — otherwise
// fast-xml-parser collapses a lone child into a bare object instead of a 1-item
// array, which would make the recursive walk below type-inconsistent.
const pdmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name: string) => name === 'proto' || name === 'field' || name === 'packet',
  // Wireshark's showname text routinely contains apostrophes ("Don't fragment") and
  // other punctuation XML-escapes as numeric character references (&#x27;) rather
  // than the 5 predefined XML entities — fast-xml-parser only decodes those 5 by
  // default even in attribute values, leaving raw "&#x27;" in labels. htmlEntities
  // additionally enables numeric entity decoding.
  htmlEntities: true,
});

function pdmlNodeToTree(node: any): PacketTreeNode {
  const children: PacketTreeNode[] = [];
  const rawChildren = [
    ...(Array.isArray(node.field) ? node.field : []),
    ...(Array.isArray(node.proto) ? node.proto : []),
  ];
  for (const child of rawChildren) {
    if (child['@_hide'] === 'yes') continue;
    children.push(pdmlNodeToTree(child));
  }
  const label = node['@_showname'] ?? node['@_show'] ?? node['@_name'] ?? '(unnamed field)';
  return { name: node['@_name'] ?? '', label, children };
}

// "geninfo" is a synthetic PDML-only proto (frame number/timestamp/length used for
// the packet list columns) — Wireshark's own Packet Details tree never shows it as
// a node, so it's dropped here to match.
function parsePacketTree(pdmlXml: string): PacketTreeNode[] {
  const parsed = pdmlParser.parse(pdmlXml);
  const packet = parsed?.pdml?.packet?.[0];
  const protos: any[] = Array.isArray(packet?.proto) ? packet.proto : [];
  return protos
    .filter(p => p['@_hide'] !== 'yes' && p['@_name'] !== 'geninfo')
    .map(pdmlNodeToTree);
}

// tshark unconditionally prints this privilege-level notice to stderr when
// run as root, on both success AND failure — it's cosmetic, not part of the
// actual error, but since it's always the FIRST line it drowns out the real
// reason (bad filter syntax, missing file, etc.) when surfaced to the UI as
// one blob. Strip it before using stderr as an error message.
function cleanTsharkStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter(line => !/^Running as user .* group .*\. This could be dangerous\.$/.test(line.trim()))
    .join('\n')
    .trim();
}

export class PcapUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  // ── Interfaces ────────────────────────────────────────────────────────────
  // network_mode: host means this container already shares the host's network
  // namespace directly (confirmed in docker-compose.yml) — no nsenter needed,
  // unlike tun-management.ts's own (now redundant, but left as-is there)
  // `nsenter --net=/proc/1/ns/net` dance.
  async listInterfaces(): Promise<HostInterface[]> {
    const [linkR, addrR] = await Promise.all([
      this.hostExecutor.executeLocalCommand('ip', ['-o', 'link', 'show']),
      this.hostExecutor.executeLocalCommand('ip', ['-o', 'addr', 'show']),
    ]);
    return parseIpLinkAddr(linkR.stdout, addrR.stdout);
  }

  // ── NF descriptors (live config, never hardcoded — auto-config.ts can rebind
  // MME/AMF/UPF/SGW-U off loopback onto real routable addresses) ─────────────
  async buildNfDescriptors(): Promise<NfCaptureDescriptor[]> {
    const all = await this.configRepo.loadAll();
    const descriptors: NfCaptureDescriptor[] = [];

    const sbiPorts = (cfg: any, nf: string, label: string, group: PcapGroup): PcapHostPort[] => {
      const hostPorts: PcapHostPort[] = [];
      const sbiAddr = cfg?.sbi?.addr;
      const addr = Array.isArray(sbiAddr) ? sbiAddr[0] : sbiAddr;
      if (addr) hostPorts.push({ proto: 'tcp', addr, port: cfg.sbi.port ?? SBI_PORT, role: 'SBI' });
      return hostPorts;
    };

    // NFs loaded via YamlConfigRepository's loadGeneric() (mme/hss/pcrf/sgwc/sgwu/
    // sepp1) only expose sbi/pfcp/gtpu/ngap through parsers that normalize BOTH the
    // flat {addr,port} and nested {server:[{address,port}]} raw shapes — but it has
    // NO equivalent parser at all for s1ap/freeDiameter, and its own "gtpc" handling
    // is a flat-only passthrough that doesn't check server[] like the others do.
    // Confirmed live (2026-07-19): mme/hss/pcrf/sgwc/sgwu/sepp1 all silently vanished
    // from the NF picker because of this — sepp1 additionally has a real top-level
    // YAML key of "sepp", not "sepp1" (matches the file/service name, not the doc
    // key). Read every field for these 6 NFs directly off the preserved rawYaml
    // instead of trusting the generic loader's typed output, same technique already
    // proven in plmn-migration-usecase.ts for this exact class of problem.
    const rawServer = (section: any): { address?: string; port?: number } | undefined => {
      const s = section?.server;
      return Array.isArray(s) ? s[0] : undefined;
    };

    // 5G core — SBI mesh, plus role-specific ports where present.
    const sgc: Array<{ key: keyof typeof all; nf: string; label: string }> = [
      { key: 'nrf', nf: 'nrf', label: 'NRF' },
      { key: 'scp', nf: 'scp', label: 'SCP' },
      { key: 'amf', nf: 'amf', label: 'AMF' },
      { key: 'smf', nf: 'smf', label: 'SMF' },
      { key: 'ausf', nf: 'ausf', label: 'AUSF' },
      { key: 'udm', nf: 'udm', label: 'UDM' },
      { key: 'udr', nf: 'udr', label: 'UDR' },
      { key: 'pcf', nf: 'pcf', label: 'PCF' },
      { key: 'nssf', nf: 'nssf', label: 'NSSF' },
      { key: 'bsf', nf: 'bsf', label: 'BSF' },
    ];
    for (const { key, nf, label } of sgc) {
      const cfg: any = (all as any)[key];
      if (!cfg) continue;
      const hostPorts = sbiPorts(cfg, nf, label, '5G');
      if (nf === 'amf') {
        const ngapAddr = cfg.ngap?.addr;
        const addr = Array.isArray(ngapAddr) ? ngapAddr[0] : ngapAddr;
        if (addr) hostPorts.push({ proto: 'sctp', addr, port: 38412, role: 'NGAP' });
      }
      if (nf === 'smf') {
        const gtpcAddr = cfg.gtpc?.addr;
        const addr = Array.isArray(gtpcAddr) ? gtpcAddr[0] : gtpcAddr;
        if (addr) hostPorts.push({ proto: 'udp', addr, port: 2123, role: 'GTP-C' });
        if (cfg.pfcp?.addr) hostPorts.push({ proto: 'udp', addr: cfg.pfcp.addr, port: cfg.pfcp.port ?? 8805, role: 'PFCP' });
        if (cfg.freeDiameter) hostPorts.push({ proto: 'tcp', addr: '127.0.0.0/8', port: 3868, role: 'Diameter' });
      }
      if (hostPorts.length) descriptors.push({ nf, label, group: '5G', hostPorts });
    }

    // SEPP1 — real top-level YAML key is "sepp", not "sepp1" (rawYaml only).
    const sepp1Raw: any = (all as any).sepp1?.rawYaml?.sepp;
    if (sepp1Raw) {
      const hostPorts: PcapHostPort[] = [];
      const s = rawServer(sepp1Raw.sbi);
      if (s?.address) hostPorts.push({ proto: 'tcp', addr: s.address, port: s.port ?? SBI_PORT, role: 'SBI' });
      if (hostPorts.length) descriptors.push({ nf: 'sepp1', label: 'SEPP', group: '5G', hostPorts });
    }

    // UPF — GTP-U + PFCP, no SBI. Dedicated loader (loadUpf), flat shape is reliable.
    const upf: any = (all as any).upf;
    if (upf) {
      const hostPorts: PcapHostPort[] = [];
      if (upf.gtpu?.addr) hostPorts.push({ proto: 'udp', addr: upf.gtpu.addr, port: upf.gtpu.port ?? 2152, role: 'GTP-U' });
      if (upf.pfcp?.addr) hostPorts.push({ proto: 'udp', addr: upf.pfcp.addr, port: upf.pfcp.port ?? 8805, role: 'PFCP' });
      if (hostPorts.length) descriptors.push({ nf: 'upf', label: 'UPF', group: '5G', hostPorts });
    }

    // 4G EPC — all rawYaml (see note above).
    const mmeRaw: any = (all as any).mme?.rawYaml?.mme;
    if (mmeRaw) {
      const hostPorts: PcapHostPort[] = [];
      const s1ap = rawServer(mmeRaw.s1ap);
      if (s1ap?.address) hostPorts.push({ proto: 'sctp', addr: s1ap.address, port: 36412, role: 'S1AP' });
      const gtpc = rawServer(mmeRaw.gtpc);
      if (gtpc?.address) hostPorts.push({ proto: 'udp', addr: gtpc.address, port: 2123, role: 'GTP-C' });
      if (mmeRaw.freeDiameter) hostPorts.push({ proto: 'tcp', addr: '127.0.0.0/8', port: 3868, role: 'Diameter' });
      if (hostPorts.length) descriptors.push({ nf: 'mme', label: 'MME', group: '4G', hostPorts });
    }
    const hssRaw: any = (all as any).hss?.rawYaml?.hss;
    if (hssRaw?.freeDiameter) {
      descriptors.push({ nf: 'hss', label: 'HSS', group: '4G', hostPorts: [{ proto: 'tcp', addr: '127.0.0.0/8', port: 3868, role: 'Diameter' }] });
    }
    const pcrfRaw: any = (all as any).pcrf?.rawYaml?.pcrf;
    if (pcrfRaw?.freeDiameter) {
      descriptors.push({ nf: 'pcrf', label: 'PCRF', group: '4G', hostPorts: [{ proto: 'tcp', addr: '127.0.0.0/8', port: 3868, role: 'Diameter' }] });
    }
    const sgwcRaw: any = (all as any).sgwc?.rawYaml?.sgwc;
    if (sgwcRaw) {
      const hostPorts: PcapHostPort[] = [];
      const pfcp = rawServer(sgwcRaw.pfcp);
      if (pfcp?.address) hostPorts.push({ proto: 'udp', addr: pfcp.address, port: 8805, role: 'PFCP' });
      const gtpc = rawServer(sgwcRaw.gtpc);
      if (gtpc?.address) hostPorts.push({ proto: 'udp', addr: gtpc.address, port: 2123, role: 'GTP-C' });
      if (hostPorts.length) descriptors.push({ nf: 'sgwc', label: 'SGW-C', group: '4G', hostPorts });
    }
    const sgwuRaw: any = (all as any).sgwu?.rawYaml?.sgwu;
    if (sgwuRaw) {
      const hostPorts: PcapHostPort[] = [];
      const pfcp = rawServer(sgwuRaw.pfcp);
      if (pfcp?.address) hostPorts.push({ proto: 'udp', addr: pfcp.address, port: 8805, role: 'PFCP' });
      const gtpu = rawServer(sgwuRaw.gtpu);
      if (gtpu?.address) hostPorts.push({ proto: 'udp', addr: gtpu.address, port: 2152, role: 'GTP-U' });
      if (hostPorts.length) descriptors.push({ nf: 'sgwu', label: 'SGW-U', group: '4G', hostPorts });
    }

    // IMS — live saved config (outside IConfigRepository's scope).
    try {
      const ims = readCurrentImsConfig();
      if (ims) {
        descriptors.push({
          nf: 'ims', label: 'IMS (P/I/S-CSCF)', group: 'IMS',
          hostPorts: [
            { proto: 'udp', addr: ims.pcscfIp, port: ims.pcscfPort ?? 5060, role: 'P-CSCF SIP' },
            { proto: 'tcp', addr: ims.pcscfIp, port: ims.pcscfPort ?? 5060, role: 'P-CSCF SIP' },
            { proto: 'udp', addr: ims.icscfIp, port: ims.icscfPort ?? 4060, role: 'I-CSCF SIP' },
            { proto: 'udp', addr: ims.scscfIp, port: ims.scscfPort ?? 6060, role: 'S-CSCF SIP' },
            { proto: 'udp', addr: ims.rtpEngineIp, port: ims.rtpPortMin ?? 20000, role: 'RTP (range start)' },
          ],
        });
      }
    } catch (err) { this.logger.debug({ err: String(err) }, 'pcap: IMS descriptor unavailable'); }

    // VoWiFi — live saved state.
    try {
      const vw = loadVowifiState();
      if (vw.installStatus === 'complete' && vw.configured && vw.epdgIp) {
        descriptors.push({
          nf: 'vowifi', label: 'VoWiFi (ePDG)', group: 'VoWiFi',
          hostPorts: [
            { proto: 'udp', addr: vw.epdgIp, port: 500, role: 'IKEv2' },
            { proto: 'udp', addr: vw.epdgIp, port: 4500, role: 'IKEv2 NAT-T' },
            { proto: 'tcp', addr: vw.s6bLocalIp ?? '127.0.0.10', port: 3868, role: 'S6b Diameter' },
          ],
        });
      }
    } catch (err) { this.logger.debug({ err: String(err) }, 'pcap: VoWiFi descriptor unavailable'); }

    // SMS — live saved bind IPs, static well-known ports.
    try {
      const sms = readCurrentSmsConfig();
      if (sms) {
        descriptors.push({
          nf: 'sms', label: 'SMS (Osmocom SGs)', group: 'SMS',
          hostPorts: [
            { proto: 'sctp', addr: sms.mscBindIp, port: 29118, role: 'SGs' },
            { proto: 'tcp', addr: sms.hlrBindIp, port: 4222, role: 'GSUP' },
            { proto: 'sctp', addr: '127.0.0.0/8', port: 2905, role: 'M3UA' },
            { proto: 'sctp', addr: '127.0.0.0/8', port: 14001, role: 'SUA' },
          ],
        });
      }
    } catch (err) { this.logger.debug({ err: String(err) }, 'pcap: SMS descriptor unavailable'); }

    return descriptors;
  }

  presets(): DecodePreset[] {
    return DECODE_PRESETS;
  }

  // ── Scope → BPF ───────────────────────────────────────────────────────────
  private async buildScope(scope: CaptureScopeInput): Promise<{ bpf: string; description: string }> {
    if (scope.mode === 'all') return { bpf: '', description: 'Everything (no capture-time filter)' };
    if (scope.mode === 'gtpAll') return { bpf: 'udp port 2123 or udp port 2152', description: 'All GTP traffic (GTP-C + GTP-U)' };
    if (scope.mode === 'custom') {
      const bpf = (scope.customBpf ?? '').trim();
      rejectUnsafeBpf(bpf);
      return { bpf, description: `Custom BPF: ${bpf || '(empty)'}` };
    }

    let nfNames: string[];
    if (scope.mode === 'functionType') {
      nfNames = FUNCTION_TYPE_GROUPS[scope.functionType ?? ''] ?? [];
      if (nfNames.length === 0) throw new Error(`Unknown function type "${scope.functionType}"`);
    } else {
      nfNames = scope.nfs ?? [];
      if (nfNames.length === 0) throw new Error('At least one NF must be selected for "By NF" scope');
    }

    const descriptors = await this.buildNfDescriptors();
    const clauses: string[] = [];
    const labels: string[] = [];
    for (const nfName of nfNames) {
      const d = descriptors.find(x => x.nf === nfName);
      if (!d) continue;
      labels.push(d.label);
      // BPF's "host" primitive only accepts a single IP — a CIDR range (used
      // for the Diameter mesh's broad 127.0.0.0/8 placeholder, since a peer
      // could be at any loopback address) needs the "net" primitive instead,
      // or dumpcap rejects the whole filter as invalid at capture-start time.
      // Confirmed live (2026-07-19): selecting several NFs together (any
      // selection that includes a Diameter-bearing NF: mme/hss/pcrf/smf) blew
      // up with "That string isn't a valid capture filter (Mask syntax for
      // networks only)" — dumpcap exits immediately, which is what a
      // near-zero-duration capture in the history table actually means.
      const portClauses = d.hostPorts.map(hp => {
        const addrKeyword = hp.addr.includes('/') ? 'net' : 'host';
        return `(${addrKeyword} ${hp.addr} and ${hp.proto} port ${hp.port})`;
      });
      if (portClauses.length) clauses.push(`(${portClauses.join(' or ')})`);
    }
    if (clauses.length === 0) throw new Error('No live ports found for the selected NF(s) — is the module configured?');
    return { bpf: clauses.join(' or '), description: `By NF: ${labels.join(', ')}` };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private async ensureDir(): Promise<void> {
    await this.hostExecutor.createDirectory(PCAP_DIR);
  }

  private manifestPath(id: string): string { return `${PCAP_DIR}/${id}.json`; }
  private pcapPath(id: string): string { return `${PCAP_DIR}/${id}.pcapng`; }
  private unitName(id: string): string { return `${UNIT_PREFIX}${id}`; }

  private async saveManifest(m: PcapManifest): Promise<void> {
    await this.hostExecutor.writeFile(this.manifestPath(m.id), JSON.stringify(m, null, 2));
  }

  private async loadManifest(id: string): Promise<PcapManifest> {
    validateId(id);
    const raw = await this.hostExecutor.readFile(this.manifestPath(id));
    return JSON.parse(raw);
  }

  async start(input: { interfaces: string[]; scope: CaptureScopeInput; label?: string }): Promise<PcapManifest> {
    if (!input.interfaces || input.interfaces.length === 0) {
      throw new Error('At least one interface must be selected');
    }
    await this.ensureDir();

    const id = String(Date.now());
    const { bpf, description } = await this.buildScope(input.scope);
    const unitName = this.unitName(id);
    const pcapPath = this.pcapPath(id);

    // dumpcap quirk (confirmed live, 2026-07-19): with multiple -i flags, a single
    // trailing -f does NOT apply to any interface — the filter has to be repeated
    // immediately after EACH -i (dumpcap binds -f to whichever -i most recently
    // preceded it). Confirmed via a controlled test: the exact same filter string
    // captured everything unfiltered when given once at the end, and correctly
    // scoped when repeated per-interface.
    const dumpcapArgs: string[] = [];
    for (const iface of input.interfaces) {
      dumpcapArgs.push('-i', iface);
      if (bpf) dumpcapArgs.push('-f', bpf);
    }
    dumpcapArgs.push('-w', pcapPath);

    const manifest: PcapManifest = {
      id,
      label: input.label?.trim() || `Capture ${id}`,
      createdAt: new Date().toISOString(),
      interfaces: input.interfaces,
      scopeMode: input.scope.mode,
      scopeDescription: description,
      bpf,
      unitName,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };
    await this.saveManifest(manifest);

    const result = await this.hostExecutor.executeCommand('systemd-run', [
      `--unit=${unitName}`,
      '--collect',
      `--description=NMS packet capture ${id}`,
      '--',
      'dumpcap',
      ...dumpcapArgs,
    ]);
    if (result.exitCode !== 0) {
      manifest.status = 'failed';
      manifest.error = result.stderr || 'systemd-run failed to start dumpcap';
      await this.saveManifest(manifest);
      throw new Error(manifest.error);
    }

    manifest.status = 'running';
    await this.saveManifest(manifest);
    this.logger.info({ id, unitName, bpf, interfaces: input.interfaces }, 'pcap: capture started');
    return manifest;
  }

  async stop(id: string): Promise<PcapManifest> {
    const manifest = await this.loadManifest(id);
    if (manifest.status !== 'running') return manifest;

    manifest.status = 'stopping';
    await this.saveManifest(manifest);

    await this.hostExecutor.stopService(manifest.unitName);

    manifest.status = 'stopped';
    manifest.stoppedAt = new Date().toISOString();
    manifest.sizeBytes = await this.statSize(this.pcapPath(id));
    await this.saveManifest(manifest);
    this.logger.info({ id }, 'pcap: capture stopped');
    return manifest;
  }

  private async statSize(path: string): Promise<number | undefined> {
    try {
      const r = await this.hostExecutor.executeLocalCommand('stat', ['-c', '%s', path]);
      const n = parseInt(r.stdout.trim(), 10);
      return isNaN(n) ? undefined : n;
    } catch { return undefined; }
  }

  async listCaptures(): Promise<PcapManifest[]> {
    await this.ensureDir();
    let files: string[];
    try {
      files = await this.hostExecutor.listDirectory(PCAP_DIR);
    } catch { return []; }

    const ids = files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    const manifests: PcapManifest[] = [];
    for (const id of ids) {
      try {
        const m = await this.loadManifest(id);
        if (m.status === 'running') {
          const active = await this.hostExecutor.isServiceActive(m.unitName);
          if (!active) {
            m.status = 'stopped';
            m.stoppedAt = m.stoppedAt ?? new Date().toISOString();
            m.error = m.error ?? 'Capture process is no longer running (backend restart or host event) — file may be valid up to the last flush.';
            m.sizeBytes = await this.statSize(this.pcapPath(id));
            await this.saveManifest(m);
          } else {
            m.sizeBytes = await this.statSize(this.pcapPath(id));
          }
        }
        manifests.push(m);
      } catch (err) {
        this.logger.warn({ id, err: String(err) }, 'pcap: skipping unreadable manifest');
      }
    }
    return manifests.sort((a, b) => parseInt(b.id) - parseInt(a.id));
  }

  // Called once at backend boot — mirrors the reconciliation idiom used by
  // other bounded-action modules (e.g. VoWiFi's install-state reconciliation):
  // any capture still genuinely running (systemd-run survives a backend
  // container restart) is left alone; anything else is corrected.
  async reconcile(): Promise<void> {
    try {
      await this.listCaptures();
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'pcap: reconciliation failed');
    }
  }

  async getSummary(id: string): Promise<string> {
    validateId(id);
    // Missing DECODE_AS_ARGS here (unlike getPackets()) meant SBI traffic on
    // port 7777 never got bucketed under "http2" in the protocol hierarchy —
    // it fell back to generic tcp/data or a heuristic partial "http" guess,
    // which reads as "SBI wasn't captured" even though it genuinely was
    // (confirmed live, 2026-07-19: the same capture's getPackets() with an
    // http2 filter found dozens of real HEADERS/DATA frames the summary
    // view's hierarchy never labeled as such).
    const r = await this.hostExecutor.executeLocalCommand('tshark', ['-r', this.pcapPath(id), ...DECODE_AS_ARGS, '-q', '-z', 'io,phs'], 60000);
    if (r.exitCode !== 0) throw new Error(cleanTsharkStderr(r.stderr) || 'tshark failed to summarize capture');
    return r.stdout;
  }

  async getPackets(id: string, filter: string): Promise<{ rows: PacketRow[]; truncated: boolean }> {
    validateId(id);
    const args = ['-r', this.pcapPath(id), ...DECODE_AS_ARGS];
    if (filter && filter.trim()) args.push('-Y', filter);
    args.push(
      '-T', 'fields',
      '-e', 'frame.number', '-e', 'frame.time_epoch', '-e', 'ip.src', '-e', 'ip.dst',
      '-e', '_ws.col.Protocol', '-e', 'frame.len', '-e', '_ws.col.Info',
      '-E', 'separator=\t',
    );
    const r = await this.hostExecutor.executeLocalCommand('tshark', args, 120000);
    if (r.exitCode !== 0) throw new Error(cleanTsharkStderr(r.stderr) || 'tshark failed to decode capture (check the filter syntax)');

    const lines = r.stdout.split('\n').filter(l => l.length > 0);
    const truncated = lines.length > PACKET_ROW_LIMIT;
    const rows: PacketRow[] = lines.slice(0, PACKET_ROW_LIMIT).map(line => {
      const [frameNumber, timeEpoch, src, dst, protocol, length, ...infoParts] = line.split('\t');
      return {
        frameNumber: parseInt(frameNumber, 10) || 0,
        timeEpoch: parseFloat(timeEpoch) || 0,
        src: src ?? '',
        dst: dst ?? '',
        protocol: protocol ?? '',
        length: parseInt(length, 10) || 0,
        info: infoParts.join('\t'),
      };
    });
    return { rows, truncated };
  }

  // Single-packet detail view — mirrors Wireshark's own "Packet Details" (collapsible
  // proto/field tree, via PDML) + "Bytes" (offset/hex/ASCII dump, via -x) panes.
  // Scoping to one frame via -Y keeps both calls fast even against a large capture.
  async getPacketDetail(id: string, frameNumber: number): Promise<{ tree: PacketTreeNode[]; hex: string }> {
    validateId(id);
    if (!Number.isInteger(frameNumber) || frameNumber <= 0) {
      throw new Error(`Invalid frame number "${frameNumber}"`);
    }
    const frameFilter = `frame.number==${frameNumber}`;
    const [pdmlR, hexR] = await Promise.all([
      this.hostExecutor.executeLocalCommand(
        'tshark', ['-r', this.pcapPath(id), ...DECODE_AS_ARGS, '-Y', frameFilter, '-T', 'pdml'], 30000,
      ),
      this.hostExecutor.executeLocalCommand(
        'tshark', ['-r', this.pcapPath(id), ...DECODE_AS_ARGS, '-Y', frameFilter, '-x'], 30000,
      ),
    ]);
    if (pdmlR.exitCode !== 0) throw new Error(cleanTsharkStderr(pdmlR.stderr) || 'tshark failed to decode packet detail');
    if (!pdmlR.stdout.includes('<packet>')) throw new Error(`Frame ${frameNumber} not found in this capture`);

    const tree = parsePacketTree(pdmlR.stdout);
    // -x's output is "<one-line summary>\n<hex dump>" per packet — strip that
    // leading summary line since the tree above already covers it structurally.
    const hex = hexR.exitCode === 0 ? hexR.stdout.split('\n').slice(1).join('\n').trim() : '';
    return { tree, hex };
  }

  async getDownloadPath(id: string): Promise<string> {
    validateId(id);
    const p = this.pcapPath(id);
    if (!(await this.hostExecutor.fileExists(p))) throw new Error('Capture file not found');
    return p;
  }

  async deleteCapture(id: string): Promise<void> {
    const manifest = await this.loadManifest(id);
    if (manifest.status === 'running' || manifest.status === 'starting' || manifest.status === 'stopping') {
      throw new Error('Cannot delete a capture that is still running — stop it first');
    }
    await this.hostExecutor.executeLocalCommand('rm', ['-f', this.pcapPath(id), this.manifestPath(id)]);
    this.logger.info({ id }, 'pcap: capture deleted');
  }
}
