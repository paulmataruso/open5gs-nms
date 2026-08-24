import { Router, Request, Response } from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { getAppVersion } from '../../infrastructure/system/app-version';

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

      const state = readState();
      const appVersion = getAppVersion();
      const configStale = !!state && state.configuredWithVersion !== appVersion;
      const installStale = installed && state?.installedWithVersion !== appVersion;

      res.json({
        success: true,
        installed,
        serviceActive,
        healthy,
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
        await auditLogger.log({ action: 'vectorcore_smsc_install', user, details: `apt exit ${depsExit}`, success: false });
        return res.end();
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
        await auditLogger.log({ action: 'vectorcore_smsc_install', user, details: `go setup exit ${goExit}`, success: false });
        return res.end();
      }

      write('\n=== Cloning VectorCore SMSC ===');
      const SRC_PARENT_DIR = SRC_DIR.slice(0, SRC_DIR.lastIndexOf('/'));
      await spawnStream(`mkdir -p ${SRC_PARENT_DIR} 2>/dev/null; [ -d ${SRC_DIR}/.git ] && echo "Already cloned — skipping." || git clone https://github.com/vectorcore-mobile/vectorcore-smsc.git ${SRC_DIR}`);

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
        await auditLogger.log({ action: 'vectorcore_smsc_install', user, details: `build exit ${buildExit}`, success: false });
        return res.end();
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

      await auditLogger.log({ action: 'vectorcore_smsc_install', user, details: 'success', success: true });
      write('\n✅ VectorCore SMSC installed. Run Configure next.');
      res.end();
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      await auditLogger.log({ action: 'vectorcore_smsc_install', user, details: String(err), success: false });
      res.end();
    }
  });

  // POST /api/vectorcore-smsc/configure — no body needed; imsDomain is
  // derived from ims-controller.ts's own state, not supplied by the caller.
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const imsState = readImsState();
      if (!imsState) {
        return res.status(400).json({ success: false, error: 'IMS is not configured yet — configure IMS first.' });
      }
      const { imsDomain } = imsState;
      if (!fs.existsSync(`${HOST_ROOT}${VC_BIN}`)) {
        return res.status(400).json({ success: false, error: 'VectorCore SMSC is not installed yet — run Install first.' });
      }

      const cfg = smscYamlCfg(imsDomain);
      fs.mkdirSync(`${HOST_ROOT}${VC_ETC}`, { recursive: true });
      fs.writeFileSync(`${HOST_ROOT}${VC_CFG}`, cfg, 'utf-8');

      await nsenter('systemctl', ['enable', '--now', SYSTEMD_UNIT]);

      writeState({ imsDomain, configuredWithVersion: getAppVersion(), installedWithVersion: readState()?.installedWithVersion });

      await auditLogger.log({ action: 'vectorcore_smsc_configure', user, details: `imsDomain=${imsDomain}`, success: true });
      res.json({ success: true, sipAddress: `${SIP_BIND_IP}:${SIP_PORT}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'vectorcore_smsc_configure', user, details: message, success: false });
      logger.error({ err: message }, 'vectorcore-smsc configure error');
      res.status(500).json({ success: false, error: message });
    }
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
