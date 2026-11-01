import { ipv4CidrOverlaps, cidrNetworkRange } from './ip-utils';

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

// ── SMF pool wider than the UPF pool that has to carry it ──────────────────
//
// The join above deliberately TOLERATES SMF and UPF declaring different prefix
// lengths for the same DNN, because it only needs to find the right `dev`. That
// tolerance hid a real outage condition for a long time: if SMF's pool is WIDER
// than the UPF's, the SMF will happily allocate a UE an address the UPF's own TUN
// device has no route for, and that UE attaches with full signal and no data path.
//
// Confirmed live 2026-11-01: smf.yaml had `internet` on 10.45.0.0/16 while
// upf.yaml (and therefore ogstun) had 10.45.0.0/24 — 65280 of the SMF's 65534
// allocatable addresses were unroutable. It had not bitten only because this
// deployment's handful of subscribers all landed inside the first /24.
//
// Only the wider-SMF direction is reported. A NARROWER SMF pool is harmless: the
// UPF simply routes a range larger than anything that will be handed out.
//
// Range comparison is used rather than comparing prefix lengths so a
// non-aligned or partially-overlapping pair is caught too, and so this reuses
// cidrNetworkRange()'s already-fixed unsigned math (see ip-utils.ts — a bitwise
// AND there once produced corrupted signed values for any first octet >= 128).
export interface SmfPoolNotRoutable {
  dnn: string;
  dev: string;
  smfSubnet: string;
  upfSubnet: string;
  /** Addresses the SMF can allocate that fall outside the UPF's routed range. */
  unroutableAddresses: number;
}

export function findSmfPoolsWiderThanUpf(
  smfSessions: any[],
  upfSessions: any[],
): SmfPoolNotRoutable[] {
  const found: SmfPoolNotRoutable[] = [];

  for (const smfSess of smfSessions ?? []) {
    const smfSubnet = smfSess?.subnet;
    // IPv6 is excluded on purpose: these pools are /48-style delegations whose
    // routing does not work the same way, and cidrNetworkRange() is IPv4-only.
    if (!smfSess?.dnn || !smfSubnet || String(smfSubnet).includes(':')) continue;

    const upfSess = (upfSessions ?? []).find((u) => u?.dnn === smfSess.dnn)
      ?? (upfSessions ?? []).find((u) => u?.subnet && !String(u.subnet).includes(':')
        && ipv4CidrOverlaps(u.subnet, smfSubnet));
    if (!upfSess?.subnet || String(upfSess.subnet).includes(':')) continue;

    const smfRange = cidrNetworkRange(smfSubnet);
    const upfRange = cidrNetworkRange(upfSess.subnet);

    const overlapFirst = Math.max(smfRange.first, upfRange.first);
    const overlapLast = Math.min(smfRange.last, upfRange.last);
    if (overlapFirst > overlapLast) continue; // disjoint — a different problem

    const smfSize = smfRange.last - smfRange.first + 1;
    const overlapSize = overlapLast - overlapFirst + 1;
    if (smfSize <= overlapSize) continue; // SMF fits inside the UPF's range

    found.push({
      dnn: smfSess.dnn,
      dev: upfSess.dev || 'ogstun',
      smfSubnet: String(smfSubnet),
      upfSubnet: String(upfSess.subnet),
      unroutableAddresses: smfSize - overlapSize,
    });
  }

  return found;
}
