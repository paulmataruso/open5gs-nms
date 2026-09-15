import { Router, Request, Response } from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { upsertVtyDirectives, OwnedDirective } from '../../domain/services/vty-config-ownership';
import {
  buildOsmoHnbgwScript, verifyOsmoHnbgwBuild, osmoHnbgwSystemdUnit,
  UNIT_PATH as HNBGW_UNIT_PATH, CFG_PATH as HNBGW_CFG_PATH,
} from '../../application/use-cases/osmo-hnbgw-build';
import {
  buildOsmoHnodebScript, verifyOsmoHnodebBuild, osmoHnodebSystemdUnit, osmoHnodebCfg,
  UNIT_PATH as HNODEB_UNIT_PATH, CFG_PATH as HNODEB_CFG_PATH,
} from '../../application/use-cases/osmo-hnodeb-build';

const execFileAsync = promisify(execFile);
const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], { timeout: timeoutMs, encoding: 'utf-8' });

// HNBGW_CFG_PATH/HNODEB_CFG_PATH (imported above) are deliberately PLAIN
// host paths (e.g. '/etc/osmocom/osmo-hnbgw.cfg') — correct as-is for
// anything run via nsenter (a real host shell), but this backend's own
// Node process only sees the HOST's filesystem through /proc/1/root/... —
// same convention as gsm-controller.ts's own SIPCONN_CFG_PATH usage
// (`/proc/1/root${SIPCONN_CFG_PATH}` at every direct fs.* call site). These
// two are the ones to use for every direct fs.* call in this file; keep
// using the raw imported constants for anything nsenter'd.
const HNBGW_CFG_HOST_PATH  = `/proc/1/root${HNBGW_CFG_PATH}`;
const HNODEB_CFG_HOST_PATH = `/proc/1/root${HNODEB_CFG_PATH}`;

