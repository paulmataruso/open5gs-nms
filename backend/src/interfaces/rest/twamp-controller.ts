import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { Db, ObjectId } from 'mongodb';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { requireAdmin } from './middleware/auth-middleware';
import { getAppVersion } from '../../infrastructure/system/app-version';
import {
  HOST_ROOT, TWAMP_DIR, TWAMP_SRC, TWAMP_BIN,
  TWAMP_SERVER_SRC, TWAMP_SERVER_BIN, TWAMP_SERVER_UNIT, TWAMP_SERVER_UNIT_PATH, TWAMP_SERVER_METRICS_ADDR,
  TWAMP_SERVER_LIGHT_PEERS_ADDR,
  GO_VERSION, isTwampInstalled, isTwampServerInstalled, runTwampTest, TwampMode, TwampProtocol,
  readTwampState, writeTwampState, getFullConnections, getLightPeers, HOST_TWAMP_STATE,
} from '../../application/use-cases/twamp/twamp-runner';
import { TwampMonitor, TwampTargetDoc, TWAMP_TARGETS_COLLECTION } from '../../application/use-cases/twamp/twamp-monitor';
import {
  DEFAULT_HISTORY_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS,
  ensureHistoryIndexes, recordTwampHistorySample, queryHistorySummary, queryHistorySeries, pickBucketMs,
} from '../../application/use-cases/twamp/twamp-history';

// ── TWAMP reflector testing ──────────────────────────────────────────────────
//
// The Nokia AirScale radios on this deployment have a built-in TWAMP (RFC
// 5357) reflector — the CLIENT side of this module (twamp-client.go) measures
// real backhaul RTT/jitter/one-way-delay/packet-loss against it (and any
// other TWAMP reflector an operator points it at — built generic, not
// Nokia-specific). The SERVER side (twamp-server.go) is the reverse
// direction: some TWAMP-capable devices (possibly including these radios)
// can themselves act as the client and test INBOUND against a reflector we
// host — this module can optionally run one.
//
// github.com/ncode/twamp is a Go LIBRARY (client + reflector-server
// packages), not a standalone CLI — there's no cmd/ to `go install`. This
// module compiles its own thin wrappers against it (twamp-templates/
// twamp-client.go + twamp-server.go, written to disk at Install time), the
// same shape as mms-controller.ts's mm1-msisdn-proxy.go, just with a real
// module dependency (its own go.mod) instead of pure stdlib.
//
// The client side is notably simpler than every other add-on module here —
// a TWAMP test is a short-lived connect-test-disconnect operation (~10s),
// not a persistent service. The server side is the opposite: a real
// always-listening TCP+UDP service, so it gets its own systemd unit
// (twamp-server.service), generated with its config flags baked directly
// into ExecStart (no separate config file — few enough values that a config
// file would be pure overhead).
//
// Bind IP: this host is multi-homed (several RAN-facing subnets on
// different interfaces) — github.com/ncode/twamp's public API has no
// LocalAddr-equivalent option for either the control connection or the test
// socket (confirmed by reading client.go/test_session.go), so
// patch-bind-ip.py patches the vendored source directly to read a
// TWAMP_BIND_IP env var, which twamp-client.go's own -bind-ip flag sets.
// This requires `go mod vendor` (not just `go get`) so there's a local copy
// to patch.

const TWAMP_CLIENT_GO_TEMPLATE = `${__dirname}/../../config/twamp-templates/twamp-client.go`;
const TWAMP_SERVER_GO_TEMPLATE = `${__dirname}/../../config/twamp-templates/twamp-server.go`;
const TWAMP_PATCH_SCRIPT_TEMPLATE = `${__dirname}/../../config/twamp-templates/patch-bind-ip.py`;

