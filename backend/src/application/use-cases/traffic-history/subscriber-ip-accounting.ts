/**
 * Per-subscriber traffic accounting via nftables counters.
 *
 * The UPF's tun devices only give an aggregate byte count (GtpBandwidthMonitor) —
 * there's no per-IP breakdown available from the interface itself. To get a
 * per-subscriber view we install one pair of nftables counter rules (up/down)
 * per subscriber UE IPv4 address, tagged with a comment encoding the IMSI so
 * counters can be read back and correlated without a separate lookup table.
 *
 * Rules live in a dedicated table/chain (`inet open5gs_nms_acct` /
 * `acct_fwd`, hooked on `forward`) so this never touches the NAT/filter rules
 * `auto-config.ts` manages elsewhere. Matching is by UE IP alone (the
 * open5gs session pool, e.g. 10.45.0.0/16) — precise enough on its own since
 * no other host traffic uses those addresses, so no interface matching is
 * needed.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { ISubscriberRepository } from '../../../domain/interfaces/subscriber-repository';

const TABLE = 'open5gs_nms_acct';
const CHAIN = 'acct_fwd';

export interface SubscriberByteCounters {
  imsi: string;
  upBytes: number;
  downBytes: number;
}

interface InstalledRule {
  handle: number;
  direction: 'up' | 'down';
  imsi: string;
  ip: string;
}

function commentFor(direction: 'up' | 'down', imsi: string): string {
  return `${direction}_${imsi}`;
}

export class SubscriberIpAccounting {
  private timer: NodeJS.Timeout | null = null;
  // ip -> imsi for whichever rules are currently installed
  private installedIps: Map<string, string> = new Map();

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly logger: pino.Logger,
  ) {}

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'nftables accounting: initial reconcile failed'));
    this.timer = setInterval(() => {
      this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'nftables accounting: reconcile failed'));
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

  private async listRules(): Promise<InstalledRule[]> {
    const result = await this.hostExecutor.executeCommand('nft', ['-j', 'list', 'table', 'inet', TABLE]);
    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    const rules: InstalledRule[] = [];
    for (const entry of parsed?.nftables ?? []) {
      const rule = entry?.rule;
      if (!rule?.comment || typeof rule.handle !== 'number') continue;
      const m = /^(up|down)_(.+)$/.exec(rule.comment);
      if (!m) continue;
      const ipMatch = (rule.expr ?? []).find((e: any) => e?.match?.left?.payload?.field === (m[1] === 'up' ? 'saddr' : 'daddr'));
      const ip = ipMatch?.match?.right;
      if (typeof ip !== 'string') continue;
      rules.push({ handle: rule.handle, direction: m[1] as 'up' | 'down', imsi: m[2], ip });
    }
    return rules;
  }

  private async getDesiredIps(): Promise<Map<string, string>> {
    const subscribers = await this.subscriberRepo.findAllFull();
    const desired = new Map<string, string>();
    for (const sub of subscribers) {
      for (const slice of sub.slice ?? []) {
        for (const session of slice.session ?? []) {
          const ip = session.ue?.ipv4;
          if (ip) desired.set(ip, sub.imsi);
        }
      }
    }
    return desired;
  }

  private async addRulePair(ip: string, imsi: string): Promise<void> {
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN,
      'ip', 'saddr', ip, 'counter', 'comment', JSON.stringify(commentFor('up', imsi)),
    ]);
    await this.hostExecutor.executeCommand('nft', [
      'add', 'rule', 'inet', TABLE, CHAIN,
      'ip', 'daddr', ip, 'counter', 'comment', JSON.stringify(commentFor('down', imsi)),
    ]);
  }

  private async deleteRule(handle: number): Promise<void> {
    await this.hostExecutor.executeCommand('nft', ['delete', 'rule', 'inet', TABLE, CHAIN, 'handle', String(handle)]);
  }

  private async reconcile(): Promise<void> {
    await this.ensureBaseline();
    const installedRules = await this.listRules();
    const desired = await this.getDesiredIps();

    // Group installed rules by ip so we can detect IMSI mismatches (IP reassignment).
    const installedByIp = new Map<string, InstalledRule[]>();
    for (const r of installedRules) {
      const list = installedByIp.get(r.ip) ?? [];
      list.push(r);
      installedByIp.set(r.ip, list);
    }

    for (const [ip, rules] of installedByIp) {
      const desiredImsi = desired.get(ip);
      const currentImsi = rules[0]?.imsi;
      if (!desiredImsi || desiredImsi !== currentImsi) {
        // Subscriber removed, IP cleared, or IP reassigned to a different
        // subscriber — delete so a reassigned IP's counter resets to zero
        // rather than inheriting the previous owner's byte count.
        for (const r of rules) {
          await this.deleteRule(r.handle).catch(err =>
            this.logger.warn({ err: String(err), ip, handle: r.handle }, 'Failed to delete stale nftables rule'));
        }
        installedByIp.delete(ip);
      }
    }

    for (const [ip, imsi] of desired) {
      if (!installedByIp.has(ip)) {
        await this.addRulePair(ip, imsi).catch(err =>
          this.logger.warn({ err: String(err), ip, imsi }, 'Failed to add nftables rule pair'));
      }
    }

    this.installedIps = desired;
  }

  /** Raw cumulative counters per subscriber IMSI since rule installation (not a rate). */
  async readCounters(): Promise<SubscriberByteCounters[]> {
    const rules = await this.listRules();
    const byImsi = new Map<string, { upBytes: number; downBytes: number }>();

    const result = await this.hostExecutor.executeCommand('nft', ['-j', 'list', 'table', 'inet', TABLE]);
    let parsed: any;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    const countersByHandle = new Map<number, number>();
    for (const entry of parsed?.nftables ?? []) {
      const rule = entry?.rule;
      if (typeof rule?.handle !== 'number') continue;
      const counterExpr = (rule.expr ?? []).find((e: any) => e?.counter);
      if (counterExpr) countersByHandle.set(rule.handle, counterExpr.counter.bytes ?? 0);
    }

    for (const r of rules) {
      const bytes = countersByHandle.get(r.handle) ?? 0;
      const acc = byImsi.get(r.imsi) ?? { upBytes: 0, downBytes: 0 };
      if (r.direction === 'up') acc.upBytes += bytes;
      else acc.downBytes += bytes;
      byImsi.set(r.imsi, acc);
    }

    return Array.from(byImsi.entries()).map(([imsi, c]) => ({ imsi, ...c }));
  }
}
