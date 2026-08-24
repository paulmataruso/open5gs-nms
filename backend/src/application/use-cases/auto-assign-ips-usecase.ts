import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IApnProfileRepository } from '../../domain/interfaces/apn-profile-repository';
import { ipv4CidrOverlaps } from '../../domain/services/ip-utils';
import pino from 'pino';

export interface AutoAssignIPsResult {
  success: boolean;
  assigned: number;
  skipped: number;
  failed: number;
  ipPool: string;
  errors?: string[];
}

export interface IPAssignment {
  imsi: string;
  ipv4: string;
}

export interface IPPoolInfo {
  ipPool: string;
  startIp: string;
  endIp: string;
  gatewayIp: string | null;
  totalSubscribers: number;
  withIp: number;
  withoutIp: number;
  // IMS APN info — only present when subscribers have an IMS session configured
  imsApn?: string;
  imsPool?: string;
  imsStartIp?: string;
  imsEndIp?: string;
  imsGatewayIp?: string | null;
  imsWithIp?: number;
  imsWithoutIp?: number;
  // #30: when an ApnProfile exists for the resolved DNN with a defined
  // dynamic sub-range, this is the range Auto-Assign actually draws from —
  // distinct from ipPool/imsPool above, which always describe the whole
  // pool. Undefined when no profile (or no dynamic range on it) exists —
  // full backward compatibility, auto-assign uses the whole pool exactly
  // as it always has.
  dynamicRangeStart?: string;
  dynamicRangeEnd?: string;
  imsDynamicRangeStart?: string;
  imsDynamicRangeEnd?: string;
}

/**
 * Auto-assign IPv4 addresses to all subscribers from the UPF session pool
 */
export class AutoAssignIPsUseCase {
  constructor(
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
    private readonly apnProfileRepo?: IApnProfileRepository,
  ) {}

  // #30: a real, PERSISTED ApnProfile only — never the derived/discovered
  // entries ApnProfileUseCase.list() also returns, since those don't carry
  // a dynamic range at all (nothing to clamp to). Constructor param is
  // optional so any test/caller that doesn't care about the static/dynamic
  // split can keep constructing this class exactly as before #30.
  private async findDynamicRange(dnn: string): Promise<{ start: string; end: string } | null> {
    if (!this.apnProfileRepo) return null;
    const profile = await this.apnProfileRepo.findByDnn(dnn).catch(() => null);
    if (profile?.dynamicRangeStart && profile?.dynamicRangeEnd) {
      return { start: profile.dynamicRangeStart, end: profile.dynamicRangeEnd };
    }
    return null;
  }

  // Clamps [startIp, endIp] to stay inside a profile's dynamic range when
  // one exists — a hard ceiling auto-assign can never exceed even via an
  // explicit override, so addresses in a defined static range are never at
  // risk of being handed out automatically (the whole point of the split —
  // only editing the profile itself can widen it).
  private clampToDynamicRange(startIp: string, endIp: string, dynamic: { start: string; end: string } | null): { startIp: string; endIp: string } {
    if (!dynamic) return { startIp, endIp };
    const dynStartNum = this.ipToNumber(dynamic.start);
    const dynEndNum = this.ipToNumber(dynamic.end);
    return {
      startIp: this.numberToIp(Math.max(this.ipToNumber(startIp), dynStartNum)),
      endIp: this.numberToIp(Math.min(this.ipToNumber(endIp), dynEndNum)),
    };
  }

