import { Router, Request, Response } from 'express';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import pino from 'pino';
import * as yaml from 'js-yaml';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { convertRepeatedMapKeysToArray } from '../../infrastructure/yaml/yaml-config-repository';

const execFileAsync = promisify(execFile);

const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

const HOST_MME_YAML    = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_OSMOCOM_DIR = '/proc/1/root/etc/osmocom';

interface SmsConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
}

const SMS_CONFIG_MANIFEST: Omit<SmsConfigFile, 'exists'>[] = [
  { path: `${HOST_OSMOCOM_DIR}/osmo-stp.cfg`,      label: 'osmo-stp.cfg',  group: 'Osmocom',  language: 'ini',  restartServices: ['osmo-stp']      },
  { path: `${HOST_OSMOCOM_DIR}/osmo-hlr.cfg`,      label: 'osmo-hlr.cfg',  group: 'Osmocom',  language: 'ini',  restartServices: ['osmo-hlr']      },
  { path: `${HOST_OSMOCOM_DIR}/osmo-msc.cfg`,      label: 'osmo-msc.cfg',  group: 'Osmocom',  language: 'ini',  restartServices: ['osmo-msc']      },
];

const SMS_ALLOWED_PATHS = new Set(SMS_CONFIG_MANIFEST.map(f => f.path));
const HOST_SGSAP_BAK   = '/proc/1/root/etc/open5gs/.sgsap.bak';
// Path as seen from the HOST (via nsenter), not via /proc/1/root:
const HOST_HLR_DB      = '/var/lib/osmocom/hlr.db';

// Standard Osmocom VTY telnet port for osmo-msc.
const MSC_VTY_PORT = 4254;

// Sends the VTY commands over a raw TCP socket entirely in Python argv — never
// interpolated into a shell string — so command/VTY injection isn't possible
// even from attacker-controlled `text`. Runs inside the host netns via nsenter
// since the VTY only binds a host-local IP unreachable from inside this container.
const VTY_SEND_SMS_SCRIPT = `
import socket, sys, time
host, port, to, frm, text = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
s = socket.create_connection((host, port), timeout=5)
s.settimeout(2)
def drain():
    out = b''
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            out += chunk
    except socket.timeout:
        pass
    return out
drain()
s.sendall(b'enable\\r\\n')
time.sleep(0.3)
drain()
cmd = 'subscriber msisdn ' + to + ' sms sender msisdn ' + frm + ' send ' + text + '\\r\\n'
s.sendall(cmd.encode())
time.sleep(0.5)
print(drain().decode(errors='replace'))
s.close()
`;

// Registers/updates one SMPP ESME on the live osmo-msc VTY, then persists it
// to disk with the VTY's own `write` command — applies instantly with no
// osmo-msc restart (confirmed live: adding/removing an esme this way takes
// effect immediately, no SMS-service interruption), and `write` writes the
// running-config back to the same file osmo-msc was launched with, so a
// future restart (of osmo-msc itself, or the host) doesn't lose it. argv-only,
// same injection-safe pattern as VTY_SEND_SMS_SCRIPT above.
const VTY_UPSERT_ESME_SCRIPT = `
import socket, sys, time
host, port, name, password = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
# argv[5] (optional): '1' -> also set this ESME as osmo-msc's MO default-route
# (used by the VectorCore SMSC 2G<->4G bridge so every 2G MO SMS is handed to
# VectorCore for routing). Absent/'0' -> plain ESME, as SMS-over-SGs / MMS use.
defroute = len(sys.argv) > 5 and sys.argv[5] == '1'
s = socket.create_connection((host, port), timeout=5)
s.settimeout(2)
def drain():
    out = b''
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            out += chunk
    except socket.timeout:
        pass
    return out
drain()
cmds = ['enable', 'configure terminal', 'smpp', 'esme ' + name, 'password ' + password, 'dcs-transparent']
if defroute:
    cmds += ['default-route']
cmds += ['end', 'write']
for cmd in cmds:
    s.sendall((cmd + '\\r\\n').encode())
    time.sleep(0.3)
print(drain().decode(errors='replace'))
s.close()
`;

// ─── Config templates ──────────────────────────────────────────────────────────

function osmostpCfg(): string {
  // `xua rkm routing-key-allocation dynamic-permitted` — found live (2G GSM
  // module bring-up): `accept-asp-connections dynamic-permitted` above only
  // lets a NEW ASP connect at all; it does NOT let that ASP dynamically
  // allocate its own routing-key/AS, which is a separate RKM (Routing Key
  // Management) policy. Without this, a new SIGTRAN client that doesn't have
  // a pre-defined `as`/routing-key entry here (e.g. osmo-bsc's A-interface
  // connection, auto-generated with routing context 1) gets rejected with
  // "RCTX 1 not found in configuration, and dynamic RKM allocation not
  // permitted" on every registration attempt, retried forever — confirmed
  // live via osmo-stp's own journal. Safe to enable unconditionally: SGs-SMS
  // (osmo-msc's only current consumer of this file) talks direct SCTP to
  // the MME and GSUP to osmo-hlr, neither through this STP at all, so
  // nothing about existing SMS-over-SGs behavior changes.
  //
  // point-code 0.24.1, not 0.23.1 — found live (2G GSM module bring-up,
  // real BSSMAP RESET testing): 0.23.1 is the conventional example "MSC"
  // point-code used throughout Osmocom's own docs/tutorials, and osmo-bsc's
  // auto-configuration (when its own cs7 instance isn't given explicitly)
  // defaults to assuming the MSC lives there. This file's own STP was
  // ALSO given 0.23.1 (presumably copied from the same convention without
  // registering that it's "the MSC's" address, not a generic STP one) —
  // meaning the STP and the real MSC (osmo-msc.cfg's own separately-set
  // `cs7 instance 0 / point-code 0.23.1`) were colliding on the identical
  // point-code. That's invalid SCCP topology (the STP needs its own
  // distinct address to route BSSAP messages *to* the MSC rather than
  // treating them as addressed to itself) and was silently swallowing
  // every real BSSAP message between osmo-bsc and osmo-msc — confirmed:
  // before this fix, no BSSMAP RESET ever completed between them despite
  // both sides showing a healthy SIGTRAN AS_ACTIVE state; after moving
  // only the STP to 0.24.1 (leaving osmo-msc.cfg's own real, hand-maintained
  // point-code untouched — it was already correct), a real "RESET ACK from
  // MSC" / "BSSMAP association is up" appeared immediately. Deliberately
  // fixed by moving the STP rather than editing osmo-msc.cfg itself — that
  // file carries real production config (SMPP/VectorCore, codec defaults,
  // SMSC retention policy) this module's own simplified config generator
  // does not model and must never overwrite.
  return `log stderr
 logging filter all 1
 logging print extended-timestamp 1
 logging print category 1
 logging print level 1
cs7 instance 0
 point-code 0.24.1
 xua rkm routing-key-allocation dynamic-permitted
 listen m3ua 2905
  accept-asp-connections dynamic-permitted
 listen sua 14001
  accept-asp-connections dynamic-permitted
line vty
 no login
`;
}

