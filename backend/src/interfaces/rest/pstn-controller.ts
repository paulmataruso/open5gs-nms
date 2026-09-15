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
  isAsterisk2gInstalled, setCrossRanPeer, listGsm2gShortCodesForCrossRan,
  getAsterisk2gEchoTestNumber, getAsterisk2gBindAddress,
} from './asterisk-2g-controller';

// ── PSTN Gateway (Asterisk) ─────────────────────────────────────────────────
//
// Interconnects the IMS core with the real PSTN via Asterisk, acting as the
// MGCF/BGCF-equivalent gateway that Kamailio S-CSCF's dispatcher already has
// (previously dormant) routing logic for. See memory: pstn-asterisk-gateway-poc
// for the full PoC this module formalizes, and /root/.claude/plans/
// typed-plotting-kite.md for the original plan.
//
// This first cut wires the "internal" side only: subscribers can be assigned
// a PSTN-looking extension number (e.g. +15551001), and dialing another
// subscriber's extension routes out through S-CSCF's existing dispatcher to
// Asterisk, which looks up the mapped target and originates a fresh INVITE
// back into the core via I-CSCF — exercising the exact same signaling path a
// real external SIP trunk provider would use, without needing one yet. See
// docs/features.md (once documented) for the real-trunk-provider fields this
// module still needs before it can place genuine outside calls.

const execFileAsync = promisify(execFile);

const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

const HOST_ROOT           = '/proc/1/root';
const HOST_IMS_STATE      = `${HOST_ROOT}/etc/open5gs/.ims-config.json`;
const HOST_PSTN_STATE     = `${HOST_ROOT}/etc/open5gs/.pstn-config.json`;
const HOST_ASTERISK_DIR   = `${HOST_ROOT}/etc/asterisk`;
const HOST_PJSIP_INC      = `${HOST_ASTERISK_DIR}/pjsip_pstn.conf`;
const HOST_EXTENSIONS_INC = `${HOST_ASTERISK_DIR}/extensions_pstn.conf`;
const HOST_MODULES_CONF   = `${HOST_ASTERISK_DIR}/modules.conf`;
const HOST_PJSIP_CONF     = `${HOST_ASTERISK_DIR}/pjsip.conf`;
const HOST_EXTENSIONS_CONF = `${HOST_ASTERISK_DIR}/extensions.conf`;
const HOST_RTP_CONF       = `${HOST_ASTERISK_DIR}/rtp.conf`;
const HOST_ASTERISK_CONF  = `${HOST_ASTERISK_DIR}/asterisk.conf`;
const HOST_DISPATCHER_LIST = `${HOST_ROOT}/etc/kamailio_scscf/dispatcher.list`;

// This project's convention: each IMS component gets its own dedicated
// loopback alias (I-CSCF=127.0.1.1, S-CSCF=127.0.1.2 — confirmed live).
// 127.0.1.4 is the next free one (verified unused on the reference host
// during the PoC this module formalizes).
const DEFAULT_ASTERISK_IP = '127.0.1.4';
const ASTERISK_PORT = 5060;
// Short and distinct from Asterisk-2G's own "600" (a separate instance/
// dialplan namespace, so no actual collision risk — just avoiding operator
// confusion between the two). Real PSTN extensions assigned so far are all
// 4-digit (1010/2020/3030/4040 — see extensionsPstnConf() below), so a
// 3-digit code can't collide with one either.
const DEFAULT_ECHO_TEST_NUMBER = '500';

interface PstnState {
  asteriskIp: string;
  // Exact-match dialplan extension for a local Answer()/Echo()/Hangup() test
  // — dial it from any IMS-registered phone (VoLTE or VoWiFi) to hear your
  // own audio looped back through this instance, no second phone needed.
  // Unlike a subscriber extension this never Dial()s back out through
  // S-CSCF/I-CSCF — it's answered locally, so it also exercises PSTN
  // Gateway's own signaling path without depending on any other subscriber.
  echoTestNumber?: string;
  // See app-version.ts / ims-controller.ts's identical field — lets /status
  // tell an operator their live deployment predates a template fix (e.g.
  // after a git pull + backend rebuild) instead of silently leaving a stale
  // config in place or auto-restarting Asterisk on every upgrade.
  configuredWithVersion?: string;
  // Source of truth for the Cross-RAN Calling toggle — the UI button lives
  // on this page's Extensions tab, backed by pstnApi, so this copy (not
  // asterisk-2g-controller.ts's own follower copy) is what /status reports
  // and setCrossRanCalling() below writes. See CLAUDE.md's Cross-RAN Calling
  // entry for the full design.
  crossRanEnabled?: boolean;
}

export function readPstnState(): PstnState | null {
  if (!fs.existsSync(HOST_PSTN_STATE)) return null;
  try { return JSON.parse(fs.readFileSync(HOST_PSTN_STATE, 'utf-8')); } catch { return null; }
}

