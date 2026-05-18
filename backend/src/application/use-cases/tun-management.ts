import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';

export interface TunInterface {
  name: string;
  ip: string;
  prefix: number;
  state: 'up' | 'down';
  managed: boolean;
  default: boolean;
  exists: boolean;
}

export interface TunCreateInput { name: string; ip: string; prefix: number; }
export interface TunEditInput   { ip: string;  prefix: number; }

const SYSTEMD_DIR = '/etc/systemd/system';

function validateName(name: string): void {
  if (!/^ogstun[0-9]+$/.test(name))
    throw new Error(`Invalid name "${name}". Must match ogstun[0-9]+ (e.g. ogstun2).`);
}
function validateIp(ip: string): void {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip))
    throw new Error(`Invalid IP "${ip}".`);
}
function validatePrefix(p: number): void {
  if (p < 1 || p > 32) throw new Error(`Invalid prefix ${p}. Must be 1-32.`);
}

// Systemd oneshot service — persists the TUN across reboots.
// ip addr add on a TUN without an open fd works fine; the address sticks
// at the kernel level. The interface just shows NO-CARRIER until a process
// opens it (Open5GS UPF via dev: in config).
function serviceContent(name: string, ip: string, prefix: number): string {
  return [
    '# Managed by open5gs-nms — do not edit manually',
    '[Unit]',
    `Description=TUN interface ${name} for Open5GS multi-APN`,
    'After=network-pre.target',
    'Before=network.target',
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=/sbin/ip tuntap add name ${name} mode tun`,
    `ExecStart=/sbin/ip addr add ${ip}/${prefix} dev ${name}`,
    `ExecStart=/sbin/ip link set ${name} up`,
    `ExecStop=/sbin/ip link set ${name} down`,
    `ExecStop=/sbin/ip link delete ${name}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function serviceName(ifaceName: string): string {
  return `open5gs-tun-${ifaceName}.service`;
}

export class TunManagementUseCase {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
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

  // Check systemd is available (used for persistence via oneshot services)
  async checkNetworkdActive(): Promise<boolean> {
    try {
      const r = await this.hostExecutor.executeCommand('systemctl', ['is-system-running']);
      const state = r.stdout.trim();
      return state === 'running' || state === 'degraded'; // degraded still works
    } catch { return false; }
  }

  async list(): Promise<TunInterface[]> {
    const [linkR, addrR] = await Promise.all([
      this.ipNet('-o link show'),
      this.ipNet('-o addr show'),
    ]);

    // Parse link — detect UP from flags field, not "state" keyword.
    // TUN interfaces always show "state DOWN" due to NO-CARRIER even when UP flag is set.
    const stateMap = new Map<string, 'up' | 'down'>();
    for (const line of linkR.stdout.split('\n')) {
      const m = line.match(/^\d+:\s+(ogstun[^:@\s]*)/);
      if (!m) continue;
      const flagsMatch = line.match(/<([^>]+)>/);
      const flags = flagsMatch ? flagsMatch[1].split(',') : [];
      stateMap.set(m[1], flags.includes('UP') ? 'up' : 'down');
    }

    // Parse addr: IPv4 assignments
    const addrMap = new Map<string, { ip: string; prefix: number }>();
    for (const line of addrR.stdout.split('\n')) {
      const m = line.match(/^\d+:\s+(ogstun[^\s]*)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
      if (!m) continue;
      addrMap.set(m[1], { ip: m[2], prefix: parseInt(m[3]) });
    }

    // NMS-managed: check for our systemd service files
    const managedNames = new Set<string>();
    try {
      const out = await this.hostFs(
        `ls ${SYSTEMD_DIR}/open5gs-tun-ogstun*.service 2>/dev/null | sed 's/.*open5gs-tun-//; s/\\.service//' || true`,
      );
      for (const n of out.split('\n').map(s => s.trim()).filter(Boolean)) managedNames.add(n);
    } catch {}

    const allNames = new Set<string>([...stateMap.keys(), ...managedNames, 'ogstun']);
    return [...allNames].sort().map(name => ({
      name,
      ip:      addrMap.get(name)?.ip     || '',
      prefix:  addrMap.get(name)?.prefix || 0,
      state:   stateMap.get(name) || 'down',
      managed: managedNames.has(name),
      default: name === 'ogstun',
      exists:  stateMap.has(name),
    }));
  }

  async create(input: TunCreateInput): Promise<void> {
    validateName(input.name); validateIp(input.ip); validatePrefix(input.prefix);
    const { name, ip, prefix } = input;
    this.logger.info({ name, ip, prefix }, 'Creating TUN interface');

    // Write systemd service for persistence across reboots
    const svcPath = `${SYSTEMD_DIR}/${serviceName(name)}`;
    await this.writeHostFile(svcPath, serviceContent(name, ip, prefix));

    // Enable so it starts at boot
    await this.hostFs(`systemctl daemon-reload && systemctl enable ${serviceName(name)}`);

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
    if (name === 'ogstun') throw new Error('Cannot edit default ogstun — managed by Open5GS.');
    validateName(name); validateIp(input.ip); validatePrefix(input.prefix);
    const { ip, prefix } = input;
    this.logger.info({ name, ip, prefix }, 'Editing TUN interface');

    // Update service file
    const svcPath = `${SYSTEMD_DIR}/${serviceName(name)}`;
    await this.writeHostFile(svcPath, serviceContent(name, ip, prefix));
    await this.hostFs('systemctl daemon-reload');

    // Apply live
    await this.ipNet(`addr flush dev ${name} 2>/dev/null || true`);
    await this.ipNet(`addr add ${ip}/${prefix} dev ${name}`);
    this.logger.info({ name }, 'TUN interface updated');
  }

  async delete(name: string): Promise<void> {
    if (name === 'ogstun') throw new Error('Cannot delete default ogstun — managed by Open5GS.');
    validateName(name);
    this.logger.info({ name }, 'Deleting TUN interface');

    // Disable and remove service
    const svc = serviceName(name);
    await this.hostFs(`systemctl disable --now ${svc} 2>/dev/null || true`);
    await this.hostFs(`rm -f ${SYSTEMD_DIR}/${svc}`);
    await this.hostFs('systemctl daemon-reload');

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
}
