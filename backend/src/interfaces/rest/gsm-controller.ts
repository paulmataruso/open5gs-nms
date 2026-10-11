import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { createSocket } from 'dgram';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { setMscMgwPeer, readCurrentSmsConfig, listHlrSubscriberStatus } from './sms-controller';
import { cidrRange, numToIp } from '../../domain/services/ip-utils';
import { upsertVtyDirectives, OwnedDirective } from '../../domain/services/vty-config-ownership';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { detectMainInterface } from '../../infrastructure/network/main-interface';
import {
  buildOsmoSipConnectorScript, verifyOsmoSipConnectorBuild, osmoSipConnectorSystemdUnit, osmoSipConnectorCfg,
  BIN as SIPCONN_BIN, UNIT_PATH as SIPCONN_UNIT_PATH, CFG_PATH as SIPCONN_CFG_PATH, MNCC_SOCKET_PATH as SIPCONN_MNCC_SOCKET_PATH,
} from '../../application/use-cases/osmo-sip-connector-build';
import { safeNsenter } from '../../infrastructure/system/safe-nsenter';

// Was previously its own local execFileAsync('nsenter', ...) + timeout, same shared
// pattern as sms-controller.ts/mms-controller.ts/pstn-controller.ts (there's no shared
// nsenter utility in this codebase — see IHostExecutor/LocalHostExecutor for the one
// that exists, unused by this family of controllers). Switched to safeNsenter
// specifically for THIS file — 2026-09-29, real finding while auditing tonight's work —
// because `osmoVtyCommand`/`bscVtyCommand` below both go through this helper and are
// each driven by their own 15s setInterval (startBtsCacheRefresh/startGsmSignalCache
// Refresh/startGprsTrafficCacheRefresh below), forever, on every deployment (unlike a
// one-shot request handler). VTY_RUN_COMMAND_SCRIPT's drain-loop structurally costs
// ~6.8s (see startBtsCacheRefresh's own comment) against only a 10s default timeout —
// real headroom to hit that timeout under any VTY slowness (a BTS OML flap, e.g.), and
// under the plain execFileAsync+timeout this used before, every such timeout orphaned
// the nsenter+python3 process tree (safe-nsenter.ts's own header comment has the full
// mechanism) — this is the exact "highest-consequence caller" shape that bug class was
// fixed for elsewhere (KamailioStatsMonitor), just not yet retrofitted here until now.
// Not applied blindly to every file sharing the old pattern — the others still using it
// (sms-controller.ts, mms-controller.ts, pstn-controller.ts, etc.) were checked and have
// no equivalent recurring-loop caller, so they keep the simpler pre-existing helper.
const nsenter = safeNsenter;

const HOST_OSMOCOM_DIR = '/proc/1/root/etc/osmocom';
const HOST_MME_YAML    = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_GSM_STATE   = `${HOST_OSMOCOM_DIR}/.nms-gsm-bts-state.json`;

// Per-UE 2G signal stats — osmo-bsc's own `meas-feed` (see osmobscCfg()'s
// network block) pushes one UDP datagram per RSL Measurement Report,
// already resolved to the real IMSI, to whoever's listening on this port.
// osmo-meas-udp2db (from the official osmo-bsc-meas-utils package — same
// apt repo, exact-version-matched to the installed osmo-bsc) is that
// listener; it owns and writes this sqlite file's ROWS directly. We do
// additionally create one index on it (see ensureMeasDbIndex below,
// `imsi`-keyed queries were doing full table scans without it) — additive
// DDL only, never touches osmo-meas-udp2db's own INSERTs. Lives outside the
// container's own mounted filesystem (same as hlr.db) so it's queried the
// same way — nsenter + the sqlite3 CLI, never a direct better-sqlite3 open.
const HOST_MEAS_DB          = '/var/lib/osmocom/meas.db';
const MEAS_UDP2DB_UNIT      = 'osmo-meas-udp2db';
const HOST_MEAS_UNIT_PATH   = '/proc/1/root/etc/systemd/system/osmo-meas-udp2db.service';
const MEAS_UDP2DB_BIN       = '/usr/bin/osmo-meas-udp2db';

// Standard Osmocom VTY telnet port for osmo-bsc — confirmed live against
// this exact installed version (osmo-bsc 1.9.0-3build2), same as how
// sms-controller.ts's MSC_VTY_PORT was confirmed for osmo-msc.
const BSC_VTY_PORT = 4242;
// osmo-ggsn's own VTY — confirmed live (2026-09-13, `ss -tlnp` against the
// real running process, osmo-ggsn 1.9.0-3.1build1) — and separately not in
// the sysmocom default-port table this project's own memory already has, so
// this is the authoritative source, not documentation. GGSN_NAME is the
// literal instance name osmoggsnCfg() below always generates (`ggsn ggsn0`)
// — never parameterized, safe to hardcode rather than re-discover per call.
const GGSN_VTY_PORT = 4260;
const GGSN_NAME = 'ggsn0';

// Same injection-safe pattern as sms-controller.ts's VTY_SEND_SMS_SCRIPT —
// argv-only, never a shell string — generalized to run one or more VTY
// commands in the SAME session (needed for e.g. entering the "oml" node
// with one command, then issuing change-adm-state within it — a plain node
// context that only persists within one connection) and return the
// concatenated drained response.
const VTY_RUN_COMMAND_SCRIPT = `
import socket, sys, time
host, port, cmds = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
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
out = b''
for cmd in cmds:
    s.sendall((cmd + '\\r\\n').encode())
    time.sleep(0.5)
    out += drain()
print(out.decode(errors='replace'))
s.close()
`;

async function osmoVtyCommand(port: number, cmd: string | string[]): Promise<string> {
  const cmds = Array.isArray(cmd) ? cmd : [cmd];
  const { stdout } = await nsenter('python3', ['-c', VTY_RUN_COMMAND_SCRIPT, '127.0.0.1', String(port), ...cmds], 10000);
  return stdout;
}

async function bscVtyCommand(cmd: string | string[]): Promise<string> {
  return osmoVtyCommand(BSC_VTY_PORT, cmd);
}

// GGSN's own PDP-context IMSI<->IP mapping — the actual IP allocator for
// GPRS/EDGE data sessions (osmo-sgsn only relays the GTP signaling, it never
// owns the address itself). Format below is copied exactly from osmo-ggsn
// 1.9.0's own show_one_pdp_v4only() (ggsn/ggsn_vty.c) — pulled via `apt-get
// source osmo-ggsn` and read directly, not guessed or reasoned from the
// VTY reference PDF (which is an auto-generated command-syntax tree with no
// sample output at all):
//   IMSI: <imsi>, NSAPI: <n>, MSISDN: <msisdn|(NONE)>
//    Version: <v>[, Primary, Num Secondaries: <n>|, Secondary]
//    Control: <ip>:<hex> <-> <ip>:<hex>
//    Data: <ip>:<hex> <-> <ip>:<hex>
//    APN requested: <name|(NONE)>
//    APN in use: <name|(NONE)>
//    End-User Address (IPv4): <ip>
//    Transmit GTP Sequence Number for G-PDU: Yes|No
// Multiple contexts print back-to-back with no separator, each starting
// fresh with its own "IMSI: " line — that's what block-splits on.
interface PdpContext {
  imsi: string; nsapi: number; msisdn: string | null; apnInUse: string | null; ipv4: string | null;
}
function parsePdpContexts(raw: string): PdpContext[] {
  const blocks = raw.split(/(?=IMSI: )/).filter(b => b.startsWith('IMSI:'));
  return blocks
    .map((block): PdpContext | null => {
      const head = block.match(/IMSI:\s*(\S+),\s*NSAPI:\s*(\d+),\s*MSISDN:\s*(\S+)/);
      if (!head) return null;
      const apn = block.match(/APN in use:\s*([^\r\n]+)/);
      const ip = block.match(/End-User Address \(IPv4\):\s*(\S+)/);
      return {
        imsi: head[1],
        nsapi: parseInt(head[2], 10),
        msisdn: head[3] === '(NONE)' ? null : head[3],
        apnInUse: apn && apn[1].trim() !== '(NONE)' ? apn[1].trim() : null,
        ipv4: ip ? ip[1] : null,
      };
    })
    .filter((c): c is PdpContext => c !== null);
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
  { path: `/proc/1/root${SIPCONN_CFG_PATH}`,             label: 'osmo-sip-connector.cfg', group: 'SIP',      language: 'ini', restartServices: ['osmo-sip-connector'] },
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
  // Administrative lock (osmo-bsc's own `rf_locked` TRX state — see
  // reapplyBtsLocks() below for why this needs to be tracked here at all
  // rather than just fired at the VTY once and forgotten: this project's own
  // generated osmo-bsc.cfg never emits an `rf_locked` line, so it's a
  // runtime-VTY-only toggle that silently reverts to Unlocked on every
  // osmo-bsc restart. See blockBtsByIdx()'s own comment for why this isn't
  // the older `change-adm-state` command an earlier version of this feature
  // used — that one never actually worked.
  blocked?: boolean;
}

export interface GsmState {
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
  // SIP tab (osmo-sip-connector) — deliberately minimal, matching upstream's
  // own config surface exactly (see osmo-sip-connector-build.ts). There is
  // no MSISDN routing, dial plan, or automatic 2G<->IMS call bridging here
  // by design (product decision, 2026-09-12, after the earlier attempt at
  // that was fully reverted — signaling never reliably completed and audio
  // was never confirmed working in either direction). "remote" is wherever
  // the operator wants 2G calls to go — this project's own P-CSCF, an
  // external SIP trunk, anything — configuring it to actually complete
  // calls is entirely on them.
  sip?: { localIp: string; localPort: number; remoteHost: string; remotePort: number };
}

// Lets sms-controller.ts defer to this module before deleting the Osmocom
// configs, hlr.db, or apt-purging osmo-stp/hlr/msc -- all of which 2G GSM
// shares with SMS-over-SGs. Mirrors isAsterisk2gInstalled()/isPstnInstalled()
// exactly. sms-controller.ts consumes this via a LAZY `await import()`, never
// a static one, because this file already statically imports sms-controller.ts
// (line 9) and a static import back would be a real load-time circular
// dependency -- CLAUDE.md pattern #16.
export function isGsmInstalled(): boolean {
  return fs.existsSync(HOST_GSM_STATE);
}