function writePstnState(state: PstnState): void {
  fs.mkdirSync(`${HOST_ROOT}/etc/open5gs`, { recursive: true });
  fs.writeFileSync(HOST_PSTN_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

interface ImsState {
  imsDomain: string;
  config: { icscfIp: string; icscfPort: number; scscfIp: string; scscfPort: number; pcscfIp: string };
}

function readImsState(): ImsState | null {
  if (!fs.existsSync(HOST_IMS_STATE)) return null;
  try { return JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8')); } catch { return null; }
}

// PSTN Gateway is built entirely on top of IMS's Kamailio S-CSCF/I-CSCF
// signaling chain (see module header) — Install itself only installs the
// Asterisk packages so it doesn't strictly need IMS present, but there's no
// point letting a user go through that step on a host that can never reach
// a working Configure. Same two-tier gate as mms-controller.ts's isImsInstalled/
// isImsConfigured — Install requires IMS installed, Configure (already gated
// below via readImsState()) requires IMS configured.
async function isImsInstalled(): Promise<boolean> {
  try {
    const { stdout } = await nsenter('which', ['kamailio']);
    return stdout.trim().length > 0;
  } catch { return false; }
}

export interface PstnExtension {
  extension: string;      // Any 1-15 digit string, e.g. "1111" or "5551111" —
                          // stored WITHOUT a leading "+". S-CSCF's
                          // route[PSTN_handling] no longer requires a "+"
                          // prefix to route a number to the dispatcher — it
                          // checks the real registrar instead (see
                          // kamailio_scscf.cfg) and only PSTN-routes numbers
                          // that AREN'T a currently-registered subscriber.
                          // Confirmed live, 2026-07-27: real phones dial an
                          // in-network-looking number via a tel: URI +
                          // phone-context with no "+" at all, so the old
                          // "+[0-9]+"-only check never matched real dialing.
  subscriberImsi: string;
  label?: string;
  createdAt: string;
}

// Accepts an optional leading "+" on input (stripped before storing/
// matching) so pasting a "+1555…"-style number still works, but never
// requires one — any 1-15 digit extension is valid, any length.
const EXTENSION_INPUT_RE = /^\+?[0-9]{1,15}$/;
function normalizeExtension(raw: string): string {
  return raw.replace(/^\+/, '');
}

export interface PstnConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
}

// This is the system-wide default `asterisk` service's own /etc/asterisk —
// confirmed sole owner (nothing else in this codebase writes here; Asterisk-2G
// is a fully separate instance at /etc/asterisk-2g), so no shared/sharedWith
// flags needed the way gsm-controller.ts's manifest needs for its cross-module
// osmo-* files.
const PSTN_CONFIG_MANIFEST: Omit<PstnConfigFile, 'exists'>[] = [
  { path: HOST_ASTERISK_CONF,  label: 'asterisk.conf',        group: '4G/5G Voice Gateway', language: 'ini', restartServices: ['asterisk'] },
  { path: HOST_PJSIP_INC,      label: 'pjsip_pstn.conf',      group: '4G/5G Voice Gateway', language: 'ini', restartServices: ['asterisk'] },
  { path: HOST_EXTENSIONS_INC, label: 'extensions_pstn.conf', group: '4G/5G Voice Gateway', language: 'ini', restartServices: ['asterisk'] },
  { path: HOST_PJSIP_CONF,     label: 'pjsip.conf',           group: '4G/5G Voice Gateway', language: 'ini', restartServices: ['asterisk'] },
  { path: HOST_EXTENSIONS_CONF, label: 'extensions.conf',     group: '4G/5G Voice Gateway', language: 'ini', restartServices: ['asterisk'] },
  { path: HOST_MODULES_CONF,   label: 'modules.conf',         group: '4G/5G Voice Gateway', language: 'ini', restartServices: ['asterisk'] },
  { path: HOST_RTP_CONF,       label: 'rtp.conf',              group: '4G/5G Voice Gateway', language: 'ini', restartServices: ['asterisk'] },
];
const PSTN_ALLOWED_PATHS = new Set(PSTN_CONFIG_MANIFEST.map(f => f.path));

function getExtensionsCollection(mongoUri: string): { client: MongoClient; collection: Collection<PstnExtension> } {
  const client = new MongoClient(mongoUri);
  return { client, collection: client.db('open5gs').collection<PstnExtension>('pstn_extensions') };
}

async function withExtensions<T>(mongoUri: string, fn: (col: Collection<PstnExtension>) => Promise<T>): Promise<T> {
  const { client, collection } = getExtensionsCollection(mongoUri);
  try {
    await client.connect();
    return await fn(collection);
  } finally {
    await client.close();
  }
}

// ── Asterisk config generation ──────────────────────────────────────────────

function pjsipPstnConf(asteriskIp: string, icscfIp: string, icscfPort: number, scscfIp: string, mediaIp: string, crossRanPeer: { ip: string; port: number } | null): string {
  // Cross-RAN Calling: peers with Asterisk-2G's own instance so a call to a
  // 2G short code can be dialed from this side and vice versa. Written/
  // removed only by setCrossRanCalling() below. Reuses transport-trunk (a
  // PJSIP transport is the local UDP socket bound to asteriskIp:ASTERISK_PORT
  // — every endpoint on this instance shares the one transport regardless of
  // how many distinct peers reference it; a second type=transport on the
  // same bind would just fail to load). allow= is ordered gsm before
  // amrwb/amr — this endpoint ultimately feeds toward Asterisk-2G's
  // GSM-only sipconn endpoint, so biasing negotiation toward GSM-FR here
  // keeps the call to exactly one transcode hop rather than risking a
  // double transcode. direct_media=no is a hard functional requirement
  // here, not inherited B2BUA hardening habit: transcoding is only possible
  // while Asterisk itself stays in the RTP path on both legs. See
  // CLAUDE.md's Cross-RAN Calling pattern entry for the full design.
  const crossRanBlock = crossRanPeer ? `
[asterisk2g_trunk]
type=identify
endpoint=asterisk2g_trunk
match=${crossRanPeer.ip}

[asterisk2g_trunk]
type=aor
contact=sip:${crossRanPeer.ip}:${crossRanPeer.port}

[asterisk2g_trunk]
type=endpoint
context=pstn-internal
disallow=all
allow=gsm
allow=amrwb
allow=amr
aors=asterisk2g_trunk
transport=transport-trunk
direct_media=no
trust_id_inbound=yes
asymmetric_rtp_codec=yes
codec_prefs_outgoing_offer=prefer:pending,operation:intersect,keep:all,transcode:allow
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
rtp_keepalive=5
` : '';
  return `; Generated by the NMS's PSTN Gateway module — do not edit by hand,
; regenerated on every Configure call.

; SIP signaling stays on Asterisk's own loopback alias (only Kamailio talks
; to it directly here) but RTP is advertised on P-CSCF/rtpengine's own real,
; UE-reachable IP (external_media_address) instead of the loopback — real
; phones can't route to 127.0.1.4. Confirmed live 2026-07-27: without this,
; the callee leg's raw offer/answer carried the unreachable loopback address
; and that direction's audio never worked no matter how P-CSCF's own
; rtpengine handling was patched (three attempts, all reverted) — reusing
; the address rtpengine/P-CSCF already advertise sidesteps the problem
; entirely, since it's already proven reachable for every other IMS flow.
; Asterisk's RTP socket itself still binds wildcard (rtp.conf default), so
; it actually receives what it advertises here.
[transport-trunk]
type=transport
protocol=udp
bind=${asteriskIp}:${ASTERISK_PORT}
external_media_address=${mediaIp}

; Trusted, unauthenticated peer representing Kamailio S-CSCF — S-CSCF's
; dispatcher forwards PSTN-bound INVITEs here. AOR contact points at I-CSCF
; (the correct entry point for calls Asterisk originates back into the core —
; confirmed via the PoC: sending directly to S-CSCF skips the Cx LIR lookup).
[scscf_trunk]
type=identify
endpoint=scscf_trunk
match=${scscfIp}

[scscf_trunk]
type=aor
contact=sip:${icscfIp}:${icscfPort}

[scscf_trunk]
type=endpoint
context=pstn-internal
disallow=all
allow=amrwb
allow=amr
allow=ulaw
allow=alaw
aors=scscf_trunk
transport=transport-trunk
direct_media=no
trust_id_inbound=yes
; Real bug found live (2026-08-15): confirmed via raw packet capture that a
; PSTN Gateway call's two independent dialogs (caller<->Asterisk, Asterisk
; <->callee) each negotiate their OWN dynamic RTP payload-type numbers for
; the same codec (e.g. one leg negotiates AMR as payload type 97, the other
; negotiates the SAME AMR as payload type 113 — both are valid, unrelated
; SDP negotiations). When Asterisk bridges audio between the two, it must
; rewrite each outgoing RTP packet's payload-type field to match whatever
; number THAT destination leg actually negotiated. Confirmed via tshark that
; without this it does not: a caller's phone received real audio packets
; carrying payload type 113 — a value its own SDP negotiation never defined
; (only 99/97/100) — so the audio, while arriving correctly on the wire, was
; undecodable. asymmetric_rtp_codec=yes lets each leg keep its own
; independent codec/payload-type identity instead of forcing one shared
; assumption across both, which is exactly this scenario. Confirmed live
; this alone did NOT fix it — the mismatch persisted byte-for-byte after
; this was applied, so it's left in place as a real, correct setting for
; this deployment but is not sufficient by itself.
asymmetric_rtp_codec=yes
; Same 2026-08-15 investigation, next attempt: default codec_prefs_outgoing_
; offer is "operation:union" — when Asterisk builds its OWN offer for the
; callee leg, union lets it independently offer every codec in this
; endpoint's own allow= list (its own default numbering, e.g. AMR as
; payload type 113) regardless of what the caller's leg already negotiated
; (e.g. AMR as payload type 97) — two structurally unrelated SDP offers for
; the "same" codec. Switching to "operation:intersect" constrains the
; callee-leg offer to codecs already pending from the caller's leg, in the
; hope that reusing the already-negotiated codec identity avoids Asterisk
; re-deriving its own independent (and differently-numbered) offer for the
; same format. Unverified — reverify PSTN Gateway audio after this lands.
codec_prefs_outgoing_offer=prefer:pending,operation:intersect,keep:all,transcode:allow
; The callee leg's own offer (Asterisk -> a real UE) now carries a real,
; reachable address (external_media_address above) and passes through
; P-CSCF untouched — but the callee's OWN answer still gets rewritten onto
; a rtpengine relay port that was never told where Asterisk actually is
; (nothing processes this leg's offer on the P-CSCF side, and re-adding
; that broke call signaling outright in three separate live attempts — see
; memory pstn-asterisk-media-ip-fix). Symmetric RTP sidesteps the problem
; entirely: once the real UE's packets arrive at Asterisk's own real,
; reachable socket (confirmed working, that's the direction that already
; has audio), Asterisk learns the UE's true address from the source of
; those packets and sends its own outbound audio there directly, ignoring
; the broken rtpengine-relay address the SDP answer advertised.
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
; Real bug found live (2026-09-14): confirmed via packet capture + live
; Asterisk channel/bridge inspection that a call can complete signaling
; perfectly (both legs answer, bridge forms, both channels show Up) while
; Asterisk transmits zero RTP on either leg for the whole call — reproduced
; identically twice for one specific direction while the reverse direction
; worked every time, with every other aspect of the two calls (dialplan,
; codec negotiation, bridge technology selection) proven byte-for-byte
; identical. Given rtp_symmetric above means Asterisk MUST learn each leg's
; real send destination from the first inbound packet rather than trusting
; the SDP answer, a call whose very first learn-then-transmit attempt loses
; a timing race (plausible given real, different devices/radio paths on
; each end) has nothing to ever retry it without this. Matches a documented
; Asterisk community fix for the identical simple_bridge/no-audio symptom.
rtp_keepalive=5
${crossRanBlock}`;
}

// One literal extension per mapping — matches this project's usual "regenerate
// the whole config on change" convention (see IMS/SMS). A future refinement
// could move this to Asterisk Realtime (ODBC-backed dialplan lookup) to avoid
// a reload on every single mapping change — noted in the PSTN plan, not done
// here since a reload is cheap and this list is expected to stay small.
function extensionsPstnConf(imsDomain: string, extensions: PstnExtension[], echoTestNumber: string, crossRanPeerCodes: { extension: string; label?: string }[]): string {
  const header = `; Generated by the NMS's PSTN Gateway module — do not edit by hand,
; regenerated on every extension add/remove.

[pstn-internal]
; Exact literal match — Asterisk always tries this before any subscriber
; extension pattern below, and it's answered locally (no Dial() back out
; through S-CSCF), so it works even with zero subscriber extensions assigned.
exten => ${echoTestNumber},1,NoOp(PSTN Gateway Echo Test)
 same => n,Answer()
 same => n,Wait(1)
 same => n,Playback(demo-echotest)
 same => n,Echo()
 same => n,Playback(demo-echodone)
 same => n,Hangup()

`;
  const entries = extensions.map(e => {
    // Dial by bare IMSI@scscf_trunk, NOT a full "sip:imsi@domain@scscf_trunk"
    // string — confirmed via the PoC that chan_pjsip's dial-string parser
    // mis-splits on the wrong '@' when the "user" part is itself a full URI
    // (it took the domain+endpoint as one bogus endpoint name). Using the
    // bare IMSI lets the AOR's static contact (I-CSCF) supply the actual
    // destination host; the resulting Request-URI becomes
    // sip:<imsi>@<icscf-ip>:<port>, which I-CSCF accepts fine (its
    // `uri==myself` check is IP:port-based, no alias needed) and correctly
    // performs Cx LIR on regardless of what domain suffix is attached.
    // No backslash-escaping of "+" — confirmed live that it's unnecessary AND
    // harmful here: Asterisk only treats leading characters specially for
    // pattern extensions (those starting with "_"), so a plain `exten =>
    // 1111,...` is already a literal match. Escaping it produced a dialplan
    // entry whose *stored* name included a literal backslash character,
    // which then never matched the actual dialed digits at all
    // (`channel originate`/incoming INVITEs both fail dialplan lookup with
    // "No such extension/context" until this is removed).
    //
    // Two literal exten lines per mapping — the bare digit string (what a
    // real phone actually dials for an in-network-looking number via tel:
    // URI + phone-context, confirmed live 2026-07-27) and a "+"-prefixed
    // variant (in case something dials in genuine E.164 form instead). Both
    // point at the same subscriber, so either dialing convention works.
    const body = `1,NoOp(PSTN Gateway: routing to subscriber ${e.subscriberImsi}${e.label ? ' (' + e.label + ')' : ''})
 same => n,Dial(PJSIP/${e.subscriberImsi}@scscf_trunk,60)
 same => n,Hangup()
`;
    return `exten => ${e.extension},${body}\nexten => +${e.extension},${body}`;
  }).join('\n');

  // Cross-RAN Calling: forward, don't resolve — dial the SAME digit string
  // out to asterisk2g_trunk so the call re-enters Asterisk-2G's own dialplan
  // at the exact short code it already owns, where its own existing
  // per-mapping Dial() logic completes it unchanged. This side never needs
  // to know which subscriber a 2G short code actually resolves to.
  const crossRanEntries = crossRanPeerCodes.map(e => {
    const body = `1,NoOp(Cross-RAN -> 2G short code ${e.extension}${e.label ? ' (' + e.label + ')' : ''})
 same => n,Dial(PJSIP/${e.extension}@asterisk2g_trunk,60)
 same => n,Hangup()
`;
    return `exten => ${e.extension},${body}`;
  }).join('\n');

  return header + entries + '\n' + crossRanEntries;
}

// Direct Mongo read, no join needed — cross-RAN forwarding only needs the
// CODE, not a resolved subscriber. Exported for asterisk-2g-controller.ts's
// own extensions2gConf() generation path to consume via a lazy import (see
// that file's isAsterisk2gInstalled() comment for why that direction has to
// stay lazy while this one — pstn-controller.ts -> asterisk-2g-controller.ts
// — is already a safe, pre-existing static import). See CLAUDE.md's
// Cross-RAN Calling entry for the full ownership map.
export async function listPstnShortCodesForCrossRan(mongoUri: string): Promise<{ extension: string; label?: string }[]> {
  const extensions = await withExtensions(mongoUri, col => col.find({}).toArray());
  return extensions.map(e => ({ extension: e.extension, label: e.label }));
}

export function getPstnEchoTestNumber(): string {
  return readPstnState()?.echoTestNumber || DEFAULT_ECHO_TEST_NUMBER;
}

export function getPstnBindAddress(): { ip: string; port: number } | null {
  const state = readPstnState();
  return state ? { ip: state.asteriskIp, port: ASTERISK_PORT } : null;
}

// Static import (the pre-existing safe direction) — no lazy import needed on
// this side, unlike asterisk-2g-controller.ts's own copy of this helper.
async function getCrossRanPeerCodes(mongoUri: string): Promise<{ extension: string; label?: string }[]> {
  const state = readPstnState();
  if (!state?.crossRanEnabled) return [];
  return listGsm2gShortCodesForCrossRan(mongoUri);
}

async function isCodecGsmLoadedPstn(): Promise<boolean> {
  try {
    const { stdout } = await nsenter('asterisk', ['-rx', 'module show like codec_gsm']);
    return /Running/.test(stdout);
  } catch { return false; }
}

async function regenerateDialplan(mongoUri: string, echoTestNumber?: string): Promise<void> {
  const imsState = readImsState();
  if (!imsState) throw new Error('IMS is not configured yet — configure IMS before assigning PSTN extensions.');
  const extensions = await withExtensions(mongoUri, col => col.find({}).toArray());
  const resolvedEchoTestNumber = echoTestNumber || readPstnState()?.echoTestNumber || DEFAULT_ECHO_TEST_NUMBER;
  const crossRanPeerCodes = await getCrossRanPeerCodes(mongoUri);
  fs.mkdirSync(HOST_ASTERISK_DIR, { recursive: true });
  fs.writeFileSync(HOST_EXTENSIONS_INC, extensionsPstnConf(imsState.imsDomain, extensions, resolvedEchoTestNumber, crossRanPeerCodes), 'utf-8');
  await nsenter('asterisk', ['-rx', 'dialplan reload']).catch(() => {});
}

// Asterisk's bridge_native_rtp technology (a same-codec RTP-frame-forwarding
// optimization, unrelated to and not controlled by the endpoint's own
// direct_media=no) silently broke one direction of audio for a bridged
// UE-to-UE-via-Asterisk call - confirmed live 2026-07-28 via "rtp set debug"
// + full PJSIP session logging: the affected leg negotiated its SDP
// correctly (matching codec, valid rtpengine relay address) but Asterisk
// never actually sent anything once the bridge switched to native_rtp
// technology, and only recovered right at call teardown when it fell back
// to core/software bridging ("media will flow through Asterisk core").
// "bridge technology suspend native_rtp" forces every call to always use
// that reliable core-bridging path. This is a per-process runtime toggle,
// not a config file setting, so it must be re-applied after every Asterisk
// (re)start - see callers of ensureNativeRtpBridgeSuspended() below.
async function ensureNativeRtpBridgeSuspended(): Promise<void> {
  await nsenter('asterisk', ['-rx', 'bridge technology suspend native_rtp']).catch(() => {});
}

function ensureIncludes(): void {
  fs.mkdirSync(HOST_ASTERISK_DIR, { recursive: true });
  if (fs.existsSync(HOST_PJSIP_CONF)) {
    const raw = fs.readFileSync(HOST_PJSIP_CONF, 'utf-8');
    if (!raw.includes('pjsip_pstn.conf')) {
      fs.writeFileSync(HOST_PJSIP_CONF, '#include pjsip_pstn.conf\n' + raw, 'utf-8');
    }
  } else {
    fs.writeFileSync(HOST_PJSIP_CONF, '#include pjsip_pstn.conf\n', 'utf-8');
  }
  if (fs.existsSync(HOST_EXTENSIONS_CONF)) {
    const raw = fs.readFileSync(HOST_EXTENSIONS_CONF, 'utf-8');
    if (!raw.includes('extensions_pstn.conf')) {
      fs.writeFileSync(HOST_EXTENSIONS_CONF, '#include extensions_pstn.conf\n' + raw, 'utf-8');
    }
  } else {
    fs.writeFileSync(HOST_EXTENSIONS_CONF, '#include extensions_pstn.conf\n', 'utf-8');
  }
}

function disableChanSip(): void {
  fs.mkdirSync(HOST_ASTERISK_DIR, { recursive: true });
  const marker = 'noload => chan_sip.so';
  let raw = fs.existsSync(HOST_MODULES_CONF) ? fs.readFileSync(HOST_MODULES_CONF, 'utf-8') : '[modules]\nautoload=yes\n';
  if (!raw.includes(marker)) {
    if (!/\[modules\]/.test(raw)) raw = '[modules]\nautoload=yes\n' + raw;
    raw = raw.replace(/\[modules\]\n/, `[modules]\n${marker}\n`);
    fs.writeFileSync(HOST_MODULES_CONF, raw, 'utf-8');
  }
}

// Real bug found live (2026-08-15): PSTN Gateway calls had one-way audio —
// confirmed via a live RTCP capture that Asterisk was sending audio fine (a
// Sender Report showing a real packet/octet count) but its own compound RTCP
// packet had "Reception report count: 0", meaning it never received anything
// to report on, even though the caller's real RTP was independently confirmed
// (via tcpdump) arriving at the right destination address:port. Root cause:
// Asterisk's own SDP offer to the caller's leg (built from the *original*
// R-URI-facing offer, which advertises rtpengine's relay address/port, not
// the real UE) sets its strict-RTP "expected source" to rtpengine's address —
// but because this leg's reply-SDP is never itself rewritten by rtpengine
// (see the external_media_address comment above — re-adding that processing
// broke call signaling outright in three separate prior live attempts, so it
// deliberately stays untouched), the caller's real audio always arrives from
// a source address strict RTP was never told to expect. `probation` (4
// frames) should normally let Asterisk re-learn a new source, but combined
// with `rtp_symmetric`/`force_rport` on this trunk it never did in practice —
// confirmed fixed live by disabling strict RTP entirely for this host.
// Acceptable trade-off here specifically: this PSTN Gateway is internal-only
// with no public SIP trunk (see CLAUDE.md's feature table), so the anti-
// spoofing protection strict RTP provides isn't protecting an internet-facing
// surface. `strictrtp` is a global rtp.conf setting, not a per-endpoint PJSIP
// option, and has no live CLI toggle — it must be written to the config file
// and picked up via a res_rtp_asterisk module reload (or full Asterisk
// restart), so — like disableChanSip() above — this must run on every
// Configure, not just once.
async function ensureStrictRtpDisabled(): Promise<void> {
  fs.mkdirSync(HOST_ASTERISK_DIR, { recursive: true });
  let raw = fs.existsSync(HOST_RTP_CONF) ? fs.readFileSync(HOST_RTP_CONF, 'utf-8') : '[general]\n';
  if (!/\[general\]/.test(raw)) raw = '[general]\n' + raw;
  if (/^\s*;?\s*strictrtp\s*=/m.test(raw)) {
    raw = raw.replace(/^\s*;?\s*strictrtp\s*=.*$/m, 'strictrtp=no');
  } else {
    raw = raw.replace(/\[general\]\n/, '[general]\nstrictrtp=no\n');
  }
  fs.writeFileSync(HOST_RTP_CONF, raw, 'utf-8');
  // The real bug, found live (2026-08-15) after this fix appeared to silently
  // do nothing across many restarts: fs.writeFileSync() from this container
  // creates/overwrites the file as root:root — every OTHER file under
  // /etc/asterisk ships owned asterisk:asterisk, and Asterisk itself runs as
  // that unprivileged user, so a root-owned rtp.conf with the default 0640
  // mode is completely unreadable to the process that needs it. Asterisk
  // doesn't error on this — it silently falls back to every compiled-in
  // default (confirmed live: rtpstart/rtpend reverted to 5000/31000 instead
  // of this file's real values), which is a much harder failure to notice
  // than an outright crash. Without this chown, strictrtp=no above is a
  // complete no-op forever, no matter how many times Asterisk is restarted.
  await nsenter('chown', ['asterisk:asterisk', HOST_RTP_CONF.replace(HOST_ROOT, '')]).catch(() => {});
}

// Real bug found live (2026-08-15): both of these used to `systemctl restart
// kamailio-scscf` just to pick up a dispatcher.list change — S-CSCF's own usrloc
// registrar is memory-only (db_mode=0, same limitation ims-controller.ts's
// ulscscf.snapshot workaround documents), so restarting it wipes EVERY currently
// registered subscriber network-wide (VoLTE and VoWiFi alike, not just PSTN),
// until each phone's own periodic re-REGISTER timer eventually fires — confirmed
// live via a real "PSTN gateway doesn't work" report that was actually this: an
// operator added a PSTN extension, the restart silently deregistered two live
// VoWiFi UEs, and a test call ~3.5 minutes later failed with "destination user
// not found" for a completely unrelated reason. The dispatcher module has its
// own RPC-based reload that re-reads dispatcher.list from disk without touching
// the rest of the running process (verified live: same PID, same
// ActiveEnterTimestamp, before and after) — use that instead, never restart the
// whole service just to update the PSTN dispatcher target.
async function reloadDispatcher(): Promise<void> {
  await nsenter('kamcmd', ['-s', '/run/kamailio_scscf/kamailio_ctl', 'dispatcher.reload']);
}

async function writeDispatcherEntry(asteriskIp: string): Promise<void> {
  fs.writeFileSync(HOST_DISPATCHER_LIST, `1 sip:${asteriskIp}:${ASTERISK_PORT}\n`, 'utf-8');
  await reloadDispatcher();
}

async function clearDispatcherEntry(): Promise<void> {
  fs.writeFileSync(HOST_DISPATCHER_LIST, '# PSTN Gateway disabled — no entries\n', 'utf-8');
  await reloadDispatcher();
}

// ── Router ───────────────────────────────────────────────────────────────────

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same install logic in-process — write() is the only side-channel.
export async function installPstn(write: (s: string) => void): Promise<{ success: boolean; error?: string; codecAmrLoaded?: boolean }> {
  try {
      write('=== Installing Asterisk ===');
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

      write('\n=== Disabling deprecated chan_sip (chan_pjsip only) ===');
      disableChanSip();
      await nsenter('systemctl', ['enable', '--now', 'asterisk']);
      await new Promise(r => setTimeout(r, 2000));
      await nsenter('asterisk', ['-rx', 'module unload chan_sip.so']).catch(() => {});
      await ensureNativeRtpBridgeSuspended();
      write('chan_sip disabled.');

      write('\n=== Verifying AMR/AMR-WB codec support ===');
      let codecOk = false;
      try {
        const { stdout } = await nsenter('asterisk', ['-rx', 'module show like codec_amr']);
        codecOk = /Running/.test(stdout);
      } catch { /* ignore */ }
      if (codecOk) {
        write('✅ codec_amr.so loaded and running — AMR-WB↔G.711 transcoding available.');
      } else {
        write('⚠️  codec_amr.so did not load. Real VoLTE calls (AMR-WB) will not be able to\n' +
          '   transcode to the PSTN side. This host\'s asterisk-modules package should\n' +
          '   include it — check `asterisk -rx "module show like amr"` manually.');
      }

      write('\n=== Verifying GSM-FR codec support (needed only if Cross-RAN Calling is enabled later) ===');
      const codecGsmOk = await isCodecGsmLoadedPstn();
      write(codecGsmOk
        ? '✅ codec_gsm.so loaded and running.'
        : '⚠️  codec_gsm.so did not load — Cross-RAN Calling to a 2G short code will not be available until it does.');

      write('\n✅ Asterisk installed. Run Configure next.');
      return { success: true, codecAmrLoaded: codecOk };
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      return { success: false, error: String(err) };
    }
}

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same configure logic in-process, always passing the last-saved
// asteriskIp explicitly rather than falling back to DEFAULT_ASTERISK_IP — a
// re-Configure with defaults would silently reset a real per-deployment value.
export async function configurePstn(
  input: { asteriskIp: string; echoTestNumber?: string },
  mongoUri: string,
): Promise<{ success: boolean; error?: string; message?: string; asteriskIp?: string }> {
  const asteriskIp = input.asteriskIp || DEFAULT_ASTERISK_IP;
  try {
      const imsState = readImsState();
      if (!imsState) {
        return { success: false, error: 'IMS is not configured yet — configure IMS first.' };
      }

      const existing = readPstnState();
      const echoTestNumber = input.echoTestNumber || existing?.echoTestNumber || DEFAULT_ECHO_TEST_NUMBER;
      const collision = await withExtensions(mongoUri, col => col.findOne({ extension: echoTestNumber })).catch(() => null);
      if (collision) {
        return { success: false, error: `Echo test number ${echoTestNumber} collides with an assigned subscriber extension — pick a different one.` };
      }

      // Idempotent — matches the loopback-alias convention already used for
      // every other IMS component (I-CSCF/S-CSCF each have their own).
      await nsenter('ip', ['addr', 'add', `${asteriskIp}/8`, 'dev', 'lo']).catch(() => {});

      ensureIncludes();
      // Preserve the existing Cross-RAN Calling wiring across a routine
      // Configure call — this rewrites pjsip_pstn.conf wholesale, so without
      // re-deriving this, an unrelated re-Configure would silently drop the
      // asterisk2g_trunk peer even though crossRanEnabled itself is
      // untouched by this function. See CLAUDE.md's Cross-RAN Calling entry.
      const crossRanPeer = existing?.crossRanEnabled ? getAsterisk2gBindAddress() : null;
      fs.writeFileSync(HOST_PJSIP_INC, pjsipPstnConf(asteriskIp, imsState.config.icscfIp, imsState.config.icscfPort, imsState.config.scscfIp, imsState.config.pcscfIp, crossRanPeer), 'utf-8');
      await ensureStrictRtpDisabled();
      await regenerateDialplan(mongoUri, echoTestNumber);

      await nsenter('systemctl', ['enable', '--now', 'asterisk']);
      await nsenter('asterisk', ['-rx', 'module reload res_pjsip.so']).catch(() => {});
      await nsenter('asterisk', ['-rx', 'module reload res_rtp_asterisk.so']).catch(() => {});
      await ensureNativeRtpBridgeSuspended();
      await writeDispatcherEntry(asteriskIp);

      writePstnState({ asteriskIp, echoTestNumber, crossRanEnabled: existing?.crossRanEnabled, configuredWithVersion: getAppVersion() });

      return { success: true, message: 'Asterisk configured and wired into S-CSCF\'s dispatcher.', asteriskIp };
    } catch (err) {
      return { success: false, error: String(err) };
    }
}

// ── Cross-RAN Calling (4G/5G <-> 2G short-code bridging) ────────────────────
//
// One-time full sweep at enable time — catches any collision predating the
// toggle (unlike the gated per-add guard in each POST /extensions handler,
// which only prevents NEW collisions once cross-RAN is already live; the two
// checks are complementary, neither is redundant with the other).
async function findCrossRanCollisions(mongoUri: string): Promise<string[]> {
  const [pstnExtensions, gsm2gCodes] = await Promise.all([
    withExtensions(mongoUri, col => col.find({}).toArray()),
    listGsm2gShortCodesForCrossRan(mongoUri),
  ]);
  const gsm2gSet = new Set(gsm2gCodes.map(c => c.extension));
  const pstnEcho = readPstnState()?.echoTestNumber || DEFAULT_ECHO_TEST_NUMBER;
  const gsm2gEcho = getAsterisk2gEchoTestNumber();
  const collisions = new Set<string>();
  for (const e of pstnExtensions) {
    if (gsm2gSet.has(e.extension)) collisions.add(e.extension);
    if (e.extension === gsm2gEcho) collisions.add(e.extension);
  }
  if (gsm2gSet.has(pstnEcho)) collisions.add(pstnEcho);
  return [...collisions];
}

// Sole orchestrator for the Cross-RAN Calling toggle — lives here (not in
// asterisk-2g-controller.ts) because the Extensions-tab button that drives
// it lives on the Voice Gateway page, whose primary API is pstnApi. Always
// configures PSTN's own half directly, then delegates Asterisk-2G's own half
// to setCrossRanPeer() via the pre-existing safe static import direction
// (see isAsterisk2gInstalled()'s own comment in asterisk-2g-controller.ts) —
// never the reverse. Deliberately never calls systemctl — both instances
// must already be installed+configured (and therefore already running)
// before this can be called; only live module/dialplan reloads, matching
// this function's own configurePstn()'s "never a full restart" convention.
//
// No rollback on a partial failure, by design: both dialplans are
// exact-match-only (this file has no catch-all at all; Asterisk-2G's _X.
// pattern always loses to an exact match in the same context regardless of
// declaration order), so a half-applied state just means a call fails to
// route on one side — it can never misroute or corrupt an in-progress call.
// Surfacing the specific inconsistency (rather than silently reverting) lets
// an operator retry the same action to converge, instead of hiding a
// half-wired trunk behind a UI that falsely claims "disabled".
export async function setCrossRanCalling(
  enabled: boolean,
  mongoUri: string,
  subscriberRepo: ISubscriberRepository,
): Promise<{ success: boolean; error?: string; collisions?: string[] }> {
  try {
    const existing = readPstnState();
    if (!existing) {
      return { success: false, error: 'PSTN Gateway is not configured yet — configure it first.' };
    }
    if (!isAsterisk2gInstalled()) {
      return { success: false, error: 'Asterisk-2G is not installed yet — install and configure it on the GSM page\'s 2G Voice tab first.' };
    }

    if (enabled) {
      const collisions = await findCrossRanCollisions(mongoUri);
      if (collisions.length > 0) {
        return {
          success: false,
          error: `${collisions.length} short code(s) are assigned on both sides — resolve these before enabling Cross-RAN Calling: ${collisions.join(', ')}`,
          collisions,
        };
      }
      if (!(await isCodecGsmLoadedPstn())) {
        return { success: false, error: 'codec_gsm.so is not loaded on this instance — required for Cross-RAN Calling\'s transcoding. Check `module show like codec_gsm`.' };
      }
    }

    const asterisk2gPeer = enabled ? getAsterisk2gBindAddress() : null;
    if (enabled && !asterisk2gPeer) {
      return { success: false, error: 'Asterisk-2G is not configured yet — configure it first.' };
    }

    const imsState = readImsState();
    if (!imsState) {
      return { success: false, error: 'IMS is not configured — cannot regenerate the dialplan.' };
    }

    // Written BEFORE the regen below so regenerateDialplan()'s own
    // getCrossRanPeerCodes() (which reads this same state) picks up the new
    // value immediately.
    writePstnState({ ...existing, crossRanEnabled: enabled });

    fs.writeFileSync(HOST_PJSIP_INC, pjsipPstnConf(existing.asteriskIp, imsState.config.icscfIp, imsState.config.icscfPort, imsState.config.scscfIp, imsState.config.pcscfIp, asterisk2gPeer), 'utf-8');
    await regenerateDialplan(mongoUri, existing.echoTestNumber);
    await nsenter('asterisk', ['-rx', 'module reload res_pjsip.so']).catch(() => {});

    const peerResult = await setCrossRanPeer(enabled, mongoUri, subscriberRepo);
    if (!peerResult.success) {
      return {
        success: false,
        error: `PSTN side ${enabled ? 'enabled' : 'disabled'} but Asterisk-2G side failed: ${peerResult.error} — ` +
          `Cross-RAN Calling is now in an inconsistent state; retry ${enabled ? 'enabling' : 'disabling'} to converge.`,
      };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export interface PstnStalenessResult {
  installed: boolean;
  hasSavedConfig: boolean;
  configStale: boolean;
  configuredWithVersion?: string;
  savedAsteriskIp?: string;
}

// Cheap staleness check for the cross-module Fix-All aggregator — mirrors the
// comparison GET /status already does. PSTN has no install-staleness concept
// (installStale field doesn't exist for this module — see /status above).
export async function getPstnStaleness(): Promise<PstnStalenessResult> {
  const { stdout: whichOut } = await nsenter('which', ['asterisk']).catch(() => ({ stdout: '', stderr: '' }));
  const installed = whichOut.trim().length > 0;
  const state = readPstnState();
  const appVersion = getAppVersion();
  const configStale = !!state && state.configuredWithVersion !== appVersion;
  return {
    installed,
    hasSavedConfig: !!state,
    configStale,
    configuredWithVersion: state?.configuredWithVersion,
    savedAsteriskIp: state?.asteriskIp,
  };
}

export function createPstnRouter(
  subscriberRepo: ISubscriberRepository,
  mongoUri: string,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const { stdout: whichOut } = await nsenter('which', ['asterisk']).catch(() => ({ stdout: '', stderr: '' }));
      const installed = whichOut.trim().length > 0;

      const [asteriskRes, scscfRes] = await Promise.allSettled([
        nsenter('systemctl', ['is-active', 'asterisk']),
        nsenter('systemctl', ['is-active', 'kamailio-scscf']),
      ]);
      const svcActive = (r: PromiseSettledResult<{ stdout: string; stderr: string }>) =>
        r.status === 'fulfilled' && r.value.stdout.trim() === 'active';

      let codecAmrLoaded = false;
      let codecGsmLoaded = false;
      if (installed) {
        try {
          const { stdout } = await nsenter('asterisk', ['-rx', 'module show like codec_amr']);
          codecAmrLoaded = /Running/.test(stdout);
        } catch { /* asterisk not running yet */ }
        codecGsmLoaded = await isCodecGsmLoadedPstn();
      }

      const state = readPstnState();
      const imsState = readImsState();

      let dispatcherWired = false;
      if (fs.existsSync(HOST_DISPATCHER_LIST)) {
        const raw = fs.readFileSync(HOST_DISPATCHER_LIST, 'utf-8');
        dispatcherWired = /^1\s+sip:/m.test(raw);
      }

      const extensions = await withExtensions(mongoUri, col => col.find({}).toArray()).catch(() => []);

      // See ims-controller.ts's identical check — no recorded version at
      // all (pre-dates this field) counts as stale too, since we don't
      // know what template that deployment is actually running.
      const appVersion = getAppVersion();
      const configStale = !!state && state.configuredWithVersion !== appVersion;

      res.json({
        success: true,
        installed,
        services: { asterisk: svcActive(asteriskRes), 'kamailio-scscf': svcActive(scscfRes) },
        codecAmrLoaded,
        codecGsmLoaded,
        crossRanEnabled: !!state?.crossRanEnabled,
        imsInstalled: await isImsInstalled(),
        imsConfigured: !!imsState,
        hasSavedConfig: !!state,
        dispatcherWired,
        pstnEnabled: dispatcherWired,
        currentConfig: state
          ? { ...state, echoTestNumber: state.echoTestNumber ?? DEFAULT_ECHO_TEST_NUMBER }
          : { asteriskIp: DEFAULT_ASTERISK_IP, echoTestNumber: DEFAULT_ECHO_TEST_NUMBER },
        extensionCount: extensions.length,
        appVersion,
        configuredWithVersion: state?.configuredWithVersion,
        configStale,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'pstn status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/install — streaming apt install of Asterisk, matching the
  // PoC: verifies codec_amr.so actually loads afterward (Phase 0's gate
  // condition) rather than just trusting the package installed cleanly.
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (!(await isImsInstalled())) {
      return res.status(400).json({ success: false, error: 'IMS is not installed yet — install IMS on the IMS page first. PSTN Gateway is built entirely on top of IMS\'s Kamailio signaling chain.' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const result = await installPstn(write);
    await auditLogger.log({ action: 'pstn_install', user, details: result.error ?? `codecAmrLoaded=${result.codecAmrLoaded}`, success: result.success });
    res.end();
  });

  // POST /api/pstn/configure — body: { asteriskIp?, echoTestNumber? }
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const asteriskIp = (req.body.asteriskIp as string) || DEFAULT_ASTERISK_IP;
    const echoTestNumber = req.body.echoTestNumber as string | undefined;
    const result = await configurePstn({ asteriskIp, echoTestNumber }, mongoUri);
    if (!result.success) {
      await auditLogger.log({ action: 'pstn_configure', user, details: result.error ?? 'failed', success: false });
      return res.status(400).json({ success: false, error: result.error });
    }
    await auditLogger.log({ action: 'pstn_configure', user, details: `asteriskIp=${result.asteriskIp}`, success: true });
    res.json({ success: true, message: result.message, asteriskIp: result.asteriskIp });
  });

  // GET /api/pstn/extensions — list mappings, joined with subscriber nickname/MSISDN
  router.get('/extensions', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const extensions = await withExtensions(mongoUri, col => col.find({}).sort({ extension: 1 }).toArray());
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
      logger.error({ err: String(err) }, 'pstn extensions list error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/extensions — body: { extension, subscriberImsi, label? }
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
    const echoTestNumber = readPstnState()?.echoTestNumber || DEFAULT_ECHO_TEST_NUMBER;
    if (extension === echoTestNumber) {
      return res.status(400).json({ success: false, error: `${extension} is reserved for the echo test — pick a different extension, or change the echo test number on the Asterisk page first.` });
    }
    // Cross-RAN Calling makes both sides' short codes reachable from either
    // instance, so a number can't mean two different subscribers at once —
    // gated on crossRanEnabled (not unconditional) so two unrelated,
    // never-to-be-bridged deployments can still reuse the same extension
    // freely on each side. See CLAUDE.md's Cross-RAN Calling entry.
    if (readPstnState()?.crossRanEnabled) {
      const peerCodes = await getCrossRanPeerCodes(mongoUri);
      if (peerCodes.some(c => c.extension === extension) || extension === getAsterisk2gEchoTestNumber()) {
        return res.status(409).json({ success: false, error: `${extension} collides with an existing 2G short code or its echo-test number — Cross-RAN Calling is enabled, so short codes must stay unique across both sides.` });
      }
    }
    try {
      const subscriber = await subscriberRepo.findByImsi(subscriberImsi);
      if (!subscriber) return res.status(404).json({ success: false, error: `No subscriber with IMSI ${subscriberImsi}` });

      await withExtensions(mongoUri, async col => {
        const existing = await col.findOne({ extension });
        if (existing) throw new Error(`Extension ${extension} is already assigned`);
        await col.insertOne({ extension, subscriberImsi, label, createdAt: new Date().toISOString() });
      });
      await regenerateDialplan(mongoUri);

      await auditLogger.log({ action: 'pstn_extension_add', user, details: `${extension} -> ${subscriberImsi}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_extension_add', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: String((err as Error).message ?? err) });
    }
  });

  // DELETE /api/pstn/extensions/:extension
  router.delete('/extensions/:extension', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const extension = decodeURIComponent(req.params.extension);
    try {
      await withExtensions(mongoUri, col => col.deleteOne({ extension }));
      await regenerateDialplan(mongoUri);
      await auditLogger.log({ action: 'pstn_extension_remove', user, details: extension, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_extension_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', 'asterisk']);
      await ensureNativeRtpBridgeSuspended();
      await auditLogger.log({ action: 'pstn_start', user, details: 'asterisk started', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', 'asterisk']);
      await auditLogger.log({ action: 'pstn_stop', user, details: 'asterisk stopped', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', 'asterisk']);
      await ensureNativeRtpBridgeSuspended();
      await auditLogger.log({ action: 'pstn_restart', user, details: 'asterisk restarted', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ─── Config file editor (mirrors gsm-controller.ts's /configs endpoints) ──
  router.get('/configs', async (_req: Request, res: Response) => {
    const files: PstnConfigFile[] = PSTN_CONFIG_MANIFEST.map(f => ({ ...f, exists: fs.existsSync(f.path) }));
    res.json({ success: true, files });
  });

  router.get('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const path = req.query.path as string;
    if (!PSTN_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
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
    if (!PSTN_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
    try {
      fs.mkdirSync(HOST_ASTERISK_DIR, { recursive: true });
      fs.writeFileSync(path, content, 'utf-8');
      await auditLogger.log({ action: 'pstn_config_save', user, details: path, success: true });
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
      if (services.includes('asterisk')) await ensureNativeRtpBridgeSuspended();
      await auditLogger.log({ action: 'pstn_config_restart', user, details: services.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/disable — remove the dispatcher entry (S-CSCF stops routing
  // PSTN-bound calls to Asterisk) without uninstalling Asterisk itself.
  router.post('/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await clearDispatcherEntry();
      await auditLogger.log({ action: 'pstn_disable', user, details: 'dispatcher entry removed', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_disable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/enable — restore the dispatcher entry using the last-configured Asterisk IP
  router.post('/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = readPstnState();
      if (!state) return res.status(400).json({ success: false, error: 'No saved config — use Configure first.' });
      await writeDispatcherEntry(state.asteriskIp);
      await auditLogger.log({ action: 'pstn_enable', user, details: `dispatcher entry restored (${state.asteriskIp})`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_enable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/cross-ran/enable, /disable — the Voice Gateway page's
  // Extensions-tab "Enable Cross-RAN Calling" toggle. Deliberately separate
  // paths from /enable and /disable above — those already mean the
  // pstnEnabled/dispatcher-wiring toggle, an unrelated concern on the same
  // page. See setCrossRanCalling() for the full orchestration.
  router.post('/cross-ran/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const result = await setCrossRanCalling(true, mongoUri, subscriberRepo);
    await auditLogger.log({ action: 'pstn_cross_ran_enable', user, details: result.error ?? 'enabled', success: result.success });
    if (!result.success) return res.status(400).json({ success: false, error: result.error, collisions: result.collisions });
    res.json({ success: true });
  });

  router.post('/cross-ran/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const result = await setCrossRanCalling(false, mongoUri, subscriberRepo);
    await auditLogger.log({ action: 'pstn_cross_ran_disable', user, details: result.error ?? 'disabled', success: result.success });
    if (!result.success) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true });
  });

  // POST /api/pstn/uninstall
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    try {
      if (readPstnState()?.crossRanEnabled) {
        write('=== Tearing down Cross-RAN Calling peer on Asterisk-2G (best-effort) ===');
        await setCrossRanPeer(false, mongoUri, subscriberRepo).catch(() => {});
      }

      write('\n=== Removing S-CSCF dispatcher entry ===');
      await clearDispatcherEntry().catch(() => {});
      write('Dispatcher cleared, S-CSCF dispatcher reloaded (no restart — live registrations untouched).');

      write('\n=== Stopping and disabling Asterisk ===');
      await nsenter('systemctl', ['disable', '--now', 'asterisk']).catch(() => {});

      write('\n=== Removing extension mappings ===');
      const removed = await withExtensions(mongoUri, col => col.deleteMany({})).then(r => r.deletedCount).catch(() => 0);
      write(`Removed ${removed} extension mapping(s).`);

      write('\n=== Removing generated config files ===');
      for (const f of [HOST_PJSIP_INC, HOST_EXTENSIONS_INC, HOST_PSTN_STATE]) {
        if (fs.existsSync(f)) { fs.unlinkSync(f); write(`Removed: ${f}`); }
      }

      // The Asterisk-2G module (2G<->2G internal voice) shares this same apt
      // package/binary with an entirely separate, isolated instance of its
      // own (see asterisk-2g-controller.ts's module header) — purging it
      // here would take that instance down too, even though nothing else
      // about this uninstall touches its files/service. Skip the purge (just
      // leave the package installed) if it's present, rather than silently
      // breaking a module this code has no other relationship with.
      if (isAsterisk2gInstalled()) {
        write('\n=== Skipping asterisk/asterisk-modules purge — the Asterisk-2G module (2G-to-2G internal voice) is installed and shares this same package ===');
        write('Uninstall it first (its own page) if you actually want these packages removed.');
        await auditLogger.log({ action: 'pstn_uninstall', user, details: 'apt purge skipped — shared with asterisk-2g', success: true });
        write('\n✅ PSTN Gateway removed (Asterisk package kept — still in use by Asterisk-2G).');
        res.end();
        return;
      }

      write('\n=== Purging asterisk packages ===');
      const exitCode: number = await new Promise((resolve) => {
        const child = exec(`nsenter -t 1 -m -u -i -p -- bash -c 'DEBIAN_FRONTEND=noninteractive apt-get purge -y asterisk asterisk-modules && apt-get autoremove -y'`);
        child.stdout?.on('data', (d: Buffer) => write(d.toString()));
        child.stderr?.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

      await auditLogger.log({ action: 'pstn_uninstall', user, details: `apt exit ${exitCode}`, success: exitCode === 0 });
      write(exitCode === 0 ? '\n✅ PSTN Gateway fully removed.' : `\n⚠️  Asterisk package purge exited ${exitCode} (rest of teardown completed).`);
      res.end();
    } catch (err) {
      await auditLogger.log({ action: 'pstn_uninstall', user, details: String(err), success: false });
      write(`\n❌ Uninstall error: ${String(err)}`);
      res.end();
    }
  });

  return router;
}
