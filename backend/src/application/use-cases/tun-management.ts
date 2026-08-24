import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { parseIpLinkAddr } from '../../infrastructure/network/ip-link-parser';
import { resolveDnnDevPairs } from '../../domain/services/dnn-dev-resolver';

export interface TunInterface {
  name: string;
  ip: string;
  prefix: number;
  state: 'up' | 'down';
  managed: boolean;
  default: boolean;
  exists: boolean;
  // Declared in upf.yaml's session list (whether ogstun-pattern or custom-named) —
  // Open5GS UPF creates/owns this device, distinct from `managed` (NMS-created via
  // this page's own .netdev files) and from a genuinely manual, UPF-unaware
  // interface. See #29: custom-named upf.yaml devices used to be invisible on this
  // page entirely because only ogstun/ogstun<N>-pattern names were ever recognized.
  fromUpfConfig: boolean;
  dnn: string | null;
  subnet: string | null;
}

export interface TunCreateInput { name: string; ip: string; prefix: number; }
export interface TunEditInput   { ip: string;  prefix: number; }

const NETWORKD_DIR = '/etc/systemd/network';
const NMS_PREFIX   = '10-nms-';

// Valid Linux interface name: starts with a letter, 1–15 chars, letters/digits/hyphen/underscore.
function validateName(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/.test(name))
    throw new Error(`Invalid interface name "${name}". Must start with a letter, max 15 chars, letters/digits/hyphen/underscore only.`);
}
function validateIp(ip: string): void {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip))
    throw new Error(`Invalid IP "${ip}".`);
}
function validatePrefix(p: number): void {
  if (p < 1 || p > 32) throw new Error(`Invalid prefix ${p}. Must be 1-32.`);
}

// systemd-networkd .netdev — creates the TUN device at boot.
function netdevContent(name: string): string {
  return [
    '# Managed by open5gs-nms — do not edit manually',
    '[NetDev]',
    `Name=${name}`,
    'Kind=tun',
    '',
  ].join('\n');
}

// systemd-networkd .network — assigns the IP address.
function networkContent(name: string, ip: string, prefix: number): string {
  return [
    '# Managed by open5gs-nms — do not edit manually',
    '[Match]',
    `Name=${name}`,
    '',
    '[Network]',
    `Address=${ip}/${prefix}`,
    '',
  ].join('\n');
}

function netdevPath(name: string):  string { return `${NETWORKD_DIR}/${NMS_PREFIX}${name}.netdev`; }
function networkPath(name: string): string { return `${NETWORKD_DIR}/${NMS_PREFIX}${name}.network`; }

