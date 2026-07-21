import { v4 as uuidv4 } from 'uuid';
import { Collection, MongoClient } from 'mongodb';
import pino from 'pino';
import {
  SasCbsd, SasGrant, SasConfig, SasFrequencyBand,
  RegistrationRequest, RegistrationResponse,
  SpectrumInquiryRequest, SpectrumInquiryResponse, AvailableChannel,
  GrantRequest, GrantResponse,
  HeartbeatRequest, HeartbeatResponse,
  RelinquishmentRequest, RelinquishmentResponse,
  DeregistrationRequest, DeregistrationResponse,
  RC, makeResponse, sasFmt,
  GroupBandPolicy, CbsdBandPolicy,
} from './sas-types';

// ─── Band 48 EARFCN helpers (3GPP TS 36.101) ────────────────────────────────
// F_MHz = 3550 + 0.1 × (EARFCN - 55240)
// EARFCN range: 55240 (3550 MHz) to 56739 (3699.9 MHz)
function earfcnToMhz(earfcn: number): number {
  return 3550 + 0.1 * (earfcn - 55240);
}
function earfcnToHz(earfcn: number): number {
  return Math.round(earfcnToMhz(earfcn) * 1e6);
}
function hzToEarfcn(hz: number): number {
  return Math.round(55240 + (hz / 1e6 - 3550) * 10);
}

// ─── NR n48 NR-ARFCN helpers (3GPP TS 38.104, FR1 3000–24250 MHz) ────────────
// F_MHz = 3000 + 0.015 × (NR-ARFCN - 600000)
// NR-ARFCN = (F_MHz - 3000) / 0.015 + 600000
// Step = 15 kHz; range: 620000 (3300 MHz) to 653333 (3800 MHz)
function hzToNrArfcn(hz: number): number {
  return Math.round((hz / 1e6 - 3000) / 0.015 + 600000);
}

// Pick the correct ARFCN display label based on radioTechnology
function cbsdArfcn(centerHz: number, radioTech?: string): { label: string; value: number } {
  if (radioTech === 'NR') return { label: 'NR-ARFCN', value: hzToNrArfcn(centerHz) };
  return { label: 'EARFCN', value: hzToEarfcn(centerHz) };
}

const CBRS_LOW  = 3_550_000_000;  // EARFCN 55240
const CBRS_HIGH = 3_700_000_000;  // EARFCN 56740

export class SasService {
  private cbsds!:        Collection<SasCbsd>;
  private grants!:        Collection<SasGrant>;
  private configs!:       Collection<SasConfig>;
  private groupPolicies!: Collection<GroupBandPolicy>;
  private cbsdPolicies!:  Collection<CbsdBandPolicy>;
  // NOTE: despite the field name (kept for API/frontend backward-compat — the
  // REST contract and UI still speak in live cbsdIds), the array stored here
  // holds "fccId:serial" keys, not raw cbsdId values. Found live (2026-07-20):
  // a radio's cbsdId regenerates on every re-registration (confirmed for both
  // Nokia sectors and, separately, Baicells — see sas_baicells_slots' own
  // comment for the same root cause), so a manual group that stored raw
  // cbsdIds silently lost track of its members on every reboot — the exact
  // same class of bug already fixed for sas_baicells_slots and
  // sas_cbsd_policies by keying on fccId:serial instead, just never applied
  // here. setManualGroup()/listManualGroups() do the cbsdId<->fccId:serial
  // translation at the API boundary so callers never see the difference.
  private manualGroups!:  Collection<{ _id: string; cbsdIds: string[]; updatedAt: Date }>;
  // Sticky per-radio slot assignment — Baicells ("baicells" group) only. See
  // assignChannelSlot() for why this group needs a persistent assignment
  // instead of the generic index-into-sorted-registered-list approach.
  private baicellsSlots!: Collection<{ _id: string; bandId: string; slotIdx: number; cbsdId: string; assignedAt: Date }>;
  private ready = false;

  constructor(
    private readonly mongoUri: string,
    private readonly logger:   pino.Logger,
  ) {}

  async initialize(): Promise<void> {
    const client = new MongoClient(this.mongoUri);
    await client.connect();
    const db = client.db('open5gs');
    this.cbsds        = db.collection<SasCbsd>('sas_cbsds');
    this.grants        = db.collection<SasGrant>('sas_grants');
    this.configs       = db.collection<SasConfig>('sas_configs');
    this.groupPolicies = db.collection<GroupBandPolicy>('sas_group_policies');
    this.cbsdPolicies  = db.collection<CbsdBandPolicy>('sas_cbsd_policies');
    this.manualGroups  = db.collection('sas_manual_groups');
    await this.manualGroups.createIndex({ cbsdIds: 1 });
    this.baicellsSlots = db.collection('sas_baicells_slots');
    await this.baicellsSlots.createIndex({ bandId: 1 });

    await this.cbsds.createIndex({ cbsdId: 1 },                     { unique: true });
    await this.cbsds.createIndex({ cbsdSerialNumber: 1, fccId: 1 });
    await this.grants.createIndex({ grantId: 1 },                   { unique: true });
    await this.grants.createIndex({ cbsdId: 1 });
    await this.grants.createIndex({ grantExpireTime: 1 });

    const existing = await this.configs.findOne({ _id: 'sas_config' });
    if (!existing) {
      await this.configs.insertOne({
        _id:                      'sas_config',
        allowedBandLow:           CBRS_LOW,
        allowedBandHigh:          CBRS_HIGH,
        maxEirpGAA:               30,
        heartbeatInterval:        240,
        grantExpireHours:         24,
        defaultGrantBandwidthMhz: 20,
        autoApprove:              true,
        frequencyBands: [
          {
            // Full CBRS band: EARFCN 55240 (3550 MHz) to 56739 (3699.9 MHz)
            id:              uuidv4(),
            label:           'Full CBRS Band (fallback)',
            lowFrequency:    earfcnToHz(55240),  // 3550 MHz
            highFrequency:   earfcnToHz(56739),  // 3699.9 MHz
            maxBandwidthMhz: 20,
          },
          {
            // Baicells valid EARFCN range: 55340 (3560 MHz) to 56640 (3690 MHz)
            id:              uuidv4(),
            label:           'Baicells (EARFCN 55340–56640)',
            lowFrequency:    earfcnToHz(55340),  // 3560 MHz
            highFrequency:   earfcnToHz(56640),  // 3690 MHz
            maxBandwidthMhz: 20,
          },
        ],
        updatedAt:                new Date(),
      });
    }

    this.ready = true;
    this.logger.info('SAS service initialized');
  }

  // ─── Last request tracker (in-memory, debug tool) ──────────────────────
  // Stores the most recent frequency range each CBSD requested.
  // Keyed by cbsdId. Used by the Freq Debug view on the dashboard.
  private lastRequests = new Map<string, {
    serial:        string;
    fccId:         string;
    ip:            string;
    lowFrequency:  number;
    highFrequency: number;
    type:          'spectrumInquiry' | 'grant';
    radioTech?:    string;
    ts:            Date;
  }>();

  // Cache of CA channel pairs per cbsdId — populated from narrow CA inquiries
  // Used to return matching channels in wide scan responses for Sercomm CA
  private caChannelCache = new Map<string, Array<{ low: number; high: number }>>();

  recordLastRequest(
    cbsdId:    string,
    serial:    string,
    fccId:     string,
    ip:        string,
    low:       number,
    high:      number,
    type:      'spectrumInquiry' | 'grant',
    radioTech?: string,
  ): void {
    this.lastRequests.set(cbsdId, { serial, fccId, ip, lowFrequency: low, highFrequency: high, type, radioTech, ts: new Date() });
  }

  getLastRequests(): Array<{
    cbsdId:        string;
    serial:        string;
    fccId:         string;
    ip:            string;
    lowFrequency:  number;
    highFrequency: number;
    type:          string;
    radioTech?:    string;
    ts:            Date;
  }> {
    return Array.from(this.lastRequests.entries()).map(([cbsdId, v]) => ({ cbsdId, ...v }));
  }

  // ─── Channel slot assignment ──────────────────────────────────────────────
  // Divides the configured band into equal slots and assigns each CBSD a unique
  // non-overlapping slot within its interference coordination group.
  // Radios in the same groupId never share a slot — prevents co-site interference.
  private computeSlots(band: SasFrequencyBand, slotWidthHz: number): Array<{ low: number; high: number }> {
    const slots: Array<{ low: number; high: number }> = [];
    let cursor = band.lowFrequency;
    while (cursor + slotWidthHz <= band.highFrequency + 1) {
      slots.push({ low: cursor, high: cursor + slotWidthHz });
      cursor += slotWidthHz;
    }
    return slots;
  }

