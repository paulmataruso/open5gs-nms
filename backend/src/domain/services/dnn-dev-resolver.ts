import { ipv4CidrOverlaps } from './ip-utils';

export interface DnnDevEntry {
  dnn: string;
  dev: string;
  subnet: string | null;
}

// Joins smf.yaml's session list (the DNN source Open5GS itself actually depends on)
// against upf.yaml's (the TUN device source) to answer "which dev serves this DNN."
//
// upf.yaml's own `dnn:` key (used below as the primary match) is a convenience
// annotation this project's UpfEditor writes — not part of Open5GS's real UPF config
// schema — so it can legitimately be absent (hand-edited upf.yaml, or one predating
// this NMS). When it's missing, fall back to joining by `subnet` instead — and that
// join can't assume an exact string match either: confirmed on a real deployment
// that SMF and UPF don't always declare identical prefix lengths for the same DNN
// (SMF's "internet" pool 10.45.0.0/16 vs UPF's narrower 10.45.0.0/24), so IPv4 falls
// back further to a CIDR-overlap check. Originally written for #28 (framed routing's
// wrong `dev`), extracted here once #29 (TUN Interfaces page) needed the identical
// join for a second, independent purpose.
//
// smfSessions/upfSessions are the raw session arrays as already returned by
// configRepo.loadSmf()/loadUpf() (`(cfg as any).session`) — untyped `any[]` matches
// this codebase's existing convention for these raw-YAML-shaped arrays (see
// resolveDnnDevMap()'s prior form). onUnresolved is called (not thrown) for an SMF
// session with no matching UPF entry, so a caller can warn/log without aborting the
// whole join — same posture #28 established.
export function resolveDnnDevPairs(
  smfSessions: any[],
  upfSessions: any[],
  onUnresolved?: (dnn: string, subnet: string | null) => void,
): DnnDevEntry[] {
  const entries: DnnDevEntry[] = [];

  for (const smfSess of smfSessions ?? []) {
    if (!smfSess?.dnn) continue;

    let dev = upfSessions?.find((u) => u?.dnn === smfSess.dnn)?.dev;

    if (!dev && smfSess.subnet) {
      const isV4 = !String(smfSess.subnet).includes(':');
      const bySubnet = upfSessions?.find((u) => u?.subnet === smfSess.subnet)
        ?? (isV4
          ? upfSessions?.find((u) => u?.subnet && !String(u.subnet).includes(':')
            && ipv4CidrOverlaps(u.subnet, smfSess.subnet))
          : undefined);
      dev = bySubnet?.dev;
    }

    if (dev) {
      entries.push({ dnn: smfSess.dnn, dev, subnet: smfSess.subnet ?? null });
    } else {
      onUnresolved?.(smfSess.dnn, smfSess.subnet ?? null);
    }
  }

  return entries;
}

// Dedup a list of {dev, subnet, ...} items down to one per dev, preferring the
// IPv4 entry when a dev has both — a dual-stack DNN produces two entries
// sharing the same dev (one IPv4 session, one IPv6), and a plain last-write-
// wins Map depends on array/file ordering, which isn't guaranteed. Two
// independent call sites (tun-management.ts's TUN Interfaces "APN / Pool"
// column, apn-profile-usecase.ts's derived-profile gateway lookup) each
// reimplemented this same rule against two different source shapes (resolved
// DNN-dev pairs vs. raw upf.yaml sessions) — extracted here after the first
// one shipped without it and showed a real IPv6-subnet-on-an-IPv4-row bug
// (#29 follow-up, 2026-08-25).
export function preferIPv4ByDev<T extends { dev: string; subnet?: string | null }>(items: T[]): Map<string, T> {
  const byDev = new Map<string, T>();
  for (const item of items) {
    const dev = item.dev || 'ogstun';
    const isV4 = item.subnet != null && !String(item.subnet).includes(':');
    if (!byDev.has(dev) || isV4) byDev.set(dev, item);
  }
  return byDev;
}