const GSM_STATE_DEFAULTS: GsmState = {
  btsEntries: [], bscMgwBindIp: '127.0.0.1', mscMgwBindIp: '127.0.0.1', mgwRtpBindIp: '127.0.0.1',
  gprsEnabled: false, gprsMode: 'gprs', sgsnGtpLocalIp: '127.0.0.1', sgsnGbRemoteIp: '', ggsnGtpBindIp: '127.0.0.5',
  ggsnApn: 'gprs', ggsnTunDevice: 'apn-gprs', ggsnPoolCidr: '', ggsnDns1: '1.1.1.1', ggsnDns2: '9.9.9.9', gprsNat: false,
  // 0.0.0.0 (upstream's own doc example default) does NOT work on this
  // host — confirmed live 2026-09-12: kamailio-pcscf (10.0.1.178:5060),
  // Asterisk (127.0.1.4:5060), and the VectorCore SMSC (127.0.1.5:5060) are
  // already bound to port 5060 on their own specific addresses, and a
  // wildcard bind conflicts with any existing specific-address bind on the
  // same port (crash-looped with "Address already in use" / "Failed to
  // initialize SIP" until fixed). 127.0.1.6 follows this project's own
  // one-dedicated-loopback-alias-per-SIP-daemon convention and is confirmed
  // free.
  sip: { localIp: '127.0.1.6', localPort: 5060, remoteHost: '', remotePort: 5060 },
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

export function loadGsmState(): GsmState {
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
  // radio-link-timeout raised from an original 32 to the real VTY-confirmed
  // max (`radio-link-timeout ?` on osmo-bsc: <4-64>, plus a test-only
  // 'infinite' deliberately not used — a truly dead link would then never
  // release its channel at all, worse than the problem this mitigates). A
  // real, repeated, intermittent T200/N200 exhaustion -> "Radio Link
  // Failure" was found live 2026-09-21 dropping otherwise-healthy calls on
  // this BTS's real hardware, alternating unpredictably between the two 2G
  // UEs under test — not tied to one specific device. Mitigation only (more
  // tolerance for a marginal link before declaring failure), not a fix for
  // whatever's causing the marginal RF condition itself.
  return ` bts ${index}
  type ${btsTypeFor(e.backend)}
  band ${e.band}
  cell_identity ${e.cellIdentity}
  location_area_code ${e.locationAreaCode}
  base_station_id_code ${e.baseStationIdCode}
  ms max power 15
  cell reselection hysteresis 4
  rxlev access min 0
  radio-link-timeout 64
  channel allocator ascending
  rach tx integer 9
  rach max transmission 7
  channel-description attach 1
  channel-description bs-pa-mfrms 5
  channel-description bs-ag-blks-res 1
  early-classmark-sending forbidden
  ipa unit-id ${e.unitId} 0
  oml ipa stream-id 255 line 0
  codec-support fr amr
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
  //
  // mgw endpoint-domain below must be 'mgw' — osmo-mgw itself has no
  // explicit `domain` override in its own config, so it uses its
  // compiled-in default of literally 'mgw' for every endpoint name it will
  // accept. This used to say 'bsc' (a reasonable-looking per-peer label,
  // matching sms-controller.ts's osmo-msc side using 'msc') but neither was
  // ever actually valid. Confirmed live 2026-09-13 via a real call attempt:
  // osmo-mgw rejected the MGCP CRCX with "wrong domain name ... expecting
  // mgw", so no voice bearer could ever be created — invisible until now
  // since attach/SMS/GPRS never touch MGW at all.
  //
  // DO NOT forbid every amr-config mode below (tried live 2026-09-13, real
  // outage): osmo-bsc's own startup validation (codec_pref.c) requires at
  // least one AMR mode to intersect between the BTS's own AMR mode-set and
  // this msc-0 block's amr-config — an empty allowed-set here can never
  // intersect with anything, so osmo-bsc refuses to start at all ("network
  // amr tch-f mode config of BTS 0 does not intersect with amr-config of
  // MSC 0" / "Configuration contains mutually exclusive codec settings"),
  // taking down the entire BTS, not just voice calls. Keep exactly one mode
  // allowed.
  //
  // This block is NOT the reason 2G<->2G calls don't complete end to end —
  // confirmed live 2026-09-13 with 5_90k allowed (as below): channel
  // assignment succeeds, the far end rings and can answer, but osmo-msc's
  // own internal/built-in MNCC handler (mncc_builtin.c, upstream Osmocom,
  // not this project's code) never implements MNCC_RTP_CREATE — it logs
  // "Message 'MNCC_RTP_CREATE' unhandled" and never actually bridges the
  // two RTP legs, so the call hangs and both channels eventually time out.
  // Real 2G<->2G audio needs the external MNCC path (osmo-sip-connector,
  // see the SIP tab) — internal mode only ever completes signaling, never
  // audio, on this osmo-msc version.
  //
  // That said, this amr-config block's SIBLING setting above (bts 0's own
  // codec-support) genuinely WAS a real, separate config bug, found live
  // 2026-09-15: codec-support was `fr` only (no amr), while this exact
  // amr-config block already allowed 5_90k — an internally inconsistent
  // pair. The BTS's own live OML Feature Vector (`show bts 0`) reports it
  // genuinely supports both `012 Fullrate speech AMR` and `013 Halfrate
  // speech AMR` — codec-support fr-only was needlessly hiding that from
  // osmo-bsc's own channel-mode selection, and every real TCH assignment
  // attempted through the (new, that day) Cross-RAN Calling path failed
  // with "Received NACK on IPACC CRCX" on the BTS's own first-tried channel,
  // 100% reproducible. Confirmed fixed live (codec-support fr amr, same
  // amr-config below, real BTS restart) via packet capture: full
  // bidirectional RTP flow on real calls in both directions. This does NOT
  // contradict the 2026-09-13 finding above (that finding was specifically
  // about amr-config, and about INTERNAL MNCC's own separate MNCC_RTP_CREATE
  // gap) — it just means the 2026-09-13 test happened to exercise a call
  // path/timing where codec-support's under-declaration didn't yet surface
  // as a hard NACK. See CLAUDE.md's Cross-RAN Calling entry and PROJECT_
  // STATE.md's 2026-09-15 Handoff Summary entry for the full investigation.
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
 timer net T3212 2
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
 mgw endpoint-domain mgw
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

// Ownership-merge write for osmo-sgsn.cfg, mirroring sms-controller.ts's own
// osmo-msc.cfg fix (vty-config-ownership.ts's own header comment has the
// full incident writeup: a blind fs.writeFileSync() on a shared VTY config
// destroyed hand/VTY-maintained content the simple template never modeled).
// This file was a plain blind overwrite until the 3G/OsmoHNBGW module
// needed to add its own `cs7 instance` block here for IuPS — without this
// conversion, the very next 2G-side GPRS/EDGE reconfigure would silently
// wipe that block. Every directive osmosgsnCfg() itself generates is now
// explicitly owned here; anything else in the file (the 3G module's cs7
// block included) passes through byte-for-byte untouched.
function writeSgsnCfg(gtpLocalIp: string, ggsnGtpIp: string, hlrBindIp: string, apn: string): void {
  const path = `${HOST_OSMOCOM_DIR}/osmo-sgsn.cfg`;
  const owned: OwnedDirective[] = [
    { node: 'log stderr', prefix: /^\s*logging filter all\s+/, line: ' logging filter all 1' },
    { node: 'log stderr', prefix: /^\s*logging print category\s+/, line: ' logging print category 1' },
    { node: 'line vty', prefix: /^\s*no login\s*$/, line: ' no login' },
    { node: 'sgsn', prefix: /^\s*gtp state-dir\s+/, line: ' gtp state-dir /tmp' },
    { node: 'sgsn', prefix: /^\s*gtp local-ip\s+/, line: ` gtp local-ip ${gtpLocalIp}` },
    { node: 'sgsn', prefix: /^\s*auth-policy\s+/, line: ' auth-policy remote' },
    { node: 'sgsn', prefix: /^\s*gsup remote-ip\s+/, line: ` gsup remote-ip ${hlrBindIp}` },
    { node: 'sgsn', prefix: /^\s*ggsn 0 remote-ip\s+/, line: ` ggsn 0 remote-ip ${ggsnGtpIp}` },
    { node: 'sgsn', prefix: /^\s*ggsn 0 gtp-version\s+/, line: ' ggsn 0 gtp-version 1' },
    { node: 'sgsn', prefix: /^\s*apn\s+\S+\s+ggsn\s+0\s*$/, line: ` apn ${apn} ggsn 0` },
    { node: 'sgsn', prefix: /^\s*ggsn dynamic\s*$/, line: ' ggsn dynamic' },
    { node: 'ns', prefix: /^\s*bind udp local\s*$/, line: ' bind udp local' },
    { node: 'ns', prefix: /^\s*listen\s+/, line: '  listen 0.0.0.0 23000' },
    { node: 'ns', prefix: /^\s*accept-ipaccess\s*$/, line: '  accept-ipaccess' },
  ];
  const current = fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : '';
  fs.writeFileSync(path, upsertVtyDirectives(current, owned, osmosgsnCfg(gtpLocalIp, ggsnGtpIp, hlrBindIp, apn)), 'utf-8');
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
// Directive names this module's generators never emit. Real defect found in
// the 2026-10-10 readiness audit: osmo-bsc.cfg is fully regenerated from
// structured state on every GSM Configure, BTS add/edit/delete, and IP-Plan
// apply touching the BSC/MGW bind IP -- then osmo-bsc is restarted, dropping
// camped 2G UEs. The live file on this host was 5283 bytes and carried real
// hand/VTY-maintained tuning the generator has no model for: 11 `gprs cell
// timer`, 7 `gprs ns timer`, `bs-power-control`, `rach max-delay`, `stats
// interval`, and 6 `amr tch-f` lines against the generator's 1. All of it
// would have been destroyed silently.
//
// The proper fix is an ownership-merge via upsertVtyDirectives() (the idiom
// sms-controller.ts already uses for osmo-msc.cfg), but that helper is
// deliberately one level deep and osmo-bsc.cfg nests network -> bts N ->
// trx N -> timeslot N, with most of the at-risk directives living INSIDE the
// bts blocks the generator rebuilds. Extending it needs a real 2G maintenance
// window to test, since getting a splice wrong yields a config osmo-bsc
// rejects outright -- i.e. radio down.
//
// So this does not pretend to merge. It makes the loss RECOVERABLE and
// VISIBLE instead of silent: every overwrite is backed up first, and any
// unmodelled directive that is about to disappear is named in the log. See
// TODO.md for the remaining merge work.
// Module-scope logger: writeHostCfg() is a plain function called from many
// places, not inside the router factory where the injected logger lives.
const cfgLogger = pino({ name: 'gsm-vty-config' });

const OSMO_BSC_UNMODELLED_DIRECTIVES = [
  'gprs cell timer', 'gprs ns timer', 'bs-power-control', 'rach max-delay',
  'stats interval', 'amr tch-f', 'cs7 instance',
];

function warnOnUnmodelledLoss(path: string, oldContent: string, newContent: string): void {
  const lost: string[] = [];
  for (const d of OSMO_BSC_UNMODELLED_DIRECTIVES) {
    const before = (oldContent.match(new RegExp(`^\\s*${d.replace(/ /g, '\\s+')}`, 'gm')) ?? []).length;
    const after  = (newContent.match(new RegExp(`^\\s*${d.replace(/ /g, '\\s+')}`, 'gm')) ?? []).length;
    if (before > after) lost.push(`${d} (${before} -> ${after})`);
  }
  if (lost.length > 0) {
    cfgLogger.warn(
      { path, lost },
      'Regenerating this VTY config DROPS hand-maintained directives the generator does not model — ' +
      'a timestamped backup was written alongside it; re-apply these by hand (or via vtysh + write memory) if they are still wanted',
    );
  }
}

function writeHostCfg(path: string, content: string): void {
  // Back up before every overwrite so a regeneration is always recoverable.
  // Kept to the most recent 10 so this cannot grow without bound.
  try {
    if (fs.existsSync(path)) {
      const prev = fs.readFileSync(path, 'utf-8');
      if (prev !== content) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(`${path}.pre-regen-${stamp}`, prev, 'utf-8');
        warnOnUnmodelledLoss(path, prev, content);
        const dir = require('path').dirname(path);
        const base = require('path').basename(path);
        const olds = fs.readdirSync(dir)
          .filter((n: string) => n.startsWith(`${base}.pre-regen-`))
          .sort();
        for (const stale of olds.slice(0, Math.max(0, olds.length - 10))) {
          try { fs.unlinkSync(`${dir}/${stale}`); } catch { /* best effort */ }
        }
      }
    }
  } catch (err) {
    cfgLogger.warn({ path, error: String(err) }, 'Could not back up VTY config before regenerating it');
  }
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

// Re-locks every BTS marked blocked in state, over VTY. Needed because
// rf_locked has no effect on this project's own generated osmo-bsc.cfg (see
// BtsEntry.blocked's comment) — every osmo-bsc restart silently drops back
// to Unlocked unless this replays the lock. osmo-bsc's VTY isn't necessarily
// up the instant `systemctl restart` returns, so this retries briefly
// rather than racing it.
//
// `rf_locked 1` at `configure terminal -> network -> bts N -> trx N`, NOT
// `change-adm-state locked` at the old "(oml)" pseudo-node this used to
// send — that command is silently overridden by osmo-bsc's own reconciliation
// loop and never actually sticks. See blockBtsByIdx()'s own comment (the
// interactive block/unblock route below) for the full story, confirmed live
// 2026-09-21 by reading osmo-bsc 1.9.0's real source.
async function reapplyBtsLocks(state: GsmState): Promise<void> {
  const lockedIdx = state.btsEntries.map((e, i) => (e.blocked ? i : -1)).filter(i => i >= 0);
  if (lockedIdx.length === 0) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      for (const idx of lockedIdx) {
        await bscVtyCommand(['configure terminal', 'network', `bts ${idx}`, 'trx 0', 'rf_locked 1', 'end']);
      }
      return;
    } catch {
      // VTY not up yet — retry
    }
  }
}

// Every call site that restarts osmo-bsc (config regen after a BTS
// add/edit/remove/configure, or the module-level Start/Restart buttons)
// should go through this so a blocked BTS never silently comes back
// unlocked — see reapplyBtsLocks() above.
async function restartOsmoBsc(state: GsmState): Promise<void> {
  await nsenter('systemctl', ['restart', 'osmo-bsc']);
  await reapplyBtsLocks(state);
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
    writeSgsnCfg(state.sgsnGtpLocalIp || '127.0.0.1', state.ggsnGtpBindIp || '127.0.0.5', hlrBindIp, state.ggsnApn || 'gprs');
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
  // module never writes osmo-msc.cfg itself, it only ever asked
  // sms-controller.ts (the file's sole owner) to include the block via
  // setMscMgwPeer() + a configureSms() call to make it take effect
  // immediately.
  //
  // Real incident, 2026-09-12: the configureSms() call here was briefly
  // removed (same night, earlier) because configureSms() used to fully
  // regenerate osmo-msc.cfg from its own simplified template, which
  // silently destroyed this host's real hand/VTY-maintained config (SS7
  // point-code, A5 ciphering, the mncc external socket path
  // osmo-sip-connector depends on, and the entire smpp/esme block incl.
  // live VectorCore MMSC + 2G-SMS-bridge passwords) on a real run — MMS,
  // the SMS bridge, and 2G ciphering all broke in one shot. That underlying
  // bug is now actually fixed (see vty-config-ownership.ts): configureSms()
  // upserts only the directives it owns and preserves everything else
  // byte-for-byte, verified against this exact file's real content. The
  // call is restored here now that it's genuinely safe.
  setMscMgwPeer(state.mscMgwBindIp);
  const { configureSms, readCurrentSmsConfig } = await import('./sms-controller');
  const currentSms = readCurrentSmsConfig();
  if (currentSms) {
    // SGs-SMS must already be configured for this to apply — same
    // precondition getMscVtyHost()/upsertSmppEsme() already enforce for
    // SMPP. A 2G module with no working SGs-SMS core underneath it isn't
    // meaningful (osmo-hlr/osmo-msc/osmo-stp are the shared foundation both
    // depend on), so this isn't a new requirement, just an explicit one.
    await configureSms(currentSms);
  }
}

// Extracted from what used to be POST /configure's own inline handler body
// (the route below is now a thin wrapper) so the IP Plan apply orchestrator
// can call this in-process for a single-field IP change, matching every
// other module's exported configureX() shape. Every field here is already
// optional/partial by the original handler's own design — each one falls
// back to the current saved value when omitted, so passing e.g. just
// `{ bscMgwBindIp: newIp }` alone is safe and changes nothing else.
export interface ConfigureGsmInput {
  bscMgwBindIp?: string; mscMgwBindIp?: string; mgwRtpBindIp?: string;
  gprsEnabled?: boolean; gprsMode?: 'gprs' | 'egprs'; sgsnGtpLocalIp?: string;
  ggsnGtpBindIp?: string; ggsnApn?: string; ggsnTunDevice?: string; ggsnPoolCidr?: string;
  ggsnDns1?: string; ggsnDns2?: string; gprsNat?: boolean; sgsnGbRemoteIp?: string;
  // Real, 2026-09-24 finding: appliedGprsEigrpCidr/appliedGprsNatCidr are
  // restored VERBATIM as part of .nms-gsm-bts-state.json (EXTRA_BACKUP_FILES),
  // so on a restore they already equal the freshly-computed desired value —
  // the diff-checks below see "no change" and never actually push the real
  // vtysh EIGRP network statement / iptables MASQUERADE rule onto the target
  // host, even though its live dataplane has nothing applied yet. Confirmed
  // live: production's own state file has a real non-empty
  // appliedGprsEigrpCidr right now, meaning THIS host would hit this
  // silently on its next restore. backup-restart-usecase.ts's gsm reapply
  // step passes this flag so the diff-checks below treat the restored state
  // as "nothing applied yet," forcing a real re-push.
  forceGprsReapply?: boolean;
}

export async function configureGsm(input: ConfigureGsmInput): Promise<{ eigrpApplied: string | null }> {
  const state = loadGsmState();
  state.bscMgwBindIp = input.bscMgwBindIp || state.bscMgwBindIp;
  state.mscMgwBindIp = input.mscMgwBindIp || state.mscMgwBindIp;
  state.mgwRtpBindIp = input.mgwRtpBindIp || state.mgwRtpBindIp;
  if (typeof input.gprsEnabled === 'boolean') state.gprsEnabled = input.gprsEnabled;
  if (input.gprsMode === 'gprs' || input.gprsMode === 'egprs') state.gprsMode = input.gprsMode;
  // The Setup-tab GPRS/EDGE toggle is the single control for data-service
  // type — apply it to every BTS here (enabled → chosen mode on all,
  // disabled → 'none' on all) so it isn't also buried per-BTS.
  const perBtsMode: BtsEntry['gprsMode'] = state.gprsEnabled ? (state.gprsMode ?? 'gprs') : 'none';
  for (const b of state.btsEntries) b.gprsMode = perBtsMode;
  state.sgsnGtpLocalIp = input.sgsnGtpLocalIp || state.sgsnGtpLocalIp;
  state.ggsnGtpBindIp  = sanitizeGgsnGtpIp(input.ggsnGtpBindIp || state.ggsnGtpBindIp);
  state.ggsnApn        = input.ggsnApn        || state.ggsnApn;
  state.ggsnTunDevice  = input.ggsnTunDevice  || state.ggsnTunDevice;
  state.ggsnPoolCidr   = input.ggsnPoolCidr   ?? state.ggsnPoolCidr;
  state.ggsnDns1       = input.ggsnDns1       || state.ggsnDns1;
  state.ggsnDns2       = input.ggsnDns2       || state.ggsnDns2;
  if (typeof input.gprsNat === 'boolean') state.gprsNat = input.gprsNat;
  // SGSN Gb address: honour an explicit value, else auto-derive this host's
  // IP on the same subnet as the first remote radio (so a nanoBTS's PCU
  // actually reaches the SGSN instead of dialling 127.0.0.1 into itself).
  state.sgsnGbRemoteIp = input.sgsnGbRemoteIp ?? state.sgsnGbRemoteIp ?? '';
  if (!state.sgsnGbRemoteIp && state.gprsEnabled) {
    state.sgsnGbRemoteIp = await deriveSgsnGbIp(state.btsEntries);
  }
  saveGsmState(state);
  await regenerateGsmConfigs(state);
  await nsenter('systemctl', ['restart', 'osmo-mgw']);
  await restartOsmoBsc(state);
  let eigrpApplied: string | null = null;
  const wantCidr = state.gprsEnabled && state.ggsnPoolCidr ? state.ggsnPoolCidr : null;
  if (wantCidr) {
    // Enable as well as restart, so GPRS/EDGE survives a reboot. Without this
    // a Configure brought it up for the current boot only (see /start's own
    // comment for the confirmed-live incident).
    await nsenter('systemctl', ['enable', 'osmo-sgsn']).catch(() => {});
    await nsenter('systemctl', ['enable', 'osmo-ggsn']).catch(() => {});
    await nsenter('systemctl', ['restart', 'osmo-sgsn']).catch(() => {});
    await nsenter('systemctl', ['restart', 'osmo-ggsn']).catch(() => {});
    // osmo-pcu only applies to a locally-run osmo-bts (virtual/trx) — a real
    // ip.access nanoBTS runs its own internal PCU and connects Gb straight
    // to the SGSN, so osmo-pcu would just crash-loop trying to reach a
    // /tmp/pcu_bts socket that never appears.
    const hasLocalBts = state.btsEntries.some(e => e.backend === 'virtual' || e.backend === 'trx');
    if (hasLocalBts) {
      await nsenter('systemctl', ['restart', 'osmo-pcu']).catch(() => {});
    } else {
      await nsenter('systemctl', ['disable', '--now', 'osmo-pcu']).catch(() => {});
    }
  } else {
    // Turning GPRS/EDGE off used to leave osmo-sgsn/osmo-ggsn running: there
    // was no off-path here at all, only the on-path above. So the page could
    // report GPRS disabled while both daemons kept serving the Gb link and the
    // APN — the inverse of the boot-persistence bug, and just as silent.
    // `disable --now` so it is off now AND stays off across a reboot.
    for (const svc of ['osmo-pcu', 'osmo-sgsn', 'osmo-ggsn']) {
      await nsenter('systemctl', ['disable', '--now', svc]).catch(() => {});
    }
  }
  // Make the GGSN pool reachable — no manual step. Two modes:
  //  - routed (default): auto-add an EIGRP `network` statement via the
  //    *incremental* live vtysh path (never `systemctl restart frr` — that's
  //    this project's confirmed eigrpd crash trigger, CLAUDE.md gotcha #7);
  //    the pool must be a disjoint sub-block of a routed subnet.
  //  - NAT: MASQUERADE the pool out instead; then it only has to not overlap
  //    Open5GS's own UE subnet.
  // Whichever mode is active, the other mode's leftover rule is torn down so
  // a toggle doesn't strand a stale route/masq.
  const dev = state.ggsnTunDevice || 'apn-gprs';
  const wantEigrp = wantCidr && !state.gprsNat ? wantCidr : null;
  const wantNat   = wantCidr &&  state.gprsNat ? wantCidr : null;
  // forceGprsReapply (see ConfigureGsmInput's comment) — treat the just-
  // restored "applied" bookkeeping as stale so the checks below fall through
  // to actually re-pushing the route/NAT rule, rather than seeing the
  // restored value already match the desired one and skipping entirely.
  const appliedEigrp = input.forceGprsReapply ? undefined : state.appliedGprsEigrpCidr;
  const appliedNat = input.forceGprsReapply ? undefined : state.appliedGprsNatCidr;
  // Real, 2026-09-24 finding (compounding the one above): these used to
  // persist state.appliedGprs{Eigrp,Nat}Cidr unconditionally, even when
  // applyGprsEigrpRoute()/applyGprsNat() actually failed (both swallow their
  // own errors and return a "...failed (apply manually): ..." STRING rather
  // than throwing) — silently desyncing the tracked "applied" state from
  // the real dataplane on ANY failure, restore or not. Now only persisted
  // on confirmed success.
  const FAILURE_PREFIX = /^(EIGRP|NAT) change failed/;
  if (appliedEigrp && appliedEigrp !== wantEigrp) {
    eigrpApplied = await applyGprsEigrpRoute(null, appliedEigrp, dev);
    if (!FAILURE_PREFIX.test(eigrpApplied)) { state.appliedGprsEigrpCidr = undefined; saveGsmState(state); }
  }
  if (appliedNat && appliedNat !== wantNat) {
    eigrpApplied = await applyGprsNat(null, appliedNat, dev);
    if (!FAILURE_PREFIX.test(eigrpApplied)) { state.appliedGprsNatCidr = undefined; saveGsmState(state); }
  }
  if (wantEigrp && wantEigrp !== appliedEigrp) {
    eigrpApplied = await applyGprsEigrpRoute(wantEigrp, null, dev);
    if (!FAILURE_PREFIX.test(eigrpApplied)) { state.appliedGprsEigrpCidr = wantEigrp; saveGsmState(state); }
  }
  if (wantNat && wantNat !== appliedNat) {
    eigrpApplied = await applyGprsNat(wantNat, null, dev);
    if (!FAILURE_PREFIX.test(eigrpApplied)) { state.appliedGprsNatCidr = wantNat; saveGsmState(state); }
  }
  // FORWARD ACCEPT for the GGSN tun — mode-independent (see helper).
  await ensureGprsForwardAccept(dev, !!state.gprsEnabled);
  return { eigrpApplied };
}

// Matches every other module's getXStaleness() naming/shape (secgw, vowifi,
// ims, mms, pstn all have one) — GSM never had one until now. No state
// boolean exists for "configured" here (unlike those modules), so this
// mirrors the exact file-existence heuristic GET /status has always used.
export async function getGsmStaleness(): Promise<{ installedOnDisk: boolean; configured: boolean }> {
  const [bscWhich, mgwWhich] = await Promise.all([
    nsenter('which', ['osmo-bsc']).catch(() => ({ stdout: '', stderr: '' })),
    nsenter('which', ['osmo-mgw']).catch(() => ({ stdout: '', stderr: '' })),
  ]);
  const installedOnDisk = bscWhich.stdout.trim().length > 0 && mgwWhich.stdout.trim().length > 0;
  const configured = fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-bsc.cfg`) && fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-mgw.cfg`);
  return { installedOnDisk, configured };
}

