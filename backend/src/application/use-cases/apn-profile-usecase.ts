import { randomUUID } from 'crypto';
import pino from 'pino';
import { IApnProfileRepository } from '../../domain/interfaces/apn-profile-repository';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { ApnProfile, ApnProfileListEntry } from '../../domain/entities/apn-profile';
import { resolveDnnDevPairs } from '../../domain/services/dnn-dev-resolver';
import { ipToNum, cidrRange } from '../../domain/services/ip-utils';

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
    // depending on which order the two happen to appear in the file.
    const upfByDev = new Map<string, any>();
    for (const s of upfSessions) {
      const dev = s.dev || 'ogstun';
      const isV4 = s.subnet && !String(s.subnet).includes(':');
      if (!upfByDev.has(dev) || isV4) upfByDev.set(dev, s);
    }

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
    this.validateInput(input);
    const existing = await this.apnProfileRepo.findByDnn(input.dnn);
    if (existing) throw new Error(`A profile for DNN "${input.dnn}" already exists`);

    const now = new Date().toISOString();
    const profile: ApnProfile = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    await this.patchYamlConfigs(profile);
    await this.apnProfileRepo.create(profile);
    return profile;
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
  private async patchYamlConfigs(profile: ApnProfile): Promise<void> {
    const smf = await this.configRepo.loadSmf();
    const smfRaw = (smf as any).rawYaml;
    const smfSessions: any[] = smfRaw?.smf?.session ?? [];
    const smfIdx = smfSessions.findIndex((s) => s?.dnn === profile.dnn);
    const smfEntry = { subnet: profile.subnet, gateway: profile.gateway, dnn: profile.dnn };
    if (smfIdx >= 0) smfSessions[smfIdx] = { ...smfSessions[smfIdx], ...smfEntry };
    else smfSessions.push(smfEntry);
    if (smfRaw?.smf) smfRaw.smf.session = smfSessions;
    await this.configRepo.saveSmf({ ...(smf as any), rawYaml: smfRaw });

    const upf = await this.configRepo.loadUpf();
    const upfRaw = (upf as any).rawYaml;
    const upfSessions: any[] = upfRaw?.upf?.session ?? [];
    let upfIdx = upfSessions.findIndex((s) => (s?.dev || 'ogstun') === profile.dev);
    if (upfIdx < 0) upfIdx = upfSessions.findIndex((s) => s?.dnn === profile.dnn);
    const upfEntry = { subnet: profile.subnet, gateway: profile.gateway, dev: profile.dev, dnn: profile.dnn };
    if (upfIdx >= 0) upfSessions[upfIdx] = { ...upfSessions[upfIdx], ...upfEntry };
    else upfSessions.push(upfEntry);
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
