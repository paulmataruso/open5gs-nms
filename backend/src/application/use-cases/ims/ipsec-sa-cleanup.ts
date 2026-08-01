/**
 * IPsec-3GPP stale SA cleanup.
 *
 * Real bug, confirmed live (2026-07-31): ims_ipsec_pcscf's own
 * delete_unused_sa() (kamailio-ims-modules, ipsec.c:928) is supposed to
 * remove a UE's old IPsec SA quadruplet whenever it re-registers with a
 * fresh one, but never actually finds anything to delete — confirmed via
 * 19/19 real REGISTER refreshes over 6h all hitting its
 * "Error sending delete unused SAs command via netlink socket: No data
 * available" (ENODATA) error path, while `ip xfrm state` on the same host
 * at the same time showed a real UE genuinely carrying two full stale
 * quadruplets (8 SAs) from two different registration generations. Left
 * unchecked this grows without bound across a UE's re-registration
 * lifetime — this backend-side reconciler is a workaround, not a fix to
 * the (third-party, not part of this repo) module itself.
 *
 * Strategy deliberately does NOT try to replicate that broken module's own
 * matching logic (which requires internal contact-table structures not
 * exposed over any RPC). Instead: group all real-subscriber SAs by UE peer
 * IP, and within each group keep only the most-recently-created cluster
 * (a real registration creates all 4 of its SAs within milliseconds of
 * each other) — anything else is stale. MIN_AGE_SECONDS guards against
 * racing a SA that's still mid-setup.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';

const CLUSTER_TOLERANCE_MS = 5_000;
const MIN_AGE_MS = 120_000;

interface XfrmSa {
  src: string;
  dst: string;
  spi: string;
  peer: string;
  addedAt: number; // epoch ms
}

function pcscfIp(): string | null {
  try {
    const state = JSON.parse(require('fs').readFileSync('/proc/1/root/etc/open5gs/.ims-config.json', 'utf-8'));
    return state?.pcscfIp ?? null;
  } catch {
    return null;
  }
}

function parseXfrmState(raw: string, selfIp: string): XfrmSa[] {
  const sas: XfrmSa[] = [];
  const blocks = raw.split(/\n(?=src )/);
  for (const block of blocks) {
    const srcDst = /^src (\S+) dst (\S+)/.exec(block);
    const spiM = /spi (0x[0-9a-fA-F]+)/.exec(block);
    const addM = /add (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(block);
    if (!srcDst || !spiM || !addM) continue;
    const [, src, dst] = srcDst;
    const peer = src === selfIp ? dst : src;
    if (peer === selfIp || peer.startsWith('127.')) continue;
    const addedAt = new Date(addM[1].replace(' ', 'T')).getTime();
    if (Number.isNaN(addedAt)) continue;
    sas.push({ src, dst, spi: spiM[1], peer, addedAt });
  }
  return sas;
}

export class IpsecSaCleanup {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
  ) {}

  start(intervalMs: number = 10_000): void {
    if (this.timer) return;
    this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'ipsec SA cleanup: initial reconcile failed'));
    this.timer = setInterval(() => {
      this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'ipsec SA cleanup: reconcile failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async reconcile(): Promise<void> {
    const selfIp = pcscfIp();
    if (!selfIp) return; // IMS not configured on this host — nothing to do.

    const result = await this.hostExecutor.executeCommand('ip', ['-s', 'xfrm', 'state'], 15000);
    if (result.exitCode !== 0 || !result.stdout.trim()) return;

    const sas = parseXfrmState(result.stdout, selfIp);
    if (sas.length === 0) return;

    const byPeer = new Map<string, XfrmSa[]>();
    for (const sa of sas) {
      const list = byPeer.get(sa.peer) ?? [];
      list.push(sa);
      byPeer.set(sa.peer, list);
    }

    const now = Date.now();
    const toDelete: XfrmSa[] = [];
    for (const group of byPeer.values()) {
      const newest = Math.max(...group.map(s => s.addedAt));
      for (const sa of group) {
        if (newest - sa.addedAt <= CLUSTER_TOLERANCE_MS) continue; // in the latest cluster — keep
        if (now - sa.addedAt < MIN_AGE_MS) continue; // too young — don't race a fresh setup
        toDelete.push(sa);
      }
    }

    if (toDelete.length === 0) return;

    this.logger.info({ count: toDelete.length }, 'ipsec SA cleanup: removing stale SAs');
    for (const sa of toDelete) {
      const del = await this.hostExecutor.executeCommand(
        'ip', ['xfrm', 'state', 'delete', 'src', sa.src, 'dst', sa.dst, 'proto', 'esp', 'spi', sa.spi], 10000,
      );
      if (del.exitCode !== 0) {
        this.logger.warn({ src: sa.src, dst: sa.dst, spi: sa.spi, stderr: del.stderr }, 'ipsec SA cleanup: delete failed');
      } else {
        this.logger.info({ src: sa.src, dst: sa.dst, spi: sa.spi, ageMs: now - sa.addedAt }, 'ipsec SA cleanup: deleted stale SA');
      }
    }
  }
}
