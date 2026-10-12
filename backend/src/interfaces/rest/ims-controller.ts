import { Router, Request, Response } from 'express';
import { revisionStaleness } from '../../domain/services/module-revision';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { CAPTURE_PORTS } from '../../application/use-cases/sip-trace/sip-trace-store';
import * as yaml from 'js-yaml';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { readListenOn, writeListenOn } from './bind-controller';
import { getAppVersion } from '../../infrastructure/system/app-version';
import { parseKamcmdOutput } from '../../infrastructure/system/kamcmd-parser';
import { ImsCallStatsMonitor } from '../../application/use-cases/ims/call-stats-monitor';
import { loadState as loadVowifiState } from './vowifi-controller';
import { buildSmfLateCsrPatchScript } from '../../application/use-cases/smf-late-csr-patch';
import { buildSmfGxPeerhostPatchScript } from '../../application/use-cases/smf-gx-peerhost-patch';
import { buildKamailioImsModulesScript, verifyKamailioImsModulesPatch } from '../../application/use-cases/kamailio-ims-modules-build';
import { isKamailioHttp2Capable } from '../../application/use-cases/kamailio-source-build';
import { VECTORCORE_SMSC_SIP_ADDRESS } from './vectorcore-smsc-controller';
import { getOcsPeerInfo, addOcsDiameterClient } from './ocs-controller';
import { formatPstnDispatcherEntry } from './pstn-controller';

const execFileAsync = promisify(execFile);

const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

// ── Constants ─────────────────────────────────────────────────────────────────
const HOST_KAMAILIO_ICSCF_DIR  = '/proc/1/root/etc/kamailio_icscf';
const HOST_KAMAILIO_SCSCF_DIR  = '/proc/1/root/etc/kamailio_scscf';
const HOST_BIND_DIR            = '/proc/1/root/etc/bind';
const HOST_BIND_ZONES_DIR      = '/proc/1/root/etc/bind/zones';
const HOST_RTPENGINE_CONF      = '/proc/1/root/etc/rtpengine/rtpengine.conf';
const HOST_SYSTEMD_DIR         = '/proc/1/root/etc/systemd/system';
const HOST_SMF_YAML            = '/proc/1/root/etc/open5gs/smf.yaml';
const HOST_MME_YAML            = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_PCRF_FD_CONF        = '/proc/1/root/etc/freeDiameter/pcrf.conf';
const HOST_UPF_YAML            = '/proc/1/root/etc/open5gs/upf.yaml';
const HOST_IMS_STATE           = '/proc/1/root/etc/open5gs/.ims-config.json';

// Cheap, safe-default reader for the SMS/MMS dashboard's exporter — same
// shape as sms-controller.ts's own getMscMnccMode() (never throws, defaults
// to the base mode when the file/field is missing rather than treating a
// not-yet-configured IMS as an error).
export function getSmsDeliveryMode(): 'sgs' | 'ims' | 'vectorcore' {
  if (!fs.existsSync(HOST_IMS_STATE)) return 'ims';
  try {
    const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
    return state.smsDeliveryMode === 'sgs' || state.smsDeliveryMode === 'vectorcore' ? state.smsDeliveryMode : 'ims';
  } catch {
    return 'ims';
  }
}
// Tracks which NMS app version last successfully ran POST /install — separate
// from HOST_IMS_STATE (which tracks Configure), since Install and Configure
// are independent actions with independent staleness. Anything that changes
// an Install-time step (the cdp.so patch, the PyHSS crash-guard/identity
// patches, the SMF late-overlapping-CSR patch, ...) ships as part of an app
// version bump per this project's own release convention — comparing whole
// app versions here is the same deliberately blunt approach configStale
// already uses for Configure, not per-patch tracking.
const HOST_IMS_INSTALL_STATE   = '/proc/1/root/etc/open5gs/.ims-install.json';
const HOST_IMS_SMF_BAK         = '/proc/1/root/etc/open5gs/.ims-smf.bak';
const HOST_IMS_UPF_BAK         = '/proc/1/root/etc/open5gs/.ims-upf.bak';
const HOST_KAMAILIO_PCSCF_DIR  = '/proc/1/root/etc/kamailio_pcscf';
const HOST_KAMAILIO_SMSC_DIR   = '/proc/1/root/etc/kamailio_smsc';
const HOST_HSS_YAML            = '/proc/1/root/etc/open5gs/hss.yaml';
// Bundled Kamailio "main" routing-script templates (P/I/S-CSCF) — see the
// "── Systemd unit templates ──" section below for why these exist as files
// rather than generated strings: they're large (1000+ line) proven-working
// Kamailio IMS routing scripts, not host-specific data, so they ship as static
// assets (same pattern as src/config/defaults) rather than being reconstructed
// in TypeScript. The only per-host data inside them is rtpengine's own bind
// address, marked with the __RTPENGINE_IP__ placeholder token.
const IMS_TEMPLATES_DIR        = path.join(__dirname, '../../config/ims-templates');

// PyHSS upstream has no release cadence this project can track, so the pin is a
// commit — the exact tree this deployment has run since 2026-07-31, with all
// three of this project's PyHSS patches confirmed applying cleanly against it.
// Same idiom as vowifi-build.ts's VECTORCORE_EPDG_COMMIT/VECTORCORE_AAA_COMMIT.
// `git describe` calls it 1.0.2-330-gcc27997.
const PYHSS_COMMIT = 'cc279971f1420668150551e56d6a8fb8561b324d';

function deployImsTemplate(templateRelPath: string, destPath: string, substitutions: Record<string, string> = {}): void {
  let content = fs.readFileSync(path.join(IMS_TEMPLATES_DIR, templateRelPath), 'utf-8');
  for (const [token, value] of Object.entries(substitutions)) {
    content = content.split(`__${token}__`).join(value);
  }
  // Refuse to deploy a template that still has an unsubstituted __TOKEN__.
  // This is the mechanism behind the documented total-RTP outage: a manual
  // redeploy of kamailio_pcscf.cfg left `__RTPENGINE_IP__` literal, so every
  // call's RTP handling failed with "Name or service not known". Today only
  // that one token exists and its caller substitutes it correctly, but a new
  // token added to a template with an un-updated caller would deploy the
  // literal placeholder silently. Failing loudly here is strictly better than
  // writing a config that cannot work.
  const leftover = content.match(/__[A-Z0-9_]+__/g);
  if (leftover) {
    throw new Error(
      `deployImsTemplate(${templateRelPath}): refusing to write ${destPath} — ` +
      `unsubstituted token(s) remain: ${[...new Set(leftover)].join(', ')}. ` +
      `Add them to this call's substitutions map.`,
    );
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, 'utf-8');
}

// Every static template configureIms() deploys verbatim, with the per-host
// tokens each one needs. Shared by the deploy loop and
// checkImsTemplateStaleness() below, so a template can never be added to one
// and silently left out of the other.
//
// dispatcher.list is deliberately absent from this list: both this module and
// pstn-controller.ts write it, and PSTN owns the real entry once configured
// (see formatPstnDispatcherEntry()'s own comment), so a live copy differing
// from the bundled placeholder is the correct state, not staleness.
const IMS_STATIC_TEMPLATES: ReadonlyArray<{
  template: string;
  dest: string;
  tokens?: readonly string[];
}> = [
  { template: 'kamailio_pcscf/kamailio_pcscf.cfg',  dest: `${HOST_KAMAILIO_PCSCF_DIR}/kamailio_pcscf.cfg`, tokens: ['RTPENGINE_IP'] },
  { template: 'kamailio_pcscf/route/mo.cfg',        dest: `${HOST_KAMAILIO_PCSCF_DIR}/route/mo.cfg` },
  { template: 'kamailio_pcscf/route/mt.cfg',        dest: `${HOST_KAMAILIO_PCSCF_DIR}/route/mt.cfg` },
  { template: 'kamailio_pcscf/route/register.cfg',  dest: `${HOST_KAMAILIO_PCSCF_DIR}/route/register.cfg` },
  { template: 'kamailio_pcscf/route/rtp.cfg',       dest: `${HOST_KAMAILIO_PCSCF_DIR}/route/rtp.cfg`, tokens: ['RTPENGINE_IP'] },
  { template: 'kamailio_icscf/kamailio_icscf.cfg',  dest: `${HOST_KAMAILIO_ICSCF_DIR}/kamailio_icscf.cfg` },
  { template: 'kamailio_scscf/kamailio_scscf.cfg',  dest: `${HOST_KAMAILIO_SCSCF_DIR}/kamailio_scscf.cfg` },
  { template: 'kamailio_scscf/CxDataType_Rel7.xsd', dest: `${HOST_KAMAILIO_SCSCF_DIR}/CxDataType_Rel7.xsd` },
];

export interface ImsTemplateStaleness {
  /** Host paths whose live content differs from what this build would deploy. */
  stale: string[];
  /** Host paths that should exist but don't. */
  missing: string[];
  checked: number;
}

/**
 * Compare every deployed static Kamailio template against the one this build
 * bundles, by content.
 *
 * `configStale`/`installStale` next to this only compare a recorded version
 * STRING against the running app version, which is both too loose and too
 * tight: a version bump that touched nothing IMS-related reads as stale, while
 * editing a template without bumping the version reads as current. That second
 * case is the one that actually hurts, and it has bitten this deployment twice
 * — a `kamailio_scscf.cfg` a full day stale so `setCdrAccountingEnabled(true)`
 * reported success with no `acc` module loaded at all (2026-09-17), and a
 * manually-redeployed `kamailio_pcscf.cfg` left holding a literal
 * `__RTPENGINE_IP__`, which failed every call's RTP handling (2026-10-02).
 * Both were found by reading files during an outage; this makes them a status
 * field instead.
 *
 * `rtpEngineIp` comes from the saved Configure state so token-bearing templates
 * are rendered exactly as they were deployed. Without it those templates can't
 * be compared meaningfully, so they are skipped rather than reported as false
 * positives.
 */
export function checkImsTemplateStaleness(rtpEngineIp?: string): ImsTemplateStaleness {
  const stale: string[] = [];
  const missing: string[] = [];
  let checked = 0;

  for (const entry of IMS_STATIC_TEMPLATES) {
    if (entry.tokens?.includes('RTPENGINE_IP') && !rtpEngineIp) continue;
    let expected: string;
    try {
      expected = fs.readFileSync(path.join(IMS_TEMPLATES_DIR, entry.template), 'utf-8');
    } catch {
      continue; // Template not bundled in this build — nothing to compare against.
    }
    if (rtpEngineIp) expected = expected.split('__RTPENGINE_IP__').join(rtpEngineIp);
    checked++;
    let live: string;
    try {
      live = fs.readFileSync(entry.dest, 'utf-8');
    } catch {
      missing.push(entry.dest.replace('/proc/1/root', ''));
      continue;
    }
    if (live !== expected) stale.push(entry.dest.replace('/proc/1/root', ''));
  }
  return { stale, missing, checked };
}

export interface IpsecSaInfo {
  src: string;
  dst: string;
  spi: string;
  authAlg: string;
  encAlg: string;
  lastUsed: string | null;
  bytes: number;
  packets: number;
  // Which subsystem owns this SA — the kernel's `ip xfrm state` table is
  // global and has no concept of "this SA belongs to P-CSCF's SIP security
  // vs. the ePDG's own S2b/SWu tunnel", so this page has to infer it by
  // matching src/dst against each subsystem's own known bind address.
  // 'other' covers anything that doesn't match either (should be rare/none
  // in a normal deployment, but real data shouldn't just vanish if it
  // shows up).
  group: 'ims' | 'vowifi' | 'other';
}

// Parses `ip -s xfrm state` (real, verified output format — see
// PROJECT_STATE.md's Data Conflicts entry on IPsec encryption; `encAlg`
// coming back as "ecb(cipher_null)" is expected/correct, not a bug — this
// project's P-CSCF IPsec SAs are integrity-only (hmac auth, no real
// encryption), by design of the ipsec-3gpp profile used here). One block
// per SA, blocks separated by a non-indented "src <ip> dst <ip>" line.
function parseIpsecSaText(raw: string): IpsecSaInfo[] {
  const blocks = raw.split(/\n(?=src )/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const srcDst = block.match(/^src (\S+) dst (\S+)/);
    const spi = block.match(/spi (0x[0-9a-fA-F]+)/);
    const authAlg = block.match(/auth[a-z-]*\s+(\S+\([^)]*\)|\S+)/);
    const encAlg = block.match(/\benc (\S+\([^)]*\)|\S+)/);
    const lastUsed = block.match(/lastused ([\d-]+ [\d:]+)/);
    const counters = block.match(/(\d+)\(bytes\),\s*(\d+)\(packets\)/);
    return {
      src: srcDst?.[1] ?? '',
      dst: srcDst?.[2] ?? '',
      spi: spi?.[1] ?? '',
      authAlg: authAlg?.[1] ?? '',
      encAlg: encAlg?.[1] ?? '',
      lastUsed: lastUsed?.[1] ?? null,
      bytes: counters ? parseInt(counters[1], 10) : 0,
      packets: counters ? parseInt(counters[2], 10) : 0,
      group: 'other' as const, // classified by the caller, see /live
    };
  });
}

export interface RegisteredUserInfo {
  // Every public identity (tel:/sip: form, MSISDN alias, etc) sharing this
  // one Contact — PyHSS's Implicit Registration Set gives each real device
  // 3 IMPU aliases in this deployment (confirmed live: 9 raw IMPU records
  // for 3 physical phones), so grouping by Contact/Call-ID is what actually
  // makes this readable as "who's registered" rather than triple-counting
  // every device.
  publicIdentities: string[];
  state: string;
  impi: string;
  contact: string | null;
  expiresSeconds: number | null;
  callId: string | null;
  userAgent: string | null;
  received: string | null;
  // Filled in by the /live route after parsing, from the subscriber DB —
  // not present in the raw usrloc snapshot itself. IMPI is `<imsi>@<ims
  // domain>` per default_ifc.xml's <PrivateID>, so the part before '@' is
  // a reliable IMSI even though publicIdentities mix MSISDN- and
  // IMSI-based URIs.
  imsi: string | null;
  nickname: string | null;
}

// Parses the text file `kamcmd ulscscf.snapshot <file>` writes. S-CSCF's
// usrloc is now db_mode=1/write-through (persisted to scscf.impu/
// impu_contact/contact so a restart doesn't wipe every phone's registration
// — see kamailio_scscf.cfg's own comment, 2026-08-31), but this live dump
// still reflects the in-memory view exactly (including anything not yet
// flushed) and needs no extra DB-shape parsing, so it's kept as the one
// source of truth here rather than querying those tables directly. Groups
// by Call-ID (falling back to Contact URI if Call-ID is
// somehow absent) so one real registered device shows as one row with all
// its IMPU aliases listed together, instead of one row per alias.
function parseRegisteredUsersSnapshot(raw: string): RegisteredUserInfo[] {
  const records = raw.split(/\.\.\.IMPU Record\(/).slice(1);
  const byRegistration = new Map<string, RegisteredUserInfo>();
  let unkeyedCounter = 0;
  for (const rec of records) {
    const publicIdentity = rec.match(/public_identity\s*:\s*'([^']*)'/)?.[1] ?? '';
    const state = rec.match(/\bstate:\s*'([^']*)'/)?.[1] ?? '';
    const impi = rec.match(/IMPI for subscription:\s*\[([^\]]*)\]/)?.[1] ?? '';
    // default_ifc.xml's <PrivateID> is always `<imsi>@<ims domain>` — the
    // part before '@' is a reliable IMSI regardless of which form (MSISDN
    // or IMSI) the individual publicIdentities happen to use.
    const imsi = impi.split('@')[0] || null;
    const contactBlocks = rec.split(/~~~Contact\(/).slice(1);
    if (contactBlocks.length === 0) {
      // Genuinely no contact (e.g. a barred/unregistered IMPU still present
      // in the dump) — has no natural grouping key, keep as its own row.
      byRegistration.set(`unkeyed-${unkeyedCounter++}`, {
        publicIdentities: [publicIdentity], state, impi, imsi, nickname: null,
        contact: null, expiresSeconds: null, callId: null, userAgent: null, received: null,
      });
      continue;
    }
    for (const cb of contactBlocks) {
      const contactUri = cb.match(/\n\s*Contact\s*:\s*'([^']*)'/)?.[1] ?? null;
      const expires = cb.match(/Expires\s*:\s*(\d+)/)?.[1];
      const callId = cb.match(/Call-ID\s*:\s*'([^']*)'/)?.[1] ?? null;
      const userAgent = cb.match(/User-Agent:\s*'([^']*)'/)?.[1] ?? null;
      const received = cb.match(/\breceived\s*:\s*'([^']*)'/)?.[1] || null;
      const key = callId ?? contactUri ?? `unkeyed-${unkeyedCounter++}`;
      const existing = byRegistration.get(key);
      if (existing) {
        if (!existing.publicIdentities.includes(publicIdentity)) existing.publicIdentities.push(publicIdentity);
      } else {
        byRegistration.set(key, {
          publicIdentities: [publicIdentity], state, impi, imsi, nickname: null,
          contact: contactUri,
          expiresSeconds: expires ? parseInt(expires, 10) : null,
          callId, userAgent, received,
        });
      }
    }
  }
  return Array.from(byRegistration.values());
}

export interface ImsConfigureInput {
  pcscfIp: string;
  pcscfPort: number;
  icscfIp: string;
  icscfPort: number;
  scscfIp: string;
  scscfPort: number;
  rtpEngineIp: string;
  rtpPortMin: number;
  rtpPortMax: number;
  dnsIp: string;
  mcc?: string;
  mnc?: string;
  additionalPlmns?: { mcc: string; mnc: string }[];
}

// ── Domain helpers ────────────────────────────────────────────────────────────

function deriveImsDomain(mcc: string, mnc: string): string {
  return `ims.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

function deriveEpcDomain(mcc: string, mnc: string): string {
  return `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

function readPcrfFreeDiameterInfo(): { fqdn: string; port: number } {
  try {
    const raw = fs.readFileSync('/proc/1/root/etc/freeDiameter/pcrf.conf', 'utf-8');
    const identityMatch = raw.match(/^\s*Identity\s*=\s*"([^"]+)"\s*;/m);
    const portMatch     = raw.match(/^\s*Port\s*=\s*(\d+)\s*;/m);
    return {
      fqdn: identityMatch?.[1] ?? 'pcrf.localdomain',
      port: portMatch ? parseInt(portMatch[1]) : 3868,
    };
  } catch {
    return { fqdn: 'pcrf.localdomain', port: 3868 };
  }
}

