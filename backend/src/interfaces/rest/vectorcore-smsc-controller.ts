import { Router, Request, Response } from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { getAppVersion } from '../../infrastructure/system/app-version';
import { upsertSmppEsme, isSmppEsmeActive } from './sms-controller';

// ── SMS via VectorCore SMSC ──────────────────────────────────────────────────
//
// A real, purpose-built SMS Center (github.com/vectorcore-mobile/vectorcore-smsc,
// Apache-2.0, Go — same org as this project's VoWiFi ePDG/AAA and MMSC),
// offered as a third SMS Delivery Mode alongside SMS-over-IMS (Kamailio's own
// inline SMSC role) and SMS-over-SGs (Osmocom). Integrated via its SIP/3GPP-ISC
// interface only — S-CSCF forwards MESSAGE requests to it instead of handling
// them inline (see kamailio_scscf.cfg's ROUTE_SMS_TO_VECTORCORE block, wired
// by scscfIncludeCfg() in ims-controller.ts). Its SMPP (external aggregator)
// and Diameter SGd interfaces are real capabilities that this module's
// generated config leaves present-but-unconfigured — no aggregator
// credentials or SGd use case exists on this deployment yet; a natural
// follow-up, deliberately not attempted in this pass.
//
// Own install tree, /opt/vectorcore/sms/ — NOT sharing MMS's /opt/vectorcore/
// bin+etc directly (MMS installs at the top level of /opt/vectorcore/, an
// earlier convention; ePDG/AAA already each use their own
// /opt/vectorcore/<component>/ subdirectory, which this follows instead).
//
// Naming note: the upstream repo's OWN systemd/vectorcore-smsc.service
// filename briefly collided with this deployment's MMS unit, which had
// (confusingly) been installed under that exact same filename despite
// running the mmsc binary — see mms-controller.ts's SYSTEMD_UNIT comment.
// Fixed by renaming the MMS unit to vectorcore-mmsc.service, which frees this
// module to use vectorcore-smsc.service — its correct, un-collided name.

const execFileAsync = promisify(execFile);

const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 20000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

const HOST_ROOT      = '/proc/1/root';
const HOST_SMS_STATE = `${HOST_ROOT}/etc/open5gs/.vectorcore-smsc-config.json`;
const HOST_IMS_STATE = `${HOST_ROOT}/etc/open5gs/.ims-config.json`;

// Gating rationale matches mms-controller.ts's isImsInstalled/isImsConfigured
// exactly: this module integrates purely via Kamailio S-CSCF, so IMS being
// installed/configured is a hard prerequisite, not an optional nicety.
async function isImsInstalled(): Promise<boolean> {
  try {
    const { stdout } = await nsenter('which', ['kamailio']);
    return stdout.trim().length > 0;
  } catch { return false; }
}
function isImsConfigured(): boolean {
  return fs.existsSync(HOST_IMS_STATE);
}

