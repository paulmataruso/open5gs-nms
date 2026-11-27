// Reading a GenieACS device document.
//
// GenieACS stores a TR-069 device as nested objects keyed by path SEGMENT, so
// the parameter `Device.IP.Interface.1.IPv4Address.1.IPAddress` is
// `device.Device.IP.Interface['1'].IPv4Address['1'].IPAddress`, and the leaf is
// not the value itself but a node carrying `_value` (the cached reading) and
// `_timestamp` (when it was last read). See acs-device-ip.ts for why that
// timestamp matters rather than being incidental.
//
// This exists because the same dotted-path walk was written out by hand in
// every consumer, each typed `Record<string, any>` with an `any` cursor — which
// switched off type checking for every read beneath it. Extracted during
// CI-LINT-PLAN Phase 6; `sercomm-nr-controller.ts`, `genieacs-controller.ts`
// and `baicells-ue-counts.ts` carry their own copies of the same walk and
// should move onto these helpers when that sweep reaches them.

/**
 * A GenieACS parameter node.
 *
 * Only the two fields anything here reads are named. The index signature keeps
 * the rest (`_object`, `_writable`, `_type`, and the child segments of a
 * container node) reachable without pretending to model them.
 */
export interface AcsParameterNode {
  _value?: unknown;
  _timestamp?: unknown;
  [segment: string]: unknown;
}

/** A GenieACS device document, as it comes back from the NBI. */
export type AcsDevice = Record<string, unknown>;

/**
 * The node at a dotted TR-069 path, or undefined if the path does not resolve.
 *
 * A missing segment, a null, or a scalar where a container was expected all
 * yield undefined rather than throwing — a device that has not reported a
 * subtree simply does not have it.
 */
export function acsNodeAt(device: AcsDevice, dotPath: string): AcsParameterNode | undefined {
  let cursor: unknown = device;
  for (const segment of dotPath.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'object' && cursor !== null
    ? (cursor as AcsParameterNode)
    : undefined;
}

/**
 * A parameter's `_value` as a trimmed string, or null when there isn't one.
 *
 * Narrows rather than coerces. TR-069 parameter values are scalars — string,
 * int, boolean, dateTime — so a string, number or boolean is stringified
 * exactly as the previous hand-rolled `String(node._value).trim()` did, and
 * every well-formed reading is unchanged. Anything else (an object, an array)
 * means the path pointed at a CONTAINER rather than a leaf, and is reported as
 * absent instead of becoming the literal text "[object Object]" and flowing on
 * into an IP check or a status field. Same narrow-don't-coerce rule as the Kea
 * config round-trip fix.
 */
export function acsValueAt(device: AcsDevice, dotPath: string): string | null {
  return acsScalar(acsNodeAt(device, dotPath)?._value);
}

/**
 * A parameter's value together with when GenieACS last read it, as epoch ms.
 *
 * `at` is 0 for an absent or unparseable `_timestamp`, which makes it lose
 * every freshness comparison rather than win one by accident.
 */
export function acsValueWithTimeAt(
  device: AcsDevice,
  dotPath: string,
): { value: string; at: number } | null {
  const node = acsNodeAt(device, dotPath);
  const value = acsScalar(node?._value);
  if (value === null) return null;
  const ts = Date.parse(typeof node?._timestamp === 'string' ? node._timestamp : '');
  return { value, at: Number.isFinite(ts) ? ts : 0 };
}

function acsScalar(v: unknown): string | null {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return String(v);
  return null;
}
