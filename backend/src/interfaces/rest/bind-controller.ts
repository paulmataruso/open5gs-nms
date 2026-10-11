import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { nsenter } from '../../infrastructure/network/dummy-interface';
import { SERVICE_UNIT_MAP } from '../../domain/entities/service-status';

// Generic BIND9 management — install, service control, and a raw file editor over
// /etc/bind. Deliberately NOT a structured zone-generation UI (that's IMS's own
// DnsRecordsCard for IMS-specific records) — this is the shared admin tool other
// modules (VoWiFi, IMS) point users at for anything beyond what their own wizard covers.
const HOST_BIND_DIR = '/proc/1/root/etc/bind';

function isPathInBindDir(absPath: string): boolean {
  const resolved = path.resolve(`/proc/1/root${absPath}`);
  return resolved === HOST_BIND_DIR || resolved.startsWith(HOST_BIND_DIR + path.sep);
}

interface BindFile {
  path: string;   // e.g. /etc/bind/named.conf.local
  label: string;  // relative to /etc/bind, e.g. zones/mnc070.mcc999.pub.3gppnetwork.org.zone
}

function listBindFiles(): BindFile[] {
  if (!fs.existsSync(HOST_BIND_DIR)) return [];
  const results: BindFile[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && (entry.name === 'cache' || entry.name === 'bind')) continue; // skip bind9 runtime state dirs
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else {
        results.push({ path: `/etc/bind/${relPath}`, label: relPath });
      }
    }
  };
  walk(HOST_BIND_DIR, '');
  return results.sort((a, b) => a.label.localeCompare(b.label));
}

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const NAMED_OPTIONS_PATH = `${HOST_BIND_DIR}/named.conf.options`;

// Ubuntu's stock named.conf.options ships a *commented-out* forwarders example:
//   // forwarders {
//   // 	0.0.0.0;
//   // };
// A plain `/forwarders\s*\{[^}]*\}\s*;/` regex doesn't know about `//` comment markers
// and matches straight through them (starting at the bare word "forwarders", ignoring
// the leading "// "). Confirmed live (2026-07-18): running the replace against this
// produced `// forwarders { 8.8.8.8; 8.8.4.4; };` (the whole thing collapsed onto one
// still-commented line) — a dead comment as far as BIND's parser is concerned, but one
// that *also* fools this exact same regex, so the health check reported "healthy" while
// forwarders stayed permanently non-functional, and repeated /repair calls kept
// reproducing the exact same broken one-liner instead of fixing it. Match is intentionally
// terminated at the nearest "};" regardless of whether that closing brace itself has a
// "//" prefix, so this strips both the original multi-line stock comment *and* the
// already-corrupted single-line form left behind by the old buggy replace.
function stripStockForwardersComment(raw: string): string {
  return raw.replace(/^[ \t]*\/\/[ \t]*forwarders\b[\s\S]*?\};[ \t]*\r?\n?/m, '');
}

/**
 * Insert a directive inside the `options { ... }` block, before its own closing
 * brace.
 *
 * Every writer here used to do `raw.replace(/\}\s*;?\s*$/, ...)`, which anchors
 * on the LAST closing brace in the whole file. That is only correct while
 * `options{}` is the final block — true of the stock file and true of this host
 * today, but a `logging { ... };` block is the single most common thing an
 * operator adds to named.conf.options, and this project even ships a Syslog
 * Forwarding module. With anything after `options{}`, a missing
 * forwarders/listen-on/recursion directive would be inserted into THAT block's
 * scope instead. BIND then refuses to load the file at all — and a BIND that
 * won't start crash-loops every FQDN-migrated NF simultaneously (pattern #6),
 * so the blast radius of getting this wrong is the whole core, not just DNS.
 *
 * Brace-counts from `options {` to its real match, skipping over comments and
 * quoted strings so a `//`-commented brace or a path like "/var/{cache}" can't
 * throw the count off. Returns null if there is no parseable options block, so
 * the caller can fall back rather than writing something malformed.
 */
