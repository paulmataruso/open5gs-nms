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