// ─── Router ─────────────────────────────────────────────────────────────────

// Runs an nsenter'd bash script to completion, streaming its output,
// resolving with its exit code — same shape as ims-controller.ts's own
// spawnStream. Module-level (not inside installGsm) so installGsm can stay a
// plain async function matching every other module's installX(write) shape.
function gsmSpawnStream(bashScript: string, write: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => write(d.toString()));
    child.stderr?.on('data', (d: Buffer) => write(d.toString()));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// Streaming apt install of osmo-bsc + osmo-mgw + osmo-bts (the latter
// bundles the virtual/trx backends both) plus osmo-sip-connector (SIP tab,
// built from source — no package exists for it). Extracted from the
// /install route so a bootstrap/restore orchestrator can call this
// in-process too, same reasoning as configureGsm() below.
export async function installGsm(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
  // osmo-bsc-ipaccess-utils provides /usr/bin/ipaccess-config — real,
  // confirmed-live gap (2026-09-24): every nanoBTS OML reprovision/drop
  // call (ipaccess-config -o/-r, this file's own reprovisionBts()/
  // dropOml()) shells out to this binary directly, but it was never in
  // this install list — "nsenter: failed to execute ipaccess-config: No
  // such file or directory" on any host whose apt cache doesn't happen to
  // have pulled it in as a transitive dependency of something else.
  const baseExitCode = await gsmSpawnStream(
    "DEBIAN_FRONTEND=noninteractive apt-get install -y osmo-bsc osmo-mgw osmo-bts osmo-bsc-meas-utils osmo-bsc-ipaccess-utils osmo-pcu osmo-sgsn osmo-ggsn 2>&1",
    write,
  );
  write(baseExitCode === 0
    ? '✅ osmo-bsc, osmo-mgw, osmo-bts, osmo-bsc-meas-utils, osmo-bsc-ipaccess-utils, osmo-pcu, osmo-sgsn, osmo-ggsn installed.'
    : `❌ Base 2G/GSM package install failed (exit ${baseExitCode}).`);

  // Built alongside the rest of the module on every Install so a
  // fresh/re-run install always ends up with it available — actually wiring
  // it into a real call path (the "remote" SIP target) happens on the SIP
  // tab's own Configure, not here.
  write('\n=== Building osmo-sip-connector (SIP tab) ===');
  const sipConnExitCode = await gsmSpawnStream(buildOsmoSipConnectorScript(), write);
  write(sipConnExitCode === 0
    ? '✅ osmo-sip-connector built.'
    : `⚠️ WARNING: osmo-sip-connector build FAILED (see errors above) — the SIP tab will show as not installed. Fix the underlying issue and re-run Install; the build is idempotent and will retry automatically.`);

  const success = baseExitCode === 0 && sipConnExitCode === 0;
  return success ? { success } : { success, error: `base exit ${baseExitCode}, sipconn exit ${sipConnExitCode}` };
}

