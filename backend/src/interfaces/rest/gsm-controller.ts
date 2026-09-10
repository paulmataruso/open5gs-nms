import { Router, Request, Response } from 'express';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createSocket } from 'dgram';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { setMscMgwPeer, readCurrentSmsConfig, listHlrSubscriberStatus } from './sms-controller';
import { cidrRange, numToIp } from '../../domain/services/ip-utils';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';

const execFileAsync = promisify(execFile);

// Same local pattern as sms-controller.ts/mms-controller.ts/pstn-controller.ts
// (there's no shared nsenter utility in this codebase — see IHostExecutor/
// LocalHostExecutor for the one that exists, unused by this family of
// controllers) — kept consistent with this module's closest sibling rather
// than introducing a third convention.
const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

const HOST_OSMOCOM_DIR = '/proc/1/root/etc/osmocom';
const HOST_MME_YAML    = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_GSM_STATE   = `${HOST_OSMOCOM_DIR}/.nms-gsm-bts-state.json`;

// Per-UE 2G signal stats — osmo-bsc's own `meas-feed` (see osmobscCfg()'s
// network block) pushes one UDP datagram per RSL Measurement Report,
// already resolved to the real IMSI, to whoever's listening on this port.
// osmo-meas-udp2db (from the official osmo-bsc-meas-utils package — same
// apt repo, exact-version-matched to the installed osmo-bsc) is that
// listener; it owns and writes this sqlite file directly, we only ever
// read it. Lives outside the container's own mounted filesystem (same as
// hlr.db) so it's queried the same way — nsenter + the sqlite3 CLI, never
// a direct better-sqlite3 open.
const HOST_MEAS_DB          = '/var/lib/osmocom/meas.db';
const MEAS_UDP2DB_UNIT      = 'osmo-meas-udp2db';
const HOST_MEAS_UNIT_PATH   = '/proc/1/root/etc/systemd/system/osmo-meas-udp2db.service';
const MEAS_UDP2DB_BIN       = '/usr/bin/osmo-meas-udp2db';

// Standard Osmocom VTY telnet port for osmo-bsc — confirmed live against
// this exact installed version (osmo-bsc 1.9.0-3build2), same as how
// sms-controller.ts's MSC_VTY_PORT was confirmed for osmo-msc.
const BSC_VTY_PORT = 4242;

// Same injection-safe pattern as sms-controller.ts's VTY_SEND_SMS_SCRIPT —
// argv-only, never a shell string — generalized to run any single VTY
// command and return the drained response, since this module needs several
// different read-only VTY queries (bts link status today, more as the
// point-code/BSSAP work continues) rather than one fixed command.
const VTY_RUN_COMMAND_SCRIPT = `
import socket, sys, time
host, port, cmd = sys.argv[1], int(sys.argv[2]), sys.argv[3]
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
s.sendall((cmd + '\\r\\n').encode())
time.sleep(0.5)
print(drain().decode(errors='replace'))
s.close()
`;

async function bscVtyCommand(cmd: string): Promise<string> {
  const { stdout } = await nsenter('python3', ['-c', VTY_RUN_COMMAND_SCRIPT, '127.0.0.1', String(BSC_VTY_PORT), cmd], 10000);
  return stdout;
}

interface BtsLinkStatus {
  operState: string; adminState: string; availState: string;
  omlConnected: boolean; rslConnected: boolean;
}

// Parses the exact `show bts N` text format confirmed live against this
// installed osmo-bsc version (both the virtual BTS and a real ip.access
// nanoBTS bring-up were watched through this exact output while building
// this module) — not guessed from documentation.
//
// Real bug caught live (2026-09-09) by re-checking a genuinely-healthy,
// 25-minutes-stable real radio and seeing this report it as *not*
// RSL-connected: the label line is
// "Number of RSL links connected (same as num_trx:rsl_connected):   1" —
// the parenthetical itself contains a colon, so a naive `[^:]*:` stops at
// that inner colon and never reaches the real value. Anchoring on the
// literal `):` right before the number (unique to this line) fixes it —
// verified against the real captured output, not just reasoned about.
function parseBtsLinkStatus(vtyOutput: string): BtsLinkStatus {
  const nmMatch = vtyOutput.match(/NM State: Oper '([^']+)', Admin '([^']+)', Avail '([^']+)'/);
  const rslMatch = vtyOutput.match(/Number of RSL links connected[^\n]*\):\s*(\d+)/);
  return {
    operState: nmMatch?.[1] ?? 'unknown',
    adminState: nmMatch?.[2] ?? 'unknown',
    availState: nmMatch?.[3] ?? 'unknown',
    omlConnected: /OML Link state: connected/.test(vtyOutput),
    rslConnected: (rslMatch ? parseInt(rslMatch[1], 10) : 0) > 0,
  };
}

// Which BTS each currently-active subscriber is on, from `show lchan`
// (full). meas.db itself doesn't persist channel identity — osmo-bsc's
// meas-feed carries it, but osmo-meas-udp2db drops it — so this live VTY
// dump is the only way to answer "which UE is on which radio". Only tells
// us about subscribers with a live lchan RIGHT NOW; a subscriber that's in
// the signal history but idle has no current radio (bts stays null). The
// `BTS N` in osmo-bsc.cfg is the index of the BtsEntry in state.btsEntries
// (btsBlock(e, index)), so the frontend maps this number straight back to
// its own BTS list.
function parseActiveLchans(vtyOutput: string): { imsi: string; bts: number }[] {
  const out: { imsi: string; bts: number }[] = [];
  let currentBts: number | null = null;
  for (const line of vtyOutput.split('\n')) {
    const btsHdr = line.match(/^BTS (\d+), TRX \d+, Timeslot/);
    if (btsHdr) { currentBts = parseInt(btsHdr[1], 10); continue; }
    if (currentBts === null) continue;
    // Subscriber identity line inside a lchan block — populated only when a
    // connection exists ("No Subscriber" / "(no subscriber)" otherwise).
    const imsiM = line.match(/IMSI[:\s-]*(\d{5,15})/);
    if (imsiM) out.push({ imsi: imsiM[1], bts: currentBts });
  }
  return out;
}

export interface DiscoveredRadio {
  macAddress: string; ipAddress: string; unitId: string;
  location1: string; location2: string;
  equipmentVersion: string; softwareVersion: string;
  unitName: string; serialNumber: string;
}

// Real bug found live (2026-09-09): the first version of this used
// abisip-find's own `-b <bindIp>` broadcast mode, which the user correctly
// pointed out only reaches the *local* L2 broadcast domain of whatever
// interface bindIp belongs to — it categorically cannot reach a remote,
// routed subnet, since routers don't forward broadcast traffic. Fixed by
// reimplementing the exact same wire protocol as a *unicast* sweep instead:
// nothing about the actual UDP packet is broadcast-specific, only the
// *destination address* abisip-find happens to choose (255.255.255.255).
// Sending the identical packet to a specific routed unicast address works
// exactly the same way — a real ip.access unit doesn't care how the packet
// reached it. Since this backend container runs `network_mode: host`
// (confirmed in docker-compose.yml), Node's own network stack already has
// the host's full routing table — no nsenter needed for this at all, unlike
// almost everything else in this codebase. Reachability of a remote subnet
// is the operator's own responsibility (routing/firewall), same as the user
// explicitly said — this makes no assumption the target is locally attached.
//
// Every byte below was fetched directly from osmo-bsc's own real source
// (github.com/osmocom/osmo-bsc src/ipaccess/abisip-find.c, read verbatim via
// curl, not paraphrased) with its symbolic IPAC_* constants resolved against
// libosmocore's real protocol header — not guessed. Wire format: 2-byte
// big-endian length, 1-byte proto (0xfe = IPAC_PROTO_IPACCESS), 0x00, 1-byte
// msg type (0x04 = ID_GET for the request, 0x05 = ID_RESP for a reply), then
// repeated [1-byte value-length][1-byte tag] pairs. A GET request's "value"
// is just the tag id being asked about; a RESP's value (at the same
// [len][tag] position) is the actual answer, printed with libc's `%s` in the
// original tool, so it's a plain (likely NUL-terminated) ASCII string, not
// binary — confirmed by the real reply captured live from the radio at
// 172.16.0.83 (e.g. IP_Address='172.16.0.83' arrived as literal text, not
// 4 raw bytes).
const IPA_DISCOVERY_PORT = 3006;
const IPA_DISCOVERY_PROBE = Buffer.from([
  0x00, 0x13, 0xfe, 0x00, 0x04,
  0x01, 0x07, // IPAC_IDTAG_MACADDR
  0x01, 0x06, // IPAC_IDTAG_IPADDR
  0x01, 0x08, // IPAC_IDTAG_UNIT
  0x01, 0x02, // IPAC_IDTAG_LOCATION1
  0x01, 0x03, // IPAC_IDTAG_LOCATION2
  0x01, 0x04, // IPAC_IDTAG_EQUIPVERS
  0x01, 0x05, // IPAC_IDTAG_SWVERSION
  0x01, 0x01, // IPAC_IDTAG_UNITNAME
  0x01, 0x00, // IPAC_IDTAG_SERNR
]);
const IPA_IDTAG_FIELD: Record<number, keyof DiscoveredRadio> = {
  0x00: 'serialNumber', 0x01: 'unitName', 0x02: 'location1', 0x03: 'location2',
  0x04: 'equipmentVersion', 0x05: 'softwareVersion', 0x06: 'ipAddress', 0x07: 'macAddress', 0x08: 'unitId',
};
// A CIDR wide enough to be a real risk (e.g. a /16) would mean tens of
// thousands of individual sendto() calls — capped well below that; a real
// site's radio subnet is never anywhere near this large.
const MAX_DISCOVERY_HOSTS = 4096;

function parseIpaDiscoveryReply(buf: Buffer, fromAddress: string): DiscoveredRadio | null {
  if (buf.length < 6 || buf[2] !== 0xfe || buf[4] !== 0x05) return null;
  const result: Partial<Record<keyof DiscoveredRadio, string>> = {};
  let cur = 6;
  while (cur + 1 < buf.length) {
    const tLen = buf[cur];
    const tTag = buf[cur + 1];
    const valueStart = cur + 2;
    const valueBuf = buf.subarray(valueStart, valueStart + tLen);
    const nul = valueBuf.indexOf(0);
    const value = (nul >= 0 ? valueBuf.subarray(0, nul) : valueBuf).toString('ascii');
    const field = IPA_IDTAG_FIELD[tTag];
    if (field) result[field] = value;
    cur = valueStart + tLen;
  }
  return {
    macAddress: result.macAddress ?? '', ipAddress: result.ipAddress || fromAddress, unitId: result.unitId ?? '',
    location1: result.location1 ?? '', location2: result.location2 ?? '',
    equipmentVersion: result.equipmentVersion ?? '', softwareVersion: result.softwareVersion ?? '',
    unitName: result.unitName ?? '', serialNumber: result.serialNumber ?? '',
  };
}

