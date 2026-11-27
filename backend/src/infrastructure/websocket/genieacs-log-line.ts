// Reading a GenieACS log line.
//
// GenieACS writes newline-delimited JSON: {"level":30,"time":...,"message":…}.
// Split out of log-stream-handler.ts so this is testable without a WebSocket,
// and because the timestamp read used to be an unchecked `any`:
// `new Date(parsed.time).toISOString()` on a `time` that is neither a number
// nor a date string gives an Invalid Date, and .toISOString() THROWS on one.
// That ran inside a `.map()` with no try/catch of its own, so a single odd
// line in one log file cost the entire recent-logs response — caught by the
// caller's outer handler, logged, and the client's ws.send never reached.
//
// `genieacsLineMatchesFilter` in the handler is the other half of reading
// these lines and could move here too when something needs it.

/**
 * The line's own timestamp as an ISO string, or now.
 *
 * Why it matters at all rather than being cosmetic: getRecentLogsFromPath
 * stamps every line with the FETCH time, since it does not know these are
 * JSON lines carrying their own `time`. Without re-deriving it, every line
 * from one service ends up with nearly the same "now" and a multi-service
 * selection comes back as one service's block followed by the next's instead
 * of interleaved by real time.
 */
export function genieacsLineTimestamp(line: string, now: () => Date = () => new Date()): string {
  try {
    const parsed: unknown = JSON.parse(line);
    const time = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).time : undefined;
    // Epoch millis (a number) and an ISO string are both real GenieACS
    // readings. Anything else is reported as absent rather than handed to
    // `new Date()`, which turns it into an Invalid Date that throws on
    // .toISOString().
    if (typeof time === 'number' || typeof time === 'string') {
      const d = new Date(time);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  } catch { /* not JSON */ }
  return now().toISOString();
}
