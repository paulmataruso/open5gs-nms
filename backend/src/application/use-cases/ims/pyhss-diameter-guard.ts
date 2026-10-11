import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../../domain/interfaces/audit-logger';
import { safeNsenter } from '../../../infrastructure/system/safe-nsenter';

// ── PyHSS pyhss-diameter hang guard ──────────────────────────────────────
//
// Mitigates a real, recurring pyhss-diameter hang found live 2026-10-01:
// PyHSS's Diameter Cx peer connection stays I_Open (`kamcmd cdp.list_peers`)
// while silently stopping all processing — new LIR/UAR/SAR/MAR requests get
// no reply, surfacing as `500 Server error on LIR` on Kamailio's side. Only
// `systemctl restart pyhss-diameter` recovered it, and it recurred
// repeatedly (4+ times in ~2 hours during one investigation session).
// `pyhss-hss` (the actual Cx business-logic processor) was independently
// confirmed NOT the hung component every time — a source-level hardening
// fix now lives in `diameterService.py`/`messagingAsync.py` itself (see
// the "pyhss-diameter hang hardening" patch in `ims-controller.ts`'s
// `POST /api/ims/install`), but an adversarial review of the exact
// installed redis-py version found real, deliberately-engineered defenses
// against the specific mechanism first suspected — so that patch is
// defense-in-depth, not a guaranteed fix. This guard is the actual
// stability backstop: it detects the externally-observable SYMPTOM
// (sustained Cx transaction timeouts despite an apparently-healthy peer)
// regardless of root cause, captures forensic diagnostics, and restarts
// the stuck service automatically — matching this codebase's own
// established pattern for a third-party bug that can't be fully pinned
// down at the source (see ocs-reservation-guard.ts, mitigating SigScale
// OCS's own unresolved `charge2` crash the same way).
//
// Detection signal: Kamailio's cdp module already tracks a per-component
// `cdp:timeout` counter (`kamcmd stats.get_statistics cdp:`) — a real,
// protocol-level count of Diameter transactions that never got a reply
// within cdp's own 5s transaction timeout. This was chosen over two
// alternatives that turned out not to work: (1) journal-silence — most of
// diameterService.py's own per-message logging is at DEBUG while this
// deployment runs at INFO, so a perfectly healthy, quiet connection looks
// identical to a hung one from the journal alone; (2) `py-spy dump` — this
// service is single-threaded asyncio, and a task awaiting a Redis reply
// that will never arrive shows the exact same "MainThread idle in
// select()" stack as a genuinely idle, healthy event loop with nothing to
// do — py-spy cannot distinguish the two without deeper asyncio-task
// introspection this service doesn't expose. `cdp:timeout` has neither
// problem: cdp logs every trip it makes to the Diameter wire, so a timeout
// there is real evidence something sent never came back, not an absence
// of logging.
//
// Only I-CSCF and S-CSCF carry a Cx peer to PyHSS (P-CSCF's own cdp only
// speaks Rx to PCRF, confirmed via `cdp.list_peers` showing a single
// `hss.*` peer on each of icscf/scscf and no PyHSS peer on pcscf) — those
// are the only two components polled. The counter is cumulative and resets
// to 0 whenever the owning Kamailio component itself restarts; a decrease
// is treated as a restart, not a signal.
//
// Trigger condition: the counter must have grown by at least
// MIN_INCREASE_TO_TRIGGER across a short rolling window (HISTORY_WINDOW_SIZE
// samples, ~4 min), not "every single poll-to-poll delta must be positive".
// A real hang's timeouts arrive whenever something happens to attempt a
// call, not on a cadence aligned with this guard's own poll interval — an
// earlier version of this guard required a fresh increase at EVERY
// consecutive poll and, confirmed live in a controlled SIGSTOP-based test
// 2026-10-01 (freezing the real process to safely reproduce "I_Open but
// unresponsive" without needing the elusive real bug), that design never
// triggered even after 5+ minutes of genuine, confirmed timeouts (`cdp:
// timeout` 0→1→2) — the two real timeout events happened to straddle poll
// boundaries such that no two *consecutive* polls each individually saw a
// fresh increase, even though the underlying hang was continuously present
// the whole time. The window-based comparison (current vs. the sample from
// ~4 min ago, not vs. the immediately preceding one) fixes this: it only
// cares whether timeouts accumulated somewhere across the window, not their
// exact distribution within it. The >=2 threshold (not >=1) still filters a
// genuinely isolated single blip under brief real load on an otherwise-
// healthy system — this guard should not restart a live Diameter peer
// connection (briefly dropping it for every currently-connected Kamailio
// component) over one such event.

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 min
const HISTORY_WINDOW_SIZE = 3; // current + 2 prior samples = a 4 min lookback
const MIN_INCREASE_TO_TRIGGER = 2; // net new timeouts across the whole window, not just since the last poll
const RESTART_COOLDOWN_MS = 3 * 60 * 1000; // avoid restart-looping if the underlying issue is severe/persistent
const KAMCMD_TIMEOUT_MS = 10000;