async function sweepForIpaRadios(cidr: string, timeoutMs: number): Promise<DiscoveredRadio[]> {
  const { first, last } = cidrRange(cidr);
  if (last < first || last - first + 1 > MAX_DISCOVERY_HOSTS) {
    throw new Error(`Subnet too large to scan (max ${MAX_DISCOVERY_HOSTS} hosts) — use a smaller CIDR`);
  }
  const found = new Map<string, DiscoveredRadio>();
  const socket = createSocket('udp4');
  try {
    // Bound to the *same* local port the probe is sent to (3006), matching
    // abisip-find's own socket setup exactly — confirmed live this matters:
    // an ephemeral source port got no replies at all, since the real device
    // answers back to whatever port sent the query, and 3006 is what every
    // real tool (including this one) actually sends from.
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(IPA_DISCOVERY_PORT, () => resolve());
    });
    socket.on('message', (msg: Buffer, rinfo) => {
      const radio = parseIpaDiscoveryReply(msg, rinfo.address);
      if (radio) found.set(radio.macAddress || rinfo.address, radio);
    });
    for (let n = first; n <= last; n++) {
      socket.send(IPA_DISCOVERY_PROBE, IPA_DISCOVERY_PORT, numToIp(n));
    }
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
  } finally {
    socket.close();
  }
  return Array.from(found.values());
}

interface GsmConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
  // true for files this module doesn't own (osmo-stp/osmo-hlr/osmo-msc,
  // owned by sms-controller.ts) but shows here too since they're all part
  // of one interconnected Osmocom stack from an operator's point of view —
  // live 2G bring-up repeatedly needed to cross-reference all of them at
  // once. Editing one here writes the same file the SMS page edits; there's
  // only one copy on disk, no separate ownership to reconcile — just a
  // clear warning so it's not mistaken for GSM-module-private config.
  shared?: boolean;
  sharedWith?: string;
}

// This module's own files, plus the ones SMS over SGs owns — shown here too
// (with `shared`/`sharedWith` flagged) since real 2G bring-up is one
// interconnected system end to end (osmo-bsc's own SIGTRAN link, for
// example, is only reachable *through* osmo-stp.cfg's cs7 config), not
// something you can reason about with only this module's own 3 files
// visible. sms-controller.ts remains the sole *generator* of stp/hlr/msc's
// content (see osmostpCfg()/osmohlrCfg()/osmomscCfg() and the mgw-peer
// marker file) — this is a second *view* onto the same files, not a second
// writer with its own regeneration logic.
const GSM_CONFIG_MANIFEST: Omit<GsmConfigFile, 'exists'>[] = [
  { path: `${HOST_OSMOCOM_DIR}/osmo-bsc.cfg`,          label: 'osmo-bsc.cfg',          group: '2G GSM',  language: 'ini', restartServices: ['osmo-bsc'] },
  { path: `${HOST_OSMOCOM_DIR}/osmo-mgw.cfg`,          label: 'osmo-mgw.cfg',          group: '2G GSM',  language: 'ini', restartServices: ['osmo-mgw'] },
  { path: `${HOST_OSMOCOM_DIR}/osmo-bts-virtual.cfg`,  label: 'osmo-bts-virtual.cfg',  group: '2G GSM',  language: 'ini', restartServices: ['osmo-bts-virtual'] },
  { path: `${HOST_OSMOCOM_DIR}/osmo-pcu.cfg`,           label: 'osmo-pcu.cfg',          group: 'GPRS/EDGE', language: 'ini', restartServices: ['osmo-pcu'] },
  { path: `${HOST_OSMOCOM_DIR}/osmo-sgsn.cfg`,          label: 'osmo-sgsn.cfg',         group: 'GPRS/EDGE', language: 'ini', restartServices: ['osmo-sgsn'] },
  { path: `${HOST_OSMOCOM_DIR}/osmo-ggsn.cfg`,          label: 'osmo-ggsn.cfg',         group: 'GPRS/EDGE', language: 'ini', restartServices: ['osmo-ggsn'] },
  {
    path: `${HOST_OSMOCOM_DIR}/osmo-stp.cfg`, label: 'osmo-stp.cfg', group: 'Shared with SMS over SGs', language: 'ini',
    restartServices: ['osmo-stp'], shared: true,
    sharedWith: 'SMS over SGs — the SS7 transfer point osmo-bsc AND osmo-msc both register with. Editing this can break SMS-over-SGs delivery for every subscriber, not just 2G.',
  },
  {
    path: `${HOST_OSMOCOM_DIR}/osmo-hlr.cfg`, label: 'osmo-hlr.cfg', group: 'Shared with SMS over SGs', language: 'ini',
    restartServices: ['osmo-hlr'], shared: true,
    sharedWith: 'SMS over SGs — the subscriber database (MSISDN↔IMSI) both SGs-SMS and any real 2G attach/auth rely on.',
  },
  {
    path: `${HOST_OSMOCOM_DIR}/osmo-msc.cfg`, label: 'osmo-msc.cfg', group: 'Shared with SMS over SGs', language: 'ini',
    restartServices: ['osmo-msc'], shared: true,
    sharedWith: 'SMS over SGs — also the MME\'s SGs peer for LTE CS-fallback SMS. A bad edit here can break SMS delivery for every LTE subscriber, not just 2G voice/SMS.',
  },
];
const GSM_ALLOWED_PATHS = new Set(GSM_CONFIG_MANIFEST.map(f => f.path));

// ─── BTS entry state ────────────────────────────────────────────────────────
// osmo-bsc.cfg is fully regenerated from this structured list every time it
// changes (same pattern configureSms() already uses for osmo-msc.cfg/
// mme.yaml) rather than doing partial text-surgery on individual `bts N`
// blocks — much safer to get right and to reason about.
//
// 'virtual'/'trx' both mean osmo-bts runs as a local process on this host
// (virtual: no RF at all, GSMTAP/UDP; trx: a real SDR via a local osmo-trx).
// 'remote-abis-ip' means dedicated BTS hardware (its own embedded computer,
// its own radio, its own copy of osmo-bts) — confirmed via osmo-bts-virtual's
// own default config (oml remote-ip / ipa unit-id) that Abis-over-IP BTS
// units always *dial in* to the BSC and identify themselves by unit-id, not
// the other way around — so a remote unit needs NO special IP-allowlist
// entry in osmo-bsc.cfg at all, just the same bts-stanza every other backend
// gets. remoteIp below is stored purely for the operator's own reference
// (which physical unit is this), never written into osmo-bsc.cfg.
export type BtsBackend = 'virtual' | 'trx' | 'remote-abis-ip';

// Verified against libosmocore's own gsm_arfcn2band_rc() range table (not
// guessed) — mirrors frontend/src/api/gsm.ts's BTS_BAND_ARFCN_RANGE.
// DCS1800/PCS1900 even overlap numerically (512-885 vs 512-810),
// disambiguated only by the separate `band` directive — an ARFCN outside
// the selected band's range is a real, easy-to-make mistake (this route's
// own prior unconditional `|| 871` default was itself invalid for
// PCS1900), so it's validated server-side too, not just in the form.
const BTS_BAND_ARFCN_RANGE: Record<string, { min: number; max: number; default: number }> = {
  GSM900:  { min: 1,   max: 124, default: 20 },
  GSM850:  { min: 128, max: 251, default: 190 },
  DCS1800: { min: 512, max: 885, default: 700 },
  PCS1900: { min: 512, max: 810, default: 661 },
};

export interface BtsEntry {
  id: string;
  name: string;
  backend: BtsBackend;
  unitId: number;
  band: string;
  arfcn: number;
  cellIdentity: number;
  locationAreaCode: number;
  baseStationIdCode: number;
  remoteIp?: string;
  // Which IP the local osmo-bts-{virtual,trx} process dials for OML (i.e.
  // osmo-bsc's own OML listen address) — only meaningful for backend
  // 'virtual'/'trx' (a 'remote-abis-ip' unit dials in per its OWN config,
  // this module has no say in that). Defaults to bscMgwBindIp below on
  // creation since in every deployment so far BSC and the local BTS
  // backends run on the same host.
  omlRemoteIp?: string;
  // GPRS/EDGE (Phase D) — 'none' (default) keeps this BTS CS-only, exactly
  // today's behavior. NS/BSSGP addressing (nsvci/nsei/bvci) defaults to the
  // BTS's own unitId when unset (mirrors the reference doc's own example,
  // which reuses its BTS's unit-id 1800 for all three) — only needs
  // overriding if two BTS entries would otherwise collide.
  gprsMode?: 'none' | 'gprs' | 'egprs';
  gprsNsvci?: number;
  gprsNsei?: number;
  gprsBvci?: number;
  // LTE neighbour EARFCNs broadcast in SI2quater — lets a 2G-camped phone
  // reselect back to LTE after a CSFB call (and feeds the "fast return to
  // LTE" cell-selection indicator in the RR Channel Release). One
  // `si2quater neighbor-list add earfcn <n> ...` line per entry. The other
  // SI2quater params (thresh-hi/lo, prio, qrxlv, meas) are fixed at sane
  // LTE-preferred defaults rather than exposed per carrier.
  lteEarfcns?: number[];
}

interface GsmState {
  btsEntries: BtsEntry[];
  bscMgwBindIp: string;
  mscMgwBindIp: string;
  // Separate from bscMgwBindIp's own `bind ip` (MGCP control-plane) — some
  // deployments may want RTP media on a different interface than MGCP
  // signaling. Defaults to the same value as bscMgwBindIp.
  mgwRtpBindIp: string;
  // GPRS/EDGE (Phase D) — module-level SGSN/GGSN state. ggsnPoolCidr is
  // deliberately NOT the same subnet Open5GS's own UPF hands out to 4G/5G
  // (confirmed via reading osmo-ggsn's real source: it can't share a live
  // pool with another allocator, nor give a subscriber a persistent static
  // IP — see the plan's own research note) — a disjoint sub-block of the
  // same /24, EIGRP-summarized alongside it, is the closest real
  // equivalent to "same subnet, routed, no NAT".
  gprsEnabled?: boolean;
  // Data-service type applied to every packet-data BTS on Configure:
  // 'gprs' (GMSK only) or 'egprs' (EDGE — adds 8PSK MCS-5..9 where the
  // radio supports it; an EGPRS cell still serves GPRS-only handsets).
  gprsMode?: 'gprs' | 'egprs';
  sgsnGtpLocalIp?: string;
  // The IP the BTS's own PCU dials for the Gb/NS link to osmo-sgsn. For a
  // local virtual/trx BTS this is 127.0.0.1; for a real remote nanoBTS it
  // MUST be this NMS host's address on the RAN subnet the radio routes to
  // (e.g. 172.16.0.168) — 127.0.0.1 there just makes the radio send NS to
  // itself, so GPRS silently never attaches. Empty = auto-derive from the
  // first remote BTS's own subnet at Configure time.
  sgsnGbRemoteIp?: string;
  ggsnGtpBindIp?: string;
  ggsnApn?: string;
  ggsnTunDevice?: string;
  ggsnPoolCidr?: string;
  ggsnDns1?: string;
  ggsnDns2?: string;
  // NAT mode: MASQUERADE the GGSN pool out instead of routing it (no EIGRP
  // advertisement, no disjoint-sub-block constraint) — the pool then just
  // has to not overlap Open5GS's own UE subnet.
  gprsNat?: boolean;
  // The GGSN pool CIDR we last pushed into FRR's `router eigrp 1` — tracked
  // so a changed/cleared pool removes the stale `network` statement.
  appliedGprsEigrpCidr?: string;
  // Ditto for the MASQUERADE rule when in NAT mode.
  appliedGprsNatCidr?: string;
}

