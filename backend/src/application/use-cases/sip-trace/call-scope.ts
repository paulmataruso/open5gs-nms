import { SipTraceDocument } from './sip-trace-store';

// ── Call scoping ─────────────────────────────────────────────────────────────
//
// Pure decision logic for "should this traced SIP message be stored". Two
// independent jobs, deliberately in one place because they are evaluated on
// every single datagram and the ORDER between them matters:
//
//   1. Keepalive suppression, always on, session or no session.
//   2. Party/dialog scoping, only while a Call Debug session is running.
//
// Everything here is a pure function over an already-parsed document so it is
// testable without a socket, a database or a running Kamailio.

/**
 * Keepalives are 68% of this deployment's whole trace store, measured, not
 * estimated: 5,763 of 8,465 documents, and ~5,790 of 5,840 DISTINCT Call-IDs,
 * because every single ping is its own dialog. Two unrelated senders produce
 * them continuously and forever:
 *
 *   - S-CSCF's dispatcher pings Asterisk (`fromUser` is the literal
 *     "dispatcher", `toUser` a bare host:port with no user part at all).
 *   - P-CSCF's route[NATPING] sends OPTIONS to every registered contact on an
 *     rtimer interval (30s by default here; it was 5s until 2026-10-13 — see
 *     CLAUDE.md's NATPING entry).
 *
 * Neither is ever the thing an operator opened the page to find, and storing
 * them is what makes the Dialogs list ~99% noise by dialog count. The existing
 * `kind:'calls'` query default papers over this at READ time
 * (sip-trace-store.ts documents that); suppressing the write is strictly
 * better because it also stops them consuming the store and the TTL budget.
 *
 * Suppression is reported through its own counter rather than being silent,
 * and `storeKeepalives` can turn it off for the rare case where the keepalive
 * itself is the bug (a dispatcher flap, or NATPING holding UEs out of idle).
 */
export function isKeepalive(d: Pick<SipTraceDocument, 'method' | 'cseqMethod'>): boolean {
  return d.method === 'OPTIONS' || d.cseqMethod === 'OPTIONS';
}

/**
 * A message we could not parse into anything identifiable.
 *
 * This exists so scoping can FAIL OPEN on it. Both sip-message-parser.ts and
 * sip-trace-store.ts carry explicit comments that a malformed or truncated
 * message must be kept, because it is frequently the exact thing being hunted
 * -- the store even invents a synthetic Call-ID rather than drop one. A party
 * filter would quietly reverse that decision, since an unparseable message has
 * no From/To user to match on and would fall through as "not my call".
 */
export function isUnparseable(d: Pick<SipTraceDocument, 'method' | 'statusCode' | 'fromUser' | 'toUser'>): boolean {
  const identified = !!d.method || typeof d.statusCode === 'number';
  const hasParty = !!d.fromUser || !!d.toUser;
  return !identified || !hasParty;
}

/** Minimum digits before a suffix match is allowed at all. */
export const MIN_SUFFIX_DIGITS = 7;
/**
 * Most a suffix match may differ in length. A country code (1-3 digits) plus a
 * trunk prefix is the only legitimate reason two renderings of ONE number
 * differ, and real traffic here shows exactly that: the same PSTN destination
 * appears as both `6034771783` and `16034771783`.
 *
 * The cap is what stops a 7+-digit entry suffix-matching an unrelated 15-digit
 * IMSI, which shares this very field: `fromUser` holds `001010000000001`
 * alongside `15550000001`. Without the cap, entering `0000001` would match
 * that IMSI and silently pull in a different subscriber's registration.
 */
export const MAX_SUFFIX_LENGTH_DELTA = 4;

export interface PartySpec {
  /** Exactly what the operator typed, for display. */
  raw: string;
  /** Digits only, present only when `raw` is a usable phone-number-ish value. */
  digits?: string;
}

const DIGITS_ONLY = /^[0-9]+$/;

/**
 * Turn operator input into a matchable party.
 *
 * `+1 (555) 000-0001`, `15550000001` and `tel:+15550000001` must all become the
 * same thing. Anything that is not a phone number after stripping separators
 * (an IMPU like `alice@domain`, or a bare host:port) keeps no digit form and is
 * compared literally, which is what stops the keepalive hazard below.
 */
export function normaliseParty(raw: string): PartySpec {
  const trimmed = String(raw ?? '').trim();
  const stripped = trimmed.replace(/^(?:sips?|tel):/i, '').replace(/[\s()\-.]/g, '').replace(/^\+/, '');
  return DIGITS_ONLY.test(stripped) && stripped.length > 0
    ? { raw: trimmed, digits: stripped }
    : { raw: trimmed };
}

/**
 * Compare one SIP user part against one party.
 *
 * The user part must be a WHOLE pure-digit value to be eligible for digit
 * matching. That requirement is load-bearing, not defensive: `sipUser()`
 * returns `127.0.1.1:4060` for the user-less URI in every dispatcher
 * keepalive (5,763 live documents), and a naive digits-only normalisation of
 * that yields `1270114060` -- an 10-digit string that would become eligible
 * for a suffix match against a real 10-digit MSISDN. Requiring the whole user
 * part to be digits makes that impossible rather than improbable.
 */