export function insertIntoOptionsBlock(raw: string, line: string): string | null {
  const m = raw.match(/(^|\n)[ \t]*options[ \t]*\{/);
  if (!m || m.index === undefined) return null;
  const open = raw.indexOf('{', m.index);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < raw.length; i++) {
    const c = raw[i];
    // Skip comments.
    if (c === '/' && raw[i + 1] === '/') { while (i < raw.length && raw[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < raw.length && raw[i] !== '\n') i++; continue; }
    if (c === '/' && raw[i + 1] === '*') { const end = raw.indexOf('*/', i + 2); i = end === -1 ? raw.length : end + 1; continue; }
    // Skip quoted strings.
    if (c === '"') { i++; while (i < raw.length && raw[i] !== '"') { if (raw[i] === '\\') i++; i++; } continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return `${raw.slice(0, i)}\t${line}\n${raw.slice(i)}`;
    }
  }
  return null; // Unbalanced braces — refuse rather than guess.
}

function readForwarders(): string[] {
  if (!fs.existsSync(NAMED_OPTIONS_PATH)) return [];
  const raw = stripStockForwardersComment(fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8'));
  const m = raw.match(/forwarders\s*\{([^}]*)\}\s*;/);
  if (!m) return [];
  return m[1].split(';').map(s => s.trim()).filter(s => IP_RE.test(s));
}

function writeForwarders(forwarders: string[]): void {
  const block = `forwarders { ${forwarders.map(f => `${f};`).join(' ')} };`;
  let raw = fs.existsSync(NAMED_OPTIONS_PATH) ? fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8') : 'options {\n};\n';
  raw = stripStockForwardersComment(raw);
  if (/forwarders\s*\{[^}]*\}\s*;/.test(raw)) {
    raw = raw.replace(/forwarders\s*\{[^}]*\}\s*;/, block);
  } else {
    // No forwarders block yet — insert inside options {}, not at end-of-file.
    const inserted = insertIntoOptionsBlock(raw, block);
    raw = inserted ?? `${raw.trimEnd()}\noptions {\n\t${block}\n};\n`;
  }
  fs.mkdirSync(path.dirname(NAMED_OPTIONS_PATH), { recursive: true });
  fs.writeFileSync(NAMED_OPTIONS_PATH, raw, 'utf-8');
}

// listen-on — the single, shared setting for which local IPs BIND actually binds to.
// Owned by this page only: IMS/VoWiFi each used to write their own copy of this line
// whenever their wizard ran, silently clobbering whatever the others (or the user) had
// set. Now they only manage their own zone files; this is the one place that touches
// the options{} block's listen-on line.
export function readListenOn(): string[] {
  if (!fs.existsSync(NAMED_OPTIONS_PATH)) return ['127.0.0.1'];
  const raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
  const m = raw.match(/listen-on\s*\{([^}]*)\}\s*;/);
  if (!m) return ['127.0.0.1'];
  const ips = m[1].split(';').map(s => s.trim()).filter(s => IP_RE.test(s));
  return ips.length > 0 ? ips : ['127.0.0.1'];
}

export function writeListenOn(ips: string[]): void {
  // Always keep 127.0.0.1 — every module here (IMS zone verification, VoWiFi, the DNS
  // migration wizard's own dig checks) assumes BIND answers on loopback regardless of
  // whatever else is configured.
  const all = Array.from(new Set(['127.0.0.1', ...ips]));
  const block = `listen-on { ${all.map(ip => `${ip};`).join(' ')} };`;
  let raw = fs.existsSync(NAMED_OPTIONS_PATH) ? fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8') : 'options {\n};\n';
  if (/listen-on\s*\{[^}]*\}\s*;/.test(raw)) {
    raw = raw.replace(/listen-on\s*\{[^}]*\}\s*;/, block);
  } else {
    const inserted = insertIntoOptionsBlock(raw, block);
    raw = inserted ?? `${raw.trimEnd()}\noptions {\n\t${block}\n};\n`;
  }
  fs.mkdirSync(path.dirname(NAMED_OPTIONS_PATH), { recursive: true });
  fs.writeFileSync(NAMED_OPTIONS_PATH, raw, 'utf-8');
}

function ensureRecursionAndAllowQuery(): boolean {
  if (!fs.existsSync(NAMED_OPTIONS_PATH)) return false;
  let raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
  let changed = false;
  if (!/recursion\s+yes\s*;/.test(raw)) {
    const inserted = insertIntoOptionsBlock(raw, 'recursion yes;');
    if (inserted) { raw = inserted; changed = true; }
  }
  if (!/allow-query\s*\{[^}]*\}\s*;/.test(raw)) {
    const inserted = insertIntoOptionsBlock(raw, 'allow-query { any; };');
    if (inserted) { raw = inserted; changed = true; }
  }
  if (changed) fs.writeFileSync(NAMED_OPTIONS_PATH, raw, 'utf-8');
  return changed;
}

