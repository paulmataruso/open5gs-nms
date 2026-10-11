import pino from 'pino';
import { IAuditLogger } from '../../../domain/interfaces/audit-logger';
import { runOcsEval, readState, getOcsNodeName } from '../../../interfaces/rest/ocs-controller';

// ── OCS stuck-reservation guard ───────────────────────────────────────────
//
// Mitigates a real, still-unresolved OCS rating-engine bug (ocs_rating:
// charge2, function_clause crash on session termination — see memory
// sigscale_ocs_module_progress.md) that leaks Gy/Ro credit-control
// reservations: when a termination CCR crashes inside OCS, the reservation
// it should have released never gets cleared. A stuck reservation does NOT
// touch the bucket's actual `remain` balance (confirmed live, twice, by
// direct Mnesia inspection before/after a manual clear) — but it DOES still
// count against capacity when the rating engine decides whether to grant a
// NEW reservation, so enough accumulation eventually starts rejecting real
// sessions outright. Confirmed live 2026-09-17: 64 stuck reservations on one
// subscriber's data bucket (~320MB) was enough to trigger exactly that,
// surfacing as repeated UE attach/reattach cycling.
//
// This is a periodic sweep, not a fix for the crash itself — no exact
// source is available for the installed OCS release (3.4.73: not in the
// public GitHub repo's tags, current master confirmed drifted too far to
// trust for a byte-exact patch; the .beam has no abstract_code and charge2
// isn't even exported, so it can't be probed live either). Explicit user
// request, on by default (not gated behind a toggle) — same age-threshold
// design already validated by two real manual interventions this session.
//
// Age threshold: 2 hours. No Diameter-level guarantee bounds a legitimate
// reservation's lifetime in this deployment (Ro's own CCA response comes
// back with validity=0 — no server-enforced expiry; Gy's own interim
// interval isn't explicitly configured in smf.conf either), so this can't be
// derived from protocol config. Chosen instead to be comfortably beyond any
// real single reservation's lifetime under normal traffic (a legitimate one
// gets renewed via CCR-Update or finalized via CCR-Terminate within minutes,
// not hours) — every stuck reservation actually observed live this session
// was already well past this age with zero sign of self-clearing.
//
// Unlike the two manual interventions (which cleared a bucket's entire
// reservations map), this sweep only removes entries individually older
// than the threshold, leaving any genuinely fresh reservation on the same
// bucket untouched — a real bucket could plausibly hold both a stuck old
// entry and a currently-active new one at the same time.

const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 min — catches a leak within 2-2.5h of going stale
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

interface SweepEntry {
  bucketId: string;
  clearedCount: number;
  freedAmount: number;
}

// Raw Mnesia table scan (mnesia:dirty_all_keys/dirty_write via RPC into the
// real node) rather than any ocs:* enumeration function — this project's
// existing OCS research never found a public "list every bucket" API, and a
// full-table scan is safe/read-mostly (writes only touch buckets that
// actually have a stale entry).
async function sweepScript(): Promise<string> {
  const script = [
    `Node = '${await getOcsNodeName()}',`,
    `Ocs = fun(F, A) -> rpc:call(Node, ocs, F, A) end,`,
    `Now = erlang:system_time(millisecond),`,
    `ThresholdMs = ${STALE_THRESHOLD_MS},`,
    `Keys = rpc:call(Node, mnesia, dirty_all_keys, [bucket]),`,
    `SweepOne = fun(Key) ->`,
    `  case Ocs(find_bucket, [Key]) of`,
    `    {ok, B} ->`,
    `      Attrs = element(8, B),`,
    `      Reservations = maps:get(reservations, Attrs, #{}),`,
    `      {Stale, Fresh} = maps:fold(fun(RK, RV, {S, F}) ->`,
    `        Ts = maps:get(ts, RV, Now),`,
    `        case (Now - Ts) > ThresholdMs of`,
    `          true -> {[RV | S], F};`,
    `          false -> {S, maps:put(RK, RV, F)}`,
    `        end`,
    `      end, {[], #{}}, Reservations),`,
    `      case Stale of`,
    `        [] -> none;`,
    `        _ ->`,
    `          Freed = lists:sum([ maps:get(reserve, V, 0) - maps:get(debit, V, 0) || V <- Stale ]),`,
    `          NewAttrs = case map_size(Fresh) of`,
    `            0 -> maps:remove(reservations, Attrs);`,
    `            _ -> maps:put(reservations, Fresh, Attrs)`,
    `          end,`,
    `          NewB = setelement(8, B, NewAttrs),`,
    `          ok = rpc:call(Node, mnesia, dirty_write, [bucket, NewB]),`,
    `          {Key, length(Stale), Freed}`,
    `      end;`,
    `    _ -> none`,
    `  end`,
    `end,`,
    `AllResults = [ SweepOne(K) || K <- Keys ],`,
    `Results = [ R || R <- AllResults, R =/= none ],`,
    `io:format("SWEEP_RESULT ~p~n", [Results]),`,
    `init:stop()`,
  ].join('\n');
  return runOcsEval(script, 30000);
}