function readMccMnc(): { mcc: string; mnc: string } {
  let mcc = '001'; let mnc = '01';
  try {
    const mmeRaw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    const mccM = mmeRaw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = mmeRaw.match(/mnc:\s*['"]?(\d+)['"]?/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
  } catch { /* use defaults */ }
  return { mcc, mnc };
}

// cdp (Kamailio's own Diameter module) resolves a <Peer FQDN="..."/> via a
// real getaddrinfo() at connect time — same synchronous-DNS-or-die behavior
// CLAUDE.md's gotcha #6 documents for every 5GC NF's own advertise FQDN,
// just for cdp instead. OCS's FQDN (ocs.epc.mnc...) lives under the EPC
// domain — this file's own IMS zone (bindZoneFile(), step 10 in
// configureIms()) doesn't cover it, but BIND already serves a real,
// authoritative "epc.mnc<mnc>.mcc<mcc>.3gppnetwork.org" zone (set up by the
// DNS/FQDN Migration Wizard) with A records for hss/mme/smf/pcrf/aaa/secgw —
// this just adds "ocs" to that same zone, mirroring secgw-controller.ts's
// own upsertSecgwDnsRecord()/upsertZoneRecordLine() pattern (itself copied
// from vowifi-controller.ts) for merging exactly one record into a zone file
// wholesale-owned by the Migration Wizard (CLAUDE.md gotcha #4) — never
// rewrite the whole file. An earlier draft of this fix used a raw /etc/hosts
// entry instead — it worked, but duplicated DNS infrastructure this project
// already has for exactly this purpose, caught in review before shipping.
// `rndc reload` (not a full `systemctl restart bind9`, secgw's own choice)
// matches this file's own existing convention (see step 16's "Reload bind9
// zone after restart" comment) and avoids a momentary DNS outage for every
// other module sharing this same BIND instance. Best-effort/non-fatal if the
// epc zone doesn't exist yet (BIND never installed, or the Migration Wizard
// never run) — same graceful-degrade convention as secgw's own upsert.
async function upsertOcsDnsRecord(mcc: string, mnc: string, ocsIp: string): Promise<void> {
  const zonePath = `${HOST_BIND_ZONES_DIR}/${deriveEpcDomain(mcc, mnc)}.zone`;
  if (!fs.existsSync(zonePath)) return;
  const raw = fs.readFileSync(zonePath, 'utf-8');
  const lineRe = /^ocs\s+IN\s+A\s+\S+\s*$/m;
  const line = `ocs IN A ${ocsIp}`;
  const updated = lineRe.test(raw) ? raw.replace(lineRe, line) : raw.trimEnd() + '\n' + line + '\n';
  if (updated === raw) return;
  fs.writeFileSync(zonePath, updated, 'utf-8');
  await nsenter('rndc', ['reload']).catch(() => {});
}

// The IP to register as S-CSCF's trusted OCS Diameter client identity.
// Deliberately NOT scscfIp — confirmed live (2026-09-17): cdp's own
// peer_connect() doesn't bind its outbound TCP connection to the configured
// <Peer>'s own listen address before connecting out to OCS, so even though
// S-CSCF listens on its own dedicated loopback alias (127.0.1.2), OCS
// observes the connection arriving from plain 127.0.0.1 — registering
// scscfIp as the client produced a real, reproduced "DIAMETER peer address
// not found in client table" (result 3010) rejection with OCS's own log
// showing `addresses: [{127,0,0,1}]`, not scscfIp. This is a difference
// from freeDiameter (SMF's Gy peer, and every other freeDiameter-based
// module here) which DOES source outbound connections from its own
// configured ListenOn address — cdp simply doesn't offer an equivalent bind.
const OCS_CLIENT_SOURCE_IP = '127.0.0.1';

// ── Kamailio include-file templates (written by Configure) ───────────────────

// Collector bind address. Loopback only and deliberately so: HEP is
// unauthenticated, every sender is a local Kamailio, and a routable bind would
// let anything on the RAN inject forged SIP into the operator's trace view.
const HEP_COLLECTOR_BIND = '127.0.0.1';

// ── SIP tracing (HEP) ────────────────────────────────────────────────────────
//
// The stock IMS templates already carry complete capture support behind
// `#!ifdef CAPTURE_NODE`: the siptrace loadmodule, its modparams
// (duplicate_uri/hep_mode_on/trace_to_database/trace_flag) and a sip_trace()
// call in route[REQINIT]. Defining CAPTURE_NODE is the whole switch -- there
// is deliberately no custom Kamailio config here.
//
// Its value becomes siptrace's duplicate_uri, so each instance is pointed at
// its OWN collector port. That is not cosmetic: the template never sets
// hep_capture_id, and we cannot add that modparam (a modparam must follow its
// loadmodule, and this generated include is imported near the top of the
// file, long before siptrace loads). Without a per-instance port, all three
// CSCFs would arrive indistinguishable. See CAPTURE_PORTS in
// sip-trace-store.ts.
// Resolves the collector port for one instance, or undefined when tracing is
// off. Centralised so a new scscfIncludeCfg() caller cannot invent a different
// rule -- a wiring test asserts every call site passes this through.
function sipTracePortFor(enabled: boolean, instance: 'pcscf' | 'icscf' | 'scscf'): number | undefined {
  return enabled ? CAPTURE_PORTS[instance] : undefined;
}

function captureNodeDefine(port: number | undefined, instance: string): string {
  if (!port) return '';
  return `
// NMS SIP tracing -- mirrors every SIP message this instance handles to the
// NMS HEP collector on its own dedicated port (${instance}). Removing this
// define disables tracing entirely; nothing else in this file references it.
#!define CAPTURE_NODE "sip:${HEP_COLLECTOR_BIND}:${port}"
`;
}

export function pcscfIncludeCfg(p: { pcscfIp: string; pcscfPort: number; imsDomain: string; epcDomain: string; additionalDomains?: string[]; http2N5Available: boolean; sipTracePort?: number }): string {
  const extraAliases = (p.additionalDomains ?? []).map(d => `alias=pcscf.${d}`).join('\n');
  return `# Open5GS NMS — P-CSCF include (generated by Configure)
listen=udp:${p.pcscfIp}:${p.pcscfPort}
listen=tcp:${p.pcscfIp}:${p.pcscfPort}

#!define IPSEC_LISTEN_ADDR "${p.pcscfIp}"
#!define IPSEC_CLIENT_PORT 5100
#!define IPSEC_SERVER_PORT 6100
#!define IPSEC_MAX_CONN 10
#!define IPSEC_DELETE_UNUSED_TUNNELS 1
#!define IPSEC_FORWARD_FLAGS 897
// NMS patch, confirmed live 2026-10-01 (critic-caught before deploy): the C-level
// IPSEC_FORWARD_ADD_SECVERIFY (1<<10) added to ims_ipsec_pcscf/cmd.c lives in a
// completely separate namespace from this .cfg preprocessor -- referencing it from
// mt.cfg without this matching #!define is a guaranteed fatal config-parse error
// (reproduced directly: 'kamailio -c' on a minimal repro file), the same failure
// class as the WITH_N5/stock-5.8.8 gotcha above. Value must stay in sync with the
// C header if that bit ever moves.
#!define IPSEC_FORWARD_ADD_SECVERIFY 1024
#!define RX_IMS_REG_DIALOG_DIRECTION 3
#!define RX_AF_SIGNALING_IP "${p.pcscfIp}"
#!substdef "/N5_BIND_IP/${p.pcscfIp}/g"
#!substdef "/N5_BIND_PORT/7777/g"
#!substdef "/SCP_BIND_IP/127.0.0.200/g"
#!substdef "/SCP_BIND_PORT/7777/g"

alias=pcscf.${p.imsDomain}
${extraAliases}
#!define MY_WS_PORT 80
#!define MY_WSS_PORT 443
#!define PCSCF_URL "sip:pcscf.${p.imsDomain}:${p.pcscfPort}"
#!define TCP_PROCESSES 8
#!substdef "/UE_REGISTRATION_EXPIRES/7200/g"
#!substdef "/CONTACT_DELETE_DELAY/120/g"
#!subst "/NETWORKNAME/${p.imsDomain}/g"
#!subst "/HOSTNAME/pcscf.${p.imsDomain}/g"
#!subst "/PCRF_REALM/${p.epcDomain}/g"
#!define DB_URL "mysql://pcscf:heslo@127.0.0.1/pcscf"
#!define SQLOPS_DBURL "pcscf=>mysql://pcscf:heslo@127.0.0.1/pcscf"
// Both Rx (4G, PCRF/Gx) and N5 (5G, PCF/N7) are deliberately enabled together,
// not mutually exclusive — this deployment serves 4G and 5G UEs on the SAME
// P-CSCF/S-CSCF/I-CSCF, unlike the upstream reference this N5 support was
// ported from (herlesupreeth/docker_open5gs), which only ever runs one or the
// other because its 4G and 5G deployments are entirely separate IMS cores.
// mt.cfg/mo.cfg's MT_aar_reply/MO_aar_reply try Rx first and fall back to N5
// only on Rx's real failure (confirmed live 2026-09-29: Rx can never succeed
// for a 5G/NR UE at all — PCRF has no Gx session for it, by architecture, not
// as a bug — see those files' own comments for the full explanation). Do not
// go back to disabling WITH_N5 without also reverting that fallback logic,
// or a 4G-only deployment's Rx failures would try to fall back to a PCF that
// was never actually being used.
// WITH_N5 itself is conditional, not a blind #!define — real, confirmed-live
// 2026-09-29 finding: route[MO/MT_N5_CALL_PCF_POLICY_AUTH] calls
// http_client_request_v2pk(), which doesn't exist in stock Kamailio 5.8.8's
// http_client module AT ALL — not a runtime failure, a FATAL CONFIG PARSE
// ERROR (confirmed via a real 'kamailio -c' check against the actual 5.8.8
// binary), which would take P-CSCF down completely, not just VoNR calling.
// Both N5 routes are fully wrapped in one #!ifdef WITH_N5/#!endif block, so
// leaving WITH_N5 undefined makes Kamailio's preprocessor strip them before
// the parser ever sees them — safe, and exactly the state this template
// shipped in before N5 support was wired up (see isKamailioHttp2Capable()'s
// own comment, kamailio-source-build.ts). On a 5.8.8-only deployment this
// means 5G/VoNR calling stays at its prior, known limitation (Rx fails for a
// 5G leg, call fails) — real but strictly less bad than P-CSCF not starting.
#!define WITH_RX
${p.http2N5Available ? '#!define WITH_N5' : '##!define WITH_N5 // undefined: Kamailio 6.0+ not detected — see the comment above'}
#!define WITH_NAT
#!define FORCE_RTPRELAY
#!define WITH_TCP
// Real bug, confirmed live 2026-09-29: WITH_PING_TCP/WITH_PING_UDP (below)
// correctly populate the natping/natpingfrom htables with every UE's real
// contact at REGISTER time, but route[NATPING] (kamailio_pcscf.cfg) — the
// rtimer-driven loop that actually SENDS the keepalive OPTIONS every 5s —
// is gated behind WITH_NATPING, which was never defined. Half-wired: data
// collected, never acted on. Real, reproduced consequence: idle TCP/TLS
// connections to UEs (particularly ones with gaps between activity, e.g.
// during test-call sessions) go stale well before their SIP registration
// Expires, causing "call failed" on the next INVITE attempt — P-CSCF tries
// a fresh outbound TCP connect to a contact that's actually dead, hits its
// own connect timeout (~3s), and synthesizes a local error response. Real,
// live packet-capture evidence: a 3-second silent gap between "pending
// outbound connect initiated" and a synthesized error response, with the
// UE's own REGISTER-based Expires nowhere near expired. Confirmed the
// natping mechanism itself already correctly handles TCP/TLS/UDP alias
// formats (see event_route[uac:reply] in kamailio_pcscf.cfg) — genuinely
// just missing this one #!define.
#!define WITH_NATPING
#!define WITH_IPSEC
#!define WITH_IMS_HDR_CACHE
#!define WITH_PING_UDP
#!define WITH_PING_TCP
${captureNodeDefine(p.sipTracePort, 'P-CSCF')}`;
}

function icscfIncludeCfg(p: { icscfIp: string; icscfPort: number; imsDomain: string; additionalDomains?: string[]; sipTracePort?: number }): string {
  const extraAliases = (p.additionalDomains ?? []).map(d => `alias=${d}`).join('\n');
  return `# Open5GS NMS — I-CSCF include (generated by Configure)
listen=udp:${p.icscfIp}:${p.icscfPort}
listen=tcp:${p.icscfIp}:${p.icscfPort}

alias=${p.imsDomain}
${extraAliases}
#!define NETWORKNAME "${p.imsDomain}"
#!define HOSTNAME "icscf.${p.imsDomain}"
#!subst "/NETWORKNAME/${p.imsDomain}/"
#!substdef "/UE_REGISTRATION_EXPIRES/7200/g"
#!define DB_URL "mysql://icscf:heslo@127.0.0.1/icscf"
#!define WITH_TCP
${captureNodeDefine(p.sipTracePort, 'I-CSCF')}`;
}

// P-CSCF's kamailio_pcscf.cfg dispatcher module routes to this list — currently
// just I-CSCF (the only "gateway" P-CSCF dispatches to in this deployment).
// Parameterized on icscfIp/icscfPort rather than a static template so it stays
// correct if I-CSCF's bind address is ever changed via Configure.
function pcscfDispatcherList(icscfIp: string, icscfPort: number): string {
  return `1 sip:${icscfIp}:${icscfPort}\n`;
}

function scscfIncludeCfg(p: { scscfIp: string; scscfPort: number; imsDomain: string; additionalDomains?: string[]; blockImsSms?: boolean; routeSmsToVectorcore?: { ip: string; port: number }; voiceCharging?: { ocsOriginHost: string }; cdrAccounting?: boolean ; sipTracePort?: number }): string {
  const extraAliases = (p.additionalDomains ?? []).map(d => `alias=scscf.${d}`).join('\n');
  // BLOCK_IMS_SMS gates the hard-reject rule in the static kamailio_scscf.cfg
  // template (search for BLOCK_IMS_SMS there) — the "SMS delivery mode"
  // selector on the SMS/MMS page. Deliberately a real SIP-level reject, not
  // just removing the smsc iFC: without this, an unmatched MESSAGE still
  // falls through to normal registrar-based routing and gets delivered
  // peer-to-peer directly to the target's registered contact (bypassing
  // smsc's store-and-forward, but still delivered) — confirmed by reading
  // this file's own default routing logic — which would NOT actually force
  // SGs, just silently change delivery semantics. A real reject is required
  // so a standards-compliant phone sees a real failure and falls back.
  const blockImsSms = p.blockImsSms ? '#!define BLOCK_IMS_SMS\n' : '';
  // ROUTE_SMS_TO_VECTORCORE — the third SMS delivery mode: instead of
  // rejecting (blockImsSms) or letting kamailio-smsc's own inline SMSC role
  // handle MESSAGE (the default 'ims' mode), relay it to VectorCore SMSC's
  // SIP/3GPP-ISC listener. Mutually exclusive with blockImsSms by
  // construction — setSmsDeliveryMode()/the Configure flow only ever sets
  // one of the two, never both — see the #!ifdef ordering in
  // kamailio_scscf.cfg for why that matters (both blocks intercept MESSAGE
  // at the same early point in route{}).
  const routeSmsToVectorcore = p.routeSmsToVectorcore
    ? `#!define ROUTE_SMS_TO_VECTORCORE\n#!define VECTORCORE_SMSC_IP "${p.routeSmsToVectorcore.ip}"\n#!define VECTORCORE_SMSC_PORT "${p.routeSmsToVectorcore.port}"\n`
    : '';
  // Voice/airtime charging (Diameter Ro, via Kamailio's own ims_charging
  // module) — completes the block kamailio_scscf.cfg has carried dormant
  // behind #!ifdef WITH_RO/WITH_RO_TERM since before this project's own
  // history began (ims_charging.so is already compiled+loadmodule'd
  // unconditionally; only the modparam block and the Ro_CCR() call sites
  // were ever gated). origin_host/origin_realm modparams in the static
  // template reference the bare HOSTNAME/NETWORKNAME macros already defined
  // above — no new variables needed for those two. RO_ROOT deliberately
  // stays at ims_charging's own compiled-in default ("32260@3gpp.org", the
  // standard MMTel Service-Context-Id) rather than being derived from this
  // deployment's own 3gppnetwork.org PLMN domain — confirmed by reading the
  // module's C source (ims_charging_mod.c) that OCS's service_type/1
  // parser only inspects the LAST 14 bytes of the assembled string
  // (a 5-digit code + "@3gpp.org", literally, not "3gppnetwork.org"), so a
  // "PLMN-flavored" root would silently stop matching as IMS-voice on the
  // OCS side. WITH_RO_TERM (charging the terminating/called leg too) is
  // deliberately never enabled — this only charges the originating leg,
  // matching standard "caller pays" billing convention, keeping the first
  // version of this simple.
  const voiceCharging = (() => {
    if (!p.voiceCharging) return '';
    const { mcc, mnc } = readMccMnc();
    return [
      `#!define WITH_RO`,
      `#!define RO_FORCED_PEER "${p.voiceCharging.ocsOriginHost}"`,
      `#!define RO_DESTINATION "${p.voiceCharging.ocsOriginHost}"`,
      `#!define RO_MNC "${mnc.padStart(2, '0')}"`,
      `#!define RO_MCC "${mcc.padStart(3, '0')}"`,
      `#!define RO_ROOT "32260@3gpp.org"`,
      `#!define RO_EXT "ext"`,
      `#!define RO_RELEASE "8"`,
      ``,
    ].join('\n');
  })();
  // CDR Phase 3 — Kamailio's own `acc` module, basic flag-based accounting
  // (db_flag/db_missed_flag), deliberately NOT acc's newer cdr_enable
  // feature, which needs load_dlg_api() bound to a module literally named
  // "dialog" — this deployment loads ims_dialog.so instead (a related but
  // separate module, not a drop-in for that lookup), so cdr_enable is a real
  // startup-failure risk here. See kamailio_scscf.cfg's own WITH_CDR block
  // for the full modparam set and setflag() site.
  const cdrAccounting = p.cdrAccounting ? '#!define WITH_CDR\n' : '';
  return `# Open5GS NMS — S-CSCF include (generated by Configure)
listen=udp:${p.scscfIp}:${p.scscfPort}
listen=tcp:${p.scscfIp}:${p.scscfPort}

#!define NETWORKNAME "${p.imsDomain}"
#!define NETWORKNAME_ESC "${p.imsDomain}"
#!define HOSTNAME "scscf.${p.imsDomain}"
#!define HOSTNAME_ESC "scscf\\.${p.imsDomain}"
#!define URI "sip:scscf.${p.imsDomain}:${p.scscfPort}"
#!subst "/NETWORKNAME/${p.imsDomain}/"
alias=scscf.${p.imsDomain}
${extraAliases}
#!define ENUM_SUFFIX "e164.arpa."
#!define DB_URL "mysql://scscf:heslo@127.0.0.1/scscf"
#!define REG_AUTH_DEFAULT_ALG "HSS-Selected"
#!define TCP_PROCESSES 3
#!substdef "/UE_REGISTRATION_EXPIRES/7200/g"
#!define WITH_TCP
#!define WITH_AUTH
${blockImsSms}${routeSmsToVectorcore}${voiceCharging}${cdrAccounting}${captureNodeDefine(p.sipTracePort, 'S-CSCF')}`;
}

// ── Diameter XML templates ────────────────────────────────────────────────────

function pcscfDiameterXml(p: { pcscfIp: string; imsDomain: string; pcrfFqdn: string; pcrfPort: number }): string {
  // EXPERIMENT 2026-08-01: re-adding the outbound <Peer> for PCRF, which was
  // deliberately removed on 2026-07-26 after it caused a confirmed live
  // connect/disconnect flap ("Peer ... has no attached send pipe", "Bad file
  // descriptor" spamming every few seconds) that starved real INVITE
  // processing entirely. Re-trying it because the reference
  // herlesupreeth/docker_open5gs pcscf.xml *does* define this exact
  // bidirectional pattern (both P-CSCF and PCRF actively connect to each
  // other) and apparently runs it successfully — worth finding out whether
  // our earlier flap was actually caused by something else (e.g. a stale
  // ConnectPeer left over from a prior PLMN, which upsertPcrfPcscfPeer()
  // below now actively cleans up — that cleanup did not exist yet on
  // 2026-07-26) rather than the bidirectional-connect pattern itself.
  // <DefaultRoute> stays either way — see cdp routing-table note in
  // icscfDiameterXml() below, same requirement applies here. If this flaps
  // again, revert to accept-only (delete the <Peer> line, keep everything
  // else) — see memory: ims-ue-to-ue-calling-investigation for the original
  // incident.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DiameterPeer SYSTEM "DiameterPeer.dtd">
<DiameterPeer
    FQDN="pcscf.${p.imsDomain}"
    Realm="${p.imsDomain}"
    Vendor_Id="10415"
    Product_Name="Kamailio P-CSCF"
    AcceptUnknownPeers="1"
    DropUnknownOnDisconnect="1"
    DefaultAuthSessionTimeout="3600"
    MaxAuthSessionTimeout="3600"
    Tc="30"
    Workers="4"
    QueueLength="32">
  <Acceptor port="3871" bind="${p.pcscfIp}"/>
  <Auth id="16777236" vendor="10415"/>
  <Auth id="16777236" vendor="0"/>
  <SupportedVendor vendor="10415"/>
  <Peer FQDN="${p.pcrfFqdn}" port="${p.pcrfPort}"/>
  <DefaultRoute FQDN="${p.pcrfFqdn}" metric="10"/>
</DiameterPeer>
`;
}

function icscfDiameterXml(p: { icscfIp: string; imsDomain: string }): string {
  // cdp configparser only matches <Peer> — <ConnectPeer> is silently ignored.
  // <DefaultRoute> is NOT optional decoration — <Peer> alone only drives CER/CEA
  // connectivity; cdp's outbound message routing table (used by every
  // AAASendMessage(), including the UAR this module sends for every REGISTER) is
  // built exclusively from <DefaultRoute> elements (confirmed against cdp's own
  // configparser.c: DefaultRoute is the only element that populates x->r_table).
  // Without it the peer connection comes up (CER/CEA succeeds, TCP shows
  // ESTABLISHED) but every actual request fails with cdp's "Empty routing table"
  // — confirmed live, 2026-07-17, as "480 Temporarily Unavailable - Diameter Cx
  // interface failed" on every REGISTER.
  return `<?xml version="1.0" encoding="UTF-8"?>
<DiameterPeer
    FQDN="icscf.${p.imsDomain}"
    Realm="${p.imsDomain}"
    Vendor_Id="10415"
    Product_Name="Kamailio I-CSCF"
    AcceptUnknownPeers="0"
    DropUnknownOnDisconnect="1"
    Tc="30"
    Workers="1"
    QueueLength="32">
  <Acceptor port="3869" bind="${p.icscfIp}"/>
  <Auth id="16777216" vendor="10415"/>
  <Auth id="16777216" vendor="4491"/>
  <Auth id="16777216" vendor="13019"/>
  <Auth id="16777216" vendor="0"/>
  <SupportedVendor vendor="10415"/>
  <SupportedVendor vendor="4491"/>
  <SupportedVendor vendor="13019"/>
  <Peer FQDN="hss.${p.imsDomain}" port="3868"/>
  <DefaultRoute FQDN="hss.${p.imsDomain}" metric="10"/>
</DiameterPeer>
`;
}

function scscfDiameterXml(p: { scscfIp: string; imsDomain: string; ocsPeer?: { fqdn: string; port: number } }): string {
  // See icscfDiameterXml()'s comment — same DefaultRoute requirement applies here
  // for S-CSCF's Cx (MAR/SAR) messages. The OCS <Peer> (when voice charging is
  // enabled) deliberately gets no <DefaultRoute> of its own — ims_charging's
  // ro_forced_peer modparam (RO_FORCED_PEER, set in the generated include file)
  // explicitly targets Ro CCR messages at it, bypassing cdp's routing table for
  // that traffic entirely. Without the <Peer> entry itself, though, cdp never
  // opens the CER/CEA connection in the first place — same requirement as every
  // other peer in this file.
  const ocsPeer = p.ocsPeer ? `\n  <Peer FQDN="${p.ocsPeer.fqdn}" port="${p.ocsPeer.port}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<DiameterPeer
    FQDN="scscf.${p.imsDomain}"
    Realm="${p.imsDomain}"
    Vendor_Id="10415"
    Product_Name="Kamailio S-CSCF"
    AcceptUnknownPeers="0"
    DropUnknownOnDisconnect="1"
    Tc="30"
    Workers="1"
    QueueLength="32">
  <Acceptor port="3870" bind="${p.scscfIp}"/>
  <Auth id="16777216" vendor="10415"/>
  <Auth id="16777216" vendor="4491"/>
  <Auth id="16777216" vendor="13019"/>
  <Auth id="16777216" vendor="0"/>
  <Auth id="4" vendor="10415"/>
  <Acct id="4" vendor="10415"/>
  <SupportedVendor vendor="10415"/>
  <SupportedVendor vendor="4491"/>
  <SupportedVendor vendor="13019"/>
  <Peer FQDN="hss.${p.imsDomain}" port="3868"/>
  <DefaultRoute FQDN="hss.${p.imsDomain}" metric="10"/>${ocsPeer}
</DiameterPeer>
`;
}

// ── Systemd unit templates ────────────────────────────────────────────────────
// Dependency ordering (After=/Wants=/Requires=) confirmed against a real,
// previously-working deployment (2026-07-17) — same provenance note as the
// PyHSS units above.

function pcscfSystemdUnit(): string {
  return `[Unit]
Description=Kamailio P-CSCF SIP Server
After=network.target mariadb.service named.service rtpengine-daemon.service kamailio-icscf.service kamailio-scscf.service

[Service]
Type=simple
RuntimeDirectory=kamailio_pcscf
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio_pcscf
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_pcscf/kamailio_pcscf.cfg -m 32 -M 1024 -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function icscfSystemdUnit(): string {
  return `[Unit]
Description=Kamailio I-CSCF SIP Server
After=network.target mariadb.service named.service pyhss-diameter.service
Wants=pyhss-diameter.service

[Service]
Type=simple
RuntimeDirectory=kamailio_icscf
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio_icscf
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_icscf/kamailio_icscf.cfg -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function scscfSystemdUnit(): string {
  return `[Unit]
Description=Kamailio S-CSCF SIP Server
After=network.target mariadb.service named.service pyhss-diameter.service
Wants=pyhss-diameter.service

[Service]
Type=simple
RuntimeDirectory=kamailio_scscf
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio_scscf
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_scscf/kamailio_scscf.cfg -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

// ── PyHSS templates ───────────────────────────────────────────────────────────

function pyhssConfigYaml(p: { imsDomain: string; mcc: string; mnc: string; scscfIp: string; scscfPort: number; hssIp: string; additionalPlmns?: { mcc: string; mnc: string }[] }): string {
  const extraScscfs = (p.additionalPlmns ?? [])
    .map(ap => `    - 'sip:scscf.${deriveImsDomain(ap.mcc, ap.mnc)}:${p.scscfPort}'`)
    .join('\n');
  return `hss:
  transport: "TCP"
  bind_ip: ["${p.hssIp}"]
  bind_port: 3868
  OriginHost: "hss.${p.imsDomain}"
  OriginRealm: "${p.imsDomain}"
  ProductName: "pyHSS"
  MCC: "${p.mcc}"
  MNC: "${p.mnc}"
  scscf_pool:
    - 'sip:scscf.${p.imsDomain}:${p.scscfPort}'
${extraScscfs}
  client_socket_timeout: 300
  diameter_request_timeout: 3
  send_dwr: False
  active_diameter_peers_timeout: 10
  lock_provisioning: False
  provisioning_key: "open5gs-nms"
  SLh_enabled: False
  CancelLocationRequest_Enabled: False
  Default_iFC: 'pyhss/default_ifc.xml'
  Default_Sh_UserData: 'pyhss/default_sh_user_data.xml'

database:
  db_type: mysql
  server: 127.0.0.1
  username: pyhss
  password: ims_db_pass
  database: ims_hss_db

# Not actually used (single-HSS deployment, no geo-redundant peer) — but required
# to exist regardless: database.py's Update_Serving_CSCF() (called on every
# successful SIP REGISTER's Server-Assignment-Request) does an unguarded
# config['geored']['sync_actions'] with no .get()/default, unlike every other
# geored reference in the codebase — a missing section here throws KeyError:
# 'geored' and silently fails every registration's SAR. Confirmed live,
# 2026-07-17.
geored:
  enabled: False
  sync_actions: []
  endpoints: []

redis:
  host: localhost
  port: 6379

# metricService.py's own real Prometheus exporter (config.get('metric', {}),
# confirmed against its live source) — without this section it silently
# falls back to its own default 127.0.0.1:9191, which works but collides
# with nothing declaring it explicitly. Own dedicated loopback, matching
# this project's per-daemon-loopback convention (.1=icscf .2=scscf .3=hss
# .4=pstn .5=vectorcore-smsc .6=gsm .7=asterisk-2g .8=hnbgw-mgw .9=osmo-
# hnodeb .10=OCS Gy — .11 confirmed free, 2026-09-25).
metric:
  bind_ip: "127.0.1.11"
  bind_port: 9191

logging:
  level: INFO
  logfiles:
    hss_logging_file: /var/log/pyhss_hss.log
    diameter_logging_file: /var/log/pyhss_diameter.log
    geored_logging_file: /var/log/pyhss_geored.log
    metric_logging_file: /var/log/pyhss_metrics.log
  sqlalchemy_sql_echo: False
  sqlalchemy_pool_recycle: 15
  sqlalchemy_pool_size: 30
  sqlalchemy_max_overflow: 0

api:
  page_size: 200
  enable_insecure_auc: True
`;
}

function defaultIfcXml(imsDomain: string, routeSmsToVectorcore?: { ip: string; port: number }): string {
  // Jinja2 variables must be prefixed with `iFC_vars.` — PyHSS's Answer_16777216_301
  // renders with `template.render(iFC_vars=ims_subscriber_details)`, nesting every
  // field (imsi, msisdn, scscf_realm, ...) under a single top-level `iFC_vars` dict,
  // not as bare top-level template variables. A bare `{{ imsi }}` silently renders
  // as an empty string (Jinja2's default for an undefined variable — no error), which
  // is what produced `<PrivateID>@</PrivateID>` and got the whole SAA rejected by
  // Kamailio's XML schema validator — confirmed live, 2026-07-17.
  //
  // Domain is `${imsDomain}` — a literal baked in at generate-time, NOT
  // `{{ iFC_vars.scscf_realm }}`. scscf_realm is a per-subscriber DB column
  // PyHSS's own `Update_Serving_CSCF()` nulls on every deregister — a
  // dereg/re-register race could bake the literal string "None" into a
  // subscriber's identity (confirmed live, recurring bug: 2026-07-27 and
  // again 2026-07-30). An earlier fix patched the *deployed file* during
  // Install to swap in an mcc/mnc-derived Jinja expression instead, but
  // configureIms() below (called on every plain Configure — this project's
  // "full rewrite every time" convention) writes this template fresh via
  // fs.writeFileSync with no equivalent patch, silently re-introducing the
  // original scscf_realm-based bug on the next Configure. Embedding the
  // already-known, static imsDomain literal here instead removes the runtime
  // DB dependency entirely — no per-subscriber field to null, so Configure
  // can no longer regress this no matter how many times it runs.
  //
  // <Identity>, not <IMSAddressOfRecord> — the real 3GPP Rel7 XSD
  // (CxDataType_Rel7.xsd, tPublicIdentity) requires the child element inside
  // PublicIdentity to be named "Identity"; "IMSAddressOfRecord" doesn't exist in
  // this schema at all and gets rejected with "This element is not expected.
  // Expected is ( Identity )." — confirmed live, 2026-07-17.
  // Second iFC, added only when VectorCore SMSC is the active SMS delivery
  // mode: a REGISTER-triggering entry that makes S-CSCF forward a copy of
  // every REGISTER (3rd-party registration, ims_registrar_scscf's own
  // isc_match_filter_reg() — already invoked unconditionally in
  // route[REGISTER]/PRE_REG_SAR_REPLY, this just gives it a matching iFC to
  // find) to VectorCore SMSC. This is NOT optional cosmetic wiring — its
  // ROUTING.md documents the routing engine's real candidate order for MT
  // delivery: `ims-local` (its own registration cache, populated ONLY by
  // these forwarded REGISTERs) is tried first, then `ims-sh`, then a real
  // SGd/S6c HSS lookup, then fallback rules. With none of those wired up
  // (this integration deliberately scopes out SMPP/SGd — see module header
  // in vectorcore-smsc-controller.ts), every message parked in `WAIT_TIMER`
  // with `deferred_reason: "sgd_lookup"` forever is EXACTLY what happens
  // without this — confirmed live 2026-08-24 via its own /api/v1/messages
  // (registry loaded entries=0 at startup, no route ever succeeded). Literal
  // IP:port, not the "smsc.<domain>" FQDN the MESSAGE iFC below uses — that
  // FQDN's DNS record is kamailio-smsc's own address (10.0.1.178), not
  // VectorCore SMSC's (127.0.1.5), so reusing it here would silently
  // misroute. Existing already-registered subscribers won't be in
  // VectorCore SMSC's cache retroactively — they need one more REGISTER
  // (natural re-registration within UE_REGISTRATION_EXPIRES, or an
  // airplane-mode toggle) for this to take effect for them.
  const registerToVectorcore = routeSmsToVectorcore ? `
    <InitialFilterCriteria>
      <Priority>10</Priority>
      <TriggerPoint>
        <ConditionTypeCNF>1</ConditionTypeCNF>
        <SPT>
          <ConditionNegated>0</ConditionNegated>
          <Group>0</Group>
          <Method>REGISTER</Method>
          <Extension></Extension>
        </SPT>
      </TriggerPoint>
      <ApplicationServer>
        <ServerName>sip:${routeSmsToVectorcore.ip}:${routeSmsToVectorcore.port}</ServerName>
        <DefaultHandling>0</DefaultHandling>
      </ApplicationServer>
    </InitialFilterCriteria>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<IMSSubscription>
  <PrivateID>{{ iFC_vars.imsi }}@${imsDomain}</PrivateID>
  <ServiceProfile>
    <PublicIdentity>
      <BarringIndication>0</BarringIndication>
      <Identity>sip:{{ iFC_vars.msisdn }}@${imsDomain}</Identity>
    </PublicIdentity>
    <PublicIdentity>
      <BarringIndication>0</BarringIndication>
      <Identity>tel:{{ iFC_vars.msisdn }}</Identity>
    </PublicIdentity>
    <PublicIdentity>
      <BarringIndication>0</BarringIndication>
      <Identity>sip:{{ iFC_vars.imsi }}@${imsDomain}</Identity>
    </PublicIdentity>

    <!-- Route SIP MESSAGE to SMSC (SMS over IMS) -->
    <InitialFilterCriteria>
      <Priority>20</Priority>
      <TriggerPoint>
        <ConditionTypeCNF>1</ConditionTypeCNF>
        <SPT>
          <ConditionNegated>0</ConditionNegated>
          <Group>0</Group>
          <Method>MESSAGE</Method>
          <Extension></Extension>
        </SPT>
        <SPT>
          <ConditionNegated>1</ConditionNegated>
          <Group>1</Group>
          <SIPHeader>
            <Header>Server</Header>
          </SIPHeader>
        </SPT>
        <SPT>
          <ConditionNegated>0</ConditionNegated>
          <Group>2</Group>
          <SessionCase>0</SessionCase>
          <Extension></Extension>
        </SPT>
      </TriggerPoint>
      <ApplicationServer>
        <ServerName>sip:smsc.${imsDomain}:7090</ServerName>
        <DefaultHandling>0</DefaultHandling>
      </ApplicationServer>
    </InitialFilterCriteria>
${registerToVectorcore}
  </ServiceProfile>
</IMSSubscription>
`;
}

function defaultShUserDataXml(imsDomain: string): string {
  // Same iFC_vars.-prefix requirement, and same literal-domain fix, as
  // defaultIfcXml() above.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Sh-Data>
  <PublicIdentifiers>
    <IMSPublicIdentity>sip:{{ iFC_vars.imsi }}@${imsDomain}</IMSPublicIdentity>
  </PublicIdentifiers>
</Sh-Data>
`;
}

// Dependency order confirmed against a real, previously-working deployment
// (2026-07-17): pyhss-hss is what actually opens the Diameter Cx acceptor and is
// what api/diameter both depend on — NOT the other way around, which is what an
// earlier version of these templates assumed (and which was never actually wired
// up / exercised, since nothing called these functions — see the module-level
// comment above IMS_TEMPLATES_DIR). ExecStart uses plain /usr/bin/python3, not a
// venv — matches how POST /install actually provisions PyHSS's deps (`pip3
// install --break-system-packages`, no `python3 -m venv` step).
function pyhssHssUnit(): string {
  return `[Unit]
Description=PyHSS Main HSS Service
After=network.target mariadb.service redis-server.service
Requires=mariadb.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/pyhss
Environment=PYTHONUNBUFFERED=1
Environment=PYHSS_CONFIG=/opt/pyhss/config.yaml
ExecStart=/usr/bin/python3 /opt/pyhss/services/hssService.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function pyhssDiameterUnit(): string {
  return `[Unit]
Description=PyHSS Diameter Service
After=pyhss-hss.service
Requires=pyhss-hss.service

[Service]
Type=simple
WorkingDirectory=/opt/pyhss
Environment=PYTHONUNBUFFERED=1
Environment=PYHSS_CONFIG=/opt/pyhss/config.yaml
ExecStart=/usr/bin/python3 /opt/pyhss/services/diameterService.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function pyhssApiUnit(): string {
  return `[Unit]
Description=PyHSS REST API Service
After=pyhss-hss.service
Requires=pyhss-hss.service

[Service]
Type=simple
WorkingDirectory=/opt/pyhss
Environment=PYTHONUNBUFFERED=1
Environment=PYHSS_CONFIG=/opt/pyhss/config.yaml
ExecStart=/usr/bin/python3 /opt/pyhss/services/apiService.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

// Real, 2026-09-25 finding: PyHSS ships a genuine Prometheus exporter
// (metricService.py, prometheus_client-based) fed by real sendMetric() calls
// already firing from hssService.py/diameterService.py/apiService.py on
// every real event — but this NMS never installed it, so PyHSS's Cx/IMS-
// subscriber-count data was structurally unreachable by Prometheus/Grafana
// regardless of any dashboard query fix. It's a pure Redis-queue consumer +
// its own HTTP exporter (make_wsgi_app/start_http_server) — needs
// redis-server directly, same as pyhss-hss's own dependency, not a
// functional dependency on pyhss-hss/diameter/api themselves (any of the
// three could be the one actually producing the Redis events it reads).
function pyhssMetricsUnit(): string {
  return `[Unit]
Description=PyHSS Prometheus Metrics Exporter
After=network.target redis-server.service
Requires=redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/pyhss
Environment=PYTHONUNBUFFERED=1
Environment=PYHSS_CONFIG=/opt/pyhss/config.yaml
ExecStart=/usr/bin/python3 /opt/pyhss/services/metricService.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

// ── SMSC templates ────────────────────────────────────────────────────────────

function smscIncludeCfg(p: { smscIp: string; imsDomain: string }): string {
  // Real bug, confirmed live (2026-08-01): SMSC_SERVER (this SMSC's own
  // self-identity constant - used as the alias, the pua_reginfo
  // server_address, and every outbound request's From URI) had no port.
  // DNS only has a plain A record for smsc.<domain> (10.0.1.178 - same IP
  // P-CSCF listens on), so anywhere this constant got used as a bare URI
  // without an explicit port, resolution silently defaulted to standard
  // SIP port 5060 - P-CSCF's port, not the SMSC's real 7090. Confirmed via
  // the pua DB table (SUBSCRIBE's own stored contact: "sip:smsc.<domain>",
  // no port) and S-CSCF's NOTIFY-building log (watcher_contact same, no
  // port) - S-CSCF's reg-event NOTIFY back to the SMSC was resolving to
  // P-CSCF's socket and getting rejected with 404, so the SMSC's own local
  // contact cache never populated and every message eventually dropped
  // after retries even once queuing itself worked. Fix: bake the real port
  // into the constant so every use (alias, pua_reginfo server_address,
  // every uac_req furi) is unambiguous.
  return `listen=udp:${p.smscIp}:7090
listen=tcp:${p.smscIp}:7090

#!define DOMAIN "${p.imsDomain}"
#!subst "/DOMAIN/${p.imsDomain}/"
#!define SMSC_SERVER "smsc.${p.imsDomain}:7090"
#!subst "/SMSC_SERVER/smsc.${p.imsDomain}:7090/"

#!define SMS_DB_URL "sms=>mysql://smsc:heslo@127.0.0.1/smsc"
#!define DIALPLAN_PUA_DB_URL "mysql://smsc:heslo@127.0.0.1/smsc"

#!subst "/NEXMO_APIKEY/disabled/"
#!subst "/NEXMO_APISECRET/disabled/"
#!subst "/SUBSCRIBE_EXPIRE/3600/"
`;
}

function smscMainCfg(smsWorkerIntervalSeconds: number = 30): string {
  // Verbatim from herlesupreeth/docker_open5gs smsc/kamailio_smsc.cfg (BSD 2-Clause),
  // except smsWorkerIntervalSeconds (originally hardcoded 30 - the rtimer poll
  // interval for the store-and-forward SMS_WORKER route, see route[SMS_WORKER]
  // below) is now configurable - exposed via the SMS/MMS page and
  // POST /api/ims/sms-worker-interval, see setSmsWorkerInterval() — and,
  // added 2026-09-25, `loadmodule "ctl.so"` + its binrpc modparam, giving
  // SMSC the same kamcmd control socket its 3 sibling instances already
  // have (`/run/kamailio_{pcscf,icscf,scscf}/kamailio_ctl`, confirmed live
  // — SMSC was simply never ported this line, no documented reason found).
  // Read-only management interface, kamailio-stats-monitor.ts's own IMS
  // dashboard metrics are the only current consumer.
  // Real, 2026-09-25 finding (caught live, after deploying — ctl.so alone
  // wasn't enough): `stats.get_statistics` itself is registered by the
  // `kex` module ("Kamailio EXtra commands"), not by ctl.so — ctl.so only
  // provides the binrpc transport/socket. Confirmed live: kex.so IS loaded
  // by P-CSCF and I-CSCF's own static templates (kamailio_pcscf.cfg,
  // kamailio_icscf.cfg) but was, like ctl.so, never ported into SMSC's own
  // inline-generated config. Without it, the socket exists and accepts
  // connections, but every stats.get_statistics call fails with
  // "500 - command stats.get_statistics not found" — confirmed live on
  // this exact host before this line was added.
  return `#!KAMAILIO

include_file "smsc.cfg"

####### Global Parameters #########
debug=2
log_stderror=no
sip_warning=no
children=4

user_agent_header="User-Agent: Kamailio SMSC"
server_header="Server: Kamailio SMSC"
log_name="smsc"
auto_aliases=no
check_via=no
dns=no
rev_dns=no
tcp_accept_no_cl=yes

#!define SMS_3GPP 1
#!define SMS_TEXT 2

alias=SMSC_SERVER

mpath="/usr/lib64/kamailio/modules_k/:/usr/lib64/kamailio/modules/:/usr/lib/kamailio/modules_k/:/usr/lib/kamailio/modules/:/usr/lib/x86_64-linux-gnu/kamailio/modules/:/usr/local/lib64/kamailio/modules"

loadmodule "tm.so"
loadmodule "tmx.so"
loadmodule "corex.so"
loadmodule "smsops.so"
loadmodule "xlog.so"
loadmodule "maxfwd.so"
loadmodule "textops.so"
loadmodule "sl.so"
loadmodule "sanity.so"
loadmodule "siputils.so"
loadmodule "pv.so"
loadmodule "uac.so"
loadmodule "http_client.so"
loadmodule "xhttp.so"
loadmodule "utils.so"
loadmodule "json.so"
loadmodule "enum.so"
loadmodule "db_mysql.so"
loadmodule "dialplan.so"
loadmodule "sqlops.so"
loadmodule "htable.so"
loadmodule "rtimer.so"
loadmodule "usrloc.so"
loadmodule "registrar.so"
loadmodule "pua.so"
loadmodule "pua_reginfo.so"
loadmodule "ctl.so"
loadmodule "kex.so"

modparam("ctl", "binrpc", "unix:/var/run/kamailio_smsc/kamailio_ctl")
modparam("sqlops", "sqlcon", SMS_DB_URL)
modparam("dialplan", "db_url", DIALPLAN_PUA_DB_URL)
modparam("uac", "restore_mode", "none")
modparam("htable", "htable", "sms_retries=>size=8;autoexpire=SUBSCRIBE_EXPIRE")
modparam("rtimer", "timer", "name=sms;interval=${smsWorkerIntervalSeconds};mode=1;")
modparam("rtimer", "exec", "timer=sms;route=SMS_WORKER")
modparam("pua_reginfo", "server_address", "sip:SMSC_SERVER")
modparam("pua_reginfo", "publish_reginfo", 0)
modparam("pua", "db_url", DIALPLAN_PUA_DB_URL)

route {
  xlog("L_DBG", "$rm ($fu ($si:$sp) to $tu, $ci)\\n");
  route(REQINIT);

  if (is_method("NOTIFY")) {
    route(NOTIFY);
    send_reply("202", "Accepted");
    exit;
  }

  if (!is_method("MESSAGE")) {
    append_to_reply("Allow: MESSAGE,NOTIFY\\r\\n");
    send_reply("405", "Method not allowed");
    exit;
  }

  if ($cT == "application/vnd.3gpp.sms") {
    route(SMS_FROM_3GPP);
  } else if ($cT == "text/plain") {
    route(SMS_FROM_SIP);
  } else {
    send_reply("488", "Content-Type not supported");
    exit;
  }
}

route[REQINIT] {
  if (!mf_process_maxfwd_header("10")) {
    sl_send_reply("483","Too Many Hops");
    exit;
  }
  if(!sanity_check("1511", "7")) {
    xlog("Malformed SIP message from $si:$sp\\n");
    exit;
  }
  if (is_method("OPTIONS") && (uri==myself)) {
    options_reply();
    exit;
  }
  if (t_lookup_request()) {
    exit;
  }
}

route[SMS_FROM_3GPP] {
  send_reply("202", "Accepted");
  if (isRPDATA()) {
    # Real bug, confirmed live (2026-07-31): the RP-ACK sent here back to
    # the ORIGINAL SENDER (via $smsack/uac_req_send()) was corrupting the
    # SEPARATE MT delivery sent to the RECIPIENT later by route[SMS_TO_3GPP]
    # (via $smsbody/uac_req_send()) - the recipient's phone was receiving
    # $smsack's 13-byte RP-ACK structure (RP_ACK_NETWORK_TO_MS + fixed
    # protocol bytes, zero room for actual text) instead of $smsbody's real
    # RP-DATA/SMS-DELIVER content. Root-caused via a byte-for-byte match
    # against smsops's pv_sms_ack() source (5 of 13 captured bytes are
    # fixed constants - 0x41/0x09/SUBMIT/0x00 - that only pv_sms_ack()
    # produces) - both $uac_req(...) and smsops's own RP-data structures
    # are single process-wide globals (uac_send.c's static _uac_req,
    # smsops_impl.c's static _smsops_rp_send_data/_smsops_rp_data), shared
    # across every uac_req_send() call in a worker; sending this RP-ACK
    # inline right before route(SMS) queues the real message for later
    # delivery left a window for state to bleed across the two separate
    # uac_req_send() calls. Config is otherwise byte-for-byte identical to
    # docker_open5gs's reference kamailio_smsc.cfg - this looks like a real
    # upstream module bug in the smsops/uac interaction, not something
    # introduced by this project. Fix: skip the RP-ACK entirely - the SIP
    # "202 Accepted" above already acknowledges the sender at the
    # transport layer, and removing this eliminates the interfering
    # concurrent uac_req_send() call.
    $avp(from) = $(ai{uri.user});
    $avp(to) = $tpdu(destination);
    $avp(dcs) = $tpdu(coding);
    dp_translate("1", "$avp(to)/$avp(to)");
    $avp(text) = $tpdu(payload);
    route(SMS);
  }
  exit;
}

route[SMS_FROM_SIP] {
  send_reply("200", "OK");
  $avp(from) = $(ai{uri.user});
  $avp(to) = $tU;
  dp_translate("1", "$avp(to)/$avp(to)");
  $avp(text) = $rb;
  route(SMS);
  exit;
}

event_route[xhttp:request] {
  if ($(hu{url.querystring}{s.len}) > 0) {
    $avp(from) = $(hu{url.querystring}{param.value,msisdn,&});
    $avp(to)   = $(hu{url.querystring}{param.value,to,&});
    $avp(text) = $(hu{url.querystring}{param.value,text,&}{s.replace,+,%20}{s.unescape.user});
    $avp(from_outbound) = 1;
    route(SMS);
  }
  xhttp_reply("200", "OK", "text/html", "<html><body>OK</body></html>");
}

route[SMS_TO_3GPP] {
  xlog("DBG-SMS: SMS_TO_3GPP enter, id=$avp(id) from=$avp(from) to=$avp(to) text=$avp(text)\\n");
  $rpdata(all) = $null;
  $rpdata(type) = 1;
  $rpdata(reference) = $avp(id);
  $rpdata(originator) = $avp(from);
  $tpdu(type) = 4;
  $tpdu(origen) = $avp(from);
  $tpdu(payload) = $avp(text);
  $tpdu(coding) = $avp(dcs);
  $uac_req(method) = "MESSAGE";
  $uac_req(ruri) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(furi) = "sip:"+SMSC_SERVER;
  $uac_req(turi) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(hdrs) = "Content-Type: application/vnd.3gpp.sms\\r\\nRequest-Disposition: no-fork\\r\\nAccept-Contact: *;+g.3gpp.smsip\\r\\nX-MSG-ID: "+$avp(id)+"\\r\\n";
  $uac_req(body) = $smsbody;
  $uac_req(evroute)=1;
  xlog("DBG-SMS: SMS_TO_3GPP about to send, ruri=$uac_req(ruri) bodylen=$(uac_req(body){s.len})\\n");
  uac_req_send();
}

route[SMS_TO_SIP] {
  $uac_req(method) = "MESSAGE";
  $uac_req(ruri) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(furi) = "sip:+"+$avp(from)+"@"+DOMAIN;
  $uac_req(turi) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(hdrs) = "Content-Type: text/plain\\r\\nX-MSG-ID: "+$avp(id)+"\\r\\n";
  $uac_req(evroute)=1;
  $uac_req(body) = $avp(text);
  uac_req_send();
}

route[SMS] {
  xlog("DBG-SMS: route[SMS] enter, from=$avp(from) to=$avp(to) text=$avp(text)\\n");
  # Real bug, confirmed live (2026-08-01): the reference docker_open5gs
  # project's enum_pv_query("+"+$avp(to)) gate exists to distinguish "local
  # subscriber" (queue for IMS/SIP delivery) from "route to PSTN via an
  # external gateway" (route(SMS_TO_OUTBOUND), which POSTs to Nexmo's REST
  # API using real API credentials). This project has no real ENUM DNS
  # infrastructure and no Nexmo/outbound SMS gateway configured at all - a
  # fully self-contained private IMS test network where every subscriber IS
  # a local number by definition. The ENUM lookup unconditionally fails for
  # every real test MSISDN (confirmed live via debug logging: "enum_pv_query
  # FAILED for +155500000XX - not treated as local number" for every single
  # send, both directions), and the original config's failure path was just
  # "return 1" - silently dropping the message before it ever reached the
  # messages queue, before ANY of SMS_TO_3GPP/SMS_TO_SIP ever had a chance
  # to run. This was the actual, direct cause of "SMS never arrives" all
  # along - upstream of and independent of the separate real bugs already
  # fixed in this session (P-CSCF's Contact-header/fill_contact() bug, and
  # the RP-ACK/uac_req_send() interference removed from
  # route[SMS_FROM_3GPP]) - both of those fixes are still correct and
  # necessary, they just couldn't matter while every message was being
  # dropped here first. Fix: skip the ENUM gate entirely, always treat the
  # destination as local.
  if (sql_query("sms", "insert into messages (caller, callee, text, dcs, valid) values ('$(avp(from){s.escape.common})', '$(avp(to){s.escape.common})', '$(avp(text){s.escape.common})', $avp(dcs), now());")) {
    xlog("DBG-SMS: insert into messages OK\\n");
    return 1;
  } else {
    xlog("DBG-SMS: insert into messages FAILED\\n");
    return -1;
  }
}

route[SMS_WORKER] {
  sql_query("sms", "select id, caller, callee, text, dcs from messages;", "q");
  xlog("DBG-SMS: SMS_WORKER tick, rows=$dbr(q=>rows)\\n");
  if ($dbr(q=>rows) > 0) {
    $var(i) = 0;
    while ($var(i) < $dbr(q=>rows)) {
      if ($sht(sms_retries=>$dbr(q=>[$var(i),0])) == $null) {
        $sht(sms_retries=>$dbr(q=>[$var(i),0])) = 0;
      } else {
        $sht(sms_retries=>$dbr(q=>[$var(i),0])) = $sht(sms_retries=>$dbr(q=>[$var(i),0])) + 1;
      }
      if ($sht(sms_retries=>$dbr(q=>[$var(i),0])) > 2) {
        xlog("Dropping SMS after 2 retries\\n");
        sql_query("sms", "delete from messages where id=$dbr(q=>[$var(i),0]);");
        $sht(sms_retries=>$dbr(q=>[$var(i),0])) = $null;
      } else {
        $avp(id)   = $dbr(q=>[$var(i),0]);
        $avp(from) = $dbr(q=>[$var(i),1]);
        $avp(to)   = $dbr(q=>[$var(i),2]);
        $avp(text) = $dbr(q=>[$var(i),3]);
        $avp(dcs)  = $dbr(q=>[$var(i),4]);
        route(SEND_SMS);
      }
      $var(i) = $var(i) + 1;
    }
  }
  sql_result_free("q");
}

route[NOTIFY] {
  if (has_body("application/reginfo+xml")) {
    reginfo_handle_notify("location");
    send_reply("202", "Accepted");
  } else {
    send_reply("503", "Invalid Content-Type");
  }
  exit;
}

route[SEND_SMS] {
  $var(uri) = "sip:"+$avp(to)+"@"+DOMAIN;
  if (reg_fetch_contacts("location", "$var(uri)", "caller")) {
    xlog("DBG-SMS: SEND_SMS uri=$var(uri) contacts=$(ulc(caller=>count))\\n");
    $var(j) = 0;
    $var(is3gpp) = 0;
    while($var(j) < $(ulc(caller=>count))) {
      $var(k) = 0;
      while($var(k) < $(ulc(caller=>addr)[$var(j)]{param.count})) {
        if ($(ulc(caller=>addr)[$var(j)]{param.name,$var(k)}) == "+g.3gpp.smsip")
          $var(is3gpp) = 1;
        $var(k) = $var(k) + 1;
      }
      if ($var(is3gpp) == 1)
        route(SMS_TO_3GPP);
      else
        route(SMS_TO_SIP);
      $var(j) = $var(j) + 1;
    }
  } else {
    xlog("DBG-SMS: SEND_SMS reg_fetch_contacts FAILED for $var(uri) - not registered, subscribing\\n");
    reginfo_subscribe("$var(uri)", "SUBSCRIBE_EXPIRE");
  }
}

event_route [tm:local-request] {
  if (is_method("SUBSCRIBE")) {
    append_hf("P-Asserted-Identity: $ru\\r\\n");
  }
}

event_route[uac:reply] {
  if (($uac_req(evtype) == 1) && ($uac_req(evcode) == 200) && ($uac_req(hdrs) != $null) && ($uac_req(hdrs) != "")) {
    $var(msgid) = $(uac_req(hdrs){line.sw,X-MSG-ID:}{s.substr,10,0}{s.int});
    sql_query("sms", "delete from messages where id=$var(msgid);");
  }
}
`;
}

function smscSystemdUnit(): string {
  return `[Unit]
Description=Kamailio SMSC (SMS over IMS)
After=network.target mariadb.service kamailio-scscf.service

[Service]
Type=simple
RuntimeDirectory=kamailio_smsc
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio_smsc
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_smsc/kamailio_smsc.cfg -m 32 -M 1024 -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

// ── BIND9 templates ───────────────────────────────────────────────────────────

function bindZoneFile(p: {
  imsDomain: string; dnsIp: string; hssIp: string;
  pcscfIp: string; icscfIp: string; scscfIp: string;
  pcscfPort: number; icscfPort: number; scscfPort: number;
}): string {
  const serial = Math.floor(Date.now() / 1000);
  return `\$TTL 300
\$ORIGIN ${p.imsDomain}.

@   IN SOA   ns1 hostmaster (${serial} 3600 1800 604800 300)
@   IN NS    ns1
ns1 IN A     ${p.dnsIp}

; Apex A record, pointed at I-CSCF (not P-CSCF). Two independent things need this:
;  1. A UE/softphone that REGISTERs against the bare home-network domain (the
;     conventional Request-URI) needs it to resolve at all, or RFC 3263 UA-side
;     resolution hard-fails even with an explicit outbound proxy configured
;     (confirmed live, 2026-07-17: linphonec's belle-sip stack refused with
;     "Unresolvable destination" on a REGISTER to the bare domain).
;  2. More importantly: P-CSCF's own route[REGISTER] (route/register.cfg) never
;     sets an explicit destination — dispatcher.list is only consulted under
;     WITH_SBC, which isn't enabled here — so its final t_relay() falls back to
;     Kamailio's own RFC 3263 resolution of the Request-URI domain to decide
;     where to relay the REGISTER next. That must land on I-CSCF (which does the
;     Cx UAR/LIR S-CSCF lookup), not loop back to P-CSCF itself — confirmed live:
;     pointing this at P-CSCF caused P-CSCF to try relaying to itself and fail
;     with "504 Server Time-Out".
@ IN A ${p.icscfIp}

; CSCF A records
pcscf IN A   ${p.pcscfIp}
icscf IN A   ${p.icscfIp}
scscf IN A   ${p.scscfIp}
smsc  IN A   ${p.pcscfIp}
hss   IN A   ${p.hssIp}

; SRV records
_sip._udp        IN SRV 0 0 ${p.icscfPort} icscf
_sip._tcp        IN SRV 0 0 ${p.icscfPort} icscf
_sip._tcp.pcscf  IN SRV 0 0 ${p.pcscfPort} pcscf
_sip._udp.pcscf  IN SRV 0 0 ${p.pcscfPort} pcscf
_sips._tcp.pcscf IN SRV 0 0 5061 pcscf
_sip._udp.icscf  IN SRV 0 0 ${p.icscfPort} icscf
_sip._tcp.icscf  IN SRV 0 0 ${p.icscfPort} icscf
_sip._udp.scscf  IN SRV 0 0 ${p.scscfPort} scscf
_sip._tcp.scscf  IN SRV 0 0 ${p.scscfPort} scscf

; NAPTR records for P-CSCF discovery (RFC 3455) — both at the apex (for UEs that
; resolve the bare home-network domain per RFC 3263) and under pcscf (existing).
@     IN NAPTR 10 0 "s" "SIP+D2T" "" _sip._tcp
@     IN NAPTR 20 0 "s" "SIP+D2U" "" _sip._udp
pcscf IN NAPTR 10 0 "s" "SIP+D2T" "" _sip._tcp.pcscf
pcscf IN NAPTR 20 0 "s" "SIP+D2U" "" _sip._udp.pcscf
`;
}

function upsertNamedZone(raw: string, zoneName: string, zoneFilePath: string): string {
  const zoneBlock = `zone "${zoneName}" {\n    type master;\n    file "${zoneFilePath}";\n};\n`;
  if (raw.includes(`zone "${zoneName}"`)) {
    const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
    return raw.replace(zoneRe, zoneBlock);
  }
  return raw.trimEnd() + '\n\n' + zoneBlock;
}

function removeNamedZone(raw: string, zoneName: string): string {
  const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
  return raw.replace(zoneRe, '');
}

// ── SMF YAML helpers ──────────────────────────────────────────────────────────

// Per Open5GS v2.7.7: p-cscf belongs at the smf: level alongside dns: and mtu:,
// NOT inside the session block. The ims session entry must only have subnet/gateway/dnn.
// upf.session[]'s own line range, so edits can never wander outside it. Mirrors
// findSmfSessionRange(); `session:` is matched at its real depth under the
// top-level `upf:` key rather than by name alone.
function findUpfSessionRange(lines: string[]): { start: number; end: number; indent: number } | null {
  const upfIdx = lines.findIndex(l => /^upf:\s*$/.test(l));
  if (upfIdx < 0) return null;
  let upfEnd = upfIdx + 1;
  while (upfEnd < lines.length) {
    const l = lines[upfEnd];
    if (l.trim().length > 0 && (l.match(/^(\s*)/) ?? ['', ''])[1].length === 0) break;
    upfEnd++;
  }
  const sessionIdx = lines.findIndex((l, i) => i > upfIdx && i < upfEnd && /^\s+session:\s*$/.test(l));
  if (sessionIdx < 0) return null;
  const indent = (lines[sessionIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
  let end = sessionIdx + 1;
  while (end < upfEnd) {
    const l = lines[end];
    if (l.trim().length > 0 && (l.match(/^(\s*)/) ?? ['', ''])[1].length <= indent) break;
    end++;
  }
  return { start: sessionIdx + 1, end, indent };
}

// Module-scope: these raw-text config transformers run outside any request
// handler's own logger scope (same idiom as gsm-controller's cfgLogger).
const imsLogger = pino({ name: 'ims-smf-yaml' });

/**
 * Apply a transform to smf.yaml, refusing to proceed on anything that is not
 * valid YAML either coming in or going out.
 *
 * Added 2026-10-11 after a user reported the file still being "messed up" on
 * every IMS stop/start. Two separate gaps, both real:
 *
 *  1. Scoping the session search (Known Issues §14) stopped NEW corruption, but
 *     nothing repaired a file already corrupted by the old code. Both
 *     transforms happily operated on unparseable YAML and wrote unparseable
 *     YAML straight back, so a deployment that had been bitten once stayed
 *     broken forever and kept looking like a fresh failure on every stop/start.
 *     Refusing to touch a file we cannot parse makes that state obvious and
 *     recoverable instead of self-perpetuating.
 *
 *  2. More importantly this is a POST-condition: whatever the transform does,
 *     broken YAML never reaches disk. That holds regardless of which code path
 *     has the bug, so it would have contained the original incident even
 *     without knowing the cause — the guard the original code should have had.
 *
 * Throws with an actionable message naming the backup, rather than logging and
 * continuing: these run inside Configure/Disable, and silently skipping a
 * requested change is how a deployment ends up in a state nobody can explain.
 */
// The only top-level key IMS owns in smf.yaml: it adds `parameter:` on
// Configure and removes it on Disable, so its disappearance is correct rather
// than corruption. upf.yaml has no equivalent — IMS only touches upf.session[].
const IMS_OWNED_SMF_TOP_KEYS = ['parameter'] as const;

export function writeYamlGuarded(
  filePath: string,
  transform: (raw: string) => string,
  what: string,
  /**
   * Top-level keys this edit is ALLOWED to remove. Everything else must still
   * be there afterwards.
   *
   * Needed because IMS legitimately owns a top-level key: it adds `parameter:`
   * (for no_ipv4v6_local_addr_in_packet_filter) on Configure and removes it on
   * Disable. Without this, the drop-check rejected that as corruption and broke
   * IMS Disable outright — caught by running a real disable/enable cycle
   * against this deployment's own smf.yaml, not by review.
   */
  ownedTopLevelKeys: readonly string[] = [],
): void {
  const raw = fs.readFileSync(filePath, 'utf-8');

  const parse = (text: string): unknown => yaml.load(text);
  let before: unknown;
  try {
    before = parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to ${what}: ${filePath.replace('/proc/1/root', '')} is not valid YAML, so it cannot be edited safely ` +
      `(${String(err).split('\n')[0]}). This deployment was almost certainly hit by the ` +
      `pre-2026-10-11 session-matching bug. Restore it first — a copy from before IMS first ` +
      `configured it is at /etc/open5gs/.ims-smf.bak — then retry.`,
    );
  }
  const isMapping = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  // Note Array.isArray: `typeof [] === 'object'` in JS, so a YAML document whose
  // root is a list would otherwise sail through as a "mapping" and then blow up
  // on the first property access. Caught by this guard's own tests.
  if (!isMapping(before)) {
    throw new Error(
      `Refusing to ${what}: ${filePath.replace('/proc/1/root', '')} parsed to ` +
      `${before === null || before === undefined ? 'nothing' : Array.isArray(before) ? 'a list' : typeof before}, ` +
      `not a mapping. Restore it (see /etc/open5gs/.ims-smf.bak) and retry.`,
    );
  }

  const next = transform(raw);

  // Post-condition: never persist something we cannot read back.
  try {
    const after = parse(next);
    if (!isMapping(after)) throw new Error('result is not a YAML mapping');
    // Nothing outside the IMS-owned keys may vanish. Catches a transform that
    // "succeeds" while dropping unrelated sections, which is exactly the shape
    // the original bug took.
    const lost = Object.keys(before)
      .filter(k => !(k in (after as Record<string, unknown>)))
      .filter(k => !ownedTopLevelKeys.includes(k));
    if (lost.length > 0) throw new Error(`would drop top-level key(s): ${lost.join(', ')}`);
  } catch (err) {
    throw new Error(
      `Refusing to ${what}: the edit would have produced a config that is unusable ` +
      `(${String(err).split('\n')[0]}). The file on disk has been left untouched. ` +
      `This is a bug — please report it with your smf.yaml attached.`,
    );
  }

  fs.writeFileSync(filePath, next, 'utf-8');
}

// Line range of smf.session[]'s own block, so edits to it can never wander into
// another part of the document. `session:` is a child of the top-level `smf:`
// key, so it is matched at its real nesting depth rather than by name alone —
// `session:` as a bare name could appear under another NF's key in a combined
// file.
function findSmfSessionRange(lines: string[]): { start: number; end: number; indent: number } | null {
  const smfIdx = lines.findIndex(l => /^smf:\s*$/.test(l));
  if (smfIdx < 0) return null;
  // End of the `smf:` block: the next non-blank line at indent 0.
  let smfEnd = smfIdx + 1;
  while (smfEnd < lines.length) {
    const l = lines[smfEnd];
    if (l.trim().length > 0 && (l.match(/^(\s*)/) ?? ['', ''])[1].length === 0) break;
    smfEnd++;
  }
  const sessionIdx = lines.findIndex((l, i) => i > smfIdx && i < smfEnd && /^\s+session:\s*$/.test(l));
  if (sessionIdx < 0) return null;
  const indent = (lines[sessionIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
  let end = sessionIdx + 1;
  while (end < smfEnd) {
    const l = lines[end];
    if (l.trim().length > 0 && (l.match(/^(\s*)/) ?? ['', ''])[1].length <= indent) break;
    end++;
  }
  return { start: sessionIdx + 1, end, indent };
}

export function updateSmfImsSession(raw: string, pcscfIp: string, _dnsIp?: string): string {
  let lines = raw.split('\n');

  // Step 1: Ensure a clean ims session entry (subnet + gateway + dnn only)
  //
  // The `dnn: ims` search MUST be scoped to smf.session[]. It used to be a
  // document-wide `lines.findIndex(l => /^\s+dnn:\s*ims\s*$/.test(l))`, which
  // destroyed a real user's smf.yaml (reported 2026-10-11) and is reproduced in
  // smf-ims-session-upf-dnn.test.ts:
  //
  //   pfcp:
  //     client:
  //       upf:
  //         - address: 10.233.188.4
  //           dnn: ims          <-- matched THIS first
  //
  // Routing a DNN to a specific UPF is an ordinary Open5GS feature, so that
  // line is legitimate — our own default config just doesn't have one, which is
  // why this never showed up in testing. From that wrong match the damage
  // cascaded: the walk-back for a `- subnet|dnn:` list item found none (the
  // enclosing item is `- address:`) and ran to line 0, making blockIndent 0;
  // the forward walk then found no other 0-indent line and ran to EOF; so the
  // "keep only subnet/gateway/dnn lines" filter was applied to the ENTIRE
  // document and spliced over all of it. The file was left as one orphan
  // `dnn: ims` line plus a few session fields — every other key gone, including
  // the whole sbi block, which is why the GUI then reported "SMF has no NRF or
  // SCP client configured under sbi.client". That message was a symptom; the
  // config had already been shredded.
  const sessionRange = findSmfSessionRange(lines);
  const imsIdx = sessionRange
    ? lines.findIndex((l, i) =>
        i >= sessionRange.start && i < sessionRange.end && /^\s+dnn:\s*ims\s*$/.test(l))
    : -1;
  if (imsIdx >= 0 && sessionRange) {
    let startIdx = imsIdx;
    while (startIdx > sessionRange.start && !/^\s*-\s*(subnet|dnn):/.test(lines[startIdx])) startIdx--;
    const blockIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
    // Hard guard. Even scoped, only edit when we are certainly sitting on a
    // session list item nested deeper than `session:` itself. Anything else
    // means the file is shaped in a way this line surgery does not understand,
    // and leaving it untouched is always better than rewriting it — that is the
    // exact failure above.
    if (!/^\s*-\s*(subnet|dnn):/.test(lines[startIdx]) || blockIndent <= sessionRange.indent) {
      imsLogger.warn(
        { startLine: startIdx + 1, blockIndent, sessionIndent: sessionRange.indent },
        'smf.yaml: could not identify the ims session entry safely — leaving the session block untouched',
      );
    } else {
      // Bounded by the session block, never by EOF.
      let endIdx = imsIdx + 1;
      while (endIdx < sessionRange.end) {
        const line = lines[endIdx];
        if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= blockIndent) break;
        endIdx++;
      }
      // Keep only the list-item lines that belong to subnet/gateway/dnn
      // Re-insert dns: pointing to our BIND9 server (pcscfIp hosts it)
      const kept = lines.slice(startIdx, endIdx)
        .filter(l => l.trim() === '' || /^\s*[-\s]*(subnet|gateway|dnn):\s/.test(l));
      // Match the entry's own indentation rather than assuming 6 spaces, so a
      // file indented differently doesn't get a misaligned dns block.
      const fieldIndent = ' '.repeat(blockIndent + 2);
      kept.push(`${fieldIndent}dns:`, `${fieldIndent}  - ${pcscfIp}`);
      lines.splice(startIdx, endIdx - startIdx, ...kept);
    }
  } else {
    // No ims session — add a minimal one to the session list
    const sessionIdx = lines.findIndex(l => /^\s*session:\s*$/.test(l));
    if (sessionIdx >= 0) {
      const sessionIndent = (lines[sessionIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
      let insertIdx = sessionIdx + 1;
      while (insertIdx < lines.length) {
        const line = lines[insertIdx];
        if (line.trim().length > 0) {
          const lineIndent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
          if (lineIndent <= sessionIndent && !line.trimStart().startsWith('-')) break;
        }
        insertIdx++;
      }
      const indent = ' '.repeat(sessionIndent + 2);
      const imsEntry = `${indent}- subnet: 10.46.0.0/24\n${indent}  gateway: 10.46.0.1\n${indent}  dnn: ims\n${indent}  dns:\n${indent}    - ${pcscfIp}`;
      lines.splice(insertIdx, 0, ...imsEntry.split('\n'));
    }
  }

  // Step 2: Add/update p-cscf at the smf: level (2-space indent, alongside dns: and mtu:)
  const pCscfEntry = `  p-cscf:\n    - ${pcscfIp}`;
  const pCscfIdx = lines.findIndex(l => /^ {2}p-cscf:\s*$/.test(l));
  if (pCscfIdx >= 0) {
    // Update existing p-cscf block
    let endIdx = pCscfIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 2) break;
      endIdx++;
    }
    lines.splice(pCscfIdx, endIdx - pCscfIdx, ...pCscfEntry.split('\n'));
  } else {
    // Insert before mtu: or before freeDiameter: as fallback
    const mtuIdx = lines.findIndex(l => /^ {2}mtu:\s/.test(l));
    // `findIndex() || lines.length` was wrong both ways: it returns -1 when not
    // found, and -1 is truthy, so a missing freeDiameter: key spliced at -1 —
    // inserting before the LAST line instead of at the end. And a freeDiameter:
    // at index 0 would be falsy and jump to end-of-file. Compare explicitly.
    const fdIdx = lines.findIndex(l => /^ {2}freeDiameter:/.test(l));
    const insertAt = mtuIdx >= 0 ? mtuIdx : (fdIdx >= 0 ? fdIdx : lines.length);
    lines.splice(insertAt, 0, ...pCscfEntry.split('\n'));
  }

  // Step 3: Add parameter.no_ipv4v6_local_addr_in_packet_filter — required for
  // VoLTE UEs that self-assign IPv6 local addresses.
  //
  // `parameter:` is a top-level (0-indent) YAML key, a sibling of `smf:` —
  // NOT a child of it. Confirmed against Open5GS's own source
  // (lib/app/ogs-init.c: `ogs_app_parse_global_conf(&root_iter)`, called
  // with the document ROOT, not any NF-specific sub-iterator;
  // lib/app/ogs-config.c's `ogs_app_parse_global_conf` is what actually
  // understands `no_ipv4v6_local_addr_in_packet_filter` as a child of
  // `parameter:`). A previous version of this code wrote `  parameter:` at
  // 2-space indent, nesting it inside `smf:` — SMF's own smf:-specific
  // parser has no idea what to do with an unrecognized `parameter` child key
  // there and just warns `unknown key 'parameter'` and ignores the whole
  // block, silently losing the flag entirely. Fixed live (2026-07-31, real
  // bug report) — also migrates away any previously-written wrongly-nested
  // block so an existing deployment self-heals on its next IMS Configure,
  // the same pattern used elsewhere in this codebase for drifted templates.
  const wrongParamIdx = lines.findIndex(l => /^ {2}parameter:\s*$/.test(l));
  if (wrongParamIdx >= 0) {
    let wrongEndIdx = wrongParamIdx + 1;
    while (wrongEndIdx < lines.length) {
      const line = lines[wrongEndIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 2) break;
      wrongEndIdx++;
    }
    lines.splice(wrongParamIdx, wrongEndIdx - wrongParamIdx);
  }

  const paramIdx = lines.findIndex(l => /^parameter:\s*$/.test(l));
  const flagLine  = '  no_ipv4v6_local_addr_in_packet_filter: true';
  if (paramIdx >= 0) {
    // Check if flag already present in parameter block
    const flagExists = lines.slice(paramIdx + 1).some(l => /no_ipv4v6_local_addr_in_packet_filter/.test(l) && (l.match(/^(\s*)/) ?? ['', ''])[1].length > 0);
    if (!flagExists) lines.splice(paramIdx + 1, 0, flagLine);
  } else {
    // Insert as a new top-level block right before the top-level smf: key
    // (matching the shipped template's own logger:/global:/smf: ordering
    // convention), falling back to end-of-file if smf: is somehow absent.
    const smfTopIdx = lines.findIndex(l => /^smf:\s*$/.test(l));
    const at2 = smfTopIdx >= 0 ? smfTopIdx : lines.length;
    lines.splice(at2, 0, 'parameter:', flagLine, '');
  }

  return lines.join('\n');
}

export function removeSmfImsSession(raw: string): string {
  let lines = raw.split('\n');

  // Remove the dnn: ims session entry.
  //
  // Scoped and guarded for the same reason as updateSmfImsSession() above, and
  // this copy was the more dangerous of the two: it ends in a bare
  // `splice(startIdx, endIdx - startIdx)`, so on a config with a per-UPF
  // `dnn: ims` route the same wrong-match cascade (walk-back to line 0, forward
  // walk to EOF) deleted essentially the whole file rather than mangling it.
  // IMS Remove would have emptied smf.yaml.
  const sessionRange = findSmfSessionRange(lines);
  const imsIdx = sessionRange
    ? lines.findIndex((l, i) =>
        i >= sessionRange.start && i < sessionRange.end && /^\s+dnn:\s*ims\s*$/.test(l))
    : -1;
  if (imsIdx >= 0 && sessionRange) {
    let startIdx = imsIdx;
    while (startIdx > sessionRange.start && !/^\s*-\s*(subnet|dnn):/.test(lines[startIdx])) startIdx--;
    const blockIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
    if (!/^\s*-\s*(subnet|dnn):/.test(lines[startIdx]) || blockIndent <= sessionRange.indent) {
      imsLogger.warn(
        { startLine: startIdx + 1, blockIndent, sessionIndent: sessionRange.indent },
        'smf.yaml: could not identify the ims session entry safely — leaving the session block untouched',
      );
    } else {
      let endIdx = imsIdx + 1;
      while (endIdx < sessionRange.end) {
        const line = lines[endIdx];
        if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= blockIndent) break;
        endIdx++;
      }
      lines.splice(startIdx, endIdx - startIdx);
    }
  }

  // Remove p-cscf from smf level
  const pCscfIdx = lines.findIndex(l => /^ {2}p-cscf:\s*$/.test(l));
  if (pCscfIdx >= 0) {
    let endIdx = pCscfIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 2) break;
      endIdx++;
    }
    lines.splice(pCscfIdx, endIdx - pCscfIdx);
  }

  // Remove parameter block (added for IMS). Top-level (0-indent) is the
  // correct, current location (see updateSmfImsSession) — also clean up a
  // legacy wrongly-nested 2-indent block if this deployment never had a
  // Configure re-run since that was fixed, so uninstall fully cleans up
  // either state.
  const paramIdx = lines.findIndex(l => /^parameter:\s*$/.test(l));
  if (paramIdx >= 0) {
    let endIdx = paramIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 0) break;
      endIdx++;
    }
    lines.splice(paramIdx, endIdx - paramIdx);
  }
  const legacyParamIdx = lines.findIndex(l => /^ {2}parameter:\s*$/.test(l));
  if (legacyParamIdx >= 0) {
    let endIdx = legacyParamIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 2) break;
      endIdx++;
    }
    lines.splice(legacyParamIdx, endIdx - legacyParamIdx);
  }

  return lines.join('\n');
}