// Real, 2026-09-24 finding: extracted from the /sip/configure route handler
// (matching the configureGsm/installGsm extraction pattern already used in
// this file) so backup-restart-usecase.ts's restore-reapply can call it
// too — regenerateGsmConfigs() (called by configureGsm() itself) never
// wrote osmo-sip-connector.cfg; GsmState.sip is correctly captured in
// .nms-gsm-bts-state.json, but nothing regenerated the actual config/unit/
// service from it during a restore's reapply. Currently masked whenever
// Asterisk-2G is also installed (wireIntoSipTabAndGoExternal() incidentally
// rewrites this same file as a side effect of ITS OWN unrelated Configure)
// — a deployment using the SIP tab standalone against a different remote
// (an external SIP trunk, P-CSCF, etc. — explicitly supported per this
// module's own design) would restore the state data but never get this
// daemon's config/unit regenerated or the service (re)started.
export async function configureGsmSip(input: { localIp?: string; localPort?: number; remoteHost?: string; remotePort?: number }): Promise<{ success: boolean; error?: string; sip?: NonNullable<GsmState['sip']> }> {
  const state = loadGsmState();
  const current = { ...GSM_STATE_DEFAULTS.sip, ...state.sip } as NonNullable<GsmState['sip']>;
  const remoteHost = (input.remoteHost ?? current.remoteHost ?? '').trim();
  if (!remoteHost) {
    return { success: false, error: 'remoteHost is required — this is the SIP peer 2G calls will be sent to/received from.' };
  }
  const sip = {
    localIp: (input.localIp || current.localIp || '0.0.0.0').trim(),
    localPort: Number(input.localPort ?? current.localPort ?? 5060),
    remoteHost,
    remotePort: Number(input.remotePort ?? current.remotePort ?? 5060),
  };
  state.sip = sip;
  saveGsmState(state);

  fs.mkdirSync('/proc/1/root/etc/osmocom', { recursive: true });
  writeHostCfg(`/proc/1/root${SIPCONN_CFG_PATH}`, osmoSipConnectorCfg(sip.localIp, sip.localPort, sip.remoteHost, sip.remotePort));
  fs.writeFileSync(`/proc/1/root${SIPCONN_UNIT_PATH}`, osmoSipConnectorSystemdUnit(), 'utf-8');
  await nsenter('systemctl', ['daemon-reload']);
  const wasActive = (await nsenter('systemctl', ['is-active', 'osmo-sip-connector']).catch(() => ({ stdout: '', stderr: '' }))).stdout.trim() === 'active';
  if (wasActive) {
    await nsenter('systemctl', ['restart', 'osmo-sip-connector']);
  } else {
    await nsenter('systemctl', ['enable', '--now', 'osmo-sip-connector']);
  }
  return { success: true, sip };
}

// Real, 2026-09-25 finding: /signal/overview did an inline `await
// bscVtyCommand('show lchan')` on every request to enrich each UE with its
// current BTS. VTY_RUN_COMMAND_SCRIPT's drain-loop design costs ~6.8s
// structurally (three ~2s "wait for silence" timeouts + two sleeps) no
// matter how little `show lchan` returns — every page load and every 15s
// poll from Gsm2gSignalPage.tsx was stalling on this alone. Moved to a
// background-refreshed cache instead, matching validation-controller.ts's
// startSessionMaxAgeSweep() idiom (setInterval with its own internal
// try/catch — the callback's rejection must never escape uncaught, since
// this project has no unhandledRejection handler anywhere and Node's
// default `--unhandled-rejections=throw` would crash-loop the ENTIRE
// backend, not just this feature, confirmed via adversarial review before
// this shipped). Gated on the SAME `configured` check createGsmRouter's own
// /status and /sip routes already use — createGsmRouter() is registered
// unconditionally on every NMS deployment (index.ts has no ENABLE_GSM_MODULE
// gate on any backend route; that flag is frontend-build-only, it only hides
// the nav item), so an ungated interval would hit osmo-bsc's VTY forever on
// every install, including the large majority that never enable 2G GSM.
let cachedBtsByImsi = new Map<string, number>();