function osmohlrCfg(hlrBindIp: string): string {
  // Note: osmo-hlr v1.5.0 only supports 'bind ip' under gsup — port is fixed at 4222
  return `log stderr
 logging filter all 1
 logging print extended-timestamp 1
 logging print category 1
 logging print level 1
hlr
 database /var/lib/osmocom/hlr.db
 gsup
  bind ip ${hlrBindIp}
line vty
 bind ${hlrBindIp}
 no login
`;
}

// Sidecar marker, not part of osmo-msc.cfg itself — see setMscMgwPeer() below
// for why this exists instead of a second module writing osmo-msc.cfg directly.
const HOST_MSC_MGW_MARKER = `${HOST_OSMOCOM_DIR}/.nms-msc-mgw.json`;

// The 2G GSM module (osmo-bsc, real A-interface voice) needs osmo-msc to have
// its own MGCP connection to an osmo-mgw for real voice bearers — SGs-SMS
// alone never needed one, so osmomscCfg() never wrote one. Rather than a
// second module writing osmo-msc.cfg directly (the exact class of bug
// CLAUDE.md's BIND9 shared-ownership lesson warns about — named.conf.options
// there, osmo-msc.cfg here), this module stays the *sole* writer of the
// file; other modules ask for something to be included via a small,
// targeted, persisted request instead. This marker is that request: any
// future configureSms() run — triggered from this module's own /configure,
// or from plmn-migration-usecase.ts, or anything else that calls it —
// re-reads it and keeps the mgw block included, so a GSM-module-unaware
// reconfigure (e.g. just changing MCC/MNC from the SMS page) can't silently
// drop it.
export function setMscMgwPeer(mgwBindIp: string | null): void {
  fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
  if (mgwBindIp) fs.writeFileSync(HOST_MSC_MGW_MARKER, JSON.stringify({ mgwBindIp }), 'utf-8');
  else if (fs.existsSync(HOST_MSC_MGW_MARKER)) fs.unlinkSync(HOST_MSC_MGW_MARKER);
}

function readMscMgwPeer(): string | null {
  try {
    if (!fs.existsSync(HOST_MSC_MGW_MARKER)) return null;
    return JSON.parse(fs.readFileSync(HOST_MSC_MGW_MARKER, 'utf-8')).mgwBindIp ?? null;
  } catch { return null; }
}

export interface HlrSubscriberStatus {
  imsi: string;
  msisdn: string | null;
  hasAuthKeys: boolean;
  lastLuSeenCs: string | null;
  lastLuSeenPs: string | null;
}

// Read-only cross-module accessor (same pattern as readCurrentSmsConfig) —
// the 2G GSM module's own subscriber-status view needs this, but hlr.db
// stays solely written by this file, per the BIND9-style shared-ownership
// convention this project uses for every other shared config/DB.
export async function listHlrSubscriberStatus(): Promise<HlrSubscriberStatus[]> {
  try {
    const { stdout } = await nsenter('sqlite3', [
      HOST_HLR_DB,
      `SELECT s.imsi || '|' || COALESCE(s.msisdn,'') || '|' || ` +
      `(CASE WHEN a.subscriber_id IS NULL THEN '0' ELSE '1' END) || '|' || ` +
      `COALESCE(s.last_lu_seen,'') || '|' || COALESCE(s.last_lu_seen_ps,'') ` +
      `FROM subscriber s LEFT JOIN auc_3g a ON a.subscriber_id = s.id ORDER BY s.imsi;`,
    ]);
    return stdout.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const [imsi, msisdn, hasKeys, luCs, luPs] = line.split('|');
      return {
        imsi,
        msisdn: msisdn || null,
        hasAuthKeys: hasKeys === '1',
        lastLuSeenCs: luCs || null,
        lastLuSeenPs: luPs || null,
      };
    });
  } catch {
    return [];
  }
}

