import { randomUUID } from 'crypto';
import pino from 'pino';
import { IApnProfileRepository } from '../../domain/interfaces/apn-profile-repository';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { ApnProfile, ApnProfileListEntry } from '../../domain/entities/apn-profile';
import { resolveDnnDevPairs, preferIPv4ByDev } from '../../domain/services/dnn-dev-resolver';
import { ipToNum, cidrRange } from '../../domain/services/ip-utils';
import {
  isValidIPv6Cidr, parseIPv6Cidr, ipv6SubnetAtOffset, ipv6ChildCount,
  ipv6OffsetWithinParent, ipv6FirstUsableAddress,
} from '../../domain/services/ip6-utils';

export interface ApnProfileInput {
  dnn: string;
  dev: string;
  subnet: string;
  gateway: string;
  subnetV6?: string;
  gatewayV6?: string;
  qos: {
    index: number;
    arp: { priority_level: number; pre_emption_capability: number; pre_emption_vulnerability: number };
  };
  staticRangeStart: string | null;
  staticRangeEnd: string | null;
  dynamicRangeStart: string | null;
  dynamicRangeEnd: string | null;
}

const DEFAULT_QOS = {
  index: 9,
  arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 },
};

export class ApnProfileUseCase {
  constructor(
    private readonly apnProfileRepo: IApnProfileRepository,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  // Merges real, persisted profiles with any DNN discovered live from
  // smf.yaml/upf.yaml (via resolveDnnDevPairs(), the same join #28/#29
  // already established) that has no matching profile record yet — so
  // existing DNNs are immediately usable (e.g. in the Subscriber dropdown)
  // without forcing a migration step. Sorted by dnn.
  async list(): Promise<ApnProfileListEntry[]> {
    const [profiles, smf, upf] = await Promise.all([
      this.apnProfileRepo.findAll(),
      this.configRepo.loadSmf(),
      this.configRepo.loadUpf(),
    ]);
    const smfSessions = ((smf as any).session ?? []) as any[];
    const upfSessions = ((upf as any).session ?? []) as any[];
    const persistedDnns = new Set(profiles.map((p) => p.dnn));

    const pairs = resolveDnnDevPairs(smfSessions, upfSessions, (dnn, subnet) => {
      this.logger.warn({ dnn, subnet }, 'APN profile list: no matching UPF session for SMF DNN, omitted from derived entries');
    });
    // dedupe by dnn (a dual-stack DNN produces two smf sessions, same dev) —
    // a null subnet (shouldn't normally happen; resolveDnnDevPairs only sets
    // it from the SMF session it matched) can't back a derivable profile.
    const derivedByDnn = new Map<string, { dnn: string; dev: string; subnet: string }>();
    for (const p of pairs) {
      if (persistedDnns.has(p.dnn) || derivedByDnn.has(p.dnn) || !p.subnet) continue;
      derivedByDnn.set(p.dnn, { dnn: p.dnn, dev: p.dev, subnet: p.subnet });
    }
    // Prefer the IPv4 session for a given dev (a dual-stack DNN has two upf.yaml
    // sessions sharing the same dev) — profiles are IPv4-only by design, and a
    // naive last-write-wins map can end up pointing at the v6 session's gateway
    // depending on which order the two happen to appear in the file. Shared
    // with tun-management.ts's identical need (#29 follow-up, 2026-08-25) —
    // see preferIPv4ByDev's own comment.
    const upfByDev = preferIPv4ByDev(upfSessions.map((s) => ({ ...s, dev: s?.dev || 'ogstun' })));

    const entries: ApnProfileListEntry[] = [
      ...profiles.map((p) => ({ ...p, persisted: true as const })),
      ...[...derivedByDnn.values()].map((d) => ({
        persisted: false as const,
        dnn: d.dnn,
        dev: d.dev,
        subnet: d.subnet,
        gateway: upfByDev.get(d.dev)?.gateway ?? null,
      })),
    ];
    return entries.sort((a, b) => a.dnn.localeCompare(b.dnn));
  }

  async create(input: ApnProfileInput): Promise<ApnProfile> {
    // #30 follow-up: auto-allocate IPv6 when the operator left it blank and
    // a core-wide parent prefix is configured — explicit input always wins
    // (never overwrite a value the caller actually provided), and a
    // deployment that never sets a parent prefix sees no behavior change at
    // all (stays IPv4-only, exactly as before this feature).
    if (!input.subnetV6 && !input.gatewayV6) {
      const auto = await this.allocateNextIPv6Subnet();
      if (auto) {
        input = { ...input, subnetV6: auto.subnet, gatewayV6: auto.gateway };
      }
    }

    this.validateInput(input);
    const existing = await this.apnProfileRepo.findByDnn(input.dnn);
    if (existing) throw new Error(`A profile for DNN "${input.dnn}" already exists`);

    const now = new Date().toISOString();
    const profile: ApnProfile = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    await this.patchYamlConfigs(profile);
    await this.apnProfileRepo.create(profile);
    return profile;
  }

  // ── IPv6 pool (#30 follow-up) ───────────────────────────────────────────

  async getIPv6ParentPrefix(): Promise<string | null> {
    return this.apnProfileRepo.getIPv6ParentPrefix();
  }

  async setIPv6ParentPrefix(parentPrefix: string | null): Promise<void> {
    if (parentPrefix === null || parentPrefix === '') {
      await this.apnProfileRepo.setIPv6ParentPrefix('');
      return;
    }
    if (!isValidIPv6Cidr(parentPrefix)) throw new Error(`Invalid IPv6 CIDR: ${parentPrefix}`);
    const { prefix } = parseIPv6Cidr(parentPrefix);
    if (prefix > 64) throw new Error(`Parent prefix /${prefix} is too specific to carve /64 profiles out of — use /64 or shorter (e.g. /48, /56)`);
    await this.apnProfileRepo.setIPv6ParentPrefix(parentPrefix);
  }

  // Finds the lowest-numbered /64 not already in use by an existing
  // profile's subnetV6 — derived live from current profiles each call
  // rather than a separate persisted counter, so deleting a profile
  // naturally frees its /64 back up with no extra bookkeeping, and this
  // can't drift out of sync with what profiles actually hold. Returns null
  // (not an error) when no parent prefix is configured, so callers that
  // don't care about IPv6 (create()'s opportunistic auto-fill) can treat
  // "not configured" as a no-op.
  async allocateNextIPv6Subnet(): Promise<{ subnet: string; gateway: string } | null> {
    const parentPrefix = await this.apnProfileRepo.getIPv6ParentPrefix();
    if (!parentPrefix) return null;

    const profiles = await this.apnProfileRepo.findAll();
    const used = new Set<number>();
    for (const p of profiles) {
      if (!p.subnetV6) continue;
      const offset = ipv6OffsetWithinParent(parentPrefix, p.subnetV6);
      if (offset !== null) used.add(offset);
    }

    const total = ipv6ChildCount(parentPrefix, 64);
    for (let offset = 0; offset < total; offset++) {
      if (used.has(offset)) continue;
      const subnet = ipv6SubnetAtOffset(parentPrefix, offset, 64);
      return { subnet, gateway: ipv6FirstUsableAddress(subnet) };
    }
    throw new Error(`IPv6 pool ${parentPrefix} is exhausted — every /64 is already in use by an existing profile`);
  }

  async update(id: string, input: ApnProfileInput): Promise<ApnProfile> {
    this.validateInput(input);
    const existing = await this.apnProfileRepo.findById(id);
    if (!existing) throw new Error('Profile not found');
    const dnnOwner = await this.apnProfileRepo.findByDnn(input.dnn);
    if (dnnOwner && dnnOwner.id !== id) throw new Error(`A different profile already uses DNN "${input.dnn}"`);

    const profile: ApnProfile = { ...existing, ...input, id, updatedAt: new Date().toISOString() };
    await this.patchYamlConfigs(profile);
    await this.apnProfileRepo.update(id, profile);
    return profile;
  }

  // Promotes a derived (config-only) entry into a real, persisted profile —
  // smf.yaml/upf.yaml already match (that's how it was discovered), so this
  // is Mongo-only, no config write. Defaults the whole pool to the dynamic
  // range (static empty) since intent can't be inferred from existing
  // config alone — the operator narrows it afterward.
  async createFromDerived(dnn: string): Promise<ApnProfile> {
    const entries = await this.list();
    const derived = entries.find((e) => e.dnn === dnn && !e.persisted);
    if (!derived) throw new Error(`No derived (unsaved) DNN "${dnn}" found — it may already be a saved profile`);
    if (!derived.gateway) throw new Error(`DNN "${dnn}" has no matching UPF session with a gateway — cannot create a profile from it`);

    const range = cidrRange(derived.subnet);
    const now = new Date().toISOString();
    const profile: ApnProfile = {
      id: randomUUID(),
      dnn: derived.dnn,
      dev: derived.dev,
      subnet: derived.subnet,
      gateway: derived.gateway,
      qos: DEFAULT_QOS,
      staticRangeStart: null,
      staticRangeEnd: null,
      dynamicRangeStart: this.numToIpSkippingGateway(range.first, derived.gateway),
      dynamicRangeEnd: this.numToIp(range.last),
      createdAt: now,
      updatedAt: now,
    };
    await this.apnProfileRepo.create(profile);
    return profile;
  }

  // Mongo-only — never touches smf.yaml/upf.yaml or subscribers already
  // using this DNN. Removing the actual DNN/session stays a manual
  // SmfEditor.tsx/UpfEditor.tsx action, outside this feature's scope.
  async delete(id: string): Promise<void> {
    await this.apnProfileRepo.delete(id);
  }

  // Patches smf.yaml's and upf.yaml's session[] arrays in place — same
  // configRepo.loadX()/saveX() round-trip every other config editor in this
  // app already uses (saveRaw() merges the incoming doc over what's on
  // disk, so untouched fields survive). Finds by dnn for smf, by dev (then
  // dnn as a fallback) for upf; updates in place if found, pushes a new
  // entry otherwise.
  //
  // #30 follow-up: when the profile carries subnetV6/gatewayV6, ALSO writes
  // a second session pair for it — same dnn (smf side) / same dev (upf
  // side), IPv6 subnet+gateway — matching the real dual-stack pattern this
  // project's own live deployments already use by hand (one v4 + one v6
  // session sharing a dnn/dev). Previously these fields were display-only
  // (see apn-profile.ts's own now-stale comment) and never actually reached
  // either YAML file. The v6 session is matched by dnn/dev **and** an IPv6
  // subnet (`includes(':')`) so it never collides with the v4 entry above.
  private async patchYamlConfigs(profile: ApnProfile): Promise<void> {
    const smf = await this.configRepo.loadSmf();
    const smfRaw = (smf as any).rawYaml;
    const smfSessions: any[] = smfRaw?.smf?.session ?? [];
    const smfIdx = smfSessions.findIndex((s) => s?.dnn === profile.dnn && !String(s?.subnet ?? '').includes(':'));
    const smfEntry = { subnet: profile.subnet, gateway: profile.gateway, dnn: profile.dnn };
    if (smfIdx >= 0) smfSessions[smfIdx] = { ...smfSessions[smfIdx], ...smfEntry };
    else smfSessions.push(smfEntry);

    if (profile.subnetV6 && profile.gatewayV6) {
      const smfV6Idx = smfSessions.findIndex((s) => s?.dnn === profile.dnn && String(s?.subnet ?? '').includes(':'));
      const smfV6Entry = { subnet: profile.subnetV6, gateway: profile.gatewayV6, dnn: profile.dnn };
      if (smfV6Idx >= 0) smfSessions[smfV6Idx] = { ...smfSessions[smfV6Idx], ...smfV6Entry };
      else smfSessions.push(smfV6Entry);
    }
    if (smfRaw?.smf) smfRaw.smf.session = smfSessions;
    await this.configRepo.saveSmf({ ...(smf as any), rawYaml: smfRaw });

    const upf = await this.configRepo.loadUpf();
    const upfRaw = (upf as any).rawYaml;
    const upfSessions: any[] = upfRaw?.upf?.session ?? [];
    let upfIdx = upfSessions.findIndex((s) => (s?.dev || 'ogstun') === profile.dev && !String(s?.subnet ?? '').includes(':'));
    if (upfIdx < 0) upfIdx = upfSessions.findIndex((s) => s?.dnn === profile.dnn && !String(s?.subnet ?? '').includes(':'));
    const upfEntry = { subnet: profile.subnet, gateway: profile.gateway, dev: profile.dev, dnn: profile.dnn };
    if (upfIdx >= 0) upfSessions[upfIdx] = { ...upfSessions[upfIdx], ...upfEntry };
    else upfSessions.push(upfEntry);

    if (profile.subnetV6 && profile.gatewayV6) {
      let upfV6Idx = upfSessions.findIndex((s) => (s?.dev || 'ogstun') === profile.dev && String(s?.subnet ?? '').includes(':'));
      if (upfV6Idx < 0) upfV6Idx = upfSessions.findIndex((s) => s?.dnn === profile.dnn && String(s?.subnet ?? '').includes(':'));
      const upfV6Entry = { subnet: profile.subnetV6, gateway: profile.gatewayV6, dev: profile.dev, dnn: profile.dnn };
      if (upfV6Idx >= 0) upfSessions[upfV6Idx] = { ...upfSessions[upfV6Idx], ...upfV6Entry };
      else upfSessions.push(upfV6Entry);
    }
    if (upfRaw?.upf) upfRaw.upf.session = upfSessions;
    await this.configRepo.saveUpf({ ...(upf as any), rawYaml: upfRaw });
  }

  private validateInput(input: ApnProfileInput): void {
    if (!input.dnn?.trim()) throw new Error('dnn is required');
    if (!input.dev?.trim()) throw new Error('dev is required');
    let poolRange: { first: number; last: number };
    try {
      poolRange = cidrRange(input.subnet);
    } catch {
      throw new Error(`Invalid subnet CIDR: ${input.subnet}`);
    }

    const ranges: Array<{ label: string; start: string | null; end: string | null }> = [
      { label: 'static', start: input.staticRangeStart, end: input.staticRangeEnd },
      { label: 'dynamic', start: input.dynamicRangeStart, end: input.dynamicRangeEnd },
    ];
    const parsed: Array<{ label: string; first: number; last: number }> = [];
    for (const r of ranges) {
      if (!r.start && !r.end) continue;
      if (!r.start || !r.end) throw new Error(`${r.label} range needs both a start and an end address`);
      const first = ipToNum(r.start);
      const last = ipToNum(r.end);
      if (first > last) throw new Error(`${r.label} range start must not be after its end`);
      if (first < poolRange.first || last > poolRange.last) {
        throw new Error(`${r.label} range must fall within the pool ${input.subnet}`);
      }
      parsed.push({ label: r.label, first, last });
    }
    if (parsed.length === 2) {
      const [a, b] = parsed;
      if (a.first <= b.last && b.first <= a.last) {
        throw new Error('Static and dynamic ranges must not overlap');
      }
    }
  }

  private numToIp(n: number): string {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
  }

  // Derived-entry default dynamic range starts right after the gateway
  // address if the gateway is the very first host address in the pool
  // (the overwhelmingly common case), so the default range never silently
  // includes the gateway itself.
  private numToIpSkippingGateway(first: number, gateway: string): string {
    return first === ipToNum(gateway) ? this.numToIp(first + 1) : this.numToIp(first);
  }
}
