import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { TunManagementUseCase } from './tun-management';
import { resolveDnnDevPairs } from '../../domain/services/dnn-dev-resolver';

// Real, 2026-09-24 finding: Framed Routing's static host routes
// (`ip route add <cidr> dev <dev>`, via TunManagementUseCase.addRoute())
// were only ever pushed synchronously from SubscriberManagementUseCase's
// create()/update()/delete() — no reconcile loop existed at all, unlike
// every other kernel-state-backed feature this project has (nftables
// accounting, the RAN block services). A route is real kernel state with
// no config-file persistence of its own (TunManagementUseCase's own
// .netdev/.network files create the TUN device, not per-subscriber
// routes) — so it doesn't survive a restore, and doesn't even survive a
// plain host reboot. Mongo (and the UI) correctly show the assignment;
// the kernel silently has no route for it.
//
// Deliberately add-only, unlike subscriber-ip-accounting.ts's full
// diff-and-delete reconcile: a kernel route has no way to tag "this is
// ours" for safe deletion (it lives in the single shared main routing
// table alongside connected-subnet routes, the default route, and
// FRR/EIGRP-redistributed routes — CLAUDE.md gotcha #7), unlike the RAN
// block services' own dedicated nftables tables. addRoute() is already
// idempotent by construction (delete-then-add), and real removals are
// already handled precisely by syncStaticRoutes()'s own before/after
// Mongo diff at update()/delete() time — this loop only needs to assert
// "every currently-desired route still exists," never delete anything.
export class FramedRoutingReconcileService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly tunUseCase: TunManagementUseCase,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  start(intervalMs: number = 60_000): void {
    if (this.timer) return;
    this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'framed-routing-reconcile: initial reconcile failed'));
    this.timer = setInterval(() => {
      this.reconcile().catch(err => this.logger.warn({ err: String(err) }, 'framed-routing-reconcile: reconcile failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async reconcile(): Promise<void> {
    const entries = await this.subscriberRepo.getAllFramedRoutes();
    const staticEntries = entries.filter(e => e.static && (e.ipv4.length > 0 || e.ipv6.length > 0));
    if (staticEntries.length === 0) return;

    const [smf, upf] = await Promise.all([
      this.configRepo.loadSmf().catch(() => ({} as any)),
      this.configRepo.loadUpf().catch(() => ({} as any)),
    ]);
    const dnnDevMap = new Map(
      resolveDnnDevPairs((smf as any).session ?? [], (upf as any).session ?? []).map(p => [p.dnn, p.dev]),
    );

    for (const entry of staticEntries) {
      const dev = dnnDevMap.get(entry.apn) ?? 'ogstun';
      for (const cidr of [...entry.ipv4, ...entry.ipv6]) {
        try {
          await this.tunUseCase.addRoute(cidr, dev);
        } catch (err) {
          this.logger.warn({ imsi: entry.imsi, cidr, dev, err: String(err) }, 'framed-routing-reconcile: failed to (re)assert static route');
        }
      }
    }
  }
}