function osmomscCfg(mcc: string, mnc: string, mscBindIp: string, hlrBindIp: string, mgwBindIp?: string | null): string {
  // Note: osmo-msc v1.9.0 does not accept 'mncc-internal' under 'msc' — omit that line,
  // but 'assign-tmsi' alone under 'msc' is accepted fine (TMSI allocation for identity
  // privacy on the SGs link — was dropped along with the rejected mncc-internal line).
  //
  // Deliberately never writes an `smpp`/`esme` block to this file: osmo-msc's
  // own VTY `write` command strips the `password` line from any esme it
  // saves, and — confirmed the hard way, live, causing a real osmo-msc
  // crash-loop — re-adding a `password` line to the static config file makes
  // osmo-msc FATAL-error on startup ("Failed to parse the config file"). The
  // esme/password pair can only ever be set interactively over the VTY (see
  // upsertSmppEsme() below), never persisted to disk. This is a deliberate
  // upstream behavior (avoids a live secret sitting in a plaintext config
  // dump), not a gap to route around — any module needing SMPP (e.g. MMS)
  // must re-apply its ESME live after every osmo-msc process start, not rely
  // on it surviving in this file.
  const epcDomain = `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
  // ports/field placement confirmed against osmo-msc 1.9.0's own
  // --vty-ref-xml output (config-msc node) and osmo-bsc's shipped default
  // config, which anchors its own mgw connection the same way — 2427 is
  // osmo-mgw's own default MGCP listen port.
  const mgwLines = mgwBindIp ? ` mgw remote-ip ${mgwBindIp}\n mgw remote-port 2427\n mgw local-port 2727\n mgw endpoint-domain msc\n` : '';
  return `log stderr
 logging filter all 1
 logging print extended-timestamp 1
 logging print category 1
 logging print level 1
network
 network country code ${mcc}
 mobile network code ${mnc}
 mm info 1
msc
 assign-tmsi
${mgwLines}hlr
 remote-ip ${hlrBindIp}
 remote-port 4222
sgs
 local-ip ${mscBindIp}
 local-port 29118
 vlr-name vlr.${epcDomain}
line vty
 bind ${hlrBindIp}
 no login
`;
}

interface SgsMapEntry { mcc: string; mnc: string; tac: number; }

// Build the sgsap YAML block indented under mme: (2-space indent). Open5GS
// expresses multiple TAI→LAI mappings (one per PLMN) as *repeated* `map:`
// sibling keys within the same client entry — non-standard YAML, but it's
// what Open5GS's own parser expects (see mme-context.c: it increments
// map_num on every `map:` key it encounters, building an array from
// duplicates rather than reading a `maps:` list). One block per entry here,
// matching that convention exactly.
function sgsapYamlBlock(mscBindIp: string, mmeLocalIp: string, entries: SgsMapEntry[]): string {
  const localLine = mmeLocalIp ? `        local_address: ${mmeLocalIp}\n` : '';
  const mapBlocks = entries.map(({ mcc, mnc, tac }) => `        map:
          tai:
            plmn_id:
              mcc: ${mcc}
              mnc: ${mnc}
            tac: ${tac}
          lai:
            plmn_id:
              mcc: ${mcc}
              mnc: ${mnc}
            lac: ${tac}
`).join('');
  return `  sgsap:
    client:
      - address: ${mscBindIp}
${localLine}        port: 29118
${mapBlocks}`;
}

// Read back any existing sgsap.client[0] map entries (one per PLMN) so a
// /configure call for one PLMN doesn't silently delete another PLMN's SGs
// mapping — replaceSgsapSection() below does a full-section replace, so
// whatever we pass it here has to already include everything we want kept.
function extractExistingMapEntries(raw: string): SgsMapEntry[] {
  const block = extractSgsapBlock(raw);
  if (!block) return [];
  // extractSgsapBlock() keeps the original 2-space indent (nested under
  // mme:) — dedent so `sgsap:` is top-level and parses standalone.
  const dedented = block.split('\n').map(l => l.startsWith('  ') ? l.slice(2) : l).join('\n');
  try {
    const converted = convertRepeatedMapKeysToArray(dedented);
    const doc = yaml.load(converted) as any;
    const maps = doc?.sgsap?.client?.[0]?.maps ?? [];

    // yaml.load() misparses a leading-zero mcc/mnc (e.g. "070") as YAML 1.1
    // octal, silently turning it into a different decimal number — same bug
    // class fixed in yaml-config-repository.ts's saveRaw(). Regex-scan the
    // raw text for the real string values instead of trusting the parsed
    // numbers. Each map entry has two mcc (tai + lai) and two mnc occurrences,
    // always identical by construction (see sgsapYamlBlock) — take the first
    // of each pair, indexed positionally by entry order.
    const mccMatches = [...dedented.matchAll(/^\s*mcc:\s*['"]?(\d+)['"]?/gm)].map(m => m[1]);
    const mncMatches = [...dedented.matchAll(/^\s*mnc:\s*['"]?(\d+)['"]?/gm)].map(m => m[1]);

    return maps
      .map((m: any, i: number) => ({
        mcc: mccMatches[i * 2] ?? (m?.tai?.plmn_id?.mcc != null ? String(m.tai.plmn_id.mcc) : undefined),
        mnc: mncMatches[i * 2] ?? (m?.tai?.plmn_id?.mnc != null ? String(m.tai.plmn_id.mnc) : undefined),
        tac: Number(m?.tai?.tac ?? 1),
      }))
      .filter((e: any): e is SgsMapEntry => e.mcc != null && e.mnc != null);
  } catch {
    return [];
  }
}

// Merge one PLMN's map entry into the existing set: update in place if that
// PLMN is already mapped, otherwise append — every other PLMN's entry passes
// through untouched.
function mergeMapEntry(existing: SgsMapEntry[], next: SgsMapEntry): SgsMapEntry[] {
  const idx = existing.findIndex(e => e.mcc === next.mcc && e.mnc === next.mnc);
  if (idx === -1) return [...existing, next];
  const merged = [...existing];
  merged[idx] = next;
  return merged;
}

// Remove ALL sgsap: sections (at any indent level, handles duplicates) then append newBlock.
function replaceSgsapSection(raw: string, newBlock: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^( *)sgsap:/);
    if (m) {
      const sgsapIndent = m[1].length;
      i++;
      // Skip all children of this sgsap block (deeper indent or empty lines)
      while (i < lines.length) {
        if (lines[i].length > 0) {
          const lineIndent = (lines[i].match(/^( *)/) ?? ['', ''])[1].length;
          if (lineIndent <= sgsapIndent) break;
        }
        i++;
      }
      // i now points to the line after this sgsap block; loop continues to catch duplicates
    } else {
      kept.push(lines[i]);
      i++;
    }
  }
  return kept.join('\n').trimEnd() + '\n' + newBlock;
}

// Extract the sgsap block verbatim (used for backup before disable)
function extractSgsapBlock(raw: string): string {
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^( *)sgsap:/);
    if (m) {
      const sgsapIndent = m[1].length;
      const block: string[] = [lines[i]];
      i++;
      while (i < lines.length) {
        if (lines[i].length > 0) {
          const lineIndent = (lines[i].match(/^( *)/) ?? ['', ''])[1].length;
          if (lineIndent <= sgsapIndent) break;
        }
        block.push(lines[i]);
        i++;
      }
      return block.join('\n') + '\n';
    }
    i++;
  }
  return '';
}

// ─── Configure (extracted for reuse by the PLMN Migration Wizard) ─────────────
// mcc/mnc/tac are deliberately NOT parameters here — this always re-reads them
// fresh from mme.yaml, same as the original route body. That's exactly why the
// PLMN migration use-case must call this AFTER mme.yaml's plmn_id has already
// been rewritten (its own Phase B), not before.
export interface SmsConfigureInput {
  mscBindIp: string;
  hlrBindIp: string;
  mmeLocalIp: string;
  // If provided and different from the newly-read mcc/mnc, that PLMN's sgsap map
  // entry is dropped rather than left stale alongside the new one — mergeMapEntry()
  // only ever adds/updates by (mcc,mnc) key, it never removes, so a primary-PLMN
  // replace would otherwise accumulate an orphaned entry for the old PLMN forever.
  previousMcc?: string;
  previousMnc?: string;
}

// Reads back the currently-configured bind IPs from the live host files, so the
// PLMN migration use-case can pass `{ ...readCurrentSmsConfig(), }` into
// configureSms() instead of an empty body — configureSms() has no internal
// defaults, so an empty/partial body would otherwise write '' for fields whose
// real value only ever lived in these on-disk configs (no .sms-config.json
// exists for this module, unlike IMS/VoWiFi).
export function readCurrentSmsConfig(): SmsConfigureInput | null {
  const mscCfgPath = `${HOST_OSMOCOM_DIR}/osmo-msc.cfg`;
  const hlrCfgPath = `${HOST_OSMOCOM_DIR}/osmo-hlr.cfg`;
  if (!fs.existsSync(mscCfgPath) || !fs.existsSync(hlrCfgPath)) return null;
  try {
    const mscRaw = fs.readFileSync(mscCfgPath, 'utf-8');
    const hlrRaw = fs.readFileSync(hlrCfgPath, 'utf-8');
    const mscBindIp = mscRaw.match(/^\s*local-ip\s+(\S+)/m)?.[1] ?? '127.0.0.2';
    const hlrBindIp = hlrRaw.match(/^\s*bind ip\s+(\S+)/m)?.[1] ?? '127.0.0.1';
    let mmeLocalIp = '';
    if (fs.existsSync(HOST_MME_YAML)) {
      const mmeRaw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
      const block = extractSgsapBlock(mmeRaw);
      mmeLocalIp = block.match(/local_address:\s*(\S+)/)?.[1] ?? '';
    }
    return { mscBindIp, hlrBindIp, mmeLocalIp };
  } catch {
    return null;
  }
}

// ⚠️ REAL RISK, found live (2G GSM module bring-up, 2026-09-09) reading the
// actual production osmo-msc.cfg on this host: it is a *hand/VTY-maintained*
// file carrying real config this function's own osmomscCfg() template does
// not model at all — SMPP/esme (VectorCore MMSC), mncc-int codec defaults,
// full encryption/authentication settings, smsc retention policy, extended
// per-category logging levels. This function *fully regenerates the file
// from scratch* on every call — if it is ever actually invoked against a
// deployment whose osmo-msc.cfg has accumulated any such extra config (this
// one has), it silently destroys all of it. This was never actually
// triggered this session (every verification here was done via direct file
// inspection/targeted edits specifically to avoid calling this), but it is
// a latent landmine in the existing SMS module, not something introduced by
// the GSM module — anyone calling the SMS page's own "Configure" button
// carries the same risk today. Fixing it properly (teaching osmomscCfg() to
// preserve unknown directives, i.e. a real merge instead of blind
// regeneration) is real, separate work — flagging clearly rather than
// papering over it, and specifically *not* attempting that merge here.
export async function configureSms(input: SmsConfigureInput): Promise<{ mcc: string; mnc: string; tac: number }> {
  const { mscBindIp, hlrBindIp, mmeLocalIp, previousMcc, previousMnc } = input;

  // Read MME config for mcc/mnc/tac
  let mcc = '001';
  let mnc = '01';
  let tac = 1;
  if (fs.existsSync(HOST_MME_YAML)) {
    const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    // Simple regex extraction — avoids yaml.dump round-trip issues
    const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
    const tacM = raw.match(/tac:\s*(\d+)/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
    if (tacM) tac = parseInt(tacM[1]);
  }

  // Write Osmocom config files
  fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_OSMOCOM_DIR}/osmo-stp.cfg`, osmostpCfg(), 'utf-8');
  fs.writeFileSync(`${HOST_OSMOCOM_DIR}/osmo-msc.cfg`, osmomscCfg(mcc, mnc, mscBindIp, hlrBindIp, readMscMgwPeer()), 'utf-8');

  // Update MME sgsap section — preserve any other PLMN's existing map
  // entry (e.g. a roaming PLMN configured separately) rather than
  // wiping the whole section down to just this one PLMN. Only write +
  // restart the MME when the file content actually changes: this function
  // is also called as a side effect of the 2G GSM module's Configure
  // (shared osmo-stp/hlr/msc foundation), and an unconditional MME restart
  // there drops S1AP on every 4G eNB for ~10-30s every time — a real,
  // user-visible "my 4G radios vanished" with no actual sgsap change.
  let mmeChanged = false;
  if (fs.existsSync(HOST_MME_YAML)) {
    const raw     = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    let existing = extractExistingMapEntries(raw);
    if (previousMcc && previousMnc && (previousMcc !== mcc || previousMnc !== mnc)) {
      existing = existing.filter(e => !(e.mcc === previousMcc && e.mnc === previousMnc));
    }
    const entries  = mergeMapEntry(existing, { mcc, mnc, tac });
    const block    = sgsapYamlBlock(mscBindIp, mmeLocalIp, entries);
    const newRaw   = replaceSgsapSection(raw, block);
    if (newRaw !== raw) {
      fs.writeFileSync(HOST_MME_YAML, newRaw, 'utf-8');
      mmeChanged = true;
    }
  }

  // Restart MME only if its sgsap config actually changed.
  if (mmeChanged) await nsenter('systemctl', ['restart', 'open5gs-mmed']);

  return { mcc, mnc, tac };
}