// The IMS domain this module's SIP FQDN is derived from is never something
// an operator should type twice — it's already the single source of truth
// written by ims-controller.ts's own Configure. Same read-only-derive
// pattern as pstn-controller.ts's readImsState()/regenerateDialplan().
interface ImsState {
  imsDomain: string;
}
function readImsState(): ImsState | null {
  if (!fs.existsSync(HOST_IMS_STATE)) return null;
  try { return JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8')); } catch { return null; }
}

// Host-real paths (as used by nsenter'd commands, not /proc/1/root-prefixed).
const SRC_DIR = '/opt/vectorcore-build/vectorcore-smsc';
const VC_DIR  = '/opt/vectorcore/sms';
const VC_BIN  = `${VC_DIR}/bin/smsc`;
const VC_ETC  = `${VC_DIR}/etc`;
const VC_CFG  = `${VC_ETC}/smsc.yaml`;
const VC_DATA = `${VC_DIR}/data`;
const VC_LOG  = `${VC_DIR}/log`;

const SYSTEMD_UNIT      = 'vectorcore-smsc'; // the project's own real name — see module header for why this is now free to use
const SYSTEMD_UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}.service`;

// Confirmed against this host live before picking these (not assumed sight-
// unseen): each existing Kamailio role (P/I/S-CSCF, SMSC) already binds its
// own dedicated loopback-range address; 127.0.1.5 was free. 8080 is PyHSS's
// API, 8090 is MMS's, 8091 is VoWiFi ePDG's — 8092 was the first free one.
const SIP_BIND_IP  = '127.0.1.5';
const SIP_PORT     = 5060;
const API_PORT     = 8092;
// Present in the generated config so the section is well-formed, but not
// wired to any peer/aggregator — see module header. Bound to loopback only.
// DIAMETER_PORT: confirmed live this doesn't collide with any of the several
// other 127.0.x.x:3868 freeDiameter listeners already on this host (MME,
// HSS, PCRF, SMF) — they're all on distinct dedicated addresses, and nothing
// else uses 127.0.0.1:3868 specifically.
const DIAMETER_PORT = 3868;
// SMPP_PORT: NOT 2775 — that's already osmo-msc's own SMPP listener (see
// mms-controller.ts's SMPP_PORT comment; MMS's ESME connects to it). This
// binary starts an SMPP server unconditionally at process startup (confirmed
// live: even a config with the whole `smpp:` section omitted still falls
// back to a hardcoded default of 0.0.0.0:2775 — there's no way to disable
// it), so reusing 2775 here is a guaranteed bind conflict/crash-loop, not
// just a theoretical one. 2776 confirmed free.
const SMPP_PORT     = 2776;
const GO_VERSION = '1.25.0'; // matches vectorcore-smsc's go.mod `go` directive — avoids Go's automatic-toolchain-download reaching proxy.golang.org mid-build on a host with restricted egress

// ── 2G ↔ 4G SMS interworking bridge ──────────────────────────────────────────
//
// VectorCore SMSC is the single SMSC brain: it takes SMS from IMS (SIP/3GPP
// ISC, via S-CSCF) AND from the 2G/CS core (osmo-msc, over SMPP), and routes
// each message to whichever side the destination is on. Wiring, all made to
// survive a fresh install by this module:
//   1. an osmo-msc `esme` (default-route) so every 2G MO SMS is handed to
//      VectorCore  — applied live via sms-controller.ts's upsertSmppEsme()
//      (never persisted to osmo-msc.cfg, self-healed in GET /status)
//   2. a VectorCore outbound SMPP client back to osmo-msc:2775 + a
//      catch-all fallback routing rule (egress smpp) — created via
//      VectorCore's own /api/v1, idempotently
//   3. seven source patches to the upstream VectorCore SMSC tree, applied
//      during Install before `make` (idempotent, fail-soft) — see
//      BRIDGE_SOURCE_PATCH_PY. Without them the SMPP-client path
//      self-deadlocks / uses the wrong PDU / mis-encodes GSM 7-bit / sends
//      MT to the wrong S-CSCF port — each found and fixed live 2026-09-10.
//   4. an S-CSCF routing patch (a MESSAGE whose From-user is "smsc" is an
//      MT delivery from VectorCore and must take the terminating path, not
//      be bounced back) — lives in the kamailio_scscf.cfg template, gated
//      by the existing ROUTE_SMS_TO_VECTORCORE #!define.
const BRIDGE_ESME_NAME     = 'vcsmsc';
const BRIDGE_ESME_PASSWORD = 'vc2msc99'; // 8 chars max — SMPP 3.4 bind PDU limit (see upsertSmppEsme)
const OSMO_MSC_SMPP        = { host: '127.0.0.1', port: 2775 };

// Idempotent, fail-soft. Each hunk: skip if its marker is already present;
// apply if its anchor is present; warn (do not fail the build) if neither —
// upstream drifted and the patch needs a human. Mirrors ims-controller.ts's
// PyHSS crash-guard patch style.
const BRIDGE_SOURCE_PATCH_PY = String.raw`
import sys, os
D = sys.argv[1]
def patch(rel, marker, anchor, repl):
    p = os.path.join(D, rel)
    try:
        s = open(p).read()
    except FileNotFoundError:
        print("  SKIP  %s (file not found)" % rel); return
    if marker in s:
        print("  ok    %s (already patched)" % rel); return
    if anchor not in s:
        print("  WARN  %s (anchor not found — upstream changed, patch skipped)" % rel); return
    open(p, "w").write(s.replace(anchor, repl, 1))
    print("  PATCH %s" % rel)

# 1. dispatch the forwarder off the SMPP client read loop (self-deadlock otherwise)
patch("cmd/smsc/main.go", "go fwd.Dispatch(ctx, msg)",
    "\t\tmsg.IngressPeer = clientName\n\t\tfwd.Dispatch(ctx, msg)\n\t})",
    "\t\tmsg.IngressPeer = clientName\n\t\tgo fwd.Dispatch(ctx, msg) // NMS: don't block the SMPP client read loop\n\t})")