  private async assignChannelSlot(
    cbsdId:    string,
    groupId:   string | undefined,
    band:      SasFrequencyBand,
    slotWidthHz: number,
  ): Promise<{ low: number; high: number }> {
    // Baicells radios only ("baicells" group — the literal groupId the
    // radios themselves report at registration, see groupingParam). The
    // generic assignment further below computes a slot from this CBSD's
    // position in the list of CURRENTLY REGISTERED group members, sorted by
    // serial — that list isn't stable, since Baicells radios reboot/
    // re-register intermittently (see the GPS lock delay handling above).
    // Every register/deregister shifts everyone else's position in it, so
    // two radios computing their slot against different snapshots of "who's
    // online right now" can land on the identical slot despite
    // computeSlots() giving each of them a distinct EARFCN — reproduced
    // live: two Baicells radios both ended up AUTHORIZED on the same
    // 3580-3600 MHz slot. Fixed here by persisting each radio's slot
    // assignment permanently (keyed by fccId:serial, so it's stable across
    // reboots and even a full SAS "Clear DB") the first time it's granted,
    // and never handing that slot to a different radio afterward — the next
    // radio to ask gets the next free slot instead. Scoped strictly to
    // groupId === 'baicells'; every other group (Sercomm, custom-slot
    // groups, ungrouped) falls through to the exact unchanged logic below.
    if (groupId === 'baicells') {
      const slots = this.computeSlots(band, slotWidthHz);
      if (slots.length === 0) return { low: band.lowFrequency, high: band.highFrequency };
      if (slots.length === 1) return slots[0];

      const cbsd = await this.cbsds.findOne({ cbsdId });
      const key  = cbsd ? `${cbsd.fccId}:${cbsd.cbsdSerialNumber}` : cbsdId;

      const existing = await this.baicellsSlots.findOne({ _id: key, bandId: band.id });
      if (existing && existing.slotIdx < slots.length) {
        return slots[existing.slotIdx];
      }

      // Bug found live (2026-07-20): the old loop bound `slotIdx < slots.length - 1`
      // stops advancing once slotIdx reaches the LAST index, even if that last slot
      // is itself held — it then silently returns that (already-occupied) index
      // instead of recognizing "no free slot." A 3rd radio arriving when only 2 of
      // N slots were actually free (e.g. because the group's band policy was
      // temporarily misconfigured, narrowing the usable slot count) collided with
      // whichever radio already held the last slot, producing two CBSDs authorized
      // on the identical frequency range. Counting occupancy per slot instead: pick
      // the first genuinely free slot, or if none exists, the least-occupied one
      // (explicit, deterministic sharing) rather than an incidental collision.
      const assignments = (await this.baicellsSlots.find({ bandId: band.id }).toArray())
        .filter(a => a.slotIdx < slots.length);
      const counts = new Array(slots.length).fill(0);
      for (const a of assignments) counts[a.slotIdx]++;

      let slotIdx = counts.indexOf(0);
      if (slotIdx === -1) {
        slotIdx = counts.indexOf(Math.min(...counts));
        this.logger.warn(
          { cbsdId, key, bandId: band.id, slotIdx, totalSlots: slots.length, radioCount: assignments.length + 1 },
          'Baicells slots exhausted for this band — sharing least-occupied slot',
        );
      }

      const assignment = { _id: key, bandId: band.id, slotIdx, cbsdId, assignedAt: new Date() };
      await this.baicellsSlots.replaceOne({ _id: key }, assignment, { upsert: true });
      this.logger.info({ cbsdId, key, bandId: band.id, slotIdx, totalSlots: slots.length }, 'Stable Baicells slot assigned');
      return slots[slotIdx];
    }

    // customSlots-based deterministic assignment — per explicit user requirement
    // (2026-07-21), this only ever activates when the effective group is BOTH
    // (a) present in sas_manual_groups (an operator actually created it through
    // the manual-group UI, not just a groupId string a radio happens to report)
    // AND (b) has a non-empty customSlots array on its policy. Matches the same
    // rule the narrow-request enforcement in spectrumInquiry()/grant() already
    // uses. Previously this checked customSlots alone, with no manual-group
    // requirement — harmless today (no native group currently has customSlots
    // set) but a latent trap: setting customSlots on a native group's policy
    // (e.g. for display/documentation) would have silently started constraining
    // any wide-request radio in that group too.
    const manualGroup = groupId ? await this.manualGroups.findOne({ _id: groupId }) : null;
    const groupPolicy = manualGroup ? await this.groupPolicies.findOne({ _id: groupId }) : null;
    if (Array.isArray(groupPolicy?.customSlots)) {
      // customSlots = [] means give the FULL band to every CBSD (no slicing)
      if (groupPolicy.customSlots.length === 0) {
        return { low: band.lowFrequency, high: band.highFrequency };
      }
      // Custom slots defined — assign deterministically by serial index
      const slots = groupPolicy.customSlots;
      if (slots.length === 1) return { low: slots[0].low, high: slots[0].high };
      const allCbsds   = await this.cbsds.find({ state: 'REGISTERED' }).toArray();
      const groupCbsds = allCbsds.filter(c =>
        c.groupingParam?.some(p => p.groupType === 'INTERFERENCE_COORDINATION' && p.groupId === groupId)
      );
      // Also include CBSDs manually assigned to this group — manualGroups.cbsdIds
      // holds fccId:serial keys (see the field's own comment), not raw cbsdId.
      const manualKeys = new Set(manualGroup?.cbsdIds ?? []);
      const allGroupCbsds = [...groupCbsds, ...allCbsds.filter(c => manualKeys.has(`${c.fccId}:${c.cbsdSerialNumber}`) && !groupCbsds.find(g => g.cbsdId === c.cbsdId))];
      const sorted  = [...allGroupCbsds].sort((a, b) =>
        (a.cbsdSerialNumber ?? a.cbsdId).localeCompare(b.cbsdSerialNumber ?? b.cbsdId)
      );
      const idx     = sorted.findIndex(c => c.cbsdId === cbsdId);
      const slotIdx = idx >= 0 ? idx % slots.length : 0;
      return { low: slots[slotIdx].low, high: slots[slotIdx].high };
    }
    // Default: auto-compute equal-width slots from maxBandwidthMhz
    const slots = this.computeSlots(band, slotWidthHz);
    if (slots.length === 0) return { low: band.lowFrequency, high: band.highFrequency };
    if (slots.length === 1) return slots[0];

    const allCbsds = await this.cbsds.find({ state: 'REGISTERED' }).toArray();
    const groupCbsds = groupId
      ? allCbsds.filter(c =>
          c.groupingParam?.some(
            p => p.groupType === 'INTERFERENCE_COORDINATION' && p.groupId === groupId,
          )
        )
      : allCbsds;
    const sorted  = [...groupCbsds].sort((a, b) =>
      (a.cbsdSerialNumber ?? a.cbsdId).localeCompare(b.cbsdSerialNumber ?? b.cbsdId)
    );
    const idx     = sorted.findIndex(c => c.cbsdId === cbsdId);
    const slotIdx = idx >= 0 ? idx % slots.length : 0;
    this.logger.info({ cbsdId, serial: sorted[idx]?.cbsdSerialNumber, groupId, slotIdx, total: sorted.length, slots: slots.length, allSerials: sorted.map(c => c.cbsdSerialNumber) }, 'Deterministic slot assigned');
    return slots[slotIdx];
  }

  // ─── Find best matching frequency band for a requested range ─────────────────
  // Returns the most specific band whose range contains the request,
  // or falls back to the legacy allowedBandLow/High if no bands configured.
  private findMatchingBand(cfg: SasConfig, reqLow: number, reqHigh: number): SasFrequencyBand | null {
    const bands = cfg.frequencyBands ?? [];
    if (bands.length === 0) {
      // Legacy fallback
      return {
        id:              'legacy',
        label:           'Default',
        lowFrequency:    cfg.allowedBandLow,
        highFrequency:   cfg.allowedBandHigh,
        maxBandwidthMhz: cfg.defaultGrantBandwidthMhz ?? 20,
      };
    }

    // Find bands that contain the requested range (at least partially)
    const overlapping = bands.filter(b =>
      reqLow < b.highFrequency && reqHigh > b.lowFrequency,
    );
    if (overlapping.length === 0) return null;

    // Pick the band with the smallest range (most specific match)
    return overlapping.sort(
      (a, b) => (a.highFrequency - a.lowFrequency) - (b.highFrequency - b.lowFrequency),
    )[0];
  }

  // ─── Resolve effective group ID for a CBSD ─────────────────────────────────
  // Manual group assignments take priority over what the radio sent at registration.
  private async resolveGroupId(cbsd: SasCbsd): Promise<string | undefined> {
    const manual = await this.manualGroups.findOne({ cbsdIds: `${cbsd.fccId}:${cbsd.cbsdSerialNumber}` });
    if (manual) return manual._id;
    return cbsd.groupingParam?.find(p => p.groupType === 'INTERFERENCE_COORDINATION')?.groupId;
  }

  // ─── 3-level band resolution ──────────────────────────────────────────────────────────────
  // Priority: CBSD override > group policy > findMatchingBand (global)
  private async resolveBand(
    cfg:     SasConfig,
    cbsd:    SasCbsd,
    reqLow:  number,
    reqHigh: number,
  ): Promise<SasFrequencyBand | null> {
    const bands = cfg.frequencyBands ?? [];
    // 1 — Per-CBSD override (keyed by fccId:serial, survives Clear DB)
    const cbsdKey    = `${cbsd.fccId}:${cbsd.cbsdSerialNumber}`;
    const cbsdPolicy = await this.cbsdPolicies.findOne({ _id: cbsdKey });
    if (cbsdPolicy) {
      const band = bands.find(b => b.id === cbsdPolicy.bandId);
      if (band) { this.logger.trace({ cbsdId: cbsd.cbsdId, bandId: band.id, label: band.label }, 'Band resolved via CBSD override'); return band; }
    }
    // 2 — Interference group policy (manual override takes priority over registered groupingParam)
    const groupId = await this.resolveGroupId(cbsd);
    if (groupId) {
      const groupPolicy = await this.groupPolicies.findOne({ _id: groupId });
      if (groupPolicy) {
        const band = bands.find(b => b.id === groupPolicy.bandId);
        if (band) { this.logger.trace({ cbsdId: cbsd.cbsdId, groupId, bandId: band.id, label: band.label }, 'Band resolved via group policy'); return band; }
      }
    }
    // 3 — Global: best-matching band for the requested range
    return this.findMatchingBand(cfg, reqLow, reqHigh);
  }

