import pino from 'pino';
import { runOcsEval, readState, getOcsNodeName } from '../../../interfaces/rest/ocs-controller';

// ── SigScale OCS stats background poller ────────────────────────────────
//
// Sibling to kamailio-stats-monitor.ts/twamp-metrics.ts/gsm-metrics.ts's
// own "background cache, collect() never does I/O" shape — but reached
// over Erlang RPC (runOcsEval) instead of a control socket/VTY, since
// that's the only real data path OCS exposes: its REST API is 401-gated
// with no stored credential anywhere in this codebase (confirmed live
// during this feature's own research — every existing OCS integration,
// including Charging Plans CRUD, already goes through this exact RPC
// mechanism, never REST).
//
// 30s interval, not Kamailio's 15s: a single round trip here is
// overwhelmingly BEAM-VM-spawn cost, not payload size (measured live,
// repeatedly, ~1.4-1.5s regardless of how many tiers one batched script
// reads) — 30s leaves large headroom on pure latency grounds. The real
// reason NOT to go faster is call-frequency exposure to a real,
// reproduced-live orphaned-process risk in runOcsEval's own nsenter
// helper (see ocs-controller.ts's own comment on that fix) — this
// monitor's cadence was deliberately chosen only after that helper was
// hardened (detached spawn + process-group kill on timeout/overflow), not
// before.
//
// One single batched eval script per poll (Tiers B-F below), each tier
// wrapped in its OWN try/catch inside the Erlang script — a bad
// assumption in one tier (a real risk: this is Mnesia record positional
// field access, no compile-time safety at all) must not zero out every
// other tier for that cycle. Every rpc:call inside uses the 5-arity form
// with an explicit per-call timeout, as defense in depth against OCS's
// own rating engine ever stalling mid-RPC (it has a real, documented,
// still-unresolved crash bug — see memory sigscale_ocs_module_progress.md)
// — a fresh throwaway Erlang node blocked forever on an unbounded 4-arity
// rpc:call would be invisible to this poller's own timeout, which only
// bounds the outer nsenter/shell process, not the RPC call happening
// inside it.
//
// On ANY failure (RPC throws, a tier's own catch caught something and
// this parser never sees its marker line, or the whole nsenter call times
// out/overflows), the entire previous snapshot is discarded and replaced
// with an all-zero, up:false snapshot — never stale-served, matching
// every other monitor in this codebase.

const POLL_INTERVAL_MS = 30_000;
const RPC_TIMEOUT_MS = 8_000; // per rpc:call, inside the Erlang script
const EVAL_TIMEOUT_MS = 25_000; // outer nsenter/shell timeout for the whole batched script

const MNESIA_TABLES = ['client', 'service', 'product', 'bucket', 'offer'] as const;
const ERLANG_MEMORY_TYPES = ['total', 'processes', 'system', 'atom', 'binary', 'code', 'ets'] as const;

export interface OcsDiameterConnection {
  service: string; // e.g. 'ocs_diameter_acct_service' / 'ocs_diameter_auth_service'
  peerOriginHost: string;
  connected: boolean; // watchdog state === 'okay'
}

export interface OcsDiameterAnswer {
  service: string;
  peerOriginHost: string;
  applicationId: number;
  commandCode: number;
  resultCode: number;
  count: number;
}

export interface OcsSubscriberBalance {
  imsi: string;
  dataRemaining: number;
  voiceRemaining: number;
}

export interface OcsStatsSnapshot {
  up: boolean;
  configured: boolean;
  sampledAt: number;
  mnesiaTableSizes: Partial<Record<(typeof MNESIA_TABLES)[number], number>>;
  balanceRemainingTotal: { octets: number; seconds: number };
  bucketCount: { octets: number; seconds: number };
  reservationsActiveTotal: number;
  bucketsWithReservations: number;
  erlangMemoryBytes: Partial<Record<(typeof ERLANG_MEMORY_TYPES)[number], number>>;
  erlangProcessCount: number;
  diameterConnections: OcsDiameterConnection[];
  diameterAnswers: OcsDiameterAnswer[];
  subscriberBalances: OcsSubscriberBalance[];
}

function emptySnapshot(configured: boolean): OcsStatsSnapshot {
  return {
    up: false,
    configured,
    sampledAt: Date.now(),
    mnesiaTableSizes: {},
    balanceRemainingTotal: { octets: 0, seconds: 0 },
    bucketCount: { octets: 0, seconds: 0 },
    reservationsActiveTotal: 0,
    bucketsWithReservations: 0,
    erlangMemoryBytes: {},
    erlangProcessCount: 0,
    diameterConnections: [],
    diameterAnswers: [],
    subscriberBalances: [],
  };
}

