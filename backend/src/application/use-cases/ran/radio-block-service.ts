/**
 * Per-radio S1-MME/S1-U block via nftables — lets an operator take a radio
 * offline from the NMS side (severing its control/user-plane paths to the
 * core) without touching the radio itself.
 *
 * Unlike subscriber-ip-accounting.ts's UE traffic (which the UPF forwards
 * onward to the internet, genuinely FORWARD-hooked traffic), S1AP and GTP-U
 * from a radio terminate directly at MME's/UPF's own listening sockets on
 * this host — so these rules hook `input` (radio -> core) and `output`
 * (core -> radio) rather than `forward`. Blocking both directions makes the
 * block immediate and complete: without it, an already-ESTABLISHED SCTP
 * association would just sit half-open (this host still sending unanswered
 * heartbeats) rather than being severed right away.
 *
 * Rules live in a dedicated table (`inet open5gs_nms_radio_block`) so this
 * never touches auto-config.ts's NAT rules or subscriber-ip-accounting.ts's
 * own table.
 *
 * Desired state (which IPs are blocked) is persisted in SQLite
 * (radio_blocks table) rather than trusted to nftables alone — nftables
 * rules live only in the kernel and are wiped on a host reboot (this
 * project has already seen unattended-upgrades trigger one), so a reconcile
 * loop is needed to re-apply blocks that should still be active.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { SqliteRadioBlockRepository } from '../../../infrastructure/auth/sqlite-radio-block-repository';

const TABLE = 'open5gs_nms_radio_block';
const CHAIN_IN = 'radio_block_in';
const CHAIN_OUT = 'radio_block_out';

const S1AP_PORT = 36412; // SCTP — S1-MME (radio<->MME control plane)
const GTPU_PORT = 2152;  // UDP — S1-U (radio<->UPF user plane)

function commentFor(ip: string): string {
  return `radio_block_${ip}`;
}

export class RadioBlockService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly repo: SqliteRadioBlockRepository,
    private readonly logger: pino.Logger,
  ) {}

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'radio-block: initial reconcile failed'));
    this.timer = setInterval(() => {
      this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'radio-block: reconcile failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async ensureBaseline(): Promise<void> {
    await this.hostExecutor.executeCommand('nft', ['add', 'table', 'inet', TABLE]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'chain', 'inet', TABLE, CHAIN_IN,
      '{', 'type', 'filter', 'hook', 'input', 'priority', 'filter', ';', 'policy', 'accept', ';', '}',
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'chain', 'inet', TABLE, CHAIN_OUT,
      '{', 'type', 'filter', 'hook', 'output', 'priority', 'filter', ';', 'policy', 'accept', ';', '}',
    ]);
  }

  /** Which IPs currently have block rules installed, per chain, keyed by nftables rule handle. */
  private async listInstalled(): Promise<{ chain: string; handle: number; ip: string }[]> {
    const result = await this.hostExecutor.executeCommand('nft', ['-j', 'list', 'table', 'inet', TABLE]);
    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    const rules: { chain: string; handle: number; ip: string }[] = [];
    for (const entry of parsed?.nftables ?? []) {
      const rule = entry?.rule;
      if (!rule?.comment || typeof rule.handle !== 'number') continue;
      const m = /^radio_block_(.+)$/.exec(rule.comment);
      if (!m) continue;
      rules.push({ chain: rule.chain, handle: rule.handle, ip: m[1] });
    }
    return rules;
  }

  private async addRulesForIp(ip: string): Promise<void> {
    // Inbound: radio -> this host, on either interface's own listening port.
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_IN,
      'ip', 'saddr', ip, 'sctp', 'dport', String(S1AP_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_IN,
      'ip', 'saddr', ip, 'udp', 'dport', String(GTPU_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
    // Outbound: this host -> radio, from either interface's own listening port —
    // severs an already-established association instead of leaving it half-open.
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_OUT,
      'ip', 'daddr', ip, 'sctp', 'sport', String(S1AP_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_OUT,
      'ip', 'daddr', ip, 'udp', 'sport', String(GTPU_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
  }

  private async removeRulesForIp(ip: string, installed: { chain: string; handle: number; ip: string }[]): Promise<void> {
    for (const r of installed.filter(r => r.ip === ip)) {
      await this.hostExecutor.executeCommand('nft', ['delete', 'rule', 'inet', TABLE, r.chain, 'handle', String(r.handle)])
        .catch(err => this.logger.warn({ err: String(err), ip, handle: r.handle }, 'radio-block: failed to delete stale rule'));
    }
  }

  private async reconcile(): Promise<void> {
    await this.ensureBaseline();
    const installed = await this.listInstalled();
    const installedIps = new Set(installed.map(r => r.ip));
    const desired = new Set(this.repo.getAll().map(b => b.ip));

    for (const ip of installedIps) {
      if (!desired.has(ip)) await this.removeRulesForIp(ip, installed);
    }
    for (const ip of desired) {
      if (!installedIps.has(ip)) {
        await this.addRulesForIp(ip).catch(err =>
          this.logger.warn({ err: String(err), ip }, 'radio-block: failed to add block rules'));
      }
    }
  }

  async listBlocked(): Promise<{ ip: string; blockedBy: string; blockedAt: number }[]> {
    return this.repo.getAll();
  }

  async block(ip: string, blockedBy: string): Promise<void> {
    this.repo.add(ip, blockedBy);
    await this.reconcile();
  }

  async unblock(ip: string): Promise<void> {
    this.repo.remove(ip);
    await this.reconcile();
  }
}
