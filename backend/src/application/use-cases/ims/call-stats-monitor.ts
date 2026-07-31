/**
 * IMS Call Stats Monitor
 *
 * Tracks live active-call count and a durable cumulative "total calls
 * placed" counter for the Dashboard's IMS Status card.
 *
 * S-CSCF's `ims_dialog` module exposes `dialog_ng:active` (live, correct
 * as-is) and `dialog_ng:processed` (cumulative dialogs since the *process*
 * started) via `kamcmd stats.get_statistics dialog_ng:`. The latter is not
 * durable on its own — kamailio-scscf restarts often in this project (every
 * IMS Configure click, plus ad hoc restarts during troubleshooting), which
 * resets it to 0. This monitor persists its own delta-accumulated total
 * across restarts in a small state file, the same reset-aware pattern
 * GtpBandwidthMonitor uses for its byte counters (Math.max(0, delta), but
 * here a *decrease* means "the process restarted", so the fallback is to
 * add the new value directly rather than clamp it to zero).
 *
 * Runs as a lightweight background sampler so the Dashboard's read is
 * always an instant, non-blocking read of the last computed value.
 */

import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';

export interface ImsCallStats {
  activeCalls: number;
  totalCallsPlaced: number;
  sampledAt: number;
}

interface CallStatsState {
  cumulativeTotal: number;
  lastKnownProcessed: number;
}

const SAMPLE_INTERVAL_MS = 5000;
const STATE_FILE = '/proc/1/root/etc/open5gs/.ims-call-stats.json';
const SCSCF_CTL = '/run/kamailio_scscf/kamailio_ctl';

export class ImsCallStatsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private latest: ImsCallStats = { activeCalls: 0, totalCallsPlaced: 0, sampledAt: 0 };

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.sample().catch(err => this.logger.warn({ err: String(err) }, 'IMS call stats: initial sample failed'));
    this.timer = setInterval(() => {
      this.sample().catch(err => this.logger.warn({ err: String(err) }, 'IMS call stats: sample failed'));
    }, SAMPLE_INTERVAL_MS);
  }

  getLatest(): ImsCallStats {
    return this.latest;
  }

  private loadState(): CallStatsState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        return {
          cumulativeTotal: Number(parsed.cumulativeTotal) || 0,
          lastKnownProcessed: Number(parsed.lastKnownProcessed) || 0,
        };
      }
    } catch {
      // Corrupt/missing state file — start fresh rather than crash the sampler.
    }
    return { cumulativeTotal: 0, lastKnownProcessed: 0 };
  }

  private saveState(state: CallStatsState): void {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'IMS call stats: failed to persist state');
    }
  }

  private async sample(): Promise<void> {
    const result = await this.hostExecutor.executeCommand(
      'kamcmd', ['-s', SCSCF_CTL, 'stats.get_statistics', 'dialog_ng:'], 10000,
    );
    if (result.exitCode !== 0) {
      // S-CSCF not running (module not installed/enabled) — leave last known
      // active count stale-but-harmless, don't touch the persisted total.
      this.latest = { ...this.latest, activeCalls: 0, sampledAt: Date.now() };
      return;
    }

    const activeMatch = result.stdout.match(/dialog_ng:active\s*=\s*(\d+)/);
    const processedMatch = result.stdout.match(/dialog_ng:processed\s*=\s*(\d+)/);
    const active = activeMatch ? parseInt(activeMatch[1], 10) : 0;
    const processed = processedMatch ? parseInt(processedMatch[1], 10) : 0;

    const state = this.loadState();
    // Normal case: processed only grows within one S-CSCF process lifetime,
    // so the delta since our last poll is new activity. If processed is
    // LOWER than what we last saw, the process restarted (counter reset to
    // 0) — the new value itself (not a clamped-to-zero delta) is the count
    // of calls placed since that restart, so add it directly.
    const delta = processed >= state.lastKnownProcessed
      ? processed - state.lastKnownProcessed
      : processed;

    const newState: CallStatsState = {
      cumulativeTotal: state.cumulativeTotal + delta,
      lastKnownProcessed: processed,
    };
    if (delta !== 0 || !fs.existsSync(STATE_FILE)) {
      this.saveState(newState);
    }

    this.latest = { activeCalls: active, totalCallsPlaced: newState.cumulativeTotal, sampledAt: Date.now() };
  }
}
