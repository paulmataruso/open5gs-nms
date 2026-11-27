import { z } from 'zod';
import { isIP } from 'net';
import { MmeMobilityPeer } from '../dto';

// Every object here is .passthrough(), never .strict(), and that is load-bearing
// rather than lax. This validator also runs over the list RETAINED from disk
// (see mergeMmeMobilityConfig below), so a strict schema would reject ANY key
// the NMS does not model -- including one an operator hand-added that the real
// MME parser accepts -- and because ApplyConfigUseCase runs this before its
// backup step, that single unknown key would fail the WHOLE Apply Config run,
// taking every unrelated edit to the other 16 NFs down with it. Unknown keys
// surviving is also what yaml-config-repository.ts's own saveRaw()/deepMerge()
// guarantees on the way back out (CLAUDE.md pattern #2), so throwing on one
// here would contradict the layer that actually writes the file. The real
// checks -- value ranges, duplicate GUMMEI, duplicate TAI, self-GUMMEI, and the
// 2-vs-3-digit MNC width -- are unaffected: every one of them is a constraint on
// a key that IS modelled.
const plmn = z.object({ mcc: z.string().regex(/^\d{3}$/), mnc: z.string().regex(/^\d{2,3}$/) }).passthrough();
const gummei = z.object({
  plmn_id: plmn, mme_gid: z.number().int().min(0).max(65535), mme_code: z.number().int().min(0).max(255),
}).passthrough();
const tai = z.object({ plmn_id: plmn, tac: z.number().int().min(0).max(65535) }).passthrough();
export const mmeMobilityPeerSchema = z.object({
  // Open5GS resolves both literal addresses and host names at startup.
  address: z.string().min(1).max(253).refine(v => isIP(v) !== 0 ||
    (!/^[\d.]+$/.test(v) && v.replace(/\.$/, '').split('.').every(label =>
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))),
  'Use a valid IP address or host name without a URL scheme'),
  port: z.number().int().min(1).max(65535).optional(),
  gummei,
  tai: z.union([tai, z.array(tai).min(1).max(256)]).optional(),
}).passthrough();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Match the repository's recursive merge for the fields relevant to mobility.
// A partial request that omits neighbors retains the on-disk list; omission
// must not bypass compatibility checks. Only an explicit [] clears that list.
export function mergeMmeMobilityConfig(current: unknown, update: unknown): Record<string, unknown> {
  const before = record(record(current).mme);
  const after = record(record(update).mme);
  const beforeGtpc = record(before.gtpc);
  const afterGtpc = record(after.gtpc);
  return { mme: { ...before, ...after, gtpc: { ...beforeGtpc, ...afterGtpc,
    client: { ...record(beforeGtpc.client), ...record(afterGtpc.client) },
  } } };
}

export function validateMmeMobility(config: unknown): MmeMobilityPeer[] {
  const mme = record(record(config).mme);
  const raw = record(record(mme.gtpc).client).mme;
  if (raw === undefined) return [];
  const parsed = z.union([mmeMobilityPeerSchema, z.array(mmeMobilityPeerSchema).max(256)]).safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid inter-MME mobility configuration: ${parsed.error.message}`);
  const peers = parsed.data;
  const list = Array.isArray(peers) ? peers : [peers];
  const identities = new Set<string>();
  const routes = new Set<string>();
  for (const peer of list) {
    const g = peer.gummei;
    const id = `${g.plmn_id.mcc}/${g.plmn_id.mnc}/${g.mme_gid}/${g.mme_code}`;
    if (identities.has(id)) throw new Error('Duplicate inter-MME neighbor GUMMEI');
    identities.add(id);
    const local = Array.isArray(mme.gummei) ? mme.gummei : [mme.gummei];
    for (const value of local) {
      const own = record(value);
      const plmns = Array.isArray(own.plmn_id) ? own.plmn_id : [own.plmn_id];
      const gids = Array.isArray(own.mme_gid) ? own.mme_gid : [own.mme_gid];
      const codes = Array.isArray(own.mme_code) ? own.mme_code : [own.mme_code];
      if (plmns.some(p => record(p).mcc === g.plmn_id.mcc && record(p).mnc === g.plmn_id.mnc) &&
          gids.includes(g.mme_gid) && codes.includes(g.mme_code))
        throw new Error('A neighbor GUMMEI must be different from this MME');
    }
    for (const area of peer.tai ? (Array.isArray(peer.tai) ? peer.tai : [peer.tai]) : []) {
      const route = `${area.plmn_id.mcc}/${area.plmn_id.mnc}/${area.tac}`;
      if (routes.has(route)) throw new Error('Duplicate inter-MME target TAI route');
      routes.add(route);
    }
  }
  return list;
}
