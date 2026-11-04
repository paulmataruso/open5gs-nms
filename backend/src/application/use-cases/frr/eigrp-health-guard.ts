import pino from 'pino';
import { IAuditLogger } from '../../../domain/interfaces/audit-logger';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { diagnoseEigrpHealth, EigrpHealth } from '../../../domain/services/eigrp-health';

// ── EIGRP forwarding-health guard ─────────────────────────────────────────
//
// Safety net for CLAUDE.md pattern #7. The eigrpd patches this project ships
// (frr-eigrpd-crash-guard.patch and frr-eigrpd-dangling-adv-router.patch)
// address the causes that were actually root-caused; this watches for the
// SYMPTOM regardless of cause, because seven occurrences across four months
// were each discovered by an operator noticing the network was down — twice
// at around 02:30 — and recovered by hand with the same command.
//
// Why a guard at all when the bug is patched. Three reasons, in order of how
// much they matter. The patched daemon only reaches a host that re-runs the
// FRR source build, and this project's own history includes four separate
// incidents of a fix living in the build script while the deployed artifact
// predated it. The post-flap zebra install failure is mitigated here (eigrpd
// re-states its routes when an adjacency comes up) but the underlying
// behaviour is zebra's, not eigrpd's, so a path we have not measured may
// still reach it. And the trigger itself was never root-caused across any of
// the seven occurrences — "Unknown TLV type: 0x0103" from a peer we do not
// administer is still unexplained, so claiming the cause is closed would be
// going further than the evidence.
//
// Deliberately narrow about when it acts. It restarts only on a finding that
// is affecting traffic RIGHT NOW, judged from the kernel route table, never
// from the EIGRP topology alone — the 6th occurrence (2026-10-10) had a
// thoroughly corrupt topology, a clean kernel table, and no outage, and
// restarting there would have interrupted a working network for a cosmetic
// fault. diagnoseEigrpHealth() owns that distinction.

const CHECK_INTERVAL_MS = 2 * 60 * 1000;        // 2 min — an outage should not wait 30
const RESTART_COOLDOWN_MS = 15 * 60 * 1000;     // never two restarts inside 15 min
const RESTART_WINDOW_MS = 6 * 60 * 60 * 1000;   // rolling window for the cap below
const MAX_RESTARTS_PER_WINDOW = 3;

// Prefixes whose kernel route this deployment's RAN and UE traffic depends on.
//
// Hardcoded deliberately, and narrowly. EIGRP legitimately learns prefixes it
// does not install, so "known but not installed" is only a fault for routes we
// know we need; deriving that set automatically would mean guessing which of
// the 29 learned prefixes matter and restarting FRR on a wrong guess. These
// two are the radio networks that carry S1AP/N2 and GTP-U here (CLAUDE.md's
// Reference facts), and both were confirmed missing from the kernel in the
// measured post-flap failure.
const REQUIRED_PREFIXES = ['10.0.2.0/24', '172.16.1.0/24'];

export interface EigrpHealthGuardStats {
  checksRun: number;
  lastCheckAt: number;        // 0 = never run
  lastCheckSuccess: boolean;
  lastHealth: EigrpHealth | null;
  restartsPerformed: number;
  lastRestartAt: number;      // 0 = never
  restartsSuppressed: number; // degraded but held back by cooldown or the cap
}

export class EigrpHealthGuard {
  private timer: NodeJS.Timeout | null = null;
  private restartTimes: number[] = [];
  private stats: EigrpHealthGuardStats = {
    checksRun: 0,
    lastCheckAt: 0,
    lastCheckSuccess: false,
    lastHealth: null,
    restartsPerformed: 0,
    lastRestartAt: 0,
    restartsSuppressed: 0,
  };

  constructor(
    private readonly logger: pino.Logger,
    private readonly auditLogger: IAuditLogger,
    private readonly hostExecutor: IHostExecutor,
  ) {}

