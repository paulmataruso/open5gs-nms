// chrony (NTP) — the shapes `chronyc` output is parsed into, plus the two
// rules every view of that output has to agree on: what counts as a real NTP
// client, and how old "last seen" is allowed to be before a client is no
// longer "connected". Both the Time Server page and the dashboard card read
// the same endpoint, so these live here rather than being written twice.

/** One row of `chronyc clients`, as chrony-controller.ts's parseClients() emits it. */
export interface ChronyClient {
  hostname: string;
  ntpRequests: number;
  ntpDropped: number;
  ntpInterval: string;
  ntpLast: string;
}

/**
 * chronyc elapsed-time strings → seconds. Handles the compound form it prints
 * for longer gaps ("2d5h30m"), the single-unit form ("3h", "14m", "82h") and
 * a bare number, which chronyc means as seconds.
 *
 * Returns null for "-", which chronyc means as "never", and for a unit string
 * that sums to zero. A bare "0" returns 0, not null: chronyc prints it for a
 * client it heard from within the last second, which is a real age — the
 * newest one there is.
 */
export function parseChronycAge(s: string): number | null {
  if (!s || s === '-') return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let seconds = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)([dhms])/g)) {
    const v = parseInt(n, 10);
    if (unit === 'd') seconds += v * 86400;
    else if (unit === 'h') seconds += v * 3600;
    else if (unit === 'm') seconds += v * 60;
    else seconds += v;
  }
  return seconds > 0 ? seconds : null;
}

/** Anything quieter than this is no longer reported as currently connected. */
export const CHRONY_RECENT_SECONDS = 3600;

/**
 * Real NTP clients heard from within `withinSeconds`, most recently seen first.
 *
 * An unknown age sorts first: with requests on the clock, "-" means chronyc
 * had no interval to report rather than "a long time ago".
 */
/**
 * Whether a row is a real NTP client at all.
 *
 * `chronyc clients` lists COMMAND-mode clients too, which is how this NMS's
 * own `chronyc` call shows up as `localhost` with 0 NTP requests and no
 * last-seen time. Counting our own polling as a time client overstates the
 * list by one on every deployment, and names something that has never asked
 * for time — so it is not one, and it is not a "stale" one either.
 */
export function isNtpClient(c: ChronyClient): boolean {
  return c.ntpRequests > 0;
}

export function recentNtpClients(
  clients: ChronyClient[],
  withinSeconds: number = CHRONY_RECENT_SECONDS,
): ChronyClient[] {
  return clients
    .filter(isNtpClient)
    .filter((c) => {
      const age = parseChronycAge(c.ntpLast);
      return age === null || age <= withinSeconds;
    })
    .sort((a, b) => (parseChronycAge(a.ntpLast) ?? 0) - (parseChronycAge(b.ntpLast) ?? 0));
}
