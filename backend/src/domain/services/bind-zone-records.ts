/**
 * Single-record edits INSIDE a BIND zone FILE.
 *
 * Distinct from named-conf-zones.ts, which manages the zone STANZA in
 * named.conf.local. This module edits the records within a zone's own file.
 *
 * The `epc.mnc<mnc>.mcc<mcc>.3gppnetwork.org` zone is shared: the DNS/FQDN
 * Migration Wizard regenerates it wholesale from its own fixed core-17-NF
 * list, which has no notion of optional add-on modules, while three modules
 * each merge a single record of their own into it -- VoWiFi's `aaa`, SecGW's
 * `secgw`, and IMS's `ocs`. A merge, never a rewrite, is what lets those lines
 * survive each other's Configure runs.
 *
 * All three carried their own copy of this function: vowifi-controller.ts and
 * secgw-controller.ts had byte-identical `upsertZoneRecordLine`s, and
 * ims-controller.ts had the same logic inlined with its record name
 * hardcoded. ims-controller.ts's own comment described the copy chain
 * ("itself copied..."), so the duplication was known. Consolidated here.
 *
 * Dependency-free on purpose: pure string functions, so three sibling
 * controllers can share them with no import between controllers (the
 * circular-dependency hazard in CLAUDE.md architectural pattern #16).
 */

/** Escapes a record name for literal use inside a RegExp. */
function escapeRecordName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches an existing A record for `name`.
 *
 * Requires an explicit `IN` class, which is what every writer here emits and
 * what the live zone contains. `\s+` rather than a single space because the
 * generator's own header records are column-aligned (`ns1 IN A     127.0.0.8`).
 *
 * A class-less record (`aaa A 1.2.3.4`) is valid zone syntax that this would
 * NOT match, and the upsert would then append a second A record for the same
 * name rather than replacing it -- two A records means round-robin, so half
 * the lookups would return the stale address. No writer here emits that form,
 * which is why this is recorded as a known boundary rather than handled; a
 * test pins it so it is visible if a future writer starts emitting one.
 */
function aRecordRe(name: string): RegExp {
  return new RegExp(`^${escapeRecordName(name)}\\s+IN\\s+A\\s+\\S+\\s*$`, 'm');
}

/** The record line this project writes. */
export function zoneARecordLine(name: string, ip: string): string {
  return `${name} IN A ${ip}`;
}

/**
 * Replaces this module's own A record, or appends it when absent, leaving
 * every other module's records in the shared zone untouched.
 */
export function upsertZoneRecordLine(raw: string, name: string, ip: string): string {
  const re = aRecordRe(name);
  const line = zoneARecordLine(name, ip);
  return re.test(raw) ? raw.replace(re, line) : raw.trimEnd() + '\n' + line + '\n';
}