// ─── Self-healing: recover from `apt purge bind9` (or any other event that resets
// named.conf.{local,options} to their stock package defaults) without losing zones ───
// Real incident (2026-07-17): a manual `apt purge bind9` wiped both conf files back to
// the stock Ubuntu template, but the zone *files* under zones/ survived (they aren't
// owned by the Debian package) — every 5GC NF that resolves its own advertise FQDN at
// startup crash-looped until this was manually repaired. This makes that repair a
// one-click, self-detecting action instead of requiring someone to SSH in and rebuild
// both conf files by hand.
const ZONE_FILE_RE = /^(.+)\.zone$/;

function zoneFilesOnDisk(): string[] {
  const zonesDir = `${HOST_BIND_DIR}/zones`;
  if (!fs.existsSync(zonesDir)) return [];
  return fs.readdirSync(zonesDir)
    .map(f => f.match(ZONE_FILE_RE)?.[1])
    .filter((name): name is string => !!name);
}

function zonesDeclaredInNamedLocal(): Set<string> {
  const namedLocalPath = `${HOST_BIND_DIR}/named.conf.local`;
  if (!fs.existsSync(namedLocalPath)) return new Set();
  const raw = fs.readFileSync(namedLocalPath, 'utf-8');
  const names = new Set<string>();
  const re = /zone\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) names.add(m[1]);
  return names;
}

export interface BindHealth {
  installed: boolean;
  undeclaredZones: string[];       // zone files on disk with no zone{} block in named.conf.local
  optionsNeedsRepair: boolean;     // missing recursion/allow-query/forwarders/listen-on
  resolvConfBypassesBind: boolean; // /etc/resolv.conf doesn't route through BIND on 127.0.0.1
}

export function checkBindHealth(): BindHealth {
  const installed = fs.existsSync('/proc/1/root/usr/sbin/named');
  const onDisk = new Set(zoneFilesOnDisk());
  const declared = zonesDeclaredInNamedLocal();
  const undeclaredZones = [...onDisk].filter(z => !declared.has(z));

  let optionsNeedsRepair = true;
  if (fs.existsSync(NAMED_OPTIONS_PATH)) {
    const raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
    const rawForForwardersCheck = stripStockForwardersComment(raw);
    optionsNeedsRepair = !/recursion\s+yes\s*;/.test(raw)
      || !/allow-query\s*\{[^}]*\}\s*;/.test(raw)
      || !/forwarders\s*\{[^}]*\}\s*;/.test(rawForForwardersCheck)
      || !/listen-on\s*\{[^}]*127\.0\.0\.1/.test(raw);
  }

  let resolvConfBypassesBind = false;
  try {
    const resolvPath = '/proc/1/root/etc/resolv.conf';
    const real = fs.existsSync(resolvPath) ? fs.readFileSync(resolvPath, 'utf-8') : '';
    // systemd-resolved's stub (127.0.0.53) answering first means BIND is bypassed even
    // if BIND itself is perfectly healthy — the actual getaddrinfo() path never reaches it.
    const firstNameserver = real.match(/^nameserver\s+(\S+)/m)?.[1];
    resolvConfBypassesBind = firstNameserver !== undefined && firstNameserver !== '127.0.0.1';
  } catch { /* leave false if unreadable */ }

  return { installed, undeclaredZones, optionsNeedsRepair, resolvConfBypassesBind };
}

