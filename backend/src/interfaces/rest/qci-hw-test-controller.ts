import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { GetInterfaceStatus } from '../../application/use-cases/interface-status/get-interface-status';
import { ImsTestNumberManager } from './ims-test-number-controller';
import { describeBearerCause } from '../../application/use-cases/major-event-classifier';
import { HOST_ROOT } from '../../application/use-cases/twamp/twamp-runner';
import {
  QCI_HW_TEST_DIR, QCI_HW_TEST_SRC, QCI_HW_TEST_BIN, QCI_HW_TEST_CSHIM_DIR,
  OPEN5GS_SRC_DIR, GO_VERSION,
  isQciHwTestBuilt, isOpen5gsSrcTreeAvailable, runQciHwTest,
} from '../../application/use-cases/ran/qci-hw-test-runner';
import { requireAdmin } from './middleware/auth-middleware';

// ── QCI / dedicated-bearer hardware test — real radio, operator-triggered ────
//
// Not a scheduled/background test: admission-control support genuinely
// varies by radio and by QCI, and there is no way to make a REAL bearer
// request happen against REAL hardware without a real UE (a real phone)
// actually attached to that radio placing a real call — see the design
// discussion in PROJECT_STATE.md (2026-08-30). So this is entirely
// operator-driven: pick a radio, confirm your own phone is on it (the
// backend re-checks this, not just the UI), pick a QCI, dial the IMS Test
// Number shown, and this reports exactly what the real radio's own
// admission control decided.

const MAIN_GO_TEMPLATE = `${__dirname}/../../config/qci-hw-test-templates/main.go`;
const CSHIM_TEMPLATE_DIR = `${__dirname}/../../config/qci-hw-test-templates/cshim`;
const TEST_TIMEOUT_MS = 90_000;

function spawnStream(bashScript: string, write: (s: string) => void): Promise<number> {
  return new Promise(resolve => {
    const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--', 'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => write(d.toString()));
    child.stderr.on('data', (d: Buffer) => write(d.toString()));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// Extracted so module-fixall-usecase.ts could invoke it in-process later, matching
// every other module's install() shape in this codebase — write() is the only
// side-channel.
export async function installQciHwTest(write: (s: string) => void): Promise<{ success: boolean; error?: string }> {
  if (!isOpen5gsSrcTreeAvailable()) {
    const msg = `Open5GS's own compiled S1AP codec was not found under ${OPEN5GS_SRC_DIR} — this feature needs Open5GS built from source with its dev artifacts (headers + .so files) still present, not a packaged/stripped install. Set the OPEN5GS_SRC_DIR env var if it lives somewhere else on this host.`;
    write(`\n❌ ${msg}`);
    return { success: false, error: msg };
  }

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
      `  curl -fsSL -o /tmp/go-qci-hw-test.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-$GOARCH.tar.gz"\n` +
      `  rm -rf /usr/local/go\n` +
      `  tar -C /usr/local -xzf /tmp/go-qci-hw-test.tar.gz\n` +
      `  rm -f /tmp/go-qci-hw-test.tar.gz\n` +
      `  echo "Installed: $(/usr/local/go/bin/go version)"\n` +
      `else\n` +
      `  echo "Already have: $(/usr/local/go/bin/go version)"\n` +
      `fi`,
      write,
    );
    if (goExit !== 0) {
      write(`\n❌ Go toolchain setup failed (exit ${goExit}).`);
      return { success: false, error: `go setup exit ${goExit}` };
    }

    write('\n=== Writing main.go + cshim (Open5GS S1AP codec bridge) ===');
    fs.mkdirSync(`${HOST_ROOT}${QCI_HW_TEST_CSHIM_DIR}`, { recursive: true });
    fs.writeFileSync(`${HOST_ROOT}${QCI_HW_TEST_SRC}`, fs.readFileSync(MAIN_GO_TEMPLATE, 'utf-8'), 'utf-8');
    for (const f of ['cgo.go', 'shim.c', 'shim.h']) {
      let content = fs.readFileSync(`${CSHIM_TEMPLATE_DIR}/${f}`, 'utf-8');
      content = content.split('__OPEN5GS_SRC_DIR__').join(OPEN5GS_SRC_DIR);
      fs.writeFileSync(`${HOST_ROOT}${QCI_HW_TEST_CSHIM_DIR}/${f}`, content, 'utf-8');
    }

    write('\n=== Building (go mod init + go get + go build, cgo enabled) ===');
    const buildExit = await spawnStream(
      `set -e\n` +
      `export PATH=/usr/local/go/bin:$PATH\n` +
      `export GOCACHE=${QCI_HW_TEST_DIR}/.gocache\n` +
      `export GOMODCACHE=${QCI_HW_TEST_DIR}/.gomodcache\n` +
      `export CGO_ENABLED=1\n` +
      `cd ${QCI_HW_TEST_DIR}\n` +
      `[ -f go.mod ] || go mod init qcihwtest\n` +
      `go get github.com/florianl/go-nfqueue/v2@v2.1.0\n` +
      `go build -o ${QCI_HW_TEST_BIN} ${QCI_HW_TEST_SRC}`,
      write,
    );
    if (buildExit !== 0) {
      write(`\n❌ Build failed (exit ${buildExit}).`);
      return { success: false, error: `build exit ${buildExit}` };
    }

    write('\n✅ qci-hw-test built. Select a radio and QCI on the Validation page to run a real test.');
    return { success: true };
  } catch (err) {
    write(`\n❌ Install error: ${String(err)}`);
    return { success: false, error: String(err) };
  }
}

let testRunning = false;