function userMatchesParty(userPart: string, p: PartySpec): boolean {
  if (userPart === p.raw) return true;
  if (!p.digits) return false;
  if (!DIGITS_ONLY.test(userPart)) return false;
  if (userPart === p.digits) return true;

  const [short, long] = userPart.length <= p.digits.length ? [userPart, p.digits] : [p.digits, userPart];
  if (short.length < MIN_SUFFIX_DIGITS) return false;          // short codes stay exact
  if (long.length - short.length > MAX_SUFFIX_LENGTH_DELTA) return false;
  return long.endsWith(short);
}

export function partyMatches(
  d: Pick<SipTraceDocument, 'fromUser' | 'toUser'>,
  parties: PartySpec[],
): boolean {
  // Both sides are checked because an in-dialog request from the UAS swaps
  // From and To -- a BYE from the callee carries the callee in From.
  for (const p of parties) {
    if (d.fromUser && userMatchesParty(d.fromUser, p)) return true;
    if (d.toUser && userMatchesParty(d.toUser, p)) return true;
  }
  return false;
}

/**
 * Which dialogs a session stores.
 *
 * Party scoping alone is NOT enough, measured on this deployment: the
 * reg-event SUBSCRIBE/NOTIFY dialog carries the subscriber's own MSISDN and
 * runs continuously, observed at 211, 217 and 218 messages in a SINGLE dialog.
 * A party-only session drags that in and is bloated again. Scoping to call
 * dialogs took a real 3.5-minute window containing one call from 85 messages
 * to 42.
 *
 * `calls`              - INVITE dialogs only. The default.
 * `callsAndRegistration` - adds REGISTER, because registration is the most
 *                        common real root cause of "the call didn't work" here
 *                        and it is NOT visible in the call dialog.
 * `all`                - everything for these parties (keepalives still
 *                        suppressed separately).
 */
export type DialogScope = 'calls' | 'callsAndRegistration' | 'all';

const CALL_METHODS = new Set(['INVITE', 'ACK', 'BYE', 'CANCEL', 'PRACK', 'UPDATE', 'INFO', 'REFER']);

/**
 * `cseqMethod` is the discriminator rather than `method`, and that choice
 * removes a real race.
 *
 * siptrace runs in TRANSACTION mode (sip_trace_mode("t")), so responses reach
 * the collector through tm callbacks on three independent UDP sockets -- a
 * `100 Trying` can genuinely be processed before the INVITE that provoked it.
 * A response has no `method` at all, but it DOES carry the CSeq method of the
 * transaction it answers, so keying on CSeq makes the decision identical
 * whichever order they arrive in, with no cross-message state to get wrong.
 */
export function dialogScopeAllows(
  d: Pick<SipTraceDocument, 'method' | 'cseqMethod'>,
  scope: DialogScope,
): boolean {
  if (scope === 'all') return true;
  const m = (d.cseqMethod || d.method || '').toUpperCase();
  if (CALL_METHODS.has(m)) return true;
  return scope === 'callsAndRegistration' && m === 'REGISTER';
}

export interface CallScopeFilter {
  sessionId: string;
  parties: PartySpec[];
  dialogScope: DialogScope;
  /** false (default) stores ONLY matching messages; true stores all, tagging matches. */
  tagOnly: boolean;
}

export type ScopeVerdict =
  | { store: true; sessionId?: string; reason: 'unparseable' | 'in-scope' | 'out-of-scope-tagged' | 'no-session' }
  | { store: false; reason: 'keepalive' | 'out-of-scope' };

/**
 * The single decision the collector makes per datagram.
 *
 * Order is deliberate and each step is justified above:
 *   1. keepalive  -> never stored (unless explicitly opted back in)
 *   2. unparseable-> ALWAYS stored, even mid-session, even out of scope
 *   3. no session -> stored
 *   4. in scope   -> stored and stamped with the session id
 *   5. out of scope -> dropped, or stored untagged in tagOnly mode
 */
export function decideScope(
  d: Pick<SipTraceDocument, 'method' | 'statusCode' | 'cseqMethod' | 'fromUser' | 'toUser'>,
  filter: CallScopeFilter | null,
  storeKeepalives: boolean,
): ScopeVerdict {
  if (!storeKeepalives && isKeepalive(d)) return { store: false, reason: 'keepalive' };
  if (isUnparseable(d)) return { store: true, reason: 'unparseable' };
  if (!filter) return { store: true, reason: 'no-session' };

  const inScope = partyMatches(d, filter.parties) && dialogScopeAllows(d, filter.dialogScope);
  if (inScope) return { store: true, sessionId: filter.sessionId, reason: 'in-scope' };
  return filter.tagOnly
    ? { store: true, reason: 'out-of-scope-tagged' }
    : { store: false, reason: 'out-of-scope' };
}
