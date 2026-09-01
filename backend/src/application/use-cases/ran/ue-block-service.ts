/**
 * Per-UE data-plane block via nftables — the persistent "stay blocked" half
 * of the UE block/detach feature (the other half, the immediate real
 * detach, is ue-detach-runner.ts's Cancel-Location-Request). Open5GS's own
 * MME never enforces any subscription-level barring AVP it sends toward the
 * UE (confirmed live 2026-08-31: no reference to operator_determined_barring
 * or subscriber_status anywhere in src/mme/), so there is no reliable way to
 * make the core itself refuse a re-attach — instead, this blackholes the
 * UE's own Framed-IP-Address at the forward hook (same hook as
 * subscriber-ip-accounting.ts's counters — UE traffic is genuinely
 * forwarded onward through the UPF, unlike radio-block-service.ts's
 * input/output-terminated S1AP/GTP-U) so that even if the UE reconnects,
 * its traffic goes nowhere until explicitly unblocked.
 *
 * Blocked state is keyed by IMSI, not IP — a re-attached UE can be handed a
 * different Framed-IP-Address than it had when blocked, so each reconcile
 * pass re-resolves the current IP from GetInterfaceStatus's live UE list
 * and moves the nftables rule if it changed, rather than trusting a
 * snapshot taken at block time.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { SqliteUeBlockRepository } from '../../../infrastructure/auth/sqlite-ue-block-repository';
import { GetInterfaceStatus } from '../interface-status/get-interface-status';

const TABLE = 'open5gs_nms_ue_block';
const CHAIN = 'ue_block_fwd';

function commentFor(imsi: string): string {
  return `ue_block_${imsi}`;
}

export class UeBlockService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly repo: SqliteUeBlockRepository,
    private readonly getInterfaceStatus: GetInterfaceStatus,
    private readonly logger: pino.Logger,
  ) {}

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'ue-block: initial reconcile failed'));
    this.timer = setInterval(() => {
      this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'ue-block: reconcile failed'));
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
      'add', 'chain', 'inet', TABLE, CHAIN,
      '{', 'type', 'filter', 'hook', 'forward', 'priority', 'filter', ';', 'policy', 'accept', ';', '}',
    ]);
  }

  /** Which IMSIs currently have block rules installed, per IP, keyed by nftables rule handle. */
  private async listInstalled(): Promise<{ handle: number; imsi: string }[]> {
    const result = await this.hostExecutor.executeCommand('nft', ['-j', 'list', 'table', 'inet', TABLE]);
    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    const rules: { handle: number; imsi: string }[] = [];
    for (const entry of parsed?.nftables ?? []) {
      const rule = entry?.rule;
      if (!rule?.comment || typeof rule.handle !== 'number') continue;
      const m = /^ue_block_(.+)$/.exec(rule.comment);
      if (!m) continue;
      rules.push({ handle: rule.handle, imsi: m[1] });
    }
    return rules;
  }

  private async addRulesForIp(imsi: string, ip: string): Promise<void> {
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN,
      'ip', 'saddr', ip, 'drop', 'comment', JSON.stringify(commentFor(imsi)),
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN,
      'ip', 'daddr', ip, 'drop', 'comment', JSON.stringify(commentFor(imsi)),
    ]);
  }

  private async removeRulesForImsi(imsi: string, installed: { handle: number; imsi: string }[]): Promise<void> {
    for (const r of installed.filter(r => r.imsi === imsi)) {
      await this.hostExecutor.executeCommand('nft', ['delete', 'rule', 'inet', TABLE, CHAIN, 'handle', String(r.handle)])
        .catch(err => this.logger.warn({ err: String(err), imsi, handle: r.handle }, 'ue-block: failed to delete stale rule'));
    }
  }

  private async reconcile(): Promise<void> {
    await this.ensureBaseline();
    const installed = await this.listInstalled();
    const installedImsis = new Set(installed.map(r => r.imsi));
    const desired = this.repo.getAll();
    const desiredImsis = new Set(desired.map(b => b.imsi));

    for (const imsi of installedImsis) {
      if (!desiredImsis.has(imsi)) await this.removeRulesForImsi(imsi, installed);
    }

    let currentIpByImsi = new Map<string, string>();
    try {
      const status = await this.getInterfaceStatus.execute();
      for (const ue of [...status.activeUEs4G, ...status.activeUEs5G]) {
        if (ue.imsi && ue.ip) currentIpByImsi.set(ue.imsi, ue.ip);
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'ue-block: failed to resolve current UE IPs, using last-known only');
    }

    for (const b of desired) {
      const currentIp = currentIpByImsi.get(b.imsi) ?? b.lastIp ?? null;
      if (!currentIp) continue; // never seen an IP for this UE yet — nothing to block

      const needsInstall = !installedImsis.has(b.imsi) || currentIp !== b.lastIp;
      if (needsInstall) {
        if (installedImsis.has(b.imsi)) await this.removeRulesForImsi(b.imsi, installed);
        await this.addRulesForIp(b.imsi, currentIp).catch(err =>
          this.logger.warn({ err: String(err), imsi: b.imsi, ip: currentIp }, 'ue-block: failed to add block rules'));
        this.repo.setLastIp(b.imsi, currentIp);
      }
    }
  }

  async listBlocked(): Promise<{ imsi: string; lastIp: string | null; blockedBy: string; blockedAt: number }[]> {
    return this.repo.getAll();
  }

  async block(imsi: string, blockedBy: string): Promise<void> {
    this.repo.add(imsi, blockedBy);
    await this.reconcile();
  }

  async unblock(imsi: string): Promise<void> {
    this.repo.remove(imsi);
    await this.reconcile();
  }
}