// Registers (or updates) one SMPP ESME on osmo-msc — this is the "SGs
// delivery path" primitive: any module that needs to submit MT messages
// (incl. binary/UDH WAP Push) through osmo-msc's SMSC calls this to get
// itself authenticated, rather than editing osmo-msc.cfg directly. Requires
// SMS (SGs) to already be configured (osmo-msc.cfg must exist).
function requireEsmeName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new Error('esme name must be 1-32 characters, alphanumeric/underscore/hyphen only');
  }
}

// Reads the osmo-msc VTY bind address out of the live osmo-msc.cfg. Throws if
// SMS (SGs) hasn't been configured yet — every SMPP primitive in this file
// requires that to already exist.
function getMscVtyHost(): string {
  const mscCfgPath = `${HOST_OSMOCOM_DIR}/osmo-msc.cfg`;
  if (!fs.existsSync(mscCfgPath)) {
    throw new Error('osmo-msc.cfg not found — configure SMS (SGs) before enabling SMPP');
  }
  const raw = fs.readFileSync(mscCfgPath, 'utf-8');
  return raw.match(/line vty[\s\S]*?\n\s*bind\s+(\S+)/)?.[1] ?? '127.0.0.1';
}

export async function upsertSmppEsme(
  name: string,
  password: string,
  opts: { defaultRoute?: boolean } = {},
): Promise<{ success: boolean; output: string }> {
  requireEsmeName(name);
  // Max 8: SMPP 3.4's bind PDU password field is capped at 8 characters by
  // the protocol spec itself — osmo-msc's VTY will accept a longer string
  // with no complaint (it isn't SMPP-PDU-encoded at that point), but any real
  // SMPP client's bind attempt then fails at the wire level ("Data length is
  // invalid"), confirmed live. Enforce the real limit here instead of only
  // discovering it later via a mysteriously-never-connecting ESME.
  if (!/^[A-Za-z0-9_-]{4,8}$/.test(password)) {
    throw new Error('esme password must be 4-8 characters (SMPP 3.4 bind PDU limit), alphanumeric/underscore/hyphen only');
  }
  const vtyHost = getMscVtyHost();

  const { stdout, stderr } = await nsenter(
    'python3',
    ['-c', VTY_UPSERT_ESME_SCRIPT, vtyHost, String(MSC_VTY_PORT), name, password, opts.defaultRoute ? '1' : '0'],
    10000,
  );
  const output = (stdout + stderr).trim();
  const success = !/% ?Unknown command|%Command incomplete|Connection refused|Traceback/i.test(output);

  // Deliberately does NOT persist this to osmo-msc.cfg — see osmomscCfg()'s
  // header comment. This VTY apply is live-only: it takes effect instantly
  // with no restart, but does not survive a future osmo-msc restart for any
  // reason (manual, host reboot, etc). The caller is responsible for calling
  // this again after any osmo-msc restart it becomes aware of.
  return { success, output };
}