const GSM_STATE_DEFAULTS: GsmState = {
  btsEntries: [], bscMgwBindIp: '127.0.0.1', mscMgwBindIp: '127.0.0.1', mgwRtpBindIp: '127.0.0.1',
  gprsEnabled: false, gprsMode: 'gprs', sgsnGtpLocalIp: '127.0.0.1', sgsnGbRemoteIp: '', ggsnGtpBindIp: '127.0.0.5',
  ggsnApn: 'gprs', ggsnTunDevice: 'apn-gprs', ggsnPoolCidr: '', ggsnDns1: '1.1.1.1', ggsnDns2: '9.9.9.9', gprsNat: false,
};

// GTP-C/GTP-U ports (2123/2152) are fixed by the protocol — the only lever
// against a collision is the bind IP. These loopbacks are already taken:
// .1 = osmo-sgsn (ours), .2 = open5gs-mmed, .3 = open5gs-sgwcd,
// .4 = open5gs-smfd. An older module build defaulted the GGSN bind IP to
// .2, which crash-loops osmo-ggsn ("addr(127.0.0.2:2123) bind failed:
// Address already in use") — force any such value back to the safe .5.
const GGSN_GTP_IP_BLOCKLIST = ['127.0.0.1', '127.0.0.2', '127.0.0.3', '127.0.0.4'];
const GGSN_GTP_IP_SAFE = '127.0.0.5';
function sanitizeGgsnGtpIp(ip: string | undefined): string {
  const v = (ip || '').trim();
  return !v || GGSN_GTP_IP_BLOCKLIST.includes(v) ? GGSN_GTP_IP_SAFE : v;
}

function loadGsmState(): GsmState {
  try {
    if (fs.existsSync(HOST_GSM_STATE)) {
      const parsed = JSON.parse(fs.readFileSync(HOST_GSM_STATE, 'utf-8'));
      const merged = { ...GSM_STATE_DEFAULTS, ...parsed };
      merged.ggsnGtpBindIp = sanitizeGgsnGtpIp(merged.ggsnGtpBindIp);
      return merged;
    }
  } catch { /* fall through to default */ }
  return { ...GSM_STATE_DEFAULTS };
}