// Parses lines like: SWEEP_RESULT [{"1789618544995-28866",12,45000000},...]
function parseSweepResults(stdout: string): SweepEntry[] {
  const m = /SWEEP_RESULT\s*\[(.*)\]/s.exec(stdout);
  if (!m) return [];
  const entries: SweepEntry[] = [];
  const re = /\{"([^"]+)",\s*(\d+),\s*(-?\d+)\}/g;
  let entry: RegExpExecArray | null;
  while ((entry = re.exec(m[1])) !== null) {
    entries.push({ bucketId: entry[1], clearedCount: Number(entry[2]), freedAmount: Number(entry[3]) });
  }
  return entries;
}

// Dashboard-facing sweep bookkeeping (added for the SigScale OCS Grafana
// dashboard, item 5 of the Grafana dashboard series). Deliberately additive
// only, and deliberately positioned to run AFTER the real clear/log/audit
// side effects below, not interleaved with them — a bug in this bookkeeping
// can produce a wrong dashboard number but can never suppress or alter the
// guard's actual protective behavior (the Mnesia writes happen inside the
// unmodified sweepScript()/parseSweepResults() below; the logger.warn()/
// auditLogger.log() calls are untouched from before this feature existed).
// The one-layer-up `start()`.catch() below is ALSO untouched — this file's
// own try/catch only records lastSweepSuccess/lastSweepAt before
// re-throwing, it never swallows or changes what start() already logs.
export interface OcsReservationGuardStats {
  sweepsRun: number;
  totalCleared: number;
  totalBucketsAffected: number;
  lastSweepAt: number; // 0 = never run
  lastSweepSuccess: boolean;
  lastSweepClearedCount: number;
  lastSweepBucketsAffected: number;
}

export class OcsReservationGuard {
  private timer: NodeJS.Timeout | null = null;
  private stats: OcsReservationGuardStats = {
    sweepsRun: 0,
    totalCleared: 0,
    totalBucketsAffected: 0,
    lastSweepAt: 0,
    lastSweepSuccess: false,
    lastSweepClearedCount: 0,
    lastSweepBucketsAffected: 0,
  };

  constructor(private readonly logger: pino.Logger, private readonly auditLogger: IAuditLogger) {}

  start(): void {
    if (this.timer) return;
    this.sweep().catch(err => this.logger.warn({ err: String(err) }, 'OCS reservation guard: initial sweep failed'));
    this.timer = setInterval(() => {
      this.sweep().catch(err => this.logger.warn({ err: String(err) }, 'OCS reservation guard: sweep failed'));
    }, SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getStats(): OcsReservationGuardStats {
    return { ...this.stats };
  }

  private recordSweepStats(cleared: number, bucketsAffected: number): void {
    this.stats.lastSweepAt = Date.now();
    this.stats.lastSweepSuccess = true;
    this.stats.lastSweepClearedCount = cleared;
    this.stats.lastSweepBucketsAffected = bucketsAffected;
    this.stats.totalCleared += cleared;
    this.stats.totalBucketsAffected += bucketsAffected;
  }

  private async sweep(): Promise<void> {
    if (!readState()) return; // OCS not configured on this deployment yet — nothing to sweep

    this.stats.sweepsRun++;
    try {
      const stdout = await sweepScript();
      const entries = parseSweepResults(stdout);
      if (entries.length === 0) {
        this.recordSweepStats(0, 0);
        return; // nothing stale this pass — the common case, stay quiet
      }

      const totalCleared = entries.reduce((sum, e) => sum + e.clearedCount, 0);
      this.logger.warn(
        { entries, totalCleared },
        `OCS reservation guard: cleared ${totalCleared} stuck reservation(s) across ${entries.length} bucket(s) (ocs_rating:charge2 crash-on-termination leak — see memory sigscale_ocs_module_progress.md)`,
      );
      await this.auditLogger.log({
        action: 'ocs_reservation_guard_sweep',
        user: 'system',
        details: `cleared ${totalCleared} stuck reservation(s) across ${entries.length} bucket(s): ${JSON.stringify(entries)}`,
        success: true,
      });
      this.recordSweepStats(totalCleared, entries.length);
    } catch (err) {
      this.stats.lastSweepAt = Date.now();
      this.stats.lastSweepSuccess = false;
      throw err; // start()'s own .catch() still logs this exactly as before
    }
  }
}