// Reached from the Validation page's Force Cleanup button (this tool has no dedicated
// "End Test" button) — resets the in-memory running-guard in case a request was
// abandoned client-side without the server-side promise ever settling.
export function resetQciHwTestRunningFlag(): void {
  testRunning = false;
}

export const createQciHwTestRouter = (
  getInterfaceStatus: GetInterfaceStatus,
  imsTestNumberManager: ImsTestNumberManager,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router => {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    res.json({
      success: true,
      built: isQciHwTestBuilt(),
      open5gsSrcAvailable: isOpen5gsSrcTreeAvailable(),
      open5gsSrcDir: OPEN5GS_SRC_DIR,
      running: testRunning,
    });
  });

  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (s: string) => res.write(s);
    const result = await installQciHwTest(write);
    await auditLogger.log({ action: 'qci_hw_test_install', user, details: `success=${result.success}`, success: result.success });
    res.end();
  });

  // Which real UEs are currently attached to the given radio — the guard the operator
  // picks their own phone from, and the same data the backend re-checks server-side
  // before /run actually starts (never trust the client's own selection alone).
  router.get('/attached-ues', async (req: Request, res: Response) => {
    const radioIp = String(req.query.radioIp || '');
    if (!radioIp) {
      res.status(400).json({ error: 'radioIp query param is required' });
      return;
    }
    try {
      const status = await getInterfaceStatus.execute();
      const ues = status.activeUEs4G.filter(ue => ue.radioIp === radioIp);
      res.json({ success: true, ues });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to get attached UEs');
      res.status(500).json({ error: 'Failed to get attached UEs' });
    }
  });

  router.post('/run', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const radioIp = String(req.body?.radioIp || '');
    const qci = Number(req.body?.qci);

    if (!radioIp) {
      res.status(400).json({ error: 'radioIp is required' });
      return;
    }
    if (!Number.isInteger(qci) || qci < 1 || qci > 9) {
      res.status(400).json({ error: 'qci must be an integer between 1 and 9' });
      return;
    }
    if (!isQciHwTestBuilt()) {
      res.status(400).json({ error: 'Not installed yet — run Install first.' });
      return;
    }
    if (testRunning) {
      res.status(409).json({ error: 'A QCI hardware test is already running.' });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (obj: any) => res.write(JSON.stringify(obj) + '\n');

    testRunning = true;
    try {
      // Server-side guard — re-derived independently of whatever the operator's browser
      // last fetched, since that could be stale by the time they hit Run.
      const status = await getInterfaceStatus.execute();
      const attached = status.activeUEs4G.filter(ue => ue.radioIp === radioIp);
      if (attached.length === 0) {
        send({ type: 'error', message: `No UE is currently attached to ${radioIp}. Attach a real phone to this radio before running the test.` });
        return;
      }
      send({ type: 'guard_ok', attachedUEs: attached.map(ue => ({ imsi: ue.imsi, nickname: ue.nickname })) });

      // Fixed, memorable MSISDN for this tool specifically (not "reuse whatever the FIRST
      // active test number happens to be" — that blindly trusted an existing instance's
      // health, and a stale/broken one would explain a real "call failed" report with no
      // other symptom). Only create it if it isn't already active; an already-active
      // instance here means its own REGISTER already succeeded (ImsTestNumberInstance.start()
      // awaits a real 200 OK before ever being added to the manager's list), so reusing it
      // is safe.
      const QCI_TEST_MSISDN = '15555555555'; // 1-555-555-5555
      const existing = imsTestNumberManager.list().find(t => t.msisdn === QCI_TEST_MSISDN);
      const testNumber = existing ?? await imsTestNumberManager.create(QCI_TEST_MSISDN);
      send({ type: 'test_number', msisdn: testNumber.msisdn });

      send({ type: 'waiting', message: `Dial ${testNumber.msisdn} from the phone attached to ${radioIp} now. Waiting up to ${Math.round(TEST_TIMEOUT_MS / 1000)}s...` });

      const outcome = await runQciHwTest(radioIp, qci, (event) => {
        send({ type: 'probe_event', event });
      }, TEST_TIMEOUT_MS);

      let resultMessage: string;
      if (outcome.status === 'success') {
        resultMessage = `QCI=${qci} was admitted by the radio.`;
      } else if (outcome.status === 'rejected') {
        const label = outcome.causeGroup !== undefined && outcome.causeValue !== undefined
          ? describeBearerCause(outcome.causeGroup, outcome.causeValue) : 'unknown cause';
        resultMessage = `QCI=${qci} was rejected: ${label}${outcome.causeGroup !== undefined ? ` (Group:${outcome.causeGroup} Cause:${outcome.causeValue})` : ''}.`;
      } else if (outcome.status === 'timeout') {
        resultMessage = `No call was placed (or no response seen) within ${Math.round(TEST_TIMEOUT_MS / 1000)}s — dial the test number from the attached phone to run this test.`;
      } else {
        resultMessage = `Test error: ${outcome.errorMessage ?? 'unknown'}`;
      }

      send({ type: 'outcome', ...outcome, radioIp, qci, message: resultMessage });
      await auditLogger.log({
        action: 'qci_hw_test_run', user,
        details: `radioIp=${radioIp} qci=${qci} status=${outcome.status}`,
        success: outcome.status === 'success' || outcome.status === 'rejected',
      });
    } catch (err) {
      send({ type: 'error', message: String(err) });
      logger.error({ err: String(err) }, 'qci hw test crashed');
      await auditLogger.log({ action: 'qci_hw_test_run', user, details: `error=${String(err)}`, success: false });
    } finally {
      testRunning = false;
      res.end();
    }
  });

  return router;
};
