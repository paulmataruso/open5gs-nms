import { Router, Request, Response } from 'express';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { Collection, MongoClient } from 'mongodb';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { requireAdmin } from './middleware/auth-middleware';
import { applyExternalTrunkFirewall, removeExternalTrunkFirewall } from '../../application/use-cases/pstn/pstn-external-trunk-firewall';
import { createDummyInterface, deleteDummyInterface } from '../../infrastructure/network/dummy-interface';
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

// A real external SIP trunk to a third-party Asterisk server with real
// PSTN/DID connectivity. Unlike every other peer this module has (all pure
// loopback, 127.0.1.x), this one needs a real, non-loopback, provider-
// reachable bind address — an operator-configurable field, matching this
// project's established convention of an explicit IP input rather than
// auto-detection (there's no reliable way to guess which of a host's real
// interfaces a given provider expects to reach). Plain UDP + an IP
// allowlist (see pstn-external-trunk-firewall.ts), deliberately not SIP-
// TLS/SRTP — no existing precedent for that anywhere in this codebase.
// Same dummy-interface convention as every other outward-facing module
// (SecGW/VoWiFi/etc. via dummy-interface.ts's createDummyInterface()) —
// added 2026-09-19 after the first real deployment needed bindIp created by
// hand (ip link add + a live EIGRP network statement) with no app support
// for either, which a fresh `git pull` + Configure would NOT have
// reproduced. 'dummy' mode now creates and persists the interface itself;
// 'existing' mode (an operator's own real interface) skips that, matching
// SecGW's exact same two-mode split.
const DUMMY_IF_NAME_EXT = 'dummy-pstn-ext';

export interface PstnExternalTrunkConfig {
  enabled: boolean;
  bindIp: string;
  bindPort: number;
  interfaceMode: 'dummy' | 'existing';
  // Only needed if this host sits behind NAT relative to the provider —
  // mirrors transport-trunk's own bind-vs-external_media_address split
  // above. Defaults to bindIp when unset.
  externalMediaAddress?: string;
  providerHost: string;
  providerPort: number;
  // Trust boundary for both the PJSIP type=identify match= AND the
  // nftables allowlist (pstn-external-trunk-firewall.ts) — the SAME value
  // drives both, so they can never drift apart. Defaults to
  // `${providerHost}/32` if left blank; widen to a real CIDR block if the
  // provider sends from a range rather than one fixed IP.
  providerCidr: string;
}

export interface PstnState {
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
  // The real external SIP trunk — see PstnExternalTrunkConfig's own comment.
  // Absent entirely on a deployment that's never configured one (not just
  // `enabled: false`), so `externalTrunk?.enabled` is the correct check
  // everywhere, matching this field's own optionality.
  externalTrunk?: PstnExternalTrunkConfig;
}

export function readPstnState(): PstnState | null {
  if (!fs.existsSync(HOST_PSTN_STATE)) return null;
  try { return JSON.parse(fs.readFileSync(HOST_PSTN_STATE, 'utf-8')); } catch { return null; }
}

// Mirrors isAsterisk2gInstalled()'s own exact shape (asterisk-2g-controller.ts)
// — same one-directional-static / lazy-import-back rule (CLAUDE.md pattern
// #16): asterisk-2g-controller.ts imports this lazily, never statically.
// Real, 2026-09-23 finding: PSTN's own uninstall already correctly checks
// isAsterisk2gInstalled() before deciding whether to purge the shared
// asterisk/asterisk-modules packages — but asterisk-2g's own uninstall never
// had the reverse check at all, it *always* skipped the purge unconditionally
// (a deliberate design at the time, per that handler's own comment) — so
// uninstalling PSTN first correctly deferred to Asterisk-2G still being
// present, and uninstalling Asterisk-2G never purged regardless of order,
// permanently orphaning the shared package if both are removed. This export
// lets asterisk-2g's uninstall become order-independent too.
export function isPstnInstalled(): boolean {
  return fs.existsSync(HOST_PSTN_STATE);
}

