import * as fs from 'fs';
import { Db } from 'mongodb';
import { safeNsenter } from '../../../infrastructure/system/safe-nsenter';
import { normaliseParty, PartySpec } from './call-scope';

// ── Resolving an operator-typed number into something capturable ─────────────
//
// An operator types two phone numbers. To scope a capture we need rather more
// than that, and all of it is derivable:
//
//   - every SIP identity that number appears under (see IMS_IDENTITY_FORMS)
//   - the UE's IMS-APN IP, which is what a BPF can actually filter on
//   - whether that UE is even registered, and whether it has an IPsec SA
//
// The last one is here because it answers more real "the call didn't work"
// reports than the capture does. CLAUDE.md's own gotcha list records that a
// `kamailio-pcscf` restart silently wipes every UE's IPsec SA while the
// registrar goes on reporting the AoR as registered with a healthy Expires
// countdown -- the two subsystems desync and nothing surfaces it. A call to an
// affected UE then fails after a multi-second delay, which reads exactly like
// a radio problem. Telling the operator up front costs one RPC.

/**
 * The IMS APN. Only this session's IP carries SIP and RTP.
 *
 * This matters more than it looks: every subscriber here holds TWO sessions
 * (verified on all live records), e.g. internet=10.45.0.70 and ims=10.46.0.70,
 * from the two `smf.yaml` pools 10.45.0.0/16 and 10.46.0.0/24. Scoping a
 * protocol-less packet capture to the internet-APN address would record every
 * byte of that subscriber's data traffic for the length of the call -- the
 * exact bloat this feature exists to avoid -- while adding nothing, because no
 * SIP or RTP ever crosses it.
 */
export const IMS_APN = 'ims';

/**
 * The IMS DNN's own UE subnet, straight from smf.yaml.
 *
 * Used only as a fallback when a subscriber has no static IMS address, so a
 * capture can still be scoped to something bounded rather than giving up or
 * (far worse) falling back to capturing everything. Read from the file rather
 * than threaded through config plumbing because it is one value, it is
 * authoritative there, and this runs once per session start.
 */
export function readImsPool(): string | undefined {
  try {
    const raw = fs.readFileSync('/proc/1/root/etc/open5gs/smf.yaml', 'utf-8');
    // Deliberately a small scan rather than a YAML parse: we want the `subnet`
    // that belongs to the `dnn: ims` entry, and the surrounding file is a
    // rawYaml-preserved document this code must never rewrite.
    const lines = raw.split('\n');
    let pending: string | undefined;
    for (const line of lines) {
      const sub = line.match(/^\s*-?\s*subnet:\s*([0-9.]+\/[0-9]+)\s*$/);
      if (sub) { pending = sub[1]; continue; }
      const dnn = line.match(/^\s*dnn:\s*(\S+)\s*$/);
      if (dnn && dnn[1] === IMS_APN && pending) return pending;
    }
  } catch { /* unreadable -> no fallback, which is honest */ }
  return undefined;
}

export interface ResolvedParty {
  /** As typed. */
  input: string;
  party: PartySpec;
  /** Every identity this number is known by, for the trace filter. */
  identities: PartySpec[];
  imsi?: string;
  /** IMS-APN UE address, the only one worth capturing. */
  imsIp?: string;
  /** internet-APN address, resolved only so we can say we excluded it. */
  dataIp?: string;
  registered?: boolean;
  /** True when this UE negotiated sec-agree and has live SAs. */
  ipsec?: boolean;
  kind: 'subscriber' | 'external';
  note?: string;
}

/**
 * A subscriber is provisioned with three IMPUs (ims-controller's own
 * provisioning): `sip:<msisdn>@domain`, `tel:<msisdn>` and `sip:<imsi>@domain`.
 * Handsets REGISTER on the IMSI form and dial on the MSISDN form, which is why
 * an operator typing only a phone number would otherwise get the call dialog
 * and no registration context whatsoever -- measured at 210 messages of
 * REGISTER/401/200 separating the two forms in this deployment's own store.
 */
function identitiesFor(msisdn: string, imsi?: string): PartySpec[] {
  const out = [normaliseParty(msisdn)];
  if (imsi) out.push(normaliseParty(imsi));
  return out;
}

interface SubscriberShape {
  imsi?: string;
  msisdn?: string[] | string;
  slice?: { session?: { name?: string; ue?: { ipv4?: string } }[] }[];
}

function apnIp(sub: SubscriberShape, apn: string): string | undefined {
  for (const sl of sub.slice ?? []) {
    for (const se of sl.session ?? []) {
      if (se.name === apn && se.ue?.ipv4) return se.ue.ipv4;
    }
  }
  return undefined;
}