  async getPoolInfo(): Promise<IPPoolInfo> {
    const [upfConfig, smfConfig] = await Promise.all([this.configRepo.loadUpf(), this.configRepo.loadSmf()]);
    const rawYaml = (upfConfig as any).rawYaml;
    const sessions: any[] = rawYaml?.upf?.session ?? [];
    const smfRawYaml = (smfConfig as any).rawYaml;
    const smfSessions: any[] = smfRawYaml?.smf?.session ?? [];

    // Primary internet session: first IPv4 session without a DNN restriction (or dnn=internet)
    const internetSession = sessions.find((s: any) =>
      s.subnet && !s.subnet.includes(':') && (!s.dnn || s.dnn === 'internet')
    ) ?? sessions.find((s: any) => s.subnet && !s.subnet.includes(':'));
    if (!internetSession?.subnet) throw new Error('No IPv4 session pool subnet found in UPF configuration');

    const ipPool = internetSession.subnet as string;
    const gatewayIp = (internetSession.gateway as string) ?? null;
    const { startIp, endIp } = this.parseSubnet(ipPool);

    // IMS session: a UPF session tagged dnn=ims. upf.yaml's own dnn field is a
    // convenience annotation this NMS's UpfEditor writes — not part of Open5GS's real
    // UPF schema — so it can legitimately be absent (e.g. hand-edited upf.yaml). Fall
    // back to joining against smf.yaml's session list by subnet (exact match, then
    // IPv4 CIDR overlap for a differently-declared prefix length) the same way
    // resolveDnnDevMap() in subscriber-management.ts does for framed routing —
    // otherwise a upf.yaml missing dnn silently reports "no IMS session configured"
    // even when one exists.
    const IMS_APNS = ['ims', 'IMS'];
    let imsUpfSession = sessions.find((s: any) =>
      s.subnet && !s.subnet.includes(':') && IMS_APNS.includes(s.dnn)
    );
    if (!imsUpfSession) {
      const imsSmfSession = smfSessions.find((s: any) =>
        s?.subnet && !String(s.subnet).includes(':') && IMS_APNS.includes(s.dnn)
      );
      if (imsSmfSession?.subnet) {
        imsUpfSession = sessions.find((s: any) => s?.subnet === imsSmfSession.subnet)
          ?? sessions.find((s: any) => s?.subnet && !String(s.subnet).includes(':')
            && ipv4CidrOverlaps(s.subnet, imsSmfSession.subnet));
        if (!imsUpfSession) {
          this.logger.warn(
            { subnet: imsSmfSession.subnet },
            'smf.yaml has an IMS DNN but no matching UPF session (by dnn or subnet) — IMS IP pool info unavailable',
          );
        }
      }
    }

    const allSubscribers = await this.subscriberRepo.findAllFull();

    const withIp = allSubscribers.filter(s =>
      s.slice?.some(sl => sl.session?.some(sess => !IMS_APNS.includes(sess.name) && sess.ue?.ipv4))
    ).length;

    // Detect IMS sessions on subscribers
    const imsSubscribers = allSubscribers.filter(s =>
      s.slice?.some(sl => sl.session?.some(sess => IMS_APNS.includes(sess.name)))
    );
    const detectedImsApn = imsSubscribers.length > 0
      ? (imsSubscribers[0].slice?.flatMap(sl => sl.session ?? []).find(sess => IMS_APNS.includes(sess.name))?.name ?? 'ims')
      : undefined;

    const info: IPPoolInfo = {
      ipPool, startIp, endIp, gatewayIp,
      totalSubscribers: allSubscribers.length,
      withIp,
      withoutIp: allSubscribers.length - withIp,
    };

    const internetDynamicRange = await this.findDynamicRange('internet');
    if (internetDynamicRange) {
      info.dynamicRangeStart = internetDynamicRange.start;
      info.dynamicRangeEnd = internetDynamicRange.end;
    }

    if (detectedImsApn !== undefined) {
      const imsWithIp = imsSubscribers.filter(s =>
        s.slice?.some(sl => sl.session?.some(sess => IMS_APNS.includes(sess.name) && sess.ue?.ipv4))
      ).length;

      let imsPool: string | undefined;
      let imsStartIp: string | undefined;
      let imsEndIp: string | undefined;
      let imsGatewayIp: string | null = null;

      if (imsUpfSession?.subnet) {
        imsPool = imsUpfSession.subnet as string;
        imsGatewayIp = (imsUpfSession.gateway as string) ?? null;
        const parsed = this.parseSubnet(imsPool);
        imsStartIp = parsed.startIp;
        imsEndIp = parsed.endIp;
      }

      info.imsApn = detectedImsApn;
      info.imsPool = imsPool;
      info.imsStartIp = imsStartIp;
      info.imsEndIp = imsEndIp;
      info.imsGatewayIp = imsGatewayIp;
      info.imsWithIp = imsWithIp;
      info.imsWithoutIp = imsSubscribers.length - imsWithIp;

      const imsDynamicRange = await this.findDynamicRange(detectedImsApn);
      if (imsDynamicRange) {
        info.imsDynamicRangeStart = imsDynamicRange.start;
        info.imsDynamicRangeEnd = imsDynamicRange.end;
      }
    }

    return info;
  }