# 2. MT hand-off from an ESME to an upstream SMSC is submit_sm, not deliver_sm
patch("internal/forwarder/forwarder.go", "MT hand-off from an ESME to an SMSC is",
    "pdu, err := smppcodec.EncodeDeliverSM(msg)\n\tif err != nil {\n\t\treturn fmt.Errorf(\"encode deliver_sm: %w\", err)\n\t}",
    "// NMS patch: an outbound SMPP client acts as an ESME toward an upstream\n"
    "\t// SMSC (here: osmo-msc). MT hand-off from an ESME to an SMSC is\n"
    "\t// submit_sm, not deliver_sm. osmo-msc silently drops an inbound\n"
    "\t// deliver_sm from a bound ESME, which made every routed message time out.\n"
    "\tpdu, err := smppcodec.EncodeSubmitSM(msg)\n\tif err != nil {\n\t\treturn fmt.Errorf(\"encode submit_sm: %w\", err)\n\t}")

# 3. single-part GSM7 goes out UNPACKED (osmo-msc packs it itself for data_coding=0)
patch("internal/codec/smpp/encode.go", "single-part GSM7 goes out UNPACKED",
    "packed, _ := tpdu.EncodeGSM7(msg.Text)\n\t\t\tpdu.ShortMessage = packed",
    "// NMS patch: single-part GSM7 goes out UNPACKED (one septet\n"
    "\t\t\t// per octet). osmo-msc, on data_coding=0, packs short_message\n"
    "\t\t\t// itself for the GSM TPDU - sending pre-packed septets makes it\n"
    "\t\t\t// double-pack and the handset shows garbage. Concatenated parts\n"
    "\t\t\t// (UDH branch above) still use packed, per the standard.\n"
    "\t\t\tpdu.ShortMessage = []byte(msg.Text)")

# 4. keep the Via port in the stored S-CSCF address (else MT MESSAGE -> dead :5060)
patch("internal/sip/isc/register.go", "via.Port != 0",
    "\tscscf := \"\"\n\tif via := req.Via(); via != nil {\n\t\tscscf = via.Host\n\t}",
    "\tscscf := \"\"\n\tif via := req.Via(); via != nil {\n\t\tscscf = via.Host\n\t\tif via.Port != 0 { // NMS: S-CSCF listens on 6060, not the default 5060\n\t\t\tscscf = via.Host + \":\" + strconv.Itoa(via.Port)\n\t\t}\n\t}")

# 5. don't block forever if the ISC client transaction times out with no response
patch("internal/sip/isc/sender.go", "case <-tx.Done():",
    "\t\tcase <-ctx.Done():\n\t\t\treturn ctx.Err()\n\t\t}\n\t}\n}",
    "\t\tcase <-ctx.Done():\n\t\t\treturn ctx.Err()\n\t\tcase <-tx.Done(): // NMS: Timer F etc. - don't hang the forwarder goroutine\n\t\t\tif e := tx.Err(); e != nil {\n\t\t\t\treturn fmt.Errorf(\"SIP MESSAGE transaction ended: %w\", e)\n\t\t\t}\n\t\t\treturn fmt.Errorf(\"SIP MESSAGE transaction ended with no response\")\n\t\t}\n\t}\n}")

# 6. an UNPACKED GSM7 decoder (osmo-msc sends unpacked in deliver_sm for dc=0)
patch("internal/codec/tpdu/dcs.go", "func DecodeGSM7Unpacked",
    "func EncodeGSM7(text string) (packed []byte, septets int) {",
    "// DecodeGSM7Unpacked maps UNPACKED GSM 7-bit octets (one septet per byte)\n"
    "// straight to text (osmo-msc's deliver_sm short_message shape for dc=0).\n"
    "func DecodeGSM7Unpacked(b []byte) string {\n"
    "\trunes := make([]rune, 0, len(b))\n"
    "\tfor i := 0; i < len(b); i++ {\n"
    "\t\tc := b[i]\n"
    "\t\tif c == 0x1B && i+1 < len(b) {\n"
    "\t\t\ti++\n"
    "\t\t\tif ext := b[i]; ext < 128 && gsm7Ext[ext] != 0 {\n"
    "\t\t\t\trunes = append(runes, gsm7Ext[ext])\n"
    "\t\t\t} else {\n"
    "\t\t\t\trunes = append(runes, ' ')\n"
    "\t\t\t}\n"
    "\t\t} else if c < 128 {\n"
    "\t\t\trunes = append(runes, gsm7Basic[c])\n"
    "\t\t}\n"
    "\t}\n"
    "\treturn string(runes)\n"
    "}\n\n"
    "func EncodeGSM7(text string) (packed []byte, septets int) {")

