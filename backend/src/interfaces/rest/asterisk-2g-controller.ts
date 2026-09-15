import { Router, Request, Response } from 'express';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { Collection, MongoClient } from 'mongodb';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { getAppVersion } from '../../infrastructure/system/app-version';
import {
  verifyOsmoSipConnectorBuild, osmoSipConnectorCfg, osmoSipConnectorSystemdUnit,
  CFG_PATH as SIPCONN_CFG_PATH, UNIT_PATH as SIPCONN_UNIT_PATH, MNCC_SOCKET_PATH,
} from '../../application/use-cases/osmo-sip-connector-build';

// ── Asterisk-2G (2G<->2G internal voice) ─────────────────────────────────────
//
// A second, fully independent Asterisk instance dedicated to real 2G-to-2G
// voice calling, kept completely isolated from the existing PSTN Gateway's
// Asterisk (pstn-controller.ts) — different config tree, different systemd
// unit, different loopback IP. Neither instance's code ever touches the
// other's files, service, or apt package lifecycle (see uninstall below).
//
// Why this exists: confirmed live 2026-09-13 via real call testing that
// osmo-msc's internal/built-in MNCC handler (mncc_builtin.c, upstream
// Osmocom) never implements MNCC_RTP_CREATE — signaling completes (ring,
// answer) but no RTP bridge is ever created, so a real 2G<->2G call always
// hangs and times out. The only way to get real audio is external MNCC via
// osmo-sip-connector (already built — see osmo-sip-connector-build.ts and
// the GSM page's SIP tab), which itself does zero call routing of its own —
// confirmed both in this project's own code comments and via external
// Osmocom documentation, it's a dumb single-peer MNCC<->SIP signaling relay
// that never touches RTP/codecs either. This Asterisk instance is that one
// "remote" peer: its dialplan does the one thing osmo-sip-connector can't —
// recognize that a dialed number is a local 2G subscriber and re-originate
// the call back out through the same trunk, which is what actually lets
// osmo-msc page/ring the second phone. See "why this isn't an infinite
// loop" comment on extensions2gConf() below.
//
// Codec is GSM-FR only (allow=gsm), matching what the real BTS/BSC/MSC chain
// actually negotiates today (confirmed live: chan_mode=SPEECH_V1, chan_type=
// FR) — osmo-sip-connector does no codec translation, so this endpoint must
// speak exactly what the real call leg produces, nothing else.

const execFileAsync = promisify(execFile);

const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

const HOST_ROOT = '/proc/1/root';
const STOCK_ASTERISK_CONF = `${HOST_ROOT}/etc/asterisk/asterisk.conf`;

// Own, fully separate directory tree — never overlaps with the stock
// /etc/asterisk (PSTN Gateway's own instance, never touched by this file).
const A2G_ETC     = '/etc/asterisk-2g';
const A2G_VARLIB  = '/var/lib/asterisk-2g';
const A2G_SPOOL   = '/var/spool/asterisk-2g';
const A2G_LOG     = '/var/log/asterisk-2g';
const A2G_CACHE   = '/var/cache/asterisk-2g';
const A2G_RUN     = '/run/asterisk-2g';
const A2G_CONF    = `${A2G_ETC}/asterisk.conf`;
const A2G_PJSIP   = `${A2G_ETC}/pjsip.conf`;
const A2G_EXTEN   = `${A2G_ETC}/extensions.conf`;
const A2G_MODULES = `${A2G_ETC}/modules.conf`;
const A2G_RTP     = `${A2G_ETC}/rtp.conf`;