  // ─── Policy CRUD ──────────────────────────────────────────────────────────────────────
  // Translates stored fccId:serial keys back to whichever cbsdId currently
  // holds that serial (if the radio is presently registered) — the REST API/
  // frontend deal exclusively in cbsdId, never fccId:serial. A member whose
  // radio isn't currently registered under that fccId:serial is simply
  // omitted (same as today's behavior when a stored id doesn't resolve).
  async listManualGroups(): Promise<Array<{ _id: string; cbsdIds: string[]; updatedAt: Date }>> {
    const [groups, allCbsds] = await Promise.all([
      this.manualGroups.find({}).toArray(),
      this.cbsds.find({}).toArray(),
    ]);
    const cbsdIdByKey = new Map(allCbsds.map(c => [`${c.fccId}:${c.cbsdSerialNumber}`, c.cbsdId]));
    return groups.map(g => ({
      ...g,
      cbsdIds: g.cbsdIds.map(key => cbsdIdByKey.get(key)).filter((id): id is string => !!id),
    }));
  }

  async setManualGroup(groupId: string, cbsdIds: string[]): Promise<{ _id: string; cbsdIds: string[]; updatedAt: Date }> {
    // Translate the incoming live cbsdIds to stable fccId:serial keys before
    // persisting — see the manualGroups field comment for why. Falls back to
    // storing the raw cbsdId for one that doesn't currently resolve to a
    // known CBSD (best-effort rather than silently dropping it).
    const members = await Promise.all(cbsdIds.map(async id => {
      const cbsd = await this.cbsds.findOne({ cbsdId: id });
      return cbsd ? `${cbsd.fccId}:${cbsd.cbsdSerialNumber}` : id;
    }));
    const doc = { _id: groupId, cbsdIds: members, updatedAt: new Date() };
    await this.manualGroups.replaceOne({ _id: groupId }, doc, { upsert: true });
    this.logger.info({ groupId, cbsdIds, members }, 'Manual group set');
    return { ...doc, cbsdIds };
  }

  async deleteManualGroup(groupId: string): Promise<boolean> {
    return (await this.manualGroups.deleteOne({ _id: groupId })).deletedCount > 0;
  }

  async listGroupPolicies(): Promise<GroupBandPolicy[]> { return this.groupPolicies.find({}).toArray(); }
  async setGroupPolicy(groupId: string, bandId: string, notes?: string, customSlots?: import('./sas-types').GroupBandSlot[]): Promise<GroupBandPolicy> {
    const p: GroupBandPolicy = { _id: groupId, bandId, notes, customSlots, updatedAt: new Date() };
    await this.groupPolicies.replaceOne({ _id: groupId }, p, { upsert: true });
    this.logger.info({ groupId, bandId, customSlots: customSlots?.length ?? 'auto' }, 'Group band policy set'); return p;
  }
  async deleteGroupPolicy(groupId: string): Promise<boolean> {
    return (await this.groupPolicies.deleteOne({ _id: groupId })).deletedCount > 0;
  }
  async listCbsdPolicies(): Promise<CbsdBandPolicy[]> { return this.cbsdPolicies.find({}).toArray(); }
  async setCbsdPolicy(fccId: string, serial: string, bandId: string, notes?: string): Promise<CbsdBandPolicy> {
    const key = `${fccId}:${serial}`;
    const p: CbsdBandPolicy = { _id: key, fccId, serial, bandId, notes, updatedAt: new Date() };
    await this.cbsdPolicies.replaceOne({ _id: key }, p, { upsert: true });
    this.logger.info({ key, bandId }, 'CBSD band policy set'); return p;
  }
  async deleteCbsdPolicy(fccId: string, serial: string): Promise<boolean> {
    return (await this.cbsdPolicies.deleteOne({ _id: `${fccId}:${serial}` })).deletedCount > 0;
  }

  // ─── GPS lock delay ───────────────────────────────────────────────────────
  // Baicells BaiBLQ firmware re-grants after GPS locks (~30-45s after boot).
  // Track by serial number so re-registrations don't reset the clock.
  private firstSeenTime = new Map<string, number>(); // fccId:serial -> timestamp ms
  private static GPS_LOCK_DELAY_MS = 75_000; // 75 seconds — covers GPS lock window

  private gpsDelayKey(fccId: string, serial: string): string {
    return `${fccId}:${serial}`;
  }

  private recordFirstSeen(fccId: string, serial: string): void {
    const key = this.gpsDelayKey(fccId, serial);
    if (!this.firstSeenTime.has(key)) {
      this.firstSeenTime.set(key, Date.now());
      this.logger.info({ fccId, serial }, 'GPS delay clock started');
    }
  }

  private msSinceFirstSeen(fccId: string, serial: string): number {
    const key = this.gpsDelayKey(fccId, serial);
    const t = this.firstSeenTime.get(key);
    if (!t) return SasService.GPS_LOCK_DELAY_MS; // unknown — allow through
    return Date.now() - t;
  }

  // ─── Config ───────────────────────────────────────────────────────────────
  async getConfig(): Promise<SasConfig> {
    const cfg = await this.configs.findOne({ _id: 'sas_config' });
    if (!cfg) throw new Error('SAS config not found');
    return cfg;
  }

  async updateConfig(patch: Partial<Omit<SasConfig, '_id' | 'updatedAt'>>): Promise<SasConfig> {
    await this.configs.updateOne(
      { _id: 'sas_config' },
      { $set: { ...patch, updatedAt: new Date() } },
      { upsert: true },
    );
    return this.getConfig();
  }

  // ─── Registration (section 8.3) ───────────────────────────────────────────
  async registration(requests: RegistrationRequest[]): Promise<RegistrationResponse[]> {
    const responses: RegistrationResponse[] = [];

    for (const req of requests) {
      if (!req.userId || !req.fccId || !req.cbsdSerialNumber) {
        const missing = ['userId', 'fccId', 'cbsdSerialNumber'].filter(k => !(req as any)[k]);
        responses.push({ response: makeResponse(RC.MISSING_PARAM, missing) });
        continue;
      }

      const existing = await this.cbsds.findOne({
        cbsdSerialNumber: req.cbsdSerialNumber,
        fccId:            req.fccId,
      });

      if (existing) {
        await this.grants.deleteMany({ cbsdId: existing.cbsdId });
        await this.cbsds.updateOne(
          { cbsdId: existing.cbsdId },
          { $set: {
            userId:            req.userId,
            cbsdCategory:      req.cbsdCategory      ?? existing.cbsdCategory,
            airInterface:      req.airInterface       ?? existing.airInterface,
            installationParam: req.installationParam  ?? existing.installationParam,
            measCapability:    req.measCapability     ?? existing.measCapability,
            groupingParam:     req.groupingParam      ?? existing.groupingParam,
            state:             'REGISTERED' as const,
            lastSeen:          new Date(),
          }},
        );
        responses.push({ cbsdId: existing.cbsdId, response: makeResponse(RC.SUCCESS) });
        this.logger.info({ cbsdId: existing.cbsdId }, 'CBSD re-registered');
        this.recordFirstSeen(req.fccId, req.cbsdSerialNumber);
      } else {
        const cbsdId = uuidv4();
        await this.cbsds.insertOne({
          cbsdId,
          cbsdSerialNumber:  req.cbsdSerialNumber,
          fccId:             req.fccId,
          userId:            req.userId,
          cbsdCategory:      req.cbsdCategory ?? 'A',
          state:             'REGISTERED',
          airInterface:      req.airInterface,
          installationParam: req.installationParam,
          measCapability:    req.measCapability,
          groupingParam:     req.groupingParam,
          registeredAt:      new Date(),
          lastSeen:          new Date(),
        });
        responses.push({ cbsdId, response: makeResponse(RC.SUCCESS) });
        this.logger.info({ cbsdId, fccId: req.fccId, serial: req.cbsdSerialNumber }, 'CBSD registered');
        this.recordFirstSeen(req.fccId, req.cbsdSerialNumber);
      }
    }

    return responses;
  }