// Disables systemd-resolved's stub listener and replaces /etc/resolv.conf with a
// static file pointing straight at BIND (127.0.0.1) — the actual fix behind the
// /fix-resolver route below, extracted so fresh-host-bootstrap-usecase.ts and
// backup-restart-usecase.ts can also call it directly instead of requiring an
// operator to remember the manual button. Real incident (2026-07-17): even with
// BIND itself perfectly healthy, getaddrinfo() (what every NF actually calls) was
// still bypassing it entirely because /etc/resolv.conf pointed at systemd-resolved's
// 127.0.0.53 stub. Idempotent — safe to call unconditionally.
export async function fixResolver(): Promise<void> {
  const resolvedConfPath = '/proc/1/root/etc/systemd/resolved.conf';
  if (fs.existsSync(resolvedConfPath)) {
    let raw = fs.readFileSync(resolvedConfPath, 'utf-8');
    raw = /^#?DNSStubListener=/m.test(raw)
      ? raw.replace(/^#?DNSStubListener=.*/m, 'DNSStubListener=no')
      : raw.trimEnd() + '\nDNSStubListener=no\n';
    fs.writeFileSync(resolvedConfPath, raw, 'utf-8');
  }
  await nsenter('systemctl', ['restart', 'systemd-resolved']).catch(() => {});
  // resolv.conf is normally a symlink into systemd-resolved's territory —
  // fs.writeFileSync() would follow it and overwrite systemd-resolved's own stub
  // file instead of replacing the symlink itself (which it would just regenerate
  // later, silently undoing this fix). Unlink first, exactly like the manual fix.
  const resolvConfPath = '/proc/1/root/etc/resolv.conf';
  try {
    const st = fs.lstatSync(resolvConfPath);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(resolvConfPath);
  } catch { /* doesn't exist yet — fine */ }
  fs.writeFileSync(resolvConfPath, 'nameserver 127.0.0.1\n', 'utf-8');
}


// ── DNS boot-race gate (systemd) ─────────────────────────────────────────────
//
// Real outage, confirmed live 2026-10-06 after a power loss: 9 of the 17 core
// NFs stayed down after the host came back, with zero self-recovery, until
// started by hand. Host booted 16:50:26; bind9 only became active 16:50:39.
// Every NF resolves its own advertise FQDN synchronously at startup
// (getaddrinfo() in ogs_sbi_context_parse_server_config) and aborts FATALLY if
// it fails — CLAUDE.md pattern #6 — and the stock Open5GS units pair
// `After=network.target` (no DNS ordering at all) with `Restart=on-failure` +
// `RestartSec=100ms` and systemd's default `StartLimitBurst=5` /
// `StartLimitIntervalSec=10s`. So each NF burned its entire 5-attempt budget
// within ~0.5s of boot, ~12s before DNS could answer, and systemd then gave up
// PERMANENTLY ("Start request repeated too quickly"). Nothing was
// misconfigured; the NFs simply lost a race they normally win.
//
// This is the SECOND occurrence of that exact signature. The first
// (2026-09-23, on the fresh-host restore VM) had a completely different root
// cause — resolv.conf still pointing at systemd-resolved's stub instead of the
// local BIND — and was fixed by fixResolver() above. The lesson of having two
// different causes produce the same permanent outage is that the real
// liability is the AMPLIFIER, not any one cause: any DNS unavailability at
// boot, from any cause, becomes a permanent manual-intervention outage. This
// gate fixes the amplifier, so a third, different cause degrades into a slow
// start instead of a dead core.
//
// Two deliberately independent layers:
//
//  1. A hard readiness barrier (open5gs-dns-ready.service) that does not
//     complete until a real query actually resolves. Ordering on named.service
//     alone would NOT be sufficient: on that same boot, NRF's getaddrinfo
//     failed at 16:50:39, the exact second bind9 reported active. "Active" is
//     not "answering"; only a real query proves it.
//  2. A patient restart budget on each NF, as the cause-agnostic safety net
//     for anything the gate cannot foresee (DNS going away again after the
//     gate released, a zone reload, a transient SERVFAIL).
//
// Bump DNS_BOOT_GATE_REV whenever the generated content below changes —
// installDnsBootGate() reinstalls on a rev mismatch. This project has been
// bitten repeatedly by edited-source-doesn't-redeploy-a-built-artifact bugs
// (see CLAUDE.md's Kamailio patching-step gotcha and its 4 recurrences), so
// the rev is stamped into each generated file and checked rather than assumed.
export const DNS_BOOT_GATE_REV = 1;

const DNS_BOOT_GATE_SCRIPT_PATH = '/usr/local/sbin/open5gs-wait-dns.sh';
const DNS_BOOT_GATE_UNIT_NAME   = 'open5gs-dns-ready.service';
const DNS_BOOT_GATE_DROPIN_NAME = '10-dns-boot-race.conf';
const DNS_BOOT_GATE_REV_TAG     = `open5gs-nms dns-boot-gate rev ${DNS_BOOT_GATE_REV}`;
// Generous: a genuinely broken (not merely slow) DNS costs this much boot
// delay before the gate gives up and releases.
const DNS_BOOT_GATE_WAIT_SECONDS = 300;

// Non-Open5GS units that also resolve FQDNs and therefore should not start
// before DNS answers. Kamailio's cdp module resolves a <Peer FQDN=...> via a
// real synchronous getaddrinfo() at connect time (CLAUDE.md pattern #18);
// PyHSS and VectorCore resolve realm/peer names of their own. None of these
// were among the units that failed on 2026-10-06, so they get ORDERING ONLY —
// no restart-policy change — keeping this zero-risk for services that are not
// currently affected. Units absent on a given deployment are skipped.
const DNS_DEPENDENT_EXTRA_UNITS = [
  'kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-smsc',
  'pyhss-diameter', 'pyhss-hss', 'pyhss-api', 'pyhss-metrics',
  'vectorcore-smsc', 'vectorcore-mmsc', 'vectorcore-mm1-proxy',
];

function dnsBootGateScript(): string {
  return `#!/bin/bash
# ${DNS_BOOT_GATE_REV_TAG} — generated by bind-controller.ts, do not hand-edit.
#
# Block until the local resolver ACTUALLY answers for this deployment's own
# 3GPP zone — not merely until bind9's unit reports "active". See
# installDnsBootGate() in bind-controller.ts for the full rationale and the
# real 2026-10-06 outage that prompted it.
#
# The FQDNs are derived from the live NF configs rather than hardcoded, so this
# keeps working after a PLMN change or a DNS/FQDN Migration Wizard run instead
# of silently waiting on a zone that no longer exists.
set -u
TIMEOUT=\${1:-${DNS_BOOT_GATE_WAIT_SECONDS}}
TAG=open5gs-wait-dns

mapfile -t FQDNS < <(grep -rhoE '[a-z0-9._-]+\\.3gppnetwork\\.org' /etc/open5gs/*.yaml 2>/dev/null | sort -u)

if [ \${#FQDNS[@]} -eq 0 ]; then
  logger -t "\$TAG" "No 3gppnetwork.org FQDN in /etc/open5gs/*.yaml -- IP-only deployment, nothing to wait for"
  exit 0
fi

start=\$SECONDS
while :; do
  # Any ONE resolving proves the zone is loaded and being served. Checking all
  # of them (not just the first) means a single stale/removed record cannot
  # stall the whole boot for the full timeout.
  for f in "\${FQDNS[@]}"; do
    if getent hosts "\$f" >/dev/null 2>&1; then
      logger -t "\$TAG" "DNS ready: \$f resolved after \$((SECONDS-start))s"
      exit 0
    fi
  done
  if [ \$((SECONDS-start)) -ge "\$TIMEOUT" ]; then
    # Deliberately exit 0, never 1: this gate must never be able to permanently
    # wedge the whole core. Releasing lets each NF's own restart budget (see the
    # ${DNS_BOOT_GATE_DROPIN_NAME} drop-ins) keep retrying instead.
    logger -t "\$TAG" "WARNING: none of \${#FQDNS[@]} FQDNs resolving after \${TIMEOUT}s -- releasing gate; NF restart budgets will keep retrying"
    exit 0
  fi
  sleep 1
done
`;
}

function dnsBootGateUnit(): string {
  return `# ${DNS_BOOT_GATE_REV_TAG} — generated by bind-controller.ts, do not hand-edit.
# DNS readiness barrier for the Open5GS core. Nothing DNS-dependent should
# start before this unit completes. See ${DNS_BOOT_GATE_SCRIPT_PATH}.
[Unit]
Description=Wait for DNS to actually answer before starting Open5GS NFs
After=named.service network.target
Wants=named.service

[Service]
Type=oneshot
# Stay "active" after exiting so After= ordering also holds for any later
# manual start of a single NF, not just the boot sequence.
RemainAfterExit=yes
ExecStart=${DNS_BOOT_GATE_SCRIPT_PATH} ${DNS_BOOT_GATE_WAIT_SECONDS}
# Must exceed the script's own timeout so systemd never kills it mid-wait.
TimeoutStartSec=${DNS_BOOT_GATE_WAIT_SECONDS + 60}

[Install]
WantedBy=multi-user.target
`;
}

function dnsBootGateNfDropIn(): string {
  return `# ${DNS_BOOT_GATE_REV_TAG} — generated by bind-controller.ts, do not hand-edit.
#
# Survive a slow-DNS boot. See installDnsBootGate() in bind-controller.ts for
# the real 2026-10-06 power-loss outage this fixes and why ordering alone is
# not sufficient.
#
# Layer 1: the gate below does not complete until a real DNS query succeeds.
# Layer 2: the restart budget is the cause-agnostic safety net. RestartSec=5
# with up to 60 starts per 600s window is roughly 5 minutes of patient
# retrying — but systemd DOES still give up eventually, so a genuinely broken
# config cannot spin forever filling the journal.
[Unit]
After=${DNS_BOOT_GATE_UNIT_NAME}
Wants=${DNS_BOOT_GATE_UNIT_NAME}
StartLimitIntervalSec=600
StartLimitBurst=60

[Service]
RestartSec=5
`;
}

function dnsBootGateOrderingOnlyDropIn(): string {
  return `# ${DNS_BOOT_GATE_REV_TAG} — generated by bind-controller.ts, do not hand-edit.
#
# Do not start before DNS actually answers. This service resolves FQDNs of its
# own (see DNS_DEPENDENT_EXTRA_UNITS in bind-controller.ts). Ordering ONLY — no
# restart policy is changed here, since none of these units were among those
# that failed on the 2026-10-06 boot.
[Unit]
After=${DNS_BOOT_GATE_UNIT_NAME}
Wants=${DNS_BOOT_GATE_UNIT_NAME}
`;
}

// Every Open5GS NF unit, derived from the single canonical service map rather
// than a parallel hardcoded list — so a future NF added there is covered here
// automatically instead of being silently missed.
function open5gsNfUnits(): string[] {
  return Object.values(SERVICE_UNIT_MAP).filter(u => u.startsWith('open5gs-'));
}

async function unitExists(unit: string): Promise<boolean> {
  try {
    await nsenter('systemctl', ['cat', `${unit}.service`], 10000);
    return true;
  } catch {
    return false;
  }
}

export interface DnsBootGateStatus {
  installed: boolean;      // gate script + unit present at the current rev
  deployedRev: number | null;
  currentRev: number;
}

export function checkDnsBootGate(): DnsBootGateStatus {
  let deployedRev: number | null = null;
  try {
    const raw = fs.readFileSync(`/proc/1/root${DNS_BOOT_GATE_SCRIPT_PATH}`, 'utf-8');
    const m = raw.match(/dns-boot-gate rev (\d+)/);
    if (m) deployedRev = Number(m[1]);
  } catch { /* not installed */ }
  const unitPresent = fs.existsSync(`/proc/1/root/etc/systemd/system/${DNS_BOOT_GATE_UNIT_NAME}`);
  return {
    installed: unitPresent && deployedRev === DNS_BOOT_GATE_REV,
    deployedRev,
    currentRev: DNS_BOOT_GATE_REV,
  };
}

// Installs (or re-installs, on a rev bump) the DNS readiness gate and the
// per-unit drop-ins. Idempotent — safe to call unconditionally. Called from
// fresh-host-bootstrap-usecase.ts (a genuinely new host), dns-migration-
// usecase.ts (the moment a deployment becomes vulnerable to pattern #6 by
// moving onto FQDNs at all), and backup-restart-usecase.ts (a restore onto a
// new host, where the 2026-09-23 occurrence actually happened).
//
// Deliberately regenerated from these constants rather than archived into a
// backup and restored: a restored copy would be a point-in-time artifact that
// could silently be older than the code, which is precisely the stale-artifact
// bug class this project keeps rediscovering.
export async function installDnsBootGate(): Promise<{ units: string[]; skipped: string[] }> {
  fs.mkdirSync('/proc/1/root/usr/local/sbin', { recursive: true });
  fs.writeFileSync(`/proc/1/root${DNS_BOOT_GATE_SCRIPT_PATH}`, dnsBootGateScript(), { encoding: 'utf-8', mode: 0o755 });
  // writeFileSync's mode only applies when creating the file — chmod explicitly
  // so a re-install over an existing file can't leave it non-executable.
  fs.chmodSync(`/proc/1/root${DNS_BOOT_GATE_SCRIPT_PATH}`, 0o755);
  fs.writeFileSync(`/proc/1/root/etc/systemd/system/${DNS_BOOT_GATE_UNIT_NAME}`, dnsBootGateUnit(), 'utf-8');

  const units: string[] = [];
  const skipped: string[] = [];

  for (const unit of open5gsNfUnits()) {
    if (!(await unitExists(unit))) { skipped.push(unit); continue; }
    const dir = `/proc/1/root/etc/systemd/system/${unit}.service.d`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${DNS_BOOT_GATE_DROPIN_NAME}`, dnsBootGateNfDropIn(), 'utf-8');
    units.push(unit);
  }

  for (const unit of DNS_DEPENDENT_EXTRA_UNITS) {
    if (!(await unitExists(unit))) { skipped.push(unit); continue; }
    const dir = `/proc/1/root/etc/systemd/system/${unit}.service.d`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${DNS_BOOT_GATE_DROPIN_NAME}`, dnsBootGateOrderingOnlyDropIn(), 'utf-8');
    units.push(unit);
  }

  await nsenter('systemctl', ['daemon-reload'], 30000);
  await nsenter('systemctl', ['enable', DNS_BOOT_GATE_UNIT_NAME], 20000);
  // Start it now too: RemainAfterExit keeps it active, so any NF restarted
  // later in this same session (or by a restore's own reapply steps) doesn't
  // block waiting on a gate that has never run.
  await nsenter('systemctl', ['start', DNS_BOOT_GATE_UNIT_NAME], (DNS_BOOT_GATE_WAIT_SECONDS + 60) * 1000);
  return { units, skipped };
}