const SYSTEMD_UNIT      = 'asterisk-2g';
const SYSTEMD_UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}.service`;
const TMPFILES_PATH     = '/etc/tmpfiles.d/asterisk-2g.conf';

const HOST_STATE       = `${HOST_ROOT}/etc/open5gs/.asterisk2g-config.json`;
const HOST_GSM_STATE   = `${HOST_ROOT}/etc/osmocom/.nms-gsm-bts-state.json`;

// This project's per-daemon dedicated-loopback-alias convention: .1-.3=IMS
// (I-CSCF/S-CSCF/HSS), .4=Asterisk (PSTN Gateway), .5=VectorCore SMSC,
// .6=osmo-sip-connector. .7 is next free — confirmed live 2026-09-13 (not in
// `ip addr show lo`, nothing bound on it in `ss -lunp`).
const DEFAULT_BIND_IP = '127.0.1.7';
const BIND_PORT = 5060;

// GSM-FR only, on purpose — see module header. RTP port range is this
// instance's own, distinct from PSTN's (which only ever patches strictrtp
// and otherwise runs on Asterisk's compiled-in 5000-31000 default) — full
// non-overlap isn't achievable without touching PSTN's own rtp.conf
// (forbidden), but that's fine: each instance is a separate OS process with
// its own socket namespace, and Asterisk's own RTP allocator just tries the
// next candidate port on EADDRINUSE rather than failing a call.
const RTP_PORT_MIN = 12000;
const RTP_PORT_MAX = 14000;

interface Asterisk2gState {
  bindIp: string;
  bindPort: number;
  // Dialplan pattern for "this destination is a locally-valid subscriber
  // number" (Asterisk exten-pattern syntax). Defaults to a catch-all: safe
  // in this specific topology since this instance has exactly one trunk
  // (sipconn) to route to regardless — there's nowhere for a "wrong" number
  // to leak to even without range-gating. Tighten to a real numbering-plan
  // pattern (e.g. '_1555X.') any time via Configure without any code change.
  msisdnMatchPattern: string;
  // Exact-match dialplan extension (not a pattern) for a 2G-only Asterisk
  // Echo() test — dial it from any 2G phone to hear your own audio looped
  // back, no second phone or subscriber needed. Asterisk always prefers an
  // exact literal extension over a `_`-prefixed pattern match in the same
  // context, so this coexists with msisdnMatchPattern's catch-all without
  // reordering anything. Chosen short ("600") so it can never collide with
  // this deployment's real MSISDNs, which are all 11 digits.
  echoTestNumber: string;
  installedWithVersion?: string;
  configuredWithVersion?: string;
  // Follower copy of the Cross-RAN Calling toggle — pstn-controller.ts's own
  // PstnState.crossRanEnabled is the source of truth the UI reads/writes
  // (the toggle button lives on the Voice Gateway page, backed by pstnApi);
  // this copy exists so THIS module's own independent regen paths
  // (regenerateExtensions2g, configureAsterisk2g) know whether to keep
  // including the cross-RAN forwarding blocks when something on THIS side
  // alone triggers a regen (e.g. an ordinary 2G short code add/remove).
  // Only ever written by setCrossRanPeer() below — never toggled directly
  // via a route on this module. See CLAUDE.md's Cross-RAN Calling entry.
  crossRanEnabled?: boolean;
}

const STATE_DEFAULTS: Asterisk2gState = {
  bindIp: DEFAULT_BIND_IP,
  bindPort: BIND_PORT,
  msisdnMatchPattern: '_X.',
  echoTestNumber: '600',
};

function readState(): Asterisk2gState | null {
  if (!fs.existsSync(HOST_STATE)) return null;
  try { return { ...STATE_DEFAULTS, ...JSON.parse(fs.readFileSync(HOST_STATE, 'utf-8')) }; } catch { return null; }
}

function writeState(state: Asterisk2gState): void {
  fs.mkdirSync(`${HOST_ROOT}/etc/open5gs`, { recursive: true });
  fs.writeFileSync(HOST_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

export interface Asterisk2gConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
}

// Own, fully separate directory tree (see A2G_ETC's own comment above) — no
// shared/sharedWith flags needed, unlike gsm-controller.ts's manifest.
const A2G_CONFIG_MANIFEST: Omit<Asterisk2gConfigFile, 'exists'>[] = [
  { path: `${HOST_ROOT}${A2G_CONF}`,    label: 'asterisk.conf',    group: '2G Voice Gateway', language: 'ini', restartServices: [SYSTEMD_UNIT] },
  { path: `${HOST_ROOT}${A2G_PJSIP}`,   label: 'pjsip.conf',       group: '2G Voice Gateway', language: 'ini', restartServices: [SYSTEMD_UNIT] },
  { path: `${HOST_ROOT}${A2G_EXTEN}`,   label: 'extensions.conf',  group: '2G Voice Gateway', language: 'ini', restartServices: [SYSTEMD_UNIT] },
  { path: `${HOST_ROOT}${A2G_MODULES}`, label: 'modules.conf',     group: '2G Voice Gateway', language: 'ini', restartServices: [SYSTEMD_UNIT] },
  { path: `${HOST_ROOT}${A2G_RTP}`,     label: 'rtp.conf',         group: '2G Voice Gateway', language: 'ini', restartServices: [SYSTEMD_UNIT] },
];
const A2G_ALLOWED_PATHS = new Set(A2G_CONFIG_MANIFEST.map(f => f.path));

// Cheap, read-only check consumed by pstn-controller.ts's own uninstall —
// the two Asterisk instances share the same apt package, so PSTN's uninstall
// needs to know not to purge it out from under this module. Deliberately a
// tiny, one-way dependency (PSTN reads this module's presence) rather than
// the reverse — this module never needs to know anything about PSTN, with
// one narrow, deliberate exception: Cross-RAN Calling (setCrossRanPeer,
// listGsm2gShortCodesForCrossRan, getAsterisk2gEchoTestNumber,
// getAsterisk2gBindAddress below) genuinely needs data from both sides. Since
// PSTN -> here was already established safe as a static import, the reverse
// direction (this file needing PSTN's own data) uses a LAZY
// `await import('./pstn-controller')` at just the two call sites that need
// it (getCrossRanPeerCodes, setCrossRanPeer, and the /extensions collision
// guard) instead of a static import, specifically to avoid turning this into
// a real load-time circular dependency. See CLAUDE.md's Cross-RAN Calling
// pattern entry for the full ownership map.
export function isAsterisk2gInstalled(): boolean {
  return fs.existsSync(`${HOST_ROOT}${A2G_CONF}`);
}

// Reads osmo-sip-connector's own live bind address straight out of GSM
// module's state file — never hardcoded, never re-typed by the operator here,
// same "read the one real source of truth" instinct as sms-controller.ts's
// getMscVtyHost(). Returns null (blocking Configure with a clear error) if
// GSM's SIP tab has no concrete local address configured yet — a wildcard/
// empty bind means `type=identify match=` below would mean nothing.
function readGsmSipPeer(): { ip: string; port: number } | null {
  if (!fs.existsSync(HOST_GSM_STATE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(HOST_GSM_STATE, 'utf-8'));
    const ip = state?.sip?.localIp as string | undefined;
    const port = state?.sip?.localPort as number | undefined;
    if (!ip || ip === '0.0.0.0' || !port) return null;
    return { ip, port };
  } catch {
    return null;
  }
}

// Merge-write ONLY sip.remoteHost/remotePort into GSM's own state file —
// never a full overwrite, so btsEntries/GPRS settings/everything else this
// module knows nothing about survives untouched. This is what keeps the SIP
// tab's own displayed value in sync after Configure wires things up below —
// without this, the live osmo-sip-connector.cfg and the SIP tab's own
// (stale) form state would silently disagree.
function updateGsmSipRemote(remoteHost: string, remotePort: number): void {
  const state = fs.existsSync(HOST_GSM_STATE) ? JSON.parse(fs.readFileSync(HOST_GSM_STATE, 'utf-8')) : {};
  state.sip = { ...(state.sip ?? {}), remoteHost, remotePort };
  fs.writeFileSync(HOST_GSM_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// Wires this instance in as osmo-sip-connector's "remote" and flips osmo-msc
// to external MNCC — done here, from THIS module's own Configure, rather
// than automatically from anything else. Deliberately narrower than a
// general "auto-wire the SIP tab" rule (which this project explicitly
// avoids elsewhere, e.g. gsm-controller.ts's own /sip/configure never does
// this for whatever the operator points "remote" at): this module's entire
// purpose is being that remote target, so wiring itself in as part of its
// own explicit Configure action isn't a surprising side effect on some
// unrelated config — it's the one thing this module exists to do. Real
// user feedback, 2026-09-13: a fully separate 3-click flow (install here,
// then two more clicks on the SIP tab) had no clear reason to stay manual
// once this module's whole job is being that one specific peer.
async function wireIntoSipTabAndGoExternal(bindIp: string, bindPort: number, gsmLocal: { ip: string; port: number }): Promise<void> {
  fs.mkdirSync('/proc/1/root/etc/osmocom', { recursive: true });
  fs.writeFileSync(`${HOST_ROOT}${SIPCONN_CFG_PATH}`, osmoSipConnectorCfg(gsmLocal.ip, gsmLocal.port, bindIp, bindPort), 'utf-8');
  fs.writeFileSync(`${HOST_ROOT}${SIPCONN_UNIT_PATH}`, osmoSipConnectorSystemdUnit(), 'utf-8');
  await nsenter('systemctl', ['daemon-reload']);
  const wasActive = (await nsenter('systemctl', ['is-active', 'osmo-sip-connector']).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim() === 'active';
  await nsenter('systemctl', [wasActive ? 'restart' : 'enable', ...(wasActive ? [] : ['--now']), 'osmo-sip-connector']);
  updateGsmSipRemote(bindIp, bindPort);
  const { setMscMnccMode } = await import('./sms-controller');
  await setMscMnccMode('external', MNCC_SOCKET_PATH);
}

// astmoddir/astdatadir are derived live from the STOCK instance's own
// asterisk.conf rather than hardcoded — avoids baking in a specific distro/
// arch multiarch triplet path. Falls back to the real Ubuntu 24.04 x86_64
// values only if the stock file is ever genuinely unreadable (shouldn't
// happen — PSTN's own Asterisk install, an install-time prerequisite here
// too, writes it).
function deriveStockDir(key: string, fallback: string): string {
  try {
    const raw = fs.readFileSync(STOCK_ASTERISK_CONF, 'utf-8');
    const m = raw.match(new RegExp(`^\\s*${key}\\s*=>\\s*(.+)$`, 'm'));
    if (m) return m[1].trim();
  } catch { /* fall through to default below */ }
  return fallback;
}

// ── Config generation ─────────────────────────────────────────────────────

// [directories] overrides every per-instance runtime path (etc/varlib/db/
// key/spool/run/log/cache) but deliberately keeps astmoddir AND astdatadir/
// astagidir shared with the stock instance — astdatadir (/usr/share/asterisk)
// is real, package-installed, read-only content (documentation XML, sounds,
// moh, static-http), not per-instance runtime state, and astagidir lives
// *under* astdatadir in the real stock config, not under astvarlibdir.
//
// Real bug found live 2026-09-13, the hard way: an earlier version of this
// function pointed astdatadir/astagidir at this instance's own (empty)
// astvarlibdir instead of the real, shared /usr/share/asterisk — Asterisk
// started, then immediately died with "Stasis initialization failed.
// ASTERISK EXITING!" preceded by a wall of "Couldn't find manager DBGet in
// XML documentation" warnings for stasis's own manager actions. Root cause:
// Stasis's own module-doc registration reads its XML from astdatadir/
// documentation/*.xml, which doesn't exist anywhere under an empty runtime
// dir — confirmed fixed by pointing astdatadir back at the real, shared
// package path (derived live below, not hardcoded).
//
// Deliberately NO "(!)" after [directories], even though the real stock
// asterisk.conf on this host has it. Second real bug found live 2026-09-13,
// right after the astdatadir one above: with "(!)" present, this instance's
// astrundir override was silently never applied — Asterisk kept checking
// the STOCK compiled-in default path (/var/run/asterisk/asterisk.ctl) for
// its own "already running?" startup guard, failing every launch with
// "Asterisk already running on /var/run/asterisk/asterisk.ctl" even though
// nothing was actually using this instance's own /run/asterisk-2g at all.
// The stock config "works" with "(!)" purely by coincidence: every one of
// its own override values is IDENTICAL to Asterisk's compiled-in default
// (/var/run/asterisk, /var/lib/asterisk, etc.), so nobody would ever notice
// the marker was silently no-op'ing those directives there. Confirmed fixed
// live by removing it — do not add it back without re-verifying this.
function asterisk2gConfTemplate(astmoddir: string, astdatadir: string): string {
  return `[directories]