  start(): void {
    if (this.timer) return;
    this.check().catch(err => this.logger.warn({ err: String(err) }, 'EIGRP health guard: initial check failed'));
    this.timer = setInterval(() => {
      this.check().catch(err => this.logger.warn({ err: String(err) }, 'EIGRP health guard: check failed'));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getStats(): EigrpHealthGuardStats {
    return { ...this.stats, lastHealth: this.stats.lastHealth ? { ...this.stats.lastHealth } : null };
  }

  /** True when a restart is allowed right now. Exported shape is the reason, for the log. */
  private restartAllowed(now: number): { allowed: boolean; reason?: string } {
    if (this.stats.lastRestartAt && now - this.stats.lastRestartAt < RESTART_COOLDOWN_MS) {
      const mins = Math.ceil((RESTART_COOLDOWN_MS - (now - this.stats.lastRestartAt)) / 60000);
      return { allowed: false, reason: `cooldown — last restart was under 15 min ago, ${mins} min remaining` };
    }
    const recent = this.restartTimes.filter(t => now - t < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS_PER_WINDOW) {
      return {
        allowed: false,
        reason: `restart cap reached (${recent.length} in the last 6h) — restarting again would be a loop, not a repair; this needs a human`,
      };
    }
    return { allowed: true };
  }

  private async check(): Promise<void> {
    this.stats.checksRun++;
    try {
      const active = await this.hostExecutor.isServiceActive('frr').catch(() => false);
      if (!active) {
        // Not this guard's job: a dead frr is watchfrr's and the operator's.
        // Acting here would race whatever is already restarting it.
        this.stats.lastCheckAt = Date.now();
        this.stats.lastCheckSuccess = true;
        this.stats.lastHealth = null;
        return;
      }

      const [topology, routes, nexthops, neighbors] = await Promise.all([
        this.run('vtysh -c "show ip eigrp topology"'),
        this.run('ip route show'),
        this.run('ip nexthop show'),
        this.run('vtysh -c "show ip eigrp neighbors"'),
      ]);

      const health = diagnoseEigrpHealth({
        topology, routes, nexthops, neighbors, requiredPrefixes: REQUIRED_PREFIXES,
      });
      this.stats.lastCheckAt = Date.now();
      this.stats.lastCheckSuccess = true;
      this.stats.lastHealth = health;

      if (health.findings.length === 0) return; // healthy — the common case, stay quiet

      if (!health.degraded) {
        // Topology-only. Worth saying once per check so it is visible in the
        // log if it becomes chronic, but explicitly NOT worth a restart.
        this.logger.warn(
          { findings: health.findings, corruptPrefixes: health.corruptPrefixes },
          'EIGRP health guard: topology anomaly with a clean kernel route table — reporting only, not restarting (see CLAUDE.md pattern #7, 6th occurrence)',
        );
        return;
      }

      const now = Date.now();
      const { allowed, reason } = this.restartAllowed(now);
      if (!allowed) {
        this.stats.restartsSuppressed++;
        this.logger.error({ findings: health.findings, reason }, `EIGRP health guard: traffic-affecting fault detected but NOT restarting — ${reason}`);
        await this.auditLogger.log({
          action: 'eigrp_health_guard_suppressed',
          user: 'system',
          details: `degraded but held back: ${reason}; findings: ${JSON.stringify(health.findings)}`,
          success: false,
        });
        return;
      }

      await this.recover(health, now);
    } catch (err) {
      this.stats.lastCheckAt = Date.now();
      this.stats.lastCheckSuccess = false;
      throw err; // start()'s own .catch() logs it
    }
  }

  private async recover(health: EigrpHealth, now: number): Promise<void> {
    // Pre-flight, straight from the documented manual procedure: confirm the
    // crash-guard patch is in the binary that will come back up. A restart
    // makes eigrpd reprocess the whole topology during a fresh neighbour
    // resync, which is the frr#943 crash trigger — the patch is what makes
    // this safe to do unattended, so an unpatched binary is reported rather
    // than bounced.
    const guard = await this.run('strings /usr/lib/frr/eigrpd 2>/dev/null | grep -cF "frr#943 crash-guard"').catch(() => '0');
    if (Number(guard.trim()) === 0) {
      this.logger.error(
        { findings: health.findings },
        'EIGRP health guard: traffic-affecting fault detected, but /usr/lib/frr/eigrpd has no crash-guard patch — NOT restarting, because a resync on an unpatched binary can crash eigrpd outright. Run the FRR Source Build (tag frr-10.6.1) first.',
      );
      await this.auditLogger.log({
        action: 'eigrp_health_guard_suppressed',
        user: 'system',
        details: `degraded but eigrpd is unpatched (no frr#943 crash-guard); findings: ${JSON.stringify(health.findings)}`,
        success: false,
      });
      this.stats.restartsSuppressed++;
      return;
    }

    const affecting = health.findings.filter(f => f.trafficAffecting);
    this.logger.error({ findings: affecting }, 'EIGRP health guard: restarting frr to repair a traffic-affecting forwarding fault');

    await this.hostExecutor.restartService('frr');
    this.stats.restartsPerformed++;
    this.stats.lastRestartAt = now;
    this.restartTimes.push(now);
    this.restartTimes = this.restartTimes.filter(t => now - t < RESTART_WINDOW_MS);

    await this.auditLogger.log({
      action: 'eigrp_health_guard_restart',
      user: 'system',
      details: `restarted frr to repair: ${affecting.map(f => `${f.kind} (${f.prefixes.join(', ')})`).join('; ')}`,
      success: true,
    });
  }

  private async run(cmd: string): Promise<string> {
    const r = await this.hostExecutor.executeCommand('sh', ['-c', cmd], 15000);
    return r.stdout;
  }
}