// Positional #service{}/#product{}/#bucket{}/#offer{} field offsets below
// match charging-plans-controller.ts's own header comment exactly (and,
// for #offer{}'s status/specification positions, were independently
// re-confirmed live during this feature's own review) — never diverge
// from that file's offsets without updating both.
async function statsScript(): Promise<string> {
  const node = await getOcsNodeName();
  return [
    `Node = '${node}',`,
    `Rpc5 = fun(M,F,A) -> rpc:call(Node, M, F, A, ${RPC_TIMEOUT_MS}) end,`,
    `Ocs = fun(F, A) -> Rpc5(ocs, F, A) end,`,

    `try`,
    `  Sizes = [ {T, Rpc5(mnesia, table_info, [T, size])} || T <- [${MNESIA_TABLES.join(',')}] ],`,
    `  io:format("TIER_B ~p~n", [Sizes])`,
    `catch _:_ -> io:format("TIER_B ERR~n", [])`,
    `end,`,

    `try`,
    `  BKeys = Rpc5(mnesia, dirty_all_keys, [bucket]),`,
    `  GetB = fun(K) -> case Ocs(find_bucket, [K]) of {ok,B} -> B; _ -> undefined end end,`,
    `  Buckets = [ B || K <- BKeys, (B = GetB(K)) =/= undefined ],`,
    `  Remain = fun(U) -> lists:sum([ element(7,B) || B <- Buckets, element(9,B) =:= U ]) end,`,
    `  Cnt = fun(U) -> length([ B || B <- Buckets, element(9,B) =:= U ]) end,`,
    `  ResvCnt = fun(B) -> map_size(maps:get(reservations, element(8,B), #{})) end,`,
    `  io:format("TIER_C ~p~n", [{Remain(octets), Cnt(octets), Remain(seconds), Cnt(seconds), lists:sum([ResvCnt(B) || B <- Buckets]), length([B || B <- Buckets, ResvCnt(B) > 0])}])`,
    `catch _:_ -> io:format("TIER_C ERR~n", [])`,
    `end,`,

    `try`,
    `  Mem = Rpc5(erlang, memory, []),`,
    `  io:format("TIER_D_MEM ~p~n", [Mem])`,
    `catch _:_ -> io:format("TIER_D_MEM ERR~n", [])`,
    `end,`,

    `try`,
    `  Proc = Rpc5(erlang, system_info, [process_count]),`,
    `  io:format("TIER_D_PROC ~p~n", [Proc])`,
    `catch _:_ -> io:format("TIER_D_PROC ERR~n", [])`,
    `end,`,

    // Watchdog is a {Pid, Ref, State} 3-tuple; caps' origin_host is a
    // {LocalOriginHost, RemoteOriginHost} 2-tuple; diameter:service_info/2
    // needs the EXACT tuple diameter:services/0 returns as its Service
    // arg, not a reconstructed bare atom — all three confirmed live
    // against the real running node, not assumed from generic OTP docs.
    // Only the Result-Code-tagged 3-element statistics entries are kept
    // (an OCS "answer sent" signal) — the base-protocol/raw recv counts
    // and bare error markers the same statistics proplist also carries
    // are deliberately left out, matching the dashboard's own "answers by
    // result code" scope rather than exposing every possible sub-metric.
    `try`,
    `  GetWd = fun(Conn) -> case proplists:get_value(watchdog, Conn, undefined) of {_,_,St} -> St; _ -> unknown end end,`,
    `  GetHost = fun(Conn) -> Caps = proplists:get_value(caps, Conn, []), case proplists:get_value(origin_host, Caps, undefined) of {_,R} -> R; _ -> <<"unknown">> end end,`,
    `  GetAns = fun(Conn) -> Stats = proplists:get_value(statistics, Conn, []), [ {element(1,element(1,K)), element(2,element(1,K)), element(2,element(3,K)), V} || {K,V} <- Stats, tuple_size(K) =:= 3, is_tuple(element(3,K)), element(1,element(3,K)) =:= 'Result-Code' ] end,`,
    `  PerSvc = fun(Svc) -> Conns = Rpc5(diameter, service_info, [Svc, connections]), [ {element(1,Svc), GetWd(C), GetHost(C), GetAns(C)} || C <- Conns ] end,`,
    `  Services = Rpc5(diameter, services, []),`,
    `  EInfo = lists:flatten([ PerSvc(S) || S <- Services ]),`,
    `  io:format("TIER_E ~p~n", [EInfo])`,
    `catch _:_ -> io:format("TIER_E ERR~n", [])`,
    `end,`,

    // Real, live-confirmed gap: a subscriber is NOT always reachable via
    // both an IMSI-keyed and MSISDN-keyed #service{} pointing at one
    // product — a product manually created via OCS's own GUI (or from
    // before the "link every identity atomically" fix — see memory
    // sigscale_ocs_module_progress.md) can carry only an MSISDN-shaped
    // identity with no IMSI-shaped one at all. Never guess/mislabel that
    // MSISDN as an imsi — skip the product entirely (confirmed live: of
    // 11 real products, exactly 1 has this shape).
    `try`,
    `  ProdKeys = Rpc5(mnesia, dirty_all_keys, [product]),`,
    `  GetP = fun(K) -> case Ocs(find_product, [K]) of {ok,P} -> P; _ -> undefined end end,`,
    `  Products = [ P || K <- ProdKeys, (P = GetP(K)) =/= undefined ],`,
    `  IsImsi = fun(Id) -> is_binary(Id) andalso byte_size(Id) =:= 15 andalso lists:all(fun(C) -> C >= $0 andalso C =< $9 end, binary_to_list(Id)) end,`,
    `  BRemain = fun(BucketIds, U) -> lists:sum([ element(7,B) || BId <- BucketIds, {ok,B} <- [Ocs(find_bucket,[BId])], element(9,B) =:= U ]) end,`,
    `  Describe = fun(P) ->`,
    `    case lists:filter(IsImsi, element(11, P)) of`,
    `      [Imsi | _] -> {Imsi, BRemain(element(10,P), octets), BRemain(element(10,P), seconds)};`,
    `      [] -> skip`,
    `    end`,
    `  end,`,
    `  FInfo = [ R || P <- Products, (R = Describe(P)) =/= skip ],`,
    `  io:format("TIER_F ~p~n", [FInfo])`,
    `catch _:_ -> io:format("TIER_F ERR~n", [])`,
    `end,`,

    `init:stop().`,
  ].join('\n');
}

