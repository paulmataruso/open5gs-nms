/**
 * Zone-stanza editing for BIND's `named.conf.local`.
 *
 * This file is SHARED INFRASTRUCTURE. IMS, VoWiFi and the DNS/FQDN Migration
 * Wizard all keep their own zones in the one `named.conf.local`, so every
 * writer has to edit it in place and leave the other modules' stanzas alone
 * (CLAUDE.md architectural pattern #4).
 *
 * All three used to carry their own private, character-for-character identical
 * copy of these two functions -- `ims-controller.ts`, `vowifi-controller.ts`
 * and `dns-migration-usecase.ts`. A fix to one would never have reached the
 * other two, and nothing tested any of them. They are consolidated here.
 *
 * Deliberately dependency-free: these are pure string functions with no
 * imports, so the three controllers can share them without a static import
 * between sibling controllers (the circular-dependency hazard in CLAUDE.md
 * architectural pattern #16).
 */

/** Escapes a zone name for literal use inside a RegExp. */
function escapeZoneName(zoneName: string): string {
  return zoneName.replace(/\./g, '\\.');
}

/**
 * Matches one zone stanza by exact name.
 *
 * `[^}]*` stops at the first closing brace, so this handles a flat stanza --
 * which is all any module here emits (`type` and `file` only). A zone body
 * containing a nested block would not match; see the prefix variant below,
 * which uses a lazy cross-brace pattern instead.
 */
function zoneStanzaRe(zoneName: string): RegExp {
  return new RegExp(`zone\\s+"${escapeZoneName(zoneName)}"\\s*\\{[^}]*\\};?\\s*`, 'g');
}

/** The stanza this project writes for a master zone. */
export function namedZoneBlock(zoneName: string, zoneFilePath: string): string {
  return `zone "${zoneName}" {\n    type master;\n    file "${zoneFilePath}";\n};\n`;
}

/**
 * Replaces the named zone's stanza, or appends it when absent -- never
 * rewrites the whole file, so the other modules' zones survive.
 */
export function upsertNamedZone(raw: string, zoneName: string, zoneFilePath: string): string {
  const zoneBlock = namedZoneBlock(zoneName, zoneFilePath);
  if (raw.includes(`zone "${zoneName}"`)) {
    return raw.replace(zoneStanzaRe(zoneName), zoneBlock);
  }
  return raw.trimEnd() + '\n\n' + zoneBlock;
}

/** Removes one zone stanza by exact name, leaving every other zone in place. */
export function removeNamedZone(raw: string, zoneName: string): string {
  return raw.replace(zoneStanzaRe(zoneName), '');
}

/**
 * Removes EVERY zone whose name starts with `prefix`.
 *
 * This is deliberately not `removeNamedZone`: a module's uninstall has to drop
 * all of its own zones at once without having to know their names, where the
 * per-zone calls above target one known name. The pattern is also different --
 * `[\s\S]*?` crosses braces where the exact-name one does not -- and it is
 * kept verbatim from the IMS uninstall path it came from, rather than unified,
 * because changing it would change what a live uninstall removes.
 *
 * `prefix` is a literal zone-name prefix such as `'ims.'`, not a pattern.
 */
export function removeNamedZonesByPrefix(raw: string, prefix: string): string {
  const re = new RegExp(`\\nzone\\s+"${escapeZoneName(prefix)}[^"]+"\\s*\\{[\\s\\S]*?\\};\\n?`, 'g');
  return raw.replace(re, '\n').trimEnd() + '\n';
}