function serverSystemdUnit(execArgs: string): string {
  return `[Unit]
Description=TWAMP Server (Reflector)
After=network.target

[Service]
Type=simple
ExecStart=${TWAMP_SERVER_BIN} ${execArgs}
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Minimal Prometheus text-exposition-format parser — just enough to render
// every twamp_* series as a generic table (name/labels/value) for the Info
// & Stats page. Not a general-purpose parser (no #TYPE/#HELP handling
// needed, we're displaying raw numbers, not re-exposing them as our own
// metrics), so a small hand-rolled regex is preferable to a real dependency
// for this.
interface ParsedMetric { metric: string; labels: Record<string, string>; value: number }
function parsePrometheusText(text: string): ParsedMetric[] {
  const results: ParsedMetric[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(\w+)(\{([^}]*)\})?\s+([-\d.eE+]+)\s*$/);
    if (!match) continue;
    const [, metric, , labelStr, valueStr] = match;
    const labels: Record<string, string> = {};
    if (labelStr) {
      for (const pair of labelStr.split(',')) {
        const kv = pair.match(/^(\w+)="([^"]*)"$/);
        if (kv) labels[kv[1]] = kv[2];
      }
    }
    results.push({ metric, labels, value: parseFloat(valueStr) });
  }
  return results;
}

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same install logic in-process — write() is the only side-channel.
export async function installTwamp(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

    try {
      write(`=== Ensuring Go ${GO_VERSION}+ toolchain ===`);
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
        `  curl -fsSL -o /tmp/go-twamp.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-$GOARCH.tar.gz"\n` +
        `  rm -rf /usr/local/go\n` +
        `  tar -C /usr/local -xzf /tmp/go-twamp.tar.gz\n` +
        `  rm -f /tmp/go-twamp.tar.gz\n` +
        `  echo "Installed: $(/usr/local/go/bin/go version)"\n` +
        `else\n` +
        `  echo "Already have: $(/usr/local/go/bin/go version)"\n` +
        `fi`
      );
      if (goExit !== 0) {
        write(`\n❌ Go toolchain setup failed (exit ${goExit}).`);
        return { success: false, error: `go setup exit ${goExit}` };
      }

      write('\n=== Writing twamp-client.go, twamp-server.go, and the bind-IP patch script ===');
      fs.mkdirSync(`${HOST_ROOT}${TWAMP_DIR}`, { recursive: true });
      fs.writeFileSync(`${HOST_ROOT}${TWAMP_SRC}`, fs.readFileSync(TWAMP_CLIENT_GO_TEMPLATE, 'utf-8'), 'utf-8');
      fs.writeFileSync(`${HOST_ROOT}${TWAMP_SERVER_SRC}`, fs.readFileSync(TWAMP_SERVER_GO_TEMPLATE, 'utf-8'), 'utf-8');
      fs.writeFileSync(`${HOST_ROOT}${TWAMP_DIR}/patch-bind-ip.py`, fs.readFileSync(TWAMP_PATCH_SCRIPT_TEMPLATE, 'utf-8'), 'utf-8');

      write('\n=== Building (go mod init + go get + go mod vendor + patch + go build ×2) ===');
      const buildExit = await spawnStream(
        `set -e\n` +
        `export PATH=/usr/local/go/bin:$PATH\n` +
        `export GOCACHE=${TWAMP_DIR}/.gocache\n` +
        `export GOMODCACHE=${TWAMP_DIR}/.gomodcache\n` +
        `cd ${TWAMP_DIR}\n` +
        `[ -f go.mod ] || go mod init twamp-client\n` +
        `go get github.com/ncode/twamp@latest\n` +
        // go get alone only records the direct dependency's go.sum entry —
        // confirmed live: a bare `go build` right after it fails with
        // "missing go.sum entry" for ncode/twamp's own transitive deps
        // (golang.org/x/sys, golang.org/x/crypto, prometheus/client_golang).
        // go mod tidy resolves the full graph (and, confirmed live, actually
        // settles on a LOWER minimum-version set than a naive `go get
        // @latest` alone triggers — it stayed on the already-installed
        // GO_VERSION here rather than auto-downloading a newer toolchain
        // mid-build, which is the whole reason this project pins Go
        // versions rather than relying on that auto-download on a
        // restricted-egress host).
        `go mod tidy\n` +
        // go mod vendor: the library's public API has no bind-IP option —
        // see patch-bind-ip.py's own header comment for the full why. We
        // need an editable local copy of the source to patch, hence vendor
        // rather than building straight from the module cache.
        `go mod vendor\n` +
        `python3 patch-bind-ip.py\n` +
        `go build -mod=vendor -o ${TWAMP_BIN} ${TWAMP_SRC}\n` +
        `go build -mod=vendor -o ${TWAMP_SERVER_BIN} ${TWAMP_SERVER_SRC}`
      );
      if (buildExit !== 0) {
        write(`\n❌ Build failed (exit ${buildExit}).`);
        return { success: false, error: `build exit ${buildExit}` };
      }

      writeTwampState({ ...(readTwampState() ?? {}), installedWithVersion: getAppVersion() });
      write('\n✅ twamp-client and twamp-server installed. Add a target below to start testing, or configure the reflector if you need it to accept inbound tests.');
      return { success: true };
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      return { success: false, error: String(err) };
    }
}

