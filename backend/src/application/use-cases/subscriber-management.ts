import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { subscriberSchema } from '../../domain/services/validation-schemas';
import { SubscriberDto } from '../dto';
import { Subscriber, SubscriberListItem } from '../../domain/entities/subscriber';
import { TunManagementUseCase } from './tun-management';
import { ipv4CidrOverlaps } from '../../domain/services/ip-utils';

export class SubscriberManagementUseCase {
  constructor(
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
    private readonly tunUseCase: TunManagementUseCase,
    private readonly configRepo: IConfigRepository,
  ) {}

  // ── Framed Routing: static host route management ───────────────────────────

  private collectStaticRoutes(slices: any[] | undefined): Map<string, string> {
    const map = new Map<string, string>(); // key: `${dnn}::${cidr}`, value: dnn
    for (const sl of slices ?? []) {
      for (const sess of sl.session ?? []) {
        if (!sess.framed_routes_static) continue;
        const dnn = sess.name;
        for (const cidr of [...(sess.ipv4_framed_routes ?? []), ...(sess.ipv6_framed_routes ?? [])]) {
          map.set(`${dnn}::${cidr}`, dnn);
        }
      }
    }
    return map;
  }

  private async resolveDnnDevMap(): Promise<Map<string, string>> {
    const upf = await this.configRepo.loadUpf();
    const sessions = ((upf as any).session ?? []) as any[];
    const map = new Map<string, string>();
    for (const s of sessions) {
      if (s?.dnn) map.set(s.dnn, s.dev || 'ogstun');
    }
    return map;
  }

  // Diffs old vs new session state and adds/removes static host routes for the delta.
  // `newSlices === undefined` means this update didn't touch sessions at all — skip.
  private async syncStaticRoutes(oldSlices: any[] | undefined, newSlices: any[] | undefined): Promise<void> {
    if (newSlices === undefined) return;
    const oldMap = this.collectStaticRoutes(oldSlices);
    const newMap = this.collectStaticRoutes(newSlices);

    const toAdd: Array<{ cidr: string; dnn: string }> = [];
    const toRemove: Array<{ cidr: string; dnn: string }> = [];
    for (const [key, dnn] of newMap) {
      if (!oldMap.has(key)) toAdd.push({ cidr: key.split('::')[1], dnn });
    }
    for (const [key, dnn] of oldMap) {
      if (!newMap.has(key)) toRemove.push({ cidr: key.split('::')[1], dnn });
    }
    if (toAdd.length === 0 && toRemove.length === 0) return;

    const dnnDevMap = await this.resolveDnnDevMap();
    for (const { cidr, dnn } of toRemove) {
      const dev = dnnDevMap.get(dnn) ?? 'ogstun';
      try {
        await this.tunUseCase.removeRoute(cidr, dev);
      } catch (err) {
        this.logger.warn({ cidr, dev, err: String(err) }, 'Failed to remove static framed route');
      }
    }
    for (const { cidr, dnn } of toAdd) {
      const dev = dnnDevMap.get(dnn) ?? 'ogstun';
      try {
        await this.tunUseCase.addRoute(cidr, dev);
      } catch (err) {
        this.logger.warn({ cidr, dev, err: String(err) }, 'Failed to add static framed route');
      }
    }
  }

  // ── Framed Routing: non-blocking overlap/duplicate warnings ────────────────

