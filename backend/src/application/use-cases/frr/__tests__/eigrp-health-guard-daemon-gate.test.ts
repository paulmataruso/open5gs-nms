import pino from 'pino';
import { EigrpHealthGuard } from '../eigrp-health-guard';
import { IHostExecutor, CommandResult } from '../../../../domain/interfaces/host-executor';
import { IAuditLogger } from '../../../../domain/interfaces/audit-logger';

// Regression guard for a real defect measured on this host 2026-11-21:
// 1,440 error-level log lines a day, every one of them
//
//   level=50 "Command execution failed" ... vtysh -c "show ip eigrp topology"
//            error: "eigrpd is not running"
//
// Two per 2-minute cycle, for 17 days. The guard's own early-return checks
// whether *frr* is active, and frr WAS active — this deployment migrated to
// OSPF on 2026-11-04, so frr runs ospfd and /etc/frr/daemons carries
// eigrpd=no. The guard therefore stayed correctly inert (an empty topology
// yields no findings, so it raised nothing and restarted nothing) while
// firing two doomed queries forever, because IHostExecutor.executeCommand()
// REPORTS a failed command instead of throwing — the same defect class
// CLAUDE.md's "Verify, don't trust 'success'" rule covers, showing up here as
// nobody noticing rather than as a false success.
//
// Mutation check for this file: delete the `show daemons` gate from check()
// and "issues no EIGRP query when eigrpd is not running" must fail.

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const eigrpdDown = (): CommandResult => ({ stdout: '', stderr: 'eigrpd is not running\n', exitCode: 1 });

/** `vtysh -c "show daemons"` as this host really answers it, post-OSPF. */
const DAEMONS_WITHOUT_EIGRPD = ' mgmtd zebra ospfd staticd watchfrr\n';
const DAEMONS_WITH_EIGRPD = ' mgmtd zebra eigrpd ospfd staticd watchfrr\n';

function harness(opts: { frrActive?: boolean; daemons?: string }) {
  const shellCalls: string[] = [];
  const infoLogs: string[] = [];

  const hostExecutor = {
    isServiceActive: jest.fn(async () => opts.frrActive ?? true),
    executeCommand: jest.fn(async (command: string, args: string[]) => {
      const cmd = command === 'sh' ? args[args.length - 1] : `${command} ${args.join(' ')}`;
      shellCalls.push(cmd);
      if (cmd.includes('show daemons')) return ok(opts.daemons ?? DAEMONS_WITHOUT_EIGRPD);
      if (cmd.includes('eigrp')) {
        // What the real executor does: resolve with a nonzero exit, never throw.
        return (opts.daemons ?? '').includes('eigrpd') ? ok('') : eigrpdDown();
      }
      return ok('');
    }),
    restartService: jest.fn(async () => ok()),
  } as unknown as IHostExecutor;

  const auditLogger = { log: jest.fn(async () => undefined) } as unknown as IAuditLogger;

  const logger = {
    info: jest.fn((_obj: unknown, msg?: string) => { infoLogs.push(msg ?? ''); }),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as pino.Logger;

  const guard = new EigrpHealthGuard(logger, auditLogger, hostExecutor);
  // check() is private by design; the gate is only observable through it.
  const check = () => (guard as unknown as { check(): Promise<void> }).check();
  return { guard, check, shellCalls, infoLogs, hostExecutor };
}

const eigrpQueries = (calls: string[]) => calls.filter(c => c.includes('eigrp'));

describe('EigrpHealthGuard — daemon gate', () => {
  it('issues no EIGRP query when eigrpd is not running', async () => {
    const h = harness({ daemons: DAEMONS_WITHOUT_EIGRPD });
    await h.check();
    expect(eigrpQueries(h.shellCalls)).toEqual([]);
  });

  it('still queries EIGRP when eigrpd IS running, so the guard keeps working', async () => {
    const h = harness({ daemons: DAEMONS_WITH_EIGRPD });
    await h.check();
    const q = eigrpQueries(h.shellCalls);
    expect(q.some(c => c.includes('show ip eigrp topology'))).toBe(true);
    expect(q.some(c => c.includes('show ip eigrp neighbors'))).toBe(true);
  });

  it('says it is idling once, not on every cycle', async () => {
    const h = harness({ daemons: DAEMONS_WITHOUT_EIGRPD });
    await h.check();
    await h.check();
    await h.check();
    expect(h.infoLogs.filter(m => m.includes('idling'))).toHaveLength(1);
  });

  it('reports the check as a success, not a failure, while idling', async () => {
    // A guard with nothing to watch is healthy. Recording these cycles as
    // failures would make lastCheckSuccess useless for telling "idle" from
    // "broken".
    const h = harness({ daemons: DAEMONS_WITHOUT_EIGRPD });
    await h.check();
    const stats = h.guard.getStats();
    expect(stats.lastCheckSuccess).toBe(true);
    expect(stats.lastHealth).toBeNull();
    expect(stats.checksRun).toBe(1);
  });

  it('asks nothing at all when frr itself is down (pre-existing behaviour)', async () => {
    const h = harness({ frrActive: false });
    await h.check();
    expect(h.shellCalls).toEqual([]);
  });

  it('never restarts frr from the idle path', async () => {
    const h = harness({ daemons: DAEMONS_WITHOUT_EIGRPD });
    await h.check();
    expect(h.hostExecutor.restartService).not.toHaveBeenCalled();
  });
});