// Erlang's io:format("~p", [Term]) line-wraps and indents large terms
// (confirmed live: TIER_D_MEM/TIER_E/TIER_F routinely span many lines at
// real deployment size, even though a small test happened to keep them
// on one line) — but never splits a small tuple like {app,cmd,result,
// count} itself across a line break, only ever between list elements.
// So extraction has two steps: pull out this tag's own multi-line body,
// bounded by the next tag's start position (or end of string) — then
// parse individual tuples out of that body with plain (un-anchored)
// global regexes, which tolerate the embedded newlines/indentation
// between elements just fine.
//
// Deliberately NOT a single regex with a `(?:\n[A-Z]...|$)` lookahead —
// a real, self-caught bug: with the `m` flag `^`/`$` need for the tag's
// OWN start-of-line match, a bare `$` in that lookahead matches before
// EVERY line ending, not just true end-of-string, so a lazy match stops
// after the section's first wrapped line instead of its true end
// (reproduced live against real deployment-sized output before shipping
// this — TIER_D_MEM/TIER_E/TIER_F all silently truncated to one line).
const KNOWN_TAGS = ['TIER_B', 'TIER_C', 'TIER_D_MEM', 'TIER_D_PROC', 'TIER_E', 'TIER_F'];
function extractSection(stdout: string, tag: string): string | null {
  const startMatch = new RegExp(`(?:^|\\n)${tag}\\s`).exec(stdout);
  if (!startMatch) return null;
  const contentStart = startMatch.index + startMatch[0].length;
  let end = stdout.length;
  for (const other of KNOWN_TAGS) {
    if (other === tag) continue;
    const otherMatch = new RegExp(`\\n${other}\\s`).exec(stdout.slice(contentStart));
    if (otherMatch) end = Math.min(end, contentStart + otherMatch.index);
  }
  const body = stdout.slice(contentStart, end).trim();
  return body === 'ERR' ? null : body;
}

function parseTierB(stdout: string): OcsStatsSnapshot['mnesiaTableSizes'] {
  const out: OcsStatsSnapshot['mnesiaTableSizes'] = {};
  const body = extractSection(stdout, 'TIER_B');
  if (!body) return out;
  const re = /\{(\w+),(\d+)\}/g;
  let e: RegExpExecArray | null;
  while ((e = re.exec(body)) !== null) {
    out[e[1] as (typeof MNESIA_TABLES)[number]] = Number(e[2]);
  }
  return out;
}