  // ─── Spectrum Inquiry (section 8.4) ──────────────────────────────────────
  async spectrumInquiry(requests: SpectrumInquiryRequest[]): Promise<SpectrumInquiryResponse[]> {
    const cfg       = await this.getConfig();
    const responses: SpectrumInquiryResponse[] = [];

    for (const req of requests) {
      if (!req.cbsdId) {
        responses.push({ response: makeResponse(RC.MISSING_PARAM, ['cbsdId']) });
        continue;
      }

      const cbsd = await this.cbsds.findOne({ cbsdId: req.cbsdId, state: 'REGISTERED' });
      if (!cbsd) {
        // CBSD unknown — tell radio to re-register from scratch (RC 105 DEREGISTER)
        responses.push({ response: makeResponse(RC.DEREGISTER) });
        continue;
      }

      let unsupported = false;
      for (const fr of req.inquiredSpectrum ?? []) {
        // Record last requested freq for debug view
        this.recordLastRequest(req.cbsdId, cbsd.cbsdSerialNumber, cbsd.fccId, '', fr.lowFrequency, fr.highFrequency, 'spectrumInquiry', cbsd.airInterface?.radioTechnology);
        // Check using 3-level resolution: CBSD override > group policy > global bands
        const resolvedBand = await this.resolveBand(cfg, cbsd, fr.lowFrequency, fr.highFrequency);
        if (!resolvedBand) {
          responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.UNSUPPORTED_SPECTRUM) });
          unsupported = true;
          break;
        }
      }
      if (unsupported) continue;

      // Return one availableChannel per inquired spectrum entry.
      // WInnForum spec: the SAS returns what's available in each inquired range.
      //
      // Two cases:
      // 1. Wide inquiry (radio asking for full band, e.g. Baicells 3560–3620 MHz):
      //    Return the entire band — the radio will pick a frequency and request a grant.
      //    Slot assignment happens deterministically at grant time.
      //
      // 2. Narrow inquiry (radio asking for a specific channel, e.g. Sercomm CA
      //    sending two 20 MHz entries, one per carrier):
      //    Return the specific slot that overlaps the inquired range so the
      //    radio knows exactly which channel it will get.
      const availableChannels: AvailableChannel[] = [];

      // Strict allow-list enforcement, per explicit user requirement
      // (2026-07-20): resolve this CBSD's exact allow-list of custom slots
      // once, reused for every inquired entry below, so spectrumInquiry never
      // advertises a frequency that grant() would then reject (see the
      // matching enforcement there). Deliberately NOT vendor-gated — scoped
      // instead to a purely structural condition: the CBSD's effective group
      // must be a group the operator actually created through the manual-
      // group UI (present in sas_manual_groups, not just a groupId string a
      // radio happens to send in its own groupingParam) AND that group must
      // have customSlots configured. Both are explicit, deliberate operator
      // actions, so this only ever fires when someone has actually built a
      // manual group with an exact slot allow-list — never as a blanket
      // default for a vendor. A native, radio-reported group (e.g. Sercomm's
      // SC_Group/SERCOMM_5G) is never a manual-group document, so it's
      // naturally excluded even if it happens to have customSlots too —
      // important because Sercomm's own narrow CA requests are expected to
      // land a few hundred kHz off the slot boundary (see the comment below),
      // which strict allow-list matching would incorrectly reject.
      let strictAllowedSlots: Array<{ low: number; high: number; label?: string }> | undefined;
      const effectiveGroup = await this.resolveGroupId(cbsd);
      if (effectiveGroup) {
        const manualGroup = await this.manualGroups.findOne({ _id: effectiveGroup });
        if (manualGroup) {
          const groupPolicy = await this.groupPolicies.findOne({ _id: effectiveGroup });
          if (Array.isArray(groupPolicy?.customSlots) && groupPolicy.customSlots.length > 0) {
            strictAllowedSlots = groupPolicy.customSlots;
          }
        }
      }

      // Detect if this is a CA narrow inquiry (multiple entries each <= slotWidth)
      const allEntries = req.inquiredSpectrum ?? [];
      const isNarrowCA = allEntries.length > 1;

      // Cache narrow CA inquiry channels for Sercomm so the wide scan can echo them back
      if (isNarrowCA && cbsd.fccId?.startsWith('P27-')) {
        const band0 = await this.resolveBand(cfg, cbsd, allEntries[0].lowFrequency, allEntries[0].highFrequency);
        if (band0) {
          const slotW = (band0.maxBandwidthMhz ?? 20) * 1_000_000;
          const narrowEntries = allEntries.filter(e => (e.highFrequency - e.lowFrequency) <= slotW * 1.1);
          if (narrowEntries.length > 1) {
            this.caChannelCache.set(req.cbsdId, narrowEntries.map(e => ({
              low:  Math.max(e.lowFrequency,  band0.lowFrequency),
              high: Math.min(e.highFrequency, band0.highFrequency),
            })));
          }
        }
      }

      for (const fr of allEntries) {
        const band = await this.resolveBand(cfg, cbsd, fr.lowFrequency, fr.highFrequency);
        if (!band) continue;
        const slotWidthHz = (band.maxBandwidthMhz ?? 20) * 1_000_000;
        const inquiredWidthHz = fr.highFrequency - fr.lowFrequency;

        if (inquiredWidthHz <= slotWidthHz * 1.1) {
          // Narrow inquiry — echo back the exact requested range clamped to band.
          // If the inquiry falls outside the radio's assigned band, clamp to band
          // boundaries so the radio gets redirected to valid spectrum rather than
          // echoing back an out-of-band frequency that will fail at grant time.
          const overlaps = fr.lowFrequency < band.highFrequency && fr.highFrequency > band.lowFrequency;
          if (overlaps && strictAllowedSlots) {
            // A manual group with an exact allow-list configured: only
            // advertise a channel if this entry actually overlaps one of the
            // allowed slots — otherwise omit it (same as an out-of-band
            // entry) so the radio never sees "available" for a frequency
            // grant() would then reject.
            const matched = strictAllowedSlots.find(s => fr.lowFrequency < s.high && fr.highFrequency > s.low);
            if (matched) {
              availableChannels.push({
                frequencyRange: { lowFrequency: matched.low, highFrequency: matched.high },
                channelType: 'GAA' as const,
                ruleApplied: 'FCC_PART_96',
                maxEirp:     band.maxEirp ?? cfg.maxEirpGAA,
              });
            }
          } else if (overlaps) {
            availableChannels.push({
              frequencyRange: {
                lowFrequency:  Math.max(fr.lowFrequency,  band.lowFrequency),
                highFrequency: Math.min(fr.highFrequency, band.highFrequency),
              },
              channelType: 'GAA' as const,
              ruleApplied: 'FCC_PART_96',
              maxEirp:     band.maxEirp ?? cfg.maxEirpGAA,
            });
          } else if (cbsd.fccId?.startsWith('NOKIAPICOBTS')) {
            // Nokia only: skip out-of-band entries entirely instead of the
            // generic index-based redirect below. Confirmed live (2026-07-20):
            // Nokia's SAS client tiles a full-band scan into 15 separate 10MHz
            // inquiredSpectrum entries (not a real CA request) — the redirect
            // math (`band.lowFrequency + entryIndex*slotWidthHz`) assumes a
            // small, fixed entry count like Sercomm's always-exactly-2-entry CA
            // pattern, and for entryIndex=12+ it ran straight past the assigned
            // band and even past the whole 3550-3700MHz CBRS range (as far as
            // 4150MHz), producing zero-width or inverted (low>high) "available
            // channels" that the radio couldn't act on — it never proceeded to
            // a grant request afterward. Nokia's own in-band entries (the ones
            // that DO overlap its assigned band) already carry everything it
            // needs to pick a valid frequency, so out-of-band ones are simply
            // omitted rather than redirected. Strictly scoped to Nokia's FCC ID
            // prefix — every other vendor keeps the exact original redirect
            // behavior below, unchanged.
          } else {
            // Inquiry is entirely outside this band — redirect to the correct slot
            // within the assigned band, offset by entry index so CA gets two
            // distinct non-overlapping slots rather than the same slot twice.
            const entryIndex = allEntries.indexOf(fr);
            const slotStart  = band.lowFrequency + entryIndex * slotWidthHz;
            const slotEnd    = Math.min(slotStart + slotWidthHz, band.highFrequency);
            this.logger.info({ cbsdId: req.cbsdId, reqLow: fr.lowFrequency, reqHigh: fr.highFrequency, bandLow: band.lowFrequency, slotStart, slotEnd, entryIndex }, 'CA inquiry outside assigned band — redirecting to band slot');
            availableChannels.push({
              frequencyRange: { lowFrequency: slotStart, highFrequency: slotEnd },
              channelType: 'GAA' as const,
              ruleApplied: 'FCC_PART_96',
              maxEirp:     band.maxEirp ?? cfg.maxEirpGAA,
            });
          }
        } else if (cbsd.fccId?.startsWith('P27-')) {
          // Sercomm wide scan: return the full band as a single channel.
          // The narrow CA inquiry immediately follows and the radio uses that
          // result for grant requests. UNSUPPORTED_SPECTRUM causes deregistration.
          availableChannels.push({
            frequencyRange: { lowFrequency: band.lowFrequency, highFrequency: band.highFrequency },
            channelType: 'GAA' as const,
            ruleApplied: 'FCC_PART_96',
            maxEirp:     band.maxEirp ?? cfg.maxEirpGAA,
          });
        } else {
          // Baicells wide scan: return whole band
          availableChannels.push({
            frequencyRange: { lowFrequency: band.lowFrequency, highFrequency: band.highFrequency },
            channelType: 'GAA' as const,
            ruleApplied: 'FCC_PART_96',
            maxEirp:     band.maxEirp ?? cfg.maxEirpGAA,
          });
        }
      }

      // Skip fallback and response push if unsupported was set in the channel loop
      if (unsupported) continue;

      // Fallback: if no inquiredSpectrum, return the full resolved band
      if (availableChannels.length === 0) {
        const firstFr = req.inquiredSpectrum?.[0];
        const resolvedBand = firstFr
          ? await this.resolveBand(cfg, cbsd, firstFr.lowFrequency, firstFr.highFrequency)
          : null;
        const bands = cfg.frequencyBands ?? [];
        const fallback: AvailableChannel[] = resolvedBand
          ? [{ frequencyRange: { lowFrequency: resolvedBand.lowFrequency, highFrequency: resolvedBand.highFrequency }, channelType: 'GAA' as const, ruleApplied: 'FCC_PART_96', maxEirp: resolvedBand.maxEirp ?? cfg.maxEirpGAA }]
          : bands.length > 0
            ? bands.map(b => ({ frequencyRange: { lowFrequency: b.lowFrequency, highFrequency: b.highFrequency }, channelType: 'GAA' as const, ruleApplied: 'FCC_PART_96', maxEirp: b.maxEirp ?? cfg.maxEirpGAA }))
            : [{ frequencyRange: { lowFrequency: cfg.allowedBandLow, highFrequency: cfg.allowedBandHigh }, channelType: 'GAA' as const, ruleApplied: 'FCC_PART_96', maxEirp: cfg.maxEirpGAA }];
        availableChannels.push(...fallback);
      }

      // Sercomm Single-Step mode (CPIInstallParamSuppliedEnable=False + Method=0):
      // The firmware never sends a /grant request. It expects grants embedded
      // in the spectrumInquiry response via grantInfo (WinnForum Instant Grant).
      // Two separate grantInfo entries required for CA — one per carrier,
      // with frequencies matching EXACTLY what the radio requested.
      const isSercommSingleStep = false; // grantInfo disabled
      // Do NOT collapse channels for Sercomm — the firmware reads freq[0] as the
      // combined span of ALL returned channels and expects ONE grant covering that
      // entire span. Collapse to a single channel before adding grantInfo.
      if (isSercommSingleStep && availableChannels.length > 1) {
        const low  = Math.min(...availableChannels.map(c => c.frequencyRange.lowFrequency));
        const high = Math.max(...availableChannels.map(c => c.frequencyRange.highFrequency));
        availableChannels.splice(0, availableChannels.length, {
          frequencyRange: { lowFrequency: low, highFrequency: high },
          channelType:    'GAA' as const,
          ruleApplied:    'FCC_PART_96',
          maxEirp:        availableChannels[0].maxEirp,
        });
      }
      if (isSercommSingleStep && availableChannels.length > 0) {
        const now             = new Date();
        const cfg2            = cfg; // alias for clarity
        const grantExpireTime = new Date(now.getTime() + cfg2.grantExpireHours * 3_600_000);
        const channelsWithGrants: (AvailableChannel & { grantInfo?: any })[] = [];
        for (const ch of availableChannels) {
          const low  = ch.frequencyRange.lowFrequency;
          const high = ch.frequencyRange.highFrequency;
          // Reuse existing grant only if it covers exactly this frequency range
          const existing = await this.grants.findOne({
            cbsdId: req.cbsdId,
            state:  { $in: ['GRANTED', 'AUTHORIZED'] },
            'operationParam.operationFrequencyRange.lowFrequency':  ch.frequencyRange.lowFrequency,
            'operationParam.operationFrequencyRange.highFrequency': ch.frequencyRange.highFrequency,
          });
          let grantId: string;
          if (existing) {
            grantId = existing.grantId;
            // Refresh expire time
            await this.grants.updateOne({ grantId }, { $set: { state: 'AUTHORIZED', lastHeartbeat: now, transmitExpireTime: new Date(now.getTime() + cfg2.heartbeatInterval * 3 * 1_000), grantExpireTime } });
          } else {
            grantId = uuidv4();
            await this.grants.insertOne({
              grantId,
              cbsdId:             req.cbsdId,
              state:              'AUTHORIZED',
              channelType:        'GAA',
              operationParam:     { maxEirp: ch.maxEirp ?? cfg2.maxEirpGAA, operationFrequencyRange: { lowFrequency: low, highFrequency: high } },
              grantExpireTime,
              heartbeatInterval:  cfg2.heartbeatInterval,
              transmitExpireTime: new Date(now.getTime() + cfg2.heartbeatInterval * 3 * 1_000),
              lastHeartbeat:      now,
              createdAt:          now,
            });
            const earfcn = Math.round(55240 + (((low + high) / 2) / 1e6 - 3550) * 10);
            this.logger.info({ cbsdId: req.cbsdId, grantId, lowFrequency: low, highFrequency: high, earfcn }, 'Sercomm instant grant issued via spectrumInquiry');
          }
          const grantExpireIso = grantExpireTime.toISOString().replace(/\.\d+Z$/, 'Z');
          channelsWithGrants.push({
            ...ch,
            grantInfo: {
              grantId,
              grantExpireTime: grantExpireIso,
            },
          });
        }
        await this.cbsds.updateOne({ cbsdId: req.cbsdId }, { $set: { lastSeen: new Date() } });
        this.logger.trace({ cbsdId: req.cbsdId, channelCount: channelsWithGrants.length }, 'Sercomm spectrumInquiry response with grantInfo');
        responses.push({ cbsdId: req.cbsdId, availableChannel: channelsWithGrants, response: makeResponse(RC.SUCCESS) });
        continue;
      }

      await this.cbsds.updateOne({ cbsdId: req.cbsdId }, { $set: { lastSeen: new Date() } });
      this.logger.trace({ cbsdId: req.cbsdId, channelCount: availableChannels.length, channels: availableChannels.map(c => `${(c.frequencyRange.lowFrequency/1e6).toFixed(1)}-${(c.frequencyRange.highFrequency/1e6).toFixed(1)}MHz`) }, 'spectrumInquiry response');
      responses.push({ cbsdId: req.cbsdId, availableChannel: availableChannels, response: makeResponse(RC.SUCCESS) });
    }

    return responses;
  }

  // ─── Grant (section 8.5) ─────────────────────────────────────────────────
  async grant(requests: GrantRequest[]): Promise<GrantResponse[]> {
    const cfg       = await this.getConfig();
    const responses: GrantResponse[] = [];

    for (const req of requests) {
      if (!req.cbsdId) {
        responses.push({ response: makeResponse(RC.MISSING_PARAM, ['cbsdId']) });
        continue;
      }
      if (!req.operationParam) {
        responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.MISSING_PARAM, ['operationParam']) });
        continue;
      }

      const cbsd = await this.cbsds.findOne({ cbsdId: req.cbsdId, state: 'REGISTERED' });
      if (!cbsd) {
        // CBSD unknown — tell radio to re-register
        responses.push({ response: makeResponse(RC.DEREGISTER) });
        continue;
      }

      // GPS lock delay — Baicells BaiBLQ firmware re-grants after GPS locks.
      // Skip this delay for Sercomm radios (FCC ID P27-SCE4255W) — they are
      // indoor units with no GPS lock sequence.
      const isSercomm = cbsd.fccId?.startsWith('P27-');
      const msSinceReg = this.msSinceFirstSeen(cbsd.fccId, cbsd.cbsdSerialNumber);
      if (!isSercomm && msSinceReg < SasService.GPS_LOCK_DELAY_MS) {
        const waitSec = Math.ceil((SasService.GPS_LOCK_DELAY_MS - msSinceReg) / 1000);
        this.logger.info({ cbsdId: req.cbsdId, msSinceReg, waitSec }, 'GPS lock delay — holding grant');
        responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.UNSUPPORTED_SPECTRUM) });
        continue;
      }

      const { lowFrequency, highFrequency } = req.operationParam.operationFrequencyRange;

      // Record last requested freq for debug view
      this.recordLastRequest(req.cbsdId, cbsd.cbsdSerialNumber, cbsd.fccId, '', lowFrequency, highFrequency, 'grant', cbsd.airInterface?.radioTechnology);

      // Find the best matching configured band using 3-level policy resolution
      const matchedBand = await this.resolveBand(cfg, cbsd, lowFrequency, highFrequency);
      if (!matchedBand) {
        responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.UNSUPPORTED_SPECTRUM) });
        continue;
      }

      // Validate the request overlaps our band (not entirely outside)
      if (lowFrequency >= matchedBand.highFrequency || highFrequency <= matchedBand.lowFrequency) {
        responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.UNSUPPORTED_SPECTRUM) });
        continue;
      }

      // Check for existing active grant covering the same carrier.
      // Use a 5 MHz minimum overlap threshold to avoid false positives with CA
      // radios where two adjacent carriers share a boundary (e.g. 3616-3636 and
      // 3635-3655 overlap by only 1 MHz — these are distinct carriers).
      const MIN_OVERLAP_HZ  = 5_000_000; // 5 MHz — more than any CA boundary overlap
      const existingGrant = await this.grants.findOne({
        cbsdId: req.cbsdId,
        state:  { $in: ['GRANTED', 'AUTHORIZED'] },
        'operationParam.operationFrequencyRange.lowFrequency':  { $lt: highFrequency - MIN_OVERLAP_HZ },
        'operationParam.operationFrequencyRange.highFrequency': { $gt: lowFrequency  + MIN_OVERLAP_HZ },
      });
      if (existingGrant) {
        // Grant exists — return it regardless of state so radio can heartbeat it
        this.logger.trace({ cbsdId: req.cbsdId, grantId: existingGrant.grantId, state: existingGrant.state }, 'Duplicate grant request — returning existing grant');
        responses.push({
          cbsdId:            req.cbsdId,
          grantId:           existingGrant.grantId,
          grantExpireTime:   sasFmt(existingGrant.grantExpireTime),
          heartbeatInterval: cfg.heartbeatInterval,
          channelType:       'GAA',
          operationParam:    existingGrant.operationParam,
          response:          makeResponse(RC.SUCCESS),
        });
        continue;
      }

      // For CA radios (Sercomm) the requested range is a specific 20 MHz channel
      // that may be offset by a few hundred kHz from our slot boundary.
      // At grant time we honour the radio's exact requested range as long as it
      // fits within the matched band — this avoids the radio rejecting the grant
      // because the frequency doesn't match its configured EARFCN.
      const slotWidthHz = (matchedBand.maxBandwidthMhz ?? cfg.defaultGrantBandwidthMhz ?? 20) * 1_000_000;
      const requestedWidthHz = highFrequency - lowFrequency;
      const groupId     = cbsd.groupingParam?.find(p => p.groupType === 'INTERFERENCE_COORDINATION')?.groupId;

      let grantLow: number;
      let clampedHigh: number;

      if (requestedWidthHz <= slotWidthHz * 1.1) {
        // Narrow request (single CA carrier or specific channel) — normally we
        // honour the radio's exact requested range (see comment above).
        // Strict allow-list enforcement, per explicit user requirement
        // (2026-07-20): constrain to an operator-defined exact allow-list of
        // slots (the group's customSlots) instead of trusting whatever
        // frequency the radio asks for. Reject with INTERFERENCE (400)
        // rather than UNSUPPORTED_SPECTRUM (300, which causes the CBSD to
        // fully deregister per the comment elsewhere in this file) if the
        // request doesn't land on one of them — the radio should just retry
        // a different frequency, not fall off the SAS entirely. Deliberately
        // NOT vendor-gated — scoped to the same structural condition as the
        // matching spectrumInquiry-side check: effective group must be a
        // manually-created group (present in sas_manual_groups) with
        // customSlots configured, both explicit operator actions. A native,
        // radio-reported group (Sercomm's SC_Group/SERCOMM_5G) is never a
        // manual-group document, so it's naturally excluded even if it also
        // has customSlots — its own narrow CA requests are expected to land
        // a few hundred kHz off the slot boundary, which strict matching
        // would incorrectly reject.
        const effectiveGroup = await this.resolveGroupId(cbsd);
        const manualGroup    = effectiveGroup ? await this.manualGroups.findOne({ _id: effectiveGroup }) : null;
        if (manualGroup) {
          const groupPolicy  = await this.groupPolicies.findOne({ _id: effectiveGroup });
          const allowedSlots = groupPolicy?.customSlots;
          if (Array.isArray(allowedSlots) && allowedSlots.length > 0) {
            const matched = allowedSlots.find(s => lowFrequency < s.high && highFrequency > s.low);
            if (!matched) {
              this.logger.warn(
                { cbsdId: req.cbsdId, groupId: effectiveGroup, lowFrequency, highFrequency, allowedSlots },
                'Grant request outside manual group\'s allowed custom slots — rejected',
              );
              responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.INTERFERENCE) });
              continue;
            }
            grantLow    = matched.low;
            clampedHigh = matched.high;
          } else {
            grantLow    = Math.max(lowFrequency,  matchedBand.lowFrequency);
            clampedHigh = Math.min(highFrequency, matchedBand.highFrequency);
          }
        } else {
          grantLow    = Math.max(lowFrequency,  matchedBand.lowFrequency);
          clampedHigh = Math.min(highFrequency, matchedBand.highFrequency);
        }
      } else if (isSercomm) {
        // Sercomm CA wide grant: honour the exact requested range spanning both carriers
        // The radio requests a grant covering the full combined CA span (e.g. 3616–3655.8)
        grantLow    = Math.max(lowFrequency,  matchedBand.lowFrequency);
        clampedHigh = Math.min(highFrequency, matchedBand.highFrequency);
      } else {
        // Wide request (Baicells full-band) — assign deterministic slot
        const slot = await this.assignChannelSlot(req.cbsdId, groupId, matchedBand, slotWidthHz);
        grantLow    = slot.low;
        clampedHigh = slot.high;
      }

      const grantId         = uuidv4();
      const now             = new Date();
      const grantExpireTime = new Date(now.getTime() + cfg.grantExpireHours * 3_600_000);

      // EIRP: use band limit, fall back to global
      const requestedEirp = req.operationParam.maxEirp;
      const bandMaxEirp   = matchedBand.maxEirp ?? cfg.maxEirpGAA;
      const maxEirp       = (requestedEirp <= 0) ? bandMaxEirp : Math.min(requestedEirp, bandMaxEirp);

      await this.grants.insertOne({
        grantId,
        cbsdId:            req.cbsdId,
        state:             'AUTHORIZED',
        channelType:       'GAA',
        operationParam:    { maxEirp, operationFrequencyRange: { lowFrequency: grantLow, highFrequency: clampedHigh } },
        grantExpireTime,
        heartbeatInterval: cfg.heartbeatInterval,
        transmitExpireTime: new Date(now.getTime() + cfg.heartbeatInterval * 3 * 1_000),
        lastHeartbeat:     now,
        createdAt:         now,
      });

      await this.cbsds.updateOne({ cbsdId: req.cbsdId }, { $set: { lastSeen: now } });

      responses.push({
        cbsdId:            req.cbsdId,
        grantId,
        grantExpireTime:   sasFmt(grantExpireTime),
        heartbeatInterval: cfg.heartbeatInterval,
        channelType:       'GAA',
        operationParam:    { maxEirp, operationFrequencyRange: { lowFrequency: grantLow, highFrequency: clampedHigh } },
        response:          makeResponse(RC.SUCCESS),
      });

      const slotMhz  = `${(grantLow/1e6).toFixed(1)}–${(clampedHigh/1e6).toFixed(1)} MHz`;
      const centerHz = (grantLow + clampedHigh) / 2;
      const { label: arfcnLabel, value: arfcnVal } = cbsdArfcn(centerHz, cbsd.airInterface?.radioTechnology);
      this.logger.info({ cbsdId: req.cbsdId, grantId, lowFrequency: grantLow, highFrequency: clampedHigh, maxEirp, slotMhz, [arfcnLabel]: arfcnVal, groupId }, 'Grant issued');
    }

    return responses;
  }

  // ─── Heartbeat (section 8.6) ──────────────────────────────────────────────
  async heartbeat(requests: HeartbeatRequest[]): Promise<HeartbeatResponse[]> {
    const cfg       = await this.getConfig();
    const responses: HeartbeatResponse[] = [];

    for (const req of requests) {
      if (!req.cbsdId) {
        responses.push({ transmitExpireTime: sasFmt(new Date()), response: makeResponse(RC.MISSING_PARAM, ['cbsdId']) });
        continue;
      }
      if (!req.grantId) {
        responses.push({ cbsdId: req.cbsdId, transmitExpireTime: sasFmt(new Date()), response: makeResponse(RC.MISSING_PARAM, ['grantId']) });
        continue;
      }

      const grant = await this.grants.findOne({ grantId: req.grantId, cbsdId: req.cbsdId });
      if (!grant) {
        // Grant unknown — return TERMINATED_GRANT so radio relinquishes and re-requests
        responses.push({
          cbsdId:             req.cbsdId,
          grantId:            req.grantId,
          transmitExpireTime: sasFmt(new Date()),
          response:           makeResponse(RC.TERMINATED_GRANT),
        });
        continue;
      }

      if (grant.state === 'TERMINATED') {
        responses.push({
          cbsdId:             req.cbsdId,
          grantId:            req.grantId,
          transmitExpireTime: sasFmt(new Date()),
          response:           makeResponse(RC.TERMINATED_GRANT),
        });
        continue;
      }

      // If the grant has expired but the radio is still heartbeating,
      // renew it inline rather than returning TERMINATED_GRANT.
      // This prevents a race window between the grant keeper and the radio's
      // heartbeat where the radio would unnecessarily relinquish and re-register.
      const now = new Date();
      const isExpired = now > grant.grantExpireTime;
      // transmitExpireTime must be well beyond the next heartbeat due time.
      // The radio must heartbeat BEFORE this expires or it stops transmitting.
      // We give 3× the heartbeat interval — this covers GPS init sequences
      // (which can take several minutes) without being dangerously permissive.
      const transmitExpireTime = new Date(now.getTime() + cfg.heartbeatInterval * 3 * 1_000);
      this.logger.debug({ cbsdId: req.cbsdId, heartbeatInterval: cfg.heartbeatInterval, transmitExpireMs: cfg.heartbeatInterval * 3 * 1_000, transmitExpireTime }, 'Heartbeat transmit expire debug');
      // Always renew if expired — radio is clearly still alive and heartbeating
      let newGrantExpireTime = (req.grantRenew || isExpired)
        ? new Date(now.getTime() + cfg.grantExpireHours * 3_600_000)
        : grant.grantExpireTime;

      await this.grants.updateOne(
        { grantId: req.grantId },
        { $set: {
          state:             'AUTHORIZED',
          lastHeartbeat:     now,
          transmitExpireTime,
          grantExpireTime:   newGrantExpireTime,
          lastOperationState: req.operationState ?? 'AUTHORIZED',
        }},
      );
      await this.cbsds.updateOne({ cbsdId: req.cbsdId }, { $set: { lastSeen: now } });

      const resp: HeartbeatResponse = {
        cbsdId:             req.cbsdId,
        grantId:            req.grantId,
        transmitExpireTime: sasFmt(transmitExpireTime),
        // Per WInnForum reference SAS (fake_sas.py): minimal response.
        // Only cbsdId, grantId, transmitExpireTime and response are returned.
        // heartbeatInterval and grantExpireTime are optional and omitted to
        // match reference SAS behavior exactly.
        response:           makeResponse(RC.SUCCESS),
      };
      // Only add grantExpireTime when radio explicitly requests renewal
      if (req.grantRenew) resp.grantExpireTime = sasFmt(newGrantExpireTime);

      // Log if radio is stuck in GRANTED state (not transmitting)
      if (req.operationState === 'GRANTED') {
        this.logger.debug({ cbsdId: req.cbsdId, grantId: req.grantId }, 'Radio heartbeating in GRANTED state — not yet transmitting (X_COM_RadioEnable may be False)');
      }

      responses.push(resp);
    }

    return responses;
  }

  // ─── Relinquishment (section 8.7) ─────────────────────────────────────────
  async relinquishment(requests: RelinquishmentRequest[]): Promise<RelinquishmentResponse[]> {
    const responses: RelinquishmentResponse[] = [];

    for (const req of requests) {
      if (!req.cbsdId) {
        responses.push({ response: makeResponse(RC.MISSING_PARAM, ['cbsdId']) });
        continue;
      }
      if (!req.grantId) {
        responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.MISSING_PARAM, ['grantId']) });
        continue;
      }

      const grant = await this.grants.findOne({ grantId: req.grantId, cbsdId: req.cbsdId });
      if (!grant) {
        // Grant already gone — still return success so radio moves on
        responses.push({ cbsdId: req.cbsdId, grantId: req.grantId, response: makeResponse(RC.SUCCESS) });
        continue;
      }

      await this.grants.deleteOne({ grantId: req.grantId });
      await this.cbsds.updateOne({ cbsdId: req.cbsdId }, { $set: { lastSeen: new Date() } });

      responses.push({ cbsdId: req.cbsdId, grantId: req.grantId, response: makeResponse(RC.SUCCESS) });
      this.logger.info({ cbsdId: req.cbsdId, grantId: req.grantId }, 'Grant relinquished');
    }

    return responses;
  }

  // ─── Deregistration (section 8.8) ─────────────────────────────────────────
  async deregistration(requests: DeregistrationRequest[]): Promise<DeregistrationResponse[]> {
    const responses: DeregistrationResponse[] = [];

    for (const req of requests) {
      if (!req.cbsdId) {
        responses.push({ response: makeResponse(RC.MISSING_PARAM, ['cbsdId']) });
        continue;
      }

      const cbsd = await this.cbsds.findOne({ cbsdId: req.cbsdId });
      if (!cbsd) {
        // Already gone — return SUCCESS so radio moves on cleanly
        responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.SUCCESS) });
        continue;
      }

      await this.grants.deleteMany({ cbsdId: req.cbsdId });
      await this.cbsds.updateOne({ cbsdId: req.cbsdId }, { $set: { state: 'UNREGISTERED' } });

      responses.push({ cbsdId: req.cbsdId, response: makeResponse(RC.SUCCESS) });
      this.logger.info({ cbsdId: req.cbsdId }, 'CBSD deregistered');
    }

    return responses;
  }

  // ─── Admin queries ────────────────────────────────────────────────────────
  async listCbsds(): Promise<SasCbsd[]> {
    return this.cbsds.find({ state: 'REGISTERED' }).sort({ lastSeen: -1 }).toArray();
  }

  async listGrants(cbsdId?: string): Promise<SasGrant[]> {
    const filter = cbsdId ? { cbsdId } : {};
    return this.grants.find(filter).sort({ createdAt: -1 }).toArray();
  }

  async getStats(): Promise<{ registeredCbsds: number; activeGrants: number; authorizedGrants: number }> {
    const [registeredCbsds, activeGrants, authorizedGrants] = await Promise.all([
      this.cbsds.countDocuments({ state: 'REGISTERED' }),
      this.grants.countDocuments({ state: { $in: ['GRANTED', 'AUTHORIZED'] } }),
      this.grants.countDocuments({ state: 'AUTHORIZED' }),
    ]);
    return { registeredCbsds, activeGrants, authorizedGrants };
  }

  // Returns slot layout for ALL configured bands — used by the spectrum chart
  async getSlotLayout(): Promise<{
    bands: Array<{
      bandLow: number; bandHigh: number; label: string;
      slotWidthHz: number;
      slots: Array<{ low: number; high: number; earfcn: number; nrArfcn?: number; radioTech?: string; cbsdId?: string; serial?: string; fccId?: string; state?: string }>;
    }>;
    // Legacy flat fields for backward compat
    bandLow: number; bandHigh: number; slotWidthHz: number;
    slots: Array<{ low: number; high: number; earfcn: number; cbsdId?: string; serial?: string; state?: string }>;
  }> {
    const cfg          = await this.getConfig();
    const activeGrants = await this.grants.find({ state: { $in: ['GRANTED', 'AUTHORIZED'] } }).toArray();
    const cbsdMap      = new Map<string, SasCbsd>();
    const cbsds        = await this.cbsds.find({}).toArray();
    for (const c of cbsds) cbsdMap.set(c.cbsdId, c);

    const configBands = cfg.frequencyBands?.length
      ? cfg.frequencyBands
      : [{ id: 'legacy', label: 'Default', lowFrequency: cfg.allowedBandLow, highFrequency: cfg.allowedBandHigh, maxBandwidthMhz: cfg.defaultGrantBandwidthMhz ?? 20 } as SasFrequencyBand];

    // Build a map: fccId:serial -> effective groupId (manual override first).
    // Keyed by fccId:serial, not cbsdId — manualGroups.cbsdIds holds fccId:serial
    // keys (see the field's own comment), since cbsdId regenerates on reboot.
    const allManualGroups = await this.manualGroups.find({}).toArray();
    const manualGroupMap = new Map<string, string>(); // fccId:serial -> groupId
    for (const mg of allManualGroups) {
      for (const key of mg.cbsdIds) manualGroupMap.set(key, mg._id);
    }
    const effectiveGroupId = (cbsd: SasCbsd) =>
      manualGroupMap.get(`${cbsd.fccId}:${cbsd.cbsdSerialNumber}`) ??
      cbsd.groupingParam?.find(p => p.groupType === 'INTERFERENCE_COORDINATION')?.groupId;
    const allGroupPolicies = await this.groupPolicies.find({}).toArray();
    const bandGroupMap = new Map<string, string[]>(); // bandId -> groupIds[]
    for (const gp of allGroupPolicies) {
      if (!gp.bandId) continue;
      const existing = bandGroupMap.get(gp.bandId) ?? [];
      existing.push(gp._id);
      bandGroupMap.set(gp.bandId, existing);
    }

    const bandResults = configBands.map(band => {
      const slotW = (band.maxBandwidthMhz ?? 20) * 1_000_000;
      const assignedGroupIds = bandGroupMap.get(band.id) ?? [];

      // If any group assigned to this band has explicit customSlots, show
      // those instead of the band's default computeSlots() grid — a group
      // with customSlots isn't actually using the band's native slot width
      // at all. Confirmed live (2026-07-20): Nokia_Pico's chart kept showing
      // the band's own native 40MHz-wide slots (EARFCN 55840/56240) even
      // after customSlots was set to an exact 2×20MHz allow-list (EARFCN
      // 55740/55940) — this loop never consulted customSlots, only ever
      // computeSlots(band, band.maxBandwidthMhz). Unions customSlots across
      // every assigned group that has them (current deployments are 1:1
      // band:group, but this degrades safely if that ever changes); falls
      // back to the default grid for any band with no customSlots-bearing
      // group assigned, unchanged from before.
      const customSlotGroups = assignedGroupIds
        .map(gid => allGroupPolicies.find(p => p._id === gid))
        .filter((p): p is GroupBandPolicy => !!p && Array.isArray(p.customSlots) && p.customSlots.length > 0);
      const slots = customSlotGroups.length > 0
        ? customSlotGroups.flatMap(p => p.customSlots!.map(s => ({ low: s.low, high: s.high })))
        : this.computeSlots(band, slotW);

      // Filter active grants to only those belonging to this band's assigned groups
      // and whose frequency overlaps this band.
      const bandGrants = activeGrants.filter(g => {
        const gLow  = g.operationParam.operationFrequencyRange.lowFrequency;
        const gHigh = g.operationParam.operationFrequencyRange.highFrequency;
        // Must overlap this band
        if (gLow >= band.highFrequency || gHigh <= band.lowFrequency) return false;
        // If band has assigned groups, filter by group — use effectiveGroupId so
        // manual group assignments (e.g. Nokia) are respected, not just groupingParam.
        if (assignedGroupIds.length > 0) {
          const cbsd    = cbsdMap.get(g.cbsdId);
          const groupId = cbsd ? effectiveGroupId(cbsd) : undefined;
          if (!groupId || !assignedGroupIds.includes(groupId)) return false;
        }
        return true;
      });

      // Map slots — for display purposes, find ALL grants that overlap each slot
      // by at least 40%. Multiple CBSDs can share the same frequency (e.g. two
      // Sercomm radios with the same CA channels) — return all of them.
      const slotResults = slots.map(s => {
        const sMid    = (s.low + s.high) / 2;
        const earfcn  = hzToEarfcn(sMid);
        const nrArfcn = hzToNrArfcn(sMid);

        const matchingGrants: Array<{ cbsdId: string; serial?: string; fccId?: string; state: string; groupId?: string; radioTech?: string }> = [];
        for (const g of bandGrants) {
          const gLow  = g.operationParam.operationFrequencyRange.lowFrequency;
          const gHigh = g.operationParam.operationFrequencyRange.highFrequency;
          const overlapLow  = Math.max(gLow,  s.low);
          const overlapHigh = Math.min(gHigh, s.high);
          const overlapHz   = Math.max(0, overlapHigh - overlapLow);
          const overlapPct  = overlapHz / slotW;
          if (overlapPct >= 0.4) {
            const cbsd     = cbsdMap.get(g.cbsdId);
            const groupId  = cbsd ? effectiveGroupId(cbsd) : undefined;
            const radioTech = cbsd?.airInterface?.radioTechnology;
            matchingGrants.push({
              cbsdId:  g.cbsdId,
              serial:  cbsd?.cbsdSerialNumber,
              fccId:   cbsd?.fccId,
              state:   g.state,
              groupId,
              radioTech,
            });
          }
        }

        // For backward compat keep single cbsdId/serial/fccId/state on the slot
        // pointing to the first match, plus a grants[] array for all matches.
        const first = matchingGrants[0];
        // Show NR-ARFCN for NR devices, LTE EARFCN otherwise
        const isNR = first?.radioTech === 'NR';
        return {
          low: s.low, high: s.high, earfcn, nrArfcn,
          ...(first ? { cbsdId: first.cbsdId, state: first.state, serial: first.serial, fccId: first.fccId, groupId: first.groupId, radioTech: first.radioTech } : {}),
          displayArfcn: isNR ? nrArfcn : earfcn,
          arfcnLabel:   isNR ? 'NR-ARFCN' : 'EARFCN',
          grants: matchingGrants,
        };
      });

      return {
        bandLow:          band.lowFrequency,
        bandHigh:         band.highFrequency,
        label:            band.label,
        slotWidthHz:      slotW,
        bandId:           band.id,
        assignedGroupIds,
        slots:            slotResults,
      };
    });

    // Flat legacy fields from first band
    const first = bandResults[0];
    return {
      bands:       bandResults,
      bandLow:     first.bandLow,
      bandHigh:    first.bandHigh,
      slotWidthHz: first.slotWidthHz,
      slots:       first.slots,
    };
  }

  // ─── 30-second summary logger ───────────────────────────────────────────────────────────────
  // Replaces the per-request noise in docker logs with a clean status line.
  private summaryInterval: ReturnType<typeof setInterval> | null = null;

  startSummaryLogger(intervalMs = 30_000): void {
    if (this.summaryInterval) return;
    this.summaryInterval = setInterval(() => this.logSummary(), intervalMs);
  }

  stopSummaryLogger(): void {
    if (this.summaryInterval) { clearInterval(this.summaryInterval); this.summaryInterval = null; }
  }

  private async logSummary(): Promise<void> {
    try {
      const activeGrants = await this.grants
        .find({ state: { $in: ['GRANTED', 'AUTHORIZED'] } })
        .toArray();

      if (activeGrants.length === 0) {
        this.logger.info('SAS ─ no active grants');
        return;
      }

      const cbsdMap = new Map<string, SasCbsd>();
      const cbsds   = await this.cbsds.find({}).toArray();
      for (const c of cbsds) cbsdMap.set(c.cbsdId, c);

      const lines = activeGrants.map(g => {
        const cbsd     = cbsdMap.get(g.cbsdId);
        const serial   = cbsd?.cbsdSerialNumber ?? g.cbsdId.slice(0, 8);
        const low      = (g.operationParam.operationFrequencyRange.lowFrequency  / 1e6).toFixed(1);
        const high     = (g.operationParam.operationFrequencyRange.highFrequency / 1e6).toFixed(1);
        const centerHz = (g.operationParam.operationFrequencyRange.lowFrequency + g.operationParam.operationFrequencyRange.highFrequency) / 2;
        const { label: arfcnLabel, value: arfcnVal } = cbsdArfcn(centerHz, cbsd?.airInterface?.radioTechnology);
        const state    = g.state === 'AUTHORIZED' ? '●' : '○';
        return `${state} ${serial.slice(-10).padEnd(10)} ${low}-${high}MHz ${arfcnLabel}:${arfcnVal}`;
      });

      this.logger.info(`SAS ─ ${activeGrants.length} active grant${activeGrants.length > 1 ? 's' : ''}:\n  ${lines.join('\n  ')}`);
    } catch { /* silent */ }
  }

  // ─── Reset all SAS state ───────────────────────────────────────────────
  // Deletes all grants and CBSDs, clears in-memory GPS delay clocks.
  async resetAll(): Promise<{ deletedGrants: number; deletedCbsds: number }> {
    const [grants, cbsds] = await Promise.all([
      this.grants.deleteMany({}),
      this.cbsds.deleteMany({}),
    ]);
    this.firstSeenTime.clear();
    this.logger.info({ deletedGrants: grants.deletedCount, deletedCbsds: cbsds.deletedCount }, 'SAS DB cleared');
    return { deletedGrants: grants.deletedCount ?? 0, deletedCbsds: cbsds.deletedCount ?? 0 };
  }

  // ─── Pause / Resume SAS responses ────────────────────────────────────────
  // When paused, all SAS protocol endpoints return DEREGISTER so radios
  // stop transmitting and wait. No data is deleted.
  private paused = false;

  pauseSas():  void { this.paused = true;  this.logger.warn('SAS PAUSED — all requests will return DEREGISTER'); }
  resumeSas(): void { this.paused = false; this.logger.info('SAS RESUMED — normal operation'); }
  isPaused():  boolean { return this.paused; }

  async deleteGrant(grantId: string): Promise<boolean> {
    const result = await this.grants.deleteOne({ grantId });
    if (result.deletedCount > 0) this.logger.info({ grantId }, 'Grant deleted by admin');
    return result.deletedCount > 0;
  }

  async deleteCbsd(cbsdId: string): Promise<boolean> {
    await this.grants.deleteMany({ cbsdId });
    const result = await this.cbsds.deleteOne({ cbsdId });
    if (result.deletedCount > 0) this.logger.info({ cbsdId }, 'CBSD deleted by admin');
    return result.deletedCount > 0;
  }

  isReady(): boolean { return this.ready; }

  // ─── RF status per CBSD ───────────────────────────────────────────────────
  // Returns the last known RF transmit state for every registered CBSD.
  // Uses server-side grant.state as the primary indicator: the SAS always
  // sets state=AUTHORIZED on any successful heartbeat, so a heartbeating grant
  // is considered transmitting. lastOperationState from the radio is stored for
  // diagnostics but is NOT used for rfOn — some firmware (e.g. Sercomm) sends
  // operationState=GRANTED even when actively transmitting.
  async getRfStatus(): Promise<Array<{
    cbsdId:     string;
    serial:     string;
    fccId:      string;
    rfOn:       boolean | null;   // null = unknown (no heartbeat ever received)
    operationState?: string;
    lastHeartbeat?:  Date;
  }>> {
    const cbsds  = await this.cbsds.find({ state: 'REGISTERED' }).toArray();
    const grants = await this.grants.find({ state: { $in: ['GRANTED', 'AUTHORIZED'] } }).toArray();

    // Build a map cbsdId -> most recent grant
    const grantByCbsd = new Map<string, SasGrant>();
    for (const g of grants) {
      const existing = grantByCbsd.get(g.cbsdId);
      if (!existing || (g.lastHeartbeat ?? g.createdAt) > (existing.lastHeartbeat ?? existing.createdAt)) {
        grantByCbsd.set(g.cbsdId, g);
      }
    }

    return cbsds.map(c => {
      const grant = grantByCbsd.get(c.cbsdId);
      let rfOn: boolean | null = null;
      if (grant?.lastHeartbeat) {
        // Any heartbeat (radio or keeper) means the SAS has set state=AUTHORIZED.
        rfOn = grant.state === 'AUTHORIZED';
      }
      return {
        cbsdId:         c.cbsdId,
        serial:         c.cbsdSerialNumber,
        fccId:          c.fccId,
        rfOn,
        operationState: grant?.lastOperationState,
        lastHeartbeat:  grant?.lastHeartbeat,
      };
    });
  }

  // ─── Background grant keeper ──────────────────────────────────────────────
  // Baicells BaiBLQ firmware stops heartbeating after GPS lock but keeps the
  // grant in GRANTED state forever. We heartbeat on behalf of all active grants
  // server-side so they never expire, regardless of radio behavior.
  private keeperInterval: ReturnType<typeof setInterval> | null = null;

  startGrantKeeper(intervalMs = 200_000): void {
    if (this.keeperInterval) return;
    this.logger.info({ intervalMs }, 'SAS grant keeper started');
    this.keeperInterval = setInterval(() => this.runGrantKeeper(), intervalMs);
  }

  stopGrantKeeper(): void {
    if (this.keeperInterval) {
      clearInterval(this.keeperInterval);
      this.keeperInterval = null;
    }
  }

  private async runGrantKeeper(): Promise<void> {
    try {
      const cfg    = await this.getConfig();
      const now    = new Date();
      const cutoff = new Date(now.getTime() + cfg.heartbeatInterval * 2 * 1_000);
      // Only touch grants the radio hasn't heartbeated recently (>3 min ago)
      const recentCutoff = new Date(now.getTime() - 3 * 60 * 1_000);

      // Also renew grants that have already expired (grantExpireTime in the past)
      // but are still in AUTHORIZED/GRANTED state — this handles the case where
      // the radio stopped heartbeating (e.g. reboot) and the grant expired while
      // the keeper was running, leaving it stuck in an expired-but-AUTHORIZED state.
      const grants = await this.grants.find({
        state: { $in: ['GRANTED', 'AUTHORIZED'] },
        $and: [
          {
            $or: [
              { transmitExpireTime: { $lt: cutoff } },
              { transmitExpireTime: { $exists: false } },
              { state: 'GRANTED' },
              { grantExpireTime: { $lt: now } }, // also catch already-expired grants
            ],
          },
          {
            $or: [
              { lastHeartbeat: { $lt: recentCutoff } },
              { lastHeartbeat: { $exists: false } },
            ],
          },
        ],
      }).toArray();

      if (grants.length === 0) return;

      this.logger.trace({ count: grants.length }, 'Grant keeper: renewing stale grants');

      const transmitExpireTime = new Date(now.getTime() + cfg.heartbeatInterval * 3 * 1_000);

      for (const grant of grants) {
        const newGrantExpireTime = new Date(now.getTime() + cfg.grantExpireHours * 3_600_000);
        await this.grants.updateOne(
          { grantId: grant.grantId },
          { $set: {
            state:             'AUTHORIZED',
            lastHeartbeat:     now,
            transmitExpireTime,
            // Always renew grantExpireTime — keeper is the fallback when the radio
            // stops heartbeating, so we must keep the grant alive indefinitely.
            grantExpireTime:   newGrantExpireTime,
          }},
        );
        this.logger.trace(
          { grantId: grant.grantId, cbsdId: grant.cbsdId, wasState: grant.state },
          'Grant keeper: renewed grant to AUTHORIZED',
        );
      }
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Grant keeper error');
    }
  }
}