function startBtsCacheRefresh(logger: pino.Logger): void {
  const refresh = async () => {
    const configured = fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-bsc.cfg`) && fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-mgw.cfg`);
    if (!configured) return; // no-op on the majority of deployments that never installed 2G GSM
    try {
      const lchanRaw = await bscVtyCommand('show lchan');
      // Reassign only on success — a transient VTY hiccup leaves the cache
      // at its last-known-good value instead of blanking `bts` for every UE
      // for a full cycle.
      cachedBtsByImsi = new Map(parseActiveLchans(lchanRaw).map(x => [x.imsi, x.bts]));
    } catch (err) {
      logger.debug({ err: String(err) }, 'gsm: BTS cache refresh failed (VTY unreachable) — keeping last-known cache');
    }
  };
  refresh(); // fire-and-forget so the cache isn't empty for the first 15s after a restart
  setInterval(refresh, 15_000); // matches Gsm2gSignalPage.tsx's own poll cadence
}

// Same reasoning as startBtsCacheRefresh's own gating comment — additive
// DDL only (IF NOT EXISTS), never touches osmo-meas-udp2db's own writes,
// but still gated + caught: meas.db may not exist at all on a host that
// never installed 2G GSM, and even once it does, a concurrent write from
// osmo-meas-udp2db could in principle return SQLITE_BUSY — this must fail
// loud-but-caught (logged), never silently and never uncaught.
//
// Real, 2026-09-25 finding: `path_loss` (what /signal/overview and
// /signal/history actually query) is osmo-meas-udp2db's own SQL VIEW, not
// a table — `CREATE VIEW path_loss AS SELECT ... FROM meas_rep, meas_rep_
// unidir AS ud_dl, meas_rep_unidir AS ud_ul WHERE ...` (confirmed live via
// `sqlite3 meas.db "SELECT sql FROM sqlite_master WHERE name='path_loss'"`).
// SQLite hard-rejects any attempt to index a view ("Error: in prepare,
// views may not be indexed") — the original `CREATE INDEX ... ON
// path_loss(...)` failed on every single call, 100% of the time, silently
// swallowed by this same catch block back when it logged at `debug`
// (invisible at this deployment's real LOG_LEVEL=info) — a permanent,
// total failure of the intended fix that a log-silence check alone could
// not distinguish from success. The view's own `id`/`imsi` columns pass
// straight through from `meas_rep` unaliased (no computed/renamed column),
// so the correct index target is the real underlying table, `meas_rep`.
// Real bug, confirmed live THREE times now (2026-09-25, 2026-09-26, and
// again 2026-09-28 despite the 2026-09-26 "fix" below): touching meas.db
// from the backend on every startup — even with the 2026-09-26 change to a
// read-only `SELECT ... sqlite_master` existence check instead of an
// unconditional `CREATE INDEX` — can still collide with osmo-meas-udp2db's
// own concurrent live INSERT and permanently wedge its prepared-statement
// handle (spams "SQL Error ... bad parameter or other API misuse" forever,
// fixed only by `systemctl restart osmo-meas-udp2db`). The 2026-09-26 fix's
// own premise was wrong: it assumed this database is in WAL mode (where a
// plain read needs only a SHARED lock, safe alongside a writer) — confirmed
// live 2026-09-28 via `PRAGMA journal_mode` that it's actually the SQLite
// default `delete` (rollback-journal) mode, where a reader CAN still
// contend with a writer's lock, so even a read-only query was never
// actually safe here. Real fix this time: a plain host-file sentinel,
// checked (and, the first time, written) via fs.existsSync/writeFileSync —
// NOT sqlite3 — so once the index is confirmed to exist even once, every
// future backend startup for the rest of this deployment's life never
// touches meas.db at all, eliminating the collision window entirely
// instead of just narrowing it again.
const MEAS_DB_INDEX_SENTINEL = `${HOST_OSMOCOM_DIR}/.meas-db-index-ensured`;
async function ensureMeasDbIndex(logger: pino.Logger): Promise<void> {
  const configured = fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-bsc.cfg`) && fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-mgw.cfg`);
  if (!configured) return;
  if (fs.existsSync(MEAS_DB_INDEX_SENTINEL)) return;
  try {
    const { stdout } = await nsenter('sqlite3', [HOST_MEAS_DB, "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_meas_rep_imsi_id';"]);
    if (stdout.trim() === 'idx_meas_rep_imsi_id') {
      fs.writeFileSync(MEAS_DB_INDEX_SENTINEL, new Date().toISOString());
      return;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'gsm: meas.db index existence check failed — skipping this startup, will retry on the next one');
    return;
  }
  try {
    await nsenter('sqlite3', [HOST_MEAS_DB, 'CREATE INDEX IF NOT EXISTS idx_meas_rep_imsi_id ON meas_rep(imsi, id);']);
    fs.writeFileSync(MEAS_DB_INDEX_SENTINEL, new Date().toISOString());
  } catch (err) {
    logger.warn({ err: String(err) }, 'gsm: meas.db index creation failed — /signal/overview and /signal/history will keep doing full table scans until this succeeds on a future restart');
  }
}

// Hoisted to module scope, 2026-09-25, for gsm-metrics.ts's own cache
// refresh below to reuse — confirmed pure (no closure dependency on
// anything only available inside createGsmRouter()) before hoisting.
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

export interface CachedGsmSignalSample {
  imsi: string; timestamp: string;
  msPowerDbm: number | null; timingAdvance: number | null;
  ulRxLevDbm: number | null; ulRxQual: number | null;
  dlRxLevDbm: number | null; dlRxQual: number | null;
  bsPowerDbm: number | null; ulPathLossDb: number | null; dlPathLossDb: number | null;
  bts: number;
  nickname: string | null; msisdn: string | null;
}

let cachedGsmSignalSamples: CachedGsmSignalSample[] = [];

// Real, 2026-09-25 finding (adversarial review, item 3 of the Grafana-
// dashboards task): filtering to IMSIs currently present in cachedBtsByImsi
// (osmo-bsc's own live `show lchan` output, refreshed on the identical 15s
// cadence above) is what actually makes an idle/detached UE's reading
// disappear from the exported gauges once gsm-metrics.ts's collect() calls
// .reset() before repopulating. path_loss's own query has NO time bound —
// it returns the latest-ever row for every IMSI that has EVER produced a
// measurement report, so without this filter a UE that went idle days ago
// would keep re-appearing as if freshly measured, forever, defeating the
// whole point of reset-then-repopulate (a stale-but-plausible number with
// no way to tell it's stale — quietly worse than the panel just being
// blank). Same gating/try-catch/fire-then-interval shape as
// startBtsCacheRefresh above — see its own comment for why.
function startGsmSignalCacheRefresh(logger: pino.Logger, subscriberRepo: ISubscriberRepository): void {
  const refresh = async () => {
    const configured = fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-bsc.cfg`) && fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-mgw.cfg`);
    if (!configured) return;
    try {
      const { stdout } = await nsenter('sqlite3', [
        HOST_MEAS_DB,
        `SELECT ${MEAS_ROW_COLUMNS} FROM path_loss p ` +
        `INNER JOIN (SELECT imsi, MAX(id) AS max_id FROM path_loss WHERE imsi IS NOT NULL AND imsi != '' GROUP BY imsi) latest ` +
        `ON p.imsi = latest.imsi AND p.id = latest.max_id ORDER BY p.imsi;`,
      ]);
      const rows = stdout.split('\n').map(l => l.trim()).filter(Boolean).map(parseMeasRow);
      const allSubs = await subscriberRepo.findAllFull();
      const byImsi = new Map(allSubs.map(s => [s.imsi, s]));
      // Real bug, found live 2026-09-26: gating on `cachedBtsByImsi.has()`
      // (show lchan's own occupancy snapshot, refreshed on its own
      // independent 15s interval) missed real, fresh measurements from 2 of
      // 3 actually-online UEs — a dedicated channel (SDCCH signaling, a
      // brief Location Update, etc.) can come and go well within one
      // show-lchan poll interval, so cross-referencing occupancy AT READ
      // TIME systematically undercounts anything shorter than a sustained
      // voice call. The staleness problem this filter was actually meant to
      // solve (see the comment this replaced) is about the AGE of the
      // reading itself, not whether some OTHER, independently-timed cache
      // currently agrees the UE is mid-session — so gate on the row's own
      // timestamp instead.
      // Real, live-observed correction, tuned THREE times now — the first
      // two (90s, then 5min, then 15min) were all guesses padded off a
      // single spot-check gap, and all three were wrong for the same
      // reason: an idle-but-attached 2G UE doesn't report continuously, so
      // any one-off "biggest gap I've seen" observation understates the
      // real period. Root-caused properly 2026-09-26 by pulling several
      // hours of REAL timestamps per IMSI instead of spot-checking: all 3
      // real IMSIs on this deployment report at a precise, consistent
      // ~30-minute interval (e.g. 14:04:13, 14:34:16, 15:04:19, 15:34:21,
      // ...) — a periodic Location/Routing-Area-Update timer, not random
      // idle burstiness as earlier comments here assumed. The prior
      // 15-minute window was almost exactly HALF that real period, so
      // every UE was visible for the first half of each cycle and
      // invisible for the second half, forever — a real, reported,
      // perfectly periodic "gap that repeats at the same interval" in
      // every timeseries panel, and (since all 3 IMSIs' cycles land
      // within a few minutes of each other) a real, empty "Per-UE Current
      // 2G Signal" table for a chunk of every half hour. 40 minutes gives
      // the confirmed ~30-minute period a real, deliberate margin (not
      // another one-off pad) while still making a truly detached UE's
      // last-ever reading disappear within well under an hour.
      //
      // Still a real, inherent tradeoff: this window is now grounded in a
      // properly-measured period rather than a guess, but a network with a
      // DIFFERENT periodic-update interval configured would need this
      // re-measured, not assumed. See memory gsm_2g_signal_dashboard_progress
      // for the full history if this needs revisiting again.
      const FRESHNESS_WINDOW_MS = 40 * 60_000;
      const nowMs = Date.now();
      cachedGsmSignalSamples = rows
        .filter(r => {
          const ts = Date.parse(`${r.timestamp.replace(' ', 'T')}Z`);
          return Number.isFinite(ts) && (nowMs - ts) <= FRESHNESS_WINDOW_MS;
        })
        .map(r => {
          const sub = byImsi.get(r.imsi);
          return {
            ...r,
            // Best-effort BTS label only now, not the staleness gate —
            // falls back to 0 (this deployment's only configured BTS, and
            // a reasonable default on any host rather than dropping an
            // otherwise-fresh, real reading just because the separate
            // occupancy cache hasn't caught up yet).
            bts: cachedBtsByImsi.get(r.imsi) ?? 0,
            nickname: sub?.nickname ?? null,
            msisdn: sub?.msisdn?.[0] ?? null,
          };
        });
    } catch (err) {
      logger.debug({ err: String(err) }, 'gsm: signal-sample cache refresh failed (meas.db unreachable) — keeping last-known cache');
    }
  };
  refresh();
  setInterval(refresh, 15_000);
}