/**
 * P-CSCF's registrar, read through its own RPC.
 *
 * `ulpcscf.status` is the right command and the obvious ones are not: this
 * P-CSCF uses ims_usrloc_pcscf, so plain `ul.dump` returns an empty Domains
 * structure. AoRs are keyed by contact address rather than by IMPU (e.g.
 * `sip:10.46.0.73:64784`, and a UUID form for some handsets), so matching is
 * by the UE's IP appearing in the AoR -- which is exactly what we have.
 */
async function readRegistrar(): Promise<{ aors: string[]; ok: boolean }> {
  try {
    const r = await safeNsenter('kamcmd', ['-s', '/run/kamailio_pcscf/kamailio_ctl', 'ulpcscf.status'], 8000);
    const aors = r.stdout
      .split('\n')
      .filter(l => l.includes('AoR:'))
      .map(l => l.replace(/^.*AoR:\s*/, '').trim());
    return { aors, ok: true };
  } catch {
    return { aors: [], ok: false };
  }
}

/**
 * Live IPsec peers, and ONLY the peers.
 *
 * `ip xfrm state` output carries `auth-trunc` and `enc` key material. It is
 * filtered to the four leading address fields here, at the point of reading,
 * so no key byte ever reaches a variable, a log line, an error message or a
 * stored document. Do not widen this parse.
 */
async function readIpsecPeers(): Promise<Set<string>> {
  const peers = new Set<string>();
  try {
    const r = await safeNsenter('ip', ['xfrm', 'state'], 8000);
    for (const line of r.stdout.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f[0] === 'src' && f[2] === 'dst') {
        peers.add(f[1]);
        peers.add(f[3]);
      }
    }
  } catch { /* absent or unreadable -> report unknown, never guess */ }
  return peers;
}

export async function resolveParties(db: Db, inputs: string[]): Promise<ResolvedParty[]> {
  const [registrar, ipsecPeers] = await Promise.all([readRegistrar(), readIpsecPeers()]);

  const out: ResolvedParty[] = [];
  for (const input of inputs) {
    const party = normaliseParty(input);
    const digits = party.digits ?? party.raw;

    // msisdn is stored as an ARRAY; Mongo matches an element directly, so no
    // $in gymnastics. Try the typed form and the digits form, since a stored
    // MSISDN may or may not carry a leading country code.
    const sub = (await db.collection('subscribers').findOne(
      { $or: [{ msisdn: input }, { msisdn: digits }, { imsi: digits }] },
      { projection: { imsi: 1, msisdn: 1, slice: 1 } },
    )) as SubscriberShape | null;

    if (!sub?.imsi) {
      out.push({
        input,
        party,
        identities: [party],
        kind: 'external',
        note: 'Not a subscriber on this core — treated as an external number. Its own leg is only visible in the packet capture.',
      });
      continue;
    }

    const imsIp = apnIp(sub, IMS_APN);
    const dataIp = apnIp(sub, 'internet');
    const registered = imsIp ? registrar.aors.some(a => a.includes(imsIp)) : undefined;

    out.push({
      input,
      party,
      identities: identitiesFor(digits, sub.imsi),
      imsi: sub.imsi,
      imsIp,
      dataIp,
      registered: registrar.ok ? registered : undefined,
      ipsec: imsIp ? ipsecPeers.has(imsIp) : undefined,
      kind: 'subscriber',
      note: imsIp
        ? undefined
        : `No static ${IMS_APN}-APN address on this subscriber, so the capture cannot be scoped to its UE address.`,
    });
  }
  return out;
}

/**
 * The one-line readiness verdict shown before the operator spends a test call.
 *
 * Deliberately advisory, never blocking: a UE with no IPsec SA is NORMAL here,
 * not a fault. Per-client gating in kamailio_pcscf.cfg clears
 * `$sht(ipsec_clients=>$si)` on every REGISTER and only sets it when the
 * REGISTER carried a Security-Client header, so a handset that never requests
 * sec-agree legitimately has no SA to show. Confirmed live on this very
 * deployment, where one handset tunnels and two do not.
 */
export function readinessNote(p: ResolvedParty): string | undefined {
  if (p.kind === 'external') return undefined;
  if (p.registered === false) {
    return `${p.input} is NOT registered with P-CSCF — a call to it will not complete. Have the handset re-register before testing.`;
  }
  if (p.registered === undefined) {
    return `${p.input}: could not read P-CSCF's registrar, so registration state is unknown.`;
  }
  return p.ipsec
    ? `${p.input} is registered, over IPsec — its UE-side SIP and RTP will appear as ESP in the packet capture, not as readable SIP.`
    : `${p.input} is registered, without IPsec — its UE-side SIP and RTP are captured in the clear.`;
}