  private async computeFramedRouteWarnings(imsi: string, slices: any[]): Promise<string[]> {
    const warnings: string[] = [];
    const newRoutes: Array<{ dnn: string; cidr: string; family: 'v4' | 'v6' }> = [];
    for (const sl of slices ?? []) {
      for (const sess of sl.session ?? []) {
        for (const cidr of sess.ipv4_framed_routes ?? []) newRoutes.push({ dnn: sess.name, cidr, family: 'v4' });
        for (const cidr of sess.ipv6_framed_routes ?? []) newRoutes.push({ dnn: sess.name, cidr, family: 'v6' });
      }
    }
    if (newRoutes.length === 0) return warnings;

    const others = await this.subscriberRepo.getAllFramedRoutes(imsi);
    for (const r of newRoutes) {
      for (const other of others) {
        const otherList = r.family === 'v4' ? other.ipv4 : other.ipv6;
        for (const otherCidr of otherList) {
          // IPv4: full numeric-range overlap check. IPv6: exact-string duplicate only
          // (no 128-bit prefix math here — no IPv6 CIDR library in this codebase and
          // full range math is disproportionate for a warn-only check).
          const conflict = r.family === 'v4' ? ipv4CidrOverlaps(r.cidr, otherCidr) : r.cidr === otherCidr;
          if (conflict) {
            warnings.push(
              `${r.cidr} (${r.dnn}) overlaps ${other.imsi}${other.nickname ? ` (${other.nickname})` : ''}'s framed route ${otherCidr} on '${other.apn}'`,
            );
          }
        }
      }
    }

    try {
      const [smf, upf] = await Promise.all([this.configRepo.loadSmf(), this.configRepo.loadUpf()]);
      const poolSubnets: string[] = [
        ...(((smf as any).session ?? []) as any[]).map((s) => s.subnet).filter(Boolean),
        ...(((upf as any).session ?? []) as any[]).map((s) => s.subnet).filter(Boolean),
      ];
      for (const r of newRoutes.filter((x) => x.family === 'v4')) {
        for (const pool of poolSubnets) {
          if (ipv4CidrOverlaps(r.cidr, pool)) {
            warnings.push(`${r.cidr} (${r.dnn}) overlaps the core UE pool subnet ${pool}`);
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'Could not check framed routes against UPF/SMF pool subnets');
    }

    return warnings;
  }

  async list(
    skip: number = 0,
    limit: number = 50,
    sortOrder: 'asc' | 'desc' = 'asc',
    sortBy: 'imsi' | 'ue_ipv4' | 'apn' = 'imsi',
  ): Promise<{ subscribers: SubscriberListItem[]; total: number }> {
    const [subscribers, total] = await Promise.all([
      this.subscriberRepo.findAll(skip, limit, sortOrder, sortBy),
      this.subscriberRepo.count(),
    ]);
    return { subscribers, total };
  }

  async search(query: string, skip: number = 0, limit: number = 50): Promise<{
    subscribers: SubscriberListItem[];
    total: number;
  }> {
    const subscribers = await this.subscriberRepo.search(query, skip, limit);
    return { subscribers, total: subscribers.length };
  }

  async getByImsi(imsi: string): Promise<Subscriber | null> {
    return this.subscriberRepo.findByImsi(imsi);
  }

  async getFramedRoutes() {
    return this.subscriberRepo.getAllFramedRoutes();
  }

  async create(dto: SubscriberDto): Promise<{ warnings: string[] }> {
    const parsed = subscriberSchema.safeParse(dto);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }

    const existing = await this.subscriberRepo.findByImsi(dto.imsi);
    if (existing) {
      throw new Error(`Subscriber with IMSI ${dto.imsi} already exists`);
    }

    const subscriber: Subscriber = {
      ...dto,
      schema_version: 1,
      __v: 0,
    };

    await this.subscriberRepo.create(subscriber);
    await this.syncStaticRoutes(undefined, subscriber.slice as any);
    const warnings = await this.computeFramedRouteWarnings(dto.imsi, subscriber.slice as any);

    this.logger.info({ imsi: dto.imsi }, 'Subscriber created');
    await this.auditLogger.log({
      action: 'subscriber_create',
      user: 'admin',
      target: dto.imsi,
      success: true,
    });
    return { warnings };
  }

  async update(imsi: string, dto: Partial<SubscriberDto>): Promise<{ warnings: string[] }> {
    const existing = await this.subscriberRepo.findByImsi(imsi);
    if (!existing) {
      throw new Error(`Subscriber with IMSI ${imsi} not found`);
    }

    if (dto.imsi && dto.imsi !== imsi) {
      const conflict = await this.subscriberRepo.findByImsi(dto.imsi);
      if (conflict) {
        throw new Error(`Subscriber with IMSI ${dto.imsi} already exists`);
      }
    }

    await this.subscriberRepo.update(imsi, dto);
    await this.syncStaticRoutes(existing.slice as any, dto.slice as any);
    const warnings = dto.slice ? await this.computeFramedRouteWarnings(imsi, dto.slice as any) : [];

    this.logger.info({ imsi }, 'Subscriber updated');
    await this.auditLogger.log({
      action: 'subscriber_update',
      user: 'admin',
      target: imsi,
      success: true,
    });
    return { warnings };
  }

  async autoAssignMsisdn(
    startingNumber: string,
    overwrite: boolean,
    user: string,
  ): Promise<{ assigned: number; skipped: number }> {
    if (!/^\d+$/.test(startingNumber)) throw new Error('Starting number must be numeric digits only.');
    const allSubs = await this.subscriberRepo.findAllFull();
    let counter = BigInt(startingNumber);
    let assigned = 0;
    let skipped = 0;
    for (const sub of allSubs) {
      if (!overwrite && sub.msisdn && sub.msisdn.length > 0) {
        skipped++;
        continue;
      }
      await this.subscriberRepo.update(sub.imsi, { msisdn: [counter.toString()] });
      counter++;
      assigned++;
    }
    this.logger.info({ assigned, skipped, startingNumber }, 'MSISDN auto-assign complete');
    await this.auditLogger.log({
      action: 'subscriber_msisdn_assign',
      user,
      details: `assigned=${assigned} skipped=${skipped} start=${startingNumber} overwrite=${overwrite}`,
      success: true,
    });
    return { assigned, skipped };
  }

  async delete(imsi: string): Promise<void> {
    const existing = await this.subscriberRepo.findByImsi(imsi);
    if (!existing) {
      throw new Error(`Subscriber with IMSI ${imsi} not found`);
    }

    await this.subscriberRepo.delete(imsi);
    await this.syncStaticRoutes(existing.slice as any, []);

    this.logger.info({ imsi }, 'Subscriber deleted');
    await this.auditLogger.log({
      action: 'subscriber_delete',
      user: 'admin',
      target: imsi,
      success: true,
    });
  }

  async bulkAddApn(
    sessions: any[],
    overwrite: boolean,
    sst: number,
    sd: string | undefined,
    user: string,
  ): Promise<{ updated: number; skipped: number; errors: string[] }> {
    const allSubs = await this.subscriberRepo.findAllFull();
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const sub of allSubs) {
      try {
        const slices: any[] = (sub as any).slice ?? [];
        if (!slices.length) continue;

        // Find the target slice by SST and optionally SD
        const targetIdx = slices.findIndex((sl: any) => {
          if (sl.sst !== sst) return false;
          if (sd !== undefined && sd !== '' && sl.sd !== sd) return false;
          return true;
        });

        if (targetIdx < 0) { skipped++; continue; }

        const targetSlice = slices[targetIdx];
        const existingSessions: any[] = targetSlice.session ?? [];
        let updatedSessions = [...existingSessions];
        let changed = false;

        for (const sess of sessions) {
          const existingIdx = existingSessions.findIndex(
            (s: any) => s.name === sess.name,
          );
          if (existingIdx >= 0) {
            if (!overwrite) continue;
            updatedSessions[existingIdx] = sess;
            changed = true;
          } else {
            updatedSessions = [...updatedSessions, sess];
            changed = true;
          }
        }

        if (!changed) { skipped++; continue; }

        const newSlices = slices.map((sl: any, i: number) =>
          i === targetIdx ? { ...sl, session: updatedSessions } : sl,
        );

        await this.subscriberRepo.update(sub.imsi, { slice: newSlices } as any);
        updated++;
      } catch (err) {
        errors.push(`${sub.imsi}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.info({ updated, skipped, errors: errors.length }, 'Bulk APN add complete');
    await this.auditLogger.log({
      action: 'subscriber_bulk_add_apn',
      user,
      target: `${sessions.map((s: any) => s.name).join(',')} — ${updated} subscribers`,
      success: true,
    });

    return { updated, skipped, errors };
  }
}