// Extracted so the cross-module Fix-All orchestrator (module-fixall-usecase.ts) can
// invoke the same server-configure logic in-process, always passing the last-saved
// values explicitly rather than an empty body — re-running Configure with defaults
// would silently reset real per-deployment values (e.g. back to 0.0.0.0:862, unauthenticated).
export async function configureTwampServer(
  input: {
    listenIp?: string; listenPort?: number; enableFull?: boolean; enableLight?: boolean; modes?: TwampMode[];
    secretKeyId?: string; secretValue?: string; allowCidrs?: string[];
  },
  hostExecutor: IHostExecutor,
): Promise<{ success: boolean; error?: string }> {
    if (!isTwampServerInstalled()) {
      return { success: false, error: 'twamp-server is not installed yet — run Install first.' };
    }
    const { listenIp, listenPort, enableFull, enableLight, modes, secretKeyId, secretValue, allowCidrs } = input;
    const validModes: TwampMode[] = ['unauthenticated', 'authenticated', 'encrypted'];
    const resolvedModes = Array.isArray(modes) ? modes.filter(m => validModes.includes(m)) : [];
    if (resolvedModes.length === 0) resolvedModes.push('unauthenticated');
    const resolvedListenIp = listenIp && listenIp.trim() ? listenIp.trim() : '0.0.0.0';
    const resolvedPort = Number.isInteger(listenPort) && listenPort! > 0 ? listenPort! : 862;
    // Default both on — an operator accepting inbound tests generally wants
    // to answer whichever protocol variant the far end actually speaks,
    // same reasoning as the per-target protocol choice on the client side.
    const resolvedEnableFull = enableFull !== false;
    const resolvedEnableLight = enableLight !== false;
    if (!resolvedEnableFull && !resolvedEnableLight) {
      return { success: false, error: 'At least one of full TWAMP-Control or TWAMP-Light must be enabled.' };
    }

    try {
      const execArgsParts = [
        '-listen', shellQuote(`${resolvedListenIp}:${resolvedPort}`),
        // Go's flag package does NOT treat a following space-separated token
        // as a bool flag's value (only non-bool flags consume the next
        // arg) — `-full-enabled false` parses as `-full-enabled=true` and
        // then aborts flag parsing entirely on the stray `false` token, so
        // the intended value is silently ignored. Confirmed live 2026-08-24:
        // a saved config with Full explicitly disabled still started the
        // TCP full-protocol listener. Must use `=` syntax for bools.
        `-full-enabled=${resolvedEnableFull}`,
        `-light-enabled=${resolvedEnableLight}`,
        '-modes', shellQuote(resolvedModes.join(',')),
      ];
      if (secretKeyId && secretValue) {
        execArgsParts.push('-secrets', shellQuote(`${secretKeyId}:${secretValue}`));
      }
      const cleanCidrs = (allowCidrs ?? []).map(c => c.trim()).filter(Boolean);
      if (cleanCidrs.length > 0) {
        execArgsParts.push('-allow-cidrs', shellQuote(cleanCidrs.join(',')));
      }

      fs.writeFileSync(`${HOST_ROOT}${TWAMP_SERVER_UNIT_PATH}`, serverSystemdUnit(execArgsParts.join(' ')), 'utf-8');
      await hostExecutor.executeCommand('systemctl', ['daemon-reload']);
      await hostExecutor.executeCommand('systemctl', ['enable', '--now', TWAMP_SERVER_UNIT]);
      // Config is baked into ExecStart, not hot-reloadable — a Configure
      // re-run always restarts to pick up the new args, same reasoning as
      // every other module's config-file-based restart-on-Configure.
      await hostExecutor.executeCommand('systemctl', ['restart', TWAMP_SERVER_UNIT]);

      const prevState = readTwampState() ?? {};
      writeTwampState({
        ...prevState,
        server: {
          configuredWithVersion: getAppVersion(),
          listenIp: resolvedListenIp,
          listenPort: resolvedPort,
          enableFull: resolvedEnableFull,
          enableLight: resolvedEnableLight,
          modes: resolvedModes,
          secretKeyId: secretKeyId || undefined,
          secretValue: secretValue || undefined,
          allowCidrs: cleanCidrs,
        },
      });

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
}

export interface TwampClientStalenessResult {
  installed: boolean;
  installStale: boolean;
  installedWithVersion?: string;
}

// Cheap staleness check for the cross-module Fix-All aggregator, client/install side.
export function getTwampClientStaleness(): TwampClientStalenessResult {
  const installed = isTwampInstalled();
  const state = readTwampState();
  const appVersion = getAppVersion();
  const installStale = installed && state?.installedWithVersion !== appVersion;
  return { installed, installStale, installedWithVersion: state?.installedWithVersion };
}

export interface TwampServerStalenessResult {
  installed: boolean;
  hasSavedConfig: boolean;
  configStale: boolean;
  configuredWithVersion?: string;
}

// Cheap staleness check for the cross-module Fix-All aggregator, server/reflector side.
export function getTwampServerStaleness(): TwampServerStalenessResult {
  const installed = isTwampServerInstalled();
  const state = readTwampState();
  const appVersion = getAppVersion();
  const configStale = !!state?.server && state.server.configuredWithVersion !== appVersion;
  return {
    installed,
    hasSavedConfig: !!state?.server,
    configStale,
    configuredWithVersion: state?.server?.configuredWithVersion,
  };
}

export function createTwampRouter(
  db: Db,
  hostExecutor: IHostExecutor,
  twampMonitor: TwampMonitor,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();
  const col = () => db.collection<TwampTargetDoc>(TWAMP_TARGETS_COLLECTION);

  // Ensure the history TTL index exists (at whatever retention was last
  // saved, or the default) on every startup — this is the only lifecycle
  // this needs, no separate init step, matching this module's overall
  // "install just builds a binary, no extra setup" simplicity.
  ensureHistoryIndexes(db, readTwampState()?.history?.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS)
    .catch(err => logger.error({ err: String(err) }, 'failed to ensure twamp history indexes'));

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const installed = isTwampInstalled();
      const state = readTwampState();
      const appVersion = getAppVersion();
      const installStale = installed && state?.installedWithVersion !== appVersion;
      res.json({
        success: true,
        installed,
        installedWithVersion: state?.installedWithVersion,
        installStale,
        appVersion,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'twamp status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/twamp/install — streamed: Go toolchain + our own go.mod
  // pulling in github.com/ncode/twamp, vendored + patched for bind-IP
  // support, then builds BOTH twamp-client and twamp-server from that same
  // shared module. Idempotent/safe to re-run.
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };
    const result = await installTwamp(write);
    await auditLogger.log({ action: 'twamp_install', user, details: result.error ?? 'success', success: result.success });
    res.end();
  });

  router.post('/uninstall', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      if (isTwampServerInstalled() || fs.existsSync(`${HOST_ROOT}${TWAMP_SERVER_UNIT_PATH}`)) {
        await hostExecutor.executeCommand('systemctl', ['disable', '--now', TWAMP_SERVER_UNIT]).catch(() => ({} as any));
        await hostExecutor.executeCommand('rm', ['-f', TWAMP_SERVER_UNIT_PATH]);
        await hostExecutor.executeCommand('systemctl', ['daemon-reload']);
      }
      await hostExecutor.executeCommand('rm', ['-rf', TWAMP_DIR]);
      if (fs.existsSync(HOST_TWAMP_STATE)) fs.unlinkSync(HOST_TWAMP_STATE);
      await auditLogger.log({ action: 'twamp_uninstall', user, details: 'success', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'twamp_uninstall', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── Targets (client side) ───────────────────────────────────────────────

  router.get('/targets', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const targets = await col().find({}).sort({ createdAt: 1 }).toArray();
      const latest = await twampMonitor.getLatestResults();
      const latestByName = new Map(latest.map(r => [r.targetId, r]));
      const data = targets.map(t => ({ ...t, latest: latestByName.get(String(t._id)) ?? null }));
      res.json({ success: true, data });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to list twamp targets');
      res.status(500).json({ success: false, error: 'Failed to list targets' });
    }
  });

  router.post('/targets', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { name, host, port, protocol, mode, sharedSecret, keyId, packetCount, pollIntervalSeconds, enabled, bindIp } = req.body;
    if (!name || typeof name !== 'string' || !host || typeof host !== 'string') {
      return res.status(400).json({ success: false, error: 'name and host are required' });
    }
    const validModes: TwampMode[] = ['unauthenticated', 'authenticated', 'encrypted'];
    const resolvedMode: TwampMode = validModes.includes(mode) ? mode : 'unauthenticated';
    const resolvedProtocol: TwampProtocol = protocol === 'light' ? 'light' : 'full';
    try {
      const doc = {
        name: name.trim(),
        host: host.trim(),
        port: Number.isInteger(port) && port > 0 ? port : 862,
        protocol: resolvedProtocol,
        mode: resolvedMode,
        sharedSecret: sharedSecret || undefined,
        keyId: keyId || undefined,
        packetCount: Number.isInteger(packetCount) && packetCount > 0 ? packetCount : 10,
        bindIp: bindIp || undefined,
        pollIntervalSeconds: Number.isInteger(pollIntervalSeconds) && pollIntervalSeconds > 0 ? pollIntervalSeconds : 60,
        enabled: enabled !== false,
        createdAt: Date.now(),
      };
      const result = await col().insertOne(doc as any);
      await auditLogger.log({ action: 'twamp_target_create', user, details: `name=${doc.name} host=${doc.host}:${doc.port}`, success: true });
      res.json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to create twamp target');
      res.status(500).json({ success: false, error: 'Failed to create target' });
    }
  });

  router.put('/targets/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'Invalid id' }); }
    const { name, host, port, protocol, mode, sharedSecret, keyId, packetCount, pollIntervalSeconds, enabled, bindIp } = req.body;
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = String(name).trim();
    if (host !== undefined) update.host = String(host).trim();
    if (port !== undefined) update.port = port;
    if (protocol !== undefined) update.protocol = protocol === 'light' ? 'light' : 'full';
    if (mode !== undefined) update.mode = mode;
    if (sharedSecret !== undefined) update.sharedSecret = sharedSecret || undefined;
    if (keyId !== undefined) update.keyId = keyId || undefined;
    if (packetCount !== undefined) update.packetCount = packetCount;
    if (bindIp !== undefined) update.bindIp = bindIp || undefined;
    if (pollIntervalSeconds !== undefined) update.pollIntervalSeconds = pollIntervalSeconds;
    if (enabled !== undefined) update.enabled = enabled;
    try {
      await col().updateOne({ _id: id }, { $set: update });
      await auditLogger.log({ action: 'twamp_target_update', user, details: `id=${req.params.id}`, success: true });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to update twamp target');
      res.status(500).json({ success: false, error: 'Failed to update target' });
    }
  });

  router.delete('/targets/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'Invalid id' }); }
    try {
      await col().deleteOne({ _id: id });
      await auditLogger.log({ action: 'twamp_target_delete', user, details: `id=${req.params.id}`, success: true });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to delete twamp target');
      res.status(500).json({ success: false, error: 'Failed to delete target' });
    }
  });

  // POST /api/twamp/targets/:id/test — on-demand, synchronous (a 10-packet
  // test is ~10-12s, well inside a normal request timeout — no need for the
  // streamed/chunked pattern every install endpoint uses).
  router.post('/targets/:id/test', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    if (!isTwampInstalled()) {
      return res.status(400).json({ success: false, error: 'twamp-client is not installed yet — install it above first.' });
    }
    let id: ObjectId;
    try { id = new ObjectId(req.params.id); } catch { return res.status(400).json({ success: false, error: 'Invalid id' }); }
    try {
      const target = await col().findOne({ _id: id });
      if (!target) return res.status(404).json({ success: false, error: 'Target not found' });
      const result = await runTwampTest(hostExecutor, target);
      await auditLogger.log({
        action: 'twamp_test', user,
        details: `target=${target.name} success=${result.success}`,
        success: result.success,
      });
      recordTwampHistorySample(db, target, result)
        .catch(err => logger.error({ err: String(err) }, 'failed to record twamp history sample'));
      res.json(result);
    } catch (err) {
      logger.error({ err: String(err) }, 'twamp on-demand test error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── History (long-term, all targets) ────────────────────────────────────

  router.get('/history/settings', requireAdmin, async (_req: Request, res: Response) => {
    const retentionDays = readTwampState()?.history?.retentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS;
    res.json({ success: true, retentionDays });
  });

  router.put('/history/settings', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { retentionDays } = req.body as { retentionDays?: number };
    if (!Number.isFinite(retentionDays) || retentionDays! < MIN_RETENTION_DAYS || retentionDays! > MAX_RETENTION_DAYS) {
      return res.status(400).json({ success: false, error: `retentionDays must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}` });
    }
    try {
      await ensureHistoryIndexes(db, retentionDays!);
      writeTwampState({ ...(readTwampState() ?? {}), history: { retentionDays: retentionDays! } });
      await auditLogger.log({ action: 'twamp_history_settings_update', user, details: `retentionDays=${retentionDays}`, success: true });
      res.json({ success: true, retentionDays });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to update twamp history retention');
      await auditLogger.log({ action: 'twamp_history_settings_update', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/history/summary', requireAdmin, async (req: Request, res: Response) => {
    try {
      const toMs = req.query.toMs ? Number(req.query.toMs) : Date.now();
      const fromMs = req.query.fromMs ? Number(req.query.fromMs) : toMs - 24 * 60 * 60 * 1000;
      const data = await queryHistorySummary(db, new Date(fromMs), new Date(toMs));
      res.json({ success: true, data });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to query twamp history summary');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/history/series', requireAdmin, async (req: Request, res: Response) => {
    try {
      const targetId = req.query.targetId as string | undefined;
      if (!targetId) return res.status(400).json({ success: false, error: 'targetId is required' });
      const toMs = req.query.toMs ? Number(req.query.toMs) : Date.now();
      const fromMs = req.query.fromMs ? Number(req.query.fromMs) : toMs - 24 * 60 * 60 * 1000;
      const bucketMs = pickBucketMs(Math.max(1, toMs - fromMs));
      const data = await queryHistorySeries(db, targetId, new Date(fromMs), new Date(toMs), bucketMs);
      res.json({ success: true, bucketMs, data });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to query twamp history series');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── Server (reflector) ──────────────────────────────────────────────────
  // Gated on "installed" (isTwampServerInstalled), never on "configured" —
  // see CLAUDE.md's UI convention note on this exact gotcha (a real bug
  // elsewhere in this project came from getting this backwards).

  router.get('/server/status', async (_req: Request, res: Response) => {
    try {
      const installed = isTwampServerInstalled();
      const serviceActiveRes = await hostExecutor.executeCommand('systemctl', ['is-active', TWAMP_SERVER_UNIT]).catch(() => null);
      const serviceActive = serviceActiveRes?.stdout.trim() === 'active';
      const state = readTwampState();
      const appVersion = getAppVersion();
      const configStale = !!state?.server && state.server.configuredWithVersion !== appVersion;
      res.json({
        success: true,
        installed,
        serviceActive,
        hasSavedConfig: !!state?.server,
        currentConfig: state?.server ? {
          listenIp: state.server.listenIp,
          listenPort: state.server.listenPort,
          enableFull: state.server.enableFull,
          enableLight: state.server.enableLight,
          modes: state.server.modes,
          secretKeyId: state.server.secretKeyId,
          hasSecret: !!state.server.secretValue,
          allowCidrs: state.server.allowCidrs ?? [],
        } : undefined,
        appVersion,
        configuredWithVersion: state?.server?.configuredWithVersion,
        configStale,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'twamp server status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/server/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const result = await configureTwampServer(req.body, hostExecutor);
    if (!result.success) {
      logger.error({ error: result.error }, 'twamp server configure error');
      await auditLogger.log({ action: 'twamp_server_configure', user, details: result.error ?? 'failed', success: false });
      return res.status(400).json({ success: false, error: result.error });
    }
    await auditLogger.log({ action: 'twamp_server_configure', user, details: 'configured', success: true });
    res.json({ success: true });
  });

  router.post('/server/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await hostExecutor.executeCommand('systemctl', ['start', TWAMP_SERVER_UNIT]);
      await auditLogger.log({ action: 'twamp_server_start', user, details: 'started', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/server/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await hostExecutor.executeCommand('systemctl', ['stop', TWAMP_SERVER_UNIT]);
      await auditLogger.log({ action: 'twamp_server_stop', user, details: 'stopped', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/server/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await hostExecutor.executeCommand('systemctl', ['restart', TWAMP_SERVER_UNIT]);
      await auditLogger.log({ action: 'twamp_server_restart', user, details: 'restarted', success: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/twamp/server/connections — merges real TCP peers (full
  // protocol, via `ss`) with recently-seen UDP senders (TWAMP-Light, via
  // twamp-server.go's own in-process tracking) — see getFullConnections()/
  // getLightPeers()'s own comments for why these need two entirely
  // different data sources.
  router.get('/server/connections', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const state = readTwampState();
      const port = state?.server?.listenPort;
      if (!port) return res.json({ success: true, data: [] });
      const [full, light] = await Promise.all([
        state?.server?.enableFull ? getFullConnections(hostExecutor, port) : Promise.resolve([]),
        state?.server?.enableLight ? getLightPeers(hostExecutor) : Promise.resolve([]),
      ]);
      res.json({ success: true, data: [...full, ...light] });
    } catch (err) {
      logger.error({ err: String(err) }, 'twamp server connections error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/twamp/server/metrics — proxies the reflector's own internal,
  // loopback-only Prometheus endpoint (twamp-server.go's -metrics-addr) —
  // real counters/gauges the github.com/ncode/twamp library already tracks
  // (sessions, packets, errors, by mode/role), not something we compute
  // ourselves. Not merged into this backend's own /metrics — deliberately
  // kept separate since these are the reflector's OWN process metrics, for
  // the Info & Stats page's human-readable table, not a Grafana time series.
  router.get('/server/metrics', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await hostExecutor.executeCommand('curl', ['-fsS', `http://${TWAMP_SERVER_METRICS_ADDR}/metrics`], 5000);
      if (result.exitCode !== 0) {
        return res.json({ success: true, available: false, data: [] });
      }
      const data = parsePrometheusText(result.stdout).filter(m => m.metric.startsWith('twamp_'));
      res.json({ success: true, available: true, data });
    } catch (err) {
      logger.error({ err: String(err) }, 'twamp server metrics error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
