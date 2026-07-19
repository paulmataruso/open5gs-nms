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