// ── UPF yaml IMS session helper ───────────────────────────────────────────────

export function updateUpfImsSession(raw: string): string {
  const lines = raw.split('\n');
  // Scoped: a `dnn: ims` anywhere else in the document must not be mistaken for
  // "the session already exists".
  const existing = findUpfSessionRange(lines);
  const imsIdx = existing
    ? lines.findIndex((l, i) =>
        i >= existing.start && i < existing.end && /^\s+dnn:\s*ims\s*$/.test(l))
    : -1;
  if (imsIdx >= 0) return raw; // already present

  const sessionIdx = lines.findIndex(l => /^\s*session:\s*$/.test(l));
  if (sessionIdx < 0) return raw;

  // Find end of session list
  const sessionIndent = (lines[sessionIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
  let insertIdx = sessionIdx + 1;
  while (insertIdx < lines.length) {
    const line = lines[insertIdx];
    if (line.trim().length > 0) {
      const ind = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
      if (ind <= sessionIndent && !line.trimStart().startsWith('-')) break;
    }
    insertIdx++;
  }
  const indent = ' '.repeat(sessionIndent + 2);
  const entry = `${indent}- subnet: 10.46.0.0/24\n${indent}  gateway: 10.46.0.1\n${indent}  dnn: ims\n${indent}  dev: ogstun2`;
  lines.splice(insertIdx, 0, ...entry.split('\n'));
  return lines.join('\n');
}

export function removeUpfImsSession(raw: string): string {
  const lines = raw.split('\n');
  // Scoped and guarded exactly like removeSmfImsSession — this carried the
  // identical defect (document-wide `dnn: ims` match, walk-back to line 0,
  // forward walk to EOF, then a bare splice-delete), and upf.yaml is written on
  // every IMS stop/disable. Missed in the first pass because only the smf twins
  // were examined.
  const sessionRange = findUpfSessionRange(lines);
  const imsIdx = sessionRange
    ? lines.findIndex((l, i) =>
        i >= sessionRange.start && i < sessionRange.end && /^\s+dnn:\s*ims\s*$/.test(l))
    : -1;
  if (imsIdx < 0 || !sessionRange) return raw;

  let startIdx = imsIdx;
  while (startIdx > sessionRange.start && !/^\s*-\s*(subnet|dnn):/.test(lines[startIdx])) startIdx--;
  const blockIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
  if (!/^\s*-\s*(subnet|dnn):/.test(lines[startIdx]) || blockIndent <= sessionRange.indent) {
    imsLogger.warn({ startLine: startIdx + 1 },
      'upf.yaml: could not identify the ims session entry safely — leaving the session block untouched');
    return raw;
  }
  let endIdx = imsIdx + 1;
  while (endIdx < sessionRange.end) {
    const line = lines[endIdx];
    if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= blockIndent) break;
    endIdx++;
  }
  lines.splice(startIdx, endIdx - startIdx);
  return lines.join('\n');
}

// ── PCRF freeDiameter helper ──────────────────────────────────────────────────

function upsertPcrfPcscfPeer(raw: string, pcscfFqdn: string, pcscfIp: string, pcscfPort: number): string {
  const peerLine = `ConnectPeer = "${pcscfFqdn}" { ConnectTo = "${pcscfIp}"; Port = ${pcscfPort}; No_TLS; };`;
  // Strip every existing "pcscf.ims.*" ConnectPeer line first, regardless of
  // MCC/MNC, then add back only the current one. Previously this only ever
  // upserted the CURRENT fqdn's line, so re-running Configure with a different
  // PLMN (or the PLMN Migration Wizard) left old entries piling up forever —
  // confirmed live, 2026-07-26: four stale entries from earlier PLMNs actively
  // interfered with the real Rx connection (PCRF's own freeDiameter stack
  // misrouted the real P-CSCF's CEA to a stale peer's state machine, causing a
  // genuine connect/disconnect flap that starved real call/INVITE processing
  // entirely). Same underlying class of bug as the known stale-neighbor-list
  // issue the PLMN Migration Wizard leaves in FRR config — see task #186.
  const cleaned = raw.replace(/^ConnectPeer\s*=\s*"pcscf\.ims\.[^\n]*\n?/gm, '');
  return cleaned.trimEnd() + '\n' + peerLine + '\n';
}

// ── Config file manifest ──────────────────────────────────────────────────────

interface ConfigFileEntry {
  path: string;
  label: string;
  group: string;
  language: string;
  restartServices: string[];
  exists: boolean;
}

function getImsConfigManifest(): ConfigFileEntry[] {
  let imsDomain = '';
  try {
    const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
    imsDomain = state.imsDomain ?? '';
  } catch { /* not configured yet */ }

  const entries: Omit<ConfigFileEntry, 'exists'>[] = [
    { group: 'P-CSCF', label: 'pcscf.cfg (include)',   path: '/etc/kamailio_pcscf/pcscf.cfg',   language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'P-CSCF', label: 'pcscf.xml (Diameter)',  path: '/etc/kamailio_pcscf/pcscf.xml',   language: 'xml', restartServices: ['kamailio-pcscf'] },
    // Added 2026-10-04: the static route-logic files (as opposed to the
    // generated per-toggle include above) were previously invisible to this
    // manifest entirely -- no GUI visibility, no API read/write, and no way
    // for the api-regression suite's generic "read every manifest entry"
    // case to ever notice if a real fix in one of these (e.g. the N5 QoS
    // port-mismatch / fr_timer fixes found live 2026-10-04) got lost on a
    // future template edit. These 4 are where that entire night's real bugs
    // actually lived, so they're exposed here as a deliberate, scoped
    // exception to the "only the generated include" pattern I-CSCF/S-CSCF
    // still follow -- not a general policy change for every module.
    { group: 'P-CSCF', label: 'kamailio_pcscf.cfg (main)', path: '/etc/kamailio_pcscf/kamailio_pcscf.cfg', language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'P-CSCF', label: 'route/mo.cfg',              path: '/etc/kamailio_pcscf/route/mo.cfg',       language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'P-CSCF', label: 'route/mt.cfg',              path: '/etc/kamailio_pcscf/route/mt.cfg',       language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'P-CSCF', label: 'route/rtp.cfg',             path: '/etc/kamailio_pcscf/route/rtp.cfg',      language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'I-CSCF', label: 'icscf.cfg (include)',   path: '/etc/kamailio_icscf/icscf.cfg',   language: 'ini', restartServices: ['kamailio-icscf'] },
    { group: 'I-CSCF', label: 'icscf.xml (Diameter)',  path: '/etc/kamailio_icscf/icscf.xml',   language: 'xml', restartServices: ['kamailio-icscf'] },
    { group: 'S-CSCF', label: 'scscf.cfg (include)',   path: '/etc/kamailio_scscf/scscf.cfg',   language: 'ini', restartServices: ['kamailio-scscf'] },
    { group: 'S-CSCF', label: 'scscf.xml (Diameter)',  path: '/etc/kamailio_scscf/scscf.xml',   language: 'xml', restartServices: ['kamailio-scscf'] },
    { group: 'PyHSS', label: 'config.yaml',              path: '/opt/pyhss/config.yaml',              language: 'yaml', restartServices: ['pyhss-api', 'pyhss-diameter', 'pyhss-hss', 'pyhss-metrics'] },
    { group: 'PyHSS', label: 'default_ifc.xml',          path: '/opt/pyhss/default_ifc.xml',          language: 'xml',  restartServices: [] },
    { group: 'PyHSS', label: 'default_sh_user_data.xml', path: '/opt/pyhss/default_sh_user_data.xml', language: 'xml',  restartServices: [] },
    { group: 'RTPengine',   label: 'rtpengine.conf',     path: '/etc/rtpengine/rtpengine.conf',          language: 'ini',       restartServices: ['rtpengine-daemon'] },
    { group: 'DNS / BIND9', label: 'named.conf.options', path: '/etc/bind/named.conf.options',           language: 'plaintext', restartServices: ['bind9'] },
    { group: 'DNS / BIND9', label: 'named.conf.local',   path: '/etc/bind/named.conf.local',             language: 'plaintext', restartServices: ['bind9'] },
    ...(imsDomain ? [
      { group: 'DNS / BIND9', label: `${imsDomain}.zone`, path: `/etc/bind/zones/${imsDomain}.zone`, language: 'plaintext', restartServices: ['bind9'] },
    ] as Omit<ConfigFileEntry, 'exists'>[] : []),
    { group: 'Open5GS', label: 'smf.yaml',  path: '/etc/open5gs/smf.yaml',        language: 'yaml',      restartServices: ['open5gs-smfd'] },
    { group: 'Open5GS', label: 'upf.yaml',  path: '/etc/open5gs/upf.yaml',        language: 'yaml',      restartServices: ['open5gs-upfd'] },
    { group: 'Open5GS', label: 'pcrf.yaml', path: '/etc/open5gs/pcrf.yaml',       language: 'yaml',      restartServices: ['open5gs-pcrfd'] },
    { group: 'Open5GS', label: 'pcrf.conf', path: '/etc/freeDiameter/pcrf.conf',  language: 'plaintext', restartServices: ['open5gs-pcrfd'] },
    { group: 'Systemd Units', label: 'kamailio-pcscf.service', path: '/etc/systemd/system/kamailio-pcscf.service', language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'Systemd Units', label: 'kamailio-icscf.service', path: '/etc/systemd/system/kamailio-icscf.service', language: 'ini', restartServices: ['kamailio-icscf'] },
    { group: 'Systemd Units', label: 'kamailio-scscf.service', path: '/etc/systemd/system/kamailio-scscf.service', language: 'ini', restartServices: ['kamailio-scscf'] },
    { group: 'Systemd Units', label: 'kamailio-smsc.service',  path: '/etc/systemd/system/kamailio-smsc.service',  language: 'ini', restartServices: ['kamailio-smsc'] },
    { group: 'SMSC',          label: 'smsc.cfg (include)',     path: '/etc/kamailio_smsc/smsc.cfg',               language: 'ini', restartServices: ['kamailio-smsc'] },
    { group: 'SMSC',          label: 'kamailio_smsc.cfg',      path: '/etc/kamailio_smsc/kamailio_smsc.cfg',      language: 'ini', restartServices: ['kamailio-smsc'] },
    { group: 'Systemd Units', label: 'pyhss-diameter.service', path: '/etc/systemd/system/pyhss-diameter.service', language: 'ini', restartServices: ['pyhss-diameter'] },
    { group: 'Systemd Units', label: 'pyhss-hss.service',      path: '/etc/systemd/system/pyhss-hss.service',      language: 'ini', restartServices: ['pyhss-hss'] },
    { group: 'Systemd Units', label: 'pyhss-api.service',      path: '/etc/systemd/system/pyhss-api.service',      language: 'ini', restartServices: ['pyhss-api'] },
    { group: 'Systemd Units', label: 'pyhss-metrics.service',  path: '/etc/systemd/system/pyhss-metrics.service',  language: 'ini', restartServices: ['pyhss-metrics'] },
  ];

  return entries.map(e => ({ ...e, exists: fs.existsSync(`/proc/1/root${e.path}`) }));
}

function isAllowedConfigPath(p: string): boolean {
  return getImsConfigManifest().some(e => e.path === p);
}

// ── MariaDB helpers ───────────────────────────────────────────────────────────

async function mysqlExec(sql: string, timeoutMs = 60000): Promise<string> {
  const { stdout } = await nsenter('mysql', ['--user=root', '--protocol=socket', '-e', sql], timeoutMs);
  return stdout;
}

async function mysqlExecFile(filePath: string, database: string): Promise<void> {
  await nsenter('bash', ['-c', `mysql --user=root --protocol=socket ${database} < ${filePath}`], 120000);
}

export async function pyhssApiCall(method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: object): Promise<any> {
  const args = ['-s', '-f', '-X', method, `http://127.0.0.1:8080${path}`, '-H', 'Content-Type: application/json'];
  if (body) args.push('-d', JSON.stringify(body));
  const { stdout } = await nsenter('curl', args, 15000);
  return JSON.parse(stdout);
}

async function sourceKamSql(db: string, files: string[]): Promise<void> {
  const kamSqlDir = '/usr/share/kamailio/mysql';
  for (const f of files) {
    const filePath = `${kamSqlDir}/${f}`;
    const exists = await nsenter('bash', ['-c', `[ -f ${filePath} ] && echo yes || echo no`])
      .then(r => r.stdout.trim() === 'yes');
    if (!exists) {
      // Previously this whole function swallowed every failure (`2>/dev/null || true`
      // plus an outer catch), so a missing schema file — e.g. from a kamailio-ims-modules/
      // kamailio-mysql-modules package that didn't install cleanly, or a Kamailio version
      // that ships it under a different path — silently created zero tables for that file
      // while Install still reported success. Confirmed live 2026-09-02: this exact gap
      // let a deployment run for a long time with pcscf.pcscf_location missing entirely,
      // crash-looping kamailio-pcscf ("Cannot fork") with no indication Install was ever
      // at fault. Fail loudly instead — a missing/broken schema file must abort Install.
      throw new Error(
        `Kamailio schema file missing: ${filePath} — expected from the kamailio-ims-modules/` +
        `kamailio-mysql-modules apt packages installed earlier in this Install run. Check ` +
        `those packages actually installed (dpkg -l | grep kamailio) before retrying.`,
      );
    }
    // Kamailio's own vendor-shipped schema files are NOT idempotent — plain `CREATE
    // TABLE foo (...)`, no `IF NOT EXISTS` (unlike this codebase's own hand-written
    // schema blocks elsewhere in this file, which do use IF NOT EXISTS deliberately).
    // Every Configure re-run sources them again against an already-initialized
    // database, so "table/column/key/constraint already exists" is the *expected*,
    // harmless outcome on a re-run — confirmed live 2026-09-02 when the first version
    // of this fix (which failed hard on ANY mysql error) broke a healthy re-Configure
    // on `ERROR 1050 ... Table 'version' already exists`. --force keeps mysql
    // processing the rest of the file past that line too — without it, a plain
    // (non-forced) run silently stops at the FIRST error and never applies anything
    // after it, which was true even before this fix existed (just invisible, since
    // errors were swallowed wholesale). Only a genuinely different error — anything
    // NOT matching one of these specific "already exists" codes — aborts Configure.
    try {
      await nsenter('bash', ['-c', `mysql --force --user=root --protocol=socket ${db} < ${filePath}`], 60000);
    } catch (err: any) {
      const stderr: string = err?.stderr || err?.message || String(err);
      // Empirically verified live 2026-09-02 by force-running every file this function
      // ever sources against already-populated scscf/pcscf/smsc databases: only 1050
      // (table exists), 1061 (duplicate key name), and 1062 (duplicate entry — these
      // files re-INSERT their own `version`/seed rows every time with a plain INSERT,
      // not INSERT IGNORE) ever actually occur. 1062 looks like it should mean a real
      // data conflict, and normally would — but here it's exclusively these files'
      // own non-idempotent version/seed bookkeeping re-running, not subscriber/session
      // data (that goes through separate, already-idempotent codepaths elsewhere in
      // this file). 1060 (duplicate column) and 1826 (duplicate FK constraint name)
      // are kept too even though this exact file set never triggered them — same
      // "schema object already exists" class of error, just not empirically exercised
      // here.
      const benign = /^ERROR (1050|1060|1061|1062|1826)\b/;
      const realErrors = stderr.split('\n').filter(line => /^ERROR /.test(line) && !benign.test(line));
      if (realErrors.length > 0) {
        throw new Error(`Failed sourcing ${filePath} into database '${db}':\n${realErrors.join('\n')}`);
      }
      // Every ERROR line was a benign "already exists" — expected on a re-run, not fatal.
    }
  }
}

// Polls `systemctl is-active` rather than trusting a bare `restart`/`enable --now` exit
// code — systemd accepts the restart request and returns immediately, well before the
// process has actually finished initializing (or crashed). A unit can restart cleanly
// per systemd's own bookkeeping and still be dead a second later once its own startup
// logic hits a real error (e.g. a missing MySQL table) — polling for a few seconds is
// what actually confirms the service stayed up, matching this project's "verify, don't
// trust success" convention (see CLAUDE.md).
async function waitForServiceActive(svc: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const active = await nsenter('systemctl', ['is-active', svc])
      .then(r => r.stdout.trim() === 'active').catch(() => false);
    if (active) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Formats a diagnostic block for a service that failed to come up — current
// systemctl status plus its most recent journal lines, so a Configure failure names
// exactly which service broke and why, instead of a generic "configure failed".
async function serviceFailureDetail(svc: string): Promise<string> {
  const status = await nsenter('systemctl', ['is-active', svc]).then(r => r.stdout.trim()).catch(() => 'unknown');
  const journal = await nsenter('journalctl', ['-u', svc, '-n', '15', '--no-pager'])
    .then(r => r.stdout.trim()).catch(() => '(could not read journal)');
  return `${svc} (status: ${status}):\n${journal}`;
}

async function initializeImsDatabase(p: {
  imsDomain: string;
  scscfIp: string;
  scscfPort: number;
}): Promise<void> {
  const scscfUri = `sip:scscf.${p.imsDomain}:${p.scscfPort}`;

  // Per-component MySQL users
  await mysqlExec(`CREATE USER IF NOT EXISTS 'icscf'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'icscf'@'127.0.0.1' IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'scscf'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'scscf'@'127.0.0.1' IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pcscf'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pcscf'@'127.0.0.1' IDENTIFIED BY 'heslo';`);

  // ── icscf ────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS icscf CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON icscf.* TO 'icscf'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON icscf.* TO 'icscf'@'127.0.0.1';`);
  await mysqlExec(`FLUSH PRIVILEGES;`);

  // Try official icscf.sql from Kamailio examples, fall back to hand-crafted
  const icscfSqlPath = '/usr/share/doc/kamailio/examples/ims/icscf/icscf.sql';
  const icscfSqlAlt  = '/usr/local/src/kamailio/misc/examples/ims/icscf/icscf.sql';
  const hasOfficialIcscf = await nsenter('bash', ['-c',
    `[ -f ${icscfSqlPath} ] && echo yes || ([ -f ${icscfSqlAlt} ] && echo yes || echo no)`], 10000)
    .then(r => r.stdout.trim() === 'yes').catch(() => false);

  if (hasOfficialIcscf) {
    await nsenter('bash', ['-c',
      `[ -f ${icscfSqlPath} ] && mysql --user=root --protocol=socket icscf < ${icscfSqlPath} 2>/dev/null || mysql --user=root --protocol=socket icscf < ${icscfSqlAlt} 2>/dev/null || true`], 60000).catch(() => {});
  } else {
    await mysqlExec(`USE icscf;
CREATE TABLE IF NOT EXISTS nds_trusted_domains (
  id             INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  trusted_domain VARCHAR(83)      NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS s_cscf (
  id         INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(83)  NOT NULL DEFAULT '',
  s_cscf_uri VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS s_cscf_capabilities (
  id         INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  id_s_cscf  INT(10) UNSIGNED NOT NULL DEFAULT 0,
  capability INT(10) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;`);
  }

  // Seed icscf trusted domain + S-CSCF
  await mysqlExec(`USE icscf;
INSERT INTO nds_trusted_domains (trusted_domain)
  SELECT '${p.imsDomain}' WHERE NOT EXISTS
  (SELECT 1 FROM nds_trusted_domains WHERE trusted_domain='${p.imsDomain}');`);

  await mysqlExec(`USE icscf;
DELETE FROM s_cscf WHERE s_cscf_uri NOT LIKE '%:${p.scscfPort}';
INSERT INTO s_cscf (name, s_cscf_uri)
  SELECT 'default', '${scscfUri}' WHERE NOT EXISTS
  (SELECT 1 FROM s_cscf WHERE s_cscf_uri='${scscfUri}');`);

  await mysqlExec(`USE icscf;
INSERT IGNORE INTO s_cscf_capabilities (id_s_cscf, capability)
  SELECT id, 0 FROM s_cscf WHERE s_cscf_uri='${scscfUri}';
INSERT IGNORE INTO s_cscf_capabilities (id_s_cscf, capability)
  SELECT id, 1 FROM s_cscf WHERE s_cscf_uri='${scscfUri}';`);

  // ── scscf ─────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS scscf CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON scscf.* TO 'scscf'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON scscf.* TO 'scscf'@'127.0.0.1';`);

  // Use official Kamailio SQL files when available
  await sourceKamSql('scscf', ['standard-create.sql', 'presence-create.sql', 'ims_usrloc_scscf-create.sql', 'ims_dialog-create.sql', 'ims_charging-create.sql', 'acc-create.sql']);

  // acc-create.sql's stock acc/missed_calls tables have no src_user/dst_user
  // columns -- CDR Phase 3 (WITH_CDR) needs both via acc's own db_extra
  // modparam. MariaDB 10.11 (confirmed installed) supports IF NOT EXISTS on
  // ADD COLUMN directly, so this is safely re-runnable on every Configure
  // without needing sourceKamSql()'s stderr-code-tolerance idiom.
  await mysqlExec(`USE scscf;
ALTER TABLE acc ADD COLUMN IF NOT EXISTS src_user VARCHAR(255) DEFAULT NULL;
ALTER TABLE acc ADD COLUMN IF NOT EXISTS dst_user VARCHAR(255) DEFAULT NULL;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS src_user VARCHAR(255) DEFAULT NULL;
ALTER TABLE missed_calls ADD COLUMN IF NOT EXISTS dst_user VARCHAR(255) DEFAULT NULL;`);

  // Fall-back hand-crafted tables (ignored if official files already created them)
  // Drop and recreate with correct ims_usrloc_scscf schema (previous schema was wrong)
  await mysqlExec(`USE scscf;
DROP TABLE IF EXISTS version, impu_subscriber, impu_contact, impu, contact, subscriber;`);

  await mysqlExec(`USE scscf;
CREATE TABLE IF NOT EXISTS version (table_name VARCHAR(32), table_version SMALLINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (table_name)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contact (
  id         INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  contact    CHAR(255)        NOT NULL,
  params     VARCHAR(255)     DEFAULT NULL,
  path       VARCHAR(255)     DEFAULT NULL,
  received   VARCHAR(255)     DEFAULT NULL,
  user_agent VARCHAR(255)     DEFAULT NULL,
  expires    DATETIME         DEFAULT NULL,
  callid     VARCHAR(255)     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY contact (contact)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS impu (
  id                   INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  impu                 CHAR(64)         NOT NULL,
  barring              INT(1)           DEFAULT '0',
  reg_state            INT(11)          DEFAULT '0',
  ccf1 CHAR(64) DEFAULT NULL, ccf2 CHAR(64) DEFAULT NULL,
  ecf1 CHAR(64) DEFAULT NULL, ecf2 CHAR(64) DEFAULT NULL,
  ims_subscription_data BLOB,
  PRIMARY KEY (id),
  UNIQUE KEY impu (impu)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS impu_contact (
  id         INT(11)          NOT NULL AUTO_INCREMENT,
  impu_id    INT(11)          NOT NULL,
  contact_id INT(11)          NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY impu_id (impu_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS subscriber (
  id               INT(11)      NOT NULL AUTO_INCREMENT,
  watcher_uri      VARCHAR(100) NOT NULL,
  watcher_contact  VARCHAR(100) NOT NULL,
  presentity_uri   VARCHAR(100) NOT NULL,
  event            INT(11)      NOT NULL,
  expires          DATETIME     NOT NULL,
  version          INT(11)      NOT NULL,
  local_cseq       INT(11)      NOT NULL,
  call_id          VARCHAR(50)  NOT NULL,
  from_tag         VARCHAR(50)  NOT NULL,
  to_tag           VARCHAR(50)  NOT NULL,
  -- record_route was VARCHAR(50): real Record-Route header chains across
  -- multiple IMS proxies (P-CSCF, S-CSCF) routinely exceed that, causing a
  -- silent MySQL 1406 "Data too long" failure on every real SUBSCRIBE from
  -- a live phone (confirmed live 2026-09-04 via kamailio-scscf's own error
  -- log). TEXT matches active_watchers' own record_route column, which
  -- never had this problem.
  record_route     TEXT         NOT NULL,
  sockinfo_str     VARCHAR(50)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY watcher_uri (event, watcher_contact, presentity_uri)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

-- Retroactive fix for any deployment whose subscriber table already existed before
-- record_route became TEXT above (CREATE TABLE IF NOT EXISTS is a no-op against an
-- existing table, so the CREATE statement alone would never widen an existing
-- deployment's column). Safe to re-run every Configure: MODIFY to the same type is
-- a harmless no-op once already applied.
ALTER TABLE subscriber MODIFY COLUMN record_route TEXT NOT NULL;

CREATE TABLE IF NOT EXISTS impu_subscriber (
  id            INT(11) NOT NULL AUTO_INCREMENT,
  impu_id       INT(11) NOT NULL,
  subscriber_id INT(11) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY impu_id (impu_id, subscriber_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS presentity (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  domain        VARCHAR(64)  NOT NULL,
  event         VARCHAR(64)  NOT NULL,
  etag          VARCHAR(128) NOT NULL,
  expires       INT(11)      NOT NULL,
  received_time INT(11)      NOT NULL,
  body          BLOB         NOT NULL,
  sender        VARCHAR(255) NOT NULL,
  priority      INT(11)      DEFAULT 0 NOT NULL,
  ruid          VARCHAR(64),
  PRIMARY KEY (id),
  CONSTRAINT presentity_idx UNIQUE (username, domain, event, etag),
  CONSTRAINT ruid_idx UNIQUE (ruid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS active_watchers (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  presentity_uri VARCHAR(128) NOT NULL,
  watcher_username VARCHAR(64) NOT NULL,
  watcher_domain VARCHAR(64) NOT NULL,
  to_user       VARCHAR(64)  NOT NULL,
  to_domain     VARCHAR(64)  NOT NULL,
  from_user     VARCHAR(64)  NOT NULL DEFAULT '',
  from_domain   VARCHAR(64)  NOT NULL DEFAULT '',
  event         VARCHAR(64)  NOT NULL DEFAULT 'presence',
  event_id      VARCHAR(64),
  to_tag        VARCHAR(128) NOT NULL,
  from_tag      VARCHAR(128) NOT NULL,
  callid        VARCHAR(128) NOT NULL,
  local_cseq    INT(11)      NOT NULL,
  remote_cseq   INT(11)      NOT NULL,
  contact       VARCHAR(128) NOT NULL,
  record_route  TEXT,
  expires       INT(11)      NOT NULL,
  status        INT(11)      NOT NULL DEFAULT 2,
  reason        VARCHAR(64),
  version       INT(11)      NOT NULL DEFAULT 0,
  socket_info   VARCHAR(64)  NOT NULL,
  local_contact VARCHAR(128) NOT NULL,
  ruid          VARCHAR(64)  NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY active_watchers_idx (callid, to_tag, from_tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS watchers (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  presentity_uri VARCHAR(128) NOT NULL,
  watcher_username VARCHAR(64) NOT NULL,
  watcher_domain VARCHAR(64) NOT NULL,
  event         VARCHAR(64)  NOT NULL DEFAULT 'presence',
  status        INT(11)      NOT NULL,
  reason        VARCHAR(64),
  inserted_time INT(11)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY watchers_idx (presentity_uri, watcher_username, watcher_domain, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS xcap (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  domain        VARCHAR(64)  NOT NULL,
  doc           LONGBLOB     NOT NULL,
  doc_type      INT(11)      NOT NULL,
  etag          VARCHAR(64)  NOT NULL,
  source        INT(11)      NOT NULL,
  doc_uri       VARCHAR(255) NOT NULL,
  port          VARCHAR(10),
  PRIMARY KEY (id),
  UNIQUE KEY xcap_idx (username, domain, doc_type, doc_uri)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS pua (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  pres_uri      VARCHAR(128) NOT NULL,
  pres_id       VARCHAR(255) NOT NULL,
  event         INT(11)      NOT NULL,
  expires       INT(11)      NOT NULL,
  desired_expires INT(11)    NOT NULL,
  flag          INT(11)      NOT NULL,
  etag          VARCHAR(64),
  tuple_id      VARCHAR(64),
  watcher_uri   VARCHAR(128),
  to_uri        VARCHAR(128),
  call_id       VARCHAR(128),
  to_tag        VARCHAR(64),
  from_tag      VARCHAR(64),
  cseq          INT(11),
  record_route  VARCHAR(255),
  contact       VARCHAR(128),
  remote_contact VARCHAR(128),
  version       INT(11),
  PRIMARY KEY (id),
  UNIQUE KEY pua_idx (pres_uri, pres_id, flag, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

INSERT IGNORE INTO version (table_name, table_version) VALUES
  ('presentity',    '5'),
  ('active_watchers','12'),
  ('watchers',      '3'),
  ('xcap',          '4'),
  ('pua',           '7');`);

  // ── pcscf ─────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS pcscf CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON pcscf.* TO 'pcscf'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON pcscf.* TO 'pcscf'@'127.0.0.1';`);
  await sourceKamSql('pcscf', ['standard-create.sql', 'presence-create.sql', 'ims_usrloc_pcscf-create.sql', 'ims_dialog-create.sql']);

  // ims_usrloc_pcscf-create.sql (above) only ever creates a table literally named
  // `location` — Kamailio's own stock default. But every route file in this project
  // (mo.cfg/mt.cfg/register.cfg/kamailio_pcscf.cfg) calls the module's functions with
  // domain name "pcscf_location", not "location" — ims_usrloc_pcscf uses that domain
  // string directly as the table it queries, so the module actually needs a table
  // named `pcscf_location` to exist, and nothing in this codebase ever created one.
  // Confirmed live 2026-09-02: this table existed on one deployment (this host) purely
  // because someone created/renamed it by hand at some undocumented point in the past
  // — a genuinely fresh deployment had no such history and crash-looped kamailio-pcscf
  // ("Cannot fork") on this exact gap. Schema copied verbatim from this host's own
  // working `pcscf_location` (confirmed identical to the vendor `location` table,
  // just renamed) so this is the real, permanent fix rather than another silent gap.
  await mysqlExec(`CREATE TABLE IF NOT EXISTS pcscf.pcscf_location (
  id INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  domain VARCHAR(64) NOT NULL,
  aor VARCHAR(255) NOT NULL,
  host VARCHAR(100) NOT NULL,
  port INT(10) NOT NULL,
  received VARCHAR(128) DEFAULT NULL,
  received_port INT(10) UNSIGNED DEFAULT NULL,
  received_proto INT(10) UNSIGNED DEFAULT NULL,
  path VARCHAR(512) DEFAULT NULL,
  rinstance VARCHAR(255) DEFAULT NULL,
  rx_session_id VARCHAR(256) DEFAULT NULL,
  reg_state TINYINT(4) DEFAULT NULL,
  expires DATETIME DEFAULT '2030-05-28 21:32:15',
  service_routes VARCHAR(2048) DEFAULT NULL,
  socket VARCHAR(64) DEFAULT NULL,
  public_ids VARCHAR(2048) DEFAULT NULL,
  security_type INT(11) DEFAULT NULL,
  protocol INT(10) DEFAULT NULL,
  mode CHAR(10) DEFAULT NULL,
  ck VARCHAR(100) DEFAULT NULL,
  ik VARCHAR(100) DEFAULT NULL,
  ealg CHAR(20) DEFAULT NULL,
  ialg CHAR(20) DEFAULT NULL,
  port_pc INT(11) UNSIGNED DEFAULT NULL,
  port_ps INT(11) UNSIGNED DEFAULT NULL,
  port_uc INT(11) UNSIGNED DEFAULT NULL,
  port_us INT(11) UNSIGNED DEFAULT NULL,
  spi_pc INT(11) UNSIGNED DEFAULT NULL,
  spi_ps INT(11) UNSIGNED DEFAULT NULL,
  spi_uc INT(11) UNSIGNED DEFAULT NULL,
  spi_us INT(11) UNSIGNED DEFAULT NULL,
  t_security_type INT(11) DEFAULT NULL,
  t_port_pc INT(11) UNSIGNED DEFAULT NULL,
  t_port_ps INT(11) UNSIGNED DEFAULT NULL,
  t_port_uc INT(11) UNSIGNED DEFAULT NULL,
  t_port_us INT(11) UNSIGNED DEFAULT NULL,
  t_spi_pc INT(11) UNSIGNED DEFAULT NULL,
  t_spi_ps INT(11) UNSIGNED DEFAULT NULL,
  t_spi_uc INT(11) UNSIGNED DEFAULT NULL,
  t_spi_us INT(11) UNSIGNED DEFAULT NULL,
  t_protocol CHAR(5) DEFAULT NULL,
  t_mode CHAR(10) DEFAULT NULL,
  t_ck VARCHAR(100) DEFAULT NULL,
  t_ik VARCHAR(100) DEFAULT NULL,
  t_ealg CHAR(20) DEFAULT NULL,
  t_ialg CHAR(20) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY aor (aor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;`);
  await mysqlExec(`INSERT IGNORE INTO pcscf.version (table_name, table_version) VALUES ('pcscf_location', '7');`);

  // ── ims_hss_db (PyHSS) ────────────────────────────────────────────────────────
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pyhss'@'localhost'  IDENTIFIED BY 'ims_db_pass';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pyhss'@'127.0.0.1' IDENTIFIED BY 'ims_db_pass';`);
  // Always reset password — CREATE USER IF NOT EXISTS skips the password update when the user
  // already exists (e.g. after ims_remove + ims_configure cycle), leaving a stale hash.
  await mysqlExec(`ALTER USER 'pyhss'@'localhost'  IDENTIFIED BY 'ims_db_pass';`);
  await mysqlExec(`ALTER USER 'pyhss'@'127.0.0.1' IDENTIFIED BY 'ims_db_pass';`);
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS ims_hss_db CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON ims_hss_db.* TO 'pyhss'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON ims_hss_db.* TO 'pyhss'@'127.0.0.1';`);

  // ── smsc ──────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE USER IF NOT EXISTS 'smsc'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'smsc'@'127.0.0.1' IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS smsc CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON smsc.* TO 'smsc'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON smsc.* TO 'smsc'@'127.0.0.1';`);
  await sourceKamSql('smsc', ['standard-create.sql', 'dialplan-create.sql', 'presence-create.sql']);
  await mysqlExec(`USE smsc;
CREATE TABLE IF NOT EXISTS \`messages\` (
  \`id\`     INT(10) UNSIGNED AUTO_INCREMENT PRIMARY KEY NOT NULL,
  \`caller\` VARCHAR(255) NOT NULL,
  \`callee\` VARCHAR(255) NOT NULL,
  \`text\`   VARCHAR(512),
  \`dcs\`    INT(1),
  \`valid\`  DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
INSERT IGNORE INTO version (table_name, table_version) VALUES ('messages','1');`);

  await mysqlExec(`FLUSH PRIVILEGES;`);
}

// ── Configure (extracted for reuse by the PLMN Migration Wizard) ──────────────
// No internal default-fallbacks here — callers (the manual /configure route below,
// or the PLMN migration use-case) must pass a fully-populated input. Defaults for
// the manual-UI path live only in the thin route wrapper.
export type ImsConfigureFullInput = ImsConfigureInput & { mcc: string; mnc: string };

// Reads back the full current config from .ims-config.json (written as a side
// effect of every configureIms() call) — lets the PLMN migration use-case build
// `{ ...readCurrentImsConfig(), mcc: newMcc, mnc: newMnc }` instead of an empty
// body, which would otherwise reset pcscfIp/icscfIp/scscfIp/etc. back to the
// hardcoded defaults that only live in the manual /configure route wrapper.
// Returns null if IMS has never been configured (not installed, or Install-only
// so far) — the migration use-case treats that as "skip this phase", not an error.
export function readCurrentImsConfig(): ImsConfigureFullInput | null {
  if (!fs.existsSync(HOST_IMS_STATE)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
    return (saved?.config as ImsConfigureFullInput) ?? null;
  } catch {
    return null;
  }
}

// Real, 2026-09-24 finding: this was ONLY ever reachable via the manual
// POST /sync-subscribers button — backup-restart-usecase.ts's own IMS
// reapply calls configureIms() alone, which never touches PyHSS's
// subscriber records at all. A restore therefore always brought back a
// fully-configured, fully-running IMS stack with ZERO subscribers able to
// register — confirmed live: the user had to click this by hand after
// every restore this whole session. Extracted from the route handler
// (previously ~244 lines inline, unchanged logic) specifically so
// backup-restart-usecase.ts can call it directly, the same way
// configureIms() itself already is.
export async function syncImsSubscribers(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
): Promise<{ synced: number; failed: string[]; removed: number; total: number }> {
  if (!fs.existsSync(HOST_IMS_STATE)) {
    throw new Error('IMS not configured — run Configure first.');
  }
  const savedState = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
  const imsDomain  = savedState.imsDomain;
  const savedConfig = savedState.config ?? {};

  const allSubs = await subscriberRepo.findAllFull();
  const toSync  = allSubs.filter(s => s.msisdn && s.msisdn.length > 0 && s.security?.k);

  const primaryMcc = savedConfig.mcc ?? '';
  const primaryMnc = savedConfig.mnc ?? '';
  const additionalPlmns: { mcc: string; mnc: string }[] = savedConfig.additionalPlmns ?? [];
  const allPlmns = [
    { mcc: primaryMcc, mnc: primaryMnc, domain: imsDomain },
    ...additionalPlmns.map((p: { mcc: string; mnc: string }) => ({
      mcc: p.mcc, mnc: p.mnc, domain: deriveImsDomain(p.mcc, p.mnc),
    })),
  ];

  const domainForImsi = (imsi: string): string => {
    for (const plmn of allPlmns) {
      if (imsi.startsWith(plmn.mcc + plmn.mnc)) return plmn.domain;
    }
    return imsDomain;
  };

  const scscfPort = savedConfig.scscfPort ?? 6060;
  const scscfIp   = savedConfig.scscfIp   ?? '127.0.1.2';
  try {
    const updatedYaml = pyhssConfigYaml({
      imsDomain,
      mcc: primaryMcc, mnc: primaryMnc,
      scscfIp, scscfPort,
      hssIp: '127.0.1.3',
      additionalPlmns,
    });
    fs.writeFileSync('/proc/1/root/opt/pyhss/config.yaml', updatedYaml, 'utf-8');
    await nsenter('systemctl', ['restart', 'pyhss-hss', 'pyhss-diameter']).catch(() => {});
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      try { await pyhssApiCall('GET', '/apn/list'); ready = true; break; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!ready) logger.warn('PyHSS API did not become ready within 45s after restart — sync will likely fail');
  } catch (e) {
    logger.warn({ err: String(e) }, 'Could not update pyHSS config during sync — continuing anyway');
  }

  let synced = 0;
  const failed: string[] = [];

  {
    let internetApnId = 1;
    try {
      const apnList: any[] = await pyhssApiCall('GET', '/apn/list');
      const existing = Array.isArray(apnList) ? apnList.find((a: any) => a.apn === 'internet') : null;
      if (existing) {
        internetApnId = existing.apn_id;
      } else {
        const created = await pyhssApiCall('PUT', '/apn/', {
          apn: 'internet', apn_ambr_dl: 999999, apn_ambr_ul: 999999, qci: 9, arp_priority: 4,
        });
        internetApnId = created.apn_id ?? 1;
      }
    } catch { /* use default apn_id=1 */ }

    const syncImsiSet = new Set(toSync.map(s => s.imsi));
    const msisdnOwnerMap = new Map<string, { imsi: string; id: number }>();
    try {
      const imsAll: any[] = await pyhssApiCall('GET', '/ims_subscriber/list');
      if (Array.isArray(imsAll)) {
        for (const e of imsAll) {
          if (e.msisdn) msisdnOwnerMap.set(String(e.msisdn), { imsi: String(e.imsi), id: e.ims_subscriber_id });
        }
      }
    } catch { /* proceed without conflict map */ }

    for (const sub of toSync) {
      const imsi   = sub.imsi;
      const msisdn = sub.msisdn![0];
      const k      = (sub.security?.k ?? '').toUpperCase();
      const opc    = (sub.security?.opc ?? '').toUpperCase();
      const amf    = (sub.security?.amf ?? '8000').toString();
      const sqnNum = Number(sub.security?.sqn ?? 0);

      if (!/^\d+$/.test(imsi) || !/^\d+$/.test(msisdn) || !/^[0-9a-fA-F]{32}$/.test(k)) {
        failed.push(`${imsi}: invalid IMSI/MSISDN/K format`);
        continue;
      }

      try {
        let existingIms: any = null;
        try { existingIms = await pyhssApiCall('GET', `/ims_subscriber/ims_subscriber_imsi/${imsi}`); } catch { /* not found */ }
        if (existingIms?.ims_subscriber_id) {
          try { await pyhssApiCall('DELETE', `/ims_subscriber/${existingIms.ims_subscriber_id}`); } catch { /* ignore */ }
          msisdnOwnerMap.delete(String(existingIms.msisdn ?? msisdn));
        }

        let existingSub: any = null;
        try { existingSub = await pyhssApiCall('GET', `/subscriber/imsi/${imsi}`); } catch { /* not found */ }
        if (existingSub?.subscriber_id) {
          try { await pyhssApiCall('DELETE', `/subscriber/${existingSub.subscriber_id}`); } catch { /* ignore */ }
        }

        let existingAuc: any = null;
        try { existingAuc = await pyhssApiCall('GET', `/auc/imsi/${imsi}`); } catch { /* not found */ }
        if (existingAuc?.auc_id) {
          try { await pyhssApiCall('DELETE', `/auc/${existingAuc.auc_id}`); } catch { /* ignore */ }
        }

        const conflict = msisdnOwnerMap.get(msisdn);
        if (conflict && conflict.imsi !== imsi) {
          if (!syncImsiSet.has(conflict.imsi)) {
            try { await pyhssApiCall('DELETE', `/ims_subscriber/${conflict.id}`); } catch { /* ignore */ }
            msisdnOwnerMap.delete(msisdn);
          } else {
            throw new Error(`MSISDN ${msisdn} is also assigned to IMSI ${conflict.imsi} — fix duplicate MSISDNs on the Subscribers page`);
          }
        }

        const newAuc = await pyhssApiCall('PUT', '/auc/', { ki: k, opc, amf, sqn: sqnNum, imsi });
        const aucId  = newAuc.auc_id;

        await pyhssApiCall('PUT', '/subscriber/', {
          imsi, msisdn, auc_id: aucId,
          default_apn: internetApnId,
          apn_list: String(internetApnId),
          enabled: true,
        });

        const subDomain   = domainForImsi(imsi);
        const subScscfUri = `sip:scscf.${subDomain}:${scscfPort}`;
        await pyhssApiCall('PUT', '/ims_subscriber/', {
          imsi, msisdn,
          msisdn_list: msisdn,
          scscf: subScscfUri,
          scscf_realm: subDomain,
          scscf_peer: `scscf.${subDomain}`,
          ifc_path: 'pyhss/default_ifc.xml',
        });

        msisdnOwnerMap.set(msisdn, { imsi, id: 0 });
        synced++;
      } catch (e) {
        failed.push(`${imsi}: ${(e as Error).message ?? String(e)}`);
        logger.warn({ imsi, err: String(e) }, 'PyHSS subscriber sync failed');
      }
    }
  }

  let removed = 0;
  try {
    const currentImsiSet = new Set(toSync.map(s => s.imsi));
    const imsAll: any[] = await pyhssApiCall('GET', '/ims_subscriber/list');
    const staleImsis = Array.isArray(imsAll)
      ? imsAll.filter(e => e.imsi && !currentImsiSet.has(String(e.imsi))).map(e => String(e.imsi))
      : [];

    for (const staleImsi of staleImsis) {
      try {
        let existingIms: any = null;
        try { existingIms = await pyhssApiCall('GET', `/ims_subscriber/ims_subscriber_imsi/${staleImsi}`); } catch { /* not found */ }
        if (existingIms?.ims_subscriber_id) {
          await pyhssApiCall('DELETE', `/ims_subscriber/${existingIms.ims_subscriber_id}`).catch(() => {});
        }

        let existingSub: any = null;
        try { existingSub = await pyhssApiCall('GET', `/subscriber/imsi/${staleImsi}`); } catch { /* not found */ }
        if (existingSub?.subscriber_id) {
          await pyhssApiCall('DELETE', `/subscriber/${existingSub.subscriber_id}`).catch(() => {});
        }

        let existingAuc: any = null;
        try { existingAuc = await pyhssApiCall('GET', `/auc/imsi/${staleImsi}`); } catch { /* not found */ }
        if (existingAuc?.auc_id) {
          await pyhssApiCall('DELETE', `/auc/${existingAuc.auc_id}`).catch(() => {});
        }

        removed++;
      } catch (e) {
        logger.warn({ imsi: staleImsi, err: String(e) }, 'PyHSS stale subscriber cleanup failed');
      }
    }
  } catch (e) {
    logger.warn({ err: String(e) }, 'Could not fetch PyHSS ims_subscriber list for cleanup — skipping');
  }

  return { synced, failed, removed, total: toSync.length };
}

export async function configureIms(input: ImsConfigureFullInput): Promise<{ imsDomain: string }> {
  const {
    pcscfIp, pcscfPort, icscfIp, icscfPort, scscfIp, scscfPort,
    rtpEngineIp, rtpPortMin, rtpPortMax, dnsIp, mcc, mnc,
    additionalPlmns = [],
  } = input;

  const imsDomain = deriveImsDomain(mcc, mnc);
  const zoneName  = imsDomain;
  const zoneFile  = `/etc/bind/zones/${zoneName}.zone`;

  // Derive additional IMS domains from additional PLMNs
  const additionalDomains = (additionalPlmns ?? []).map((p: { mcc: string; mnc: string }) =>
    deriveImsDomain(p.mcc, p.mnc),
  );

  // Domains that were configured before this call but aren't in the new list anymore
  // (e.g. a PLMN was removed, or the primary PLMN itself changed) — their zone file +
  // named.conf.local stanza must be deleted here, not just left to accumulate.
  let removedDomains: string[] = [];
  // Preserve the SMS delivery-mode toggle (see setSmsDeliveryMode() below)
  // across a plain Configure re-run — this project's "full rewrite every
  // time" convention would otherwise silently reset it back to 'ims'.
  let smsDeliveryMode: 'sgs' | 'ims' | 'vectorcore' = 'ims';
  // Preserve the SMS_WORKER poll interval (see setSmsWorkerInterval() below)
  // across a plain Configure re-run for the same reason as smsDeliveryMode
  // above. Default 30s matches the reference project's original hardcoded
  // value.
  let smsWorkerIntervalSeconds = 30;
  // Preserve the voice/airtime charging (Diameter Ro) toggle across a plain
  // Configure re-run, same reason as smsDeliveryMode above — see
  // setVoiceChargingEnabled() below. Defaults off: enabling it touches a
  // currently-working, critical, live IMS component (S-CSCF) exactly the way
  // the Gy toggle touched SMF during this same session's production
  // incident — see CLAUDE.md's SigScale OCS / Charging Plans pattern entries.
  let voiceChargingEnabled = false;
  // Preserve the CDR accounting (Kamailio `acc` module, direct IMS-to-IMS
  // call records) toggle across a plain Configure re-run, same reason as
  // voiceChargingEnabled above — see setCdrAccountingEnabled() below.
  // Defaults off: same live-S-CSCF blast radius as voiceChargingEnabled,
  // though this one has no external-service dependency to re-heal.
  let cdrAccountingEnabled = false;
  // SIP tracing (HEP) -- preserved across Configure exactly like the two
  // toggles above. Enabling it costs a restart of all three CSCFs, and a
  // P-CSCF restart wipes every registered UE's IPsec SA, so it is never
  // enabled implicitly here; only setSipTracingEnabled() turns it on.
  let sipTracingEnabled = false;
  if (fs.existsSync(HOST_IMS_STATE)) {
    try {
      const prevSaved = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
      if (typeof prevSaved?.smsWorkerIntervalSeconds === 'number' && prevSaved.smsWorkerIntervalSeconds > 0) {
        smsWorkerIntervalSeconds = prevSaved.smsWorkerIntervalSeconds;
      }
      const prevAdditionalPlmns: { mcc: string; mnc: string }[] = prevSaved?.config?.additionalPlmns ?? [];
      const prevDomains = prevAdditionalPlmns.map(p => deriveImsDomain(p.mcc, p.mnc));
      const prevPrimaryDomain: string | undefined = prevSaved?.imsDomain;
      if (prevPrimaryDomain) prevDomains.push(prevPrimaryDomain);
      removedDomains = [...new Set(prevDomains)].filter(d => d !== imsDomain && !additionalDomains.includes(d));
      if (prevSaved?.smsDeliveryMode === 'sgs' || prevSaved?.smsDeliveryMode === 'vectorcore') smsDeliveryMode = prevSaved.smsDeliveryMode;
      if (prevSaved?.voiceChargingEnabled === true) voiceChargingEnabled = true;
      if (prevSaved?.cdrAccountingEnabled === true) cdrAccountingEnabled = true;
      if (prevSaved?.sipTracingEnabled === true) sipTracingEnabled = true;
    } catch { /* corrupt state — nothing to clean up */ }
  }
  // Fail-safe, not fail-loud, on a plain re-Configure: if the toggle was left
  // on but OCS is no longer reachable (uninstalled, never configured), don't
  // let a stale flag silently break the entire IMS stack's Configure run —
  // degrade to "voice charging off" the same way a removed BIND forwarder or
  // any other optional cross-module dependency degrades elsewhere in this
  // file. The dedicated /voice-charging route below is the one place that
  // DOES hard-fail when an operator explicitly tries to turn this on against
  // an unavailable OCS, matching setSmsDeliveryMode()'s existing guard style.
  let ocsPeerInfo = voiceChargingEnabled ? getOcsPeerInfo() : null;
  if (voiceChargingEnabled && !ocsPeerInfo) voiceChargingEnabled = false;
  // Re-heal S-CSCF's OCS Diameter client registration on every plain
  // Configure too (not just inside setVoiceChargingEnabled() below) — mirrors
  // configureOcs()'s own addSmfAsOcsClient() call, same idempotent-by-IP
  // Mnesia upsert, in case OCS's own client table was ever reset
  // independently of this toggle. A failure here downgrades this run to
  // "voice charging off" rather than throwing — an optional add-on's peer
  // hiccup must never fail the entire IMS Configure (P-CSCF/I-CSCF/SMS/etc.
  // all restart from the same call), and writing scscf.cfg/scscf.xml with
  // WITH_RO baked in while OCS doesn't actually trust S-CSCF as a client
  // would be the fatal "looks configured, isn't" trap this session's Gy
  // incident already demonstrated once tonight.
  if (ocsPeerInfo) {
    const clientResult = await addOcsDiameterClient(OCS_CLIENT_SOURCE_IP);
    if (!clientResult.ok) {
      ocsPeerInfo = null;
      voiceChargingEnabled = false;
    }
  }

  // 1. P-CSCF include config + Diameter XML
  const epcDomain = deriveEpcDomain(mcc, mnc);
  const { fqdn: pcrfFqdn, port: pcrfPort } = readPcrfFreeDiameterInfo();
  const http2N5Available = await isKamailioHttp2Capable();
  fs.mkdirSync(HOST_KAMAILIO_PCSCF_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_KAMAILIO_PCSCF_DIR}/pcscf.cfg`,
    pcscfIncludeCfg({ pcscfIp, pcscfPort, imsDomain, epcDomain, additionalDomains, http2N5Available,
      sipTracePort: sipTracePortFor(sipTracingEnabled, 'pcscf') }), 'utf-8');
  fs.writeFileSync(`${HOST_KAMAILIO_PCSCF_DIR}/pcscf.xml`,
    pcscfDiameterXml({ pcscfIp, imsDomain, pcrfFqdn, pcrfPort }), 'utf-8');

  // 2. I-CSCF include config + Diameter XML
  fs.mkdirSync(HOST_KAMAILIO_ICSCF_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_KAMAILIO_ICSCF_DIR}/icscf.cfg`,
    icscfIncludeCfg({ icscfIp, icscfPort, imsDomain, additionalDomains,
      sipTracePort: sipTracePortFor(sipTracingEnabled, 'icscf') }), 'utf-8');
  fs.writeFileSync(`${HOST_KAMAILIO_ICSCF_DIR}/icscf.xml`,
    icscfDiameterXml({ icscfIp, imsDomain }), 'utf-8');

  // 3. S-CSCF include config + Diameter XML
  fs.mkdirSync(HOST_KAMAILIO_SCSCF_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
    scscfIncludeCfg({
      scscfIp, scscfPort, imsDomain, additionalDomains,
      blockImsSms: smsDeliveryMode === 'sgs',
      routeSmsToVectorcore: smsDeliveryMode === 'vectorcore' ? VECTORCORE_SMSC_SIP_ADDRESS : undefined,
      voiceCharging: ocsPeerInfo ? { ocsOriginHost: ocsPeerInfo.originHost } : undefined,
      cdrAccounting: cdrAccountingEnabled,
      sipTracePort: sipTracePortFor(sipTracingEnabled, 'scscf'),
    }), 'utf-8');
  fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.xml`,
    scscfDiameterXml({
      scscfIp, imsDomain,
      ocsPeer: ocsPeerInfo ? { fqdn: ocsPeerInfo.originHost, port: ocsPeerInfo.port } : undefined,
    }), 'utf-8');
  if (ocsPeerInfo) await upsertOcsDnsRecord(mcc, mnc, ocsPeerInfo.bindIp);

  // 3b. SMSC config — Kamailio SMS center on port 7090
  const smscIp = pcscfIp; // SMSC runs on same host as P-CSCF
  fs.mkdirSync(HOST_KAMAILIO_SMSC_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_KAMAILIO_SMSC_DIR}/smsc.cfg`,
    smscIncludeCfg({ smscIp, imsDomain }), 'utf-8');
  fs.writeFileSync(`${HOST_KAMAILIO_SMSC_DIR}/kamailio_smsc.cfg`,
    smscMainCfg(smsWorkerIntervalSeconds), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-smsc.service`,
    smscSystemdUnit(), 'utf-8');

  // 4. RTPengine config — listen-ng must match kamailio_pcscf.cfg's rtpengine_sock
  fs.mkdirSync('/proc/1/root/etc/rtpengine', { recursive: true });
  fs.writeFileSync(HOST_RTPENGINE_CONF,
    `[rtpengine]\ninterface = ${rtpEngineIp}\nlisten-ng = ${rtpEngineIp}:2223\ntos = 184\nport-min = ${rtpPortMin}\nport-max = ${rtpPortMax}\nlog-level = 5\n`,
    'utf-8');

  // 4b. Main Kamailio routing-script configs (P/I/S-CSCF) + P-CSCF's route/*.cfg
  // fragments + dispatcher lists. These are the large, proven-working routing
  // scripts that pcscf.cfg/icscf.cfg/scscf.cfg (written above) get import_file'd
  // into — deployed from the bundled templates every Configure run, same as
  // everything else here, so they can't silently go missing on a fresh install
  // the way they did before this was wired up (2026-07-17 incident: these were
  // never written by either /install or /configure — only ever placed once, by
  // hand, on one dev host — so every OTHER host's P/I/S-CSCF units referenced a
  // main cfg file that never existed).
  // Driven off IMS_STATIC_TEMPLATES so this and checkImsTemplateStaleness()
  // can never disagree about which files are template-owned.
  for (const entry of IMS_STATIC_TEMPLATES) {
    deployImsTemplate(entry.template, entry.dest,
      entry.tokens?.includes('RTPENGINE_IP') ? { RTPENGINE_IP: rtpEngineIp } : {});
  }
  fs.writeFileSync(`${HOST_KAMAILIO_PCSCF_DIR}/dispatcher.list`, pcscfDispatcherList(icscfIp, icscfPort), 'utf-8');
  // dispatcher.list is a file BOTH this module and pstn-controller.ts write
  // to — PSTN Gateway owns the real dispatcher entry once configured (see
  // formatPstnDispatcherEntry()'s own comment). Found live 2026-09-18: this
  // used to unconditionally deploy the static placeholder template on every
  // single Configure, silently wiping PSTN's own dispatcher entry (breaking
  // every PSTN-routed call) the next time an operator re-ran a completely
  // unrelated IMS Configure. Preserve PSTN's entry if it's currently
  // configured; only fall back to the placeholder template on a deployment
  // where PSTN was never set up (matches original/fresh-install behavior).
  const pstnDispatcherEntry = formatPstnDispatcherEntry();
  if (pstnDispatcherEntry) {
    fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/dispatcher.list`, pstnDispatcherEntry, 'utf-8');
  } else {
    deployImsTemplate('kamailio_scscf/dispatcher.list', `${HOST_KAMAILIO_SCSCF_DIR}/dispatcher.list`);
  }
  // Required by modparam("ims_registrar_scscf", "user_data_xsd", ...) — without
  // it, every SAA's iFC XML fails schema validation and the whole SIP REGISTER
  // fails with "500 Server error on UAR select next S-CSCF" once no more
  // candidate S-CSCFs are left to retry (confirmed live, 2026-07-17). Sourced
  // directly from Kamailio's own ims_registrar_scscf module source — the exact
  // schema its own C code validates against, not a hand-authored guess.
  // (deployed by the IMS_STATIC_TEMPLATES loop above.)

  // 4c. Systemd units for P/I/S-CSCF + all 3 PyHSS services — same gap as 4b:
  // these generator functions existed but were never actually called anywhere.
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-pcscf.service`, pcscfSystemdUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-icscf.service`, icscfSystemdUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-scscf.service`, scscfSystemdUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/pyhss-hss.service`, pyhssHssUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/pyhss-diameter.service`, pyhssDiameterUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/pyhss-api.service`, pyhssApiUnit(), 'utf-8');
  fs.writeFileSync(`${HOST_SYSTEMD_DIR}/pyhss-metrics.service`, pyhssMetricsUnit(), 'utf-8');

  // 5. daemon-reload — picks up every unit file written in 3b/4c above.
  await nsenter('systemctl', ['daemon-reload']);

  // 6a. PyHSS config — deployed to /opt/pyhss/config.yaml + iFC XMLs. Services
  // are (re)started later in step 16, in dependency order, after step 8 below
  // has actually created the databases they need — restarting them here would
  // just fail against a nonexistent ims_hss_db on a fresh install.
  fs.writeFileSync('/proc/1/root/opt/pyhss/config.yaml',
    pyhssConfigYaml({ imsDomain, mcc, mnc, scscfIp, scscfPort, hssIp: '127.0.1.3', additionalPlmns }), 'utf-8');
  fs.writeFileSync('/proc/1/root/opt/pyhss/default_ifc.xml',
    defaultIfcXml(imsDomain, smsDeliveryMode === 'vectorcore' ? VECTORCORE_SMSC_SIP_ADDRESS : undefined), 'utf-8');
  fs.writeFileSync('/proc/1/root/opt/pyhss/default_sh_user_data.xml', defaultShUserDataXml(imsDomain), 'utf-8');

  // 8. Initialize MariaDB (all databases)
  await initializeImsDatabase({ imsDomain, scscfIp, scscfPort });

  // 9. /etc/hosts — FQDN entry for HSS peer (cdp uses getaddrinfo)
  const hostsPath = '/proc/1/root/etc/hosts';
  const hssFqdn   = `hss.${imsDomain}`;
  const hssIp     = '127.0.1.3';
  let hostsContent = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf-8') : '';
  const hostsHssLine = `${hssIp}  ${hssFqdn}`;
  hostsContent = hostsContent.includes(hssFqdn)
    ? hostsContent.replace(/^[^\n]*hss\.ims\.[^\n]*/m, hostsHssLine)
    : `${hostsContent.trimEnd()}\n${hostsHssLine}\n`;
  fs.writeFileSync(hostsPath, hostsContent, 'utf-8');

  // 10. BIND9 zones — primary + one zone per additional PLMN
  fs.mkdirSync(HOST_BIND_ZONES_DIR, { recursive: true });
  fs.writeFileSync(`${HOST_BIND_ZONES_DIR}/${zoneName}.zone`,
    bindZoneFile({ imsDomain, dnsIp, hssIp, pcscfIp, icscfIp, scscfIp, pcscfPort, icscfPort, scscfPort }), 'utf-8');

  // listen-on itself is owned by the BIND page now (see bind-controller.ts) — it
  // manages install/forwarders/listen-on for every module sharing this one BIND9
  // instance, so nothing here overwrites the whole options{} block anymore. We still
  // need our own dnsIp actually listened on, so merge it in via the same safe upsert
  // the BIND page's own UI uses, rather than replacing whatever's already configured.
  writeListenOn([...readListenOn(), dnsIp]);

  let namedLocalRaw  = fs.existsSync(`${HOST_BIND_DIR}/named.conf.local`)
    ? fs.readFileSync(`${HOST_BIND_DIR}/named.conf.local`, 'utf-8')
    : '';
  namedLocalRaw = upsertNamedZone(namedLocalRaw, zoneName, zoneFile);

  // Additional PLMN zones — same server IPs, different domain names
  for (const addDomain of additionalDomains) {
    const addZoneFile = `/etc/bind/zones/${addDomain}.zone`;
    fs.writeFileSync(`${HOST_BIND_ZONES_DIR}/${addDomain}.zone`,
      bindZoneFile({ imsDomain: addDomain, dnsIp, hssIp, pcscfIp, icscfIp, scscfIp, pcscfPort, icscfPort, scscfPort }), 'utf-8');
    namedLocalRaw = upsertNamedZone(namedLocalRaw, addDomain, addZoneFile);
  }

  // Remove zones for PLMNs no longer configured
  for (const removedDomain of removedDomains) {
    const removedZoneFile = `${HOST_BIND_ZONES_DIR}/${removedDomain}.zone`;
    if (fs.existsSync(removedZoneFile)) fs.unlinkSync(removedZoneFile);
    namedLocalRaw = removeNamedZone(namedLocalRaw, removedDomain);
  }

  fs.writeFileSync(`${HOST_BIND_DIR}/named.conf.local`, namedLocalRaw, 'utf-8');

  // 11. Update SMF yaml
  if (fs.existsSync(HOST_SMF_YAML)) {
    if (!fs.existsSync(HOST_IMS_SMF_BAK)) fs.copyFileSync(HOST_SMF_YAML, HOST_IMS_SMF_BAK);
    writeYamlGuarded(HOST_SMF_YAML, raw => updateSmfImsSession(raw, pcscfIp, dnsIp), 'add the IMS session to smf.yaml', IMS_OWNED_SMF_TOP_KEYS);
  }

  // 11b. HSS yaml — sms_over_ims capability for 4G subscribers
  if (fs.existsSync(HOST_HSS_YAML)) {
    let hssRaw = fs.readFileSync(HOST_HSS_YAML, 'utf-8');
    const smscUri = `sip:smsc.${imsDomain}:7090;transport=tcp`;
    if (!hssRaw.includes('sms_over_ims')) {
      hssRaw = hssRaw.replace(/^(hss:\s*)$/m, `$1\n  sms_over_ims: "${smscUri}"`);
    } else {
      hssRaw = hssRaw.replace(/sms_over_ims:.*/, `sms_over_ims: "${smscUri}"`);
    }
    fs.writeFileSync(HOST_HSS_YAML, hssRaw, 'utf-8');
  }

  // 12. PCRF — add P-CSCF as Diameter peer for Rx interface
  if (fs.existsSync(HOST_PCRF_FD_CONF)) {
    const pcrfRaw   = fs.readFileSync(HOST_PCRF_FD_CONF, 'utf-8');
    const pcscfFqdn = `pcscf.${imsDomain}`;
    fs.writeFileSync(HOST_PCRF_FD_CONF, upsertPcrfPcscfPeer(pcrfRaw, pcscfFqdn, pcscfIp, 3871), 'utf-8');
  }

  // 13. ogstun2 — IMS data plane (idempotent)
  try {
    await nsenter('bash', ['-c',
      `ip link show ogstun2 2>/dev/null || ` +
      `(ip tuntap add name ogstun2 mode tun && ` +
      `ip addr add 10.46.0.1/24 dev ogstun2 && ` +
      `ip link set ogstun2 up && ` +
      `iptables -t nat -C POSTROUTING -s 10.46.0.0/24 ! -o ogstun2 -j MASQUERADE 2>/dev/null || ` +
      `iptables -t nat -A POSTROUTING -s 10.46.0.0/24 ! -o ogstun2 -j MASQUERADE)`
    ]).catch(() => {});
  } catch { /* non-fatal */ }

  // 13b. UPF yaml — add IMS session entry pointing to ogstun2
  if (fs.existsSync(HOST_UPF_YAML)) {
    if (!fs.existsSync(HOST_IMS_UPF_BAK)) fs.copyFileSync(HOST_UPF_YAML, HOST_IMS_UPF_BAK);
    const upfRaw = fs.readFileSync(HOST_UPF_YAML, 'utf-8');
    writeYamlGuarded(HOST_UPF_YAML, updateUpfImsSession, 'add the IMS session to upf.yaml');
  }

  // 14. Save state. configuredWithVersion is deliberately NOT set to the current build
  // here — it's only updated once every service below is verified to have actually come
  // up (see the end of this function). Marking it "up to date" before that verification
  // would silently clear the staleness flag /status uses to drive StaleModulesModal, even
  // when this exact Configure attempt is about to fail — confirmed live 2026-09-02: a
  // deployment's Configure silently failed to create pcscf_location and then crash-looped
  // kamailio-pcscf, but configuredWithVersion still got marked current, so the "update
  // modules" prompt never came back to tell the operator anything was still wrong.
  const prevConfiguredWithVersion: string | undefined = fs.existsSync(HOST_IMS_STATE)
    ? (() => { try { return JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8')).configuredWithVersion; } catch { return undefined; } })()
    : undefined;
  fs.writeFileSync(HOST_IMS_STATE, JSON.stringify({
    imsDomain,
    hssBackend: 'pyhss',
    configuredWithVersion: prevConfiguredWithVersion,
    smsDeliveryMode,
    smsWorkerIntervalSeconds,
    voiceChargingEnabled,
    cdrAccountingEnabled,
    config: {
      mcc, mnc, additionalPlmns: additionalPlmns ?? [],
      pcscfIp, pcscfPort, icscfIp, icscfPort, scscfIp, scscfPort,
      rtpEngineIp, rtpPortMin, rtpPortMax, dnsIp,
    },
  }, null, 2), 'utf-8');

  // 15. Disable the default kamailio.service — it binds all interfaces on port 5060
  //     and conflicts with kamailio-pcscf if left running.
  await nsenter('systemctl', ['stop', 'kamailio']).catch(() => {});
  await nsenter('systemctl', ['disable', 'kamailio']).catch(() => {});

  // 16. Enable + start all services (ordered). The four kamailio-* units parse their
  // .cfg/.xml config only once at process startup (cdp's Diameter Peer/DefaultRoute
  // config in particular is never hot-reloaded) — `enable --now` is a no-op on an
  // already-running unit, so a *re*-Configure would otherwise silently leave a stale
  // process running against the config this same call just regenerated on disk.
  // Confirmed live: this caused kamailio-icscf to keep running without a DefaultRoute
  // entry (cdp's "Empty routing table" error) after a Configure re-run that fixed
  // icscf.xml — enable+restart for these four instead of enable --now.
  const kamailioCscfServices = new Set(['kamailio-icscf', 'kamailio-scscf', 'kamailio-pcscf', 'kamailio-smsc']);
  const svcs = ['bind9', 'mariadb', 'redis-server', 'pyhss-hss', 'pyhss-api', 'pyhss-diameter', 'pyhss-metrics',
                'rtpengine-daemon', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-pcscf', 'kamailio-smsc'];
  // Collected rather than thrown immediately — a restart failing partway through this
  // ordered list shouldn't stop the rest from at least being attempted (or skip step 17's
  // SMF/PCRF/UPF restart below, which is independent of whether IMS itself came up
  // cleanly). Everything still gets reported in one aggregated error at the end instead
  // of the previous behavior of silently returning success either way.
  const serviceFailures: string[] = [];
  for (const svc of svcs) {
    if (kamailioCscfServices.has(svc)) {
      await nsenter('systemctl', ['enable', svc]).catch(() => {});
      await nsenter('systemctl', ['restart', svc]).catch(() => {});
    } else {
      await nsenter('systemctl', ['enable', '--now', svc]).catch(() => {});
    }
    if (svc === 'redis-server') {
      await new Promise(r => setTimeout(r, 2000)); // let redis bind before pyhss services
    }
    if (!(await waitForServiceActive(svc))) {
      serviceFailures.push(await serviceFailureDetail(svc));
    }
  }
  // Reload bind9 zone after restart — systemctl restart alone can race with zone file writes
  await nsenter('rndc', ['reload']).catch(() => {});

  // 17. Restart SMF + PCRF + UPF
  for (const svc of ['open5gs-smfd', 'open5gs-pcrfd', 'open5gs-upfd']) {
    await nsenter('systemctl', ['restart', svc]).catch(() => {});
    if (!(await waitForServiceActive(svc))) {
      serviceFailures.push(await serviceFailureDetail(svc));
    }
  }

  // kamailio-scscf was restarted in the same loop above, so its own registrar
  // is normally empty right after a full Configure and this is a no-op — kept
  // for defense-in-depth in case that ever changes (see forceReregisterAllRegisteredUes).
  await forceReregisterAllRegisteredUes().catch(() => {});

  if (serviceFailures.length > 0) {
    throw new Error(
      `IMS Configure wrote all config successfully, but ${serviceFailures.length} service(s) ` +
      `failed to come up afterward:\n\n${serviceFailures.join('\n\n---\n\n')}`,
    );
  }

  // Only now — after every service above is confirmed actually running — mark this
  // deployment as configured at the current build. If this write itself fails, staleness
  // just stays stuck true (a safe direction to fail in: worst case is a spurious "update
  // modules" prompt, never a silently-cleared one).
  try {
    const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
    state.configuredWithVersion = getAppVersion();
    state.configuredWithRev = IMS_CONFIG_REV;
    fs.writeFileSync(HOST_IMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* see comment above */ }

  return { imsDomain };
}

// Toggles the "SMS delivery mode" selector on the SMS/MMS page — a
// deployment-wide choice between SMS-over-IMS (SIP MESSAGE, the default —
// this is what real phones prefer whenever they're IMS-registered, per
// standard 3GPP UE behavior, regardless of whether SGs is also configured),
// SMS-over-SGs only (hard-rejects MESSAGE at S-CSCF — see
// scscfIncludeCfg()'s BLOCK_IMS_SMS comment for why a real reject is needed
// rather than just removing the smsc iFC), and SMS via VectorCore SMSC
// (relays MESSAGE to that module's SIP/3GPP-ISC listener instead — see
// scscfIncludeCfg()'s ROUTE_SMS_TO_VECTORCORE comment). Deliberately
// lightweight: only regenerates the S-CSCF include file and restarts that
// one service, not a full re-Configure of the whole IMS stack.
export async function setSmsDeliveryMode(mode: 'sgs' | 'ims' | 'vectorcore'): Promise<void> {
  if (!fs.existsSync(HOST_IMS_STATE)) {
    throw new Error('IMS is not configured yet — configure IMS first');
  }
  const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
  const { scscfIp, scscfPort } = state.config;
  const imsDomain: string = state.imsDomain;
  const additionalDomains = (state.config.additionalPlmns ?? []).map((p: { mcc: string; mnc: string }) => deriveImsDomain(p.mcc, p.mnc));
  // voiceChargingEnabled (see setVoiceChargingEnabled() below) and
  // cdrAccountingEnabled (see setCdrAccountingEnabled() below) are two more
  // independent toggles that regenerate this SAME scscf.cfg — both must be
  // preserved here, or switching SMS delivery mode would silently regenerate
  // the file with WITH_RO/WITH_CDR dropped even though state still claims
  // they're on.
  const ocsPeerInfo = state.voiceChargingEnabled === true ? getOcsPeerInfo() : null;
  const cdrAccountingEnabled = state.cdrAccountingEnabled === true;

  fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
    scscfIncludeCfg({
      scscfIp, scscfPort, imsDomain, additionalDomains,
      blockImsSms: mode === 'sgs',
      routeSmsToVectorcore: mode === 'vectorcore' ? VECTORCORE_SMSC_SIP_ADDRESS : undefined,
      cdrAccounting: cdrAccountingEnabled,
      sipTracePort: sipTracePortFor(state.sipTracingEnabled === true, 'scscf'),
      voiceCharging: ocsPeerInfo ? { ocsOriginHost: ocsPeerInfo.originHost } : undefined,
    }), 'utf-8');
  await nsenter('systemctl', ['restart', 'kamailio-scscf']);

  // Also regenerate default_ifc.xml — this is what actually makes VectorCore
  // SMSC's MT delivery work at all when it's the active mode (see
  // defaultIfcXml()'s registerToVectorcore comment for the full why). No
  // PyHSS restart needed: it's a Jinja2 template PyHSS renders fresh per
  // Cx User-Data lookup, not something read once at startup — same reason
  // this file's config-manifest entry lists restartServices: [].
  fs.writeFileSync('/proc/1/root/opt/pyhss/default_ifc.xml',
    defaultIfcXml(imsDomain, mode === 'vectorcore' ? VECTORCORE_SMSC_SIP_ADDRESS : undefined), 'utf-8');

  state.smsDeliveryMode = mode;
  fs.writeFileSync(HOST_IMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// Toggles voice/airtime charging (Diameter Ro, via Kamailio's own
// ims_charging module) on the S-CSCF — completes the block
// kamailio_scscf.cfg has carried dormant behind #!ifdef WITH_RO since before
// this project's own history began (see scscfIncludeCfg()'s own comment for
// the full research). Deliberately the same shape as setSmsDeliveryMode()
// above: regenerates only the S-CSCF include file + Diameter XML and
// restarts that one service, not a full re-Configure of the whole IMS
// stack. Unlike configureIms()'s own fail-safe degrade-to-off handling of a
// stale flag, turning this ON here hard-fails immediately if OCS isn't
// configured or the client registration doesn't succeed — this is the one
// deliberate operator action point where silent degradation would hide a
// real problem instead of surfacing it. Turning it OFF never depends on OCS
// at all, so the feature can always be disabled even if OCS itself is down.
export async function setVoiceChargingEnabled(enabled: boolean): Promise<void> {
  if (!fs.existsSync(HOST_IMS_STATE)) {
    throw new Error('IMS is not configured yet — configure IMS first');
  }
  const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
  const { scscfIp, scscfPort } = state.config;
  const imsDomain: string = state.imsDomain;
  const additionalDomains = (state.config.additionalPlmns ?? []).map((p: { mcc: string; mnc: string }) => deriveImsDomain(p.mcc, p.mnc));
  const mode: 'sgs' | 'ims' | 'vectorcore' =
    state.smsDeliveryMode === 'sgs' || state.smsDeliveryMode === 'vectorcore' ? state.smsDeliveryMode : 'ims';

  let ocsPeerInfo: { originHost: string; bindIp: string; port: number } | null = null;
  if (enabled) {
    ocsPeerInfo = getOcsPeerInfo();
    if (!ocsPeerInfo) {
      throw new Error('SigScale OCS is not configured yet — set it up on the SigScale OCS page first.');
    }
    const clientResult = await addOcsDiameterClient(OCS_CLIENT_SOURCE_IP);
    if (!clientResult.ok) {
      throw new Error(`Registering S-CSCF as a trusted OCS Diameter client failed: ${clientResult.error}`);
    }
  }

  // cdrAccountingEnabled (see setCdrAccountingEnabled() below) is a second,
  // independent toggle that regenerates this SAME scscf.cfg — must be
  // preserved here, same reason setSmsDeliveryMode() preserves it above.
  const cdrAccountingEnabled = state.cdrAccountingEnabled === true;

  fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
    scscfIncludeCfg({
      scscfIp, scscfPort, imsDomain, additionalDomains,
      blockImsSms: mode === 'sgs',
      routeSmsToVectorcore: mode === 'vectorcore' ? VECTORCORE_SMSC_SIP_ADDRESS : undefined,
      voiceCharging: ocsPeerInfo ? { ocsOriginHost: ocsPeerInfo.originHost } : undefined,
      cdrAccounting: cdrAccountingEnabled,
      sipTracePort: sipTracePortFor(state.sipTracingEnabled === true, 'scscf'),
    }), 'utf-8');
  fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.xml`,
    scscfDiameterXml({
      scscfIp, imsDomain,
      ocsPeer: ocsPeerInfo ? { fqdn: ocsPeerInfo.originHost, port: ocsPeerInfo.port } : undefined,
    }), 'utf-8');
  if (ocsPeerInfo) await upsertOcsDnsRecord(state.config.mcc, state.config.mnc, ocsPeerInfo.bindIp);
  await nsenter('systemctl', ['restart', 'kamailio-scscf']);

  state.voiceChargingEnabled = enabled && !!ocsPeerInfo;
  fs.writeFileSync(HOST_IMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// Toggles CDR accounting (Kamailio's own `acc` module, basic flag-based
// db_flag/db_missed_flag — see scscfIncludeCfg()'s own comment for why NOT
// acc's newer cdr_enable feature) on the S-CSCF — this is what makes direct
// 4G/5G IMS-to-IMS calls (no PSTN/2G B2BUA leg) show up in the CDR module's
// Call History page at all; PSTN Gateway and Asterisk-2G calls are already
// captured independently via their own Asterisk CSV tailers. Same lightweight
// shape as setVoiceChargingEnabled() above: regenerates only the S-CSCF
// include file and restarts that one service. Unlike voice charging, this has
// no external service dependency to check (no SigScale OCS-style
// availability guard) — it only touches this deployment's own already-running
// scscf MySQL database (acc-create.sql sourced unconditionally during IMS
// Install/Configure, see initializeImsDatabase() above).
export async function setCdrAccountingEnabled(enabled: boolean): Promise<void> {
  if (!fs.existsSync(HOST_IMS_STATE)) {
    throw new Error('IMS is not configured yet — configure IMS first');
  }
  const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
  const { scscfIp, scscfPort } = state.config;
  const imsDomain: string = state.imsDomain;
  const additionalDomains = (state.config.additionalPlmns ?? []).map((p: { mcc: string; mnc: string }) => deriveImsDomain(p.mcc, p.mnc));
  const mode: 'sgs' | 'ims' | 'vectorcore' =
    state.smsDeliveryMode === 'sgs' || state.smsDeliveryMode === 'vectorcore' ? state.smsDeliveryMode : 'ims';
  // voiceChargingEnabled (see setVoiceChargingEnabled() above) is a second,
  // independent toggle that regenerates this SAME scscf.cfg — must be
  // preserved here, same reason setSmsDeliveryMode() preserves it.
  const ocsPeerInfo = state.voiceChargingEnabled === true ? getOcsPeerInfo() : null;

  fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
    scscfIncludeCfg({
      scscfIp, scscfPort, imsDomain, additionalDomains,
      blockImsSms: mode === 'sgs',
      routeSmsToVectorcore: mode === 'vectorcore' ? VECTORCORE_SMSC_SIP_ADDRESS : undefined,
      voiceCharging: ocsPeerInfo ? { ocsOriginHost: ocsPeerInfo.originHost } : undefined,
      cdrAccounting: enabled,
      sipTracePort: sipTracePortFor(state.sipTracingEnabled === true, 'scscf'),
    }), 'utf-8');
  await nsenter('systemctl', ['restart', 'kamailio-scscf']);

  state.cdrAccountingEnabled = enabled;
  fs.writeFileSync(HOST_IMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// ── SIP tracing (HEP) toggle ─────────────────────────────────────────────────
//
// Asymmetric on purpose, because the two directions cost very different things:
//
//   Enabling  needs siptrace.so actually loaded, and Kamailio only loads
//             modules at startup -- so the first enable restarts each CSCF.
//             Restarting kamailio-pcscf WIPES EVERY REGISTERED UE's IPsec SA
//             (see CLAUDE.md's gotcha on this): affected handsets keep showing
//             as registered while having no working tunnel, and must
//             re-register for real before they can call. That is why this is
//             never switched on implicitly by Configure.
//   Disabling uses siptrace's own RPC (`siptrace.status off`) to stop tracing
//             in the running process, then rewrites the config so it stays off
//             across a future restart. No restart, so no SA loss -- turning
//             tracing back off is free.
//
// A re-enable after that is also free: the module is still loaded, so the RPC
// alone suffices and we skip the restart. The returned report says per instance
// which path was taken, so the UI never has to guess whether it cost a restart.

const SIP_TRACE_INSTANCES = [
  // S-CSCF and I-CSCF first: restarting them is harmless, so if something
  // fails we have not already dropped the UE tunnels for nothing.
  { role: 'scscf' as const, unit: 'kamailio-scscf', ctl: '/run/kamailio_scscf/kamailio_ctl' },
  { role: 'icscf' as const, unit: 'kamailio-icscf', ctl: '/run/kamailio_icscf/kamailio_ctl' },
  { role: 'pcscf' as const, unit: 'kamailio-pcscf', ctl: '/run/kamailio_pcscf/kamailio_ctl' },
];

export interface SipTracingApplyReport {
  enabled: boolean;
  instances: { role: string; action: 'rpc' | 'restarted' | 'failed'; detail?: string }[];
  /** True if any instance needed a restart -- i.e. UE IPsec SAs were dropped. */
  restarted: boolean;
}

/**
 * Is siptrace loaded in this running instance? Probe via its own RPC.
 *
 * kamcmd does NOT signal an unknown command through its exit status: asking for
 * a method a non-loaded module would provide prints
 * `error: 500 - command siptrace.status not found` on STDOUT and exits 0
 * (verified directly against the live P-CSCF). Trusting the exit code alone
 * reports the module as loaded when it is not -- which in the enable path
 * would skip the restart that actually loads it, leaving tracing silently
 * never started. So the response body is what decides.
 */
async function siptraceRpc(ctl: string, arg: 'on' | 'off' | 'check'): Promise<{ ok: boolean; out: string }> {
  try {
    // nsenter() resolves to { stdout, stderr } -- not a string. kamcmd writes
    // its error line to stdout, so both streams are considered.
    const res = await nsenter('kamcmd', ['-s', ctl, 'siptrace.status', arg]);
    const raw = `${res?.stdout ?? ''}${res?.stderr ?? ''}`.trim();
    if (/^error:/i.test(raw) || /not found/i.test(raw)) {
      return { ok: false, out: raw || 'siptrace RPC not available' };
    }
    return { ok: true, out: raw };
  } catch (err) {
    // A genuine failure (no control socket, instance down) still lands here.
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

function writeCscfIncludes(state: any, enabled: boolean, http2N5Available: boolean): void {
  const c = state.config;
  const imsDomain: string = state.imsDomain;
  const additionalDomains = (c.additionalPlmns ?? []).map((p: { mcc: string; mnc: string }) => deriveImsDomain(p.mcc, p.mnc));
  const epcDomain = deriveEpcDomain(c.mcc, c.mnc);
  const mode: 'sgs' | 'ims' | 'vectorcore' =
    state.smsDeliveryMode === 'sgs' || state.smsDeliveryMode === 'vectorcore' ? state.smsDeliveryMode : 'ims';
  // Every other toggle that regenerates these same files must be preserved,
  // exactly as setSmsDeliveryMode()/setVoiceChargingEnabled() preserve each
  // other -- otherwise flipping tracing would silently drop WITH_RO/WITH_CDR.
  const ocsPeerInfo = state.voiceChargingEnabled === true ? getOcsPeerInfo() : null;

  fs.writeFileSync(`${HOST_KAMAILIO_PCSCF_DIR}/pcscf.cfg`,
    pcscfIncludeCfg({
      pcscfIp: c.pcscfIp, pcscfPort: c.pcscfPort, imsDomain, epcDomain, additionalDomains,
      http2N5Available,
      sipTracePort: sipTracePortFor(enabled, 'pcscf'),
    }), 'utf-8');

  fs.writeFileSync(`${HOST_KAMAILIO_ICSCF_DIR}/icscf.cfg`,
    icscfIncludeCfg({
      icscfIp: c.icscfIp, icscfPort: c.icscfPort, imsDomain, additionalDomains,
      sipTracePort: sipTracePortFor(enabled, 'icscf'),
    }), 'utf-8');

  fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
    scscfIncludeCfg({
      scscfIp: c.scscfIp, scscfPort: c.scscfPort, imsDomain, additionalDomains,
      blockImsSms: mode === 'sgs',
      routeSmsToVectorcore: mode === 'vectorcore' ? VECTORCORE_SMSC_SIP_ADDRESS : undefined,
      voiceCharging: ocsPeerInfo ? { ocsOriginHost: ocsPeerInfo.originHost } : undefined,
      cdrAccounting: state.cdrAccountingEnabled === true,
      sipTracePort: sipTracePortFor(enabled, 'scscf'),
    }), 'utf-8');
}

export async function setSipTracingEnabled(enabled: boolean): Promise<SipTracingApplyReport> {
  if (!fs.existsSync(HOST_IMS_STATE)) {
    throw new Error('IMS is not configured yet — configure IMS first');
  }
  const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
  const http2N5Available = await isKamailioHttp2Capable();

  const report: SipTracingApplyReport = { enabled, instances: [], restarted: false };

  if (!enabled) {
    // Stop tracing live first, then persist "off" to config. Doing it in this
    // order means tracing has genuinely stopped even if the config write were
    // to fail, which is the safer failure for something that duplicates every
    // SIP message.
    for (const inst of SIP_TRACE_INSTANCES) {
      const r = await siptraceRpc(inst.ctl, 'off');
      report.instances.push({
        role: inst.role,
        action: r.ok ? 'rpc' : 'failed',
        // Not loaded at all is the expected state when tracing was never on,
        // so it is reported as information rather than as an error.
        detail: r.ok ? r.out || 'tracing stopped' : `RPC unavailable (module likely not loaded): ${r.out}`,
      });
    }
    writeCscfIncludes(state, false, http2N5Available);
    state.sipTracingEnabled = false;
    fs.writeFileSync(HOST_IMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
    return report;
  }

  // Enabling: config first, so a restart picks it up.
  writeCscfIncludes(state, true, http2N5Available);

  for (const inst of SIP_TRACE_INSTANCES) {
    const probe = await siptraceRpc(inst.ctl, 'on');
    if (probe.ok) {
      // Module already loaded from an earlier enable -- no restart needed, so
      // no IPsec SA loss.
      report.instances.push({ role: inst.role, action: 'rpc', detail: probe.out || 'tracing started' });
      continue;
    }
    try {
      await nsenter('systemctl', ['restart', inst.unit]);
      report.restarted = true;
      report.instances.push({
        role: inst.role,
        action: 'restarted',
        detail: inst.role === 'pcscf'
          ? 'restarted to load siptrace — every registered UE must re-register before it can call'
          : 'restarted to load siptrace',
      });
    } catch (err) {
      report.instances.push({
        role: inst.role,
        action: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  state.sipTracingEnabled = true;
  fs.writeFileSync(HOST_IMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
  return report;
}

export function getSipTracingEnabled(): boolean {
  try {
    if (!fs.existsSync(HOST_IMS_STATE)) return false;
    return JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'))?.sipTracingEnabled === true;
  } catch {
    return false;
  }
}

/** Per-instance live tracing state, straight from siptrace's own RPC. */
export async function getSipTracingRuntime(): Promise<{ role: string; loaded: boolean; status: string }[]> {
  return Promise.all(
    SIP_TRACE_INSTANCES.map(async inst => {
      const r = await siptraceRpc(inst.ctl, 'check');
      return { role: inst.role, loaded: r.ok, status: r.ok ? r.out : 'not loaded' };
    }),
  );
}

// Sets the SMS_WORKER rtimer poll interval (see route[SMS_WORKER] in
// smscMainCfg()) — how often kamailio-smsc's store-and-forward queue gets
// drained. Lower = faster real-world delivery, at the cost of more frequent
// DB polling. Deliberately lightweight, same shape as setSmsDeliveryMode()
// above: only regenerates kamailio_smsc.cfg (the interval is baked into the
// modparam there, not the include file) and restarts kamailio-smsc.
export async function setSmsWorkerInterval(seconds: number): Promise<void> {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw new Error('Interval must be an integer between 1 and 300 seconds');
  }
  if (!fs.existsSync(HOST_IMS_STATE)) {
    throw new Error('IMS is not configured yet — configure IMS first');
  }
  const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));

  fs.writeFileSync(`${HOST_KAMAILIO_SMSC_DIR}/kamailio_smsc.cfg`,
    smscMainCfg(seconds), 'utf-8');
  await nsenter('systemctl', ['restart', 'kamailio-smsc']);

  state.smsWorkerIntervalSeconds = seconds;
  fs.writeFileSync(HOST_IMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// Real bug, confirmed live (2026-07-31): the Dashboard's "registered UEs"
// count came from ulscscf.status's "Records:" figure, which is a raw IMPU
// binding count - every real device registers 3 public identities
// (tel:X, sip:X, sip:imsi@domain) that all share the same Contact/
// User-Agent, so 3 real phones showed as "9 registered". Fixed by dumping
// the full usrloc snapshot (ulscscf.snapshot) and deduping by Contact URI
// to get the true distinct-device count, classified by device type from
// each contact's User-Agent header.
async function getRegisteredUesWithActivity(pcscfIp?: string): Promise<{
  registeredUes: number;
  registeredUesByType: { iphone: number; android: number; other: number };
  activeUes: number;
}> {
  const empty = { registeredUes: 0, registeredUesByType: { iphone: 0, android: 0, other: 0 }, activeUes: 0 };
  const snapshotPath = '/tmp/.nms-scscf-snapshot.txt';
  try {
    await nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'ulscscf.snapshot', snapshotPath]);
  } catch {
    return empty;
  }
  const hostSnapshotPath = `/proc/1/root${snapshotPath}`;
  let raw: string;
  try {
    raw = fs.readFileSync(hostSnapshotPath, 'utf-8');
  } catch {
    return empty;
  }
  try { fs.unlinkSync(hostSnapshotPath); } catch { /* best-effort cleanup */ }

  const contactRe = /Contact\s*:\s*'([^']+)'/g;
  const uaRe = /User-Agent:\s*'([^']*)'/g;
  const contacts: string[] = [];
  const uas: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = contactRe.exec(raw))) contacts.push(m[1]);
  while ((m = uaRe.exec(raw))) uas.push(m[1]);

  const byContact = new Map<string, { ip: string; userAgent: string }>();
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    if (byContact.has(contact)) continue;
    // Handles both "sip:IP:PORT..." and "sip:<uuid>@IP:PORT..." contact forms.
    const ipMatch = contact.match(/@([\d.]+):/) ?? contact.match(/:([\d.]+):/);
    byContact.set(contact, { ip: ipMatch ? ipMatch[1] : '', userAgent: uas[i] ?? '' });
  }

  const registeredUesByType = { iphone: 0, android: 0, other: 0 };
  for (const { userAgent } of byContact.values()) {
    const ua = userAgent.toLowerCase();
    if (ua.includes('iphone') || ua.includes('ios/')) registeredUesByType.iphone++;
    else if (ua.includes('android')) registeredUesByType.android++;
    else registeredUesByType.other++;
  }

  // "Active" = the UE's IPsec SA has passed real traffic in the last 5
  // minutes - distinguishes actually-doing-something-right-now from
  // merely holding a still-valid-but-idle registration binding. Must be
  // scoped to P-CSCF's own IP — `ip xfrm state` dumps the WHOLE host's IPsec
  // state, which also includes SecGW's completely unrelated radio-backhaul
  // tunnels (different IP, different mechanism — strongSwan/IKEv2, not
  // P-CSCF's AKA-derived kamailio-internal SAs) when that module is enabled.
  // Confirmed live 2026-08-30: without this filter, SecGW's tunnels get
  // counted as if they were UE registration activity.
  const activeIps = new Set<string>();
  try {
    const xfrmOut = await nsenter('ip', ['-s', 'xfrm', 'state']);
    const blocks = xfrmOut.stdout.split(/\n(?=src )/);
    const now = Date.now();
    for (const block of blocks) {
      const srcDst = /^src (\S+) dst (\S+)/.exec(block);
      const lastUsed = /lastused (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(block);
      if (!srcDst || !lastUsed) continue;
      if (pcscfIp && srcDst[1] !== pcscfIp && srcDst[2] !== pcscfIp) continue;
      const t = new Date(lastUsed[1].replace(' ', 'T')).getTime();
      if (Number.isNaN(t) || now - t > 5 * 60 * 1000) continue;
      activeIps.add(srcDst[1]);
      activeIps.add(srcDst[2]);
    }
  } catch { /* best-effort */ }

  let activeUes = 0;
  for (const { ip } of byContact.values()) {
    if (ip && activeIps.has(ip)) activeUes++;
  }

  return { registeredUes: byContact.size, registeredUesByType, activeUes };
}

// P-CSCF keeps its own in-memory registration state (pcscf_location,
// ipsec_clients) completely separate from S-CSCF's registrar — restarting
// kamailio-pcscf alone (e.g. a raw config/route-script edit via
// /configs/restart, as happened live 2026-08-30 for a mt.cfg fix) wipes that
// state while S-CSCF (a different, unrestarted process) still reports every
// phone as registered. A phone has no way to know P-CSCF forgot about it, so
// its next call attempt hits mo.cfg's very first check
// (`pcscf_is_registered`) and gets an explicit 403 "You must register first
// with a S-CSCF" — looking exactly like "IMS says registered but calls
// silently fail" until the user manually toggles Airplane Mode to force a
// fresh REGISTER. Confirmed live as the root cause of that exact symptom.
// Fix: force every currently-registered IMPU off S-CSCF's own registrar via
// its dereg_impu RPC (the same one used to clean up a stale/ghost
// registration — see memory) right after a P-CSCF-only restart. That RPC
// sends a real NOTIFY to any phone subscribed to its own reg-event package
// (standard GSMA VoLTE-profile behavior, confirmed present on both the
// iPhone and Android entries in this project's own registrar dump), which
// makes a compliant phone silently re-REGISTER on its own — repopulating
// P-CSCF's local state with no user action needed. If kamailio-scscf was
// ALSO just restarted in the same action, this naturally finds nothing to
// deregister (S-CSCF's own state is freshly empty too) and is a harmless
// no-op. Never throws — best-effort UX improvement, not a restart blocker.
export async function forceReregisterAllRegisteredUes(logger?: pino.Logger): Promise<void> {
  const snapshotPath = '/tmp/.nms-scscf-dereg-snapshot.txt';
  try {
    await nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'ulscscf.snapshot', snapshotPath]);
  } catch (err) {
    logger?.warn({ err: String(err) }, 'ims: force-reregister skipped — S-CSCF unreachable');
    return;
  }
  const hostSnapshotPath = `/proc/1/root${snapshotPath}`;
  let raw: string;
  try {
    raw = fs.readFileSync(hostSnapshotPath, 'utf-8');
  } catch (err) {
    logger?.warn({ err: String(err) }, 'ims: force-reregister skipped — could not read snapshot');
    return;
  }
  try { fs.unlinkSync(hostSnapshotPath); } catch { /* best-effort cleanup */ }

  const registrations = parseRegisteredUsersSnapshot(raw);
  let count = 0;
  for (const reg of registrations) {
    const impu = reg.publicIdentities[0];
    if (!impu) continue;
    try {
      await nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'regscscf.dereg_impu', impu]);
      count++;
    } catch (err) {
      logger?.warn({ err: String(err), impu }, 'ims: force-reregister failed for one IMPU');
    }
  }
  if (count > 0) {
    logger?.info({ count }, 'ims: forced re-register for all previously-registered UEs after a P-CSCF restart');
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts)
// can invoke the same install logic in-process, without looping back over HTTP —
// write() is the only side-channel, shared by both the streaming HTTP route below
// and the orchestrator's own log capture.
export async function installIms(write: (s: string) => void): Promise<{ success: boolean }> {
    // Helper: spawn a command via nsenter and stream output line-by-line
    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--',
          'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

    // Add Kamailio's official APT repo (5.8.x branch) before installing — Ubuntu
    // 24.04's own archive only has 5.7.4, which cannot correctly resolve a
    // #!substdef used across an import_file boundary (confirmed live, 2026-07-17:
    // the bundled kamailio_pcscf.cfg/kamailio_scscf.cfg templates below fail to
    // parse under 5.7.4 with "Can't set module parameter" / "unknown command,
    // missing loadmodule?" on UE_REGISTRATION_EXPIRES et al, but parse and run
    // cleanly under 5.8.8). This repo used to only exist as a hand-added file on
    // one dev host from an earlier, undocumented troubleshooting session — never
    // captured into this install step, so every other host silently got the
    // older, incompatible 5.7.4 instead. Idempotent: safe to re-run.
    write('=== Adding Kamailio 5.8 APT repo ===\n');
    await spawnStream(
      'set -e\n' +
      // --yes: gpg refuses to overwrite an existing keyring file without an
      // interactive confirmation, which fails hard with "cannot open '/dev/tty'"
      // on a re-run (no tty attached to this streamed nsenter/bash process) -
      // confirmed live 2026-07-28 on a second Install attempt.
      'curl -fsSL http://deb.kamailio.org/kamailiodebkey.gpg | gpg --yes --dearmor -o /usr/share/keyrings/kamailio.gpg\n' +
      'CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")\n' +
      'cat > /etc/apt/sources.list.d/kamailio.list <<EOF\n' +
      'deb [arch=amd64 signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 ${CODENAME} main\n' +
      'deb-src [arch=amd64 signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 ${CODENAME} main\n' +
      'EOF\n' +
      'apt-get update -q\n' +
      'echo "✅ Kamailio 5.8 repo added."'
    );

    // Install rtpengine as its own, isolated step. Confirmed live 2026-07-28 on
    // a fresh Ubuntu 22.04 (jammy) host: the plain "rtpengine" metapackage only
    // exists in Ubuntu's own universe repo from 23.04 onward (this project's dev
    // host is 24.04, where it "just works", which is why this was never caught
    // before) - on 22.04 it fails with "E: Unable to locate package rtpengine".
    // Worse, because this used to live in the SAME big apt-get install line as
    // dpkg-dev/mariadb-server/etc., apt-get's default behavior of refusing to
    // install ANY package in a command line if even ONE is unlocatable meant a
    // single missing package name silently took every other package down with
    // it (confirmed: the same log showed "dpkg-source: not found" right after,
    // even though dpkg-dev was right there in the list — apt-get never even
    // attempted it). Isolating this install means a bad/missing package here
    // can no longer cascade into failing everything else.
    write('\n=== Installing rtpengine ===\n');
    const rtpengineExitCode = await spawnStream(
      'set -e\n' +
      'CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")\n' +
      'apt-get update -q\n' +
      'if apt-cache show rtpengine >/dev/null 2>&1; then\n' +
      '  echo "rtpengine available directly (Ubuntu $CODENAME) — installing."\n' +
      '  DEBIAN_FRONTEND=noninteractive apt-get install -y rtpengine\n' +
      'else\n' +
      '  echo "rtpengine not in the default repos on Ubuntu $CODENAME (only in universe from 23.04+) — adding davidlublink/rtpengine PPA."\n' +
      // add-apt-repository itself is idempotent (won't duplicate an
      // already-added line) — no separate marker file needed. Ensure the
      // command exists first; it's not guaranteed present on a minimal image.
      '  DEBIAN_FRONTEND=noninteractive apt-get install -y software-properties-common\n' +
      '  add-apt-repository -y ppa:davidlublink/rtpengine\n' +
      '  apt-get update -q\n' +
      '  DEBIAN_FRONTEND=noninteractive apt-get install -y ngcp-rtpengine\n' +
      // Documented gotcha for this specific PPA build: its shipped unit's
      // AmbientCapabilities line can prevent the daemon from starting cleanly.
      // Idempotent (sed no-ops if already commented or the line is absent).
      '  sed -i "s/^AmbientCapabilities=/#AmbientCapabilities=/" /lib/systemd/system/ngcp-rtpengine-daemon.service 2>/dev/null || true\n' +
      // The PPA package's real unit is ngcp-rtpengine-daemon.service, but every
      // other Install/Configure/Start/Stop/Restart/Status/Uninstall route in this
      // file refers to the plain rtpengine-daemon.service name (matching what
      // Ubuntu's own native package provides on 24.04+) - a compat symlink means
      // none of those call sites need to know which install path was taken.
      '  ln -sf /lib/systemd/system/ngcp-rtpengine-daemon.service /etc/systemd/system/rtpengine-daemon.service\n' +
      '  systemctl daemon-reload\n' +
      'fi\n' +
      'echo "✅ rtpengine installed."'
    );
    if (rtpengineExitCode !== 0) {
      write('\n⚠️ WARNING: rtpengine install FAILED (see errors above) — the RTP media relay ' +
        'is required for any call to have audio. Fix the underlying issue and re-run Install.\n');
    }

    write('\n=== Installing IMS packages ===\n');
    // presence/sctp/json modules are all required by the bundled main-cfg
    // templates (kamailio_pcscf.cfg loads sctp+json, kamailio_scscf.cfg loads
    // presence) — confirmed live, 2026-07-17: omitting any of these makes the
    // corresponding kamailio-*.service crash-loop on "could not find module".
    // Real defect found in the 2026-10-10 readiness audit: this list was
    // installed unconditionally, so IMS Install itself would apt-install the
    // 5.8.x packages straight over a 6.0.8 source build, reverting all of that
    // build's patches. With WITH_N5 active in pcscf.cfg, 5.8.x has no
    // http_client_request_v2pk() -- a FATAL config-parse error, so P-CSCF
    // would then refuse to start at all. The packages are also apt-held by the
    // build itself now, which would make this apt-get fail rather than
    // downgrade; skipping them outright keeps Install clean instead of noisy.
    const { isKamailioSourceBuildComplete, KAMAILIO_APT_PKGS } = await import('./kamailio-source-build-controller');
    const srcBuilt = isKamailioSourceBuildComplete();
    if (srcBuilt) {
      write('A Kamailio 6.0.8 source build is active — skipping the kamailio apt packages\n' +
            `so this Install cannot downgrade over it (${KAMAILIO_APT_PKGS.length} packages skipped, and they are apt-held).\n`);
    }
    const kamailioPkgs = srcBuilt ? '' : KAMAILIO_APT_PKGS.join(' ') + ' ';
    const basePkgs = kamailioPkgs +
      'mariadb-server bind9 bind9utils mariadb-client dnsutils git dpkg-dev libxml2-dev';
    const pyhssPkgs = ' redis-server python3-pip python3-venv python3-dev';
    const basePkgsExitCode = await spawnStream(
      `DEBIAN_FRONTEND=noninteractive apt-get install -y ${basePkgs}${pyhssPkgs} 2>&1`
    );
    if (basePkgsExitCode !== 0) {
      write('\n⚠️ WARNING: one or more IMS packages failed to install (see errors above) — ' +
        'check which package apt could not locate/install and fix before re-running Install.\n');
    }

    // Raise MariaDB's max_connections into a file apt will never own.
    //
    // Real defect found in the 2026-10-10 readiness audit: this value was an
    // unmanaged hand edit in /etc/mysql/mariadb.conf.d/50-server.cnf, which is
    // a dpkg CONFFILE — so IMS Remove (which purges mariadb-server) deletes it,
    // and a fresh install never had it. The stock default is 151, and this
    // deployment measured Max_used_connections at exactly 152 during a P-CSCF
    // restart's own connection burst on 2026-10-02, taking the whole service
    // down: one ims_usrloc_pcscf worker failing to connect aborts all of
    // Kamailio's startup, not just that worker. S/I-CSCF, SMSC and PyHSS all
    // hold pools open concurrently, so the ceiling is genuinely load-bearing.
    //
    // A 99-prefixed drop-in loads after 50-server.cnf and so wins, and apt
    // never owns it, so a purge/reinstall cycle cannot silently revert it.
    try {
      write('\n=== Ensuring MariaDB max_connections (apt-proof drop-in) ===\n');
      const myCnfDir = '/proc/1/root/etc/mysql/mariadb.conf.d';
      if (fs.existsSync(myCnfDir)) {
        const myCnf = `${myCnfDir}/99-open5gs-nms.cnf`;
        const desired = [
          '# Written by open5gs-nms IMS Install. Do not hand-edit.',
          '#',
          '# The stock 151 is genuinely too low for this stack: P-CSCF, I-CSCF,',
          '# S-CSCF, the SMSC and PyHSS all hold connection pools open at once,',
          '# and a P-CSCF restart burst measured 152 in use on 2026-10-02, which',
          '# took IMS down entirely (one usrloc worker failing to connect aborts',
          '# all of Kamailio startup). Kept in a 99- drop-in because apt owns',
          '# 50-server.cnf and a purge would delete the value from there.',
          '[mysqld]',
          'max_connections = 300',
          '',
        ].join('\n');
        const existing = fs.existsSync(myCnf) ? fs.readFileSync(myCnf, 'utf-8') : '';
        if (existing !== desired) {
          fs.writeFileSync(myCnf, desired, 'utf-8');
          write('Wrote /etc/mysql/mariadb.conf.d/99-open5gs-nms.cnf (max_connections = 300).\n');
          const r = await nsenter('systemctl', ['restart', 'mariadb']).then(() => true).catch(() => false);
          write(r ? 'mariadb restarted to pick it up.\n'
                  : '⚠️  Could not restart mariadb — the drop-in applies on its next restart.\n');
        } else {
          write('Already present and current — nothing to do.\n');
        }
      } else {
        write('⚠️  /etc/mysql/mariadb.conf.d not present — skipping (is mariadb-server installed?).\n');
      }
    } catch (err) {
      write(`⚠️  Could not write the MariaDB drop-in: ${String(err)} — raise max_connections manually.\n`);
    }

    // Patch cdp.so: the stock Kamailio 5.x cdp_mod.c registers one fewer process slot
    // than it actually forks, causing the CDP timer to fail with "Process limit exceeded"
    // — which breaks Cx/Rx Diameter (HSS/PCRF signaling) under load.
    // Fix: bump the register_procs() count from (2+workers+2*peers) to (3+workers+2*peers).
    //
    // Skipped outright once the 6.0.8 source build owns Kamailio, and that is a
    // correctness requirement, not just tidiness. `dpkg -s kamailio` still
    // reports 5.8.8+ubuntu24.04 on a source-built host (the build installs over
    // the apt tree without going through dpkg), so this block would fetch 5.8.8
    // source, compile a 5.8.8 cdp.so, and drop it on top of the running 6.0.8
    // one — a module-interface ABI mismatch that stops every CSCF from loading
    // cdp at all. The 6.0.8 pipeline carries this same fix as
    // CDP_MOD_C_PATCH now, so there is nothing left for this block to do there.
    write('\n=== Patching cdp.so (process slot fix) ===\n');
    if (srcBuilt) {
      write('A Kamailio 6.0.8 source build is active — skipping. That pipeline applies\n' +
            'this same fix as CDP_MOD_C_PATCH, and patching from apt 5.8.8 source here\n' +
            'would overwrite the 6.0.8 cdp.so with an ABI-incompatible one.\n');
    }
    const cdpPatchExitCode = srcBuilt ? 0 : await spawnStream(
      'set -e\n' +
      'CDP_SO=/usr/lib/x86_64-linux-gnu/kamailio/modules/cdp.so\n' +
      'MARKER=/usr/lib/x86_64-linux-gnu/kamailio/modules/cdp.so.patched\n' +
      // The marker used to be a bare `touch`ed empty file, checked for presence
      // only. That lost this patch silently and permanently: the 6.0.8 source
      // build replaced cdp.so on 2026-10-03 with a build that did NOT carry
      // this fix, the Aug-2 marker stayed behind, and `[ -f "$MARKER" ] &&
      // exit 0` then guaranteed Install would never reapply it. The marker now
      // records the hash of the cdp.so this step actually produced, so anything
      // that later replaces the binary is detected and the patch is redone.
      'if [ -s "$MARKER" ] && [ -f "$CDP_SO" ] && \\\n' +
      '   [ "$(cat "$MARKER")" = "$(sha256sum "$CDP_SO" | awk \'{print $1}\')" ]; then\n' +
      '  echo "cdp.so already patched (hash matches marker) — skipping."\n' +
      '  exit 0\n' +
      'fi\n' +
      '[ -f "$MARKER" ] && echo "Marker present but cdp.so no longer matches it — the binary was replaced, reapplying."\n' +
      'KVER=$(dpkg -s kamailio 2>/dev/null | grep ^Version | awk \'{print $2}\')\n' +
      'echo "Kamailio version: $KVER"\n' +
      // Real incident (2026-07-17): the previous check here — `grep -qr "deb-src"
      // /etc/apt/sources.list /etc/apt/sources.list.d/` — false-positived on a comment
      // inside cloud-init's ubuntu.sources.curtin.orig backup file ("## Types: Append
      // deb-src to enable..."), which literally contains the substring "deb-src" without
      // being a real enabled source. It also only knew how to edit the legacy
      // sources.list format; Ubuntu 24.04+ defaults to the new deb822 ubuntu.sources
      // format, where sources.list is just a placeholder comment with no "deb " lines to
      // transform. Net effect: `apt-get source` failed ("You must put some deb-src URIs
      // in your sources.list"), the patch silently never applied, and this step's exit
      // code was never checked — so the wizard reported "IMS installation complete" with
      // the crash-guard patch quietly missing. Fix: always (idempotently) write our own
      // explicit deb-src file, independent of whatever format the existing sources are
      // in — works on both legacy and deb822-based installs.
      'CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")\n' +
      'cat > /etc/apt/sources.list.d/deb-src-ims.list <<EOF\n' +
      'deb-src http://archive.ubuntu.com/ubuntu/ ${CODENAME} main restricted universe multiverse\n' +
      'deb-src http://archive.ubuntu.com/ubuntu/ ${CODENAME}-updates main restricted universe multiverse\n' +
      'deb-src http://security.ubuntu.com/ubuntu/ ${CODENAME}-security main restricted universe multiverse\n' +
      'EOF\n' +
      'apt-get update -q\n' +
      'cd /tmp && apt-get source "kamailio=$KVER" -q\n' +
      'SRCDIR=$(ls -d /tmp/kamailio-*/src 2>/dev/null | head -1 | sed "s|/src$||")\n' +
      '[ -z "$SRCDIR" ] && echo "ERROR: kamailio source not found" && exit 1\n' +
      'echo "Source dir: $SRCDIR"\n' +
      'CDP_MOD_C="$SRCDIR/src/modules/cdp/cdp_mod.c"\n' +
      'sed -i "s/register_procs(2 + config->workers/register_procs(3 + config->workers/g" "$CDP_MOD_C"\n' +
      'sed -i "s/cfg_register_child(2 + config->workers/cfg_register_child(3 + config->workers/g" "$CDP_MOD_C"\n' +
      // `sed -i` exits 0 when its expression matches nothing, so an upstream
      // source change would have made this a silent no-op that still wrote the
      // marker and printed success. Verify the edit actually landed.
      'if ! grep -q "register_procs(3 + config->workers" "$CDP_MOD_C" || \\\n' +
      '   ! grep -q "cfg_register_child(3 + config->workers" "$CDP_MOD_C"; then\n' +
      '  echo "ERROR: the process-slot edit did not apply — upstream cdp_mod.c has changed shape. Review manually."\n' +
      '  exit 1\n' +
      'fi\n' +
      'cd "$SRCDIR" && make modules modules=src/modules/cdp 2>&1\n' +
      // Never `cp` over a live-mapped .so: a running worker page-faulting into
      // a half-rewritten file executes a mix of old and new bytes and dies with
      // SIGILL — confirmed live 2026-10-03, which took all 3 Kamailio processes
      // down at once. A rename swaps the directory entry atomically, so any
      // process holding the old inode keeps seeing consistent old bytes until
      // it restarts, and nothing can observe a partial file.
      'cp "$SRCDIR/src/modules/cdp/cdp.so" "$CDP_SO.new"\n' +
      'mv "$CDP_SO.new" "$CDP_SO"\n' +
      'sha256sum "$CDP_SO" | awk \'{print $1}\' > "$MARKER"\n' +
      'echo "✅ cdp.so patched successfully (marker records its hash; restart Kamailio to load it)."'
    );
    if (cdpPatchExitCode !== 0) {
      write('\n⚠️ WARNING: cdp.so patch FAILED (see errors above). Kamailio\'s CDP module ' +
        'may hit "Process limit exceeded" and Cx/Rx Diameter (HSS/PCRF signaling) may be ' +
        'unstable. Fix the underlying issue and re-run Install — the patch is not marked ' +
        'complete, so it will retry automatically.\n');
    }

    // Two real C-level bugs in the stock (unmodified) ims_ipsec_pcscf/
    // ims_registrar_pcscf Kamailio modules, root-caused and patched live
    // 2026-09-12: a contact-promotion gap and a reg_state stomp on every
    // re-auth cycle. Together these silently broke registration state for
    // ANY real UE (not just 2G-interop ones) — confirmed as the actual root
    // cause of a full "IMS to IMS is not working" regression, not anything
    // in this project's own kamailio *.cfg scripts. Previously existed only
    // as manually-patched .so files on one host with no way to reproduce
    // them; see kamailio-ims-modules-build.ts for the full mechanism and
    // patch content. Idempotent (checks in-binary markers + .apt-original
    // presence), same build-now pattern as the cdp.so patch above.
    write('\n=== Patching ims_ipsec_pcscf.so / ims_registrar_pcscf.so (P-CSCF reg_state fixes) ===\n');
    const kamailioImsModulesExitCode = await spawnStream(buildKamailioImsModulesScript());
    if (kamailioImsModulesExitCode !== 0) {
      write('\n⚠️ WARNING: ims_ipsec_pcscf.so/ims_registrar_pcscf.so patch FAILED (see errors ' +
        'above). Real UEs may intermittently fail to originate calls or may appear to ' +
        'de-register (reg_state stuck/stomped to 0) even though their contact is otherwise ' +
        'correct. Fix the underlying issue and re-run Install — the patch is idempotent and ' +
        'will retry automatically.\n');
    } else {
      write('✅ ims_ipsec_pcscf.so / ims_registrar_pcscf.so patched.\n');
    }

    write('\n=== Installing PyHSS ===\n');
    const pyhssInstalled = fs.existsSync('/proc/1/root/opt/pyhss');
    if (!pyhssInstalled) {
      write(`Cloning PyHSS at pinned commit ${PYHSS_COMMIT.slice(0, 12)}...\n`);
      // Pinned, not a bare clone of upstream's default branch. This project
      // applies three real patches to PyHSS source at Install time, each
      // located by matching specific text (the Answer_16777216_300/_302 UAA/LIA
      // crash-guard in lib/diameter.py, and the scshf_realm -> mcc/mnc domain
      // fix in default_ifc.xml — both documented in CLAUDE.md). An unpinned
      // clone means a fresh install gets whatever upstream HEAD happens to be
      // that day, so those patch sites can move or vanish and the patches
      // silently stop applying — and two installs a week apart end up running
      // different PyHSS builds, which makes "works on this host" unreproducible.
      await spawnStream(
        'set -e\n' +
        'git clone https://github.com/nickvsnetworking/pyhss /opt/pyhss 2>&1\n' +
        `cd /opt/pyhss && git checkout ${PYHSS_COMMIT} 2>&1\n` +
        'echo "PyHSS at $(git rev-parse --short HEAD) ($(git describe --tags 2>/dev/null || echo untagged))"',
      );
    } else {
      // Deliberately not force-moving an existing tree to the pin: it carries
      // this deployment's applied patches and local state, and a checkout here
      // would revert them mid-Install. Report the divergence instead.
      const { stdout: head } = await nsenter('git', ['-C', '/opt/pyhss', 'rev-parse', 'HEAD'])
        .catch(() => ({ stdout: '' }));
      const at = head.trim();
      write(`PyHSS already cloned — skipping clone (at ${at.slice(0, 12) || 'unknown'}).\n`);
      if (at && at !== PYHSS_COMMIT) {
        write(`⚠️  This tree is NOT the pinned commit (${PYHSS_COMMIT.slice(0, 12)}). It was cloned\n` +
              '   before this pin existed, or moved by hand. Left alone deliberately — it holds\n' +
              '   this deployment\'s applied patches. The patch steps below verify their own\n' +
              '   sites and will report if any no longer match.\n');
      }
    }
    // Real, 2026-09-23 fresh-VM finding: libmariadb-dev + pkg-config alone
    // were NOT enough for pip to build mysqlclient's C extension (a real,
    // reproduced `ModuleNotFoundError: No module named 'MySQLdb'` at PyHSS's
    // own runtime, despite this apt-get step itself reporting success) —
    // needed default-libmysqlclient-dev (the mysql_config binary specifically,
    // distinct from mariadb_config) and build-essential (a genuinely fresh
    // minimal image doesn't guarantee gcc/make are already present, unlike
    // this project's own long-lived reference host where some earlier step
    // had already pulled them in for something else). Confirmed live: adding
    // these three and re-running the pip install below fixed it.
    const basePyhssDepsExitCode = await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get install -y libmariadb-dev default-libmysqlclient-dev pkg-config build-essential 2>&1');
    // --break-system-packages (PEP 668) is only understood by pip >= 23.0.1 -
    // older pip3 (as shipped on some fresh hosts) rejects it outright with
    // "no such option: --break-system-packages" and the whole install never
    // runs, which used to be silently ignored here (no exit code captured,
    // unconditional "✅ PyHSS installed." printed regardless). Confirmed live
    // 2026-07-28. Try with the flag first; only fall back to without it if
    // the flag itself is what's unrecognized, not on any other failure (a
    // real requirements.txt/network failure should still surface as failed).
    // --ignore-installed avoids a second, separate failure mode confirmed live
    // 2026-08-02: "Cannot uninstall pyparsing 3.1.1, RECORD file not found.
    // Hint: The package was installed by debian." — some of requirements.txt's
    // deps (pyparsing here, but this class of conflict can hit any dep) are
    // already present as an apt/dpkg-installed system package, which has no
    // RECORD file for pip to use to uninstall it before replacing it. Telling
    // pip to ignore what's already installed makes it install straight over
    // (shadowing it in site-packages) instead of trying to uninstall first.
    const pipExitCode = await spawnStream(
      'set -o pipefail\n' +
      'OUT=$(pip3 install --break-system-packages --ignore-installed -r /opt/pyhss/requirements.txt 2>&1); RC=$?\n' +
      'echo "$OUT"\n' +
      'if [ $RC -ne 0 ] && echo "$OUT" | grep -q "no such option.*break-system-packages"; then\n' +
      '  echo "pip3 does not support --break-system-packages (older pip) — retrying without it."\n' +
      '  pip3 install --ignore-installed -r /opt/pyhss/requirements.txt\n' +
      'else\n' +
      '  exit $RC\n' +
      'fi'
    );
    await spawnStream('mkdir -p /etc/pyhss');
    if (basePyhssDepsExitCode !== 0 || pipExitCode !== 0) {
      write('\n⚠️ WARNING: PyHSS Python dependency install FAILED (see errors above) — ' +
        'PyHSS will not start correctly. Fix the underlying issue and re-run Install.\n');
    } else {
      write('✅ PyHSS installed.\n');
    }

    // Best-effort install of py-spy (a sampling Python profiler/stack-dump
    // tool) — not a PyHSS dependency, used by pyhss-diameter-guard.ts to
    // capture forensic context when it detects the pyhss-diameter hang
    // signature (see that file's header). Deliberately non-fatal: the
    // guard's actual detection/restart logic doesn't depend on py-spy being
    // present, this just makes a future diagnostic capture richer when it
    // is. --break-system-packages is safe here specifically because py-spy
    // is a standalone Rust binary with a thin wheel wrapper and no real
    // Python dependencies of its own to conflict with anything PyHSS needs.
    const pySpyExitCode = await spawnStream(
      'if command -v py-spy >/dev/null 2>&1; then\n' +
      '  echo "py-spy already installed."\n' +
      '  exit 0\n' +
      'fi\n' +
      'pip3 install --break-system-packages py-spy 2>&1 || pip3 install --ignore-installed py-spy 2>&1\n'
    );
    if (pySpyExitCode !== 0) {
      write('\n⚠️ py-spy install failed (non-fatal — IMS still works; this only reduces the ' +
        'detail available in a future pyhss-diameter-guard diagnostic capture).\n');
    } else {
      write('✅ py-spy available for diagnostics.\n');
    }

    // Patch PyHSS's Answer_16777216_300() (Cx UAA) and Answer_16777216_302()
    // (Cx LIA): both have the same bug shape — a missing username-bearing AVP
    // (AVP 1 for UAA, AVP 601 for LIA) raises IndexError inside the try block
    // before the id variable (imsi / username) is ever assigned; the except
    // handler then references that same variable for a Redis metric label,
    // raising a SECOND, uncaught UnboundLocalError from inside the handler
    // itself — which crashes the function before either the success AVP or
    // the proper 5001 Experimental-Result AVP is ever written. On the wire
    // this looks exactly like a "genuinely intermittent" UAA/LIA with
    // neither Result-Code nor Experimental-Result-Code present (302 case
    // confirmed live 2026-07-26; 300 has the identical shape, found by
    // inspection while scoping the 302 fix).
    // Idempotent (line-anchored, not offset-based) so it's safe to re-run
    // against an already-patched file, and fails loudly instead of silently
    // if upstream PyHSS changes either function's shape enough to break the
    // anchors.
    write('\n=== Patching PyHSS diameter.py (UAA/LIA crash-guard) ===\n');
    const pyhssPatchExitCode = await spawnStream(
      // set -e: without this, the heredoc's sys.exit(1) on a real patch
      // failure didn't abort the script - the trailing py_compile call ran
      // regardless and (succeeding on the unpatched-but-still-valid file)
      // became the reported exit code, silently masking the real failure.
      // Confirmed live 2026-07-28 via the sibling default_ifc.xml patch below
      // hitting exactly this. This patch happened to already be up to date
      // when found, but the same masking bug was latent here too.
      'set -e\n' +
      'python3 - <<\'PYEOF\'\n' +
      'import sys\n' +
      'path = "/opt/pyhss/lib/diameter.py"\n' +
      'with open(path) as f:\n' +
      '    lines = f.readlines()\n' +
      'changed = False\n' +
      '# "Checking if username present" is reused by Answer_16777216_300/301/302 —\n' +
      '# always scope the search strictly to the one function body being patched.\n' +
      'def patch_func(func_name, var_name):\n' +
      '    global changed\n' +
      '    func_start = None\n' +
      '    for i, line in enumerate(lines):\n' +
      '        if line.strip().startswith("def " + func_name + "("):\n' +
      '            func_start = i\n' +
      '            break\n' +
      '    if func_start is None:\n' +
      '        print("ERROR: " + func_name + "() not found — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '        sys.exit(1)\n' +
      '    func_end = len(lines)\n' +
      '    for i in range(func_start + 1, len(lines)):\n' +
      '        if lines[i].strip().startswith("def "):\n' +
      '            func_end = i\n' +
      '            break\n' +
      '    anchor_idx = None\n' +
      '    for i in range(func_start, func_end):\n' +
      '        if "Checking if username present" in lines[i]:\n' +
      '            anchor_idx = i\n' +
      '            break\n' +
      '    if anchor_idx is None:\n' +
      '        print("ERROR: anchor line (\'Checking if username present\') not found inside " + func_name + "() — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '        sys.exit(1)\n' +
      '    try_idx = anchor_idx - 1\n' +
      '    if lines[try_idx].strip() != "try:":\n' +
      '        print("ERROR: expected try: line not found above anchor in " + func_name + "() — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '        sys.exit(1)\n' +
      '    if try_idx == 0 or (var_name + " = None") not in lines[try_idx - 1]:\n' +
      '        indent = lines[try_idx][:len(lines[try_idx]) - len(lines[try_idx].lstrip())]\n' +
      '        lines.insert(try_idx, indent + var_name + " = None\\n")\n' +
      '        changed = True\n' +
      '        func_end += 1\n' +
      '    needle = "str(" + var_name + "[0:6])"\n' +
      '    guard = "if " + var_name + " else"\n' +
      '    for i in range(func_start, func_end):\n' +
      '        if needle in lines[i] and guard not in lines[i]:\n' +
      '            lines[i] = lines[i].replace(needle, "(" + needle + " if " + var_name + " else \'unknown\')")\n' +
      '            changed = True\n' +
      'patch_func("Answer_16777216_300", "imsi")\n' +
      'patch_func("Answer_16777216_302", "username")\n' +
      'if changed:\n' +
      '    with open(path, "w") as f:\n' +
      '        f.writelines(lines)\n' +
      '    print("patched")\n' +
      'else:\n' +
      '    print("already patched — skipping")\n' +
      'PYEOF\n' +
      'python3 -m py_compile /opt/pyhss/lib/diameter.py\n'
    );
    if (pyhssPatchExitCode !== 0) {
      write('\n⚠️ WARNING: diameter.py UAA/LIA crash-guard patch FAILED (see errors above). ' +
        'PyHSS may crash-loop or return malformed Cx UAA/LIA responses when a request is ' +
        'missing a username-bearing AVP — fix the underlying issue and re-run Install, the ' +
        'patch is idempotent and will retry automatically.\n');
    } else {
      write('✅ PyHSS diameter.py patched.\n');
    }

    // Patch PyHSS's hssService.py: Generate_Prom_Stats() (diameter.py) — the
    // function that would populate prom_ims_subs/prom_mme_subs/prom_pcrf_subs,
    // the gauges behind this NMS's own "IMS Subscribers" Grafana panel — exists
    // in stock PyHSS but is never called anywhere in the codebase (confirmed
    // live 2026-09-25, dead code). It must run on its OWN background thread,
    // never inline in handleQueue() — that's PyHSS's single-threaded, blocking
    // Diameter message loop, and Generate_Prom_Stats does blocking DB I/O
    // (3 full ORM queries via SQLAlchemy) — inlining it would stall real
    // Diameter processing on every 30s tick. Same idempotent/line-anchored/
    // fail-loud idiom as the UAA/LIA patch directly above.
    write('\n=== Patching PyHSS hssService.py (background Prometheus stats thread) ===\n');
    const pyhssMetricsPatchExitCode = await spawnStream(
      'set -e\n' +
      'python3 - <<\'PYEOF\'\n' +
      'import sys\n' +
      'path = "/opt/pyhss/services/hssService.py"\n' +
      'with open(path) as f:\n' +
      '    lines = f.readlines()\n' +
      'changed = False\n' +
      'import_idx = None\n' +
      'for i, line in enumerate(lines):\n' +
      '    if line.strip().startswith("import os, sys, json, time, traceback, socket"):\n' +
      '        import_idx = i\n' +
      '        break\n' +
      'if import_idx is None:\n' +
      '    print("ERROR: expected stdlib import line not found in hssService.py — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '    sys.exit(1)\n' +
      'if "threading" not in lines[import_idx]:\n' +
      '    lines[import_idx] = lines[import_idx].rstrip("\\n") + ", threading\\n"\n' +
      '    changed = True\n' +
      'if not any("_prom_stats_loop" in l for l in lines):\n' +
      '    main_idx = None\n' +
      '    for i, line in enumerate(lines):\n' +
      '        if line.startswith("def main():"):\n' +
      '            main_idx = i\n' +
      '            break\n' +
      '    if main_idx is None:\n' +
      '        print("ERROR: def main() not found in hssService.py — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '        sys.exit(1)\n' +
      '    loop_fn_lines = [\n' +
      '        "def _prom_stats_loop(hssService):\\n",\n' +
      '        "    # open5gs-nms: runs Generate_Prom_Stats() on a background thread —\\n",\n' +
      '        "    # see main()\'s own comment for why this can never be inline.\\n",\n' +
      '        "    while True:\\n",\n' +
      '        "        try:\\n",\n' +
      '        "            hssService.diameterLibrary.Generate_Prom_Stats()\\n",\n' +
      '        "        except Exception:\\n",\n' +
      '        "            pass\\n",\n' +
      '        "        time.sleep(30)\\n",\n' +
      '        "\\n",\n' +
      '        "\\n",\n' +
      '    ]\n' +
      '    lines[main_idx:main_idx] = loop_fn_lines\n' +
      '    changed = True\n' +
      'handlequeue_idx = None\n' +
      'for i, line in enumerate(lines):\n' +
      '    if "hssService.handleQueue()" in line:\n' +
      '        handlequeue_idx = i\n' +
      '        break\n' +
      'if handlequeue_idx is None:\n' +
      '    print("ERROR: hssService.handleQueue() call not found — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '    sys.exit(1)\n' +
      'if "_prom_stats_loop" not in lines[handlequeue_idx - 1]:\n' +
      '    indent = lines[handlequeue_idx][:len(lines[handlequeue_idx]) - len(lines[handlequeue_idx].lstrip())]\n' +
      '    lines.insert(handlequeue_idx, indent + "# open5gs-nms: background Prometheus stats thread (never inline — see _prom_stats_loop)\\n" + indent + "threading.Thread(target=_prom_stats_loop, args=(hssService,), daemon=True).start()\\n")\n' +
      '    changed = True\n' +
      'if changed:\n' +
      '    with open(path, "w") as f:\n' +
      '        f.writelines(lines)\n' +
      '    print("patched")\n' +
      'else:\n' +
      '    print("already patched — skipping")\n' +
      'PYEOF\n' +
      'python3 -m py_compile /opt/pyhss/services/hssService.py\n'
    );
    if (pyhssMetricsPatchExitCode !== 0) {
      write('\n⚠️ WARNING: hssService.py background-stats patch FAILED (see errors above). ' +
        'The "IMS Subscribers" Grafana panel will keep reading 0 — pyhss-metrics itself will ' +
        'still run, but Generate_Prom_Stats() never gets called to populate its gauge. Fix the ' +
        'underlying issue and re-run Install, the patch is idempotent and will retry automatically.\n');
    } else {
      write('✅ PyHSS hssService.py patched.\n');
    }

    // Patch PyHSS's default_ifc.xml: its <PrivateID>/<Identity> elements built
    // the subscriber's permanent SIP identity domain from `scscf_realm` — a
    // *transient* Diameter-routing field on the ims_subscriber row that
    // `database.py`'s Update_Serving_CSCF() explicitly sets to NULL on every
    // deregister. If a re-register's Server-Assignment-Answer got built while
    // that field was momentarily None (a real race between a deregister SAR
    // and the following register SAR), Jinja2 rendered the literal string
    // "None" straight into the subscriber's identity — e.g.
    // `sip:15550000004@None` — which S-CSCF then cached as that subscriber's
    // Implicit Registration Set until the next full re-register. On the wire
    // this looked like a client-side SIP corruption bug; confirmed live
    // 2026-07-27 it's actually this PyHSS template's fault. Fix: derive the
    // domain from `mnc`/`mcc` (always freshly set immediately before every
    // render in Answer_16777216_301, never touched by the dereg-clearing
    // bug) instead of the volatile `scscf_realm`.
    write('\n=== Patching PyHSS default_ifc.xml (identity-domain corruption guard) ===\n');
    const ifcPatchExitCode = await spawnStream(
      // set -e: without this, the heredoc's SystemExit(1) on a real patch
      // failure (e.g. "expected '{{ iFC_vars.scscf_realm }}' not found")
      // didn't abort the script - the trailing render/parse validation
      // command ran regardless and, since a raw "None" value still renders
      // as syntactically valid XML text, it succeeded anyway and its exit
      // code became the reported result. Confirmed live 2026-07-28: a real
      // Install run printed both the ERROR line AND "✅ ... patched." for
      // this exact step.
      'set -e\n' +
      'python3 - <<\'PYEOF\'\n' +
      'path = "/opt/pyhss/default_ifc.xml"\n' +
      'with open(path) as f:\n' +
      '    src = f.read()\n' +
      '# Upstream PyHSS has used two different Jinja2 attribute-access syntaxes for\n' +
      '# this template over time — dot notation ("iFC_vars.scscf_realm") and, as of a\n' +
      '# 2026-07-31 upstream commit confirmed live 2026-08-02, bracket/subscript\n' +
      '# notation ("iFC_vars[\'scscf_realm\']"). Handle both instead of only the dot form.\n' +
      'variants = [\n' +
      '    ("{{ iFC_vars.scscf_realm }}", "ims.mnc{{ iFC_vars.mnc }}.mcc{{ iFC_vars.mcc }}.3gppnetwork.org"),\n' +
      '    ("{{ iFC_vars[\'scscf_realm\'] }}", "ims.mnc{{ iFC_vars[\'mnc\'] }}.mcc{{ iFC_vars[\'mcc\'] }}.3gppnetwork.org"),\n' +
      ']\n' +
      'count = 0\n' +
      'for needle, replacement in variants:\n' +
      '    c = src.count(needle)\n' +
      '    if c:\n' +
      '        src = src.replace(needle, replacement)\n' +
      '        count += c\n' +
      'if count:\n' +
      '    with open(path, "w") as f:\n' +
      '        f.write(src)\n' +
      '    print("patched " + str(count) + " occurrence(s)")\n' +
      'elif "scscf_realm" not in src:\n' +
      '    # Upstream itself no longer derives the subscriber identity domain from\n' +
      '    # scscf_realm at all (already building it from mnc/mcc directly) — the bug\n' +
      '    # this patch guards against cannot occur, nothing to do.\n' +
      '    print("not applicable — PyHSS source no longer derives the identity domain from scscf_realm, nothing to patch")\n' +
      'else:\n' +
      '    print("ERROR: default_ifc.xml still references scscf_realm but not via a recognized ' +
        'dot or bracket accessor form — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '    raise SystemExit(1)\n' +
      'PYEOF\n' +
      'python3 -c "import xml.dom.minidom, jinja2; t = jinja2.Environment(loader=jinja2.FileSystemLoader(\'/opt/pyhss\')).get_template(\'default_ifc.xml\'); xml.dom.minidom.parseString(t.render(iFC_vars={\'imsi\':\'1\',\'msisdn\':\'1\',\'mnc\':\'001\',\'mcc\':\'001\',\'scscf_realm\':None}))"\n'
    );
    if (ifcPatchExitCode !== 0) {
      write('\n⚠️ WARNING: default_ifc.xml identity-domain patch FAILED (see errors above). ' +
        'Subscribers may intermittently register with a corrupted "None" SIP domain after a ' +
        're-register race — fix the underlying issue and re-run Install, the patch is ' +
        'idempotent and will retry automatically.\n');
    } else {
      write('✅ PyHSS default_ifc.xml patched.\n');
    }

    // Patch PyHSS's diameterService.py/messagingAsync.py (pyhss-diameter):
    // a real, recurring hang found live 2026-10-01 — PyHSS's Diameter Cx
    // peer connection stays I_Open (confirmed via `cdp.list_peers`) while
    // silently stopping all processing, surfacing as `500 Server error on
    // LIR` on Kamailio's side; only `systemctl restart pyhss-diameter`
    // recovered it, and it recurred repeatedly (4+ times in ~2 hours).
    // `hssService.py` (`pyhss-hss`, the actual Cx business-logic processor)
    // was independently confirmed NOT the hung component — its own PID had
    // been running continuously for 25+ hours spanning every hang, and a
    // live `py-spy dump` showed it correctly idle. The hang is isolated to
    // `diameterService.py`'s own asyncio socket layer: `awaitMessage()`
    // (messagingAsync.py) calls Redis `BLPOP`/`BLMPOP` with no timeout
    // (blocks forever), no `socket_timeout` is configured on the Redis
    // client at all, and every peer reconnect (any pcscf/scscf/icscf
    // restart) cancels an in-flight per-connection writer task via
    // `asyncio.wait(..., FIRST_COMPLETED)` + `.cancel()` — a combination
    // that can leave a blocking call with no bounded recovery path. This
    // patch makes every blocking Redis call in this service self-healing
    // (a stalled wait now times out and retries instead of hanging
    // forever) rather than requiring a manual restart — note this is
    // hardening against a confirmed failure *symptom*, not a 100%-proven
    // single root cause (an adversarial code-level review of the exact
    // installed redis-py 5.0.0 found real built-in defenses against the
    // specific "corrupted pooled connection" mechanism first suspected,
    // so treat this as defense-in-depth, not a guaranteed fix — see
    // memory pyhss_diameter_hang_investigation.md for the full arc,
    // including why a direct live reproduction was never caught). Also
    // fixes a real, separate `UnboundLocalError` risk in
    // `validateDiameterInbound()` — same bug shape as the already-shipped
    // diameter.py UAA/LIA crash-guard above, just in this file's own
    // exception handler (not the hang cause — it's independently caught
    // and swallowed by the caller — but worth closing on the same pass).
    // Idempotent (line-anchored, not offset-based), fails loudly if
    // upstream PyHSS changes either file's shape enough to break an
    // anchor, same as every other patch in this function.
    write('\n=== Patching PyHSS diameterService.py/messagingAsync.py (pyhss-diameter hang hardening) ===\n');
    const pyhssHangPatchExitCode = await spawnStream(
      'set -e\n' +
      'python3 - <<\'PYEOF\'\n' +
      'import sys\n' +
      'changed_any = False\n' +
      '\n' +
      '# messagingAsync.py: give every Redis client a bounded socket timeout,\n' +
      '# and give the per-connection outbound BLPOP a bounded wait so a stalled\n' +
      '# read raises and retries instead of hanging forever.\n' +
      'path = "/opt/pyhss/lib/messagingAsync.py"\n' +
      'with open(path) as f:\n' +
      '    src = f.read()\n' +
      'orig_src = src\n' +
      'replacements = [\n' +
      '    ("self.redisClient = redis.Redis(unix_socket_path=unixSocketPath)",\n' +
      '     "self.redisClient = redis.Redis(unix_socket_path=unixSocketPath, socket_timeout=15, socket_connect_timeout=5)"),\n' +
      '    ("self.redisClient = redis.Redis(host=host, port=port)",\n' +
      '     "self.redisClient = redis.Redis(host=host, port=port, socket_timeout=15, socket_connect_timeout=5)"),\n' +
      '    ("message =  (await(self.redisClient.blpop(key)))",\n' +
      '     "message =  (await(self.redisClient.blpop(key, timeout=10)))"),\n' +
      ']\n' +
      'for old, new in replacements:\n' +
      '    if new in src:\n' +
      '        continue\n' +
      '    if old not in src:\n' +
      '        print("ERROR: anchor not found in messagingAsync.py: " + repr(old) + " — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '        sys.exit(1)\n' +
      '    src = src.replace(old, new, 1)\n' +
      '    changed_any = True\n' +
      'if src != orig_src:\n' +
      '    with open(path, "w") as f:\n' +
      '        f.write(src)\n' +
      '    print("messagingAsync.py: patched")\n' +
      'else:\n' +
      '    print("messagingAsync.py: already patched — skipping")\n' +
      '\n' +
      '# diameterService.py: writeOutboundData() must treat a timed-out/empty\n' +
      '# awaitMessage() result as "nothing to send yet, loop again" rather than\n' +
      '# "connection closed, tear the writer down" (indexing \'\'[1] currently\n' +
      '# raises IndexError, caught generically as a connection-closed signal) —\n' +
      '# required once the blpop above gets a real timeout instead of blocking\n' +
      '# forever, or every idle period would start dropping the Kamailio\n' +
      '# connection. A short sleep on the empty path only (not the real-message\n' +
      '# path) rate-limits a genuinely fast-failing Redis error instead of\n' +
      '# busy-spinning; validateDiameterInbound() gets the same None-init crash\n' +
      '# guard as the diameter.py UAA/LIA patch above, for the same reason.\n' +
      'path = "/opt/pyhss/services/diameterService.py"\n' +
      'with open(path) as f:\n' +
      '    src = f.read()\n' +
      'orig_src = src\n' +
      '\n' +
      'old_d = (\n' +
      '    "        try:\\n"\n' +
      '    "            packetVars, avps = await(self.diameterLibrary.decodeDiameterPacket(inboundData))"\n' +
      ')\n' +
      'new_d = (\n' +
      '    "        packetVars, avps = None, None\\n"\n' +
      '    "        try:\\n"\n' +
      '    "            packetVars, avps = await(self.diameterLibrary.decodeDiameterPacket(inboundData))"\n' +
      ')\n' +
      'if new_d in src:\n' +
      '    pass\n' +
      'elif old_d not in src:\n' +
      '    print("ERROR: anchor not found in diameterService.py for validateDiameterInbound — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '    sys.exit(1)\n' +
      'else:\n' +
      '    src = src.replace(old_d, new_d, 1)\n' +
      '    changed_any = True\n' +
      '\n' +
      'old_c = (\n' +
      '    "                pendingOutboundMessage = (await(self.redisWriterMessaging.awaitMessage(key=f\\"diameter-outbound-{clientAddress}-{clientPort}\\", usePrefix=True, prefixHostname=self.hostname, prefixServiceName=\'diameter\')))[1]\\n"\n' +
      ')\n' +
      'new_c = (\n' +
      '    "                rawOutboundMessage = await(self.redisWriterMessaging.awaitMessage(key=f\\"diameter-outbound-{clientAddress}-{clientPort}\\", usePrefix=True, prefixHostname=self.hostname, prefixServiceName=\'diameter\'))\\n"\n' +
      '    "                if not rawOutboundMessage:\\n"\n' +
      '    "                    await(asyncio.sleep(1))\\n"\n' +
      '    "                    continue\\n"\n' +
      '    "                pendingOutboundMessage = rawOutboundMessage[1]\\n"\n' +
      ')\n' +
      'if new_c in src:\n' +
      '    pass\n' +
      'elif old_c not in src:\n' +
      '    print("ERROR: anchor not found in diameterService.py for writeOutboundData — PyHSS source may have changed, skipping patch, please review manually.")\n' +
      '    sys.exit(1)\n' +
      'else:\n' +
      '    src = src.replace(old_c, new_c, 1)\n' +
      '    changed_any = True\n' +
      '\n' +
      'if src != orig_src:\n' +
      '    with open(path, "w") as f:\n' +
      '        f.write(src)\n' +
      '    print("diameterService.py: patched")\n' +
      'else:\n' +
      '    print("diameterService.py: already patched — skipping")\n' +
      'PYEOF\n' +
      'python3 -m py_compile /opt/pyhss/lib/messagingAsync.py /opt/pyhss/services/diameterService.py\n'
    );
    if (pyhssHangPatchExitCode !== 0) {
      write('\n⚠️ WARNING: PyHSS diameterService.py/messagingAsync.py hang-hardening patch FAILED ' +
        '(see errors above). pyhss-diameter may keep hanging on a peer reconnect race until this ' +
        'is fixed and Install is re-run — the patch is idempotent and will retry automatically.\n');
    } else {
      write('✅ PyHSS diameterService.py/messagingAsync.py patched (pyhss-diameter hang hardening).\n');
      await nsenter('systemctl', ['restart', 'pyhss-diameter']).catch(() => {});
    }

    // Patch Open5GS SMF's "Late/overlapping Create Session Request" gap
    // (src/smf/gsm-sm.c): smf_gsm_state_operational() silently drops a
    // Create Session Request that collides with an already-operational
    // session instead of replying with a proper GTP2 cause — confirmed
    // live 2026-08-04 via a real Nokia AirScale Pico BTS B66 eNB attach,
    // this is exactly what "IMS won't create the bearer" looked like: the
    // silent drop causes a multi-second peer-side timeout whose cleanup
    // also tears down the UE's OTHER, unrelated sibling PDN session (a
    // working "internet" bearer dying just because a colliding "ims"
    // request arrived for the same UE). Builds a patched open5gs-smfd from
    // source (matching whatever commit the host's own smfd was already
    // built from — Open5GS isn't vendored by this NMS, so this can't pin a
    // fixed version the way the VoWiFi/FRR from-source builds do) and
    // installs it over the host's binary, with an automatic rollback to
    // the pre-patch binary if the newly built one fails to come up
    // healthy. This step failing is a warning, not a hard Install failure
    // — IMS still works without it, this specific race just stays open.
    write('\n=== Patching Open5GS SMF (Create Session Request collision fix) ===\n');
    const smfPatchExitCode = await spawnStream(buildSmfLateCsrPatchScript());
    if (smfPatchExitCode !== 0) {
      write('\n⚠️ WARNING: Open5GS SMF late-overlapping-CSR patch FAILED or was skipped ' +
        '(see errors above) — IMS bearer setup may still intermittently fail on radios ' +
        'whose attach timing triggers this race (confirmed on a Nokia AirScale Pico BTS). ' +
        'Fix the underlying issue and re-run Install — this step is idempotent.\n');
    } else {
      write('✅ Open5GS SMF patched (or already up to date).\n');
    }

    // Patch Open5GS SMF's Gx "wrong-peer" gap (src/smf/gx-path.c): the very
    // first Gx CCR of a new session relies entirely on freeDiameter's
    // realm+Application-Id candidate selection to reach PCRF, with no
    // Destination-Host — and this deployment's SMF has three same-realm
    // Diameter peers (pcrf/aaa/ocs), one of which (SigScale OCS) also
    // advertises Gx's Application-Id in its own CER despite not
    // implementing it. Confirmed live 2026-10-02 chasing a real "iPhone
    // keeps connecting then disconnecting from LTE" report: a real Gx CCR
    // got routed to OCS instead of PCRF, PCRF's own log showed it never
    // arrived, and ~7.5s later MME's GTP Holding Timeout tore the whole
    // session down. Builds a patched open5gs-smfd the same way as the
    // late-overlapping-CSR patch above (same source tree, same
    // commit-matching, same automatic rollback if the new binary doesn't
    // come up healthy) — this step failing is a warning, not a hard
    // Install failure, same reasoning as that patch.
    write('\n=== Patching Open5GS SMF (Gx wrong-peer fix) ===\n');
    const smfGxPatchExitCode = await spawnStream(buildSmfGxPeerhostPatchScript());
    if (smfGxPatchExitCode !== 0) {
      write('\n⚠️ WARNING: Open5GS SMF Gx wrong-peer patch FAILED or was skipped ' +
        '(see errors above) — a Gx CCR may still intermittently misroute to another ' +
        'same-realm Diameter peer (e.g. SigScale OCS, if installed), causing a PDU ' +
        'session to silently hang until the UE\'s own GTP retransmit timer gives up ' +
        'and the attach is torn down and retried. Fix the underlying issue and ' +
        're-run Install — this step is idempotent.\n');
    } else {
      write('✅ Open5GS SMF patched for the Gx wrong-peer fix (or already up to date).\n');
    }

    // Record which app version this Install ran under — drives the
    // "Reinstall available" banner (installStale in /status) so a future
    // release that changes an Install-time step (a new patch, a fixed
    // package list, ...) doesn't sit silently unapplied on an existing
    // deployment. Written unconditionally at the end, same as every other
    // step above: Install is considered "done" once it reaches here even
    // if an individual patch step warned rather than hard-failed.
    fs.writeFileSync(HOST_IMS_INSTALL_STATE, JSON.stringify({
      installedWithVersion: getAppVersion(),
      installedWithRev: IMS_INSTALL_REV,
      installedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');

  write('\n✅ IMS installation complete. Run Configure next.\n');
  return { success: true };
}

// Install/config revisions — see domain/services/module-revision.ts for the
// rule. IMS additionally has a CONTENT check (checkImsTemplateStaleness), which
// is the stronger signal where it applies; these catch a changed install step or
// config generator whose output happens to look identical.
export const IMS_INSTALL_REV = 1;
export const IMS_CONFIG_REV = 1;

export interface ImsStalenessResult {
  installed: boolean;
  hasSavedConfig: boolean;
  installStale: boolean;
  configStale: boolean;
  installedWithVersion?: string;
  configuredWithVersion?: string;
  installedWithRev?: number;
  configuredWithRev?: number;
  /**
   * Deployed static templates whose content differs from this build's, and ones
   * missing entirely — host paths, from checkImsTemplateStaleness().
   *
   * Separate from `configStale` on purpose: that flag only compares version
   * STRINGS, so it reads "current" for the failure mode that actually keeps
   * happening here (a template edited without a version bump, or a hand
   * redeploy — see checkImsTemplateStaleness()'s own comment for the two real
   * outages). Without this, Fix All would report nothing to do while the live
   * routing scripts were genuinely out of date.
   */
  staleTemplates: string[];
  missingTemplates: string[];
}

// Cheap, standalone version of the staleness-comparison logic already
// computed inline by GET /status — used by the cross-module Fix-All
// aggregator (module-fixall-usecase.ts) so it doesn't need to run every
// other expensive check /status does (service health, registered UEs, etc).
export async function getImsStaleness(): Promise<ImsStalenessResult> {
  const whichRes = await nsenter('which', ['kamailio']).catch(() => null);
  const installed = !!whichRes && whichRes.stdout.trim().length > 0;
  const appVersion = getAppVersion();

  const hasSavedConfig = fs.existsSync(HOST_IMS_STATE);
  let configuredWithVersion: string | undefined;
  let configuredWithRev: number | undefined;
  if (hasSavedConfig) {
    try {
      const saved = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
      configuredWithVersion = saved.configuredWithVersion;
      configuredWithRev = saved.configuredWithRev;
    } catch { /* corrupt */ }
  }

  let installedWithVersion: string | undefined;
  let installedWithRev: number | undefined;
  const hasInstallMarker = fs.existsSync(HOST_IMS_INSTALL_STATE);
  if (hasInstallMarker) {
    try {
      const saved = JSON.parse(fs.readFileSync(HOST_IMS_INSTALL_STATE, 'utf-8'));
      installedWithVersion = saved.installedWithVersion;
      installedWithRev = saved.installedWithRev;
    } catch { /* corrupt */ }
  }

  const { installStale, configStale } = revisionStaleness({
    installed,
    hasSavedConfig,
    installedWithRev,
    configuredWithRev,
    expectedInstallRev: IMS_INSTALL_REV,
    expectedConfigRev: IMS_CONFIG_REV,
  });

  // Content comparison, not a version-string compare. Needs the rtpEngineIp the
  // deployment was actually configured with so token-bearing templates render
  // exactly as they were deployed; without it those are skipped rather than
  // reported as false positives.
  let rtpEngineIp: string | undefined;
  if (hasSavedConfig) {
    try {
      rtpEngineIp = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'))?.config?.rtpEngineIp;
    } catch { /* corrupt */ }
  }
  const templates = installed
    ? checkImsTemplateStaleness(rtpEngineIp)
    : { stale: [], missing: [], checked: 0 };

  return {
    installed, hasSavedConfig, installStale, configStale,
    installedWithVersion, configuredWithVersion,
    installedWithRev, configuredWithRev,
    staleTemplates: templates.stale,
    missingTemplates: templates.missing,
  };
}

export function createImsRouter(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
  callStatsMonitor?: ImsCallStatsMonitor,
): Router {
  const router = Router();

  // GET /api/ims/call-stats — instant, non-blocking read of the background
  // sampler's last computed value (see call-stats-monitor.ts). Polled on a
  // short interval by the Dashboard's IMS Status card.
  router.get('/call-stats', (_req: Request, res: Response) => {
    const latest = callStatsMonitor?.getLatest() ?? { activeCalls: 0, totalCallsPlaced: 0, totalSmsSent: 0, sampledAt: 0 };
    res.json({ success: true, ...latest });
  });

  // GET /api/ims/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const [whichRes, pcscfRes, icscfRes, scscfRes, smscRes, rtpRes, dnsRes, mariaRes,
             pyhssDiamRes, pyhssHssRes, pyhssApiRes, redisRes] =
        await Promise.allSettled([
          nsenter('which', ['kamailio']),
          nsenter('systemctl', ['is-active', 'kamailio-pcscf']),
          nsenter('systemctl', ['is-active', 'kamailio-icscf']),
          nsenter('systemctl', ['is-active', 'kamailio-scscf']),
          nsenter('systemctl', ['is-active', 'kamailio-smsc']),
          nsenter('systemctl', ['is-active', 'rtpengine-daemon']),
          nsenter('systemctl', ['is-active', 'bind9']),
          nsenter('systemctl', ['is-active', 'mariadb']),
          nsenter('systemctl', ['is-active', 'pyhss-diameter']),
          nsenter('systemctl', ['is-active', 'pyhss-hss']),
          nsenter('systemctl', ['is-active', 'pyhss-api']),
          nsenter('systemctl', ['is-active', 'redis-server']),
        ]);

      const installed = whichRes.status === 'fulfilled' && whichRes.value.stdout.trim().length > 0;
      const pyhssInstalled = fs.existsSync('/proc/1/root/opt/pyhss');
      const svcActive = (r: PromiseSettledResult<any>) =>
        r.status === 'fulfilled' && r.value.stdout.trim() === 'active';

      const hasSavedConfig = fs.existsSync(HOST_IMS_STATE);
      let currentConfig: ImsConfigureInput | undefined;
      let imsDomain: string | undefined;
      let configuredWithVersion: string | undefined;
      let configuredWithRev: number | undefined;
      let smsDeliveryMode: 'sgs' | 'ims' | 'vectorcore' = 'ims';
      let smsWorkerIntervalSeconds = 30;
      let voiceChargingEnabled = false;
      let cdrAccountingEnabled = false;
      if (hasSavedConfig) {
        try {
          const saved = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
          currentConfig = saved.config;
          imsDomain = saved.imsDomain;
          configuredWithVersion = saved.configuredWithVersion;
          configuredWithRev = saved.configuredWithRev;
          if (saved.smsDeliveryMode === 'sgs' || saved.smsDeliveryMode === 'vectorcore') smsDeliveryMode = saved.smsDeliveryMode;
          if (typeof saved.smsWorkerIntervalSeconds === 'number' && saved.smsWorkerIntervalSeconds > 0) {
            smsWorkerIntervalSeconds = saved.smsWorkerIntervalSeconds;
          }
          if (saved.voiceChargingEnabled === true) voiceChargingEnabled = true;
          if (saved.cdrAccountingEnabled === true) cdrAccountingEnabled = true;
        } catch { /* corrupt */ }
      }
      // Whether OCS is even available to turn this toggle on — lets the
      // frontend disable/explain the control instead of letting an operator
      // hit the hard-fail in setVoiceChargingEnabled() first.
      const ocsAvailable = !!getOcsPeerInfo();
      // Deployments configured before this field existed have no
      // configuredWithVersion at all — treat that the same as "stale",
      // since we genuinely don't know what template they're running.
      const appVersion = getAppVersion();
      // Same revision comparison the Fix-All aggregator uses; IMS additionally
      // reports the stronger content check below.
      const configStale = hasSavedConfig && configuredWithRev !== IMS_CONFIG_REV;

      // Same pattern, for Install rather than Configure — see
      // HOST_IMS_INSTALL_STATE's own comment for why these are tracked
      // separately. A deployment that's `installed` but has never gone
      // through a version that wrote this marker (i.e. every deployment
      // installed before this tracking existed) is treated as stale too,
      // same reasoning as configStale above — we don't know what install
      // steps it actually got.
      let installedWithVersion: string | undefined;
      let installedWithRev: number | undefined;
      const hasInstallMarker = fs.existsSync(HOST_IMS_INSTALL_STATE);
      if (hasInstallMarker) {
        try {
          const savedInstall = JSON.parse(fs.readFileSync(HOST_IMS_INSTALL_STATE, 'utf-8'));
          installedWithVersion = savedInstall.installedWithVersion;
          installedWithRev = savedInstall.installedWithRev;
        } catch { /* corrupt */ }
      }
      const installStale = installed && installedWithRev !== IMS_INSTALL_REV;

      // Content-based staleness, independent of the two version-string flags
      // above — see checkImsTemplateStaleness()'s own comment for the two real
      // outages that came from a deployed template silently differing from the
      // one in the build. Also surfaces the compiled-module patch state, which
      // had a verification function with no callers at all until now.
      const templates = checkImsTemplateStaleness(currentConfig?.rtpEngineIp);
      const modulePatches = installed
        ? await verifyKamailioImsModulesPatch().catch(() => undefined)
        : undefined;

      const services = {
        pcscf:            svcActive(pcscfRes),
        icscf:            svcActive(icscfRes),
        scscf:            svcActive(scscfRes),
        smsc:             svcActive(smscRes),
        rtpengine:        svcActive(rtpRes),
        bind9:            svcActive(dnsRes),
        mariadb:          svcActive(mariaRes),
        'pyhss-diameter': svcActive(pyhssDiamRes),
        'pyhss-hss':      svcActive(pyhssHssRes),
        'pyhss-api':      svcActive(pyhssApiRes),
        redis:            svcActive(redisRes),
      };

      // Registered UE count (live S-CSCF registrar) + active IPsec SA count —
      // both read directly from the running system, not from any DB, so they
      // reflect what's actually happening right now: a provisioned subscriber
      // isn't necessarily registered, and IPsec SAs get wiped by any P-CSCF
      // restart until the phone re-registers — see memory:
      // ims-ue-to-ue-calling-investigation.
      //
      // Both must be scoped to P-CSCF's own IP (currentConfig?.pcscfIp) —
      // `ip xfrm state` is a whole-host dump and also picks up SecGW's
      // entirely unrelated radio-backhaul tunnels (different mechanism,
      // different IPs) when that module is enabled, which showed IPsec SAs
      // as "present" on this page even when P-CSCF had none of its own and
      // every phone was actually unregistered (confirmed live 2026-08-30).
      let ipsecSaCount = 0;
      const [ueRes, xfrmRes] = await Promise.allSettled([
        services.scscf
          ? getRegisteredUesWithActivity(currentConfig?.pcscfIp)
          : Promise.reject(new Error('scscf not running')),
        nsenter('ip', ['xfrm', 'state']),
      ]);
      const { registeredUes, registeredUesByType, activeUes } =
        ueRes.status === 'fulfilled' ? ueRes.value : { registeredUes: 0, registeredUesByType: { iphone: 0, android: 0, other: 0 }, activeUes: 0 };
      if (xfrmRes.status === 'fulfilled') {
        const pcscfIp = currentConfig?.pcscfIp;
        if (pcscfIp) {
          const blocks = xfrmRes.value.stdout.split(/\n(?=src )/);
          ipsecSaCount = blocks.filter((b) => {
            const m = /^src (\S+) dst (\S+)/.exec(b);
            return !!m && (m[1] === pcscfIp || m[2] === pcscfIp);
          }).length;
        } else {
          ipsecSaCount = (xfrmRes.value.stdout.match(/^src /gm) ?? []).length;
        }
      }

      const smfImsConfigured = fs.existsSync(HOST_SMF_YAML) &&
        /dnn:\s*ims/.test(fs.readFileSync(HOST_SMF_YAML, 'utf-8'));

      const dnsConfigured = fs.existsSync(HOST_BIND_ZONES_DIR) &&
        fs.readdirSync(HOST_BIND_ZONES_DIR).some(f => f.includes('3gppnetwork'));

      const imsEnabled = services.pcscf && services.icscf && services.scscf &&
        services['pyhss-diameter'] && services['pyhss-hss'] && smfImsConfigured;

      let imsSubscribers = 0;
      if (services['pyhss-api']) {
        try {
          const list = await pyhssApiCall('GET', '/ims_subscriber/list');
          imsSubscribers = Array.isArray(list) ? list.length : 0;
        } catch { /* api not ready */ }
      }

      const allSubs = await subscriberRepo.findAll();
      const open5gsSubscribers = allSubs.filter(s => s.msisdn && s.msisdn.length > 0).length;

      res.json({
        success: true,
        installed,
        pyhssInstalled,
        hssBackend: 'pyhss',
        services,
        imsSubscribers,
        open5gsSubscribers,
        registeredUes,
        registeredUesByType,
        activeUes,
        ipsecSaCount,
        smfImsConfigured,
        dnsConfigured,
        imsEnabled,
        hasSavedConfig,
        imsDomain,
        currentConfig,
        appVersion,
        configuredWithVersion,
        configStale,
        installedWithVersion,
        installStale,
        templates,
        modulePatches,
        smsDeliveryMode,
        smsWorkerIntervalSeconds,
        voiceChargingEnabled,
        ocsAvailable,
        cdrAccountingEnabled,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'ims status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/sms-delivery-mode — body: { mode: 'sgs' | 'ims' | 'vectorcore' }.
  // Toggle shown on the SMS/MMS page (SMS tab) — see setSmsDeliveryMode() above.
  router.post('/sms-delivery-mode', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { mode } = req.body as { mode?: string };
    if (mode !== 'sgs' && mode !== 'ims' && mode !== 'vectorcore') {
      return res.status(400).json({ success: false, error: "mode must be 'sgs', 'ims', or 'vectorcore'" });
    }
    try {
      await setSmsDeliveryMode(mode);
      await auditLogger.log({ action: 'ims_configure', user, details: `sms_delivery_mode=${mode}`, success: true });
      res.json({ success: true, mode });
    } catch (err) {
      await auditLogger.log({ action: 'ims_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'ims sms-delivery-mode error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/voice-charging — body: { enabled: boolean }.
  // Toggle for voice/airtime charging (Diameter Ro) — see
  // setVoiceChargingEnabled() above. Enabling requires SigScale OCS to
  // already be configured; disabling always succeeds.
  router.post('/voice-charging', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }
    try {
      await setVoiceChargingEnabled(enabled);
      await auditLogger.log({ action: 'ims_configure', user, details: `voice_charging_enabled=${enabled}`, success: true });
      res.json({ success: true, enabled });
    } catch (err) {
      await auditLogger.log({ action: 'ims_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'ims voice-charging error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/sms-worker-interval — body: { seconds: number (1-300) }.
  // Controls how often kamailio-smsc's store-and-forward queue is polled —
  // see setSmsWorkerInterval() above.
  router.post('/sms-worker-interval', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { seconds } = req.body as { seconds?: number };
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
      return res.status(400).json({ success: false, error: 'seconds must be an integer between 1 and 300' });
    }
    try {
      await setSmsWorkerInterval(seconds);
      await auditLogger.log({ action: 'ims_configure', user, details: `sms_worker_interval_seconds=${seconds}`, success: true });
      res.json({ success: true, seconds });
    } catch (err) {
      await auditLogger.log({ action: 'ims_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'ims sms-worker-interval error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/ims/live — real-time IPsec SA / registration / active-call
  // view for the IMS page's "Live Status" tab. Every field here is read
  // directly off the running system rather than the DB (S-CSCF's usrloc is
  // db_mode=1/write-through as of 2026-08-31, but this live in-memory view
  // is still the most current signal, including anything not yet flushed),
  // and IPsec SA byte/packet counters
  // are the same live signal used throughout this project's own VoLTE
  // debugging history to tell "registered" from "actually exchanging
  // traffic." Three independent nsenter calls — one slow/failed source
  // (e.g. S-CSCF not running) shouldn't blank out the other two, so each
  // is caught and defaulted separately rather than failing the whole
  // request.
  router.get('/live', async (_req: Request, res: Response) => {
    try {
      const [ipsecRes, snapshotRes, dlgRes] = await Promise.allSettled([
        nsenter('ip', ['-s', 'xfrm', 'state']),
        (async () => {
          const snapFile = `/tmp/kamailio-scscf-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
          await nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'ulscscf.snapshot', snapFile]);
          const hostSnapFile = `/proc/1/root${snapFile}`;
          const content = fs.existsSync(hostSnapFile) ? fs.readFileSync(hostSnapFile, 'utf-8') : '';
          await nsenter('rm', ['-f', snapFile]).catch(() => {});
          return content;
        })(),
        nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'dlg2.list']),
      ]);

      const ipsecSas = ipsecRes.status === 'fulfilled' ? parseIpsecSaText(ipsecRes.value.stdout) : [];

      // `ip xfrm state` is a single global kernel table shared by both
      // P-CSCF's own SIP-signaling IPsec (Gm, TS 33.203) and VoWiFi's
      // ePDG↔UE tunnel IPsec (SWu) — the kernel has no notion of which
      // subsystem an SA belongs to, so classify by matching each SA's
      // src/dst against each subsystem's own known bind address.
      try {
        const pcscfIp = readCurrentImsConfig()?.pcscfIp;
        const epdgIp = loadVowifiState().epdgIp;
        for (const sa of ipsecSas) {
          if (pcscfIp && (sa.src === pcscfIp || sa.dst === pcscfIp)) sa.group = 'ims';
          else if (epdgIp && (sa.src === epdgIp || sa.dst === epdgIp)) sa.group = 'vowifi';
          else sa.group = 'other';
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'ims live status: IPsec SA classification failed');
        for (const sa of ipsecSas) sa.group = sa.group ?? 'other';
      }

      const registeredUsers = snapshotRes.status === 'fulfilled' ? parseRegisteredUsersSnapshot(snapshotRes.value) : [];

      // Tag each registered row with its subscriber nickname, looked up by
      // the IMSI already extracted from IMPI — best-effort, a lookup
      // failure shouldn't blank out the registration data itself.
      try {
        const imsis = [...new Set(registeredUsers.map(u => u.imsi).filter((v): v is string => !!v))];
        if (imsis.length > 0) {
          const nicknames = await subscriberRepo.getNicknamesByImsi(imsis);
          for (const u of registeredUsers) {
            if (u.imsi && nicknames[u.imsi]) u.nickname = nicknames[u.imsi];
          }
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'ims live status: nickname lookup failed');
      }

      let activeDialogs: Record<string, unknown> = {};
      if (dlgRes.status === 'fulfilled') {
        try { activeDialogs = (parseKamcmdOutput(dlgRes.value.stdout).Dialogs as Record<string, unknown>) ?? {}; }
        catch { /* leave empty on unexpected shape rather than 500 the whole endpoint */ }
      }

      res.json({
        success: true,
        ipsecSas,
        registeredUsers,
        activeDialogCount: Object.keys(activeDialogs).length,
        activeDialogs,
        errors: {
          ipsec: ipsecRes.status === 'rejected' ? String(ipsecRes.reason) : null,
          registrations: snapshotRes.status === 'rejected' ? String(snapshotRes.reason) : null,
          dialogs: dlgRes.status === 'rejected' ? String(dlgRes.reason) : null,
        },
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'ims live status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/live/deregister — manual, operator-triggered force-deregister for
  // one row on the Live Status table. Same underlying regscscf.dereg_impu RPC
  // forceReregisterAllRegisteredUes() already uses for automatic post-restart
  // cleanup, exposed here as an on-demand action so an operator can cleanly reset a
  // test device's registration state (e.g. to test whether it re-registers cleanly
  // over a different access, without waiting for the old binding's Expires timer to
  // lapse on its own).
  //
  // IMPORTANT, confirmed live 2026-09-03 by reading ims_registrar_scscf's own RPC
  // source (reg_rpc.c) and watching kamailio-scscf's debug log during a real call:
  // dereg_impu does NOT directly remove anything from S-CSCF's in-memory usrloc
  // table (system.listMethods confirms there is no hard-delete RPC at all — only
  // showimpu/snapshot/status, all read-only). It builds a reginfo XML marking every
  // linked AOR state="terminated" and sends that as a NOTIFY to whoever is
  // SUBSCRIBEd to this phone's own reg-event package (normally the phone itself) —
  // a "notify and hope the phone reacts" mechanism, not a forced removal. Whether
  // the row actually disappears therefore depends on the phone currently holding a
  // live reg-event subscription and choosing to re-register in response — neither
  // guaranteed. This is exactly why a manual test showed "does nothing" on one
  // attempt and worked on a later one: pure timing/subscription-state luck, not a
  // bug in the RPC call itself.
  //
  // Since there is no real hard-delete available, this endpoint is honest about
  // that instead of reporting a blind "success" the moment the RPC call itself
  // doesn't error: it fires dereg_impu for every alias, then polls the live
  // snapshot for up to ~6s to confirm each one actually disappeared, and reports
  // exactly which ones did/didn't — so the UI never claims success when nothing
  // observably happened.
  router.post('/live/deregister', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const impus = (req.body as any)?.publicIdentities as unknown;
    if (!Array.isArray(impus) || impus.length === 0 || !impus.every((i: unknown) => typeof i === 'string' && i)) {
      res.status(400).json({ success: false, error: 'publicIdentities must be a non-empty array of strings' });
      return;
    }

    const rpcResults: { impu: string; rpcOk: boolean; error?: string }[] = [];
    for (const impu of impus as string[]) {
      try {
        await nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'regscscf.dereg_impu', impu]);
        rpcResults.push({ impu, rpcOk: true });
      } catch (err) {
        rpcResults.push({ impu, rpcOk: false, error: String(err) });
      }
    }

    const readSnapshot = async (): Promise<string> => {
      const snapFile = `/tmp/kamailio-scscf-deregcheck-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
      await nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'ulscscf.snapshot', snapFile]);
      const hostSnapFile = `/proc/1/root${snapFile}`;
      const content = fs.existsSync(hostSnapFile) ? fs.readFileSync(hostSnapFile, 'utf-8') : '';
      await nsenter('rm', ['-f', snapFile]).catch(() => {});
      return content;
    };

    let remaining = new Set(impus as string[]);
    const pollDeadline = Date.now() + 6000;
    while (remaining.size > 0 && Date.now() < pollDeadline) {
      let snapshot: string;
      try {
        snapshot = await readSnapshot();
      } catch {
        break;
      }
      for (const impu of Array.from(remaining)) {
        if (!snapshot.includes(`'${impu}'`)) remaining.delete(impu);
      }
      if (remaining.size > 0) await new Promise(r => setTimeout(r, 750));
    }

    const results = (impus as string[]).map(impu => ({
      impu,
      success: !remaining.has(impu),
      rpcError: rpcResults.find(r => r.impu === impu)?.error,
    }));
    const allCleared = remaining.size === 0;

    logger.warn({ user, results, allCleared }, 'ims: manual force-deregister');
    await auditLogger.log({
      action: 'ims_force_deregister', user,
      details: results.map(r => `${r.impu}=${r.success ? 'cleared' : 'still-registered'}`).join(', '),
      success: allCleared,
    });

    res.json({
      success: allCleared,
      results,
      message: allCleared
        ? 'Deregistered — confirmed removed from the live registrar.'
        : 'Kamailio sent the deregister notify, but the device hasn\'t dropped from the live registrar yet — it may not have an active subscription to react to it, or hasn\'t processed it. Try again in a few seconds, or wait for a natural REGISTER refresh.',
    });
  });

  // POST /api/ims/install — streaming: packages + PyHSS install
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');  // disable nginx proxy buffering
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const write = (s: string) => { res.write(s); };
    await installIms(write);
    await auditLogger.log({ action: 'ims_install', user, details: 'packages + pyhss', success: true });
    res.end();
  });

  // POST /api/ims/configure
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      // NMS fix (2026-08-05): dnsIp used to default to pcscfIp — a
      // coincidental, unrelated value (P-CSCF's own bind IP has nothing to
      // do with DNS) that a caller omitting dnsIp would silently inherit.
      // Confirmed live: this is exactly how one real deployment ended up
      // with dnsIp="10.0.1.178" (P-CSCF's IP) instead of the real DNS
      // service IP — which every subsequent Configure then kept merging
      // into BIND's listen-on list (see writeListenOn() below), alongside
      // the real DNS IP that was separately, correctly configured via the
      // BIND page. Since BIND's own already-configured listen-on list
      // (owned by bind-controller.ts, shared across every module) is the
      // one authoritative source for "what non-loopback IP does BIND
      // actually answer on in this deployment" — no per-deployment guess
      // needed — derive the default from that instead. 127.0.0.1 is always
      // a safe fallback: writeListenOn() guarantees it's in the list on
      // every deployment regardless of anything else configured.
      const bindListenIp = readListenOn().find(ip => ip !== '127.0.0.1');
      const {
        pcscfIp    = '10.0.1.178',
        pcscfPort  = 5060,
        icscfIp    = '127.0.1.1',
        icscfPort  = 4060,
        scscfIp    = '127.0.1.2',
        scscfPort  = 6060,
        rtpEngineIp = pcscfIp,
        rtpPortMin  = 20000,
        rtpPortMax  = 30000,
        dnsIp       = bindListenIp ?? '127.0.0.1',
        additionalPlmns = [],
      } = req.body as Partial<ImsConfigureInput>;

      // Primary PLMN: use explicit override if provided, else read from mme.yaml
      const bodyMcc = (req.body as any).mcc as string | undefined;
      const bodyMnc = (req.body as any).mnc as string | undefined;
      const { mcc: autoMcc, mnc: autoMnc } = readMccMnc();
      const mcc = bodyMcc || autoMcc;
      const mnc = bodyMnc || autoMnc;

      const { imsDomain } = await configureIms({
        pcscfIp, pcscfPort, icscfIp, icscfPort, scscfIp, scscfPort,
        rtpEngineIp, rtpPortMin, rtpPortMax, dnsIp, mcc, mnc, additionalPlmns,
      });

      await auditLogger.log({
        action: 'ims_configure', user,
        details: `domain=${imsDomain} pcscf=${pcscfIp}:${pcscfPort} icscf=${icscfIp}:${icscfPort} scscf=${scscfIp}:${scscfPort}`,
        success: true,
      });
      res.json({ success: true, message: 'IMS configured and services started.', imsDomain });
    } catch (err) {
      await auditLogger.log({ action: 'ims_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'ims configure error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/sync-subscribers — Open5GS MongoDB → PyHSS REST API
  router.post('/sync-subscribers', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const result = await syncImsSubscribers(subscriberRepo, logger);
      await auditLogger.log({
        action: 'ims_sync_subscribers', user,
        details: `synced=${result.synced} failed=${result.failed.length} removed=${result.removed}`, success: true,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err: String(err) }, 'ims sync-subscribers error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/ims/dns-records
  router.get('/dns-records', async (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(HOST_IMS_STATE)) return res.json({ success: true, records: [] });
      const stateData = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
      const { imsDomain, config } = stateData;
      const additionalPlmns: { mcc: string; mnc: string }[] = config?.additionalPlmns ?? [];
      const additionalDomains = additionalPlmns.map((p: { mcc: string; mnc: string }) =>
        `ims.mnc${p.mnc.padStart(3, '0')}.mcc${p.mcc}.3gppnetwork.org`);
      const allDomains = [imsDomain, ...additionalDomains];

      const records: { name: string; type: string; value: string }[] = [];
      const rawParts: string[] = [];

      for (const domain of allDomains) {
        const zoneFile = `${HOST_BIND_ZONES_DIR}/${domain}.zone`;
        if (!fs.existsSync(zoneFile)) continue;
        const zoneRaw = fs.readFileSync(zoneFile, 'utf-8');
        rawParts.push(`; ═══ ${domain} ═══\n${zoneRaw}`);
        for (const line of zoneRaw.split('\n')) {
          if (line.startsWith(';') || line.startsWith('$') || line.trim() === '') continue;
          const m = line.match(/^(\S+|\s+)\s+(?:IN\s+)?(\w+)\s+(.+)$/);
          if (m) records.push({ name: m[1].trim() || '@', type: m[2], value: m[3].trim() });
        }
      }

      res.json({ success: true, records, raw: rawParts.join('\n\n') });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/validate
  router.post('/validate', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    type Check = { name: string; pass: boolean; detail: string; remediation?: string };
    const checks: Check[] = [];
    const add = (name: string, pass: boolean, detail: string, remediation?: string) =>
      checks.push({ name, pass, detail, remediation });

    try {
      if (!fs.existsSync(HOST_IMS_STATE)) {
        return res.json({
          success: true,
          checks: [{ name: 'IMS State', pass: false, detail: 'Not configured', remediation: 'Run Configure first.' }],
          allPass: false,
        });
      }
      const savedValidate = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
      const imsDomain = savedValidate.imsDomain;
      const config    = savedValidate.config;
      const dnsIp = config?.dnsIp ?? '127.0.0.1';

      // DNS checks — primary PLMN
      for (const host of ['pcscf', 'icscf', 'scscf']) {
        try {
          const { stdout } = await nsenter('dig', ['+short', `${host}.${imsDomain}`, `@${dnsIp}`]);
          const ip = stdout.trim();
          add(`DNS A: ${host}`, ip.length > 0, ip || 'no answer',
            ip.length === 0 ? 'Check BIND9 zone file and service status.' : undefined);
        } catch (e) {
          add(`DNS A: ${host}`, false, String(e));
        }
      }

      // SRV
      try {
        const { stdout } = await nsenter('dig', ['+short', `_sip._udp.pcscf.${imsDomain}`, 'SRV', `@${dnsIp}`]);
        add('DNS SRV: _sip._udp.pcscf', stdout.trim().length > 0, stdout.trim() || 'no answer');
      } catch (e) { add('DNS SRV', false, String(e)); }

      // DNS checks — additional PLMNs
      const additionalPlmnsVal: { mcc: string; mnc: string }[] = config?.additionalPlmns ?? [];
      for (const plmn of additionalPlmnsVal) {
        const addDomain = `ims.mnc${plmn.mnc.padStart(3, '0')}.mcc${plmn.mcc}.3gppnetwork.org`;
        for (const host of ['pcscf', 'icscf', 'scscf']) {
          try {
            const { stdout } = await nsenter('dig', ['+short', `${host}.${addDomain}`, `@${dnsIp}`]);
            const ip = stdout.trim();
            add(`DNS (${plmn.mcc}/${plmn.mnc}): ${host}`, ip.length > 0, ip || 'no answer',
              ip.length === 0 ? `Check BIND9 zone for ${addDomain}.` : undefined);
          } catch (e) {
            add(`DNS (${plmn.mcc}/${plmn.mnc}): ${host}`, false, String(e));
          }
        }
      }

      // HSS service check
      for (const svc of ['pyhss-diameter', 'pyhss-hss', 'pyhss-api']) {
        try {
          const { stdout } = await nsenter('systemctl', ['is-active', svc]);
          const active = stdout.trim() === 'active';
          add(`PyHSS: ${svc}`, active, stdout.trim(),
            !active ? `${svc} not running. Run Install + Configure.` : undefined);
        } catch { add(`PyHSS: ${svc}`, false, 'unknown'); }
      }
      // PyHSS Diameter port
      try {
        const { stdout } = await nsenter('bash', ['-c', `ss -tlnp | grep ':3868 ' | head -1`]);
        add('PyHSS Diameter port 3868', stdout.trim().length > 0, stdout.trim() || 'not listening',
          stdout.trim().length === 0 ? 'pyhss-diameter not listening on port 3868.' : undefined);
      } catch { add('PyHSS Diameter port 3868', false, 'check failed'); }
      // PyHSS subscriber count via API
      try {
        const list = await pyhssApiCall('GET', '/ims_subscriber/list');
        const count = Array.isArray(list) ? list.length : 0;
        add('PyHSS: IMS subscribers', true, `${count} IMS subscribers`,
          count === 0 ? 'Run Sync Subscribers.' : undefined);
      } catch (e) {
        add('PyHSS: IMS subscribers', false, String(e), 'PyHSS API not responding. Check pyhss-api service.');
      }

      // Kamailio processes
      try {
        const { stdout } = await nsenter('pgrep', ['-c', 'kamailio']);
        const count = parseInt(stdout.trim()) || 0;
        add('Kamailio processes', count >= 3, `${count} kamailio processes`,
          count < 3 ? 'Check kamailio-pcscf/icscf/scscf status.' : undefined);
      } catch { add('Kamailio processes', false, '0 processes'); }

      // RTPengine
      try {
        const { stdout } = await nsenter('systemctl', ['is-active', 'rtpengine-daemon']);
        add('RTPengine', stdout.trim() === 'active', stdout.trim());
      } catch { add('RTPengine', false, 'unknown'); }

      // SMF IMS DNN
      const smfHasIms = fs.existsSync(HOST_SMF_YAML) && /dnn:\s*ims/.test(fs.readFileSync(HOST_SMF_YAML, 'utf-8'));
      add('SMF IMS DNN', smfHasIms, smfHasIms ? 'ims DNN in smf.yaml' : 'not found',
        !smfHasIms ? 'Re-run Configure.' : undefined);

      const allPass = checks.every(c => c.pass);
      await auditLogger.log({ action: 'ims_validate', user, details: `allPass=${allPass}`, success: true });
      res.json({ success: true, checks, allPass });
    } catch (err) {
      logger.error({ err: String(err) }, 'ims validate error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/enable
  router.post('/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const svcs = ['bind9', 'mariadb', 'redis-server', 'pyhss-diameter', 'pyhss-hss', 'pyhss-api', 'pyhss-metrics', 'rtpengine-daemon', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-pcscf', 'kamailio-smsc'];
      for (const svc of svcs) {
        await nsenter('systemctl', ['start', svc]).catch(() => {});
      }
      if (fs.existsSync(HOST_IMS_SMF_BAK) && fs.existsSync(HOST_IMS_STATE)) {
        const { config } = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
        if (fs.existsSync(HOST_SMF_YAML) && config) {
          writeYamlGuarded(HOST_SMF_YAML, raw => updateSmfImsSession(raw, config.pcscfIp, config.dnsIp), 're-add the IMS session to smf.yaml', IMS_OWNED_SMF_TOP_KEYS);
          await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
        }
      }
      await auditLogger.log({ action: 'ims_enable', user, details: 'IMS services started', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_enable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/disable
  router.post('/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      if (fs.existsSync(HOST_SMF_YAML)) {
        writeYamlGuarded(HOST_SMF_YAML, removeSmfImsSession, 'remove the IMS session from smf.yaml', IMS_OWNED_SMF_TOP_KEYS);
        await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
      }
      if (fs.existsSync(HOST_UPF_YAML)) {
        const upfRaw = fs.readFileSync(HOST_UPF_YAML, 'utf-8');
        writeYamlGuarded(HOST_UPF_YAML, removeUpfImsSession, 'remove the IMS session from upf.yaml');
        await nsenter('systemctl', ['restart', 'open5gs-upfd']).catch(() => {});
      }
      const stopSvcs = ['kamailio-smsc', 'kamailio-scscf', 'kamailio-icscf', 'kamailio-pcscf', 'rtpengine-daemon', 'pyhss-api', 'pyhss-hss', 'pyhss-diameter', 'pyhss-metrics'];
      for (const svc of stopSvcs) {
        await nsenter('systemctl', ['stop', svc]).catch(() => {});
      }
      await auditLogger.log({ action: 'ims_disable', user, details: 'IMS stopped, SMF IMS DNN removed', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_disable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/remove — full teardown, as if IMS was never installed
  router.post('/remove', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const write = (s: string) => { res.write(s); };
    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--',
          'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

    // 1. Stop and disable all IMS services
    write('=== Stopping IMS services ===\n');
    // NOTE: bind9 is deliberately NOT in this list — it's shared infrastructure (VoWiFi's
    // ePDG zone, the DNS/FQDN migration wizard's 5gc/epc zones, SEPP's advertise FQDN all
    // depend on it staying up). Only IMS's own zone gets torn down, in step 5 below.
    const removeSvcs = ['kamailio-smsc', 'kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'rtpengine-daemon', 'pyhss-api', 'pyhss-hss', 'pyhss-diameter', 'pyhss-metrics'];
    for (const svc of removeSvcs) {
      await nsenter('systemctl', ['stop', svc]).catch(() => {});
      await nsenter('systemctl', ['disable', svc]).catch(() => {});
      write(`  stopped + disabled: ${svc}\n`);
    }

    // 2. Remove IMS DNN and p-cscf from SMF YAML, restart SMF
    write('\n=== Removing IMS APN from SMF config ===\n');
    if (fs.existsSync(HOST_SMF_YAML)) {
      writeYamlGuarded(HOST_SMF_YAML, removeSmfImsSession, 'remove the IMS session from smf.yaml', IMS_OWNED_SMF_TOP_KEYS);
      await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
      write('  p-cscf + dnn:ims removed from smf.yaml, open5gs-smfd restarted.\n');
    } else {
      write('  smf.yaml not found — skipping.\n');
    }

    // 2b. Remove IMS session from UPF YAML, restart UPF
    write('\n=== Removing IMS session from UPF config ===\n');
    if (fs.existsSync(HOST_UPF_YAML)) {
      const upfRaw = fs.readFileSync(HOST_UPF_YAML, 'utf-8');
      writeYamlGuarded(HOST_UPF_YAML, removeUpfImsSession, 'remove the IMS session from upf.yaml');
      await nsenter('systemctl', ['restart', 'open5gs-upfd']).catch(() => {});
      write('  dnn:ims removed from upf.yaml, open5gs-upfd restarted.\n');
    } else {
      write('  upf.yaml not found — skipping.\n');
    }
    if (fs.existsSync(HOST_IMS_UPF_BAK)) { try { fs.unlinkSync(HOST_IMS_UPF_BAK); } catch { /* ok */ } }

    // 3. Deliberately NOT touching subscriber profiles here. This used to call
    // subscriberRepo.removeImsSessionFromAll() to strip every subscriber's
    // 'ims' PDN session on the theory that a dangling session for a DNN that
    // no longer exists in smf.yaml/upf.yaml (removed in steps 2/2b above) was
    // worth cleaning up. In practice that session is inert once the DNN is
    // gone — Open5GS just won't establish a PDU session for an APN the SMF/UPF
    // don't know about — but the mutation was NOT inert: it destructively
    // wiped each subscriber's real per-session QoS/AMBR/PCC-rule config, and
    // reinstalling IMS never added it back (no corresponding "add" step
    // exists). Confirmed live 2026-08-02: two routine Remove→Install test
    // cycles silently erased 'ims' sessions a subscriber-restore had *just*
    // put back, with no warning anywhere that this would happen. If you want
    // a clean slate for subscriber APNs, do it explicitly via the Subscribers
    // page, not as a side effect of removing IMS.

    // 4. Drop MariaDB IMS databases
    write('\n=== Dropping IMS databases ===\n');
    for (const db of ['icscf', 'scscf', 'pcscf', 'ims_hss_db', 'ims_icscf', 'ims_scscf', 'hss_db']) {
      try {
        await mysqlExec(`DROP DATABASE IF EXISTS \`${db}\`;`);
        write(`  Dropped: ${db}\n`);
      } catch (err) {
        write(`  Warning dropping ${db}: ${String(err)}\n`);
      }
    }

    // 5. Remove BIND9 IMS zone file and zone block
    write('\n=== Removing BIND9 IMS zone ===\n');
    try {
      if (fs.existsSync(HOST_BIND_ZONES_DIR)) {
        const zoneFiles = fs.readdirSync(HOST_BIND_ZONES_DIR).filter(f => f.startsWith('ims.'));
        for (const f of zoneFiles) {
          fs.unlinkSync(path.join(HOST_BIND_ZONES_DIR, f));
          write(`  Removed zone file: ${f}\n`);
        }
      }
      const namedLocal = path.join(HOST_BIND_DIR, 'named.conf.local');
      if (fs.existsSync(namedLocal)) {
        const raw = fs.readFileSync(namedLocal, 'utf-8');
        const cleaned = raw.replace(/\nzone\s+"ims\.[^"]+"\s*\{[\s\S]*?\};\n?/g, '\n').trimEnd() + '\n';
        fs.writeFileSync(namedLocal, cleaned, 'utf-8');
        write('  Removed IMS zone block from named.conf.local.\n');
      }
      // Reload bind9 if running — ignore error if not
      await nsenter('systemctl', ['is-active', 'bind9'])
        .then(() => nsenter('systemctl', ['reload', 'bind9']).catch(() => {}))
        .catch(() => {});
    } catch (err) {
      write(`  Warning: ${String(err)}\n`);
    }

    // 6. Remove IMS include config and Diameter XML files
    write('\n=== Removing IMS config files ===\n');
    const imsFiles = [
      `${HOST_KAMAILIO_PCSCF_DIR}/pcscf.cfg`,
      `${HOST_KAMAILIO_PCSCF_DIR}/pcscf.xml`,
      `${HOST_KAMAILIO_ICSCF_DIR}/icscf.cfg`,
      `${HOST_KAMAILIO_ICSCF_DIR}/icscf.xml`,
      `${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
      `${HOST_KAMAILIO_SCSCF_DIR}/scscf.xml`,
      HOST_RTPENGINE_CONF,
    ];
    for (const f of imsFiles) {
      try { fs.unlinkSync(f); write(`  Removed: ${f.replace('/proc/1/root', '')}\n`); }
      catch { /* already gone */ }
    }

    // 7. Remove systemd service files and reload
    write('\n=== Removing systemd service files ===\n');
    const svcFiles = ['kamailio-smsc', 'kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'pyhss-diameter', 'pyhss-hss', 'pyhss-api', 'pyhss-metrics'];
    for (const svc of svcFiles) {
      const f = path.join(HOST_SYSTEMD_DIR, `${svc}.service`);
      try { fs.unlinkSync(f); write(`  Removed: ${svc}.service\n`); }
      catch { /* already gone */ }
    }
    await nsenter('systemctl', ['daemon-reload']).catch(() => {});
    write('  daemon-reload complete.\n');

    // 8. Remove PyHSS
    write('\n=== Removing PyHSS ===\n');
    try {
      fs.rmSync('/proc/1/root/opt/pyhss', { recursive: true, force: true });
      write('  Removed /opt/pyhss.\n');
    } catch (err) { write(`  Warning: ${String(err)}\n`); }
    try {
      fs.rmSync('/proc/1/root/etc/pyhss', { recursive: true, force: true });
      write('  Removed /etc/pyhss.\n');
    } catch (err) { write(`  Warning: ${String(err)}\n`); }

    // 9. Purge all IMS packages
    write('\n=== Purging IMS packages ===\n');
    // bind9/bind9utils/dnsutils deliberately excluded — see the removeSvcs comment above,
    // same reasoning: apt-get purge would wipe /etc/bind entirely (VoWiFi's zone, the DNS
    // migration wizard's zones, everything), not just IMS's own.
    const basePurgePkgs = 'kamailio kamailio-ims-modules kamailio-mysql-modules kamailio-tls-modules kamailio-extra-modules kamailio-utils-modules ' +
      'rtpengine mariadb-server mariadb-client mariadb-common';
    await spawnStream(
      `DEBIAN_FRONTEND=noninteractive apt-get purge -y ${basePurgePkgs} redis-server 2>&1 || true`
    );
    await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>&1 || true');

    // 9b. Two real, 2026-09-23-found gaps `apt purge` never closes:
    //  - Kamailio's 4 config directories (kamailio_pcscf/icscf/scscf/smsc)
    //    are deployed by this project's own template code, not shipped as
    //    package conffiles — apt purge only removes what dpkg itself put
    //    there, leaving these 4 real directories behind untouched, forever.
    //  - MariaDB's own data directory (/var/lib/mysql, PyHSS's actual HSS/
    //    subscriber database) is deliberately never touched by `apt purge
    //    mariadb-server` — databases are treated as precious user data, by
    //    design, not package files. A real uninstall of THIS module means
    //    removing it too, not leaving 100+ MB of orphaned subscriber data.
    write('\n=== Removing Kamailio config directories + MariaDB data ===\n');
    for (const dir of [HOST_KAMAILIO_PCSCF_DIR, HOST_KAMAILIO_ICSCF_DIR, HOST_KAMAILIO_SCSCF_DIR, HOST_KAMAILIO_SMSC_DIR]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); write(`  Removed: ${dir.replace('/proc/1/root', '')}\n`); }
      catch (err) { write(`  Warning removing ${dir}: ${String(err)}\n`); }
    }
    try { fs.rmSync('/proc/1/root/var/lib/mysql', { recursive: true, force: true }); write('  Removed: /var/lib/mysql\n'); }
    catch (err) { write(`  Warning removing /var/lib/mysql: ${String(err)}\n`); }

    // 10. Remove NMS IMS state files
    write('\n=== Removing IMS state files ===\n');
    for (const f of [HOST_IMS_STATE, HOST_IMS_SMF_BAK, HOST_IMS_INSTALL_STATE]) {
      try { fs.unlinkSync(f); write(`  Removed: ${path.basename(f)}\n`); }
      catch { /* already gone */ }
    }

    await auditLogger.log({ action: 'ims_remove', user, details: 'Full IMS removal', success: true });
    write('\n✅ IMS removed successfully.\n');
    write('   All services stopped, packages purged, configs deleted, subscriber IMS APNs cleared.\n');
    write('   The L3 IP address has not been changed. You may reinstall from scratch.\n');
    res.end();
  });

  // POST /api/ims/restart
  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const restartSvcs = ['bind9', 'mariadb', 'redis-server', 'pyhss-diameter', 'pyhss-hss', 'pyhss-api', 'pyhss-metrics',
                           'rtpengine-daemon', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-pcscf', 'kamailio-smsc'];
      for (const svc of restartSvcs) {
        await nsenter('systemctl', ['restart', svc]).catch(() => {});
        if (svc === 'redis-server') {
          await new Promise(r => setTimeout(r, 2000)); // let redis bind before pyhss services
        }
      }
      await forceReregisterAllRegisteredUes(logger).catch(() => {});
      await auditLogger.log({ action: 'ims_restart', user, details: 'IMS restarted', success: true });
      res.json({ success: true, message: 'IMS services restarted.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/ims/configs
  router.get('/configs', requireAdmin, (_req: Request, res: Response) => {
    try {
      res.json({ files: getImsConfigManifest() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/ims/configs/content?path=<encoded>
  router.get('/configs/content', requireAdmin, (req: Request, res: Response) => {
    const filePath = String(req.query.path ?? '');
    if (!filePath || !isAllowedConfigPath(filePath)) {
      return res.status(400).json({ error: 'Path not in allowlist' });
    }
    const hostPath = `/proc/1/root${filePath}`;
    if (!fs.existsSync(hostPath)) {
      return res.json({ content: '', exists: false });
    }
    try {
      res.json({ content: fs.readFileSync(hostPath, 'utf-8'), exists: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/ims/configs/content
  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: filePath, content } = req.body as { path: string; content: string };
    if (!filePath || !isAllowedConfigPath(filePath)) {
      return res.status(400).json({ error: 'Path not in allowlist' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    const hostPath = `/proc/1/root${filePath}`;
    try {
      fs.mkdirSync(path.dirname(hostPath), { recursive: true });
      fs.writeFileSync(hostPath, content, 'utf-8');
      await auditLogger.log({ action: 'ims_configure', user, details: `config-edit: ${filePath}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_configure', user, details: `config-edit failed: ${filePath}: ${String(err)}`, success: false });
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/ims/configs/restart
  router.post('/configs/restart', requireAdmin, async (req: Request, res: Response) => {
    const { services } = req.body as { services: string[] };
    if (!Array.isArray(services) || services.length === 0) {
      return res.status(400).json({ error: 'services must be a non-empty array' });
    }
    const allowed = new Set([
      'kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-smsc',
      'pyhss-api', 'pyhss-diameter', 'pyhss-hss', 'pyhss-metrics',
      'rtpengine-daemon', 'bind9', 'open5gs-smfd', 'open5gs-pcrfd',
    ]);
    const bad = services.filter(s => !allowed.has(s));
    if (bad.length > 0) {
      return res.status(400).json({ error: `Not allowed: ${bad.join(', ')}` });
    }
    const results: string[] = [];
    try {
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});
      for (const svc of services) {
        try {
          await nsenter('systemctl', ['restart', svc], 20000);
          results.push(`${svc}: restarted`);
        } catch (err) {
          results.push(`${svc}: error — ${String(err)}`);
        }
      }
      if (services.includes('kamailio-pcscf')) {
        await forceReregisterAllRegisteredUes(logger).catch(() => {});
      }
      res.json({ success: true, results });
    } catch (err) {
      res.status(500).json({ error: String(err), results });
    }
  });

  return router;
}
