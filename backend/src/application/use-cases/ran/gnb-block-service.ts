/**
 * Per-gNodeB N2/N3 block via nftables — the 5G equivalent of radio-block-service.ts's
 * 4G S1-MME/S1-U block. Same shape, but NOT the same ports: N2 (NGAP) is SCTP 38412,
 * distinct from S1-MME's SCTP 36412 — this is a genuinely different control-plane
 * interface, not a renamed one. N3 (GTP-U) is UDP 2152, the SAME port number S1-U uses,
 * but that's not a conflict here: rules are scoped by `ip saddr <radio-ip>`, and a real
 * eNodeB and a real gNodeB are always different physical devices with different IPs —
 * N3 traffic from a gNodeB's IP was never matched by the 4G table's eNodeB-scoped rules,
 * and vice versa. Also, N3 terminates at UPF's own GTP-U socket, S1-U at SGW-U's own
 * socket — two separate Open5GS processes even when both listen on :2152.
 *
 * Own dedicated nftables table (`inet open5gs_nms_gnb_block`), per CLAUDE.md pattern #11
 * ("give it its own table rather than sharing this one") — never reuses
 * open5gs_nms_radio_block, even though the underlying mechanism is identical.
 *
 * Desired state persisted in SQLite (gnb_blocks table) for the same reason as the 4G
 * version: nftables rules live only in the kernel and are wiped on reboot, so a reconcile
 * loop re-applies blocks that should still be active.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { SqliteGnbBlockRepository } from '../../../infrastructure/auth/sqlite-gnb-block-repository';

const TABLE = 'open5gs_nms_gnb_block';
const CHAIN_IN = 'gnb_block_in';
const CHAIN_OUT = 'gnb_block_out';

const NGAP_PORT = 38412; // SCTP — N2 (gNodeB<->AMF control plane)
const GTPU_PORT = 2152;  // UDP — N3 (gNodeB<->UPF user plane)

function commentFor(ip: string): string {
  return `gnb_block_${ip}`;
}

export class GnbBlockService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly repo: SqliteGnbBlockRepository,
    private readonly logger: pino.Logger,
  ) {}

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'gnb-block: initial reconcile failed'));
    this.timer = setInterval(() => {
      this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'gnb-block: reconcile failed'));
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
      const m = /^gnb_block_(.+)$/.exec(rule.comment);
      if (!m) continue;
      rules.push({ chain: rule.chain, handle: rule.handle, ip: m[1] });
    }
    return rules;
  }

  private async addRulesForIp(ip: string): Promise<void> {
    // Inbound: gNodeB -> this host, on either interface's own listening port.
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_IN,
      'ip', 'saddr', ip, 'sctp', 'dport', String(NGAP_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_IN,
      'ip', 'saddr', ip, 'udp', 'dport', String(GTPU_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
    // Outbound: this host -> gNodeB, from either interface's own listening port —
    // severs an already-established association instead of leaving it half-open.
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_OUT,
      'ip', 'daddr', ip, 'sctp', 'sport', String(NGAP_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN_OUT,
      'ip', 'daddr', ip, 'udp', 'sport', String(GTPU_PORT), 'drop', 'comment', JSON.stringify(commentFor(ip)),
    ]);
  }

  private async removeRulesForIp(ip: string, installed: { chain: string; handle: number; ip: string }[]): Promise<void> {
    for (const r of installed.filter(r => r.ip === ip)) {
      await this.hostExecutor.executeCommand('nft', ['delete', 'rule', 'inet', TABLE, r.chain, 'handle', String(r.handle)])
        .catch(err => this.logger.warn({ err: String(err), ip, handle: r.handle }, 'gnb-block: failed to delete stale rule'));
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
          this.logger.warn({ err: String(err), ip }, 'gnb-block: failed to add block rules'));
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