export function writePstnState(state: PstnState): void {
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

// A real, external DID (Direct Inward Dialing number) ringing a subscriber
// on any RAN tech (see externalInboundDialplanConf() below for the inbound
// routing side). Inbound-only by design — same shape/validation as
// PstnExtension (reuses EXTENSION_INPUT_RE/normalizeExtension as-is, no new
// regex needed) but a genuinely separate collection and dialplan namespace
// (see externalInboundDialplanConf()'s own comment for why), not a variant
// of PstnExtension. A DID must be unique; a subscriber may have zero, one,
// or several DIDs — there's no "one DID per subscriber" constraint, since a
// subscriber can legitimately be reachable via several different real
// numbers. Briefly (2026-09-19) this collection was ALSO the source for
// outbound caller ID, on the assumption a subscriber only ever needs one
// identity in both directions — reverted the same day once real testing
// showed operators need independent control (e.g. several inbound DIDs
// ringing one subscriber, but a specific different number presented
// outbound) — see OutboundCallerId below for that now-separate concern.
export interface DidMapping {
  did: string;
  subscriberImsi: string;
  label?: string;
  createdAt: string;
}

function getDidMappingsCollection(mongoUri: string): { client: MongoClient; collection: Collection<DidMapping> } {
  const client = new MongoClient(mongoUri);
  return { client, collection: client.db('open5gs').collection<DidMapping>('pstn_did_mappings') };
}

async function withDidMappings<T>(mongoUri: string, fn: (col: Collection<DidMapping>) => Promise<T>): Promise<T> {
  const { client, collection } = getDidMappingsCollection(mongoUri);
  try {
    await client.connect();
    return await fn(collection);
  } finally {
    await client.close();
  }
}

// The caller ID a subscriber presents on OUTBOUND external-trunk calls —
// independent of (and, unlike DidMapping, deliberately 1:1 with) their
// inbound DID(s). Real-world requirement found live (2026-09-19): the
// external provider only routes an outbound call whose caller ID matches a
// DID it recognizes, so this needs to be assignable on its own, not just
// inferred from whichever inbound DID a subscriber happens to have. A
// subscriber with no entry here still dials out fine, presenting their
// real MSISDN instead (see syncOutboundCallerIdLookupTable()'s own
// fallback). Uniqueness is on subscriberImsi (one active outbound identity
// per subscriber), not on callerId — unlike DidMapping, nothing requires
// this value to be unique across subscribers or to match any of their own
// inbound DIDs, since some providers allow presenting any assigned number.
export interface OutboundCallerId {
  subscriberImsi: string;
  callerId: string;
  label?: string;
  createdAt: string;
}

function getOutboundCallerIdsCollection(mongoUri: string): { client: MongoClient; collection: Collection<OutboundCallerId> } {
  const client = new MongoClient(mongoUri);
  return { client, collection: client.db('open5gs').collection<OutboundCallerId>('pstn_outbound_caller_ids') };
}

async function withOutboundCallerIds<T>(mongoUri: string, fn: (col: Collection<OutboundCallerId>) => Promise<T>): Promise<T> {
  const { client, collection } = getOutboundCallerIdsCollection(mongoUri);
  try {
    await client.connect();
    return await fn(collection);
  } finally {
    await client.close();
  }
}

// ── Asterisk config generation ──────────────────────────────────────────────

interface PstnCoreWiring {
  icscfIp: string;
  icscfPort: number;
  scscfIp: string;
  mediaIp: string;
}
interface PstnPeers {
  crossRan: { ip: string; port: number } | null;
  external: PstnExternalTrunkConfig | null;
}

function pjsipPstnConf(asteriskIp: string, core: PstnCoreWiring, peers: PstnPeers): string {
  const { icscfIp, icscfPort, scscfIp, mediaIp } = core;
  const crossRanPeer = peers.crossRan;
  // Cross-RAN Calling: peers with Asterisk-2G's own instance so a call to a
  // 2G short code can be dialed from this side and vice versa. Written/
  // removed only by setCrossRanCalling() below. Reuses transport-trunk (a
  // PJSIP transport is the local UDP socket bound to asteriskIp:ASTERISK_PORT
  // — every endpoint on this instance shares the one transport regardless of
  // how many distinct peers reference it; a second type=transport on the
  // same bind would just fail to load). direct_media=no is a hard functional
  // requirement here, not inherited B2BUA hardening habit: transcoding is
  // only possible while Asterisk itself stays in the RTP path on both legs.
  // See CLAUDE.md's Cross-RAN Calling pattern entry for the full design.
  //
  // Real bug found live 2026-09-26 (real cross-RAN test calls, both
  // directions): allow= originally also listed amrwb/amr after gsm here, on
  // the theory that listing gsm FIRST would bias negotiation toward it while
  // still tolerating AMR, keeping the call to exactly one transcode hop.
  // That bias never actually applied — codec_prefs_outgoing_offer below uses
  // prefer:pending,operation:intersect, which narrows this leg's offer to
  // whatever's ALREADY pending on the OTHER leg (e.g. AMR from scscf_trunk)
  // before this endpoint's own allow= order ever gets a say. Since amrwb/amr
  // were in this endpoint's allow= list too, the intersect kept AMR and
  // dropped gsm entirely, regardless of gsm being listed first — confirmed
  // live via packet capture as a real cause of one-way audio (raw AMR
  // reaching Asterisk-2G's GSM-only sipconn leg undecoded). Fixed by hard-
  // restricting allow= to gsm only: a codec absent from allow= can never
  // appear in an offer or answer for this endpoint no matter what
  // codec_prefs_outgoing_offer says, so the AMR<->GSM transcode is now
  // always forced onto THIS endpoint's own bridge with scscf_trunk (the only
  // place it can actually happen), never left ambiguous. See
  // asterisk-2g-controller.ts's pjsip2gConf() for the matching fix on
  // pstn_trunk, the other end of this same physical trunk.
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
  // The real external trunk — a genuinely new bind (transport-external),
  // not shared with transport-trunk above, since every other peer here is
  // loopback-only and this one has to be reachable off-host. codecs are
  // deliberately ulaw/alaw ONLY, not amrwb/amr: this leg's job is speaking
  // to a real PSTN-style provider that will never negotiate AMR anyway —
  // transcoding already happens because the call's OTHER leg (scscf_trunk
  // or asterisk2g_trunk) is what offers AMR. Same B2BUA hardening
  // (direct_media=no/rtp_symmetric=yes/rtp_keepalive=5) as every other
  // trunk here — see CLAUDE.md pattern #14 on budgeting for this on any
  // new B2BUA-style peer. Network-layer trust (nftables allowlist on
  // providerCidr, see pstn-external-trunk-firewall.ts) is the PRIMARY
  // defense for this peer, since — unlike scscf_trunk/asterisk2g_trunk —
  // its match= boundary is reachable from off-host at all.
  const external = peers.external;
  const externalBlock = external?.enabled ? `
[transport-external]
type=transport
protocol=udp
bind=${external.bindIp}:${external.bindPort}
external_media_address=${external.externalMediaAddress || external.bindIp}

[external_trunk]
type=identify
endpoint=external_trunk
match=${external.providerCidr}

[external_trunk]
type=aor
contact=sip:${external.providerHost}:${external.providerPort}

[external_trunk]
type=endpoint
context=pstn-external-inbound
disallow=all
allow=ulaw
allow=alaw
aors=external_trunk
transport=transport-external
direct_media=no
trust_id_inbound=yes
asymmetric_rtp_codec=yes
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
${crossRanBlock}${externalBlock}`;
}

// One literal extension per mapping — matches this project's usual "regenerate
// the whole config on change" convention (see IMS/SMS). A future refinement
// could move this to Asterisk Realtime (ODBC-backed dialplan lookup) to avoid
// a reload on every single mapping change — noted in the PSTN plan, not done
// here since a reload is cheap and this list is expected to stay small.
// A subscriber's own real MSISDN, auto-dialable internally alongside
// (never instead of) any PstnExtension short code they may also have.
// `extension` is the digit string a caller actually dials -- for a
// non-gsm subscriber this is informational only (the real Dial() target is
// subscriberImsi via scscf_trunk); for a gsm subscriber `extension` IS the
// dial target itself (their own msisdn[0] via asterisk2g_trunk).
interface AutoDialEntry {
  extension: string;
  subscriberImsi: string;
  gsm: boolean;
}

// A real inbound DID, resolved against its target subscriber's gsmEnabled
// flag at dialplan-generation time -- same auto-derived-path reasoning as
// AutoDialEntry above, just keyed by the DID instead of the subscriber's
// own MSISDN. subscriberMsisdn is only populated (and only needed) when
// gsm is true.
interface DidDialEntry {
  did: string;
  subscriberImsi: string;
  gsm: boolean;
  subscriberMsisdn?: string;
}

function extensionsPstnConf(imsDomain: string, extensions: PstnExtension[], autoDialEntries: AutoDialEntry[], echoTestNumber: string, crossRanPeerCodes: { extension: string; label?: string }[], externalTrunkEnabled: boolean, didEntries: DidDialEntry[]): string {
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

  // Every subscriber's own real MSISDN, auto-dialable internally -- this is
  // what lets "dial a known subscriber's real number" count as internal
  // (not sent out the external trunk) without an operator having to
  // manually create a PstnExtension for every subscriber. gsm=true routes
  // via asterisk2g_trunk using the subscriber's own MSISDN as both the
  // dialed digits AND the Dial() target (Asterisk-2G's own existing _X.
  // catch-all completes it from there, unchanged); gsm=false reuses the
  // exact same scscf_trunk/IMSI mechanism PstnExtension entries already use.
  const autoDialBlocks = autoDialEntries.map(e => {
    const target = e.gsm ? `${e.extension}@asterisk2g_trunk` : `${e.subscriberImsi}@scscf_trunk`;
    // Early Ringing() for GSM-routed targets only -- same real-radio-paging-
    // takes-a-few-seconds reasoning as the DID block above, and the same
    // asterisk2g_trunk hop, so this is exposed to the identical premature-
    // CANCEL risk from an impatient external caller. See didBlocks' own
    // comment above for the full packet-level story.
    const ringing = e.gsm ? ' same => n,Ringing()\n' : '';
    const body = `1,NoOp(PSTN Gateway: auto-dial subscriber ${e.subscriberImsi} by their own MSISDN${e.gsm ? ' via 2G' : ''})
${ringing} same => n,Dial(PJSIP/${target},60)
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
    // Real bug, confirmed live 2026-10-03: this used to call Ringing()
    // immediately before Dial(), copied defensively from didBlocks' real
    // external-PBX-timeout fix (see that block's own comment) without that
    // justification actually applying here -- the caller for this block is
    // always an internal IMS/Kamailio subscriber via scscf_trunk, never an
    // external PSTN trunk with its own premature-CANCEL timer. Confirmed
    // via packet-level SIP trace: Ringing()+Dial() made Asterisk's own
    // B2BUA answer back to scscf_trunk come out `a=inactive` instead of
    // `sendrecv`, which made chan_pjsip substitute local MusicOnHold onto
    // the bridged 2G-facing leg -- the real 2G phone heard hold music
    // instead of the real caller's voice. Removed; matches the
    // already-clean plain NoOp->Dial() shape the reverse (2G->4G/5G)
    // direction already uses.
    const body = `1,NoOp(Cross-RAN -> 2G short code ${e.extension}${e.label ? ' (' + e.label + ')' : ''})
 same => n,Dial(PJSIP/${e.extension}@asterisk2g_trunk,60)
 same => n,Hangup()
`;
    return `exten => ${e.extension},${body}`;
  }).join('\n');

  // Outbound: "if it's not (1) an existing internal exact-match above or
  // (2) the echo test, it's external" -- falls out structurally from
  // Asterisk always preferring an exact literal over a _-pattern in the
  // same context regardless of declaration order (already relied on
  // elsewhere in this codebase, e.g. Asterisk-2G's own _X. catch-all vs its
  // exact-match short codes), so this catch-all can never steal an
  // already-working internal route. Caller ID is looked up by whatever
  // identity scscf_trunk's trust_id_inbound=yes actually puts in
  // ${CALLERID(num)} for a real subscriber-originated call -- confirmed
  // live via real CDR data to be the subscriber's MSISDN, not their IMSI as
  // this module originally assumed (see syncOutboundCallerIdLookupTable()'s
  // and syncSubscriberMsisdnLookupTable()'s own comments for the full
  // story); both AstDB tables are now keyed under both identities so the
  // lookup works regardless. Real-world requirement found live (2026-09-19):
  // the external provider only routes a call whose caller ID matches a DID
  // it recognizes, so a subscriber's own assigned outbound caller ID (when
  // they have one, via the independent OutboundCallerId collection --
  // deliberately NOT their inbound DidMapping, since operators need to set
  // these independently) takes priority over their raw MSISDN
  // (syncSubscriberMsisdnLookupTable()). A subscriber with nothing assigned
  // here still falls back to their MSISDN unchanged, so this is additive,
  // not a behavior change for anyone without an outbound caller ID set.
  // Only emitted when the external trunk is actually enabled -- with no
  // external_trunk PJSIP peer to Dial() toward, an unmatched number instead
  // falls through to Asterisk's own default "no matching extension"
  // behavior, same as every deployment before this phase existed.
  const outboundCatchAll = externalTrunkEnabled ? `
exten => _X.,1,NoOp(PSTN Gateway: unmatched digits \${EXTEN} - checking external routing)
 same => n,Set(CALLER_IMSI=\${CALLERID(num)})
 same => n,Set(OUT_CALLERID=\${DB(pstn_subscriber_outbound_callerid/\${CALLER_IMSI})})
 same => n,GotoIf($["\${OUT_CALLERID}" != ""]?dial)
 same => n,Set(OUT_CALLERID=\${DB(pstn_subscriber_msisdn/\${CALLER_IMSI})})
 same => n,GotoIf($["\${OUT_CALLERID}" = ""]?no_caller_id)
 same => n(dial),Set(CALLERID(num)=\${OUT_CALLERID})
 same => n,Set(CDR(accountcode)=external-did)
 same => n,Dial(PJSIP/\${EXTEN}@external_trunk,60)
 same => n,Hangup()
 same => n(no_caller_id),NoOp(Caller \${CALLER_IMSI} has no outbound caller ID or MSISDN on file - rejecting outbound external call)
 same => n,Busy()
 same => n,Hangup()
` : '';

  // Real inbound DIDs get their OWN context, not [pstn-internal] -- a
  // deliberate namespace split, not just tidiness: it structurally
  // eliminates any DID-vs-short-code collision question (Asterisk never
  // cross-matches between two different contexts), rather than needing a
  // new collision guard the way Cross-RAN Calling needed one for sharing a
  // single namespace across two instances. external_trunk's own AOR
  // (pjsipPstnConf()) points context= at this exact name. Asterisk allows
  // multiple [context] sections in one file, so this stays in
  // extensions_pstn.conf rather than needing a second generated file/
  // manifest entry. Bare + "+"-prefixed variants, same defensive shape as
  // every other digit-string entry above -- the real provider's exact
  // format isn't known until Phase 5's live test.
  const didHeader = `
[pstn-external-inbound]
`;
  const didBlocks = didEntries.map(e => {
    const target = e.gsm ? `${e.subscriberMsisdn}@asterisk2g_trunk` : `${e.subscriberImsi}@scscf_trunk`;
    // GSM-routed DIDs only: real-radio paging (PSTN -> asterisk2g_trunk ->
    // sipconn -> MNCC -> osmo-msc -> actual over-the-air paging) genuinely
    // takes a few real seconds -- confirmed live 2026-09-20 via packet
    // capture that with nothing sent back in that window, a real external
    // caller's own PBX (IncrediblePBX, in this case) hits its own
    // no-provisional-response timeout (~3s) and CANCELs before the phone
    // ever gets a chance to ring; every hop in this NMS's own chain was
    // just faithfully relaying that upstream cancel, not causing it.
    // Ringing() sends a real SIP 180 immediately, before Dial() even starts,
    // which resets that timer on the caller's end. Not applied to the
    // scscf_trunk (4G/IMS) branch -- that path calls Dial() fast enough on
    // its own and has shown no sign of this problem.
    const ringing = e.gsm ? ' same => n,Ringing()\n' : '';
    const body = `1,NoOp(Inbound DID -> subscriber ${e.subscriberImsi}${e.gsm ? ' via 2G' : ''})
${ringing} same => n,Dial(PJSIP/${target},60)
 same => n,Hangup()
`;
    return `exten => ${e.did},${body}\nexten => +${e.did},${body}`;
  }).join('\n');

  return header + entries + '\n' + autoDialBlocks + '\n' + crossRanEntries + '\n' + outboundCatchAll + didHeader + didBlocks;
}

// Bulk-fetch + filter/map, matching asterisk-2g-controller.ts's own
// resolveGsm2gShortCodes() shape exactly. usedDigits carries every digit
// string already spoken for (PstnExtension entries, the echo-test number,
// cross-RAN peer codes) so a real subscriber MSISDN that happens to
// collide with one of those never gets a duplicate/conflicting exten =>
// line -- the existing, explicitly-assigned mapping always wins.
async function resolveAutoDialEntries(
  subscriberRepo: ISubscriberRepository,
  usedDigits: Set<string>,
  crossRanEnabled: boolean,
): Promise<AutoDialEntry[]> {
  const subs = await subscriberRepo.findAllFull();
  return subs
    .filter(s => s.msisdn?.[0] && !usedDigits.has(s.msisdn[0]))
    // A gsmEnabled subscriber is only reachable via asterisk2g_trunk, which
    // only exists as a PJSIP peer at all when Cross-RAN Calling is on (see
    // pjsipPstnConf()'s crossRanBlock) -- skip rather than emit a Dial()
    // toward a peer that doesn't exist, which would just fail every call.
    .filter(s => !s.gsmEnabled || crossRanEnabled)
    .map(s => ({ extension: s.msisdn![0], subscriberImsi: s.imsi, gsm: !!s.gsmEnabled }));
}

// Same bulk-fetch shape as resolveAutoDialEntries() above, for DidMapping
// instead of a subscriber's own MSISDN. A gsm-routed mapping is skipped
// (not emitted with a broken Dial() target) if the target subscriber has
// no MSISDN on file, or if Cross-RAN Calling is off (same asterisk2g_trunk-
// doesn't-exist-yet reasoning as resolveAutoDialEntries()).
async function resolveDidMappingEntries(
  mongoUri: string,
  subscriberRepo: ISubscriberRepository,
  crossRanEnabled: boolean,
): Promise<DidDialEntry[]> {
  const mappings = await withDidMappings(mongoUri, col => col.find({}).toArray());
  if (mappings.length === 0) return [];
  const subsByImsi = new Map((await subscriberRepo.findAllFull()).map(s => [s.imsi, s]));
  const entries: DidDialEntry[] = [];
  for (const m of mappings) {
    const sub = subsByImsi.get(m.subscriberImsi);
    const gsm = !!sub?.gsmEnabled;
    if (gsm && (!crossRanEnabled || !sub?.msisdn?.[0])) continue;
    entries.push({ did: m.did, subscriberImsi: m.subscriberImsi, gsm, subscriberMsisdn: sub?.msisdn?.[0] });
  }
  return entries;
}

// AstDB (Asterisk's own bundled SQLite key/value store, `database put/get`)
// -- the caller-ID lookup the outbound catch-all's ${DB(...)} reads from.
// Kept in sync with the FULL subscriber list (every subscriber with an
// MSISDN, not just ones with an inbound DID mapped -- outbound eligibility
// is "has an MSISDN on file", period). Real bug found live (2026-09-19):
// this was keyed by IMSI only, on the assumption that scscf_trunk's
// trust_id_inbound=yes puts the subscriber's IMSI in ${CALLERID(num)} --
// real CDR data (Master.csv "src" field) proves it's actually their
// MSISDN. That made this lookup a silent no-op for every subscriber (their
// own MSISDN was never found under an IMSI key, so ${CALLERID(num)} just
// passed through unchanged -- which happened to look identical to success
// since it was already their real MSISDN, until the DID table's own
// version of this exact bug made the failure visible as a real Busy()).
// Now keyed under both identities so the lookup succeeds regardless of
// which one ${CALLERID(num)} turns out to be. Idempotent, cheap, matches
// this file's own "reload is cheap, this list stays small" reasoning
// elsewhere -- runs on every regenerateDialplan() call, not just when a
// subscriber's MSISDN actually changes.
async function syncSubscriberMsisdnLookupTable(subscriberRepo: ISubscriberRepository): Promise<void> {
  const subs = await subscriberRepo.findAllFull();
  const desired = new Map<string, string>();
  for (const s of subs) {
    const msisdn = s.msisdn?.[0];
    if (!msisdn) continue;
    desired.set(s.imsi, msisdn);
    desired.set(msisdn, msisdn);
  }

  const existingKeys = new Set<string>();
  try {
    const { stdout } = await nsenter('asterisk', ['-rx', 'database show pstn_subscriber_msisdn']);
    // Real "database show <family>" output format: "/pstn_subscriber_msisdn/<imsi>  : <msisdn>"
    for (const line of stdout.split('\n')) {
      const m = /^\/pstn_subscriber_msisdn\/(\S+)\s*:/.exec(line.trim());
      if (m) existingKeys.add(m[1]);
    }
  } catch { /* family doesn't exist yet on a fresh install -- nothing to read */ }

  for (const [imsi, msisdn] of desired) {
    await nsenter('asterisk', ['-rx', `database put pstn_subscriber_msisdn ${imsi} ${msisdn}`]).catch(() => {});
  }
  for (const key of existingKeys) {
    if (!desired.has(key)) await nsenter('asterisk', ['-rx', `database del pstn_subscriber_msisdn ${key}`]).catch(() => {});
  }
}

// Real-world requirement found live (2026-09-19): the external provider
// only routes an outbound call if the caller ID it sees matches a DID it
// already knows about — presenting the subscriber's raw MSISDN (never
// registered with the provider at all) gets the call rejected/misrouted on
// their end even though it looks perfectly normal on ours. Sourced from the
// dedicated OutboundCallerId collection (NOT did_mappings — the two started
// out sharing one table on the assumption a subscriber only needs one
// identity in both directions, reverted the same day once real operator
// need showed otherwise; see OutboundCallerId's own comment). Same AstDB
// idempotent put/del shape as syncSubscriberMsisdnLookupTable() above,
// separate family (pstn_subscriber_outbound_callerid) so a subscriber with
// no entry here simply has no key and the dialplan's own fallback to
// pstn_subscriber_msisdn still applies unchanged. Real bug found live
// (2026-09-19) building the original version of this table: real CDR data
// (Master.csv "src" field) proves scscf_trunk's trust_id_inbound=yes
// actually puts the calling subscriber's MSISDN into ${CALLERID(num)}, not
// their IMSI as this module originally assumed everywhere (including the
// pre-existing pstn_subscriber_msisdn table, which happened to never matter
// in practice since a subscriber's own MSISDN is already correct as-is —
// the DB substitution was a silent no-op for them, not a real failure, so
// this went unnoticed until this table's own wrong substitution made it
// visible as an actual Busy()). Fixed by keying every entry under both
// identities (IMSI and, when the subscriber has one, MSISDN too) so the
// lookup succeeds regardless of which one ${CALLERID(num)} actually turns
// out to be for a given call, rather than re-guessing a single "correct" key.
async function syncOutboundCallerIdLookupTable(mongoUri: string, subscriberRepo: ISubscriberRepository): Promise<void> {
  const entries = await withOutboundCallerIds(mongoUri, col => col.find({}).toArray());
  const subsByImsi = new Map((await subscriberRepo.findAllFull()).map(s => [s.imsi, s]));
  const desired = new Map<string, string>();
  for (const e of entries) {
    desired.set(e.subscriberImsi, e.callerId);
    const msisdn = subsByImsi.get(e.subscriberImsi)?.msisdn?.[0];
    if (msisdn) desired.set(msisdn, e.callerId);
  }

  const existingKeys = new Set<string>();
  try {
    const { stdout } = await nsenter('asterisk', ['-rx', 'database show pstn_subscriber_outbound_callerid']);
    for (const line of stdout.split('\n')) {
      const m = /^\/pstn_subscriber_outbound_callerid\/(\S+)\s*:/.exec(line.trim());
      if (m) existingKeys.add(m[1]);
    }
  } catch { /* family doesn't exist yet on a fresh install -- nothing to read */ }

  for (const [imsi, callerId] of desired) {
    await nsenter('asterisk', ['-rx', `database put pstn_subscriber_outbound_callerid ${imsi} ${callerId}`]).catch(() => {});
  }
  for (const key of existingKeys) {
    if (!desired.has(key)) await nsenter('asterisk', ['-rx', `database del pstn_subscriber_outbound_callerid ${key}`]).catch(() => {});
  }
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

// Exported so ims-controller.ts's configureIms() can preserve PSTN's own
// dispatcher.list entry across a plain IMS Configure re-run instead of
// blindly overwriting it back to the shared static template's placeholder
// content — dispatcher.list is a file BOTH modules write to (this one owns
// the real entry once PSTN is configured; ims-controller.ts owns deploying
// the placeholder on a fresh install where PSTN was never set up). Mirrors
// writeDispatcherEntry()'s own exact format — kept as a single source of
// truth so the two writers can never silently drift apart on syntax.
export function formatPstnDispatcherEntry(): string | null {
  const bind = getPstnBindAddress();
  return bind ? `1 sip:${bind.ip}:${bind.port}\n` : null;
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

async function regenerateDialplan(mongoUri: string, subscriberRepo: ISubscriberRepository, echoTestNumber?: string): Promise<void> {
  const imsState = readImsState();
  if (!imsState) throw new Error('IMS is not configured yet — configure IMS before assigning PSTN extensions.');
  const extensions = await withExtensions(mongoUri, col => col.find({}).toArray());
  const resolvedEchoTestNumber = echoTestNumber || readPstnState()?.echoTestNumber || DEFAULT_ECHO_TEST_NUMBER;
  const crossRanPeerCodes = await getCrossRanPeerCodes(mongoUri);
  const crossRanEnabled = !!readPstnState()?.crossRanEnabled;
  const usedDigits = new Set<string>([resolvedEchoTestNumber, ...extensions.map(e => e.extension), ...crossRanPeerCodes.map(c => c.extension)]);
  const autoDialEntries = await resolveAutoDialEntries(subscriberRepo, usedDigits, crossRanEnabled);
  const externalTrunkEnabled = !!readPstnState()?.externalTrunk?.enabled;
  const didEntries = await resolveDidMappingEntries(mongoUri, subscriberRepo, crossRanEnabled);
  fs.mkdirSync(HOST_ASTERISK_DIR, { recursive: true });
  fs.writeFileSync(HOST_EXTENSIONS_INC, extensionsPstnConf(imsState.imsDomain, extensions, autoDialEntries, resolvedEchoTestNumber, crossRanPeerCodes, externalTrunkEnabled, didEntries), 'utf-8');
  if (externalTrunkEnabled) {
    await syncSubscriberMsisdnLookupTable(subscriberRepo);
    await syncOutboundCallerIdLookupTable(mongoUri, subscriberRepo);
  }
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
  subscriberRepo: ISubscriberRepository,
  hostExecutor: IHostExecutor,
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
      // Real, 2026-09-24 finding: disableChanSip() used to run only from
      // installPstn(), never from here — modules.conf's `noload =>
      // chan_sip.so` line never self-healed on a plain Configure re-run
      // (unlike Asterisk-2G's own ensureChanSipDisabled2g(), already called
      // on every Configure). Safe/idempotent to call unconditionally —
      // matches the parity Asterisk-2G already has.
      disableChanSip();
      // Preserve the existing Cross-RAN Calling wiring across a routine
      // Configure call — this rewrites pjsip_pstn.conf wholesale, so without
      // re-deriving this, an unrelated re-Configure would silently drop the
      // asterisk2g_trunk peer even though crossRanEnabled itself is
      // untouched by this function. See CLAUDE.md's Cross-RAN Calling entry.
      const crossRanPeer = existing?.crossRanEnabled ? getAsterisk2gBindAddress() : null;
      // Same reasoning as crossRanPeer above, for the external trunk —
      // preserve it across a routine re-Configure rather than silently
      // dropping it (this write is wholesale, not a merge).
      const externalTrunk = existing?.externalTrunk ?? null;
      fs.writeFileSync(HOST_PJSIP_INC, pjsipPstnConf(asteriskIp, {
        icscfIp: imsState.config.icscfIp, icscfPort: imsState.config.icscfPort,
        scscfIp: imsState.config.scscfIp, mediaIp: imsState.config.pcscfIp,
      }, { crossRan: crossRanPeer, external: externalTrunk }), 'utf-8');
      if (externalTrunk?.enabled) await applyExternalTrunkFirewall(hostExecutor, { bindIp: externalTrunk.bindIp, bindPort: externalTrunk.bindPort, providerCidr: externalTrunk.providerCidr });
      await ensureStrictRtpDisabled();
      await regenerateDialplan(mongoUri, subscriberRepo, echoTestNumber);

      await nsenter('systemctl', ['enable', '--now', 'asterisk']);
      await nsenter('asterisk', ['-rx', 'module reload res_pjsip.so']).catch(() => {});
      await nsenter('asterisk', ['-rx', 'module reload res_rtp_asterisk.so']).catch(() => {});
      await ensureNativeRtpBridgeSuspended();
      await writeDispatcherEntry(asteriskIp);

      // Real, confirmed-live bug (2026-09-24): this used to build a brand-new
      // object literal here instead of spreading `existing` first (every
      // OTHER writePstnState() call site in this file does) — silently
      // dropping externalTrunk from disk on every single Configure run,
      // even though the local `externalTrunk` var two lines above already
      // has the correct value. Confirmed this had already fired on
      // production: the live trunk was still up (pjsip_pstn.conf + the
      // nftables allowlist both intact) while .pstn-config.json had already
      // lost the field, one "Configure" click away from tearing the real
      // trunk down. `existing ?? {}` guards the legitimate first-ever-
      // Configure case where existing is null.
      writePstnState({ ...(existing ?? {}), asteriskIp, echoTestNumber, crossRanEnabled: existing?.crossRanEnabled, configuredWithVersion: getAppVersion() });

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

    fs.writeFileSync(HOST_PJSIP_INC, pjsipPstnConf(existing.asteriskIp, {
      icscfIp: imsState.config.icscfIp, icscfPort: imsState.config.icscfPort,
      scscfIp: imsState.config.scscfIp, mediaIp: imsState.config.pcscfIp,
    }, { crossRan: asterisk2gPeer, external: existing.externalTrunk ?? null }), 'utf-8');
    await regenerateDialplan(mongoUri, subscriberRepo, existing.echoTestNumber);
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

// ── External SIP trunk (real DID connectivity) ──────────────────────────────
//
// Shared apply step for /external-trunk/enable and /external-trunk/disable —
// regenerates pjsip_pstn.conf from CURRENT saved state (so it always reflects
// whatever crossRanEnabled/externalTrunk.enabled already are, same "preserve
// the other peer's wiring on a wholesale rewrite" reasoning as configurePstn()
// and setCrossRanCalling() above), reloads res_pjsip live (never a full
// restart — matches every other PSTN toggle in this file), applies or
// removes the nftables allowlist to match, AND regenerates the dialplan —
// extensionsPstnConf()'s outbound catch-all and [pstn-external-inbound]
// context both depend on whether external_trunk actually exists as a PJSIP
// peer, so a bare pjsip-config-only reload here would leave the dialplan
// out of sync with reality (e.g. a catch-all still trying to Dial() toward
// a peer that was just disabled). Callers mutate+save PstnState BEFORE
// calling this, so it always regenerates from the already-updated state,
// not a stale in-memory copy.
export async function applyExternalTrunkChange(mongoUri: string, subscriberRepo: ISubscriberRepository, hostExecutor: IHostExecutor): Promise<void> {
  const state = readPstnState();
  if (!state) throw new Error('PSTN Gateway is not configured yet — configure it first.');
  const imsState = readImsState();
  if (!imsState) throw new Error('IMS is not configured — cannot regenerate the dialplan.');
  const crossRanPeer = state.crossRanEnabled ? getAsterisk2gBindAddress() : null;
  fs.writeFileSync(HOST_PJSIP_INC, pjsipPstnConf(state.asteriskIp, {
    icscfIp: imsState.config.icscfIp, icscfPort: imsState.config.icscfPort,
    scscfIp: imsState.config.scscfIp, mediaIp: imsState.config.pcscfIp,
  }, { crossRan: crossRanPeer, external: state.externalTrunk ?? null }), 'utf-8');
  await regenerateDialplan(mongoUri, subscriberRepo, state.echoTestNumber);
  // A plain `module reload res_pjsip.so` does NOT rebind an existing
  // type=transport object's socket to a new bind address — confirmed live
  // 2026-09-19: after changing externalTrunk.bindIp and reloading, `pjsip
  // show transport transport-external` kept reporting the OLD bind address
  // (asterisk had a stale in-memory transport bound to the previous IP)
  // even though the freshly-regenerated pjsip_pstn.conf on disk already had
  // the new one — only a full restart actually recreates the socket. Every
  // call into this function is inherently an external-trunk transport
  // change (enable/disable/reconfigure-while-enabled), so always restart
  // here rather than trying to distinguish "did the bind address actually
  // change" — same native_rtp re-suspend the manual /restart route already
  // needs, since that bridge-technology setting doesn't persist restarts.
  await nsenter('systemctl', ['restart', 'asterisk']);
  await ensureNativeRtpBridgeSuspended();
  // Real bug found live (2026-09-19): restarting Asterisk takes scscf_trunk
  // down for a moment, and if S-CSCF's dispatcher module (which actively
  // pings every PSTN Gateway destination every 15s, ds_probing_mode=1) polls
  // during exactly that window, it marks the destination inactive — and
  // despite probing being enabled, it did NOT auto-recover on its own even
  // several minutes after Asterisk was back up and fully healthy (confirmed
  // live: `dispatcher.list` still showed the destination as down while every
  // other health check — pjsip endpoint state, service status — was green).
  // Every real call through this trunk failed with "No PSTN-Gateways
  // available" until a manual `dispatcher.reload` cleared it. Since this
  // function restarts Asterisk on every external-trunk enable/disable/
  // reconfigure, always force a fresh dispatcher reload right after —
  // reloadDispatcher() re-reads dispatcher.list from disk without touching
  // the rest of the running kamailio-scscf process (see its own comment,
  // above) so this is safe to call unconditionally, not just when something
  // about the dispatcher target itself actually changed.
  await reloadDispatcher();
  if (state.externalTrunk?.enabled) {
    await applyExternalTrunkFirewall(hostExecutor, { bindIp: state.externalTrunk.bindIp, bindPort: state.externalTrunk.bindPort, providerCidr: state.externalTrunk.providerCidr });
  } else {
    await removeExternalTrunkFirewall(hostExecutor);
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
  hostExecutor: IHostExecutor,
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

      // Surfaces why some gsmEnabled subscribers aren't reachable via their
      // own real MSISDN yet (see resolveAutoDialEntries()'s own comment) —
      // cheap, matches extensionCount's own bulk-fetch-and-count shape.
      const gsmEnabledWithoutCrossRanCount = state?.crossRanEnabled
        ? 0
        : (await subscriberRepo.findAllFull().catch(() => [])).filter(s => s.gsmEnabled).length;

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
        externalTrunkEnabled: !!state?.externalTrunk?.enabled,
        imsInstalled: await isImsInstalled(),
        imsConfigured: !!imsState,
        hasSavedConfig: !!state,
        dispatcherWired,
        pstnEnabled: dispatcherWired,
        currentConfig: state
          ? { ...state, echoTestNumber: state.echoTestNumber ?? DEFAULT_ECHO_TEST_NUMBER }
          : { asteriskIp: DEFAULT_ASTERISK_IP, echoTestNumber: DEFAULT_ECHO_TEST_NUMBER },
        extensionCount: extensions.length,
        gsmEnabledWithoutCrossRanCount,
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
    const result = await configurePstn({ asteriskIp, echoTestNumber }, mongoUri, subscriberRepo, hostExecutor);
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
      await regenerateDialplan(mongoUri, subscriberRepo);

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
      await regenerateDialplan(mongoUri, subscriberRepo);
      await auditLogger.log({ action: 'pstn_extension_remove', user, details: extension, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_extension_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/pstn/did-mappings — list, joined with subscriber nickname/MSISDN/
  // gsmEnabled (mirrors GET /extensions exactly). Real DID→subscriber
  // inbound routing — see DidMapping's own comment for why this is a
  // separate collection/dialplan namespace, not a PstnExtension variant.
  router.get('/did-mappings', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const mappings = await withDidMappings(mongoUri, col => col.find({}).sort({ did: 1 }).toArray());
      const nicknames = await subscriberRepo.getNicknamesByImsi(mappings.map(m => m.subscriberImsi));
      const allSubs = await subscriberRepo.findAllFull();
      const msisdnByImsi = new Map(allSubs.map(s => [s.imsi, s.msisdn?.[0]]));
      const gsmEnabledByImsi = new Map(allSubs.map(s => [s.imsi, !!s.gsmEnabled]));
      res.json({
        success: true,
        didMappings: mappings.map(m => ({
          ...m,
          subscriberNickname: nicknames[m.subscriberImsi],
          subscriberMsisdn: msisdnByImsi.get(m.subscriberImsi),
          subscriberGsmEnabled: gsmEnabledByImsi.get(m.subscriberImsi) ?? false,
        })),
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'pstn did-mappings list error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/did-mappings — body: { did, subscriberImsi, label? }
  router.post('/did-mappings', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { subscriberImsi, label } = req.body as { did?: string; subscriberImsi?: string; label?: string };
    const rawDid = req.body.did as string | undefined;
    if (!rawDid || !EXTENSION_INPUT_RE.test(rawDid)) {
      return res.status(400).json({ success: false, error: 'did must be 1-15 digits (a leading "+" is accepted but not required)' });
    }
    const did = normalizeExtension(rawDid);
    if (!subscriberImsi || !/^\d{6,15}$/.test(subscriberImsi)) {
      return res.status(400).json({ success: false, error: 'subscriberImsi is required' });
    }
    try {
      const subscriber = await subscriberRepo.findByImsi(subscriberImsi);
      if (!subscriber) return res.status(404).json({ success: false, error: `No subscriber with IMSI ${subscriberImsi}` });

      await withDidMappings(mongoUri, async col => {
        const existing = await col.findOne({ did });
        if (existing) throw new Error(`DID ${did} is already assigned`);
        await col.insertOne({ did, subscriberImsi, label, createdAt: new Date().toISOString() });
      });
      await regenerateDialplan(mongoUri, subscriberRepo);

      await auditLogger.log({ action: 'pstn_did_mapping_add', user, details: `${did} -> ${subscriberImsi}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_did_mapping_add', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: String((err as Error).message ?? err) });
    }
  });

  // PUT /api/pstn/did-mappings/:did — body: { did?, subscriberImsi, label? }.
  // Edits an existing row in place (:did in the URL identifies the CURRENT
  // row; body.did, if different, becomes its new value) — the UI's inline
  // editor uses this instead of delete+re-add, which would otherwise lose
  // the row's position/history for a simple value change.
  router.put('/did-mappings/:did', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const currentDid = decodeURIComponent(req.params.did);
    const rawDid = (req.body.did as string | undefined) ?? currentDid;
    if (!EXTENSION_INPUT_RE.test(rawDid)) {
      return res.status(400).json({ success: false, error: 'did must be 1-15 digits (a leading "+" is accepted but not required)' });
    }
    const newDid = normalizeExtension(rawDid);
    const { subscriberImsi, label } = req.body as { subscriberImsi?: string; label?: string };
    if (!subscriberImsi || !/^\d{6,15}$/.test(subscriberImsi)) {
      return res.status(400).json({ success: false, error: 'subscriberImsi is required' });
    }
    try {
      const subscriber = await subscriberRepo.findByImsi(subscriberImsi);
      if (!subscriber) return res.status(404).json({ success: false, error: `No subscriber with IMSI ${subscriberImsi}` });

      await withDidMappings(mongoUri, async col => {
        const existingRow = await col.findOne({ did: currentDid });
        if (!existingRow) throw new Error(`No DID mapping found for ${currentDid}`);
        if (newDid !== currentDid) {
          const collision = await col.findOne({ did: newDid });
          if (collision) throw new Error(`DID ${newDid} is already assigned`);
        }
        await col.updateOne({ did: currentDid }, { $set: { did: newDid, subscriberImsi, label } });
      });
      await regenerateDialplan(mongoUri, subscriberRepo);

      await auditLogger.log({ action: 'pstn_did_mapping_edit', user, details: `${currentDid} -> ${newDid} (${subscriberImsi})`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_did_mapping_edit', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: String((err as Error).message ?? err) });
    }
  });

  // DELETE /api/pstn/did-mappings/:did
  router.delete('/did-mappings/:did', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const did = decodeURIComponent(req.params.did);
    try {
      await withDidMappings(mongoUri, col => col.deleteOne({ did }));
      await regenerateDialplan(mongoUri, subscriberRepo);
      await auditLogger.log({ action: 'pstn_did_mapping_remove', user, details: did, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_did_mapping_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/pstn/outbound-caller-ids — list, joined with subscriber
  // nickname/MSISDN (same shape as GET /did-mappings). See OutboundCallerId's
  // own comment for why this is a separate collection from did-mappings.
  router.get('/outbound-caller-ids', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const entries = await withOutboundCallerIds(mongoUri, col => col.find({}).sort({ subscriberImsi: 1 }).toArray());
      const nicknames = await subscriberRepo.getNicknamesByImsi(entries.map(e => e.subscriberImsi));
      const allSubs = await subscriberRepo.findAllFull();
      const msisdnByImsi = new Map(allSubs.map(s => [s.imsi, s.msisdn?.[0]]));
      res.json({
        success: true,
        outboundCallerIds: entries.map(e => ({
          ...e,
          subscriberNickname: nicknames[e.subscriberImsi],
          subscriberMsisdn: msisdnByImsi.get(e.subscriberImsi),
        })),
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'pstn outbound-caller-ids list error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/outbound-caller-ids — body: { subscriberImsi, callerId, label? }.
  // One active entry per subscriber (unlike did-mappings' many-per-subscriber) —
  // re-posting for a subscriber that already has one replaces it, rather than
  // erroring, since "change what this subscriber presents outbound" is the
  // expected edit path (there's no meaningful "second outbound caller ID").
  router.post('/outbound-caller-ids', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { subscriberImsi, label } = req.body as { subscriberImsi?: string; label?: string };
    const rawCallerId = req.body.callerId as string | undefined;
    if (!rawCallerId || !EXTENSION_INPUT_RE.test(rawCallerId)) {
      return res.status(400).json({ success: false, error: 'callerId must be 1-15 digits (a leading "+" is accepted but not required)' });
    }
    const callerId = normalizeExtension(rawCallerId);
    if (!subscriberImsi || !/^\d{6,15}$/.test(subscriberImsi)) {
      return res.status(400).json({ success: false, error: 'subscriberImsi is required' });
    }
    try {
      const subscriber = await subscriberRepo.findByImsi(subscriberImsi);
      if (!subscriber) return res.status(404).json({ success: false, error: `No subscriber with IMSI ${subscriberImsi}` });

      await withOutboundCallerIds(mongoUri, async col => {
        await col.replaceOne(
          { subscriberImsi },
          { subscriberImsi, callerId, label, createdAt: new Date().toISOString() },
          { upsert: true },
        );
      });
      await regenerateDialplan(mongoUri, subscriberRepo);

      await auditLogger.log({ action: 'pstn_outbound_caller_id_set', user, details: `${subscriberImsi} -> ${callerId}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_outbound_caller_id_set', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: String((err as Error).message ?? err) });
    }
  });

  // PUT /api/pstn/outbound-caller-ids/:imsi — body: { subscriberImsi?, callerId,
  // label? }. Edits an existing entry in place (:imsi in the URL identifies
  // the CURRENT row; body.subscriberImsi, if different, moves it to a new
  // subscriber) — same "inline edit, not delete+re-add" rationale as the
  // did-mappings PUT above. Rejects moving onto a subscriber that already
  // has their own entry (1:1 by design — see OutboundCallerId's own
  // comment) rather than silently clobbering it.
  router.put('/outbound-caller-ids/:imsi', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const currentImsi = decodeURIComponent(req.params.imsi);
    const rawCallerId = req.body.callerId as string | undefined;
    if (!rawCallerId || !EXTENSION_INPUT_RE.test(rawCallerId)) {
      return res.status(400).json({ success: false, error: 'callerId must be 1-15 digits (a leading "+" is accepted but not required)' });
    }
    const callerId = normalizeExtension(rawCallerId);
    const { label } = req.body as { label?: string };
    const newImsi = (req.body.subscriberImsi as string | undefined) ?? currentImsi;
    if (!/^\d{6,15}$/.test(newImsi)) {
      return res.status(400).json({ success: false, error: 'subscriberImsi is required' });
    }
    try {
      const subscriber = await subscriberRepo.findByImsi(newImsi);
      if (!subscriber) return res.status(404).json({ success: false, error: `No subscriber with IMSI ${newImsi}` });

      await withOutboundCallerIds(mongoUri, async col => {
        const existingRow = await col.findOne({ subscriberImsi: currentImsi });
        if (!existingRow) throw new Error(`No outbound caller ID found for ${currentImsi}`);
        if (newImsi !== currentImsi) {
          const collision = await col.findOne({ subscriberImsi: newImsi });
          if (collision) throw new Error(`Subscriber ${newImsi} already has an outbound caller ID — remove it first or edit that row instead`);
        }
        await col.updateOne({ subscriberImsi: currentImsi }, { $set: { subscriberImsi: newImsi, callerId, label } });
      });
      await regenerateDialplan(mongoUri, subscriberRepo);

      await auditLogger.log({ action: 'pstn_outbound_caller_id_edit', user, details: `${currentImsi} -> ${newImsi} (${callerId})`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_outbound_caller_id_edit', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: String((err as Error).message ?? err) });
    }
  });

  // DELETE /api/pstn/outbound-caller-ids/:imsi
  router.delete('/outbound-caller-ids/:imsi', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const subscriberImsi = decodeURIComponent(req.params.imsi);
    try {
      await withOutboundCallerIds(mongoUri, col => col.deleteOne({ subscriberImsi }));
      await regenerateDialplan(mongoUri, subscriberRepo);
      await auditLogger.log({ action: 'pstn_outbound_caller_id_remove', user, details: subscriberImsi, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_outbound_caller_id_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/pstn/external-trunk/configure — body: { bindIp, bindPort?,
  // interfaceMode? ('dummy'|'existing', defaults 'dummy'), externalMediaAddress?,
  // providerHost, providerPort?, providerCidr? }. Creates/verifies the bindIp
  // interface as a side effect (see DUMMY_IF_NAME_EXT's comment) before
  // saving. Saves the field values only — does NOT flip `enabled` or touch the live
  // config/firewall (see the separate /enable below). A real network-facing
  // trunk deliberately gets a two-step "save the fields, then explicitly
  // turn it on" flow rather than configurePstn()'s own single-step
  // configure-and-apply, matching the higher blast radius of opening a real
  // port to the outside world.
  router.post('/external-trunk/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = readPstnState();
    if (!state) {
      return res.status(400).json({ success: false, error: 'PSTN Gateway is not configured yet — configure it first.' });
    }
    const { bindIp, providerHost } = req.body as { bindIp?: string; providerHost?: string };
    if (!bindIp) return res.status(400).json({ success: false, error: 'bindIp is required — a real, non-loopback interface IP the provider can reach.' });
    if (!providerHost) return res.status(400).json({ success: false, error: 'providerHost is required.' });
    const bindPort = Number(req.body.bindPort) || ASTERISK_PORT;
    const providerPort = Number(req.body.providerPort) || ASTERISK_PORT;
    const providerCidr = (req.body.providerCidr as string) || `${providerHost}/32`;
    const interfaceMode: 'dummy' | 'existing' = req.body.interfaceMode === 'existing' ? 'existing' : 'dummy';
    try {
      // Same dummy-interface convention as SecGW's own gatewayIp — see
      // DUMMY_IF_NAME_EXT's comment. This bindIp also needs to be reachable
      // from off-host (the real provider), same EIGRP caveat as SecGW's —
      // the frontend Setup tab shows the same manual frr.conf hint before
      // Configure runs (this backend never touches frr.conf itself —
      // CLAUDE.md gotcha #7).
      if (interfaceMode === 'dummy') {
        await createDummyInterface(DUMMY_IF_NAME_EXT, bindIp, 32, true);
      } else {
        const ipPresent = await nsenter('bash', ['-c', `ip -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx '${bindIp}' && echo yes || echo no`])
          .then(r => r.stdout.trim() === 'yes').catch(() => false);
        if (!ipPresent) {
          return res.status(400).json({
            success: false,
            error: `${bindIp} is not currently assigned to any interface on this host (checked with "ip addr show"). ` +
              `In "use existing IP" mode you must bind it yourself first, then retry.`,
          });
        }
      }
      const externalTrunk: PstnExternalTrunkConfig = {
        enabled: state.externalTrunk?.enabled ?? false,
        bindIp, bindPort, interfaceMode,
        externalMediaAddress: (req.body.externalMediaAddress as string) || undefined,
        providerHost, providerPort, providerCidr,
      };
      writePstnState({ ...state, externalTrunk });
      await auditLogger.log({ action: 'pstn_external_trunk_configure', user, details: `bindIp=${bindIp}:${bindPort} provider=${providerHost}:${providerPort} cidr=${providerCidr}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_external_trunk_configure', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/external-trunk/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = readPstnState();
    if (!state?.externalTrunk) {
      return res.status(400).json({ success: false, error: 'Configure the external trunk (bind IP, provider host/CIDR) before enabling it.' });
    }
    try {
      writePstnState({ ...state, externalTrunk: { ...state.externalTrunk, enabled: true } });
      await applyExternalTrunkChange(mongoUri, subscriberRepo, hostExecutor);
      await auditLogger.log({ action: 'pstn_external_trunk_enable', user, details: `bindIp=${state.externalTrunk.bindIp}:${state.externalTrunk.bindPort}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_external_trunk_enable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/external-trunk/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = readPstnState();
    if (!state?.externalTrunk) {
      return res.status(400).json({ success: false, error: 'External trunk is not configured.' });
    }
    try {
      writePstnState({ ...state, externalTrunk: { ...state.externalTrunk, enabled: false } });
      await applyExternalTrunkChange(mongoUri, subscriberRepo, hostExecutor);
      await auditLogger.log({ action: 'pstn_external_trunk_disable', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'pstn_external_trunk_disable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', 'asterisk']);
      await ensureNativeRtpBridgeSuspended();
      // See applyExternalTrunkChange()'s comment on reloadDispatcher() —
      // S-CSCF's dispatcher can catch this destination down mid-restart and
      // not self-recover even with probing enabled; force a reload any time
      // this route brings Asterisk back up. Best-effort: PSTN Gateway may
      // not be configured at all yet (dispatcher.list wouldn't exist), so a
      // failure here shouldn't fail the whole start.
      await reloadDispatcher().catch(() => {});
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
      // See applyExternalTrunkChange()'s comment on reloadDispatcher().
      await reloadDispatcher().catch(() => {});
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

      write('\n=== Removing inbound DID mappings ===');
      const removedDids = await withDidMappings(mongoUri, col => col.deleteMany({})).then(r => r.deletedCount).catch(() => 0);
      write(`Removed ${removedDids} DID mapping(s).`);

      write('\n=== Removing outbound caller ID assignments ===');
      const removedCallerIds = await withOutboundCallerIds(mongoUri, col => col.deleteMany({})).then(r => r.deletedCount).catch(() => 0);
      write(`Removed ${removedCallerIds} outbound caller ID assignment(s).`);

      const externalTrunkAtUninstall = readPstnState()?.externalTrunk;
      if (externalTrunkAtUninstall?.enabled) {
        write('\n=== Removing external SIP trunk firewall allowlist ===');
        await removeExternalTrunkFirewall(hostExecutor).catch(() => {});
        write('Firewall rules removed.');
      }
      if (externalTrunkAtUninstall && externalTrunkAtUninstall.interfaceMode !== 'existing') {
        write('\n=== Removing dummy-pstn-ext interface ===');
        await deleteDummyInterface(DUMMY_IF_NAME_EXT).catch(() => {});
        write('dummy-pstn-ext removed.');
      }

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
