/**
 * IMS Call Stats Monitor
 *
 * Tracks live active-call count and durable cumulative "total calls
 * placed" / "total SMS sent" counters for the Dashboard's IMS Status card.
 *
 * S-CSCF's `ims_dialog` module exposes `dialog_ng:active` (live, correct
 * as-is) and `dialog_ng:processed` (cumulative dialogs since the *process*
 * started) via `kamcmd stats.get_statistics dialog_ng:`. Kamailio's core
 * stats module separately exposes a per-SIP-method request counter,
 * `core:rcv_requests_message` — a count of SIP MESSAGE requests received,
 * i.e. SMS-over-IMS sends (this project's default/primary SMS delivery
 * path — see the SMS Delivery Mode toggle in ims-controller.ts; SMS sent
 * via the SGs/osmo-msc path instead is NOT counted here, no equivalent
 * durable counter exists for that path yet). Neither of these process-
 * lifetime counters is durable on its own — kamailio-scscf restarts often
 * in this project (every IMS Configure click, plus ad hoc restarts during
 * troubleshooting), which resets both to 0. This monitor persists its own
 * delta-accumulated totals across restarts in a small state file, the same
 * reset-aware pattern GtpBandwidthMonitor uses for its byte counters
 * (Math.max(0, delta), but here a *decrease* means "the process
 * restarted", so the fallback is to add the new value directly rather than
 * clamp it to zero).
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
  totalSmsSent: number;
  sampledAt: number;
}

interface CallStatsState {
  cumulativeTotal: number;
  lastKnownProcessed: number;
  cumulativeSmsTotal: number;
  lastKnownSmsProcessed: number;
}

const SAMPLE_INTERVAL_MS = 5000;
const STATE_FILE = '/proc/1/root/etc/open5gs/.ims-call-stats.json';
const SCSCF_CTL = '/run/kamailio_scscf/kamailio_ctl';

export class ImsCallStatsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private latest: ImsCallStats = { activeCalls: 0, totalCallsPlaced: 0, totalSmsSent: 0, sampledAt: 0 };

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
          cumulativeSmsTotal: Number(parsed.cumulativeSmsTotal) || 0,
          lastKnownSmsProcessed: Number(parsed.lastKnownSmsProcessed) || 0,
        };
      }
    } catch {
      // Corrupt/missing state file — start fresh rather than crash the sampler.
    }
    return { cumulativeTotal: 0, lastKnownProcessed: 0, cumulativeSmsTotal: 0, lastKnownSmsProcessed: 0 };
  }

  private saveState(state: CallStatsState): void {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'IMS call stats: failed to persist state');
    }
  }

  // Delta-accumulate a process-lifetime counter into a durable total. A
  // decrease means the process restarted (counter reset to 0) — the new
  // value itself (not a clamped-to-zero delta) is the count of new activity
  // since that restart, so it's added directly rather than dropped.
  private static accumulate(rawValue: number, lastKnown: number, cumulative: number): { delta: number; newCumulative: number } {
    const delta = rawValue >= lastKnown ? rawValue - lastKnown : rawValue;
    return { delta, newCumulative: cumulative + delta };
  }

  private async sample(): Promise<void> {
    // stats.get_statistics takes exactly one group-prefix argument — confirmed
    // live that passing both 'dialog_ng:' and 'core:rcv_requests_message' in a
    // single call silently drops the second one (only dialog_ng: stats came
    // back). Needs two separate calls; 'core:' pulls the whole core stats
    // group (dozens of unrelated counters) but that's fine, the regex below
    // only picks out the one line we want.
    const [dialogResult, coreResult] = await Promise.all([
      this.hostExecutor.executeCommand('kamcmd', ['-s', SCSCF_CTL, 'stats.get_statistics', 'dialog_ng:'], 10000),
      this.hostExecutor.executeCommand('kamcmd', ['-s', SCSCF_CTL, 'stats.get_statistics', 'core:'], 10000),
    ]);
    if (dialogResult.exitCode !== 0) {
      // S-CSCF not running (module not installed/enabled) — leave last known
      // active count stale-but-harmless, don't touch the persisted totals.
      this.latest = { ...this.latest, activeCalls: 0, sampledAt: Date.now() };
      return;
    }

    const activeMatch = dialogResult.stdout.match(/dialog_ng:active\s*=\s*(\d+)/);
    const processedMatch = dialogResult.stdout.match(/dialog_ng:processed\s*=\s*(\d+)/);
    const smsMatch = coreResult.stdout.match(/core:rcv_requests_message\s*=\s*(\d+)/);
    const active = activeMatch ? parseInt(activeMatch[1], 10) : 0;
    const processed = processedMatch ? parseInt(processedMatch[1], 10) : 0;
    const smsProcessed = smsMatch ? parseInt(smsMatch[1], 10) : 0;

    const state = this.loadState();
    const calls = ImsCallStatsMonitor.accumulate(processed, state.lastKnownProcessed, state.cumulativeTotal);
    const sms = ImsCallStatsMonitor.accumulate(smsProcessed, state.lastKnownSmsProcessed, state.cumulativeSmsTotal);

    const newState: CallStatsState = {
      cumulativeTotal: calls.newCumulative,
      lastKnownProcessed: processed,
      cumulativeSmsTotal: sms.newCumulative,
      lastKnownSmsProcessed: smsProcessed,
    };
    if (calls.delta !== 0 || sms.delta !== 0 || !fs.existsSync(STATE_FILE)) {
      this.saveState(newState);
    }

    this.latest = {
      activeCalls: active,
      totalCallsPlaced: newState.cumulativeTotal,
      totalSmsSent: newState.cumulativeSmsTotal,
      sampledAt: Date.now(),
    };
  }
}