const VTY_CHECK_ESME_SCRIPT = `
import socket, sys, time
host, port, name = sys.argv[1], int(sys.argv[2]), sys.argv[3]
s = socket.create_connection((host, port), timeout=5)
s.settimeout(2)
def drain():
    out = b''
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            out += chunk
    except socket.timeout:
        pass
    return out
drain()
s.sendall(b'enable\\r\\n')
time.sleep(0.3)
drain()
s.sendall(b'show running-config\\r\\n')
time.sleep(0.3)
out = drain().decode(errors='replace')
lines = [l.strip() for l in out.splitlines()]
print('ESME_FOUND' if ('esme ' + name) in lines else 'ESME_MISSING')
s.close()
`;

// Checks whether an ESME is CURRENTLY bound-capable on the live osmo-msc VTY
// (i.e. survived since it was last applied via upsertSmppEsme()). Needed
// because the password never persists across an osmo-msc restart (see
// upsertSmppEsme()'s comment) — any module relying on SMPP should poll this
// and re-call upsertSmppEsme() if it comes back false, rather than assuming
// a one-time Configure-time apply is enough forever.
export async function isSmppEsmeActive(name: string): Promise<boolean> {
  requireEsmeName(name);
  let vtyHost: string;
  try {
    vtyHost = getMscVtyHost();
  } catch {
    return false;
  }
  try {
    const { stdout } = await nsenter(
      'python3',
      ['-c', VTY_CHECK_ESME_SCRIPT, vtyHost, String(MSC_VTY_PORT), name],
      10000,
    );
    return stdout.includes('ESME_FOUND');
  } catch {
    return false;
  }
}

const VTY_REMOVE_ESME_SCRIPT = `
import socket, sys, time
host, port, name = sys.argv[1], int(sys.argv[2]), sys.argv[3]
s = socket.create_connection((host, port), timeout=5)
s.settimeout(2)
def drain():
    out = b''
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk: break
            out += chunk
    except socket.timeout:
        pass
    return out
drain()
for cmd in ['enable', 'configure terminal', 'smpp', 'no esme ' + name, 'end', 'write']:
    s.sendall((cmd + '\\r\\n').encode())
    time.sleep(0.3)
print(drain().decode(errors='replace'))
s.close()
`;