export function getCachedGsmSignalSamples(): CachedGsmSignalSample[] {
  return cachedGsmSignalSamples;
}

// ── GPRS/EDGE data traffic (Traffic History unification) ───────────────────
//
// 2G subscriber data traffic does NOT go through Open5GS's own SMF/UPF —
// osmo-sgsn + osmo-ggsn is a completely separate GGSN implementation with its
// own IP pool and its own tun device. osmo-sgsn's own VTY already does
// per-subscriber byte accounting AND carries cell attribution in the same
// place (`show mm-context all pdp`) — confirmed live 2026-09-26, real output:
//
//   MM Context for IMSI <imsi>, ...
//     GMM State: ..., Routeing Area: ..., Cell ID: <n>
//     SGSN MM Context Statistics:            <- this subscriber's OWN cumulative
//       User Data  Bytes    ( In): ...          total across ALL its PDP contexts
//       User Data  Bytes    (Out): ...           combined — NOT used below
//     PDP Context IMSI: <imsi>, SAPI: ..., NSAPI: ..., TI: ...
//       APN: ...
//       PDP Address: IPv4 <ip>
//      SGSN PDP Context Statistics:          <- THIS one PDP context's own bytes
//       User Data  Bytes    ( In): ...           — used below, summed per IMSI
//       User Data  Bytes    (Out): ...            across however many PDP
//                                                  contexts that IMSI holds
//
// Only the inner, per-PDP-context numbers are used — summed per IMSI — so a
// subscriber holding more than one concurrent APN is attributed correctly
// instead of relying on the outer MM-level total (which only coincidentally
// matches in the common single-PDP-context case). A GPRS-attached subscriber
// with ZERO active PDP contexts is a real, valid, non-error VTY shape
// (confirmed live) and is correctly skipped — nothing to report, not a
// fabricated zero.
//
// (In)/(Out) are from the SGSN's own point of view on the Gb interface: data
// SGSN receives FROM the MS is uplink (In → upBytes); data SGSN sends TO the
// MS is downlink (Out → downBytes) — same up/down convention already used by
// every other traffic metric in this codebase.
const SGSN_VTY_PORT = 4245;

export interface GprsSubscriberTraffic {
  imsi: string;
  cellId: number | null;
  upBytes: number;
  downBytes: number;
}

export function parseMmContextPdp(raw: string): GprsSubscriberTraffic[] {
  const results: GprsSubscriberTraffic[] = [];
  const blocks = raw.split(/(?=^MM Context for IMSI )/m).filter(b => b.trim().startsWith('MM Context for IMSI'));
  for (const block of blocks) {
    const imsiMatch = block.match(/^MM Context for IMSI (\d+)/);
    if (!imsiMatch) continue;
    const imsi = imsiMatch[1];
    const cellMatch = block.match(/Cell ID:\s*(\d+)/);
    const cellId = cellMatch ? parseInt(cellMatch[1], 10) : null;

    // Drop the first chunk (the MM-context header + its own outer
    // "SGSN MM Context Statistics:" block) — only real per-PDP-context
    // chunks (one per concurrent APN) remain.
    const pdpBlocks = block.split(/(?=^\s*PDP Context IMSI:)/m).slice(1);
    let upBytes = 0;
    let downBytes = 0;
    let hasPdp = false;
    for (const pdpBlock of pdpBlocks) {
      const inMatch = pdpBlock.match(/User Data\s+Bytes\s+\(\s*In\):\s*(\d+)/);
      const outMatch = pdpBlock.match(/User Data\s+Bytes\s+\(Out\):\s*(\d+)/);
      if (inMatch && outMatch) {
        hasPdp = true;
        upBytes += parseInt(inMatch[1], 10);
        downBytes += parseInt(outMatch[1], 10);
      }
    }
    if (hasPdp) results.push({ imsi, cellId, upBytes, downBytes });
  }
  return results;
}

// Resolves an SGSN-reported Cell ID (BtsEntry.cellIdentity, an
// operator-set BSSGP/RA value) to the array-INDEX bts numbering the
// existing 2G signal gauges use (osmo-bsc's own "BTS N" numbering from
// `show lchan`, matching `btsBlock()`'s own array index at generation
// time) — these are two different number spaces in this codebase and must
// not be conflated.
function resolveBtsIndexByCellId(cellId: number | null, state: GsmState): number | null {
  if (cellId === null) return null;
  const idx = state.btsEntries.findIndex(e => e.cellIdentity === cellId);
  return idx >= 0 ? idx : null;
}

let cachedGprsTrafficByImsi = new Map<string, GprsSubscriberTraffic>();