const HNBGW_VTY_PORT = 4261;
// Same injection-safe, argv-only pattern as gsm-controller.ts's
// VTY_RUN_COMMAND_SCRIPT — a real telnet client isn't guaranteed present on
// this host, and even if it were, shelling a command string through it is
// exactly the kind of thing this project's own convention avoids.
const HNBGW_VTY_SCRIPT = `
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
async function hnbgwVtyCommand(cmd: string): Promise<string> {
  const { stdout } = await nsenter('python3', ['-c', HNBGW_VTY_SCRIPT, '127.0.0.1', String(HNBGW_VTY_PORT), cmd], 10000);
  return stdout;
}

const HOST_OSMOCOM_DIR = '/proc/1/root/etc/osmocom';
const HOST_MME_YAML    = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_SGSN_CFG    = `${HOST_OSMOCOM_DIR}/osmo-sgsn.cfg`;
const HOST_STATE       = `${HOST_OSMOCOM_DIR}/.nms-hnbgw-state.json`;

// Used by the virtual HNB's own config (network country code/mobile network
// code) — osmo-hnbgw itself doesn't need PLMN at tag 1.3.0 (see
// osmoHnbgwCfg()'s comment), but osmo-hnodeb's `hnodeb` node does.
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

// Dedicated GTP-U bind for the virtual HNB (osmo-hnodeb) — its fixed-port
// (2152, the standard 3GPP port) GTP-U socket defaults to 0.0.0.0 and
// collides fatally with Open5GS's own UPF, which already binds it on this
// host (confirmed live 2026-09-13: osmo-hnodeb treats this as fatal and
// exits outright, not a graceful degrade). Continues this project's
// per-daemon-loopback convention (Asterisk-2G=127.0.1.7, the dedicated
// HNBGW-MGW instance=127.0.1.8).
const HNODEB_GTP_LOCAL_IP = '127.0.1.9';

// Third, fully isolated OsmoMGW instance — same "own config, own systemd
// unit, own loopback IP" precedent this project already used for
// Asterisk-2G (127.0.1.7), applied here because OsmoHNBGW's own manual is
// explicit that it "requires a co-located OsmoMGW instance" for RTP relay,
// and this project's existing 2G-era OsmoMGW instance already has its own
// distinct job (A-interface RTP). Reuses the already-installed osmo-mgw
// apt package (same binary as the 2G instance) — no source build needed,
// only a second unit + config + bind address.
const HNBGW_MGW_UNIT     = 'osmo-mgw-hnbgw';
const HNBGW_MGW_UNIT_PATH = `/proc/1/root/etc/systemd/system/${HNBGW_MGW_UNIT}.service`;
const HNBGW_MGW_CFG_PATH  = `${HOST_OSMOCOM_DIR}/osmo-mgw-hnbgw.cfg`;
const HNBGW_MGW_BIN       = '/usr/bin/osmo-mgw';

interface HnbgwState {
  rncId: number;
  iuhLocalIp: string;
  iuhLocalPort: number;
  // This module's own SCCP/M3UA point-code, and the two peers it needs to
  // know by point-code to route IuCS/IuPS once connected to the STP (which
  // itself accepts HNBGW's own ASP dynamically — see hnbgw-controller.ts's
  // module comment and the config-ownership map in the approved plan for
  // why osmo-stp.cfg/osmo-msc.cfg need no changes for this). mscPointCode
  // defaults to this host's real confirmed live value (0.23.1) — if that
  // ever changes on the MSC side, it must be updated here to match, this
  // module has no way to auto-discover it.
  hnbgwPointCode: string;
  mscPointCode: string;
  sgsnIuPsPointCode: string;
  mgwBindIp: string;
  mgwRtpBindIp: string;
}

const HNBGW_STATE_DEFAULTS: HnbgwState = {
  rncId: 1,
  iuhLocalIp: '0.0.0.0',
  iuhLocalPort: 29169,
  hnbgwPointCode: '0.23.5',
  mscPointCode: '0.23.1',
  sgsnIuPsPointCode: '0.23.4',
  mgwBindIp: '127.0.1.8',
  mgwRtpBindIp: '127.0.1.8',
};

function loadHnbgwState(): HnbgwState {
  try {
    if (fs.existsSync(HOST_STATE)) return { ...HNBGW_STATE_DEFAULTS, ...JSON.parse(fs.readFileSync(HOST_STATE, 'utf-8')) };
  } catch { /* fall through to default */ }
  return { ...HNBGW_STATE_DEFAULTS };
}
function saveHnbgwState(state: HnbgwState): void {
  fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
  fs.writeFileSync(HOST_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

function writeHostCfg(path: string, content: string): void {
  try { if (fs.lstatSync(path).isSymbolicLink()) fs.unlinkSync(path); } catch { /* not there yet */ }
  fs.writeFileSync(path, content, 'utf-8');
}

// NOT the manual's §5.4 example verbatim — that example (and its `plmn`/
// `mgw <n>` directives) is from a newer osmo-hnbgw release than the 1.3.0
// this project actually builds (see HNBGW_TAG's comment for why). Confirmed
// live 2026-09-13 by generating this exact binary's own `--vty-ref-xml` and
// by a real live-start test (see memory umts_3g_hnbgw_module_progress.md):
// 1.3.0's `hnbgw` config node has NO `plmn` command at all — a config with
// one fails to parse and the daemon refuses to start ("There is no such
// command", confirmed live) — presumably PLMN is taken from the HNB's own
// HNBAP registration in this version rather than configured at the gateway.
// The MGW client is also the OLDER, pre-pooling `mgcp` node with flat
// `mgw <directive>`-prefixed commands, not the newer numbered `mgw <n>`
// sub-node the manual shows (its own text warns of exactly this: "Previous
// versions of OsmoHNBGW didn't have the mgw VTY node... historically the
// MGW related commands where placed under the mgcp VTY node").
function osmoHnbgwCfg(state: HnbgwState): string {
  return `log stderr
 logging filter all 1
 logging print category 1
line vty
 no login
cs7 instance 0
 point-code ${state.hnbgwPointCode}
 sccp-address msc
  routing-indicator PC
  point-code ${state.mscPointCode}
 sccp-address sgsn
  routing-indicator PC
  point-code ${state.sgsnIuPsPointCode}