// Removes an ESME from osmo-msc, live, no restart — the uninstall-time
// counterpart to upsertSmppEsme().
export async function removeSmppEsme(name: string): Promise<{ success: boolean; output: string }> {
  requireEsmeName(name);
  const vtyHost = getMscVtyHost();
  const { stdout, stderr } = await nsenter(
    'python3',
    ['-c', VTY_REMOVE_ESME_SCRIPT, vtyHost, String(MSC_VTY_PORT), name],
    10000,
  );
  const output = (stdout + stderr).trim();
  const success = !/% ?Unknown command|%Command incomplete|Connection refused|Traceback/i.test(output);
  return { success, output };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createSmsRouter(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  // GET /api/sms/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const { stdout: whichOut } = await nsenter('which', ['osmo-msc']).catch(() => ({ stdout: '', stderr: '' }));
      const installed = whichOut.trim().length > 0;

      const [stpRes, hlrRes, mscRes] = await Promise.allSettled([
        nsenter('systemctl', ['is-active', 'osmo-stp']),
        nsenter('systemctl', ['is-active', 'osmo-hlr']),
        nsenter('systemctl', ['is-active', 'osmo-msc']),
      ]);
      const svcActive = (r: PromiseSettledResult<{ stdout: string; stderr: string }>) =>
        r.status === 'fulfilled' && r.value.stdout.trim() === 'active';

      let hlrSubscribers = 0;
      try {
        const { stdout } = await nsenter('sqlite3', [HOST_HLR_DB, 'SELECT COUNT(*) FROM subscriber;']);
        hlrSubscribers = parseInt(stdout.trim()) || 0;
      } catch { /* DB doesn't exist yet */ }

      const allSubs = await subscriberRepo.findAll();
      const open5gsSubscribers = allSubs.filter(s => s.msisdn && s.msisdn.length > 0).length;

      let mmeSgsConfigured = false;
      let currentConfig = { mscBindIp: '127.0.0.2', hlrBindIp: '127.0.0.1', mmeLocalIp: '' };
      try {
        if (fs.existsSync(HOST_MME_YAML)) {
          const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
          mmeSgsConfigured = /sgsap:/m.test(raw);
          // Read back mme local SGs IP if configured
          const localAddrM = raw.match(/local_address:\s*(\S+)/);
          if (localAddrM) currentConfig.mmeLocalIp = localAddrM[1];
          // Read back MSC bind IP from sgsap.client.address
          const sgsapAddrM = raw.match(/sgsap:[\s\S]*?address:\s*(\S+)/);
          if (sgsapAddrM) currentConfig.mscBindIp = sgsapAddrM[1];
        }
        const mscCfgPath = `${HOST_OSMOCOM_DIR}/osmo-msc.cfg`;
        if (fs.existsSync(mscCfgPath)) {
          const raw = fs.readFileSync(mscCfgPath, 'utf-8');
          const m = raw.match(/local-ip\s+(\S+)/);
          if (m) currentConfig.mscBindIp = m[1];
        }
        const hlrCfgPath = `${HOST_OSMOCOM_DIR}/osmo-hlr.cfg`;
        if (fs.existsSync(hlrCfgPath)) {
          const raw = fs.readFileSync(hlrCfgPath, 'utf-8');
          const m = raw.match(/bind ip\s+(\S+)/);
          if (m) currentConfig.hlrBindIp = m[1];
        }
      } catch { /* ignore */ }

      const hasSavedConfig = fs.existsSync(HOST_SGSAP_BAK);
      res.json({
        success: true,
        installed,
        services: {
          stp: svcActive(stpRes),
          hlr: svcActive(hlrRes),
          msc: svcActive(mscRes),
        },
        hlrSubscribers,
        open5gsSubscribers,
        mmeSgsConfigured,
        smsEnabled: mmeSgsConfigured,
        hasSavedConfig,
        currentConfig,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'sms status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/install — streaming apt install
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders();
    const child = exec(
      `nsenter -t 1 -m -u -i -p -- bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y osmo-stp osmo-hlr osmo-msc sqlite3'`
    );
    child.stdout?.on('data', (d: Buffer) => res.write(d.toString()));
    child.stderr?.on('data', (d: Buffer) => res.write(d.toString()));
    child.on('close', async (code) => {
      const ok = code === 0;
      await auditLogger.log({ action: 'sms_install', user, details: `exit code ${code}`, success: ok });
      res.write(ok ? '\n✅ Osmocom packages installed.\n' : `\n❌ Install failed (exit ${code}).\n`);
      res.end();
    });
  });

  // POST /api/sms/configure
  // Body: { mscBindIp?, hlrBindIp?, mmeLocalIp? }
  //   mscBindIp  — IP OsmoMSC binds SGs on; MME connects here     (default: 127.0.0.2)
  //   hlrBindIp  — IP OsmoHLR binds GSUP on; OsmoMSC connects here (default: 127.0.0.1)
  //   mmeLocalIp — MME's local SCTP bind for the SGs link           (default: '' = OS picks)
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const mscBindIp  = (req.body.mscBindIp  as string) || '127.0.0.2';
      const hlrBindIp  = (req.body.hlrBindIp  as string) || '127.0.0.1';
      const mmeLocalIp = (req.body.mmeLocalIp as string) || '';

      const { mcc, mnc, tac } = await configureSms({ mscBindIp, hlrBindIp, mmeLocalIp });

      await auditLogger.log({
        action: 'sms_configure', user,
        details: `mcc=${mcc} mnc=${mnc} tac=${tac} mscBindIp=${mscBindIp} hlrBindIp=${hlrBindIp}`,
        success: true,
      });
      res.json({ success: true, message: 'Osmocom configs written and MME restarted.', mcc, mnc, tac });
    } catch (err) {
      await auditLogger.log({ action: 'sms_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'sms configure error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/sync-subscribers
  router.post('/sync-subscribers', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const allSubs = await subscriberRepo.findAllFull();
      // Eligible if it has an MSISDN (original purpose — SMS-over-SGs
      // routing needs one; unchanged) OR the subscriber has explicitly
      // opted in via the "2G/GSM" checkbox on the Subscribers page
      // (gsmEnabled) — an additional, not replacement, inclusion path so a
      // subscriber can get real 2G/3G auth keys synced without needing an
      // MSISDN at all, but only when the operator actually asked for it.
      const toSync = allSubs.filter(s => (s.msisdn && s.msisdn.length > 0) || s.gsmEnabled === true);

      if (toSync.length === 0) {
        return res.json({ success: true, synced: 0, message: 'No eligible subscribers found.' });
      }

      // Stop OsmoHLR before direct DB writes to avoid lock conflicts
      await nsenter('systemctl', ['stop', 'osmo-hlr']).catch(() => {});

      let synced = 0;
      const failed: string[] = [];

      for (const sub of toSync) {
        const imsi   = sub.imsi;
        const msisdn = sub.msisdn?.[0];
        // Basic sanitisation: IMSI and (if present) MSISDN must be numeric only
        if (!/^\d+$/.test(imsi) || (msisdn && !/^\d+$/.test(msisdn))) {
          failed.push(imsi);
          continue;
        }
        try {
          let sql = `INSERT OR IGNORE INTO subscriber (imsi) VALUES ('${imsi}');`;
          if (msisdn) {
            // Clear the MSISDN from any other subscriber first to avoid the UNIQUE constraint,
            // then upsert this subscriber's MSISDN.
            sql +=
              ` UPDATE subscriber SET msisdn=NULL WHERE msisdn='${msisdn}' AND imsi!='${imsi}'; ` +
              `UPDATE subscriber SET msisdn='${msisdn}' WHERE imsi='${imsi}';`;
          }

          // Real 2G/3G authentication (osmo-bsc's A-interface, not just the
          // SGs peering this loop originally existed for) needs actual key
          // material in OsmoHLR, not just the imsi/msisdn mapping above.
          // Open5GS subscribers are already Milenage (K + OPc) — the same
          // algorithm OsmoHLR's auc_3g table supports (algo_id_3g=5) — and
          // OsmoHLR derives 2G vectors from a Milenage auc_3g row via the
          // standard 3G->2G conversion functions when no separate auc_2g
          // row exists, so this one upsert is enough to authenticate the
          // same real SIM over 2G *and* 3G/4G-style AKA. sqn/ind_bitlen are
          // deliberately left untouched on conflict — OsmoHLR tracks its
          // own independent SQN state for this subscriber (same as any
          // second, independent core authenticating the same SIM would),
          // and resetting it on every re-sync would risk a spurious
          // SQN-resync each time an operator just re-runs this sync.
          // Gated on gsmEnabled specifically, NOT just "has an MSISDN" —
          // every Open5GS subscriber always has valid k/opc, so without
          // this check every MSISDN-only (SMS-over-SGs) subscriber would
          // silently get real 2G/3G auth capability pushed too, regardless
          // of whether its "Enable 2G/GSM" checkbox was ever checked. Real
          // bug, caught live 2026-09-10: a batch of MSISDN-only subscribers
          // ended up with real auc_3g keys after nothing but an ordinary
          // SMS-page re-sync.
          const k = sub.security?.k;
          const opc = sub.security?.opc;
          if (sub.gsmEnabled === true && k && opc && /^[0-9a-fA-F]{32}$/.test(k) && /^[0-9a-fA-F]{32}$/.test(opc)) {
            sql +=
              ` INSERT INTO auc_3g (subscriber_id, algo_id_3g, k, opc, sqn, ind_bitlen) ` +
              `SELECT id, 5, '${k.toLowerCase()}', '${opc.toLowerCase()}', 0, 5 FROM subscriber WHERE imsi='${imsi}' ` +
              `ON CONFLICT(subscriber_id) DO UPDATE SET algo_id_3g=excluded.algo_id_3g, k=excluded.k, opc=excluded.opc;`;
          }

          await nsenter('sqlite3', [HOST_HLR_DB, sql]);
          synced++;
        } catch (e) {
          failed.push(imsi);
          logger.warn({ imsi, err: String(e) }, 'HLR sync failed for subscriber');
        }
      }

      // Reconciliation: remove OsmoHLR rows whose IMSI is no longer in Open5GS (deleted
      // subscriber, or MSISDN cleared) — the loop above only ever inserts/updates
      // currently-eligible IMSIs, so anything synced once and later removed/demoted
      // stays behind in OsmoHLR forever otherwise.
      let removed = 0;
      try {
        const syncImsiSet = new Set(toSync.map(s => s.imsi));
        const { stdout } = await nsenter('sqlite3', [HOST_HLR_DB, 'SELECT imsi FROM subscriber;']);
        const hlrImsis = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        const staleImsis = hlrImsis.filter(imsi => !syncImsiSet.has(imsi));

        for (const staleImsi of staleImsis) {
          try {
            await nsenter('sqlite3', [HOST_HLR_DB, `DELETE FROM subscriber WHERE imsi='${staleImsi}';`]);
            removed++;
          } catch (e) {
            logger.warn({ imsi: staleImsi, err: String(e) }, 'OsmoHLR stale subscriber cleanup failed');
          }
        }
      } catch (e) {
        logger.warn({ err: String(e) }, 'Could not query OsmoHLR subscriber list for cleanup — skipping');
      }

      // auc_3g.subscriber_id has no FK/cascade in OsmoHLR's own schema, so a
      // subscriber row deleted above would otherwise leave its key material
      // behind forever — clean up any orphaned auc_3g rows too.
      try {
        await nsenter('sqlite3', [HOST_HLR_DB, 'DELETE FROM auc_3g WHERE subscriber_id NOT IN (SELECT id FROM subscriber);']);
      } catch (e) {
        logger.warn({ err: String(e) }, 'OsmoHLR auc_3g orphan cleanup failed');
      }

      await nsenter('systemctl', ['start', 'osmo-hlr']).catch(() => {});

      await auditLogger.log({ action: 'sms_sync_subscribers', user, details: `synced=${synced} failed=${failed.length} removed=${removed}`, success: true });
      res.json({ success: true, synced, failed, removed });
    } catch (err) {
      // Ensure OsmoHLR is restarted even if we error
      await nsenter('systemctl', ['start', 'osmo-hlr']).catch(() => {});
      logger.error({ err: String(err) }, 'sms sync-subscribers error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/send-test — sends a CLI-originated SMS via the osmo-msc VTY,
  // per the osmo-msc reference manual: `subscriber msisdn <to> sms sender msisdn
  // <from> send <text>`. Useful for testing the SMS-over-SGs path without a real
  // handset — the message is injected directly at the MSC, not sent from a UE.
  router.post('/send-test', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { to, from, text } = req.body as { to?: string; from?: string; text?: string };

    if (!to || !/^\d{5,16}$/.test(to)) {
      return res.status(400).json({ success: false, error: 'to (recipient MSISDN) must be 5-16 digits' });
    }
    if (!from || !/^\d{5,16}$/.test(from)) {
      return res.status(400).json({ success: false, error: 'from (sender MSISDN) must be 5-16 digits' });
    }
    if (!text || text.length === 0 || text.length > 160) {
      return res.status(400).json({ success: false, error: 'text is required and must be 1-160 characters' });
    }
    if (/[\r\n]/.test(text)) {
      return res.status(400).json({ success: false, error: 'text must not contain newlines' });
    }

    try {
      const mscCfgPath = `${HOST_OSMOCOM_DIR}/osmo-msc.cfg`;
      let vtyHost = '127.0.0.1';
      if (fs.existsSync(mscCfgPath)) {
        const raw = fs.readFileSync(mscCfgPath, 'utf-8');
        const m = raw.match(/line vty[\s\S]*?\n\s*bind\s+(\S+)/);
        if (m) vtyHost = m[1];
      }

      const { stdout, stderr } = await nsenter(
        'python3',
        ['-c', VTY_SEND_SMS_SCRIPT, vtyHost, String(MSC_VTY_PORT), to, from, text],
        10000,
      );
      const output = (stdout + stderr).trim();
      const ok = !/% ?Unknown command|%Command incomplete|Connection refused|Traceback/i.test(output);

      await auditLogger.log({
        action:  'sms_send_test',
        user,
        details: `to=${to} from=${from} len=${text.length} ok=${ok}`,
        success: ok,
      });
      res.json({ success: ok, output });
    } catch (err) {
      await auditLogger.log({ action: 'sms_send_test', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'sms send-test error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/start
  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const svc of ['osmo-stp', 'osmo-hlr', 'osmo-msc']) {
        await nsenter('systemctl', ['start', svc]);
      }
      await auditLogger.log({ action: 'sms_start', user, details: 'osmocom services started', success: true });
      res.json({ success: true, message: 'Osmocom services started.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/stop
  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const svc of ['osmo-msc', 'osmo-hlr', 'osmo-stp']) {
        await nsenter('systemctl', ['stop', svc]);
      }
      await auditLogger.log({ action: 'sms_stop', user, details: 'osmocom services stopped', success: true });
      res.json({ success: true, message: 'Osmocom services stopped.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/disable — save sgsap block, remove from MME, stop Osmocom services
  router.post('/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      if (fs.existsSync(HOST_MME_YAML)) {
        const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
        const block = extractSgsapBlock(raw);
        if (block) fs.writeFileSync(HOST_SGSAP_BAK, block, 'utf-8');
        const newRaw = replaceSgsapSection(raw, '');
        fs.writeFileSync(HOST_MME_YAML, newRaw, 'utf-8');
      }
      await nsenter('systemctl', ['restart', 'open5gs-mmed']);
      for (const svc of ['osmo-msc', 'osmo-hlr', 'osmo-stp']) {
        await nsenter('systemctl', ['stop', svc]).catch(() => {});
      }
      await auditLogger.log({ action: 'sms_disable', user, details: 'sgsap removed, osmocom stopped', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'sms_disable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/enable — restore saved sgsap block, start Osmocom services
  router.post('/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      if (!fs.existsSync(HOST_SGSAP_BAK)) {
        return res.status(400).json({ success: false, error: 'No saved config — use Configure first.' });
      }
      const block = fs.readFileSync(HOST_SGSAP_BAK, 'utf-8');
      if (fs.existsSync(HOST_MME_YAML)) {
        const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
        fs.writeFileSync(HOST_MME_YAML, replaceSgsapSection(raw, block), 'utf-8');
      }
      fs.unlinkSync(HOST_SGSAP_BAK);
      await nsenter('systemctl', ['restart', 'open5gs-mmed']);
      for (const svc of ['osmo-stp', 'osmo-hlr', 'osmo-msc']) {
        await nsenter('systemctl', ['start', svc]).catch(() => {});
      }
      await auditLogger.log({ action: 'sms_enable', user, details: 'sgsap restored, osmocom started', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'sms_enable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/sms/uninstall — completely removes SMS-over-SGs: stops+disables osmo-stp/
  // osmo-hlr/osmo-msc, removes the sgsap block from mme.yaml (restarting MME), deletes
  // Osmocom config files and the HLR database, and purges the osmo-* packages (not
  // sqlite3 — a generic system utility, not SMS-specific, left alone on purpose).
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    try {
      write('=== Stopping and disabling Osmocom services ===');
      for (const svc of ['osmo-msc', 'osmo-hlr', 'osmo-stp']) {
        await nsenter('systemctl', ['disable', '--now', svc]).catch(() => {});
      }
      write('osmo-msc, osmo-hlr, osmo-stp stopped and disabled.');

      write('\n=== Removing sgsap block from mme.yaml ===');
      if (fs.existsSync(HOST_MME_YAML)) {
        const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
        fs.writeFileSync(HOST_MME_YAML, replaceSgsapSection(raw, ''), 'utf-8');
        await nsenter('systemctl', ['restart', 'open5gs-mmed']).catch(() => {});
        write('sgsap block removed, open5gs-mmed restarted.');
      } else {
        write('mme.yaml not found — skipping.');
      }
      if (fs.existsSync(HOST_SGSAP_BAK)) {
        fs.unlinkSync(HOST_SGSAP_BAK);
        write('Removed saved sgsap backup (.sgsap.bak).');
      }

      write('\n=== Removing Osmocom config files ===');
      for (const f of SMS_CONFIG_MANIFEST) {
        if (fs.existsSync(f.path)) {
          fs.unlinkSync(f.path);
          write(`Removed: ${f.label}`);
        }
      }

      write('\n=== Removing OsmoHLR database ===');
      await nsenter('bash', ['-c', `rm -f ${HOST_HLR_DB} ${HOST_HLR_DB}-shm ${HOST_HLR_DB}-wal`]).catch(() => {});
      write('Removed hlr.db (and -shm/-wal if present).');

      write('\n=== Purging osmo-stp, osmo-hlr, osmo-msc ===');
      const purge = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--',
        'bash', '-c', 'DEBIAN_FRONTEND=noninteractive apt-get purge -y osmo-stp osmo-hlr osmo-msc 2>&1 && apt-get autoremove -y 2>&1'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>(resolve => {
        purge.stdout.on('data', (d: Buffer) => write(d.toString()));
        purge.stderr.on('data', (d: Buffer) => write(d.toString()));
        purge.on('close', () => resolve());
      });

      await auditLogger.log({ action: 'sms_uninstall', user, details: 'osmo-stp/hlr/msc removed, sgsap unconfigured', success: true });
      write('\n✅ SMS-over-SGs fully removed.');
      res.end();
    } catch (err) {
      await auditLogger.log({ action: 'sms_uninstall', user, details: String(err), success: false });
      write(`\n❌ Uninstall error: ${String(err)}`);
      res.end();
    }
  });

  // POST /api/sms/restart
  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const svc of ['osmo-stp', 'osmo-hlr', 'osmo-msc']) {
        await nsenter('systemctl', ['restart', svc]);
      }
      await auditLogger.log({ action: 'sms_restart', user, details: 'osmocom services restarted', success: true });
      res.json({ success: true, message: 'Osmocom services restarted.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/sms/configs — list of editable config files
  router.get('/configs', requireAdmin, async (_req: Request, res: Response) => {
    const files: SmsConfigFile[] = SMS_CONFIG_MANIFEST.map(f => ({ ...f, exists: fs.existsSync(f.path) }));
    res.json({ success: true, files });
  });

  // GET /api/sms/configs/content?path=...
  router.get('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!SMS_ALLOWED_PATHS.has(filePath)) return res.status(403).json({ success: false, error: 'Path not allowed' });
    const exists = fs.existsSync(filePath);
    const content = exists ? fs.readFileSync(filePath, 'utf-8') : '';
    res.json({ success: true, content, exists });
  });

  // PUT /api/sms/configs/content
  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: filePath, content } = req.body as { path: string; content: string };
    if (!SMS_ALLOWED_PATHS.has(filePath)) return res.status(403).json({ success: false, error: 'Path not allowed' });
    fs.mkdirSync(filePath.substring(0, filePath.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    await auditLogger.log({ action: 'sms_config_save', user, details: filePath, success: true });
    res.json({ success: true });
  });

  // POST /api/sms/configs/restart
  router.post('/configs/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { services } = req.body as { services: string[] };
    const results: string[] = [];
    for (const svc of services) {
      try {
        await nsenter('systemctl', ['restart', svc]);
        results.push(`✓ ${svc} restarted`);
      } catch (err) {
        results.push(`✗ ${svc} failed — ${String(err).split('\n')[0]}`);
      }
    }
    await auditLogger.log({ action: 'sms_config_restart', user, details: services.join(', '), success: true });
    res.json({ success: true, results });
  });

  return router;
}
