// Reading a subscriber document out of Mongo.
//
// `Collection` with no type argument is `Collection<Document>`, and mongodb's
// `Document` is `Record<string, any>` — so every `doc.x` in the repository was
// an `any` and nothing beneath it was checked.
//
// Typing the collection as `Collection<Subscriber>` would be WORSE than the
// `any`, not better: most reads are PROJECTIONS, so fields the entity declares
// as required (`security`, `ambr`, `slice`) genuinely are not present, and the
// compiler would promise they are. So the projected shapes are declared here
// with every field optional and `unknown` — which is what a projection really
// returns, from documents written variously by this NMS, by Open5GS's own
// WebUI, and by hand.
//
// Split out of mongo-subscriber-repository.ts so the mapping is a pure
// function testable without a database.

import { SubscriberListItem, FramedRouteEntry } from '../../domain/entities/subscriber';

/** The fields the subscriber-list projection asks for. */
export interface SubscriberListDoc {
  imsi?: unknown;
  nickname?: unknown;
  iccid?: unknown;
  simType?: unknown;
  msisdn?: unknown;
  slice?: unknown;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

/** `simType` as the list item declares it; anything unrecognised is absent. */
export function simType(v: unknown): 'esim' | 'physical' | null | undefined {
  if (v === 'esim' || v === 'physical' || v === null) return v;
  return undefined;
}

/** An object's own property, or undefined when it is not an object at all. */
export function field(v: unknown, key: string): unknown {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined;
}

export function objArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * One list row, or null for a document with no IMSI.
 *
 * The old code asserted `doc.imsi as string`, so such a document produced a
 * row whose `imsi` was `undefined` through a field declared `string`: it
 * renders blank, and every per-row action (edit, delete, assign plan) keys off
 * that imsi, so the row would silently act on nothing. Returning null lets the
 * caller skip and log it instead.
 */
export function toSubscriberListItem(doc: SubscriberListDoc): SubscriberListItem | null {
  const imsi = str(doc.imsi);
  if (imsi === undefined) return null;
  const slices = objArray(doc.slice);
  const firstSession = objArray(field(slices[0], 'session'))[0];
  const sessions = slices.flatMap(s => objArray(field(s, 'session')).map(sess => ({
    apn: str(field(sess, 'name')) ?? '',
    ipv4: str(field(field(sess, 'ue'), 'ipv4')),
    framedRoutes: strArray(field(sess, 'ipv4_framed_routes')),
  })));
  return {
    imsi,
    nickname: str(doc.nickname),
    iccid: str(doc.iccid),
    simType: simType(doc.simType),
    msisdn: strArray(doc.msisdn),
    slice_count: slices.length,
    // `reduce<number>`: `slices` is unknown[], so without the explicit type
    // argument the accumulator infers as unknown.
    session_count: slices.reduce<number>((sum, s) => sum + objArray(field(s, 'session')).length, 0),
    ue_ipv4: str(field(field(firstSession, 'ue'), 'ipv4')),
    apn: str(field(firstSession, 'name')),
    sessions,
  };
}

/**
 * Every framed-route-carrying session of one document.
 *
 * `?? []` was not enough on these two fields. They feed subscriber-management's
 * framed-route overlap check, which iterates them and hands each element to
 * `ipv4CidrOverlaps()`; a document holding a bare STRING instead of an array
 * passed the old `.length === 0` test (a non-empty string has a length), was
 * pushed through a field declared `string[]`, and then iterated CHARACTER BY
 * CHARACTER into the CIDR parser. Narrowing makes a malformed field read as
 * absent instead.
 */
export function framedRouteEntriesOf(doc: SubscriberListDoc): FramedRouteEntry[] {
  const imsi = str(doc.imsi);
  if (imsi === undefined) return [];
  const entries: FramedRouteEntry[] = [];
  for (const slice of objArray(doc.slice)) {
    for (const sess of objArray(field(slice, 'session'))) {
      const ipv4 = strArray(field(sess, 'ipv4_framed_routes')) ?? [];
      const ipv6 = strArray(field(sess, 'ipv6_framed_routes')) ?? [];
      if (ipv4.length === 0 && ipv6.length === 0) continue;
      entries.push({
        imsi,
        nickname: str(doc.nickname),
        apn: str(field(sess, 'name')) ?? '',
        ipv4,
        ipv6,
        static: field(sess, 'framed_routes_static') === true,
      });
    }
  }
  return entries;
}