const CDP_PEERS: { component: string; socket: string }[] = [
  { component: 'icscf', socket: '/run/kamailio_icscf/kamailio_ctl' },
  { component: 'scscf', socket: '/run/kamailio_scscf/kamailio_ctl' },
];

const HOST_DIAGNOSTICS_DIR = '/proc/1/root/var/log/open5gs-nms/diagnostics';

export interface PyhssDiameterGuardStats {
  checksRun: number;
  restartsTriggered: number;
  lastCheckAt: number; // 0 = never
  lastRestartAt: number; // 0 = never
  lastRestartReason: string;
}

export class PyhssDiameterGuard {
  private timer: NodeJS.Timeout | null = null;
  // Rolling history of recent cdp:timeout samples per component, oldest
  // first — compared against the newest sample to detect sustained growth
  // across the whole window rather than requiring every single poll-to-poll
  // step to individually increase (see this file's header for why).
  private history: Record<string, number[]> = {};
  private stats: PyhssDiameterGuardStats = {
    checksRun: 0,
    restartsTriggered: 0,
    lastCheckAt: 0,
    lastRestartAt: 0,
    lastRestartReason: '',
  };

  constructor(private readonly logger: pino.Logger, private readonly auditLogger: IAuditLogger) {}

  start(): void {
    if (this.timer) return;
    this.check().catch(err => this.logger.warn({ err: String(err) }, 'pyhss-diameter guard: initial check failed'));
    this.timer = setInterval(() => {
      this.check().catch(err => this.logger.warn({ err: String(err) }, 'pyhss-diameter guard: check failed'));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getStats(): PyhssDiameterGuardStats {
    return { ...this.stats };
  }

  private async readCdpTimeoutCount(socket: string): Promise<number | null> {
    try {
      const { stdout } = await safeNsenter('kamcmd', ['-s', socket, 'stats.get_statistics', 'cdp:'], KAMCMD_TIMEOUT_MS);
      const m = /cdp:timeout\s*=\s*(\d+)/.exec(stdout);
      return m ? Number(m[1]) : null;
    } catch {
      return null; // component not installed/reachable right now — not this guard's concern
    }
  }

  private async check(): Promise<void> {
    this.stats.checksRun++;
    this.stats.lastCheckAt = Date.now();

    const triggerDetails: string[] = [];

    for (const { component, socket } of CDP_PEERS) {
      const current = await this.readCdpTimeoutCount(socket);
      if (current === null) continue;

      const hist = this.history[component] || [];
      const oldest = hist.length > 0 ? hist[0] : undefined;

      if (oldest !== undefined && current < oldest) {
        // The Kamailio component itself restarted at some point in this
        // window (counter reset) — any comparison across it is meaningless.
        this.history[component] = [current];
      } else {
        hist.push(current);
        while (hist.length > HISTORY_WINDOW_SIZE) hist.shift();
        this.history[component] = hist;
        if (hist.length === HISTORY_WINDOW_SIZE) {
          const delta = current - hist[0];
          if (delta >= MIN_INCREASE_TO_TRIGGER) {
            triggerDetails.push(`${component}: cdp:timeout ${hist[0]}→${current} (+${delta} over the last ~${(HISTORY_WINDOW_SIZE - 1) * POLL_INTERVAL_MS / 60000} min)`);
          }
        }
      }
    }

    if (triggerDetails.length === 0) return;

    if (this.stats.lastRestartAt !== 0 && (Date.now() - this.stats.lastRestartAt) < RESTART_COOLDOWN_MS) {
      this.logger.warn({ triggerDetails }, 'pyhss-diameter guard: hang signature detected again within cooldown, skipping restart');
      return;
    }

    const reason = triggerDetails.join('; ');
    this.logger.warn(
      { triggerDetails },
      'pyhss-diameter guard: sustained Cx transaction timeouts detected despite an apparently-healthy peer — capturing diagnostics and restarting pyhss-diameter',
    );
    await this.captureDiagnostics(reason).catch(err =>
      this.logger.warn({ err: String(err) }, 'pyhss-diameter guard: diagnostic capture failed'));

    try {
      await safeNsenter('systemctl', ['restart', 'pyhss-diameter'], 15000);
      this.stats.restartsTriggered++;
      this.stats.lastRestartAt = Date.now();
      this.stats.lastRestartReason = reason;
      this.history = {}; // pyhss-diameter restarted — every component's cdp:timeout counter is about to reset too
      await this.auditLogger.log({
        action: 'pyhss_diameter_guard_restart',
        user: 'system',
        details: `restarted pyhss-diameter after detecting a hang signature: ${reason}`,
        success: true,
      });
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'pyhss-diameter guard: restart failed');
    }
  }

  // Captures forensic context BEFORE restarting — written directly via fs
  // (not a shell heredoc) so arbitrary captured log/dump content can never
  // break out of a shell quoting context. py-spy is best-effort only: see
  // this file's header for why it can't actually prove a stuck task here,
  // it's corroborating context at most.
  private async captureDiagnostics(reason: string): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const parts: string[] = [
      '=== pyhss-diameter guard diagnostic capture ===',
      `Time: ${new Date().toISOString()}`,
      `Reason: ${reason}`,
      '',
    ];

    for (const { component, socket } of CDP_PEERS) {
      parts.push(`=== cdp.list_peers (${component}) ===`);
      try {
        const { stdout } = await safeNsenter('kamcmd', ['-s', socket, 'cdp.list_peers'], KAMCMD_TIMEOUT_MS);
        parts.push(stdout);
      } catch (err) {
        parts.push(`(failed: ${String(err)})`);
      }
    }

    parts.push('=== redis-cli CLIENT LIST ===');
    try {
      const { stdout } = await safeNsenter('redis-cli', ['CLIENT', 'LIST'], KAMCMD_TIMEOUT_MS);
      parts.push(stdout);
    } catch (err) {
      parts.push(`(failed: ${String(err)})`);
    }

    for (const unit of ['pyhss-diameter', 'pyhss-hss']) {
      parts.push(`=== journalctl -u ${unit} (last 5 min) ===`);
      try {
        const { stdout } = await safeNsenter('journalctl', ['-u', unit, '--since', '5 minutes ago', '--no-pager'], KAMCMD_TIMEOUT_MS);
        parts.push(stdout);
      } catch (err) {
        parts.push(`(failed: ${String(err)})`);
      }
    }

    parts.push('=== py-spy dump (best-effort — see header comment) ===');
    try {
      const { stdout: pidOut } = await safeNsenter('systemctl', ['show', 'pyhss-diameter', '-p', 'MainPID', '--value'], 5000);
      const pid = pidOut.trim();
      const { stdout } = await safeNsenter('py-spy', ['dump', '--pid', pid], KAMCMD_TIMEOUT_MS);
      parts.push(stdout);
    } catch (err) {
      parts.push(`(unavailable or failed: ${String(err)})`);
    }

    fs.mkdirSync(HOST_DIAGNOSTICS_DIR, { recursive: true });
    const outFile = `${HOST_DIAGNOSTICS_DIR}/pyhss-diameter-guard-${ts}.log`;
    fs.writeFileSync(outFile, parts.join('\n'), 'utf-8');
    this.logger.warn({ outFile: outFile.replace('/proc/1/root', '') }, 'pyhss-diameter guard: diagnostics captured');
  }
}