# 7. use the unpacked decoder for single-part GSM7 deliver_sm
patch("internal/codec/smpp/decode.go", "tpdu.DecodeGSM7Unpacked(payload)",
    "\tcase codec.EncodingGSM7:\n\t\t// UDL in submit_sm is byte count",
    "\tcase codec.EncodingGSM7:\n\t\tif !hasUDHI && msg.Concat == nil {\n\t\t\tmsg.Text = tpdu.DecodeGSM7Unpacked(payload) // NMS: osmo-msc sends unpacked for dc=0\n\t\t\tbreak\n\t\t}\n\t\t// UDL in submit_sm is byte count")
`;

// Idempotently ensure the CS bridge: osmo-msc ESME (default-route) + the
// VectorCore SMPP client + fallback routing rule. Safe to call repeatedly and
// safe when osmo-msc isn't present (it just skips the ESME half). `log` is
// optional streaming output.
async function ensureCsBridge(log: (s: string) => void = () => {}): Promise<void> {
  // 1. osmo-msc ESME (live VTY, self-heals on restart via GET /status)
  try {
    const r = await upsertSmppEsme(BRIDGE_ESME_NAME, BRIDGE_ESME_PASSWORD, { defaultRoute: true });
    log(r.success
      ? `  osmo-msc esme "${BRIDGE_ESME_NAME}" (default-route) applied`
      : `  WARN: osmo-msc esme apply returned: ${r.output.slice(0, 200)}`);
  } catch (err) {
    // osmo-msc not configured (no 2G/SGs core) — the bridge simply has no
    // CS side to talk to. Not an error for a pure-4G deployment.
    log(`  osmo-msc esme skipped (${err instanceof Error ? err.message : String(err)})`);
  }

  // 2. VectorCore's own SMPP client + fallback routing rule, via its REST API
  const api = `http://127.0.0.1:${API_PORT}/api/v1`;
  const curlJson = async (method: string, path: string, body?: unknown): Promise<string> => {
    const args = ['-fsS', '-X', method, `${api}${path}`];
    if (body !== undefined) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
    const { stdout } = await nsenter('curl', args, 8000);
    return stdout;
  };
  try {
    const clients: any[] = JSON.parse(await curlJson('GET', '/smpp/clients').catch(() => '[]') || '[]');
    if (!clients.some(c => c.name === 'osmo-msc' || c.system_id === BRIDGE_ESME_NAME)) {
      await curlJson('POST', '/smpp/clients', {
        name: 'osmo-msc', host: OSMO_MSC_SMPP.host, port: OSMO_MSC_SMPP.port,
        transport: 'tcp', verify_server_cert: false,
        system_id: BRIDGE_ESME_NAME, password: BRIDGE_ESME_PASSWORD,
        bind_type: 'transceiver', reconnect_interval: '10s', throughput_limit: 0, enabled: true,
      });
      log('  VectorCore SMPP client -> osmo-msc:2775 created');
    } else {
      log('  VectorCore SMPP client already present');
    }

    const policies: any[] = JSON.parse(await curlJson('GET', '/routing/policies').catch(() => '[]') || '[]');
    const sfPolicyId = policies[0]?.id ?? '';
    const rules: any[] = JSON.parse(await curlJson('GET', '/routing/rules').catch(() => '[]') || '[]');
    if (!rules.some(r => r.name === 'fallback-to-cs')) {
      await curlJson('POST', '/routing/rules', {
        name: 'fallback-to-cs', priority: 100,
        match_src_iface: '', match_src_peer: '', match_dst_prefix: '',
        match_msisdn_min: '', match_msisdn_max: '',
        egress_iface: 'smpp', egress_peer: 'osmo-msc',
        sf_policy_id: sfPolicyId, enabled: true,
      });
      log('  VectorCore fallback routing rule (-> smpp:osmo-msc) created');
    } else {
      log('  VectorCore fallback routing rule already present');
    }
  } catch (err) {
    log(`  WARN: VectorCore API bridge config failed (${err instanceof Error ? err.message : String(err)}) — retried on next /status`);
  }
}

interface VectorcoreSmscState {
  imsDomain: string;
  configuredWithVersion?: string;
  // Separate from configuredWithVersion — same reasoning as MMS's
  // installedWithVersion: Install (clone/build) and Configure (write
  // smsc.yaml, restart with the CURRENTLY-BUILT binary) are genuinely
  // different operations; only a re-Install rebuilds the actual binary.
  installedWithVersion?: string;
}

