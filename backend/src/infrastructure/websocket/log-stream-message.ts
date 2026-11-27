// Reading a log-stream WebSocket client's message.
//
// `JSON.parse` returns `any`, so every field of an inbound message used to be
// read unchecked. The one that mattered is `source`: it is DECLARED as a
// six-way union on all three handler signatures while actually carrying
// whatever string the client sent, so an unrecognised value type-checked
// against the union without ever being one of its members, then fell through
// every `source === ...` branch to the open5gs default. The client got the
// wrong logs rather than an error — which reads as a frontend bug.
//
// Split out of log-stream-handler.ts so these are testable without a
// WebSocket, a log file or a child process.

import { MajorEventType, MAJOR_EVENT_TYPES } from '../../application/use-cases/major-event-classifier';

/** The log sources this handler knows how to read. */
export const LOG_SOURCES = ['open5gs', 'docker', 'genieacs', 'frr', 'ims', 'gsm'] as const;
export type LogSource = typeof LOG_SOURCES[number];

/**
 * What a client may send, before any of it is believed.
 *
 * Every field is `unknown`: this is the shape of a parsed JSON object, not a
 * contract the client has honoured. The readers below are the only way values
 * leave it, which is also why no assertion is needed to get here — a narrowed
 * non-null `object` already satisfies an all-optional-`unknown` interface.
 */
export interface LogStreamClientMessage {
  type?: unknown;
  source?: unknown;
  services?: unknown;
  filter?: unknown;
  limit?: unknown;
  majorEventsOnly?: unknown;
  imsis?: unknown;
  radioIps?: unknown;
  eventTypes?: unknown;
}

export function isLogSource(v: unknown): v is LogSource {
  return typeof v === 'string' && (LOG_SOURCES as readonly string[]).includes(v);
}

/**
 * The requested source, or the open5gs default.
 *
 * That default was already the behaviour for an ABSENT field; it is now also
 * the behaviour for an unrecognised one, which previously got that far while
 * claiming to be something else.
 */
export function asLogSource(v: unknown): LogSource {
  return isLogSource(v) ? v : 'open5gs';
}

/** Only the real strings out of a client array; anything else is dropped. */
export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function isMajorEventType(v: string): v is MajorEventType {
  return (MAJOR_EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * Only event types this build actually classifies.
 *
 * Returns the real union rather than `string[]`, so nothing downstream needs
 * an assertion — the old `eventTypesArr as MajorEventType[]` was the only
 * thing standing between a client string and a `Set<MajorEventType>`.
 */
export function asEventTypes(v: unknown): MajorEventType[] {
  return asStringArray(v).filter(isMajorEventType);
}

/** A non-empty string, or absent. An empty filter is no filter. */
export function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Strictly `true`. A truthy string or 1 is not a request to change mode. */
export function asBoolean(v: unknown): boolean {
  return v === true;
}

/**
 * A sane line count.
 *
 * The client's limit reaches `limit * 10` and `limit * 4` multipliers and then
 * a log read, so NaN, Infinity, a negative and a float all had somewhere to
 * go. Clamped rather than rejected: asking for too much is a UI slip, not an
 * error worth refusing a reply over.
 */
export function asLimit(v: unknown, fallback: number, max = 10000): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < 1) return fallback;
  return Math.min(n, max);
}