  async execute(overrides?: { startIp?: string; endIp?: string; overwrite?: boolean; imsStartIp?: string; imsEndIp?: string; imsOverwrite?: boolean; imsis?: string[] }): Promise<AutoAssignIPsResult> {
    try {
      const IMS_APNS = ['ims', 'IMS'];

      // Step 1: Get IP pool from UPF configuration
      const upfConfig = await this.configRepo.loadUpf();
      const rawYaml = (upfConfig as any).rawYaml;
      const upfSessions: any[] = rawYaml?.upf?.session ?? [];

      const internetSession = upfSessions.find((s: any) =>
        s.subnet && !s.subnet.includes(':') && (!s.dnn || s.dnn === 'internet')
      ) ?? upfSessions.find((s: any) => s.subnet && !s.subnet.includes(':'));
      if (!internetSession?.subnet) throw new Error('No IPv4 session pool subnet found in UPF configuration');

      const ipPool = internetSession.subnet as string;
      const gatewayIP = internetSession.gateway;
      this.logger.info({ ipPool, gatewayIP }, 'Using IP pool from UPF configuration');

      // Step 2: Parse the subnet to get base IP and netmask
      const { baseIp, netmask, startIp: defaultStart, endIp: defaultEnd } = this.parseSubnet(ipPool);
      // #30: clamp to the "internet" profile's dynamic range when one is
      // defined — a hard ceiling even over an explicit override, so a
      // defined static range is never at risk of being auto-assigned into.
      const internetDynamicRange = await this.findDynamicRange('internet');
      const { startIp, endIp } = this.clampToDynamicRange(
        overrides?.startIp ?? defaultStart,
        overrides?.endIp ?? defaultEnd,
        internetDynamicRange,
      );
      const overwrite = overrides?.overwrite ?? false;
      const gatewayIPNum = gatewayIP ? this.ipToNumber(gatewayIP) : null;
      this.logger.info({ baseIp, netmask, startIp, endIp, gatewayIP, overwrite, dynamicRange: internetDynamicRange }, 'Parsed IP pool');

      // Step 3: Get subscribers in scope — either every subscriber, or only the
      // caller-selected subset (so a bulk run never touches UEs the operator
      // deliberately left out of the selection).
      const allSubscribersFull = await this.subscriberRepo.findAllFull();
      const allSubscribers = overrides?.imsis?.length
        ? allSubscribersFull.filter(s => overrides.imsis!.includes(s.imsi))
        : allSubscribersFull;
      this.logger.info({ count: allSubscribers.length, scope: overrides?.imsis?.length ? `selected(${overrides.imsis.length})` : 'all' }, 'Found subscribers');

      // Step 4: Assign internet session IPs
      let assigned = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];
      const endIpNum = this.ipToNumber(endIp);

      // Gap-fill: a naive incrementing counter that only skips subscribers who
      // already have SOME IP silently reuses low addresses once it reaches
      // subscribers without one — if e.g. the first 5 and last 5 of 20
      // subscribers already hold sequential IPs from a prior run, a bare
      // counter starting at startIp collides head-on with the first 5's
      // addresses when it gets to the middle 10. Instead, build the set of
      // every IP already held by ANY subscriber (not just those in scope) and
      // walk the pool skipping occupied addresses, so gaps between existing
      // blocks are correctly detected and filled rather than collided with.
      // A subscriber's own current IP is excluded from "occupied" only when
      // it's in scope AND about to be overwritten — its slot is being freed.
      const scopedImsiSet = overrides?.imsis?.length ? new Set(overrides.imsis) : null;
      const occupied = new Set<number>();
      for (const s of allSubscribersFull) {
        const sess = s.slice?.flatMap(sl => sl.session ?? []).find(x => !IMS_APNS.includes(x.name));
        const ip = sess?.ue?.ipv4;
        if (!ip) continue;
        const willBeReassigned = overwrite && (scopedImsiSet ? scopedImsiSet.has(s.imsi) : true);
        if (willBeReassigned) continue;
        occupied.add(this.ipToNumber(ip));
      }

      let cursor = this.ipToNumber(startIp);
      const nextFreeIp = (): number | null => {
        while (cursor <= endIpNum) {
          if ((gatewayIPNum !== null && cursor === gatewayIPNum) || occupied.has(cursor)) {
            cursor++;
            continue;
          }
          return cursor;
        }
        return null;
      };

      for (const subscriber of allSubscribers) {
        try {
          // Target the actual non-IMS session by name, not slice[0].session[0] positionally —
          // a subscriber whose "ims" session happens to sit first in the array would otherwise
          // get an internet-pool IP written into their IMS session instead of their real
          // internet session (confirmed live: this caused internet and ims to end up sharing
          // the same 10.45.0.0/24 range for affected subscribers).
          const nonImsSession = subscriber.slice
            ?.flatMap(sl => sl.session ?? [])
            .find(sess => !IMS_APNS.includes(sess.name));

          if (!nonImsSession) {
            skipped++;
            continue;
          }

          if (nonImsSession.ue?.ipv4 && !overwrite) {
            skipped++;
            continue;
          }

          const ipNum = nextFreeIp();
          if (ipNum === null) {
            errors.push(`IP pool exhausted after ${assigned} assignments`);
            failed++;
            break;
          }
          occupied.add(ipNum);
          cursor = ipNum + 1;

          const assignedIp = this.numberToIp(ipNum);
          await this.subscriberRepo.assignIPv4ByApn(subscriber.imsi, nonImsSession.name, assignedIp);
          assigned++;

        } catch (error) {
          failed++;
          errors.push(`Failed to assign IP to ${subscriber.imsi}: ${error instanceof Error ? error.message : String(error)}`);
          this.logger.warn({ imsi: subscriber.imsi, error: String(error) }, 'Failed to assign IP');
        }
      }

      // Step 5: Optionally assign IMS session IPs — same gap-fill approach, its
      // own independent occupied set since it's a separate pool/subnet.
      if (overrides?.imsStartIp && overrides?.imsEndIp) {
        const imsOverwrite = overrides.imsOverwrite ?? false;
        // #30: same dynamic-range clamp as the internet pool above, keyed
        // off whichever DNN name the IMS subscribers actually use (matches
        // getPoolInfo()'s own detectedImsApn — usually "ims", sometimes "IMS").
        const imsProfileDnn = allSubscribersFull
          .flatMap(s => s.slice?.flatMap(sl => sl.session ?? []) ?? [])
          .find(sess => IMS_APNS.includes(sess.name))?.name ?? 'ims';
        const imsDynamicRange = await this.findDynamicRange(imsProfileDnn);
        const { startIp: imsStartIp, endIp: imsEndIp } = this.clampToDynamicRange(
          overrides.imsStartIp, overrides.imsEndIp, imsDynamicRange,
        );
        const imsEndIpNum = this.ipToNumber(imsEndIp);

        const imsOccupied = new Set<number>();
        for (const s of allSubscribersFull) {
          const sess = s.slice?.flatMap(sl => sl.session ?? []).find(x => IMS_APNS.includes(x.name));
          const ip = sess?.ue?.ipv4;
          if (!ip) continue;
          const willBeReassigned = imsOverwrite && (scopedImsiSet ? scopedImsiSet.has(s.imsi) : true);
          if (willBeReassigned) continue;
          imsOccupied.add(this.ipToNumber(ip));
        }

        let imsCursor = this.ipToNumber(imsStartIp);
        const nextFreeImsIp = (): number | null => {
          while (imsCursor <= imsEndIpNum) {
            if (imsOccupied.has(imsCursor)) { imsCursor++; continue; }
            return imsCursor;
          }
          return null;
        };

        for (const subscriber of allSubscribers) {
          try {
            const imsSession = subscriber.slice?.flatMap(sl => sl.session ?? [])
              .find(sess => IMS_APNS.includes(sess.name));
            if (!imsSession) continue;

            if (imsSession.ue?.ipv4 && !imsOverwrite) {
              skipped++;
              continue;
            }

            const imsIpNum = nextFreeImsIp();
            if (imsIpNum === null) {
              errors.push(`IMS IP pool exhausted after ${assigned} IMS assignments`);
              failed++;
              break;
            }
            imsOccupied.add(imsIpNum);
            imsCursor = imsIpNum + 1;

            const imsIp = this.numberToIp(imsIpNum);
            await this.subscriberRepo.assignIPv4ByApn(subscriber.imsi, imsSession.name, imsIp);
            assigned++;

          } catch (error) {
            failed++;
            errors.push(`Failed to assign IMS IP to ${subscriber.imsi}: ${error instanceof Error ? error.message : String(error)}`);
            this.logger.warn({ imsi: subscriber.imsi, error: String(error) }, 'Failed to assign IMS IP');
          }
        }
      }

      this.logger.info({ assigned, skipped, failed }, 'IP assignment completed');

      return {
        success: true,
        assigned,
        skipped,
        failed,
        ipPool,
        errors: errors.length > 0 ? errors : undefined,
      };

    } catch (error) {
      this.logger.error({ error: String(error) }, 'Auto-assign IPs failed');
      throw error;
    }
  }

  /**
   * Get list of all IP assignments for display
   */
  async getIPAssignments(): Promise<IPAssignment[]> {
    const subscribers = await this.subscriberRepo.findAllFull();
    const assignments: IPAssignment[] = [];

    for (const subscriber of subscribers) {
      // Find the first IPv4 address assigned
      const ipv4 = subscriber.slice
        ?.flatMap(slice => slice.session || [])
        ?.find(session => session.ue?.ipv4)
        ?.ue?.ipv4;

      if (ipv4) {
        assignments.push({
          imsi: subscriber.imsi,
          ipv4,
        });
      }
    }

    return assignments.sort((a, b) => a.imsi.localeCompare(b.imsi));
  }

  // Helper functions for IP manipulation
  private parseSubnet(cidr: string): { baseIp: string; netmask: number; startIp: string; endIp: string } {
    const [baseIp, netmaskStr] = cidr.split('/');
    const netmask = parseInt(netmaskStr, 10);

    if (!baseIp || isNaN(netmask) || netmask < 0 || netmask > 32) {
      throw new Error(`Invalid CIDR notation: ${cidr}`);
    }

    const baseIpNum = this.ipToNumber(baseIp);
    const hostBits = 32 - netmask;
    const networkMask = (0xFFFFFFFF << hostBits) >>> 0;
    const networkAddress = (baseIpNum & networkMask) >>> 0;

    // Start from .1 (skip network address)
    const startIp = this.numberToIp(networkAddress + 1);
    
    // End at broadcast address - 1 (skip broadcast)
    const broadcastAddress = (networkAddress | (~networkMask >>> 0)) >>> 0;
    const endIp = this.numberToIp(broadcastAddress - 1);

    return { baseIp, netmask, startIp, endIp };
  }

  private ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  private numberToIp(num: number): string {
    return [
      (num >>> 24) & 0xFF,
      (num >>> 16) & 0xFF,
      (num >>> 8) & 0xFF,
      num & 0xFF,
    ].join('.');
  }
}