function repairZonesAndOptions(): { zonesRepaired: string[] } {
  const namedLocalPath = `${HOST_BIND_DIR}/named.conf.local`;
  const health = checkBindHealth();

  if (health.undeclaredZones.length > 0) {
    let raw = fs.existsSync(namedLocalPath) ? fs.readFileSync(namedLocalPath, 'utf-8') : '';
    for (const zoneName of health.undeclaredZones) {
      const zoneBlock = `\nzone "${zoneName}" {\n    type master;\n    file "/etc/bind/zones/${zoneName}.zone";\n};\n`;
      raw = raw.trimEnd() + '\n' + zoneBlock;
    }
    fs.mkdirSync(path.dirname(namedLocalPath), { recursive: true });
    fs.writeFileSync(namedLocalPath, raw.trimStart(), 'utf-8');
  }

  if (health.optionsNeedsRepair) {
    const existingForwarders = readForwarders();
    writeForwarders(existingForwarders.length > 0 ? existingForwarders : ['8.8.8.8', '8.8.4.4']);
    writeListenOn(readListenOn());
    ensureRecursionAndAllowQuery();
  }

  return { zonesRepaired: health.undeclaredZones };
}

export function createBindRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // Upstream DNS forwarders — without this, a UE using this server as its DNS would
  // resolve IMS/VoWiFi-specific names fine but get nothing for general internet domains.
  // `recursion yes` + this forwarders list is what makes it a usable full DNS server, not
  // just an authoritative one for our own zones.
  router.get('/forwarders', (_req: Request, res: Response) => {
    res.json({ success: true, forwarders: readForwarders() });
  });

  router.put('/forwarders', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { forwarders } = req.body as { forwarders: string[] };
    if (!Array.isArray(forwarders) || forwarders.length === 0 || !forwarders.every(f => IP_RE.test(f))) {
      return res.status(400).json({ success: false, error: 'forwarders must be a non-empty array of IPv4 addresses' });
    }
    try {
      writeForwarders(forwarders);
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({ action: 'bind_config_save', user, target: 'forwarders', details: forwarders.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'forwarders', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Which local IPs BIND actually binds to — the single owner of this setting. IMS and
  // VoWiFi each build their own zone files, but neither writes listen-on anymore; if a
  // module needs BIND reachable on a specific IP (e.g. the one served to UEs via SMF
  // PCO), that IP needs to be added here too, not just referenced in a zone.
  router.get('/listen-on', (_req: Request, res: Response) => {
    res.json({ success: true, listenOn: readListenOn() });
  });

  router.put('/listen-on', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { listenOn } = req.body as { listenOn: string[] };
    if (!Array.isArray(listenOn) || listenOn.length === 0 || !listenOn.every(ip => IP_RE.test(ip))) {
      return res.status(400).json({ success: false, error: 'listenOn must be a non-empty array of IPv4 addresses' });
    }
    try {
      writeListenOn(listenOn);
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({ action: 'bind_config_save', user, target: 'listen-on', details: listenOn.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'listen-on', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const installed = fs.existsSync('/proc/1/root/usr/sbin/named');
      const active = installed
        ? await nsenter('systemctl', ['is-active', 'bind9']).then(r => r.stdout.trim() === 'active').catch(() => false)
        : false;
      const health = checkBindHealth();
      res.json({
        success: true, installed, running: active, fileCount: listBindFiles().length,
        undeclaredZones: health.undeclaredZones,
        optionsNeedsRepair: health.optionsNeedsRepair,
        resolvConfBypassesBind: health.resolvConfBypassesBind,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /repair — self-heal named.conf.local/named.conf.options after they've been
  // reset to stock (e.g. `apt purge bind9` wipes conffiles but not the zones/ directory,
  // which the package doesn't own). Re-declares any zone file found on disk that's
  // missing its zone{} block, and re-asserts recursion/allow-query/forwarders/listen-on
  // if any are missing. Safe to call anytime — a no-op if nothing needs fixing.
  router.post('/repair', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { zonesRepaired } = repairZonesAndOptions();
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({
        action: 'bind_config_save', user, target: 'repair',
        details: `zones repaired: ${zonesRepaired.join(', ') || 'none'}`, success: true,
      });
      res.json({ success: true, zonesRepaired });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'repair', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /fix-resolver — separate, explicit action from /repair: disables
  // systemd-resolved's stub listener and replaces /etc/resolv.conf with a static file
  // pointing straight at BIND. This changes host-wide DNS resolution behavior (not just
  // BIND's own config), so it's deliberately not bundled into /repair — the operator
  // should consciously opt into it. Real incident (2026-07-17): even with BIND itself
  // perfectly healthy, getaddrinfo() (what every NF actually calls) was still bypassing
  // it entirely because /etc/resolv.conf pointed at systemd-resolved's 127.0.0.53 stub.
  router.post('/fix-resolver', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await fixResolver();
      await auditLogger.log({ action: 'bind_config_save', user, target: 'fix-resolver', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'fix-resolver', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /install — streamed synchronous install (apt only, fast — no build step)
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', '-c', bashScript],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', code => resolve(code ?? 1));
      });

    try {
      write('=== Installing BIND9 ===');
      await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get install -y bind9 bind9utils dnsutils 2>&1');
      fs.mkdirSync(`${HOST_BIND_DIR}/zones`, { recursive: true });
      // Seed a working baseline only if it isn't already actively configured — reuses
      // the exact same repair logic /api/bind/repair uses, since "never configured yet"
      // and "reset to stock by an apt purge" are the same underlying condition (missing
      // recursion/allow-query/forwarders/listen-on). Checking mere file *existence*
      // doesn't work here: bind9's own postinst always creates named.conf.options
      // immediately as part of `apt-get install`, so that check could never actually
      // fire — confirmed live (2026-07-18), this seeding silently never ran on a fresh
      // install and the DNS page kept reporting "needs repair" until /repair was called
      // by hand. If the user (or an old install) already actively configured this file,
      // checkBindHealth().optionsNeedsRepair is false and this is a no-op, same as before.
      if (checkBindHealth().optionsNeedsRepair) {
        repairZonesAndOptions();
        await nsenter('systemctl', ['restart', 'bind9']).catch(() => {});
        write('Seeded default named.conf.options (recursion on, forwarders 8.8.8.8/8.8.4.4, listen-on 127.0.0.1).');
      }
      await auditLogger.log({ action: 'bind_install', user, success: true });
      write('\n✅ BIND9 installed.');
      res.end();
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      await auditLogger.log({ action: 'bind_install', user, details: String(err), success: false });
      res.end();
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['enable', '--now', 'bind9']);
      await auditLogger.log({ action: 'bind_start', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_start', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', 'bind9']);
      await auditLogger.log({ action: 'bind_stop', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_stop', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({ action: 'bind_restart', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_restart', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get('/files', (_req: Request, res: Response) => {
    res.json({ success: true, files: listBindFiles() });
  });

  router.get('/files/content', (req: Request, res: Response) => {
    const p = String(req.query.path ?? '');
    if (!isPathInBindDir(p)) return res.status(400).json({ success: false, error: 'Path must be inside /etc/bind' });
    try {
      const content = fs.existsSync(`/proc/1/root${p}`) ? fs.readFileSync(`/proc/1/root${p}`, 'utf-8') : '';
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.put('/files/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: p, content, restart } = req.body as { path: string; content: string; restart?: boolean };
    if (!isPathInBindDir(p)) return res.status(400).json({ success: false, error: 'Path must be inside /etc/bind' });
    try {
      fs.mkdirSync(path.dirname(`/proc/1/root${p}`), { recursive: true });
      fs.writeFileSync(`/proc/1/root${p}`, content, 'utf-8');
      if (restart) await nsenter('systemctl', ['restart', 'bind9']).catch(() => {});
      await auditLogger.log({ action: 'bind_config_save', user, target: p, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: p, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.delete('/files', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const p = String(req.query.path ?? '');
    if (!isPathInBindDir(p)) return res.status(400).json({ success: false, error: 'Path must be inside /etc/bind' });
    try {
      if (fs.existsSync(`/proc/1/root${p}`)) fs.unlinkSync(`/proc/1/root${p}`);
      await auditLogger.log({ action: 'bind_config_delete', user, target: p, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_delete', user, target: p, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