hnbgw
 rnc-id ${state.rncId}
 iuh
  local-ip ${state.iuhLocalIp}
  local-port ${state.iuhLocalPort}
 iucs
  remote-addr msc
 iups
  remote-addr sgsn
 mgcp
  mgw remote-ip ${state.mgwBindIp}
  mgw remote-port 2427
  mgw reset-endpoint rtpbridge/*
`;
}

// Dedicated MGW instance config — deliberately no 2G-style hardcoded SDP
// codec defaults (osmomgwCfg() in gsm-controller.ts sets
// `sdp audio payload name GSM`, correct for that instance's own known
// 2G-only traffic); real 3G Iu-UP codec negotiation hasn't been tested
// live yet (see the approved plan's Phase 3), so this stays at plain RTP-
// bridge defaults until that's confirmed.
//
// Real incident, found live 2026-09-13 on first real Configure: osmo-mgw's
// VTY (line vty) and CTRL interface both default to binding 127.0.0.1 on
// their own compiled-in ports (4243 / 4267) regardless of the mgcp node's
// own bind ip — colliding directly with the 2G module's own already-running
// osmo-mgw instance, which owns those same 127.0.0.1 ports first. osmo-mgw
// treats a failed VTY bind as fatal and exits, so the dedicated instance
// crash-looped (systemd's restart-rate-limit eventually gave up: "Start
// request repeated too quickly"). This is exactly the "Multiple instances"
// guidance OsmoHNBGW's own manual gives for separating VTY/CTRL by binding
// each to its own address (already applied to osmo-hnbgw's own Iuh/VTY) —
// just missed for this second, dedicated MGW instance. Fixed by binding
// both to this instance's own dedicated IP too, not just MGCP/RTP.
function osmoMgwHnbgwCfg(bindIp: string, rtpBindIp: string): string {
  return `line vty
  no login
  bind ${bindIp}
ctrl
  bind ${bindIp}
mgcp
  bind ip ${bindIp}
  rtp port-range 16002 32001
  rtp bind-ip ${rtpBindIp}
  rtp ip-probing
  bind port 2427
  number endpoints 512
  loop 0
  force-realloc 1
  rtcp-omit
`;
}

function hnbgwMgwSystemdUnit(): string {
  return `[Unit]
Description=OsmoMGW (dedicated instance for OsmoHNBGW 3G RTP relay)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=2
ExecStart=${HNBGW_MGW_BIN} -c ${HNBGW_MGW_CFG_PATH}

[Install]
WantedBy=multi-user.target
`;
}

// Config file viewer manifest, same shape/convention as gsm-controller.ts's
// GSM_CONFIG_MANIFEST. osmo-sgsn.cfg is flagged shared — this module only
// owns one directive block inside it (see SGSN_IUPS_OWNED below), the 2G
// module owns the rest.
export interface HnbgwConfigFile {
  path: string; label: string; group: string; language: string;
  restartServices: string[]; exists: boolean;
  shared?: boolean;
  sharedWith?: string;
}
const HNBGW_CONFIG_MANIFEST: Omit<HnbgwConfigFile, 'exists'>[] = [
  { path: HNBGW_CFG_HOST_PATH, label: 'osmo-hnbgw.cfg', group: '3G UMTS', language: 'ini', restartServices: ['osmo-hnbgw'] },
  { path: HNBGW_MGW_CFG_PATH, label: 'osmo-mgw-hnbgw.cfg', group: '3G UMTS', language: 'ini', restartServices: [HNBGW_MGW_UNIT] },
  { path: HNODEB_CFG_HOST_PATH, label: 'osmo-hnodeb.cfg (virtual HNB)', group: '3G UMTS', language: 'ini', restartServices: ['osmo-hnodeb'] },
  {
    path: HOST_SGSN_CFG, label: 'osmo-sgsn.cfg', group: 'Shared with 2G GSM', language: 'ini',
    restartServices: ['osmo-sgsn'], shared: true,
    sharedWith: '2G GPRS/EDGE — this module only owns the cs7/IuPS point-code block inside it (see hnbgw-controller.ts\'s writeSgsnIuPsCs7Block()); everything else is the 2G module\'s own generated content.',
  },
];
const HNBGW_ALLOWED_PATHS = new Set(HNBGW_CONFIG_MANIFEST.map(f => f.path));

// Adds this module's own cs7/point-code block for the IuPS link into
// osmo-sgsn.cfg via ownership-merge — NEVER a full-file write. See the
// approved plan's "Config ownership map": osmo-sgsn.cfg is owned by
// gsm-controller.ts (its own osmosgsnCfg()/writeSgsnCfg()), which was
// itself converted to an ownership-merge specifically so this addition
// can coexist safely. Requires osmo-sgsn.cfg to already exist (i.e. the
// 2G module's GPRS/EDGE must already be configured) — refuses rather than
// writing a broken partial file if it doesn't.
const SGSN_IUPS_OWNED = (pointCode: string): OwnedDirective[] => [
  { node: `cs7 instance 1`, prefix: /^\s*point-code\s+/, line: ` point-code ${pointCode}` },
];

function writeSgsnIuPsCs7Block(sgsnIuPsPointCode: string): { ok: boolean; error?: string } {
  if (!fs.existsSync(HOST_SGSN_CFG)) {
    return { ok: false, error: 'osmo-sgsn.cfg does not exist yet — enable and configure GPRS/EDGE on the 2G GSM page first, then retry.' };
  }
  const current = fs.readFileSync(HOST_SGSN_CFG, 'utf-8');
  const merged = upsertVtyDirectives(current, SGSN_IUPS_OWNED(sgsnIuPsPointCode), current);
  fs.writeFileSync(HOST_SGSN_CFG, merged, 'utf-8');
  return { ok: true };
}

async function regenerateHnbgwConfigs(state: HnbgwState): Promise<{ ok: boolean; error?: string }> {
  fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
  writeHostCfg(HNBGW_CFG_HOST_PATH, osmoHnbgwCfg(state));
  writeHostCfg(HNBGW_MGW_CFG_PATH, osmoMgwHnbgwCfg(state.mgwBindIp, state.mgwRtpBindIp));
  const sgsnResult = writeSgsnIuPsCs7Block(state.sgsnIuPsPointCode);
  return sgsnResult;
}

export function createHnbgwRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const state = loadHnbgwState();
      const build = await verifyOsmoHnbgwBuild();
      const hnodebBuild = await verifyOsmoHnodebBuild();
      const configured = fs.existsSync(HNBGW_CFG_HOST_PATH);
      const services: Record<string, boolean> = {};
      for (const unit of ['osmo-hnbgw', HNBGW_MGW_UNIT, 'osmo-hnodeb']) {
        try {
          const { stdout } = await nsenter('systemctl', ['is-active', unit]);
          services[unit] = stdout.trim() === 'active';
        } catch { services[unit] = false; }
      }
      let hnbList = '';
      if (services['osmo-hnbgw']) {
        try { hnbList = await hnbgwVtyCommand('show hnb all'); } catch { /* VTY not up yet */ }
      }
      res.json({
        success: true, installedOnDisk: build.installed, version: build.version, configured, services, ...state,
        virtualHnbInstalled: hnodebBuild.installed, virtualHnbDeployed: fs.existsSync(HNODEB_CFG_HOST_PATH), hnbListRaw: hnbList,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/hnbgw/install — streams: build osmo-hnbgw from source (see
  // osmo-hnbgw-build.ts's HNBGW_TAG comment for why 1.3.0, not the 1.9.0
  // every other daemon here uses), plus a defensive `apt-get install
  // osmo-mgw` (harmless no-op if the 2G module already installed it — this
  // module's own dedicated MGW instance reuses that same binary).
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const spawnStream = (bashScript: string): Promise<number> => new Promise((resolve) => {
      const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (d: Buffer) => write(d.toString()));
      child.stderr?.on('data', (d: Buffer) => write(d.toString()));
      child.on('close', (code) => resolve(code ?? 1));
    });

    const mgwExitCode = await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get install -y osmo-mgw 2>&1');
    write(mgwExitCode === 0 ? '✅ osmo-mgw present.' : `❌ osmo-mgw install failed (exit ${mgwExitCode}).`);

    write('\n=== Building osmo-hnbgw from source (tag 1.3.0) ===');
    const hnbgwExitCode = await spawnStream(buildOsmoHnbgwScript(req.query.force === '1'));
    write(hnbgwExitCode === 0 ? '✅ osmo-hnbgw built.' : `❌ osmo-hnbgw build FAILED (see errors above).`);

    const ok = mgwExitCode === 0 && hnbgwExitCode === 0;
    await auditLogger.log({ action: 'hnbgw_install', user, details: `mgw exit ${mgwExitCode}, hnbgw exit ${hnbgwExitCode}`, success: ok });
    res.end();
  });

  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const state = loadHnbgwState();
      if (req.body.rncId != null) state.rncId = Number(req.body.rncId);
      state.iuhLocalIp = (req.body.iuhLocalIp as string) || state.iuhLocalIp;
      if (req.body.iuhLocalPort != null) state.iuhLocalPort = Number(req.body.iuhLocalPort);
      state.hnbgwPointCode = (req.body.hnbgwPointCode as string) || state.hnbgwPointCode;
      state.mscPointCode = (req.body.mscPointCode as string) || state.mscPointCode;
      state.sgsnIuPsPointCode = (req.body.sgsnIuPsPointCode as string) || state.sgsnIuPsPointCode;
      state.mgwBindIp = (req.body.mgwBindIp as string) || state.mgwBindIp;
      state.mgwRtpBindIp = (req.body.mgwRtpBindIp as string) || state.mgwRtpBindIp;
      saveHnbgwState(state);

      const result = await regenerateHnbgwConfigs(state);
      if (!result.ok) {
        await auditLogger.log({ action: 'hnbgw_configure', user, details: result.error || 'unknown error', success: false });
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      // Write both systemd units fresh every Configure (cheap, idempotent —
      // matches this project's established pattern elsewhere for per-
      // instance units, e.g. Asterisk-2G's own).
      writeHostCfg(HNBGW_UNIT_PATH.replace('/etc/systemd/system', '/proc/1/root/etc/systemd/system'), osmoHnbgwSystemdUnit());
      writeHostCfg(HNBGW_MGW_UNIT_PATH, hnbgwMgwSystemdUnit());
      await nsenter('systemctl', ['daemon-reload']);
      await nsenter('systemctl', ['enable', '--now', HNBGW_MGW_UNIT]).catch(() => {});
      await nsenter('systemctl', ['restart', HNBGW_MGW_UNIT]).catch(() => {});
      await nsenter('systemctl', ['enable', '--now', 'osmo-hnbgw']).catch(() => {});
      await nsenter('systemctl', ['restart', 'osmo-hnbgw']).catch(() => {});

      await auditLogger.log({ action: 'hnbgw_configure', user, details: `rnc-id ${state.rncId}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'hnbgw_configure', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const unit of [HNBGW_MGW_UNIT, 'osmo-hnbgw']) await nsenter('systemctl', ['start', unit]);
      await auditLogger.log({ action: 'hnbgw_start', user, details: 'hnbgw services started', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const unit of ['osmo-hnbgw', HNBGW_MGW_UNIT]) await nsenter('systemctl', ['stop', unit]);
      await auditLogger.log({ action: 'hnbgw_stop', user, details: 'hnbgw services stopped', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });
  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const unit of [HNBGW_MGW_UNIT, 'osmo-hnbgw']) await nsenter('systemctl', ['restart', unit]);
      await auditLogger.log({ action: 'hnbgw_restart', user, details: 'hnbgw services restarted', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/hnbgw/virtual-hnb — the whole point of osmo-hnodeb (see its
  // own build file's comment): a software HNB for proving the HNBAP/Iuh
  // signaling chain end-to-end without the real nano3G. Direct parallel to
  // GsmPage.tsx's VirtualBtsControl for the 2G module's osmo-bts-virtual.
  // Streamed the same way /install is — the source build alone takes real
  // time, and this is a separate, lazy build (not bundled into the main
  // /install) since it's a test tool, not something every real deployment
  // needs. Requires osmo-hnbgw itself to already be configured and running
  // (it dials out to it, mirroring how a real HNB would).
  router.post('/virtual-hnb/deploy', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (!fs.existsSync(HNBGW_CFG_HOST_PATH)) {
      res.status(400).json({ success: false, error: 'Configure OsmoHNBGW itself first — the virtual HNB dials out to it, same as a real one would.' });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const spawnStream = (bashScript: string): Promise<number> => new Promise((resolve) => {
      const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (d: Buffer) => write(d.toString()));
      child.stderr?.on('data', (d: Buffer) => write(d.toString()));
      child.on('close', (code) => resolve(code ?? 1));
    });

    write('=== Building osmo-hnodeb (virtual HNB) from source (tag 0.1.0) ===');
    const buildExitCode = await spawnStream(buildOsmoHnodebScript(req.query.force === '1'));
    if (buildExitCode !== 0) {
      write(`❌ osmo-hnodeb build FAILED (see errors above).`);
      await auditLogger.log({ action: 'hnbgw_virtual_hnb_deploy', user, details: `build exit ${buildExitCode}`, success: false });
      res.end();
      return;
    }
    write('✅ osmo-hnodeb built.');

    try {
      const state = loadHnbgwState();
      const { mcc, mnc } = readMccMnc();
      const cfg = osmoHnodebCfg(mcc, mnc, '127.0.0.1', state.iuhLocalPort, HNODEB_GTP_LOCAL_IP);
      writeHostCfg(HNODEB_CFG_HOST_PATH, cfg);
      writeHostCfg(HNODEB_UNIT_PATH.replace('/etc/systemd/system', '/proc/1/root/etc/systemd/system'), osmoHnodebSystemdUnit());
      await nsenter('systemctl', ['daemon-reload']);
      await nsenter('systemctl', ['enable', '--now', 'osmo-hnodeb']);
      write('✅ Virtual HNB deployed and started — check the RAN page or `show hnb all` shortly to confirm it registered.');
      await auditLogger.log({ action: 'hnbgw_virtual_hnb_deploy', user, details: 'deployed', success: true });
    } catch (err) {
      write(`❌ Deploy failed: ${String(err)}`);
      await auditLogger.log({ action: 'hnbgw_virtual_hnb_deploy', user, details: String(err), success: false });
    }
    res.end();
  });

  router.post('/virtual-hnb/remove', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['disable', '--now', 'osmo-hnodeb']).catch(() => {});
      await nsenter('rm', ['-f', HNODEB_UNIT_PATH]).catch(() => {});
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});
      try { fs.unlinkSync(HNODEB_CFG_HOST_PATH); } catch { /* may not exist */ }
      await auditLogger.log({ action: 'hnbgw_virtual_hnb_remove', user, details: 'removed', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'hnbgw_virtual_hnb_remove', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Uninstall deliberately does NOT touch osmo-sgsn.cfg's shared cs7
  // content beyond removing this module's own IuPS point-code directive —
  // never purges osmo-mgw (shared apt package with the 2G module) or
  // touches osmo-stp/osmo-msc at all, matching the approved plan's
  // ownership map.
  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      for (const unit of ['osmo-hnbgw', HNBGW_MGW_UNIT, 'osmo-hnodeb']) {
        await nsenter('systemctl', ['disable', '--now', unit]).catch(() => {});
      }
      for (const path of [HNBGW_UNIT_PATH, HNBGW_MGW_UNIT_PATH.replace('/proc/1/root', ''), HNODEB_UNIT_PATH]) {
        await nsenter('rm', ['-f', path]).catch(() => {});
      }
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});
      try { fs.unlinkSync(HNBGW_CFG_HOST_PATH); } catch { /* may not exist */ }
      try { fs.unlinkSync(HNBGW_MGW_CFG_PATH); } catch { /* may not exist */ }
      try { fs.unlinkSync(HNODEB_CFG_HOST_PATH); } catch { /* may not exist */ }
      if (fs.existsSync(HOST_SGSN_CFG)) {
        const current = fs.readFileSync(HOST_SGSN_CFG, 'utf-8');
        const withoutIups = upsertVtyDirectives(
          current,
          [{ node: 'cs7 instance 1', prefix: /^\s*point-code\s+/, line: null }],
          current,
        );
        fs.writeFileSync(HOST_SGSN_CFG, withoutIups, 'utf-8');
      }
      await auditLogger.log({ action: 'hnbgw_uninstall', user, details: 'osmo-hnbgw + dedicated mgw removed', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'hnbgw_uninstall', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ─── Config file editor (mirrors gsm-controller.ts's /configs endpoints) ──
  router.get('/configs', async (_req: Request, res: Response) => {
    const files: HnbgwConfigFile[] = HNBGW_CONFIG_MANIFEST.map(f => ({ ...f, exists: fs.existsSync(f.path) }));
    res.json({ success: true, files });
  });

  router.get('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const path = req.query.path as string;
    if (!HNBGW_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
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
    if (!HNBGW_ALLOWED_PATHS.has(path)) { res.status(403).json({ success: false, error: 'path not allowed' }); return; }
    try {
      fs.mkdirSync(HOST_OSMOCOM_DIR, { recursive: true });
      fs.writeFileSync(path, content, 'utf-8');
      await auditLogger.log({ action: 'hnbgw_config_save', user, details: path, success: true });
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
      await auditLogger.log({ action: 'hnbgw_config_restart', user, details: services.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