function readState(): VectorcoreSmscState | null {
  if (!fs.existsSync(HOST_SMS_STATE)) return null;
  try { return JSON.parse(fs.readFileSync(HOST_SMS_STATE, 'utf-8')); } catch { return null; }
}
function writeState(state: VectorcoreSmscState): void {
  fs.mkdirSync(`${HOST_ROOT}/etc/open5gs`, { recursive: true });
  fs.writeFileSync(HOST_SMS_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

// Deliberately ABSOLUTE paths throughout (dsn/log file) — same reasoning as
// mmscYamlCfg() in mms-controller.ts: the shipped unit has no
// WorkingDirectory= set, so relative paths would resolve against systemd's
// default cwd ("/") and scatter files across the filesystem.
function smscYamlCfg(imsDomain: string): string {
  const fqdn = `smsc.${imsDomain}`;
  return `smpp:
  server:
    address: "127.0.0.1"
    port: ${SMPP_PORT}
    max_connections: 50
    enquire_link_interval: 30s
    response_timeout: 10s

sip:
  address: "${SIP_BIND_IP}"
  port: ${SIP_PORT}
  fqdn: "${fqdn}"
  transport: udp

isc:
  accept_contact: "*;+g.3gpp.smsip"
  mt_request_disposition: "no-fork"
  submit_report_request_disposition: "no-fork"

diameter:
  address: "127.0.0.1"
  port: ${DIAMETER_PORT}
  transport: tcp
  local_fqdn: "${fqdn}"
  local_realm: "${imsDomain}"
  s6c_cache_ttl: 300s

database:
  driver: sqlite
  dsn: "${VC_DATA}/vectorcore-smsc.db"
  poll_interval: 2s

# 0.0.0.0, not loopback: this serves both the JSON API and the embedded
# admin SPA (at /ui/) — the frontend links directly to it by host+port for
# the SPA (same as mms-controller.ts's VC_ADMIN_PORT convention; the SPA
# can't be reverse-proxied under an nginx subpath, its asset/router paths
# are baked in absolute at build time). It has zero auth of its own, same
# posture already accepted for MMS's equivalent admin port.
api:
  address: "0.0.0.0"
  port: ${API_PORT}

log:
  file: "${VC_LOG}/smsc.log"
  level: "info"
`;
}

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same install logic in-process — write() is the only side-channel.
export async function installVectorcoreSmsc(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

    try {
      write('=== Installing build dependencies (build-essential, make, git, sqlite3) ===');
      const depsExit = await spawnStream(
        `set -e\n` +
        `DEBIAN_FRONTEND=noninteractive apt-get update -q\n` +
        `DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential make git sqlite3\n` +
        `if command -v npm >/dev/null 2>&1; then\n` +
        `  echo "npm already present ($(npm --version)) — skipping apt npm package."\n` +
        `else\n` +
        `  DEBIAN_FRONTEND=noninteractive apt-get install -y npm\n` +
        `fi`
      );
      if (depsExit !== 0) {
        write(`\n❌ apt-get install failed (exit ${depsExit}).`);
        return { success: false, error: `apt exit ${depsExit}` };
      }

      write(`\n=== Ensuring Go ${GO_VERSION}+ toolchain ===`);
      const goExit = await spawnStream(
        `set -e\n` +
        `NEED_GO=1\n` +
        `if [ -x /usr/local/go/bin/go ]; then\n` +
        `  CURVER=$(/usr/local/go/bin/go version | grep -oE 'go[0-9]+\\.[0-9]+(\\.[0-9]+)?' | sed 's/^go//')\n` +
        `  TOPVER=$(printf '%s\\n%s\\n' "${GO_VERSION}" "$CURVER" | sort -V | tail -1)\n` +
        `  if [ "$TOPVER" = "$CURVER" ]; then NEED_GO=0; fi\n` +
        `fi\n` +
        `if [ "$NEED_GO" = "1" ]; then\n` +
        `  ARCH=$(uname -m)\n` +
        `  case $ARCH in x86_64) GOARCH=amd64 ;; aarch64) GOARCH=arm64 ;; *) GOARCH=amd64 ;; esac\n` +
        `  echo "Downloading go${GO_VERSION}.linux-$GOARCH.tar.gz..."\n` +
        `  curl -fsSL -o /tmp/go-smsc.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-$GOARCH.tar.gz"\n` +
        `  rm -rf /usr/local/go\n` +
        `  tar -C /usr/local -xzf /tmp/go-smsc.tar.gz\n` +
        `  rm -f /tmp/go-smsc.tar.gz\n` +
        `  echo "Installed: $(/usr/local/go/bin/go version)"\n` +
        `else\n` +
        `  echo "Already have: $(/usr/local/go/bin/go version)"\n` +
        `fi`
      );
      if (goExit !== 0) {
        write(`\n❌ Go toolchain setup failed (exit ${goExit}).`);
        return { success: false, error: `go setup exit ${goExit}` };
      }

      write('\n=== Cloning VectorCore SMSC ===');
      const SRC_PARENT_DIR = SRC_DIR.slice(0, SRC_DIR.lastIndexOf('/'));
      await spawnStream(`mkdir -p ${SRC_PARENT_DIR} 2>/dev/null; [ -d ${SRC_DIR}/.git ] && echo "Already cloned — skipping." || git clone https://github.com/vectorcore-mobile/vectorcore-smsc.git ${SRC_DIR}`);

      write('\n=== Applying NMS 2G↔4G SMS bridge patches ===');
      await spawnStream(`python3 - ${SRC_DIR} <<'PYEOF'\n${BRIDGE_SOURCE_PATCH_PY}\nPYEOF`);

      write('\n=== Building (web UI + Go binary) ===');
      const buildExit = await spawnStream(
        `set -e\n` +
        `export PATH=/usr/local/go/bin:$PATH\n` +
        `export GOCACHE=${SRC_DIR}/.gocache\n` +
        `export GOMODCACHE=${SRC_DIR}/.gomodcache\n` +
        // This host's NMS backend runs with NODE_ENV=production set (a normal
        // choice for its own Node process) — child_process.spawn() inherits
        // that into every nsenter'd command by default, and npm silently
        // skips devDependencies when it sees NODE_ENV=production. This repo's
        // own Makefile builds its embedded web UI via `cd web && npm ci &&
        // npm run build`, and vite (the actual build tool) lives in
        // devDependencies — confirmed live: this produced "added 48 packages"
        // (deps only, no vite) instead of the full ~109, then "vite: not
        // found" at build time with no earlier warning. Unlike
        // mms-controller.ts's own install (which pre-populates node_modules
        // itself with `npm install --include=dev` before calling make), this
        // Makefile's `npm ci` always wipes node_modules first, so a
        // pre-install doesn't survive — unset NODE_ENV instead, so npm never
        // sees it in the first place.
        `unset NODE_ENV\n` +
        `cd ${SRC_DIR}\n` +
        `make`
      );
      if (buildExit !== 0) {
        write(`\n❌ Build failed (exit ${buildExit}).`);
        return { success: false, error: `build exit ${buildExit}` };
      }

      write('\n=== Installing binary and systemd unit (content as shipped) ===');
      await spawnStream(
        `set -e\n` +
        `mkdir -p ${VC_DIR}/bin ${VC_ETC} ${VC_DATA} ${VC_LOG}\n` +
        `cp ${SRC_DIR}/bin/smsc ${VC_BIN}\n` +
        `chmod +x ${VC_BIN}\n` +
        `cp ${SRC_DIR}/systemd/${SYSTEMD_UNIT}.service ${SYSTEMD_UNIT_PATH}\n` +
        // The shipped unit's ExecStart points at /opt/vectorcore/bin/smsc — this
        // deployment installs under /opt/vectorcore/sms/bin/smsc instead (own
        // subdirectory, see module header), so the copied unit needs its
        // ExecStart/config path rewritten. Everything else (Restart=,
        // dependencies, etc.) stays exactly as shipped.
        `sed -i "s|ExecStart=.*|ExecStart=${VC_BIN} -c ${VC_CFG}|" ${SYSTEMD_UNIT_PATH}\n` +
        `systemctl daemon-reload`
      );

      const existingState = readState();
      writeState({ ...(existingState ?? {} as VectorcoreSmscState), imsDomain: existingState?.imsDomain ?? '', installedWithVersion: getAppVersion() });

      write('\n✅ VectorCore SMSC installed. Run Configure next.');
      return { success: true };
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      return { success: false, error: String(err) };
    }
}

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same configure logic in-process — zero-input, imsDomain is always
// derived live from ims-controller.ts's own state, never a caller-supplied value.
export async function configureVectorcoreSmsc(): Promise<{ success: boolean; error?: string; imsDomain?: string; sipAddress?: string }> {
  try {
      const imsState = readImsState();
      if (!imsState) {
        return { success: false, error: 'IMS is not configured yet — configure IMS first.' };
      }
      const { imsDomain } = imsState;
      if (!fs.existsSync(`${HOST_ROOT}${VC_BIN}`)) {
        return { success: false, error: 'VectorCore SMSC is not installed yet — run Install first.' };
      }

      const cfg = smscYamlCfg(imsDomain);
      fs.mkdirSync(`${HOST_ROOT}${VC_ETC}`, { recursive: true });
      fs.writeFileSync(`${HOST_ROOT}${VC_CFG}`, cfg, 'utf-8');

      await nsenter('systemctl', ['enable', '--now', SYSTEMD_UNIT]);

      // Give the API a moment to come up, then wire the 2G↔4G CS bridge.
      await new Promise(r => setTimeout(r, 4000));
      await ensureCsBridge();

      writeState({ imsDomain, configuredWithVersion: getAppVersion(), installedWithVersion: readState()?.installedWithVersion });

      return { success: true, imsDomain, sipAddress: `${SIP_BIND_IP}:${SIP_PORT}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
}

export interface VectorcoreSmscStalenessResult {
  installed: boolean;
  hasSavedConfig: boolean;
  installStale: boolean;
  configStale: boolean;
  installedWithVersion?: string;
  configuredWithVersion?: string;
}

// Cheap staleness check for the cross-module Fix-All aggregator — mirrors the
// comparison GET /status already does, without the rest of that endpoint's work.
export async function getVectorcoreSmscStaleness(): Promise<VectorcoreSmscStalenessResult> {
  const installed = fs.existsSync(`${HOST_ROOT}${VC_BIN}`);
  const state = readState();
  const appVersion = getAppVersion();
  const configStale = !!state && state.configuredWithVersion !== appVersion;
  const installStale = installed && state?.installedWithVersion !== appVersion;
  return {
    installed,
    hasSavedConfig: !!state,
    installStale,
    configStale,
    installedWithVersion: state?.installedWithVersion,
    configuredWithVersion: state?.configuredWithVersion,
  };
}

export function createVectorcoreSmscRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const installed = fs.existsSync(`${HOST_ROOT}${VC_BIN}`);
      const serviceActiveRes = await nsenter('systemctl', ['is-active', SYSTEMD_UNIT]).catch(() => null);
      const serviceActive = serviceActiveRes?.stdout.trim() === 'active';

      let healthy = false;
      if (serviceActive) {
        try {
          await nsenter('curl', ['-fsS', '-o', '/dev/null', `http://127.0.0.1:${API_PORT}/health`], 3000);
          healthy = true;
        } catch { /* not up yet or crashed — reported via serviceActive/healthy separately */ }
      }

      // Self-heal the 2G↔4G CS bridge. The osmo-msc ESME password never
      // survives an osmo-msc restart (upsertSmppEsme is live-VTY only), and a
      // fresh VectorCore DB has no SMPP client / routing rule — re-apply both
      // whenever we notice the ESME is gone. Same pattern as mms-controller.ts.
      let bridgeEsmeActive = false;
      if (healthy) {
        bridgeEsmeActive = await isSmppEsmeActive(BRIDGE_ESME_NAME).catch(() => false);
        if (!bridgeEsmeActive) {
          await ensureCsBridge(s => logger.info({ msg: s.trim() }, 'vectorcore-smsc: bridge self-heal'));
          bridgeEsmeActive = await isSmppEsmeActive(BRIDGE_ESME_NAME).catch(() => false);
        }
      }

      const state = readState();
      const appVersion = getAppVersion();
      const configStale = !!state && state.configuredWithVersion !== appVersion;
      const installStale = installed && state?.installedWithVersion !== appVersion;

      res.json({
        success: true,
        installed,
        serviceActive,
        healthy,
        // 2G↔4G CS bridge: is the osmo-msc ESME live? (false on a pure-4G
        // deployment with no 2G/SGs core — that's expected, not an error.)
        bridgeEsmeActive,
        hasSavedConfig: !!state,
        installedWithVersion: state?.installedWithVersion,
        installStale,
        imsInstalled: await isImsInstalled(),
        imsConfigured: isImsConfigured(),
        // Live-derived from ims-controller.ts's own state, not something an
        // operator ever types in here — see readImsState()'s comment.
        imsDomain: readImsState()?.imsDomain,
        currentConfig: state ? { imsDomain: state.imsDomain } : undefined,
        appVersion,
        configuredWithVersion: state?.configuredWithVersion,
        configStale,
        sipAddress: `${SIP_BIND_IP}:${SIP_PORT}`,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'vectorcore-smsc status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/vectorcore-smsc/install — streaming: Go toolchain + build deps,
  // clone, build (embeds the web UI first), deploy the systemd unit as-is —
  // same shape as mms-controller.ts's /install.
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (!(await isImsInstalled())) {
      return res.status(400).json({ success: false, error: 'IMS is not installed yet — install IMS on the IMS page first. VectorCore SMSC integrates via S-CSCF and needs IMS present.' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const result = await installVectorcoreSmsc(write);
    await auditLogger.log({ action: 'vectorcore_smsc_install', user, details: result.error ?? 'success', success: result.success });
    res.end();
  });

  // POST /api/vectorcore-smsc/configure — no body needed; imsDomain is
  // derived from ims-controller.ts's own state, not supplied by the caller.
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const result = await configureVectorcoreSmsc();
    if (!result.success) {
      await auditLogger.log({ action: 'vectorcore_smsc_configure', user, details: result.error ?? 'failed', success: false });
      return res.status(400).json({ success: false, error: result.error });
    }
    await auditLogger.log({ action: 'vectorcore_smsc_configure', user, details: `imsDomain=${result.imsDomain}`, success: true });
    res.json({ success: true, sipAddress: result.sipAddress });
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['start', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'vectorcore_smsc_start', user, details: 'started', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'vectorcore_smsc_stop', user, details: 'stopped', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', SYSTEMD_UNIT]);
      await auditLogger.log({ action: 'vectorcore_smsc_restart', user, details: 'restarted', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/vectorcore-smsc/uninstall — streaming: full teardown, matches
  // this project's existing SMS/MMS/PSTN uninstall convention (full clean
  // removal, gated behind an explicit confirmation dialog on the frontend).
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    try {
      write('=== Stopping and disabling VectorCore SMSC ===');
      await nsenter('systemctl', ['disable', '--now', SYSTEMD_UNIT]).catch(() => {});

      write('\n=== Removing the 2G↔4G CS bridge from osmo-msc ===');
      try {
        const { removeSmppEsme } = await import('./sms-controller');
        await removeSmppEsme(BRIDGE_ESME_NAME);
        write(`  osmo-msc esme "${BRIDGE_ESME_NAME}" removed (2G MO SMS returns to native osmo-msc delivery)`);
      } catch (err) {
        write(`  osmo-msc esme removal skipped (${err instanceof Error ? err.message : String(err)})`);
      }

      write('\n=== Removing systemd unit ===');
      if (fs.existsSync(`${HOST_ROOT}${SYSTEMD_UNIT_PATH}`)) {
        await nsenter('rm', ['-f', SYSTEMD_UNIT_PATH]);
        await nsenter('systemctl', ['daemon-reload']);
        write(`Removed: ${SYSTEMD_UNIT_PATH}`);
      }

      write('\n=== Removing VectorCore SMSC (binary, database, log) ===');
      await nsenter('rm', ['-rf', VC_DIR]);
      write(`Removed: ${VC_DIR}`);

      if (fs.existsSync(HOST_SMS_STATE)) { fs.unlinkSync(HOST_SMS_STATE); write(`Removed: ${HOST_SMS_STATE}`); }

      await auditLogger.log({ action: 'vectorcore_smsc_uninstall', user, details: 'success', success: true });
      write('\n✅ VectorCore SMSC uninstalled. Source tree left at ' + SRC_DIR + ' for a faster re-install (delete it manually to reclaim disk space).');
      res.end();
    } catch (err) {
      write(`\n❌ Uninstall error: ${String(err)}`);
      await auditLogger.log({ action: 'vectorcore_smsc_uninstall', user, details: String(err), success: false });
      res.end();
    }
  });

  // GET /api/vectorcore-smsc/admin/* — read-only proxy into VectorCore
  // SMSC's own JSON API, same reasoning/shape as mms-controller.ts's
  // equivalent: the API has zero auth of its own, so route it through this
  // admin-gated endpoint rather than ever telling the frontend to call it
  // directly. Frontend calls e.g. /api/vectorcore-smsc/admin/api/v1/messages.
  router.get('/admin/*', requireAdmin, async (req: Request, res: Response) => {
    const subPath = (req.params as any)[0] as string;
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    try {
      const { stdout } = await nsenter('curl', ['-fsS', `http://127.0.0.1:${API_PORT}/${subPath}${qs}`], 10000);
      res.type('application/json').send(stdout);
    } catch (err) {
      res.status(502).json({ success: false, error: String(err) });
    }
  });

  return router;
}

// Exported for ims-controller.ts's scscfIncludeCfg() call site, so the SIP
// bind address/port are defined once here rather than duplicated.
export const VECTORCORE_SMSC_SIP_ADDRESS = { ip: SIP_BIND_IP, port: SIP_PORT };