function startGprsTrafficCacheRefresh(logger: pino.Logger): void {
  const refresh = async () => {
    const configured = fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-sgsn.cfg`) && fs.existsSync(`${HOST_OSMOCOM_DIR}/osmo-ggsn.cfg`);
    if (!configured) return;
    try {
      const raw = await osmoVtyCommand(SGSN_VTY_PORT, 'show mm-context all pdp');
      const rows = parseMmContextPdp(raw);
      cachedGprsTrafficByImsi = new Map(rows.map(r => [r.imsi, r]));
    } catch (err) {
      logger.debug({ err: String(err) }, 'gsm: GPRS traffic cache refresh failed (SGSN VTY unreachable) — keeping last-known cache');
    }
  };
  refresh();
  setInterval(refresh, 15_000);
}

/** Public: per-subscriber 2G data traffic, with BTS resolved to the same array-index numbering the signal gauges use. Used by both the Prometheus exporter (gsm2g-traffic-metrics.ts) and the shared radio-info gauge (radio-info-metrics.ts). */
export function getCachedGprsTrafficByImsi(): Array<GprsSubscriberTraffic & { bts: number | null; radioName: string | null }> {
  const state = loadGsmState();
  return Array.from(cachedGprsTrafficByImsi.values()).map(r => {
    const bts = resolveBtsIndexByCellId(r.cellId, state);
    return { ...r, bts, radioName: bts !== null ? state.btsEntries[bts]?.name ?? null : null };
  });
}

/** Public: GGSN's own tun-device aggregate byte counters, for the `internet` APN's data plane — mirrors gtp-bandwidth.ts's own UPF tun-device read exactly, just pointed at the GGSN's device instead. Deliberately a DISTINCT metric name from the 4G/5G open5gs_gtp_* family when exported (see gsm2g-traffic-metrics.ts) — GGSN's APN and Open5GS's DNN are both literally named "internet" on this deployment, and a prom-client Gauge keyed on an identical label tuple from two independent collect() sources would have one silently overwrite the other on whichever scrape ran last, not "sum" — a same-name reuse would be strictly worse than a name collision, not just redundant. */
export async function getGgsnTunCounters(): Promise<{ apn: string; rxBytes: number; txBytes: number } | null> {
  const state = loadGsmState();
  const apn = state.ggsnApn || 'gprs';
  const dev = state.ggsnTunDevice || 'apn-gprs';
  try {
    const [rxRaw, txRaw] = await Promise.all([
      fs.promises.readFile(`/proc/1/root/sys/class/net/${dev}/statistics/rx_bytes`, 'utf-8'),
      fs.promises.readFile(`/proc/1/root/sys/class/net/${dev}/statistics/tx_bytes`, 'utf-8'),
    ]);
    const rxBytes = parseInt(rxRaw.trim(), 10);
    const txBytes = parseInt(txRaw.trim(), 10);
    if (isNaN(rxBytes) || isNaN(txBytes)) return null;
    return { apn, rxBytes, txBytes };
  } catch {
    // Device not present (GGSN not installed/configured, or APN removed) —
    // expected churn on a deployment without 2G GPRS enabled, not an error.
    return null;
  }
}

export function createGsmRouter(subscriberRepo: ISubscriberRepository, logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();
  startBtsCacheRefresh(logger);
  ensureMeasDbIndex(logger);
  startGsmSignalCacheRefresh(logger, subscriberRepo);
  startGprsTrafficCacheRefresh(logger);

  // GET /api/gsm/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const [bscWhich, mgwWhich, btsWhich, sgsnWhich, sipConnBuild, sipConnActive] = await Promise.all([
        nsenter('which', ['osmo-bsc']).catch(() => ({ stdout: '', stderr: '' })),
        nsenter('which', ['osmo-mgw']).catch(() => ({ stdout: '', stderr: '' })),
        nsenter('which', ['osmo-bts-virtual']).catch(() => ({ stdout: '', stderr: '' })),
        nsenter('which', ['osmo-sgsn']).catch(() => ({ stdout: '', stderr: '' })),
        verifyOsmoSipConnectorBuild(),
        nsenter('systemctl', ['is-active', 'osmo-sip-connector']).catch(() => ({ stdout: '', stderr: '' })),
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
      const sip = { ...GSM_STATE_DEFAULTS.sip, ...state.sip } as NonNullable<GsmState['sip']>;
      const { getMscMnccMode } = await import('./sms-controller');
      const sipStatus = {
        installedOnDisk: sipConnBuild.installed,
        version: sipConnBuild.version,
        configured: fs.existsSync(`/proc/1/root${SIPCONN_CFG_PATH}`),
        running: sipConnActive.stdout.trim() === 'active',
        localIp: sip.localIp,
        localPort: sip.localPort,
        remoteHost: sip.remoteHost,
        remotePort: sip.remotePort,
        mnccSocketPath: SIPCONN_MNCC_SOCKET_PATH,
        // Live off osmo-msc.cfg itself, not cached state — see getMscMnccMode().
        mnccMode: getMscMnccMode(),
      };

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
        sip: sipStatus,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'gsm status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/gsm/install — streaming apt install of osmo-bsc + osmo-mgw +
  // osmo-bts (the latter bundles the virtual/trx backends both — see the
  // plan's Phase 0/1 note on why one package covers both). Thin wrapper —
  // see installGsm() above for the actual logic, extracted so a
  // bootstrap/restore orchestrator can call it in-process too.
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const result = await installGsm(write);
    await auditLogger.log({ action: 'gsm_install', user, details: result.error ?? 'ok', success: result.success });
    res.end();
  });

  // POST /api/gsm/configure — Body: { bscMgwBindIp?, mscMgwBindIp?, mgwRtpBindIp?, ... }
  // Thin wrapper — see configureGsm() above for the actual logic, extracted
  // so the IP Plan apply orchestrator can call it in-process too.
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { eigrpApplied } = await configureGsm(req.body as ConfigureGsmInput);
      const state = loadGsmState();
      await auditLogger.log({ action: 'gsm_configure', user, details: `osmo-bsc/osmo-mgw configured, gprsEnabled=${!!state.gprsEnabled} nat=${!!state.gprsNat}`, success: true });
      res.json({ success: true, eigrpApplied });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_configure', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // SIP tab (osmo-sip-connector) — deliberately its own small lifecycle,
  // separate from the main /configure above, rather than folded into
  // regenerateGsmConfigs(). Two reasons: (1) the "remote" SIP target is
  // free-form operator input with no relationship to BTS/GPRS state, so
  // there's nothing to auto-derive or regenerate it from; (2) an unrelated
  // BTS/GPRS Configure save should never silently rewrite or restart a
  // separately-managed SIP daemon the operator is mid-way through wiring up.
  // POST /api/gsm/sip/configure — Body: { localIp, localPort, remoteHost, remotePort }
  router.post('/sip/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const result = await configureGsmSip(req.body);
      if (!result.success) {
        res.status(400).json(result);
        return;
      }
      // Deliberately does NOT touch osmo-msc's MNCC mode — that's an
      // explicit, separate operator choice (POST /sip/mncc-mode below), not
      // an automatic side effect of editing the connector's own local/remote
      // address. Configuring this daemon and actually routing live calls to
      // it are two different decisions.
      await auditLogger.log({ action: 'gsm_sip_configure', user, details: `local=${result.sip!.localIp}:${result.sip!.localPort} remote=${result.sip!.remoteHost}:${result.sip!.remotePort}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_sip_configure', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/sip/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', 'osmo-sip-connector']);
      await auditLogger.log({ action: 'gsm_sip_start', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/sip/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', 'osmo-sip-connector']);
      // Deliberately does NOT touch osmo-msc's MNCC mode — if the operator
      // has explicitly selected External, stopping the daemon here doesn't
      // silently switch that back (they may be about to restart it). GET
      // /status's mnccMode + running fields together are enough for the UI
      // to show a clear "External selected but connector isn't running —
      // calls will fail" warning instead of us guessing their intent.
      await auditLogger.log({ action: 'gsm_sip_stop', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/gsm/sip/mncc-mode — Body: { mode: 'internal' | 'external' }
  // The one explicit place call-routing mode changes — see setMscMnccMode()'s
  // comment for the full incident this replaced (a leftover `mncc external`
  // silently breaking plain 2G<->2G calling with no operator-visible cause).
  router.post('/sip/mncc-mode', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const mode = req.body?.mode;
    if (mode !== 'internal' && mode !== 'external') {
      res.status(400).json({ success: false, error: "mode must be 'internal' or 'external'" });
      return;
    }
    try {
      const { setMscMnccMode } = await import('./sms-controller');
      await setMscMnccMode(mode, SIPCONN_MNCC_SOCKET_PATH);
      await auditLogger.log({ action: 'gsm_sip_mncc_mode', user, details: mode, success: true });
      res.json({ success: true, mode });
    } catch (err) {
      await auditLogger.log({ action: 'gsm_sip_mncc_mode', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/sip/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', 'osmo-sip-connector']);
      await auditLogger.log({ action: 'gsm_sip_restart', user, details: '', success: true });
      res.json({ success: true });
    } catch (err) {
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
    // Real, confirmed-live bug (2026-09-24): every call site passes
    // state.bscMgwBindIp as the "own IP" argument, but that field defaults
    // to 127.0.0.1 (it's the MGCP/MGW control-plane bind, unrelated to OML)
    // — telling a REAL remote radio to send OML to loopback, which it
    // obviously can't reach ("No route to host", confirmed live against a
    // real ip.access nanoBTS on the same /24). -o just needs to be any real
    // host IP the radio's own subnet can reach — osmo-bsc's own OML/IPA
    // listener has no bind-IP restriction (binds all interfaces), so this
    // doesn't need to match anything else. Prefer the host's real main
    // (default-route) interface IP; only fall back to the passed-in
    // bscOmlIp if that can't be detected for some reason.
    let ownIp = bscOmlIp;
    try {
      const main = await detectMainInterface();
      if (main?.ip) ownIp = main.ip;
    } catch { /* fall back to bscOmlIp below */ }
    await nsenter('ipaccess-config', ['-o', ownIp, '-r', remoteIp], 20000);
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

  // GET /api/gsm/signal/overview — latest 2G measurement sample per IMSI.
  // Real bug, found live 2026-10-03: this handler used to run its own
  // separate, unfiltered `path_loss` query (duplicating startGsmSignalCacheRefresh's
  // own logic, including the same nickname/msisdn join) instead of reusing
  // getCachedGsmSignalSamples() — and unlike that cache, it never applied
  // the 40-minute FRESHNESS_WINDOW_MS staleness filter (see that function's
  // own extensive comment: a UE's LAST-EVER `path_loss` row has no time
  // bound at all, so a subscriber that was only ever measured once, weeks
  // ago, kept showing up here — and therefore in the Dashboard's "2G active"
  // count, the GSM Signal page, and the RAN page's A-interface section — as
  // if it were currently active, forever. Fixed by reusing the same
  // already-correct, already-measured cache every other "is this 2G UE
  // currently active" consumer in this file relies on, instead of a second,
  // subtly-different implementation of the same query.
  router.get('/signal/overview', async (_req: Request, res: Response) => {
    res.json({ success: true, samples: getCachedGsmSignalSamples() });
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

  // GET /api/gsm/pdp-contexts — live IMSI<->IP mapping for active GPRS/EDGE
  // data sessions, straight from osmo-ggsn (see parsePdpContexts' comment).
  // Same graceful-empty-on-failure shape as /signal/history right above —
  // GPRS simply being disabled (osmo-ggsn not running) is a routine state
  // here, not an error worth a 500.
  router.get('/pdp-contexts', async (_req: Request, res: Response) => {
    try {
      const raw = await osmoVtyCommand(GGSN_VTY_PORT, `show pdp-context ggsn ${GGSN_NAME}`);
      res.json({ success: true, contexts: parsePdpContexts(raw) });
    } catch {
      res.json({ success: true, contexts: [] });
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
      await restartOsmoBsc(state).catch(() => {});
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
      await restartOsmoBsc(state).catch(() => {});

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

  // POST /api/gsm/bts/:id/block | /unblock — administratively lock/unlock a
  // BTS via osmo-bsc's own OML Administrative State. Live-verified
  // 2026-09-12/13 against the real running osmo-bsc, but never actually
  // verified via this feature's own UI until 2026-09-21 — turned out to
  // still be broken in a different way (see below). This is an osmo-bsc-side
  // state, not a radio-backend one, so unlike /restart above it applies
  // uniformly to virtual/trx/real units. The flag is persisted in state (see
  // BtsEntry.blocked's comment) and reapplied by reapplyBtsLocks() after
  // every osmo-bsc restart, since osmo-bsc itself forgets it on restart.
  //
  // NOT `change-adm-state locked` at the "(oml)" pseudo-node (entered via
  // `bts <idx> oml class bts instance <idx> 255 255`) — that's what this
  // used to do, targeting NM object class "bts" directly. Real, confirmed
  // live incident (2026-09-13): the object instance triple originally used
  // was (idx, 0, 0) instead of the correct (idx, 255, 255) — a real nanoBTS
  // NACK'd (idx,0,0) with "Object Instance unknown", and osmo-bsc's own
  // reaction to ANY change-adm-state NACK is to immediately drop the whole
  // OML link. That got fixed to (idx,255,255) and the crash stopped — but a
  // real live test through this bulk-block feature on 2026-09-21 found the
  // command *still* doesn't work: it's accepted with zero VTY error and
  // zero journalctl error, but osmo-bsc's own nm_bts_fsm.c runs a background
  // reconciliation loop (configure_loop()) that silently re-unlocks any
  // "bts"-class object it considers should be in service, with no guard
  // against a manual lock — confirmed by locking, then re-reading `show bts
  // N` immediately and repeatedly over 8+ seconds: Admin state never left
  // 'Unlocked', and OML Link's own uptime counter never reset (so it's not
  // an OML reconnect race either — the request is just overridden in
  // place). The NACK/override itself never surfaces as VTY command-line
  // error text or a journalctl line (only the *symptom* — the state
  // silently not changing — is observable), which is exactly why this
  // needs the read-back-and-compare verify step below rather than trusting
  // a clean VTY prompt — see CLAUDE.md's "Verify, don't trust 'success'".
  //
  // The real, sticky mechanism (confirmed by reading osmo-bsc 1.9.0's own
  // source — src/osmo-bsc/bts_trx_vty.c's cfg_trx_rf_locked_cmd +
  // src/osmo-bsc/bts_trx.c's gsm_trx_lock_rf()): `rf_locked (0|1)` is a
  // config-tree command on the TRX object specifically (configure terminal
  // -> network -> bts N -> trx N), which sets trx->mo.force_rf_lock — the
  // one guard nm_rcarrier_fsm.c's own configure_loop() checks before
  // auto-re-unlocking. CMD_ATTR_IMMEDIATE in the source confirms it takes
  // effect live, no `write memory`/restart needed — and this deliberately
  // never calls `write memory` either, since force_rf_lock isn't emitted by
  // this project's own osmo-bsc.cfg template regen, so persisting it
  // wouldn't survive a Configure anyway; this NMS's own state +
  // reapplyBtsLocks() (below) is already the source of truth for "should
  // this BTS be locked", same as it always was for the old command.
  //
  // Verify target changes too: `show bts N` never had a per-TRX NM State
  // line at all (only BTS-level "NM State:" and "Site Mgr NM State:", both
  // unrelated to force_rf_lock) — `show trx N 0` is what actually prints
  // the TRX's own "Radio Carrier NM State: Oper 'x', Admin 'y', Avail 'z'",
  // which parseBtsLinkStatus's existing regex still matches unmodified
  // (unanchored, and "Radio Carrier NM State:" prints before "Baseband
  // Transceiver NM State:" in trx_dump_vty(), so the first match is still
  // the right one). Only tests trx 0 — every BTS this project manages is
  // single-TRX; a multi-TRX BTS would need every trx index locked.
  type BtsBlockResult =
    | { success: true; name: string; status: BtsLinkStatus }
    | { success: false; error: string; status?: BtsLinkStatus; name?: string };

  // Core of the single-BTS block/unblock route below, pulled out so the new
  // bulk /bts/block-all route can drive the same real, verify-after-command
  // osmo-bsc call per entry rather than re-deriving it. Always re-reads state
  // fresh (matching this codebase's established "never trust a caller's
  // stale snapshot" convention) rather than taking `state`/`entry` as params.
  const blockBtsByIdx = async (idx: number, blocked: boolean, user: string): Promise<BtsBlockResult> => {
    const state = loadGsmState();
    const entry = state.btsEntries[idx];
    if (!entry) return { success: false, error: 'BTS entry not found' };
    const action = blocked ? 'gsm_bts_block' : 'gsm_bts_unblock';
    try {
      await bscVtyCommand([
        'configure terminal',
        'network',
        `bts ${idx}`,
        'trx 0',
        `rf_locked ${blocked ? '1' : '0'}`,
        'end',
      ]);
      // adminState/operState/availState come from the TRX-level read (what
      // rf_locked actually controls); omlConnected/rslConnected come from
      // the BTS-level read — `show trx N 0`'s own text has neither field.
      const trxStatus = parseBtsLinkStatus(await bscVtyCommand(`show trx ${idx} 0`));
      const btsStatus = parseBtsLinkStatus(await bscVtyCommand(`show bts ${idx}`));
      const status: BtsLinkStatus = {
        ...btsStatus,
        adminState: trxStatus.adminState, operState: trxStatus.operState, availState: trxStatus.availState,
      };
      const expected = blocked ? 'Locked' : 'Unlocked';
      if (status.adminState !== expected) {
        await auditLogger.log({ action, user, details: `verify failed: adminState=${status.adminState}, expected ${expected}`, success: false });
        return {
          success: false,
          error: `osmo-bsc reports '${status.adminState}', not ${expected}, after the command — not applied as intended. Don't retry blindly: check the BTS's link status and osmo-bsc's own journalctl first, since a stuck state here can mean the OML link needs a clean osmo-bsc restart to recover.`,
          status, name: entry.name,
        };
      }
      state.btsEntries[idx].blocked = blocked;
      saveGsmState(state);
      await auditLogger.log({ action, user, details: entry.name, success: true });
      return { success: true, name: entry.name, status };
    } catch (err) {
      await auditLogger.log({ action, user, details: String(err), success: false });
      return { success: false, error: String(err), name: entry.name };
    }
  };

  const setBtsBlocked = (blocked: boolean) => async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadGsmState();
    const idx = state.btsEntries.findIndex(e => e.id === req.params.id);
    if (idx === -1) { res.status(404).json({ success: false, error: 'BTS entry not found' }); return; }
    const result = await blockBtsByIdx(idx, blocked, user);
    if (!result.success) {
      res.status(result.status ? 502 : 500).json({ success: false, error: result.error, ...(result.status ?? {}) });
      return;
    }
    res.json({ success: true, ...result.status });
  };
  router.post('/bts/:id/block', requireAdmin, setBtsBlocked(true));
  router.post('/bts/:id/unblock', requireAdmin, setBtsBlocked(false));

  // POST /api/gsm/bts/block-all — bulk-lock every configured BTS at once, the
  // 2G equivalent of radio-block's/gnb-block's 4G/5G "Block RAN" kill switch.
  // Deliberately NOT the same mechanism: those are mild, host-only nftables
  // rules that never touch the radio itself; this reuses the SAME real
  // osmo-bsc OML admin-lock as the single-BTS Block button above — every
  // camped UE on every BTS drops immediately and each radio goes off the air
  // (see Gsm2GBlockButton's own comment in RANPage.tsx for why the two are
  // deliberately never visually conflated). Runs sequentially, not in
  // parallel — each call already does its own command+verify round-trip
  // against the same shared osmo-bsc VTY session. Skips entries already
  // blocked rather than re-issuing the lock command, since the documented
  // history here (see blockBtsByIdx's home comment above) is real hardware
  // NACKing a bad command, not a stale flag — no reason to risk a redundant
  // command against a BTS that's already confirmed locked.
  router.post('/bts/block-all', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const state = loadGsmState();
    const results: { id: string; name: string; success: boolean; error?: string }[] = [];
    for (let idx = 0; idx < state.btsEntries.length; idx++) {
      const entry = state.btsEntries[idx];
      if (entry.blocked) { results.push({ id: entry.id, name: entry.name, success: true }); continue; }
      const result = await blockBtsByIdx(idx, true, user);
      results.push({ id: entry.id, name: entry.name, success: result.success, error: result.success ? undefined : result.error });
    }
    const allOk = results.every(r => r.success);
    res.status(allOk ? 200 : 207).json({ success: allOk, results });
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
      await restartOsmoBsc(state).catch(() => {});
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
  // Real gap found live 2026-09-12: this previously omitted GPRS
  // (osmo-sgsn/osmo-ggsn/osmo-pcu) and osmo-sip-connector entirely, so
  // Start/Stop/Restart and Uninstall's own stop-everything pass silently
  // left them running/orphaned. Both are conditional on the state that
  // actually turns them on, same as the BTS-backend service already was.
  const lifecycleServices = (state: GsmState): string[] => [
    'osmo-mgw', 'osmo-bsc',
    ...state.btsEntries.map(e => btsBackendServiceName(e.backend)).filter((s): s is string => !!s),
    ...(state.gprsEnabled ? ['osmo-sgsn', 'osmo-ggsn'] : []),
    ...(state.gprsEnabled && state.btsEntries.some(e => e.backend === 'virtual' || e.backend === 'trx') ? ['osmo-pcu'] : []),
  ];
  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadGsmState();
      // `enable --now`, not plain `start`. Nothing in this module ever enabled
      // these units, so they only ran until the next reboot — and the 2G/3G
      // stack's apparent boot survival was entirely accidental: osmo-hnbgw and
      // osmo-sip-connector happen to be enabled and pull osmo-stp/osmo-msc/
      // osmo-bsc/osmo-mgw in as dependencies. osmo-sgsn/osmo-ggsn are in
      // nobody's dependency chain, so GPRS/EDGE silently stayed down after the
      // 2026-10-06 reboot while this module's own state still said
      // gprsEnabled: true — confirmed live, with no journal entries at all for
      // either unit. Enabling makes boot survival explicit and not dependent on
      // whether some other optional module happens to be installed.
      for (const svc of lifecycleServices(state)) await nsenter('systemctl', ['enable', '--now', svc]);
      await reapplyBtsLocks(state);
      await auditLogger.log({ action: 'gsm_start', user, details: 'gsm services started + enabled at boot', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      // `disable --now` is the counterpart to /start's `enable --now`: a plain
      // `stop` against an enabled unit would come straight back on the next
      // reboot, so "stopped" would silently not mean stopped.
      for (const svc of lifecycleServices(loadGsmState()).reverse()) await nsenter('systemctl', ['disable', '--now', svc]);
      await auditLogger.log({ action: 'gsm_stop', user, details: 'gsm services stopped + disabled at boot', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadGsmState();
      for (const svc of lifecycleServices(state)) await nsenter('systemctl', ['restart', svc]);
      await reapplyBtsLocks(state);
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
      if (services.includes('osmo-bsc')) await reapplyBtsLocks(loadGsmState());
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
      // Real incident, 2026-09-12: this call was briefly removed (same
      // night, earlier) because configureSms() used to fully REGENERATE
      // osmo-msc.cfg from its own simplified template, silently wiping this
      // host's real hand/VTY-maintained config (SS7 point-code, A5
      // ciphering, the mncc external socket path, the smpp/esme block with
      // live VectorCore MMSC + 2G-SMS-bridge passwords) on a real run. That
      // underlying bug is now fixed (see vty-config-ownership.ts) —
      // configureSms() upserts only the directives it owns (the mgw block
      // among them) and preserves everything else byte-for-byte. Restored
      // here so Uninstall actually removes the mgw peer from the live file,
      // not just the marker.
      setMscMgwPeer(null);
      const { configureSms, readCurrentSmsConfig } = await import('./sms-controller');
      const currentSms = readCurrentSmsConfig();
      if (currentSms) await configureSms(currentSms);

      write('\n=== Stopping and removing osmo-sip-connector (SIP tab) ===');
      await nsenter('systemctl', ['disable', '--now', 'osmo-sip-connector']).catch(() => {});
      try { fs.unlinkSync(`/proc/1/root${SIPCONN_UNIT_PATH}`); } catch { /* may not exist */ }
      try { fs.unlinkSync(`/proc/1/root${SIPCONN_BIN}`); } catch { /* may not exist */ }
      await nsenter('rm', ['-rf', '/opt/osmo-sip-connector-build']).catch(() => {});
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});
      // Removing the bridge entirely must not leave osmo-msc pointed at a
      // socket nothing is listening on anymore — restore internal routing.
      const { setMscMnccMode } = await import('./sms-controller');
      await setMscMnccMode('internal', SIPCONN_MNCC_SOCKET_PATH).catch(() => {});

      write('\n=== Stopping and removing osmo-meas-udp2db ===');
      await nsenter('systemctl', ['disable', '--now', MEAS_UDP2DB_UNIT]).catch(() => {});
      try { fs.unlinkSync(HOST_MEAS_UNIT_PATH); } catch { /* may not exist */ }
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});

      write('\n=== Removing GSM config files ===');
      // Real bug found live 2026-09-12, fixed before this ever ran for real:
      // this loop previously iterated the WHOLE manifest unconditionally,
      // which includes osmo-stp.cfg/osmo-hlr.cfg/osmo-msc.cfg (marked
      // shared: true purely for the Config Files tab's warning banner) —
      // meaning Uninstall would have deleted the shared SMS-over-SGs config
      // files it explicitly claims (in its own final message below) to
      // leave untouched. Skip anything shared — this module never owns
      // those files' lifecycle, only sms-controller.ts's configureSms() does.
      for (const f of GSM_CONFIG_MANIFEST) { if (f.shared) continue; try { fs.unlinkSync(f.path); } catch { /* may not exist */ } }
      try { fs.unlinkSync(HOST_GSM_STATE); } catch { /* may not exist */ }

      write('\n=== Purging osmo-bsc, osmo-mgw, osmo-bts, osmo-bsc-meas-utils, osmo-pcu, osmo-sgsn, osmo-ggsn ===');
      await new Promise<void>((resolve) => {
        const purge = spawn('nsenter', [
          '-t', '1', '-m', '-u', '-i', '-p', '--',
          'bash', '-c', 'DEBIAN_FRONTEND=noninteractive apt-get purge -y osmo-bsc osmo-mgw osmo-bts osmo-bsc-meas-utils osmo-pcu osmo-sgsn osmo-ggsn 2>&1 && apt-get autoremove -y 2>&1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        purge.stdout?.on('data', (d: Buffer) => write(d.toString()));
        purge.stderr?.on('data', (d: Buffer) => write(d.toString()));
        purge.on('close', () => resolve());
      });

      await auditLogger.log({ action: 'gsm_uninstall', user, details: 'osmo-bsc/mgw/bts/gprs/sip-connector removed', success: true });
      write('\n✅ 2G GSM module uninstalled (CS, GPRS/EDGE, SIP tab). osmo-stp/osmo-hlr/osmo-msc (shared with SMS over SGs) were left untouched.');
    } catch (err) {
      await auditLogger.log({ action: 'gsm_uninstall', user, details: String(err), success: false });
      write(`\n❌ Uninstall failed: ${String(err)}`);
    }
    res.end();
  });

  return router;
}