astcachedir => ${A2G_CACHE}
astetcdir => ${A2G_ETC}
astmoddir => ${astmoddir}
astvarlibdir => ${A2G_VARLIB}
astdbdir => ${A2G_VARLIB}
astkeydir => ${A2G_VARLIB}
astdatadir => ${astdatadir}
astagidir => ${astdatadir}/agi-bin
astspooldir => ${A2G_SPOOL}
astrundir => ${A2G_RUN}
astlogdir => ${A2G_LOG}
astsbindir => /usr/sbin

[options]
`;
}

function pjsip2gConf(bindIp: string, bindPort: number, sipConnIp: string, sipConnPort: number, crossRanPeer: { ip: string; port: number } | null): string {
  // Cross-RAN Calling: peers with the PSTN Gateway's own Asterisk instance
  // so a call to a 4G/5G short code can be dialed from this side and vice
  // versa. Written/removed only by setCrossRanPeer() below, orchestrated
  // from pstn-controller.ts's setCrossRanCalling() — never toggled directly
  // from a route on this module. Reuses transport-2g (a PJSIP transport is
  // the local UDP socket bound to bindIp:bindPort — every endpoint that
  // sends/receives through this instance shares the one transport,
  // regardless of how many distinct peers reference it; a second
  // type=transport on the same bind would just fail to load). allow= is
  // ordered amrwb/amr before gsm — this endpoint ultimately feeds toward
  // PSTN's scscf_trunk (AMR-capable), so biasing negotiation toward AMR here
  // keeps the call to exactly one transcode hop (AMR<->GSM-FR happening once,
  // on whichever instance's dialplan the call lands on second) rather than
  // risking a double transcode. direct_media=no is a hard functional
  // requirement here, not inherited B2BUA hardening habit: transcoding is
  // only possible while Asterisk itself stays in the RTP path on both legs.
  // See CLAUDE.md's Cross-RAN Calling pattern entry for the full design.
  const crossRanBlock = crossRanPeer ? `
[pstn_trunk]
type=identify
endpoint=pstn_trunk
match=${crossRanPeer.ip}

[pstn_trunk]
type=aor
contact=sip:${crossRanPeer.ip}:${crossRanPeer.port}

[pstn_trunk]
type=endpoint
context=2g-loopback
disallow=all
allow=amrwb
allow=amr
allow=gsm
aors=pstn_trunk
transport=transport-2g
direct_media=no
trust_id_inbound=yes
asymmetric_rtp_codec=yes
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
rtp_keepalive=5
` : '';
  return `; Generated by the NMS's Asterisk-2G module — do not edit by hand,
