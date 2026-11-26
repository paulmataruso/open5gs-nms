// Pure parsing logic only — no I/O here. Every caller (interfaces/rest/*.ts
// controllers via sync fs + /proc/1/root, application/use-cases/*.ts via the
// async IHostExecutor abstraction) owns reading mme.yaml's raw text itself,
// through whichever access pattern its own layer already uses, then hands the
// raw string to this one shared parser instead of re-deriving the same regex.
//
// This consolidates five previously-duplicated `readMccMnc()` implementations
// (ims-controller.ts, vowifi-controller.ts, swu-emulator-controller.ts,
// sms-controller.ts's inline regex, dns-migration-usecase.ts's private method)
// that were all byte-identical: same regex, same '001'/'01' fallback. Existing
// call sites can adopt this opportunistically — not all migrated at once.
export function parseMccMncFromMmeYaml(raw: string): { mcc: string; mnc: string } {
  const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
  const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
  return { mcc: mccM?.[1] ?? '001', mnc: mncM?.[1] ?? '01' };
}

// A radio that hasn't reported its own PLMN yet (blank mcc/mnc — not yet
// synced, or RF genuinely never configured) is NOT a mismatch — that's a
// "don't know yet" state, not a "known wrong" one. Only flag when the radio
// HAS reported a real PLMN and it differs from what the core is configured
// for. This project treats PLMN as one global value shared across the whole
// core (4G and 5G both read from mme.yaml — see plmn-migration-usecase.ts),
// so the same core mcc/mnc is the right comparison for every radio type.
export function isPlmnMismatch(deviceMcc: string, deviceMnc: string, coreMcc: string, coreMnc: string): boolean {
  if (!deviceMcc || !deviceMnc) return false;
  return deviceMcc !== coreMcc || deviceMnc !== coreMnc;
}

export function deriveSgcDomain(mcc: string, mnc: string): string {
  return `5gc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

export function deriveEpcDomain(mcc: string, mnc: string): string {
  return `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

export function deriveImsDomain(mcc: string, mnc: string): string {
  return `ims.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

export function derivePubEpdgDomain(mcc: string, mnc: string): string {
  return `mnc${mnc.padStart(3, '0')}.mcc${mcc}.pub.3gppnetwork.org`;
}

// ── IMSI vs FQDN: the MNC width rule is DIFFERENT, and conflating them is a
//    real bug this project shipped ────────────────────────────────────────────
//
// The four FQDN helpers above pad MNC to three digits, and that is correct: a
// 3GPP domain name always renders MNC as exactly 3 digits (TS 23.003 §19.2), so
// MNC "70" and MNC "070" legitimately produce the same `mnc070` label.
//
// An IMSI does NOT work that way. It is MCC (3 digits) + MNC (2 OR 3 digits) +
// MSIN (TS 23.003 §2.2), using the MNC's own width -- and `70` and `070` are
// different networks, so the width is load-bearing. Three places built test
// IMSIs with `mcc + mnc.padStart(3, '0')`, which on this deployment's
// MCC 001 / MNC 01 yields `001001...` -- PLMN 001-001, not 001-01 -- while
// their own comments said the test block sat "within the real PLMN". Confirmed
// against the live subscriber list on 2026-11-26: every real subscriber here is
// `00101` + a 10-digit MSIN. swu-emulator-controller.ts already had this right.

/** IMSI prefix for a PLMN: MCC, then MNC at its REAL width. */
export function imsiPlmnPrefix(mcc: string, mnc: string): string {
  return mcc + mnc;
}

/** MSIN digit count that makes a 15-digit IMSI for this PLMN. */
export function msinLength(mcc: string, mnc: string): number {
  return 15 - mcc.length - mnc.length;
}

/**
 * The padded prefix the three builders used before 2026-11-26.
 *
 * Kept ONLY so reconcile paths can still recognise and clean up test
 * subscribers created by an older build -- a leftover bot whose prefix no
 * longer matches would otherwise be orphaned in PyHSS forever. Never use it to
 * build a new IMSI.
 */
export function legacyPaddedImsiPlmnPrefix(mcc: string, mnc: string): string {
  return mcc + mnc.padStart(3, '0');
}