function parseTierC(stdout: string): Pick<OcsStatsSnapshot, 'balanceRemainingTotal' | 'bucketCount' | 'reservationsActiveTotal' | 'bucketsWithReservations'> | null {
  const body = extractSection(stdout, 'TIER_C');
  if (!body) return null;
  const m = /\{(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\}/.exec(body);
  if (!m) return null;
  return {
    balanceRemainingTotal: { octets: Number(m[1]), seconds: Number(m[3]) },
    bucketCount: { octets: Number(m[2]), seconds: Number(m[4]) },
    reservationsActiveTotal: Number(m[5]),
    bucketsWithReservations: Number(m[6]),
  };
}

function parseTierDMem(stdout: string): OcsStatsSnapshot['erlangMemoryBytes'] {
  const out: OcsStatsSnapshot['erlangMemoryBytes'] = {};
  const body = extractSection(stdout, 'TIER_D_MEM');
  if (!body) return out;
  for (const type of ERLANG_MEMORY_TYPES) {
    const em = new RegExp(`\\{${type},(\\d+)\\}`).exec(body);
    if (em) out[type] = Number(em[1]);
  }
  return out;
}

function parseTierDProc(stdout: string): number {
  const body = extractSection(stdout, 'TIER_D_PROC');
  return body ? Number(body) || 0 : 0;
}

function parseTierE(stdout: string): { connections: OcsDiameterConnection[]; answers: OcsDiameterAnswer[] } {
  const connections: OcsDiameterConnection[] = [];
  const answers: OcsDiameterAnswer[] = [];
  const body = extractSection(stdout, 'TIER_E');
  if (!body) return { connections, answers };
  // Each connection: {service, watchdogState, <<"peer.host">>, [ {app,cmd,result,count}, ... ]}
  const connRe = /\{(\w+),\s*(\w+),\s*<<"([^"]*)">>,\s*\[([^\]]*)\]\}/g;
  let c: RegExpExecArray | null;
  while ((c = connRe.exec(body)) !== null) {
    const [, service, watchdog, peerOriginHost, answersBody] = c;
    connections.push({ service, peerOriginHost, connected: watchdog === 'okay' });
    const ansRe = /\{(\d+),(\d+),(\d+),(\d+)\}/g;
    let a: RegExpExecArray | null;
    while ((a = ansRe.exec(answersBody)) !== null) {
      answers.push({
        service,
        peerOriginHost,
        applicationId: Number(a[1]),
        commandCode: Number(a[2]),
        resultCode: Number(a[3]),
        count: Number(a[4]),
      });
    }
  }
  return { connections, answers };
}

function parseTierF(stdout: string): OcsSubscriberBalance[] {
  const out: OcsSubscriberBalance[] = [];
  const body = extractSection(stdout, 'TIER_F');
  if (!body) return out;
  const re = /\{<<"(\d+)">>,\s*(-?\d+),\s*(-?\d+)\}/g;
  let e: RegExpExecArray | null;
  while ((e = re.exec(body)) !== null) {
    out.push({ imsi: e[1], dataRemaining: Number(e[2]), voiceRemaining: Number(e[3]) });
  }
  return out;
}

export class OcsStatsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private latest: OcsStatsSnapshot = emptySnapshot(false);

  constructor(private readonly logger: pino.Logger) {}

  start(): void {
    if (this.timer) return;
    this.sample().catch(err => this.logger.debug({ err: String(err) }, 'OCS stats: initial sample failed'));
    this.timer = setInterval(() => {
      this.sample().catch(err => this.logger.debug({ err: String(err) }, 'OCS stats: sample failed'));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getLatest(): OcsStatsSnapshot {
    return this.latest;
  }

  private async sample(): Promise<void> {
    // Skips the RPC round trip entirely (no throwaway Erlang node spawned
    // at all) on any deployment where OCS was never configured — the
    // common case, since ENABLE_OCS_MODULE defaults disabled.
    if (!readState()) {
      this.latest = emptySnapshot(false);
      return;
    }
    // Overlapping-tick guard: if one round trip ever hangs past a single
    // 30s interval, skip the next tick rather than spawning a second
    // throwaway Erlang node on top of a possibly-still-running one.
    if (this.sampling) return;
    this.sampling = true;
    try {
      const script = await statsScript();
      const stdout = await runOcsEval(script, EVAL_TIMEOUT_MS);
      const tierC = parseTierC(stdout);
      const { connections, answers } = parseTierE(stdout);
      const snapshot: OcsStatsSnapshot = {
        up: true,
        configured: true,
        sampledAt: Date.now(),
        mnesiaTableSizes: parseTierB(stdout),
        balanceRemainingTotal: tierC?.balanceRemainingTotal ?? { octets: 0, seconds: 0 },
        bucketCount: tierC?.bucketCount ?? { octets: 0, seconds: 0 },
        reservationsActiveTotal: tierC?.reservationsActiveTotal ?? 0,
        bucketsWithReservations: tierC?.bucketsWithReservations ?? 0,
        erlangMemoryBytes: parseTierDMem(stdout),
        erlangProcessCount: parseTierDProc(stdout),
        diameterConnections: connections,
        diameterAnswers: answers,
        subscriberBalances: parseTierF(stdout),
      };
      this.latest = snapshot;
    } catch (err) {
      // Never stale-serve — a failed poll means "unknown right now", not
      // "still whatever it was 30s ago".
      this.latest = emptySnapshot(true);
      throw err;
    } finally {
      this.sampling = false;
    }
  }
}