function saveGsmState(state: GsmState): void {
  fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
  fs.writeFileSync(HOST_GSM_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

function nextUnitId(existing: BtsEntry[]): number {
  const used = new Set(existing.map(e => e.unitId));
  let id = 6969;
  while (used.has(id)) id++;
  return id;
}

// ─── Config templates ───────────────────────────────────────────────────────
// Bodies below are the *verified default configs these exact package
// versions ship* (osmo-bsc 1.9.0-3build2 / osmo-mgw 1.10.0+dfsg1-3build2 /
// osmo-bts 1.5.0+dfsg1-2ubuntu2, all confirmed via `apt-cache policy` and the
// real /etc/osmocom/*.cfg each package installs on this exact host),
// parameterized only where a value genuinely needs to vary — not
// reconstructed from general Osmocom documentation. That said, unlike
// osmo-stp/osmo-hlr/osmo-msc's templates above (which accumulated several
// live-discovered version-specific fixes over real testing), these have not
// yet been through that same live-iteration cycle — Phase 0/1's own
// verification step (install → configure → check `journalctl -u osmo-bsc`
// for a parse error) is expected to surface at least one syntax quirk here,
// the same way the SMS module's own history did.

function osmomgwCfg(bindIp: string, rtpBindIp: string): string {
  return `mgcp
  bind ip ${bindIp}
  rtp port-range 4002 16000
  rtp bind-ip ${rtpBindIp}
  rtp ip-probing
  rtp ip-dscp 46
  bind port 2427
  sdp audio payload number 98
  sdp audio payload name GSM
  number endpoints 512
  loop 0
  force-realloc 1
  rtcp-omit
  rtp-patch ssrc
  rtp-patch timestamp
`;
}

// osmo-bsc's `type` selector is the one real config difference between a
// locally-run osmo-bts backend and real ip.access hardware — confirmed
// live against this exact osmo-bsc 1.9.0 build's own --vty-ref-xml
// (`type (unknown|bs11|nanobts|rbs2000|nokia_site|osmo-bts)`), everything
// else under `bts N` (band/cell_identity/ipa unit-id/oml ipa stream-id/
// trx/timeslots) uses identical directive names across types in this
// version — the older ip.access-specific `ip.access unit_id`/
// `ip.access stream_id` syntax some docs still show is from a pre-unified
// OpenBSC-era osmo-bsc and is NOT what this installed version expects.
function btsTypeFor(backend: BtsBackend): string {
  return backend === 'remote-abis-ip' ? 'nanobts' : 'osmo-bts';
}

// Accepts a number[], a comma/space/newline-separated string, or undefined.
function parseEarfcns(v: unknown): number[] | undefined {
  if (v == null || v === '') return undefined;
  const raw = Array.isArray(v) ? v : String(v).split(/[\s,]+/);
  const nums = raw.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 65535);
  return nums.length ? [...new Set(nums)] : [];
}

function btsBlock(e: BtsEntry, index: number, sgsnGbRemoteIp = ''): string {
  const gprsMode = e.gprsMode ?? 'none';
  // Gb/NS target for this BTS's PCU. An explicit module-level SGSN Gb IP
  // wins; Configure auto-derives one from a remote radio's own subnet, so
  // by the time we render, 127.0.0.1 only remains for a genuinely local
  // (virtual/trx) BTS.
  const gbIp = sgsnGbRemoteIp || '127.0.0.1';
  // GPRS timeslot layout. Verified against this osmo-bsc 1.9.0's own
  // `--vty-ref-xml`: valid phys_chan_config values are
  // none|ccch|ccch+sdcch4|tch/f|tch/h|sdcch8|pdch|tch/f_pdch|
  // ccch+sdcch4+cbch|sdcch8+cbch|tch/f_tch/h_sdcch8_pdch — there is NO
  // `tch/f_tch/h_pdch` (that's from an older osmo-bts manual). A real
  // ip.access nanoBTS also doesn't do Osmocom-style dynamic timeslots at
  // all — it needs *static* PDCH. So: when GPRS is on, make the last two
  // timeslots (6, 7) dedicated PDCH and leave 1-5 as TCH/F. Timeslots 0/1
  // are never touched (CCCH+SDCCH4 / TCH/F) — the proven CS layout.
  const pdchTs = gprsMode === 'none' ? 'TCH/F' : 'PDCH';
  // Built line-by-line (not a hand-aligned multi-line template literal) so
  // every line gets the exact same 2-space indent as its siblings — a real
  // bug here (the empty-gprsBlock case landing 'trx 0' one space short of
  // its neighbors) broke osmo-bsc's VTY parser outright ("There is no such
  // command" / "Error occurred during reading the below line:  trx 0"),
  // confirmed live 2026-09-10, causing a real BSC outage until the live
  // file was hand-patched and this generator fixed. libvty-style configs
  // use indentation depth to determine nesting, so even a one-space
  // mismatch between sibling directives is a hard parse failure, not
  // cosmetic — never rely on getting continuation-line indentation right
  // by eye in a template literal for this kind of config again.
  // Matches the Osmocom NITB reference's own nanoBTS voice+data example
  // exactly (gprs mode + the nsvc/nsei/bvci block, nothing else) — RAC and
  // network-control-order default fine, adding them just diverges from the
  // one config known to work on this hardware.
  const gprsLines = gprsMode === 'none' ? [] : [
    `  gprs nsvc 0 remote ip ${gbIp}`,
    `  gprs nsvc 0 remote udp port 23000`,
    `  gprs nsvc 0 local udp port 23000`,
    `  gprs nsvc 0 nsvci ${e.gprsNsvci ?? e.unitId}`,
    `  gprs nsei ${e.gprsNsei ?? e.unitId}`,
    // `gprs cell bvci` range is <2-65535> per the real VTY grammar — a
    // unit-id of 1 (the nanoBTS's) would be rejected, so floor at 2.
    `  gprs cell bvci ${e.gprsBvci ?? Math.max(2, e.unitId)}`,
  ];
  const gprsBlock = gprsLines.map(l => `${l}\n`).join('');
  // SI2quater E-UTRAN neighbour list — LTE-preferred defaults: prio 6 (above
  // GSM's usual 0-4 so an idle UE goes back to LTE), thresh-hi/lo 20/10,
  // qrxlv 22, meas 0. Same explicit-per-line indentation discipline as the
  // gprs block above.
  const earfcnBlock = (e.lteEarfcns ?? [])
    .filter(n => Number.isInteger(n) && n >= 0 && n <= 65535)
    .map(n => `  si2quater neighbor-list add earfcn ${n} thresh-hi 20 thresh-lo 10 prio 6 qrxlv 22 meas 0\n`)
    .join('');
  return ` bts ${index}
  type ${btsTypeFor(e.backend)}
  band ${e.band}
  cell_identity ${e.cellIdentity}
  location_area_code ${e.locationAreaCode}
  base_station_id_code ${e.baseStationIdCode}
  ms max power 15
  cell reselection hysteresis 4
  rxlev access min 0
  radio-link-timeout 32
  channel allocator ascending
  rach tx integer 9
  rach max transmission 7
  channel-description attach 1
  channel-description bs-pa-mfrms 5
  channel-description bs-ag-blks-res 1
  early-classmark-sending forbidden
  ipa unit-id ${e.unitId} 0
  oml ipa stream-id 255 line 0
  codec-support fr
  gprs mode ${gprsMode}
${gprsBlock}${earfcnBlock}  trx 0
   rf_locked 0
   arfcn ${e.arfcn}
   nominal power 23
   max_power_red 20
   rsl e1 tei 0
   timeslot 0
    phys_chan_config CCCH+SDCCH4
    hopping enabled 0
   timeslot 1
    phys_chan_config TCH/F
    hopping enabled 0
   timeslot 2
    phys_chan_config TCH/F
    hopping enabled 0
   timeslot 3
    phys_chan_config TCH/F
    hopping enabled 0
   timeslot 4
    phys_chan_config TCH/F
    hopping enabled 0
   timeslot 5
    phys_chan_config TCH/F
    hopping enabled 0
   timeslot 6
    phys_chan_config ${pdchTs}
    hopping enabled 0
   timeslot 7
    phys_chan_config ${pdchTs}
    hopping enabled 0
`;
}

function osmobscCfg(mcc: string, mnc: string, btsEntries: BtsEntry[], mgwBindIp: string, sgsnGbRemoteIp = ''): string {
  // Per-BTS `gprs mode` comes from each BtsEntry.gprsMode (btsBlock()); a
  // BTS left at the default 'none' stays CS-only. sgsnGbRemoteIp is where
  // the PCU dials the Gb link — see btsBlock()/GsmState for how it's
  // resolved.
  //
  // mgw local-port 2728 below is deliberately different from osmo-msc's own
  // 2727 (sms-controller.ts's osmomscCfg) — found live: both processes bind
  // their own local MGCP client socket, and with the same literal port they
  // collide ("Address already in use") whenever both run at once, which is
  // the normal case for this module. osmo-bsc auto-recovers by retrying the
  // next port up, but pinning distinct values avoids relying on that.
  //
  // encryption a5 1 3 below must overlap osmo-msc.cfg's own real
  // `encryption a5 1 3` line (that file is precious/hand-maintained, never
  // regenerated by this module — see configureSms()'s own warning) or
  // every real attach gets rejected before Location Updating even
  // completes: "Reject: no overlapping A5 ciphers between BSC (0x01) and
  // MSC (0x02)" — confirmed live, 2026-09-10, this was the actual reason a
  // real UE could never attach even though OML/RSL/BSSMAP were all
  // healthy. The previous `a5 0` (no encryption only) shared no bit at all
  // with the MSC's requested set.
  const btsBlocks = btsEntries.map((e, i) => btsBlock(e, i, sgsnGbRemoteIp)).join('');
  return `log stderr
 logging filter all 1
 logging print extended-timestamp 1
 logging print category 1
 logging print level 1
e1_input
 e1_line 0 driver ipa
network
 network country code ${mcc}
 mobile network code ${mnc}
 encryption a5 1 3
 neci 1
 paging any use tch 0
 handover 0
 timer net T3212 5
 meas-feed destination 127.0.0.1 8888
 meas-feed scenario nms
${btsBlocks}msc 0
 allow-emergency allow
 amr-config 12_2k forbidden
 amr-config 10_2k forbidden
 amr-config 7_95k forbidden
 amr-config 7_40k forbidden
 amr-config 6_70k forbidden
 amr-config 5_90k allowed
 amr-config 5_15k forbidden
 amr-config 4_75k forbidden
 mgw remote-ip ${mgwBindIp}
 mgw remote-port 2427
 mgw local-port 2728
 mgw endpoint-domain bsc
bsc
 mid-call-timeout 0
`;
}

// Full logging-category enumeration kept verbatim from the package's own
// shipped default (a real `write`-saved config, not hand-written) rather
// than trimmed — every line in it is proven to parse against this exact
// osmo-bts version; guessing which lines are safe to drop isn't worth the
// risk of a startup parse error over a handful of log-verbosity settings.
function osmobtsVirtualCfg(unitId: number, band: string, bscOmlIp: string): string {
  return `log stderr
 logging filter all 1
 logging color 0
 logging print category 1
 logging timestamp 0
 logging level rsl info
 logging level oml info
 logging level rll notice
 logging level rr notice
 logging level meas notice
 logging level pag info
 logging level l1c info
 logging level l1p info
 logging level dsp error
 logging level pcu notice
 logging level ho debug
 logging level trx notice
 logging level loop notice
 logging level abis debug
 logging level rtp notice
 logging level sum error
 logging level lglobal notice
 logging level llapd notice
 logging level linp notice
 logging level lmux notice
 logging level lmi notice
 logging level lmib notice
 logging level lsms notice
 logging level lctrl notice
 logging level lgtp notice
 logging level lstats error
line vty
 no login
e1_input
 e1_line 0 driver ipa
 e1_line 0 port 0
 no e1_line 0 keepalive
phy 0
 instance 0
bts 0
 band ${band}
 ipa unit-id ${unitId} 0
 oml remote-ip ${bscOmlIp}
 rtp jitter-buffer 100
 paging queue-size 200
 paging lifetime 0
 min-qual-rach 50
 min-qual-norm -5
 trx 0
  power-ramp max-initial 23000 mdBm
  power-ramp step-size 2000 mdB
  power-ramp step-interval 1
  ms-power-control osmo
  phy 0 instance 0
`;
}

// GPRS/EDGE (Phase D) — three new daemons, config shape confirmed directly
// against the Osmocom "Network In The Box" reference doc's own working
// example (the user supplied an .mhtml capture of it since the live wiki
// page is behind anti-bot protection this session couldn't get past).

function osmopcuCfg(): string {
  return `log stderr
 logging filter all 1
 logging print category 1
line vty
 no login
pcu
 flow-control-interval 10
 cs 2
 alloc-algorithm dynamic
 alpha 0
 gamma 0
`;
}

// auth-policy remote reuses the *same* OsmoHLR auc_3g rows the CS side
// already populates via sync-subscribers' gsmEnabled checkbox — no new
// subscriber-provisioning path needed for GPRS, confirmed while researching
// this phase (osmo-sgsn only ever asks OsmoHLR for auth data over GSUP, the
// same protocol/rows the CS/voice side already relies on).
// NS config is the libosmocore NS2 grammar (bind + nse), NOT the old
// pre-2021 `encapsulation udp ...` form the "Network In The Box" wiki
// still shows — confirmed against this host's real osmo-sgsn 1.x via
// `osmo-sgsn --vty-ref-xml`. `accept-ipaccess` on the bind is what lets a
// nanoBTS's IPA-multiplexed Gb link attach dynamically (no static nsvc).
function osmosgsnCfg(gtpLocalIp: string, ggsnGtpIp: string, hlrBindIp: string, apn: string): string {
  return `log stderr
 logging filter all 1
 logging print category 1
line vty
 no login
sgsn
 gtp state-dir /tmp
 gtp local-ip ${gtpLocalIp}
 auth-policy remote
 gsup remote-ip ${hlrBindIp}
 ggsn 0 remote-ip ${ggsnGtpIp}
 ggsn 0 gtp-version 1
 apn ${apn} ggsn 0
 ggsn dynamic
ns
 bind udp local
  listen 0.0.0.0 23000
  accept-ipaccess
`;
}

// ip prefix dynamic below is deliberately a disjoint sub-block of the same
// /24 Open5GS's own UPF already hands out to 4G/5G subscribers (e.g. UPF
// keeps .0/25, this gets .128/25), summarized under one EIGRP `network`
// statement so it's routed identically from the outside — NOT the literal
// same live pool. Confirmed at the source level (osmo-ggsn's own ggsn.c)
// that it cannot share a pool with another allocator or give a subscriber
// a persistent static IP the way Open5GS's own Framed Routing already
// does — this is the closest real equivalent, not a limitation of this
// module's own design. See regenerateGsmConfigs()'s own EIGRP-hint comment
// — this project's hard-learned eigrpd crash-guard rule means that network
// statement is never auto-applied, only ever shown as a copy-paste hint.
// `apn NAME` opens a sub-node in osmo-ggsn's real grammar (confirmed via
// `osmo-ggsn --vty-ref-xml`) — tun-device / type-support / ip prefix /
// ip dns / the APN's own `no shutdown` all live one level deeper, under
// it. The wiki's flat example is stale.
function osmoggsnCfg(gtpBindIp: string, apn: string, tunDevice: string, poolCidr: string, dns1: string, dns2: string): string {
  return `log stderr
 logging filter all 1
 logging print category 1
line vty
 no login
ggsn ggsn0
 gtp state-dir /tmp
 gtp bind-ip ${gtpBindIp}
 apn ${apn}
  gtpu-mode tun
  type-support v4
  tun-device ${tunDevice}
  ip prefix dynamic ${poolCidr}
  ip dns 0 ${dns1}
  ip dns 1 ${dns2}
  no shutdown
 default-apn ${apn}
 no shutdown ggsn
`;
}

function readMccMnc(): { mcc: string; mnc: string } {
  let mcc = '001';
  let mnc = '01';
  if (fs.existsSync(HOST_MME_YAML)) {
    const raw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    const mccM = raw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = raw.match(/mnc:\s*['"]?(\d+)['"]?/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
  }
  return { mcc, mnc };
}

// Regenerates every config file this module owns from the current state —
// called after any BTS CRUD mutation or an explicit /configure, so the
// state file and the on-disk configs never drift apart.
// osmo-bsc-meas-utils ships no systemd unit of its own (confirmed via
// `dpkg -L osmo-bsc-meas-utils` — bin + man page only) — this is a small,
// fixed-argument daemon (one positional arg, the db path; UDP port 8888 is
// hardcoded in its own source, not configurable), so a static unit file is
// enough, no templating needed beyond the db path itself.
function measUdp2dbSystemdUnit(): string {
  return `[Unit]
Description=Osmocom 2G measurement-report UDP-to-SQLite bridge (osmo-meas-udp2db)
After=network.target osmo-bsc.service
Wants=osmo-bsc.service

[Service]
Type=simple
ExecStart=${MEAS_UDP2DB_BIN} ${HOST_MEAS_DB}
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
`;
}

// Several Osmocom .deb packages ship /etc/osmocom/<daemon>.cfg as a symlink
// into ../doc/examples/ (a *relative* link that resolves to a
// nonexistent /etc/doc/examples/ path) — confirmed live for osmo-ggsn.cfg,
// 2026-09-10, which made a plain fs.writeFileSync ENOENT because the write
// follows the dangling symlink to a missing target. Unlink first so we
// always land a real regular file.
function writeHostCfg(path: string, content: string): void {
  try { if (fs.lstatSync(path).isSymbolicLink()) fs.unlinkSync(path); } catch { /* not there yet */ }
  fs.writeFileSync(path, content, 'utf-8');
}

// Add or remove one EIGRP `network` statement (plus a passive-interface for
// the GGSN tun so EIGRP never tries to form an adjacency out of it), live
// via vtysh's incremental config path and then `write memory` to persist to
// frr.conf. Deliberately NEVER `systemctl restart frr` — that is the exact
// trigger for this project's confirmed eigrpd crash. Returns a short status
// string for the API response; a vtysh failure is logged but not fatal to
// the surrounding Configure.
async function applyGprsEigrpRoute(addCidr: string | null, delCidr: string | null, tunDevice: string): Promise<string> {
  const cmds: string[] = ['configure terminal', 'router eigrp 1'];
  if (delCidr && /^[\d.]+\/\d+$/.test(delCidr)) cmds.push(`no network ${delCidr}`);
  if (addCidr && /^[\d.]+\/\d+$/.test(addCidr)) {
    cmds.push(`network ${addCidr}`);
    cmds.push(`passive-interface ${tunDevice.replace(/[^\w.-]/g, '')}`);
  }
  cmds.push('end');
  const args = cmds.flatMap(c => ['-c', c]);
  try {
    await nsenter('vtysh', args, 15000);
    await nsenter('vtysh', ['-c', 'write memory'], 15000);
    return addCidr ? `EIGRP: advertising ${addCidr}` : `EIGRP: withdrew ${delCidr}`;
  } catch (e) {
    return `EIGRP change failed (apply manually): ${String(e)}`;
  }
}

// NAT-mode alternative to the EIGRP route: MASQUERADE the GGSN pool out any
// interface that isn't its own tun, so it needs no routing/advertisement —
// mirrors auto-config.ts's own configureNAT rule shape. Idempotent (-C
// before -A / -D), persisted with netfilter-persistent.
async function applyGprsNat(addCidr: string | null, delCidr: string | null, tunDevice: string): Promise<string> {
  const dev = tunDevice.replace(/[^\w.-]/g, '');
  const run = (a: string[]) => nsenter('iptables', a, 15000);
  try {
    if (delCidr && /^[\d.]+\/\d+$/.test(delCidr)) {
      await run(['-t', 'nat', '-D', 'POSTROUTING', '-s', delCidr, '!', '-o', dev, '-j', 'MASQUERADE']).catch(() => {});
    }
    if (addCidr && /^[\d.]+\/\d+$/.test(addCidr)) {
      const has = await run(['-t', 'nat', '-C', 'POSTROUTING', '-s', addCidr, '!', '-o', dev, '-j', 'MASQUERADE']).then(() => true).catch(() => false);
      if (!has) await run(['-t', 'nat', '-A', 'POSTROUTING', '-s', addCidr, '!', '-o', dev, '-j', 'MASQUERADE']);
      const hasIn = await run(['-C', 'INPUT', '-i', dev, '-j', 'ACCEPT']).then(() => true).catch(() => false);
      if (!hasIn) await run(['-I', 'INPUT', '-i', dev, '-j', 'ACCEPT']);
    }
    await nsenter('netfilter-persistent', ['save'], 15000).catch(() => {});
    return addCidr ? `NAT: masquerading ${addCidr}` : `NAT: removed masquerade for ${delCidr}`;
  } catch (e) {
    return `NAT change failed (apply manually): ${String(e)}`;
  }
}

// The host FORWARD chain policy is DROP with explicit per-tun ACCEPT rules
// (ogstun/ogstun2 for the 4G/IMS pools). The GGSN's own tun needs the same
// pair or every forwarded GPRS packet to the internet is silently dropped
// — and because host-local traffic uses the INPUT chain, a local
// speed-test server keeps working, which makes it look like "GPRS is up
// but there's no internet". Needed in BOTH routed and NAT modes.
async function ensureGprsForwardAccept(tunDevice: string, want: boolean): Promise<void> {
  const dev = tunDevice.replace(/[^\w.-]/g, '');
  try {
    for (const io of ['-i', '-o'] as const) {
      const spec = ['FORWARD', io, dev, '-j', 'ACCEPT'];
      const has = await nsenter('iptables', ['-C', ...spec], 10000).then(() => true).catch(() => false);
      if (want && !has) await nsenter('iptables', ['-A', ...spec], 10000);
      if (!want && has) await nsenter('iptables', ['-D', ...spec], 10000);
    }
    await nsenter('netfilter-persistent', ['save'], 15000).catch(() => {});
  } catch { /* best effort */ }
}

// Best-effort: this host's IPv4 on the same /24 as the first remote radio
// — that's the address a real nanoBTS's PCU can actually reach osmo-sgsn
// on for the Gb link. Returns '' if nothing matches (caller then leaves
// the BTS on 127.0.0.1, only valid for a local virtual/trx BTS).
async function deriveSgsnGbIp(btsEntries: BtsEntry[]): Promise<string> {
  const remote = btsEntries.find(e => e.backend === 'remote-abis-ip' && e.remoteIp);
  if (!remote?.remoteIp) return '';
  const prefix = remote.remoteIp.split('.').slice(0, 3).join('.') + '.';
  try {
    const { stdout } = await nsenter('bash', ['-c', `ip -o -4 addr show | awk '{print $4}'`], 8000);
    for (const cidr of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
      const ip = cidr.split('/')[0];
      if (ip.startsWith(prefix) && ip !== remote.remoteIp) return ip;
    }
  } catch { /* fall through */ }
  return '';
}

async function regenerateGsmConfigs(state: GsmState): Promise<void> {
  const { mcc, mnc } = readMccMnc();
  fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
  writeHostCfg(`${HOST_OSMOCOM_DIR}/osmo-bsc.cfg`, osmobscCfg(mcc, mnc, state.btsEntries, state.bscMgwBindIp, state.sgsnGbRemoteIp || ''));
  writeHostCfg(`${HOST_OSMOCOM_DIR}/osmo-mgw.cfg`, osmomgwCfg(state.bscMgwBindIp, state.mgwRtpBindIp));

  const virtualBts = state.btsEntries.find(e => e.backend === 'virtual');
  if (virtualBts) {
    writeHostCfg(
      `${HOST_OSMOCOM_DIR}/osmo-bts-virtual.cfg`,
      osmobtsVirtualCfg(virtualBts.unitId, virtualBts.band, virtualBts.omlRemoteIp || state.bscMgwBindIp),
    );
  }

  if (state.gprsEnabled) {
    writeHostCfg(`${HOST_OSMOCOM_DIR}/osmo-pcu.cfg`, osmopcuCfg());
    const { readCurrentSmsConfig } = await import('./sms-controller');
    const hlrBindIp = readCurrentSmsConfig()?.hlrBindIp || '127.0.0.1';
    writeHostCfg(
      `${HOST_OSMOCOM_DIR}/osmo-sgsn.cfg`,
      osmosgsnCfg(state.sgsnGtpLocalIp || '127.0.0.1', state.ggsnGtpBindIp || '127.0.0.5', hlrBindIp, state.ggsnApn || 'gprs'),
    );
    writeHostCfg(
      `${HOST_OSMOCOM_DIR}/osmo-ggsn.cfg`,
      osmoggsnCfg(
        state.ggsnGtpBindIp || '127.0.0.5', state.ggsnApn || 'gprs', state.ggsnTunDevice || 'apn-gprs',
        state.ggsnPoolCidr || '', state.ggsnDns1 || '1.1.1.1', state.ggsnDns2 || '9.9.9.9',
      ),
    );
  }

  // Deploy the meas-feed listener alongside osmo-bsc.cfg's own meas-feed
  // lines above — skipped gracefully (not an error) on an existing
  // deployment that installed the module before this feature existed and
  // hasn't re-run Install yet to pick up osmo-bsc-meas-utils.
  if (fs.existsSync(`/proc/1/root${MEAS_UDP2DB_BIN}`)) {
    fs.writeFileSync(HOST_MEAS_UNIT_PATH, measUdp2dbSystemdUnit(), 'utf-8');
    await nsenter('systemctl', ['daemon-reload']);
    const wasActive = (await nsenter('systemctl', ['is-active', MEAS_UDP2DB_UNIT]).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim() === 'active';
    await nsenter('systemctl', [wasActive ? 'restart' : 'enable', ...(wasActive ? [] : ['--now']), MEAS_UDP2DB_UNIT]);
  }

  // osmo-msc needs to know about the MGW too (real voice bearers) — this
  // module never writes osmo-msc.cfg itself, it only asks sms-controller.ts
  // (the file's sole owner) to include the block. See setMscMgwPeer()'s own
  // comment for why.
  setMscMgwPeer(state.mscMgwBindIp);
  const { configureSms, readCurrentSmsConfig } = await import('./sms-controller');
  const currentSms = readCurrentSmsConfig();
  if (currentSms) {
    // SGs-SMS must already be configured for this to apply — same
    // precondition getMscVtyHost()/upsertSmppEsme() already enforce for
    // SMPP. A 2G module with no working SGs-SMS core underneath it isn't
    // meaningful (osmo-hlr/osmo-msc/osmo-stp are the shared foundation both
    // depend on), so this isn't a new requirement, just a explicit one.
    await configureSms(currentSms);
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export function createGsmRouter(subscriberRepo: ISubscriberRepository, logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // GET /api/gsm/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const [bscWhich, mgwWhich, btsWhich, sgsnWhich] = await Promise.all([
        nsenter('which', ['osmo-bsc']).catch(() => ({ stdout: '', stderr: '' })),
        nsenter('which', ['osmo-mgw']).catch(() => ({ stdout: '', stderr: '' })),
        nsenter('which', ['osmo-bts-virtual']).catch(() => ({ stdout: '', stderr: '' })),
        nsenter('which', ['osmo-sgsn']).catch(() => ({ stdout: '', stderr: '' })),
      ]);
      const installedOnDisk = bscWhich.stdout.trim().length > 0 && mgwWhich.stdout.trim().length > 0;
      const btsInstalled = btsWhich.stdout.trim().length > 0;
      const gprsInstalled = sgsnWhich.stdout.trim().length > 0;

      const state = loadGsmState();
      const svcNames = [
        'osmo-bsc', 'osmo-mgw', ...(state.btsEntries.some(e => e.backend === 'virtual') ? ['osmo-bts-virtual'] : []),
        ...(state.gprsEnabled ? ['osmo-sgsn', 'osmo-ggsn'] : []),
        ...(state.gprsEnabled && state.btsEntries.some(e => e.backend === 'virtual' || e.backend === 'trx') ? ['osmo-pcu'] : []),
      ];
      const results = await Promise.allSettled(svcNames.map(svc => nsenter('systemctl', ['is-active', svc])));
      const services: Record<string, boolean> = {};
      svcNames.forEach((svc, i) => {
        const r = results[i];
        services[svc] = r.status === 'fulfilled' && r.value.stdout.trim() === 'active';
      });

      const configured = fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-bsc.cfg`) && fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-mgw.cfg`);

      // Read-only on this page — hlrBindIp/mscBindIp are owned and edited on
      // the SMS (SGs) page's own Configure form; shown here purely so the
      // operator can see the full picture (what osmo-hlr/osmo-msc are
      // actually bound to) without needing to jump pages to cross-reference.
      const sgsShared = readCurrentSmsConfig();

      res.json({
        success: true,
        installedOnDisk,
        btsInstalled,
        gprsInstalled,
        configured,
        services,
        btsEntries: state.btsEntries,
        bscMgwBindIp: state.bscMgwBindIp,
        mscMgwBindIp: state.mscMgwBindIp,
        mgwRtpBindIp: state.mgwRtpBindIp,
        gprsEnabled: !!state.gprsEnabled,
        gprsMode: state.gprsMode ?? 'gprs',
        gprsNat: !!state.gprsNat,
        sgsnGtpLocalIp: state.sgsnGtpLocalIp,
        sgsnGbRemoteIp: state.sgsnGbRemoteIp || '',
        ggsnGtpBindIp: state.ggsnGtpBindIp,
        ggsnApn: state.ggsnApn,
        ggsnTunDevice: state.ggsnTunDevice,
        ggsnPoolCidr: state.ggsnPoolCidr,
        ggsnDns1: state.ggsnDns1,
        ggsnDns2: state.ggsnDns2,
        // What the GGSN pool is actually doing in the dataplane right now,
        // so the UI can show "advertised via EIGRP: <cidr>" / "NAT: <cidr>"
        // persistently, not just in the Configure response.
        appliedGprsEigrpCidr: state.appliedGprsEigrpCidr || '',
        appliedGprsNatCidr: state.appliedGprsNatCidr || '',
        sgsShared: sgsShared ? { hlrBindIp: sgsShared.hlrBindIp, mscBindIp: sgsShared.mscBindIp } : null,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'gsm status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/gsm/install — streaming apt install of osmo-bsc + osmo-mgw +
  // osmo-bts (the latter bundles the virtual/trx backends both — see the
  // plan's Phase 0/1 note on why one package covers both).
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const child = spawn('nsenter', [
      '-t', '1', '-m', '-u', '-i', '-p', '--',
      'bash', '-c', "DEBIAN_FRONTEND=noninteractive apt-get install -y osmo-bsc osmo-mgw osmo-bts osmo-bsc-meas-utils osmo-pcu osmo-sgsn osmo-ggsn 2>&1",
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => write(d.toString()));
    child.stderr?.on('data', (d: Buffer) => write(d.toString()));
    child.on('close', async (code) => {
      const ok = code === 0;
      await auditLogger.log({ action: 'gsm_install', user, details: `exit code ${code}`, success: ok });
      write(ok ? '\n✅ osmo-bsc, osmo-mgw, osmo-bts, osmo-bsc-meas-utils, osmo-pcu, osmo-sgsn, osmo-ggsn installed.' : `\n❌ Install failed (exit ${code}).`);
      res.end();
    });
  });

  // POST /api/gsm/configure — Body: { bscMgwBindIp?, mscMgwBindIp?, mgwRtpBindIp? }
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadGsmState();
      state.bscMgwBindIp = (req.body.bscMgwBindIp as string) || state.bscMgwBindIp;
      state.mscMgwBindIp = (req.body.mscMgwBindIp as string) || state.mscMgwBindIp;
      state.mgwRtpBindIp = (req.body.mgwRtpBindIp as string) || state.mgwRtpBindIp;
      if (typeof req.body.gprsEnabled === 'boolean') state.gprsEnabled = req.body.gprsEnabled;
      if (req.body.gprsMode === 'gprs' || req.body.gprsMode === 'egprs') state.gprsMode = req.body.gprsMode;
      // The Setup-tab GPRS/EDGE toggle is the single control for data-service
      // type — apply it to every BTS here (enabled → chosen mode on all,
      // disabled → 'none' on all) so it isn't also buried per-BTS.
      const perBtsMode: BtsEntry['gprsMode'] = state.gprsEnabled ? (state.gprsMode ?? 'gprs') : 'none';
      for (const b of state.btsEntries) b.gprsMode = perBtsMode;
      state.sgsnGtpLocalIp = (req.body.sgsnGtpLocalIp as string) || state.sgsnGtpLocalIp;
      state.ggsnGtpBindIp  = sanitizeGgsnGtpIp((req.body.ggsnGtpBindIp as string)  || state.ggsnGtpBindIp);
      state.ggsnApn        = (req.body.ggsnApn as string)        || state.ggsnApn;
      state.ggsnTunDevice  = (req.body.ggsnTunDevice as string)  || state.ggsnTunDevice;
      state.ggsnPoolCidr   = (req.body.ggsnPoolCidr as string)   ?? state.ggsnPoolCidr;
      state.ggsnDns1       = (req.body.ggsnDns1 as string)       || state.ggsnDns1;
      state.ggsnDns2       = (req.body.ggsnDns2 as string)       || state.ggsnDns2;
      if (typeof req.body.gprsNat === 'boolean') state.gprsNat = req.body.gprsNat;
      // SGSN Gb address: honour an explicit value, else auto-derive this
      // host's IP on the same subnet as the first remote radio (so a
      // nanoBTS's PCU actually reaches the SGSN instead of dialling
      // 127.0.0.1 into itself).
      state.sgsnGbRemoteIp = (req.body.sgsnGbRemoteIp as string) ?? state.sgsnGbRemoteIp ?? '';
      if (!state.sgsnGbRemoteIp && state.gprsEnabled) {
        state.sgsnGbRemoteIp = await deriveSgsnGbIp(state.btsEntries);
      }
      saveGsmState(state);
      await regenerateGsmConfigs(state);
      await nsenter('systemctl', ['restart', 'osmo-mgw']);
      await nsenter('systemctl', ['restart', 'osmo-bsc']);
      let eigrpApplied: string | null = null;
      const wantCidr = state.gprsEnabled && state.ggsnPoolCidr ? state.ggsnPoolCidr : null;
      if (wantCidr) {
        await nsenter('systemctl', ['restart', 'osmo-sgsn']).catch(() => {});
        await nsenter('systemctl', ['restart', 'osmo-ggsn']).catch(() => {});
        // osmo-pcu only applies to a locally-run osmo-bts (virtual/trx) — a
        // real ip.access nanoBTS runs its own internal PCU and connects Gb
        // straight to the SGSN, so osmo-pcu would just crash-loop trying to
        // reach a /tmp/pcu_bts socket that never appears.
        const hasLocalBts = state.btsEntries.some(e => e.backend === 'virtual' || e.backend === 'trx');
        if (hasLocalBts) {
          await nsenter('systemctl', ['restart', 'osmo-pcu']).catch(() => {});
        } else {
          await nsenter('systemctl', ['disable', '--now', 'osmo-pcu']).catch(() => {});
        }
      }
      // Make the GGSN pool reachable — no manual step. Two modes:
      //  - routed (default): auto-add an EIGRP `network` statement via the
      //    *incremental* live vtysh path (never `systemctl restart frr` —
      //    that's this project's confirmed eigrpd crash trigger, CLAUDE.md
      //    gotcha #7); the pool must be a disjoint sub-block of a routed
      //    subnet.
      //  - NAT: MASQUERADE the pool out instead; then it only has to not
      //    overlap Open5GS's own UE subnet.
      // Whichever mode is active, the other mode's leftover rule is torn
      // down so a toggle doesn't strand a stale route/masq.
      const dev = state.ggsnTunDevice || 'apn-gprs';
      const wantEigrp = wantCidr && !state.gprsNat ? wantCidr : null;
      const wantNat   = wantCidr &&  state.gprsNat ? wantCidr : null;
      if (state.appliedGprsEigrpCidr && state.appliedGprsEigrpCidr !== wantEigrp) {
        eigrpApplied = await applyGprsEigrpRoute(null, state.appliedGprsEigrpCidr, dev);
        state.appliedGprsEigrpCidr = undefined; saveGsmState(state);
      }
      if (state.appliedGprsNatCidr && state.appliedGprsNatCidr !== wantNat) {
        eigrpApplied = await applyGprsNat(null, state.appliedGprsNatCidr, dev);
        state.appliedGprsNatCidr = undefined; saveGsmState(state);
      }
      if (wantEigrp && wantEigrp !== state.appliedGprsEigrpCidr) {
        eigrpApplied = await applyGprsEigrpRoute(wantEigrp, null, dev);
        state.appliedGprsEigrpCidr = wantEigrp; saveGsmState(state);
      }
      if (wantNat && wantNat !== state.appliedGprsNatCidr) {
        eigrpApplied = await applyGprsNat(wantNat, null, dev);
        state.appliedGprsNatCidr = wantNat; saveGsmState(state);
      }
      // FORWARD ACCEPT for the GGSN tun — mode-independent (see helper).
      await ensureGprsForwardAccept(dev, !!state.gprsEnabled);
      await auditLogger.log({ action: 'gsm_configure', user, details: `osmo-bsc/osmo-mgw configured, gprsEnabled=${!!state.gprsEnabled} nat=${!!state.gprsNat}`, success: true });
      res.json({ success: true, eigrpApplied });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_configure', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  const btsBackendServiceName = (backend: BtsBackend): string | null =>
    backend === 'virtual' ? 'osmo-bts-virtual' : null; // 'trx' arrives in Phase 2, 'remote-abis-ip' has no local service at all

  // Repoints a real ip.access unit's OML target at this host and restarts
  // it — confirmed live (2026-09-09, real nanoBTS) this alone is enough to
  // bring the cell fully on-air within ~60-90s, no separate "arm"/"unlock"
  // step. This is the one action in this whole module with real regulatory
  // stakes (RF transmission on licensed spectrum) — never call this without
  // the caller having gone through the RF-authorization acknowledgment
  // (enforced client-side in AddBtsModal; every server-side call site below
  // is reached only via that form).
  async function provisionRemoteRadio(remoteIp: string, bscOmlIp: string): Promise<void> {
    await nsenter('ipaccess-config', ['-o', bscOmlIp, '-r', remoteIp], 20000);
  }

  // GET /api/gsm/subscribers — read-only unified-subscriber view for 2G.
  // Deliberately scoped to "opted in AND actually synced", not "everything
  // OsmoHLR happens to have" — hlr.db also carries MSISDN-only rows kept
  // there for the separate SMS-over-SGs feature (sms-controller.ts's own
  // sync-subscribers, unchanged), which have nothing to do with the 2G/GSM
  // module and would otherwise show up here as confusing, uncontrolled
  // noise. hlr.db itself stays owned by sms-controller.ts (see
  // listHlrSubscriberStatus's own comment) — this route just cross-
  // references it against Mongo's gsmEnabled flag.
  router.get('/subscribers', async (_req: Request, res: Response) => {
    const [hlrRows, allSubs] = await Promise.all([
      listHlrSubscriberStatus(),
      subscriberRepo.findAllFull(),
    ]);
    const hlrByImsi = new Map(hlrRows.map(r => [r.imsi, r]));
    const subscribers = allSubs
      .filter(s => s.gsmEnabled === true && hlrByImsi.has(s.imsi))
      .map(s => hlrByImsi.get(s.imsi)!);
    res.json({ success: true, subscribers });
  });

  const MEAS_ROW_COLUMNS =
    `p.imsi || '|' || p.timestamp || '|' || COALESCE(p.ms_l1_pwr,'') || '|' || COALESCE(p.ms_l1_ta,'') || '|' || ` +
    `COALESCE(p.ul_rx_lev_full,'') || '|' || COALESCE(p.ul_rx_qual_full,'') || '|' || ` +
    `COALESCE(p.dl_rx_lev_full,'') || '|' || COALESCE(p.dl_rx_qual_full,'') || '|' || ` +
    `COALESCE(p.bs_power,'') || '|' || COALESCE(p.ul_path_loss_full,'') || '|' || COALESCE(p.dl_path_loss_full,'')`;

  function parseMeasRow(line: string) {
    const [imsi, timestamp, msL1Pwr, msL1Ta, ulRxLev, ulRxQual, dlRxLev, dlRxQual, bsPower, ulPathLoss, dlPathLoss] = line.split('|');
    const n = (v: string) => (v === '' ? null : Number(v));
    return {
      imsi, timestamp,
      msPowerDbm: n(msL1Pwr), timingAdvance: n(msL1Ta),
      ulRxLevDbm: n(ulRxLev), ulRxQual: n(ulRxQual),
      dlRxLevDbm: n(dlRxLev), dlRxQual: n(dlRxQual),
      bsPowerDbm: n(bsPower), ulPathLossDb: n(ulPathLoss), dlPathLossDb: n(dlPathLoss),
    };
  }

  // GET /api/gsm/signal/overview — latest 2G measurement sample per IMSI,
  // cross-referenced against Open5GS's own subscriber list for
  // nickname/msisdn exactly like radio-signal-controller.ts's own read-time
  // join (no identity duplicated into meas.db itself — osmo-bsc already
  // resolves the IMSI for us before it ever leaves the meas-feed UDP
  // datagram, so unlike the 4G feature there's no separate backfill step).
  router.get('/signal/overview', async (_req: Request, res: Response) => {
    try {
      const { stdout } = await nsenter('sqlite3', [
        HOST_MEAS_DB,
        // Exclude rows with no resolved subscriber — osmo-bsc's meas-feed
        // also emits measurement reports for channels in setup/RACH before
        // an identity is known, which osmo-meas-udp2db stores with an empty
        // imsi. Those aren't a "UE" and were inflating the active count
        // (e.g. dashboard showing 2G "2/1").
        `SELECT ${MEAS_ROW_COLUMNS} FROM path_loss p ` +
        `INNER JOIN (SELECT imsi, MAX(id) AS max_id FROM path_loss WHERE imsi IS NOT NULL AND imsi != '' GROUP BY imsi) latest ` +
        `ON p.imsi = latest.imsi AND p.id = latest.max_id ORDER BY p.imsi;`,
      ]);
      const rows = stdout.split('\n').map(l => l.trim()).filter(Boolean).map(parseMeasRow);
      const allSubs = await subscriberRepo.findAllFull();
      const byImsi = new Map(allSubs.map(s => [s.imsi, s]));
      // Live "which UE is on which BTS right now" — best-effort, doesn't
      // fail the whole request if the VTY is briefly unreachable.
      let btsByImsi = new Map<string, number>();
      try {
        const lchanRaw = await bscVtyCommand('show lchan');
        btsByImsi = new Map(parseActiveLchans(lchanRaw).map(x => [x.imsi, x.bts]));
      } catch { /* VTY unreachable — every sample just gets bts: null */ }
      const samples = rows.map(r => {
        const sub = byImsi.get(r.imsi);
        return {
          ...r,
          nickname: sub?.nickname ?? null,
          msisdn: sub?.msisdn?.[0] ?? null,
          bts: btsByImsi.has(r.imsi) ? btsByImsi.get(r.imsi)! : null,
        };
      });
      res.json({ success: true, samples });
    } catch {
      // meas.db doesn't exist yet (module not configured, or no real UE has
      // triggered a measurement report yet) — same as HLR's own
      // "DB doesn't exist yet" handling elsewhere in this file.
      res.json({ success: true, samples: [] });
    }
  });

  // GET /api/gsm/signal/history?imsi=... — time series for one subscriber's
  // signal-history chart.
  router.get('/signal/history', async (req: Request, res: Response) => {
    const imsi = String(req.query.imsi ?? '');
    if (!/^\d+$/.test(imsi)) {
      return res.status(400).json({ success: false, error: 'imsi must be numeric' });
    }
    try {
      const { stdout } = await nsenter('sqlite3', [
        HOST_MEAS_DB,
        `SELECT ${MEAS_ROW_COLUMNS} FROM path_loss p WHERE p.imsi='${imsi}' ORDER BY p.id DESC LIMIT 500;`,
      ]);
      const samples = stdout.split('\n').map(l => l.trim()).filter(Boolean).map(parseMeasRow).reverse();
      res.json({ success: true, samples });
    } catch {
      res.json({ success: true, samples: [] });
    }
  });

  // GET /api/gsm/bts
  router.get('/bts', async (_req: Request, res: Response) => {
    res.json({ success: true, btsEntries: loadGsmState().btsEntries });
  });

  // POST /api/gsm/discover — Body: { cidr, timeoutSeconds? }. Sends a real
  // ip.access discovery probe (unicast, see sweepForIpaRadios's own comment)
  // to every host address in the given CIDR — the user's own subnet choice,
  // local or remote, is trusted as-is; this makes no assumption about local
  // attachment and requires no bind-interface selection.
  router.post('/discover', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const cidr = req.body.cidr as string;
    if (!cidr || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(cidr)) {
      res.status(400).json({ success: false, error: 'cidr is required, e.g. 172.16.0.0/24' });
      return;
    }
    const timeoutSeconds = Math.min(Math.max(Number(req.body.timeoutSeconds) || 5, 2), 30);
    try {
      const radios = await sweepForIpaRadios(cidr, timeoutSeconds * 1000);
      await auditLogger.log({ action: 'gsm_discover', user, details: `${radios.length} found on ${cidr}`, success: true });
      res.json({ success: true, radios });
    } catch (err: any) {
      await auditLogger.log({ action: 'gsm_discover', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err?.message ?? err) });
    }
  });

  // POST /api/gsm/bts — add a BTS entry
  router.post('/bts', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadGsmState();
      const backend = req.body.backend as BtsBackend;
      if (!['virtual', 'trx', 'remote-abis-ip'].includes(backend)) {
        res.status(400).json({ success: false, error: 'backend must be virtual, trx, or remote-abis-ip' });
        return;
      }
      if (backend === 'virtual' && state.btsEntries.some(e => e.backend === 'virtual')) {
        res.status(400).json({ success: false, error: 'Only one virtual BTS is supported for protocol testing (Phase 1) — remove the existing one first' });
        return;
      }
      const band = (req.body.band as string) || 'DCS1800';
      const range = BTS_BAND_ARFCN_RANGE[band];
      const arfcn = Number(req.body.arfcn) || range?.default || 871;
      if (range && (arfcn < range.min || arfcn > range.max)) {
        res.status(400).json({ success: false, error: `ARFCN ${arfcn} is out of range for ${band} (valid: ${range.min}-${range.max})` });
        return;
      }
      const entry: BtsEntry = {
        id: randomUUID(),
        name: (req.body.name as string) || 'BTS',
        backend,
        // Real hardware usually already has its own unit-id burned in
        // (read via `ipaccess-config -G <ip>` — see the wiki note on that
        // tool) — honor an explicit value rather than force a second write
        // to the physical unit just to match this module's own numbering.
        unitId: req.body.unitId != null && req.body.unitId !== '' ? Number(req.body.unitId) : nextUnitId(state.btsEntries),
        band,
        arfcn,
        cellIdentity: Number(req.body.cellIdentity) || 1,
        locationAreaCode: Number(req.body.locationAreaCode) || 1,
        baseStationIdCode: Number(req.body.baseStationIdCode) || 63,
        remoteIp: backend === 'remote-abis-ip' ? (req.body.remoteIp as string) : undefined,
        omlRemoteIp: backend !== 'remote-abis-ip' ? ((req.body.omlRemoteIp as string) || state.bscMgwBindIp) : undefined,
        gprsMode: (req.body.gprsMode as BtsEntry['gprsMode']) || 'none',
        gprsNsvci: req.body.gprsNsvci != null && req.body.gprsNsvci !== '' ? Number(req.body.gprsNsvci) : undefined,
        gprsNsei: req.body.gprsNsei != null && req.body.gprsNsei !== '' ? Number(req.body.gprsNsei) : undefined,
        gprsBvci: req.body.gprsBvci != null && req.body.gprsBvci !== '' ? Number(req.body.gprsBvci) : undefined,
        lteEarfcns: parseEarfcns(req.body.lteEarfcns),
      };
      state.btsEntries.push(entry);
      saveGsmState(state);
      await regenerateGsmConfigs(state);
      await nsenter('systemctl', ['restart', 'osmo-bsc']).catch(() => {});
      const svc = btsBackendServiceName(backend);
      if (svc) {
        await nsenter('systemctl', ['enable', '--now', svc]).catch(() => {});
      }

      // The "one-click configure" step for real hardware: repoint the
      // physical unit's OML target at this host so it actually dials in,
      // rather than leaving that as a separate manual step the user has to
      // remember (see memory: gsm_2g_osmocom_module_progress for why this
      // is safe to always do — repointing to the same IP it may already
      // have is a harmless no-op, and it's what makes "add radio" mean
      // "radio works" in one action rather than several).
      let provisionWarning: string | undefined;
      if (backend === 'remote-abis-ip' && entry.remoteIp) {
        try {
          await provisionRemoteRadio(entry.remoteIp, state.bscMgwBindIp);
        } catch (err) {
          provisionWarning = `Saved, but repointing the radio failed: ${String(err)}. Retry from the BTS list once the radio is reachable.`;
        }
      }

      await auditLogger.log({ action: 'gsm_bts_add', user, details: `${entry.name} (${backend})${provisionWarning ? ' [provision failed]' : ''}`, success: true });
      res.json({ success: true, bts: entry, provisionWarning });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_bts_add', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // PUT /api/gsm/bts/:id — edit an existing entry's settings
  router.put('/bts/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadGsmState();
      const idx = state.btsEntries.findIndex(e => e.id === req.params.id);
      if (idx === -1) { res.status(404).json({ success: false, error: 'BTS entry not found' }); return; }
      const existing = state.btsEntries[idx];

      const band = (req.body.band as string) || existing.band;
      const range = BTS_BAND_ARFCN_RANGE[band];
      const arfcn = req.body.arfcn != null ? Number(req.body.arfcn) : existing.arfcn;
      if (range && (arfcn < range.min || arfcn > range.max)) {
        res.status(400).json({ success: false, error: `ARFCN ${arfcn} is out of range for ${band} (valid: ${range.min}-${range.max})` });
        return;
      }

      const updated: BtsEntry = {
        ...existing,
        name: (req.body.name as string) || existing.name,
        unitId: req.body.unitId != null && req.body.unitId !== '' ? Number(req.body.unitId) : existing.unitId,
        band,
        arfcn,
        cellIdentity: req.body.cellIdentity != null ? Number(req.body.cellIdentity) : existing.cellIdentity,
        locationAreaCode: req.body.locationAreaCode != null ? Number(req.body.locationAreaCode) : existing.locationAreaCode,
        baseStationIdCode: req.body.baseStationIdCode != null ? Number(req.body.baseStationIdCode) : existing.baseStationIdCode,
        remoteIp: existing.backend === 'remote-abis-ip' ? ((req.body.remoteIp as string) ?? existing.remoteIp) : existing.remoteIp,
        omlRemoteIp: existing.backend !== 'remote-abis-ip' ? ((req.body.omlRemoteIp as string) ?? existing.omlRemoteIp) : existing.omlRemoteIp,
        gprsMode: (req.body.gprsMode as BtsEntry['gprsMode']) ?? existing.gprsMode ?? 'none',
        gprsNsvci: req.body.gprsNsvci != null && req.body.gprsNsvci !== '' ? Number(req.body.gprsNsvci) : existing.gprsNsvci,
        gprsNsei: req.body.gprsNsei != null && req.body.gprsNsei !== '' ? Number(req.body.gprsNsei) : existing.gprsNsei,
        gprsBvci: req.body.gprsBvci != null && req.body.gprsBvci !== '' ? Number(req.body.gprsBvci) : existing.gprsBvci,
        lteEarfcns: req.body.lteEarfcns !== undefined ? parseEarfcns(req.body.lteEarfcns) : existing.lteEarfcns,
      };
      state.btsEntries[idx] = updated;
      saveGsmState(state);
      await regenerateGsmConfigs(state);
      await nsenter('systemctl', ['restart', 'osmo-bsc']).catch(() => {});

      // Unit-id or remote-IP changes only matter for real hardware — a
      // changed remote IP means re-pointing the *new* address; the unit-id
      // itself is intentionally never rewritten to the radio here (this
      // module always prefers reusing whatever's already burned in — see
      // provisionRemoteRadio()'s own comment) even if the user edits it in
      // this form, since that only changes what osmo-bsc expects to see,
      // not what the hardware reports.
      let provisionWarning: string | undefined;
      if (updated.backend === 'remote-abis-ip' && updated.remoteIp && updated.remoteIp !== existing.remoteIp) {
        try {
          await provisionRemoteRadio(updated.remoteIp, state.bscMgwBindIp);
        } catch (err) {
          provisionWarning = `Saved, but repointing the radio failed: ${String(err)}.`;
        }
      }

      await auditLogger.log({ action: 'gsm_bts_edit', user, details: updated.name, success: true });
      res.json({ success: true, bts: updated, provisionWarning });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_bts_edit', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/gsm/bts/:id/provision — retry the physical repoint for an
  // existing remote-abis-ip entry without re-entering/changing anything.
  router.post('/bts/:id/provision', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadGsmState();
    const entry = state.btsEntries.find(e => e.id === req.params.id);
    if (!entry) { res.status(404).json({ success: false, error: 'BTS entry not found' }); return; }
    if (entry.backend !== 'remote-abis-ip' || !entry.remoteIp) {
      res.status(400).json({ success: false, error: 'Only remote-abis-ip entries with a unit IP can be (re)provisioned' });
      return;
    }
    try {
      await provisionRemoteRadio(entry.remoteIp, state.bscMgwBindIp);
      await auditLogger.log({ action: 'gsm_bts_provision', user, details: `${entry.name} (${entry.remoteIp})`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_bts_provision', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/gsm/bts/:id/restart — reboot a real ip.access unit in place
  // (ipaccess-config -r), without changing its OML target. It drops OML/RSL
  // and comes back on its own in ~60-90s.
  router.post('/bts/:id/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const entry = loadGsmState().btsEntries.find(e => e.id === req.params.id);
    if (!entry) { res.status(404).json({ success: false, error: 'BTS entry not found' }); return; }
    if (entry.backend !== 'remote-abis-ip' || !entry.remoteIp) {
      res.status(400).json({ success: false, error: 'Only a real ip.access unit can be restarted this way' });
      return;
    }
    // "No route to host" / "could not connect socket" here almost always
    // means the unit is mid-reboot or its OML is flapping right now — the
    // exact window an operator reaches for this button. Retry a few times
    // before giving up, and return a message that says what's actually
    // going on rather than a raw nsenter error.
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { stdout } = await nsenter('ipaccess-config', ['-r', entry.remoteIp], 25000);
        await auditLogger.log({ action: 'gsm_bts_provision', user, details: `restart ${entry.name} (${entry.remoteIp}) attempt ${attempt}`, success: true });
        res.json({ success: true, message: `Restart sent — ${entry.name} reboots and takes ~2 min to come back on air.`, detail: stdout.trim() });
        return;
      } catch (err) {
        lastErr = String(err);
        if (attempt < 3) await new Promise(r => setTimeout(r, 4000));
      }
    }
    await auditLogger.log({ action: 'gsm_bts_provision', user, details: `restart failed: ${lastErr}`, success: false });
    const unreachable = /no route to host|could not connect|connection refused|timed out/i.test(lastErr);
    res.status(502).json({
      success: false,
      error: unreachable
        ? `Could not reach ${entry.name} at ${entry.remoteIp} on its config port — it may already be rebooting or its Abis link is down. Wait ~1–2 min and check the link status before retrying.`
        : `Restart failed: ${lastErr}`,
    });
  });

  // GET /api/gsm/bts/:id/link-status — live OML/RSL/NM state for one entry,
  // for the frontend to poll during/after bring-up (see parseBtsLinkStatus's
  // comment — this is the exact same data this module's own live testing
  // was read from manually while bringing up both the virtual BTS and the
  // real nanoBTS). The bts-N index is this entry's current array position,
  // recomputed fresh each call — that's also what regenerateGsmConfigs()
  // uses, so it can never drift from what's actually in osmo-bsc.cfg.
  router.get('/bts/:id/link-status', async (req: Request, res: Response) => {
    const state = loadGsmState();
    const idx = state.btsEntries.findIndex(e => e.id === req.params.id);
    if (idx === -1) { res.status(404).json({ success: false, error: 'BTS entry not found' }); return; }
    try {
      const raw = await bscVtyCommand(`show bts ${idx}`);
      res.json({ success: true, ...parseBtsLinkStatus(raw) });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // DELETE /api/gsm/bts/:id
  router.delete('/bts/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadGsmState();
      const removed = state.btsEntries.find(e => e.id === req.params.id);
      state.btsEntries = state.btsEntries.filter(e => e.id !== req.params.id);
      saveGsmState(state);
      await regenerateGsmConfigs(state);
      await nsenter('systemctl', ['restart', 'osmo-bsc']).catch(() => {});
      if (removed) {
        const svc = btsBackendServiceName(removed.backend);
        if (svc) await nsenter('systemctl', ['disable', '--now', svc]).catch(() => {});
      }
      await auditLogger.log({ action: 'gsm_bts_remove', user, details: req.params.id, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_bts_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/gsm/start | /stop | /restart
  const lifecycleServices = (state: GsmState): string[] => [
    'osmo-mgw', 'osmo-bsc',
    ...state.btsEntries.map(e => btsBackendServiceName(e.backend)).filter((s): s is string => !!s),
  ];
  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const svc of lifecycleServices(loadGsmState())) await nsenter('systemctl', ['start', svc]);
      await auditLogger.log({ action: 'gsm_start', user, details: 'gsm services started', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const svc of lifecycleServices(loadGsmState()).reverse()) await nsenter('systemctl', ['stop', svc]);
      await auditLogger.log({ action: 'gsm_stop', user, details: 'gsm services stopped', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const svc of lifecycleServices(loadGsmState())) await nsenter('systemctl', ['restart', svc]);
      await auditLogger.log({ action: 'gsm_restart', user, details: 'gsm services restarted', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ─── Config file editor (mirrors sms-controller.ts's /configs endpoints) ──
  router.get('/configs', async (_req: Request, res: Response) => {
    const files: GsmConfigFile[] = GSM_CONFIG_MANIFEST.map(f => ({ ...f, exists: fs.existsSync(f.path) }));
    res.json({ success: true, files });
  });

  router.get('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const path = req.query.path as string;
    if (!GSM_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
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
    if (!GSM_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
    try {
      fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
      fs.writeFileSync(path, content, 'utf-8');
      await auditLogger.log({ action: 'gsm_config_save', user, details: path, success: true });
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
      await auditLogger.log({ action: 'gsm_config_restart', user, details: services.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/gsm/uninstall
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    try {
      write('=== Stopping and disabling GSM services ===');
      const state = loadGsmState();
      for (const svc of lifecycleServices(state).reverse()) {
        await nsenter('systemctl', ['disable', '--now', svc]).catch(() => {});
      }
      write('osmo-bsc, osmo-mgw, and any BTS backends stopped and disabled.');

      write('\n=== Removing this module\'s MGW peer from osmo-msc ===');
      setMscMgwPeer(null);
      const { configureSms, readCurrentSmsConfig } = await import('./sms-controller');
      const currentSms = readCurrentSmsConfig();
      if (currentSms) await configureSms(currentSms);

      write('\n=== Removing GSM config files ===');
      for (const f of GSM_CONFIG_MANIFEST) { try { fs.unlinkSync(f.path); } catch { /* may not exist */ } }
      try { fs.unlinkSync(HOST_GSM_STATE); } catch { /* may not exist */ }

      write('\n=== Purging osmo-bsc, osmo-mgw, osmo-bts ===');
      await new Promise<void>((resolve) => {
        const purge = spawn('nsenter', [
          '-t', '1', '-m', '-u', '-i', '-p', '--',
          'bash', '-c', 'DEBIAN_FRONTEND=noninteractive apt-get purge -y osmo-bsc osmo-mgw osmo-bts 2>&1 && apt-get autoremove -y 2>&1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        purge.stdout?.on('data', (d: Buffer) => write(d.toString()));
        purge.stderr?.on('data', (d: Buffer) => write(d.toString()));
        purge.on('close', () => resolve());
      });

      await auditLogger.log({ action: 'gsm_uninstall', user, details: 'osmo-bsc/mgw/bts removed', success: true });
      write('\n✅ 2G GSM module uninstalled. osmo-stp/osmo-hlr/osmo-msc (shared with SMS over SGs) were left untouched.');
    } catch (err) {
      await auditLogger.log({ action: 'gsm_uninstall', user, details: String(err), success: false });
      write(`\n❌ Uninstall failed: ${String(err)}`);
    }
    res.end();
  });

  return router;
}