export class TunManagementUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
    private readonly configRepo: IConfigRepository,
  ) {}

  // ── ipNet: ip commands in PID 1's network namespace ────────────────────────
  private async ipNet(args: string): Promise<{ stdout: string; stderr: string }> {
    const cmd = `nsenter --net=/proc/1/ns/net /sbin/ip ${args}`;
    this.logger.info({ cmd }, 'ipNet');
    const r = await this.hostExecutor.executeLocalCommand('bash', ['-c', cmd]);
    this.logger.info({ stdout: r.stdout.trim(), stderr: r.stderr.trim(), exitCode: r.exitCode }, 'ipNet result');
    return r;
  }

  // ── hostFs: commands in HOST mount namespace (for file writes, systemctl) ──
  private async hostFs(cmd: string): Promise<string> {
    const r = await this.hostExecutor.executeCommand('bash', ['-c', cmd]);
    this.logger.debug({ cmd, stdout: r.stdout.trim(), stderr: r.stderr.trim() }, 'hostFs');
    return r.stdout;
  }

  // Write file to host filesystem via base64
  private async writeHostFile(filePath: string, content: string): Promise<void> {
    const b64 = Buffer.from(content).toString('base64');
    await this.hostFs(`echo '${b64}' | base64 -d > ${filePath}`);
  }

  // Check systemd-networkd is active (required for .netdev/.network persistence)
  async checkNetworkdActive(): Promise<boolean> {
    try {
      const r = await this.hostExecutor.executeCommand('systemctl', ['is-active', 'systemd-networkd']);
      return r.stdout.trim() === 'active';
    } catch { return false; }
  }

  async list(): Promise<TunInterface[]> {
    const [linkR, addrR] = await Promise.all([
      // Use `ip link show` without `type tun` — older kernels (pre-5.x) don't
      // populate IFLA_INFO_KIND for TUN devices, so `type tun` returns nothing
      // even when ogstun is live. We filter to only names we care about below.
      this.ipNet('-o link show'),
      this.ipNet('-o addr show'),
    ]);

    // Shared parsing (backend/src/infrastructure/network/ip-link-parser.ts) —
    // returns every interface unfiltered; this method applies its own
    // ogstun-only/managed filtering on top below.
    const parsed = parseIpLinkAddr(linkR.stdout, addrR.stdout);
    const stateMap = new Map(parsed.map(i => [i.name, i.state]));
    const addrMap = new Map(parsed.map(i => [i.name, { ip: i.ip, prefix: i.prefix }]));

    // NMS-managed: detect from .netdev files written by this NMS
    const managedNames = new Set<string>();
    try {
      const out = await this.hostFs(
        `ls ${NETWORKD_DIR}/${NMS_PREFIX}*.netdev 2>/dev/null | sed 's|.*/||; s|^${NMS_PREFIX}||; s|\\.netdev$||' || true`,
      );
      for (const n of out.split('\n').map(s => s.trim()).filter(Boolean)) managedNames.add(n);
    } catch {}

    // upf.yaml's session[].dev is the authoritative list of devices Open5GS UPF
    // actually uses — not just ogstun/ogstun<N>-pattern names (#29: a custom-named
    // dev, e.g. `dev: ptt` for a non-default DNN, is just as real and just as
    // Open5GS-owned as ogstun2, but was previously invisible on this page entirely).
    const [smf, upf] = await Promise.all([
      this.configRepo.loadSmf().catch(() => ({} as any)),
      this.configRepo.loadUpf().catch(() => ({} as any)),
    ]);
    const smfSessions = ((smf as any).session ?? []) as any[];
    const upfSessions = ((upf as any).session ?? []) as any[];
    const upfConfigDevs = new Set<string>(upfSessions.map((s) => s?.dev || 'ogstun'));

    // dev -> {dnn, subnet} for the "APN / Pool" column, sourced server-side from the
    // same smf.yaml/upf.yaml join #28 already fixed once — see dnn-dev-resolver.ts.
    const devInfo = new Map<string, { dnn: string; subnet: string | null }>();
    for (const { dnn, dev, subnet } of resolveDnnDevPairs(smfSessions, upfSessions)) {
      devInfo.set(dev, { dnn, subnet });
    }

    // Display: NMS-managed interfaces + any ogstun* present on the system + every
    // dev declared in upf.yaml's own session config
    // (Open5GS UPF and the IMS configure step create ogstun2, ogstun3, etc. outside NMS)
    const allNames = new Set<string>([...managedNames, ...upfConfigDevs]);
    for (const name of stateMap.keys()) {
      if (name === 'ogstun' || /^ogstun\d+$/.test(name)) allNames.add(name);
    }
    // Always include ogstun even if UPF isn't running yet
    allNames.add('ogstun');

    return [...allNames].sort().map(name => ({
      name,
      ip:      addrMap.get(name)?.ip     || '',
      prefix:  addrMap.get(name)?.prefix || 0,
      state:   stateMap.get(name) || 'down',
      managed: managedNames.has(name),
      default: name === 'ogstun',
      exists:  stateMap.has(name),
      fromUpfConfig: upfConfigDevs.has(name),
      dnn:     devInfo.get(name)?.dnn ?? null,
      subnet:  devInfo.get(name)?.subnet ?? null,
    }));
  }

  async create(input: TunCreateInput): Promise<void> {
    validateName(input.name); validateIp(input.ip); validatePrefix(input.prefix);
    const { name, ip, prefix } = input;
    this.logger.info({ name, ip, prefix }, 'Creating TUN interface');

    // Write .netdev + .network pair for persistence across reboots
    await this.writeHostFile(netdevPath(name),  netdevContent(name));
    await this.writeHostFile(networkPath(name), networkContent(name, ip, prefix));
    await this.hostFs('networkctl reload 2>/dev/null || true');

    // Apply live: delete if exists, create fresh, assign IP, bring up
    await this.ipNet(`link delete ${name} 2>/dev/null || true`);
    await this.ipNet(`tuntap add name ${name} mode tun`);
    await this.ipNet(`addr add ${ip}/${prefix} dev ${name}`);
    await this.ipNet(`link set ${name} up`);

    const verify = await this.ipNet(`addr show dev ${name}`);
    this.logger.info({ name, verifyOutput: verify.stdout.trim() }, 'TUN verify');
    this.logger.info({ name, ip, prefix }, 'TUN interface created successfully');
  }

  async edit(name: string, input: TunEditInput): Promise<void> {
    validateName(name); validateIp(input.ip); validatePrefix(input.prefix);
    const { ip, prefix } = input;
    this.logger.info({ name, ip, prefix }, 'Editing TUN interface');

    // Rewrite .network file with updated address
    await this.writeHostFile(networkPath(name), networkContent(name, ip, prefix));
    await this.hostFs('networkctl reload 2>/dev/null || true');

    // Apply live
    await this.ipNet(`addr flush dev ${name} 2>/dev/null || true`);
    await this.ipNet(`addr add ${ip}/${prefix} dev ${name}`);
    this.logger.info({ name }, 'TUN interface updated');
  }

  async delete(name: string): Promise<void> {
    if (name === 'ogstun') throw new Error('Cannot delete default ogstun — managed by Open5GS.');
    validateName(name);
    this.logger.info({ name }, 'Deleting TUN interface');

    // Remove .netdev + .network pair and reload networkd
    await this.hostFs(`rm -f ${netdevPath(name)} ${networkPath(name)}`);
    await this.hostFs('networkctl reload 2>/dev/null || true');

    // Remove live interface
    await this.ipNet(`link set ${name} down 2>/dev/null || true`);
    await this.ipNet(`link delete ${name} 2>/dev/null || true`);
    this.logger.info({ name }, 'TUN interface deleted');
  }

  async setUp(name: string): Promise<void> {
    this.logger.info({ name }, 'Bringing up');
    await this.ipNet(`link set ${name} up`);
  }

  async setDown(name: string): Promise<void> {
    this.logger.info({ name }, 'Bringing down');
    await this.ipNet(`link set ${name} down`);
  }

  async suggestNextName(): Promise<string> {
    const existing = new Set((await this.list()).map(i => i.name));
    for (let n = 2; n <= 99; n++) {
      if (!existing.has(`ogstun${n}`)) return `ogstun${n}`;
    }
    return 'ogstun2';
  }

  // ── Static routes (e.g. Framed Routing subnets behind a UE) ────────────────
  // Idempotent: safe to call repeatedly for the same cidr/dev.
  async addRoute(cidr: string, dev: string): Promise<void> {
    const family = cidr.includes(':') ? '-6' : '-4';
    await this.ipNet(`${family} route del ${cidr} dev ${dev} 2>/dev/null || true`);
    await this.ipNet(`${family} route add ${cidr} dev ${dev}`);
    this.logger.info({ cidr, dev }, 'Static route added');
  }

  async removeRoute(cidr: string, dev: string): Promise<void> {
    const family = cidr.includes(':') ? '-6' : '-4';
    await this.ipNet(`${family} route del ${cidr} dev ${dev} 2>/dev/null || true`);
    this.logger.info({ cidr, dev }, 'Static route removed');
  }
}