; regenerated on every Configure call.
;
; No external_media_address override, unlike the PSTN Gateway's own
; pjsip_pstn.conf — every real endpoint in this call flow (this instance,
; osmo-sip-connector, and osmo-mgw's own RTP sockets) lives on this same
; host's loopback range. PSTN needed that override to reach real, remote
; UEs across the network; there is no remote peer in this flow.
[transport-2g]
type=transport
protocol=udp
bind=${bindIp}:${bindPort}

; Trusted, unauthenticated peer representing osmo-sip-connector — it only
; supports a single IP-trusted SIP trunk, no REGISTER, no auth of any kind
; (confirmed in its own official docs), so this is the only valid shape.
[sipconn]
type=identify
endpoint=sipconn
match=${sipConnIp}

[sipconn]
type=aor
contact=sip:${sipConnIp}:${sipConnPort}

[sipconn]
type=endpoint
context=2g-loopback
disallow=all
allow=gsm
aors=sipconn
transport=transport-2g
direct_media=no
trust_id_inbound=yes
; This instance is a real B2BUA exactly like the PSTN Gateway's own
; (CLAUDE.md pattern #14: two independent SIP dialogs, caller->Asterisk and
; Asterisk->callee, each need their own complete offer+answer handling) —
; these are the same defensive B2BUA settings PSTN's own pjsip_pstn.conf
; carries, kept here even though the specific bug PSTN hit (an unreachable
; external_media_address causing a strict-RTP source mismatch) doesn't
; directly apply in this host-local-only topology.
asymmetric_rtp_codec=yes
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
; Real bug found live (2026-09-14) on PSTN Gateway's own identical B2BUA
; setup: rtp_symmetric above means each leg's real send destination is only
; learned from its first inbound packet, not trusted from the SDP answer —
; a call whose very first learn-then-transmit attempt loses a timing race
; has nothing to ever retry it, so that leg stays permanently silent even
; though the bridge itself looks perfectly healthy. This risk is generic to
; any rtp_symmetric-dependent B2BUA leg, not tied to PSTN's own unreachable-
; address issue above, so it applies here too even in this host-local
; topology. See pstn-controller.ts's pjsipPstnConf() for the full writeup.
rtp_keepalive=5
${crossRanBlock}`;
}

// Why this isn't an infinite loop: osmo-sip-connector has exactly one
// configured "remote" peer and zero dialplan logic of its own — every
// inbound INVITE it forwards carries the dialed digits verbatim as the
// R-URI user part, whether that's subscriber A's original MO call or,
// after this dialplan re-originates, the resulting call heading toward B.
// This dialplan only ever EXECUTES once per inbound INVITE Asterisk itself
// receives — Dial(PJSIP/${EXTEN}@sipconn) originates a brand-new OUTBOUND
// INVITE back to osmo-sip-connector, it does not re-enter this dialplan.
// osmo-sip-connector receives that second INVITE and — because its job is
// MNCC<->SIP translation, not SIP<->SIP proxying — hands it to osmo-msc as
// an MNCC mobile-terminated setup toward B's dialed digits; osmo-msc does
// its own normal MSISDN->subscriber/HLR resolution and pages B exactly as
// it would for any real inbound call. There is no third SIP hop, so no
// recursion is possible.
// ── 2G-only short codes ──────────────────────────────────────────────────
// Direct analog of pstn-controller.ts's own extensions feature, adapted for
// this trunk: PSTN dials a subscriber by IMSI over the scscf_trunk (IMS
// core resolves it), but this instance's only peer is osmo-sip-connector,
// which — per the module header above — does no routing of its own; the
// re-dial always has to carry the subscriber's actual MSISDN, exactly like
// the existing msisdnMatchPattern catch-all already does with whatever
// digits were dialed. So a short code here is stored by subscriberImsi
// (matching PSTN's own convention, and staying correct if a subscriber's
// MSISDN ever changes) but resolved to their live MSISDN at config-generate
// time, not stored redundantly.
export interface Gsm2gExtension {
  extension: string;
  subscriberImsi: string;
  label?: string;
  createdAt: string;
}

const EXTENSION_INPUT_RE = /^\+?[0-9]{1,15}$/;
function normalizeExtension(raw: string): string {
  return raw.replace(/^\+/, '');
}

function getGsm2gExtensionsCollection(mongoUri: string): { client: MongoClient; collection: Collection<Gsm2gExtension> } {
  const client = new MongoClient(mongoUri);
  return { client, collection: client.db('open5gs').collection<Gsm2gExtension>('gsm2g_extensions') };
}

async function withGsm2gExtensions<T>(mongoUri: string, fn: (col: Collection<Gsm2gExtension>) => Promise<T>): Promise<T> {
  const { client, collection } = getGsm2gExtensionsCollection(mongoUri);
  try {
    await client.connect();
    return await fn(collection);
  } finally {
    await client.close();
  }
}

function extensions2gConf(msisdnMatchPattern: string, echoTestNumber: string, shortCodes: { extension: string; subscriberMsisdn: string }[], crossRanPeerCodes: { extension: string; label?: string }[]): string {
  const shortCodeBlocks = shortCodes.map(e => `exten => ${e.extension},1,NoOp(2G Short Code -> ${e.subscriberMsisdn})
 same => n,Dial(PJSIP/${e.subscriberMsisdn}@sipconn,30)
 same => n,Hangup()
`).join('\n');

  // Cross-RAN Calling: forward, don't resolve — dial the SAME digit string
  // out to pstn_trunk so the call re-enters PSTN Gateway's own dialplan at
  // the exact extension it already owns, where its own existing per-mapping
  // Dial() logic completes it unchanged. This side never needs to know which
  // subscriber a PSTN short code actually belongs to.
  const crossRanBlocks = crossRanPeerCodes.map(e => `exten => ${e.extension},1,NoOp(Cross-RAN -> 4G/5G short code ${e.extension}${e.label ? ' (' + e.label + ')' : ''})
 same => n,Dial(PJSIP/${e.extension}@pstn_trunk,30)
 same => n,Hangup()
`).join('\n');

  return `; Generated by the NMS's Asterisk-2G module — do not edit by hand,
; regenerated on every Configure call.

[2g-loopback]
; Exact literal match — Asterisk always tries this before the msisdnMatchPattern
; catch-all below, so a 2G phone dialing this number hits the echo test instead
; of being re-dialed back out through osmo-sip-connector.
exten => ${echoTestNumber},1,NoOp(2G Echo Test)
 same => n,Answer()
 same => n,Wait(1)
 same => n,Playback(demo-echotest)
 same => n,Echo()
 same => n,Playback(demo-echodone)
 same => n,Hangup()

${shortCodeBlocks}
${crossRanBlocks}
exten => ${msisdnMatchPattern},1,NoOp(2G-to-2G: re-dialing \${EXTEN} back through osmo-sip-connector)
 same => n,Set(CALLERID(num)=\${CALLERID(num)})
 same => n,Dial(PJSIP/\${EXTEN}@sipconn,30)
 same => n,Hangup()
`;
}

async function resolveGsm2gShortCodes(mongoUri: string, subscriberRepo: ISubscriberRepository): Promise<{ extension: string; subscriberMsisdn: string }[]> {
  const extensions = await withGsm2gExtensions(mongoUri, col => col.find({}).toArray());
  if (extensions.length === 0) return [];
  const allSubs = await subscriberRepo.findAllFull();
  const msisdnByImsi = new Map(allSubs.map(s => [s.imsi, s.msisdn?.[0]]));
  return extensions
    .map(e => ({ extension: e.extension, subscriberMsisdn: msisdnByImsi.get(e.subscriberImsi) }))
    .filter((e): e is { extension: string; subscriberMsisdn: string } => !!e.subscriberMsisdn);
}

// Direct Mongo read, no subscriberRepo join — cross-RAN forwarding only
// needs to know the CODE exists on this side; MSISDN resolution happens
// locally once the call lands back in THIS instance's own dialplan (see
// extensions2gConf()'s shortCodeBlocks above). Exported for
// pstn-controller.ts's own extensionsPstnConf() to consume via the
// pre-existing safe static import direction. See CLAUDE.md's Cross-RAN
// Calling entry for the full ownership map.
export async function listGsm2gShortCodesForCrossRan(mongoUri: string): Promise<{ extension: string; label?: string }[]> {
  const extensions = await withGsm2gExtensions(mongoUri, col => col.find({}).toArray());
  return extensions.map(e => ({ extension: e.extension, label: e.label }));
}

export function getAsterisk2gEchoTestNumber(): string {
  return readState()?.echoTestNumber ?? STATE_DEFAULTS.echoTestNumber;
}

export function getAsterisk2gBindAddress(): { ip: string; port: number } | null {
  const s = readState();
  return s ? { ip: s.bindIp, port: s.bindPort } : null;
}

// Lazy-imports pstn-controller.ts ONLY when cross-RAN is actually enabled —
// see isAsterisk2gInstalled()'s own comment for why this direction has to
// stay a lazy `await import()` rather than a static one (this function is
// reached from routine single-side short-code CRUD, with no orchestrator in
// that call path to push the data in as a parameter instead).
async function getCrossRanPeerCodes(mongoUri: string): Promise<{ extension: string; label?: string }[]> {
  const state = readState();
  if (!state?.crossRanEnabled) return [];
  const { listPstnShortCodesForCrossRan } = await import('./pstn-controller');
  return listPstnShortCodesForCrossRan(mongoUri);
}

// Lightweight regen — mirrors pstn-controller.ts's own regenerateDialplan():
// rewrites just extensions.conf + reloads the dialplan, deliberately NOT a
// full configureAsterisk2g() (which also touches IP binding, pjsip.conf, the
// SIP tab wiring, and restarts the whole service) — adding/removing a short
// code shouldn't need any of that.
async function regenerateExtensions2g(mongoUri: string, subscriberRepo: ISubscriberRepository): Promise<void> {
  const state = readState();
  const msisdnMatchPattern = state?.msisdnMatchPattern ?? STATE_DEFAULTS.msisdnMatchPattern;
  const echoTestNumber = state?.echoTestNumber ?? STATE_DEFAULTS.echoTestNumber;
  const shortCodes = await resolveGsm2gShortCodes(mongoUri, subscriberRepo);
  const crossRanPeerCodes = await getCrossRanPeerCodes(mongoUri);
  fs.writeFileSync(`${HOST_ROOT}${A2G_EXTEN}`, extensions2gConf(msisdnMatchPattern, echoTestNumber, shortCodes, crossRanPeerCodes), 'utf-8');
  await nsenter('asterisk', ['-C', A2G_CONF, '-rx', 'dialplan reload']).catch(() => {});
}

function rtp2gConf(): string {
  return `[general]
rtpstart=${RTP_PORT_MIN}
rtpend=${RTP_PORT_MAX}
strictrtp=no
`;
}

function asterisk2gTmpfilesLine(): string {
  // /run is tmpfs, wiped on every reboot — a plain mkdir at Configure time
  // wouldn't survive a reboot since Configure is a manual, one-time operator
  // action. This is the standard systemd-native fix: applied once here and
  // automatically reapplied at every boot by systemd-tmpfiles-setup.service,
  // before asterisk-2g.service even starts.
  return `d ${A2G_RUN} 0750 asterisk asterisk -\n`;
}

// Upstream's own contrib/systemd/asterisk.service template (confirmed live
// 2026-09-13 against this host's actual stock unit), pointed at this
// instance's own alternate config via -C, with its own PID/state directory
// and a soft (not hard) dependency on osmo-sip-connector — this instance can
// start and sit idle fine even before osmo-sip-connector is configured,
// there's no runtime crash risk, just call-flow uselessness until both
// sides are set up.
function asterisk2gSystemdUnit(): string {
  return `[Unit]
Description=Asterisk PBX (2G-to-2G internal voice — isolated instance, separate from the PSTN Gateway's Asterisk)
Documentation=man:asterisk(8)
Wants=network-online.target
After=network-online.target osmo-sip-connector.service

[Service]
Type=notify
ExecStart=/usr/sbin/asterisk -g -f -p -U asterisk -G asterisk -C ${A2G_CONF}
ExecReload=/usr/sbin/asterisk -C ${A2G_CONF} -rx "core reload"
Restart=on-failure
RestartSec=1
WorkingDirectory=${A2G_VARLIB}
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
`;
}

// ── Host-side helpers ─────────────────────────────────────────────────────

async function ensureDirTreeAndOwnership(): Promise<void> {
  const dirs = [A2G_ETC, A2G_VARLIB, `${A2G_VARLIB}/agi-bin`, A2G_SPOOL, A2G_LOG, A2G_CACHE];
  await nsenter('bash', ['-c', `mkdir -p ${dirs.join(' ')} && chown -R asterisk:asterisk ${dirs.join(' ')}`]);
  fs.mkdirSync(`${HOST_ROOT}/etc/tmpfiles.d`, { recursive: true });
  fs.writeFileSync(`${HOST_ROOT}${TMPFILES_PATH}`, asterisk2gTmpfilesLine(), 'utf-8');
  await nsenter('systemd-tmpfiles', ['--create', TMPFILES_PATH]);
}

// One-time baseline: takes a point-in-time copy of the currently-installed
// stock /etc/asterisk tree so this instance starts from a complete, valid
// Asterisk config (codecs.conf, indications.conf, etc. — the ~80 files this
// module never generates itself and the dialplan never needs). A snapshot,
// not a live link — future edits to either instance's own files never
// cross-contaminate. Only runs once; re-running Configure never re-copies.
async function ensureBaselineTreeCopied(): Promise<void> {
  if (fs.existsSync(`${HOST_ROOT}${A2G_CONF}`)) return;
  await nsenter('bash', ['-c', `cp -a /etc/asterisk/. ${A2G_ETC}/`]);
}

function ensureChanSipDisabled2g(): void {
  const marker = 'noload => chan_sip.so';
  let raw = fs.existsSync(`${HOST_ROOT}${A2G_MODULES}`) ? fs.readFileSync(`${HOST_ROOT}${A2G_MODULES}`, 'utf-8') : '[modules]\nautoload=yes\n';
  if (!raw.includes(marker)) {
    if (!/\[modules\]/.test(raw)) raw = '[modules]\nautoload=yes\n' + raw;
    raw = raw.replace(/\[modules\]\n/, `[modules]\n${marker}\n`);
  }
  fs.writeFileSync(`${HOST_ROOT}${A2G_MODULES}`, raw, 'utf-8');
}

// Same real bug class as pstn-controller.ts's ensureStrictRtpDisabled(): a
// file written from inside this backend container lands root:root on the
// host, which the unprivileged `asterisk` user can't read — Asterisk
// doesn't error on this, it silently falls back to compiled-in defaults.
// Must run after every write to any of this module's own generated files.
async function chownConfigFiles(): Promise<void> {
  await nsenter('chown', ['asterisk:asterisk', A2G_CONF, A2G_PJSIP, A2G_EXTEN, A2G_MODULES, A2G_RTP]).catch(() => {});
}

// Same per-process runtime toggle as pstn-controller.ts's
// ensureNativeRtpBridgeSuspended() — must be its own, separate call against
// THIS instance's own control socket. These are two independent running
// `asterisk` processes; PSTN's own suspend call never reaches this one.
async function ensureNativeRtpBridgeSuspended2g(): Promise<void> {
  await nsenter('asterisk', ['-C', A2G_CONF, '-rx', 'bridge technology suspend native_rtp']).catch(() => {});
}

async function verifyGsmSipConnReady(): Promise<{ ready: boolean; reason?: string }> {
  const build = await verifyOsmoSipConnectorBuild();
  if (!build.installed) {
    return { ready: false, reason: 'osmo-sip-connector is not built yet — build it from the GSM page\'s Setup tab (Install) first.' };
  }
  const peer = readGsmSipPeer();
  if (!peer) {
    return { ready: false, reason: 'osmo-sip-connector has no concrete local SIP address configured yet — set it on the GSM page\'s SIP tab first.' };
  }
  return { ready: true };
}

// ── Install / Configure (extracted, same shape as every sibling module) ────

export async function installAsterisk2g(write: (s: string) => void): Promise<{ success: boolean; error?: string; codecGsmLoaded?: boolean }> {
  try {
    const gate = await verifyGsmSipConnReady();
    if (!gate.ready) {
      write(`\n❌ ${gate.reason}`);
      return { success: false, error: gate.reason };
    }

    write('=== Installing Asterisk (shared package — reused if the PSTN Gateway already installed it) ===');
    const exitCode: number = await new Promise((resolve) => {
      const child = exec(`nsenter -t 1 -m -u -i -p -- bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y asterisk asterisk-modules'`);
      child.stdout?.on('data', (d: Buffer) => write(d.toString()));
      child.stderr?.on('data', (d: Buffer) => write(d.toString()));
      child.on('close', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      write(`\n❌ apt-get install failed (exit ${exitCode}).`);
      return { success: false, error: `apt exit ${exitCode}` };
    }

    write('\n=== Creating isolated instance directory tree (own config, own runtime state — never touches /etc/asterisk) ===');
    await ensureDirTreeAndOwnership();
    await ensureBaselineTreeCopied();
    ensureChanSipDisabled2g();
    await chownConfigFiles();

    write('\n=== Installing systemd unit (asterisk-2g.service — separate from the stock asterisk.service) ===');
    fs.writeFileSync(`${HOST_ROOT}${SYSTEMD_UNIT_PATH}`, asterisk2gSystemdUnit(), 'utf-8');
    await nsenter('systemctl', ['daemon-reload']);
    await nsenter('systemctl', ['enable', '--now', SYSTEMD_UNIT]);
    await new Promise(r => setTimeout(r, 2000));
    await nsenter('asterisk', ['-C', A2G_CONF, '-rx', 'module unload chan_sip.so']).catch(() => {});
    await ensureNativeRtpBridgeSuspended2g();

    write('\n=== Verifying GSM-FR codec support on this instance ===');
    let codecOk = false;
    try {
      const { stdout } = await nsenter('asterisk', ['-C', A2G_CONF, '-rx', 'module show like codec_gsm']);
      codecOk = /Running/.test(stdout);
    } catch { /* ignore */ }
    if (codecOk) {
      write('✅ codec_gsm.so loaded and running — matches the real BTS/BSC/MSC chain\'s GSM-FR codec.');
    } else {
      write('⚠️  codec_gsm.so did not load on this instance. Real 2G calls will fail codec negotiation.\n' +
        '   Check `asterisk -C /etc/asterisk-2g/asterisk.conf -rx "module show like codec_gsm"` manually.');
    }

    const existing = readState();
    writeState({ ...(existing ?? STATE_DEFAULTS), installedWithVersion: getAppVersion() });

    write('\n✅ Asterisk-2G installed. Run Configure next.');
    return { success: true, codecGsmLoaded: codecOk };
  } catch (err) {
    write(`\n❌ Install error: ${String(err)}`);
    return { success: false, error: String(err) };
  }
}

export async function configureAsterisk2g(
  input: { bindIp?: string; bindPort?: number; msisdnMatchPattern?: string; echoTestNumber?: string },
  mongoUri: string,
  subscriberRepo: ISubscriberRepository,
): Promise<{ success: boolean; error?: string; bindIp?: string; sipConnPeer?: string }> {
  try {
    if (!fs.existsSync(`${HOST_ROOT}${A2G_CONF}`)) {
      return { success: false, error: 'Asterisk-2G is not installed yet — run Install first.' };
    }
    const peer = readGsmSipPeer();
    if (!peer) {
      return { success: false, error: 'osmo-sip-connector has no concrete local SIP address configured yet — set it on the GSM page\'s SIP tab first.' };
    }

    const existing = readState();
    const bindIp = input.bindIp || existing?.bindIp || DEFAULT_BIND_IP;
    const bindPort = input.bindPort || existing?.bindPort || BIND_PORT;
    const msisdnMatchPattern = input.msisdnMatchPattern || existing?.msisdnMatchPattern || STATE_DEFAULTS.msisdnMatchPattern;
    const echoTestNumber = input.echoTestNumber || existing?.echoTestNumber || STATE_DEFAULTS.echoTestNumber;

    const shortCodeCollision = await withGsm2gExtensions(mongoUri, col => col.findOne({ extension: echoTestNumber })).catch(() => null);
    if (shortCodeCollision) {
      return { success: false, error: `Echo test number ${echoTestNumber} collides with an assigned 2G short code — pick a different one.` };
    }

    // Idempotent — matches the loopback-alias convention every other SIP
    // daemon in this project follows (each gets its own dedicated address).
    await nsenter('ip', ['addr', 'add', `${bindIp}/8`, 'dev', 'lo']).catch(() => {});

    const astmoddir = deriveStockDir('astmoddir', '/usr/lib/x86_64-linux-gnu/asterisk/modules');
    const astdatadir = deriveStockDir('astdatadir', '/usr/share/asterisk');
    const shortCodes = await resolveGsm2gShortCodes(mongoUri, subscriberRepo);
    // Preserve the existing Cross-RAN Calling wiring across a routine
    // Configure call — this rewrites pjsip.conf/extensions.conf wholesale,
    // so without re-deriving these, an unrelated re-Configure would silently
    // drop the pstn_trunk peer/forwarding blocks even though crossRanEnabled
    // itself is untouched by this function (see CLAUDE.md's Cross-RAN
    // Calling entry — same "don't silently drop on regen" issue
    // regenerateExtensions2g's own getCrossRanPeerCodes() already handles).
    let crossRanPeer: { ip: string; port: number } | null = null;
    if (existing?.crossRanEnabled) {
      const { getPstnBindAddress } = await import('./pstn-controller');
      crossRanPeer = getPstnBindAddress();
    }
    const crossRanPeerCodes = await getCrossRanPeerCodes(mongoUri);
    fs.writeFileSync(`${HOST_ROOT}${A2G_CONF}`, asterisk2gConfTemplate(astmoddir, astdatadir), 'utf-8');
    fs.writeFileSync(`${HOST_ROOT}${A2G_PJSIP}`, pjsip2gConf(bindIp, bindPort, peer.ip, peer.port, crossRanPeer), 'utf-8');
    fs.writeFileSync(`${HOST_ROOT}${A2G_EXTEN}`, extensions2gConf(msisdnMatchPattern, echoTestNumber, shortCodes, crossRanPeerCodes), 'utf-8');
    fs.writeFileSync(`${HOST_ROOT}${A2G_RTP}`, rtp2gConf(), 'utf-8');
    ensureChanSipDisabled2g();
    await chownConfigFiles();

    const wasActive = (await nsenter('systemctl', ['is-active', SYSTEMD_UNIT]).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim() === 'active';
    if (wasActive) {
      await nsenter('systemctl', ['restart', SYSTEMD_UNIT]);
    } else {
      await nsenter('systemctl', ['enable', '--now', SYSTEMD_UNIT]);
    }
    await new Promise(r => setTimeout(r, 1500));
    await ensureNativeRtpBridgeSuspended2g();

    // This module's whole job is being osmo-sip-connector's "remote" — wire
    // it in and flip osmo-msc to external MNCC as part of its own explicit
    // Configure, rather than leaving that as separate manual steps on the
    // SIP tab. See wireIntoSipTabAndGoExternal()'s own comment for why this
    // is narrower than (and doesn't contradict) this project's general rule
    // against modules silently rewriting each other's config.
    await wireIntoSipTabAndGoExternal(bindIp, bindPort, peer);

    writeState({ bindIp, bindPort, msisdnMatchPattern, echoTestNumber, crossRanEnabled: existing?.crossRanEnabled, installedWithVersion: existing?.installedWithVersion, configuredWithVersion: getAppVersion() });

    return { success: true, bindIp, sipConnPeer: `${peer.ip}:${peer.port}` };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Cross-RAN Calling (2G <-> 4G/5G short-code bridging) ────────────────────
//
// Sole follower half of the Cross-RAN Calling toggle — orchestrated FROM
// pstn-controller.ts's setCrossRanCalling(), never called directly from a
// route on this module (there is deliberately no `POST /cross-ran/*` route
// here — the one-button toggle lives entirely on the Voice Gateway page,
// backed by pstnApi). Mirrors configureAsterisk2g()'s own "never a full
// restart, always a live module/dialplan reload" convention — both instances
// must already be running before this can be called. See CLAUDE.md's
// Cross-RAN Calling pattern entry for the full design (ownership map, codec
// ordering rationale, why there's no rollback on partial failure).
export async function setCrossRanPeer(
  enabled: boolean,
  mongoUri: string,
  subscriberRepo: ISubscriberRepository,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!fs.existsSync(`${HOST_ROOT}${A2G_CONF}`)) {
      return { success: false, error: 'Asterisk-2G is not installed yet.' };
    }
    const existing = readState();
    if (!existing) {
      return { success: false, error: 'Asterisk-2G is not configured yet — run Configure first.' };
    }
    const sipConnPeer = readGsmSipPeer();
    if (!sipConnPeer) {
      return { success: false, error: 'osmo-sip-connector has no concrete local SIP address configured yet — set it on the GSM page\'s SIP tab first.' };
    }

    let crossRanPeer: { ip: string; port: number } | null = null;
    if (enabled) {
      let codecOk = false;
      try {
        const { stdout } = await nsenter('asterisk', ['-C', A2G_CONF, '-rx', 'module show like codec_gsm']);
        codecOk = /Running/.test(stdout);
      } catch { /* ignore */ }
      if (!codecOk) {
        return { success: false, error: 'codec_gsm.so is not loaded on this instance — required for Cross-RAN Calling\'s transcoding. Check `module show like codec_gsm`.' };
      }
      const { getPstnBindAddress } = await import('./pstn-controller');
      crossRanPeer = getPstnBindAddress();
      if (!crossRanPeer) {
        return { success: false, error: 'PSTN Gateway is not configured yet — configure it before enabling Cross-RAN Calling.' };
      }
    }

    // Written BEFORE the file regen below so regenerateExtensions2g()'s own
    // getCrossRanPeerCodes() (which reads this same state) picks up the new
    // value immediately. Deliberately not rolled back if a later step fails
    // — see setCrossRanCalling() in pstn-controller.ts for the full "no
    // rollback, surface the inconsistency" rationale this mirrors.
    writeState({ ...existing, crossRanEnabled: enabled });

    fs.writeFileSync(`${HOST_ROOT}${A2G_PJSIP}`, pjsip2gConf(existing.bindIp, existing.bindPort, sipConnPeer.ip, sipConnPeer.port, crossRanPeer), 'utf-8');
    await chownConfigFiles();
    await nsenter('asterisk', ['-C', A2G_CONF, '-rx', 'module reload res_pjsip.so']).catch(() => {});
    await regenerateExtensions2g(mongoUri, subscriberRepo);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export interface Asterisk2gStalenessResult {
  installed: boolean;
  hasSavedConfig: boolean;
  configStale: boolean;
  configuredWithVersion?: string;
}

export async function getAsterisk2gStaleness(): Promise<Asterisk2gStalenessResult> {
  const installed = fs.existsSync(`${HOST_ROOT}${A2G_CONF}`);
  const state = readState();
  const appVersion = getAppVersion();
  const configStale = !!state && state.configuredWithVersion !== appVersion;
  return {
    installed,
    hasSavedConfig: !!state,
    configStale,
    configuredWithVersion: state?.configuredWithVersion,
  };
}

// ── Router ───────────────────────────────────────────────────────────────

export function createAsterisk2gRouter(subscriberRepo: ISubscriberRepository, mongoUri: string, logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const installed = fs.existsSync(`${HOST_ROOT}${A2G_CONF}`);
      const serviceActiveRes = await nsenter('systemctl', ['is-active', SYSTEMD_UNIT]).catch(() => ({ stdout: '', stderr: '' }));
      const serviceActive = serviceActiveRes.stdout.trim() === 'active';

      let codecGsmLoaded = false;
      if (installed && serviceActive) {
        try {
          const { stdout } = await nsenter('asterisk', ['-C', A2G_CONF, '-rx', 'module show like codec_gsm']);
          codecGsmLoaded = /Running/.test(stdout);
        } catch { /* not running yet */ }
      }

      const state = readState();
      const gsmPeer = readGsmSipPeer();
      const appVersion = getAppVersion();
      const configStale = !!state && state.configuredWithVersion !== appVersion;

      res.json({
        success: true,
        installed,
        serviceActive,
        codecGsmLoaded,
        bindIp: state?.bindIp ?? DEFAULT_BIND_IP,
        bindPort: state?.bindPort ?? BIND_PORT,
        msisdnMatchPattern: state?.msisdnMatchPattern ?? STATE_DEFAULTS.msisdnMatchPattern,
        echoTestNumber: state?.echoTestNumber ?? STATE_DEFAULTS.echoTestNumber,
        // What this instance's own pjsip.conf currently points its sipconn
        // trunk at (osmo-sip-connector's live local bind, read fresh every
        // status poll) — lets the frontend warn if the GSM SIP tab's own
        // remote peer doesn't actually point back here.
        sipConnPeer: gsmPeer,
        hasSavedConfig: !!state,
        configuredWithVersion: state?.configuredWithVersion,
        configStale,
        appVersion,
        crossRanEnabled: !!state?.crossRanEnabled,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'asterisk-2g status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const result = await installAsterisk2g(write);
    await auditLogger.log({ action: 'asterisk2g_install', user, details: result.error ?? `codecGsmLoaded=${result.codecGsmLoaded}`, success: result.success });
    res.end();
  });

  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { bindIp, bindPort, msisdnMatchPattern, echoTestNumber } = req.body as { bindIp?: string; bindPort?: number; msisdnMatchPattern?: string; echoTestNumber?: string };
    const result = await configureAsterisk2g({ bindIp, bindPort, msisdnMatchPattern, echoTestNumber }, mongoUri, subscriberRepo);
    if (!result.success) {
      await auditLogger.log({ action: 'asterisk2g_configure', user, details: result.error ?? 'failed', success: false });
      return res.status(400).json({ success: false, error: result.error });
    }
    await auditLogger.log({ action: 'asterisk2g_configure', user, details: `bindIp=${result.bindIp} sipConnPeer=${result.sipConnPeer}`, success: true });
    res.json({ success: true, bindIp: result.bindIp, sipConnPeer: result.sipConnPeer });
  });

  // GET /api/asterisk-2g/extensions — list 2G short codes, joined with subscriber nickname/MSISDN
  router.get('/extensions', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const extensions = await withGsm2gExtensions(mongoUri, col => col.find({}).sort({ extension: 1 }).toArray());
      const nicknames = await subscriberRepo.getNicknamesByImsi(extensions.map(e => e.subscriberImsi));
      const allSubs = await subscriberRepo.findAllFull();
      const msisdnByImsi = new Map(allSubs.map(s => [s.imsi, s.msisdn?.[0]]));
      res.json({
        success: true,
        extensions: extensions.map(e => ({
          ...e,
          subscriberNickname: nicknames[e.subscriberImsi],
          subscriberMsisdn: msisdnByImsi.get(e.subscriberImsi),
        })),
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'asterisk-2g extensions list error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/asterisk-2g/extensions — body: { extension, subscriberImsi, label? }
  router.post('/extensions', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { subscriberImsi, label } = req.body as { extension?: string; subscriberImsi?: string; label?: string };
    const rawExtension = req.body.extension as string | undefined;
    if (!rawExtension || !EXTENSION_INPUT_RE.test(rawExtension)) {
      return res.status(400).json({ success: false, error: 'extension must be 1-15 digits (a leading "+" is accepted but not required)' });
    }
    const extension = normalizeExtension(rawExtension);
    if (!subscriberImsi || !/^\d{6,15}$/.test(subscriberImsi)) {
      return res.status(400).json({ success: false, error: 'subscriberImsi is required' });
    }
    const echoTestNumber = readState()?.echoTestNumber || STATE_DEFAULTS.echoTestNumber;
    if (extension === echoTestNumber) {
      return res.status(400).json({ success: false, error: `${extension} is reserved for the echo test — pick a different code, or change the echo test number on the 2G Voice tab first.` });
    }
    // Cross-RAN Calling makes both sides' short codes reachable from either
    // instance, so a number can't mean two different subscribers at once —
    // gated on crossRanEnabled (not unconditional) so two unrelated,
    // never-to-be-bridged deployments can still reuse the same short code
    // freely on each side. See CLAUDE.md's Cross-RAN Calling entry.
    if (readState()?.crossRanEnabled) {
      const peerCodes = await getCrossRanPeerCodes(mongoUri);
      const { getPstnEchoTestNumber } = await import('./pstn-controller');
      if (peerCodes.some(c => c.extension === extension) || extension === getPstnEchoTestNumber()) {
        return res.status(409).json({ success: false, error: `${extension} collides with an existing 4G/5G short code or its echo-test number — Cross-RAN Calling is enabled, so short codes must stay unique across both sides.` });
      }
    }
    try {
      const subscriber = await subscriberRepo.findByImsi(subscriberImsi);
      if (!subscriber) return res.status(404).json({ success: false, error: `No subscriber with IMSI ${subscriberImsi}` });
      if (!subscriber.gsmEnabled) return res.status(400).json({ success: false, error: 'Subscriber does not have 2G/3G Auth enabled — enable it on the Subscribers page first.' });
      if (!subscriber.msisdn?.[0]) return res.status(400).json({ success: false, error: 'Subscriber has no MSISDN — 2G short codes dial by MSISDN, not IMSI.' });

      await withGsm2gExtensions(mongoUri, async col => {
        const existing = await col.findOne({ extension });
        if (existing) throw new Error(`Short code ${extension} is already assigned`);
        await col.insertOne({ extension, subscriberImsi, label, createdAt: new Date().toISOString() });
      });
      await regenerateExtensions2g(mongoUri, subscriberRepo);

      await auditLogger.log({ action: 'asterisk2g_extension_add', user, details: `${extension} -> ${subscriberImsi}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'asterisk2g_extension_add', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: String((err as Error).message ?? err) });
    }
  });

  // DELETE /api/asterisk-2g/extensions/:extension
  router.delete('/extensions/:extension', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const extension = decodeURIComponent(req.params.extension);
    try {
      await withGsm2gExtensions(mongoUri, col => col.deleteOne({ extension }));
      await regenerateExtensions2g(mongoUri, subscriberRepo);
      await auditLogger.log({ action: 'asterisk2g_extension_remove', user, details: extension, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'asterisk2g_extension_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', SYSTEMD_UNIT]);
      await ensureNativeRtpBridgeSuspended2g();
      await auditLogger.log({ action: 'asterisk2g_start', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'asterisk2g_stop', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', SYSTEMD_UNIT]);
      await ensureNativeRtpBridgeSuspended2g();
      await auditLogger.log({ action: 'asterisk2g_restart', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ─── Config file editor (mirrors gsm-controller.ts's /configs endpoints) ──
  router.get('/configs', async (_req: Request, res: Response) => {
    const files: Asterisk2gConfigFile[] = A2G_CONFIG_MANIFEST.map(f => ({ ...f, exists: fs.existsSync(f.path) }));
    res.json({ success: true, files });
  });

  router.get('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const path = req.query.path as string;
    if (!A2G_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
    try {
      const content = fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : '';
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path, content } = req.body as { path: string; content: string };
    if (!A2G_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
    try {
      fs.mkdirSync(`${HOST_ROOT}${A2G_ETC}`, { recursive: true });
      fs.writeFileSync(path, content, 'utf-8');
      await auditLogger.log({ action: 'asterisk2g_config_save', user, details: path, success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/configs/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const services = (req.body.services as string[]) || [];
    try {
      for (const svc of services) await nsenter('systemctl', ['restart', svc]);
      if (services.includes(SYSTEMD_UNIT)) await ensureNativeRtpBridgeSuspended2g();
      await auditLogger.log({ action: 'asterisk2g_config_restart', user, details: services.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/asterisk-2g/uninstall — scoped ONLY to this instance's own
  // tree/unit. Deliberately NEVER apt purges asterisk/asterisk-modules (see
  // module header) — that package is shared with the PSTN Gateway's own,
  // untouched instance; purging it would take PSTN down too. This is a real,
  // intentional asymmetry with pstn-controller.ts's own uninstall (which DOES
  // purge) — not an oversight.
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    try {
      // Best-effort — must run BEFORE this instance's own tree gets wiped
      // below, since setCrossRanCalling(false,...) internally delegates back
      // to THIS module's own setCrossRanPeer(false,...) too (harmless/
      // redundant given the wipe that follows, but it needs A2G_CONF to
      // still exist to do PSTN's own half of the teardown correctly). Lazy
      // import — see isAsterisk2gInstalled()'s own comment for why this
      // direction can't be a static import.
      if (readState()?.crossRanEnabled) {
        write('=== Tearing down Cross-RAN Calling peer on PSTN Gateway (best-effort) ===');
        const { setCrossRanCalling } = await import('./pstn-controller');
        await setCrossRanCalling(false, mongoUri, subscriberRepo).catch(() => {});
      }

      write('\n=== Stopping and disabling asterisk-2g.service (the stock asterisk.service / PSTN Gateway is never touched) ===');
      await nsenter('systemctl', ['disable', '--now', SYSTEMD_UNIT]).catch(() => {});

      write('\n=== Removing this instance\'s own systemd unit ===');
      if (fs.existsSync(`${HOST_ROOT}${SYSTEMD_UNIT_PATH}`)) fs.unlinkSync(`${HOST_ROOT}${SYSTEMD_UNIT_PATH}`);
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});

      write('\n=== Removing this instance\'s own directory tree (/etc/asterisk is never touched) ===');
      await nsenter('rm', ['-rf', A2G_ETC, A2G_VARLIB, A2G_SPOOL, A2G_LOG, A2G_CACHE, A2G_RUN]).catch(() => {});
      if (fs.existsSync(`${HOST_ROOT}${TMPFILES_PATH}`)) fs.unlinkSync(`${HOST_ROOT}${TMPFILES_PATH}`);
      if (fs.existsSync(HOST_STATE)) fs.unlinkSync(HOST_STATE);

      write('\n=== Removing 2G short code mappings ===');
      const removed = await withGsm2gExtensions(mongoUri, col => col.deleteMany({})).then(r => r.deletedCount).catch(() => 0);
      write(`Removed ${removed} short code mapping(s).`);

      write('\n=== NOT purging the asterisk/asterisk-modules packages — shared with the PSTN Gateway\'s own instance ===');

      // Removing the one thing osmo-msc's external MNCC mode was pointed at
      // must not leave it stranded there — same reasoning as the GSM
      // module's own uninstall forcing internal mode back on (see
      // sms-controller.ts's setMscMnccMode() comment for the original
      // incident this pattern exists to prevent).
      write('\n=== Restoring osmo-msc to internal call routing (nothing would be listening on external anymore) ===');
      const { setMscMnccMode } = await import('./sms-controller');
      await setMscMnccMode('internal', MNCC_SOCKET_PATH).catch(() => {});

      await auditLogger.log({ action: 'asterisk2g_uninstall', user, details: '', success: true });
      write('\n✅ Asterisk-2G removed. The stock Asterisk instance (PSTN Gateway) is untouched.');
      res.end();
    } catch (err) {
      await auditLogger.log({ action: 'asterisk2g_uninstall', user, details: String(err), success: false });
      write(`\n❌ Uninstall error: ${String(err)}`);
      res.end();
    }
  });

  return router;
}
