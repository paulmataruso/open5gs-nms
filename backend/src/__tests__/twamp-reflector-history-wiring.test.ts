import * as fs from 'fs';
import * as path from 'path';

// Static wiring guard for the reflector half of TWAMP history, in the same
// style as ran-grouping-wiring.test.ts. The arithmetic is executed in
// twamp-reflector-sample.test.ts; what cannot be executed here is the
// wiring, and each of these regressions is silent — the page keeps loading,
// the charts keep rendering, and they are simply always empty or always
// wrong:
//
//   * TwampReflectorMonitor not started in index.ts. Nothing ever writes a
//     sample, so the History tab's Reflector view shows its "no history in
//     this range" state forever, which reads as "this deployment has no
//     inbound clients" rather than "nothing is recording".
//   * The reflector collection missing from one of the three places the TTL
//     index is applied. Retention then silently differs between the two
//     halves of the same page's one Retention control.
//   * The per-peer series reverting to $unwind. Presence would then be 100%
//     in every bucket by construction, which is the one number that view
//     exists to show.

const SRC = path.resolve(__dirname, '..');
const FRONTEND = path.resolve(__dirname, '../../../frontend/src');
const read = (base: string, rel: string) => fs.readFileSync(path.join(base, rel), 'utf-8');

const INDEX = read(SRC, 'index.ts');
const CONTROLLER = read(SRC, 'interfaces/rest/twamp-controller.ts');
const STORE = read(SRC, 'application/use-cases/twamp/twamp-reflector-history.ts');
const MONITOR = read(SRC, 'application/use-cases/twamp/twamp-reflector-monitor.ts');
const RUNNER = read(SRC, 'application/use-cases/twamp/twamp-runner.ts');
const RESTORE = read(SRC, 'application/use-cases/backup-restart-usecase.ts');
const PAGE = read(FRONTEND, 'pages/TwampPage.tsx');
const API = read(FRONTEND, 'api/twamp.ts');

describe('TWAMP reflector history — wiring', () => {
  test('the sampler is constructed at startup', () => {
    expect(INDEX).toContain("import { TwampReflectorMonitor } from './application/use-cases/twamp/twamp-reflector-monitor'");
    expect(INDEX).toMatch(/new TwampReflectorMonitor\(subscriberRepo\.getDb\(\), hostExecutor, logger\)/);
  });

  test('the TTL index is applied in all three places the client-side one is', () => {
    // Boot and the retention-settings route, both in the controller...
    expect(CONTROLLER.match(/ensureReflectorHistoryIndexes\(db, /g) ?? []).toHaveLength(2);
    // ...and the restore path, which has its own documented gap for exactly
    // this (nothing in a restore re-runs a boot-time index call).
    expect(RESTORE).toContain('ensureReflectorHistoryIndexes(this.db, saved.history.retentionDays)');
  });

  test('retention is one shared setting, not a second one for the reflector', () => {
    // A separate reflector retention value would need its own control, its
    // own state key and its own restore handling; the page has one input.
    expect(STORE).not.toMatch(/REFLECTOR_[A-Z_]*RETENTION_DAYS/);
    expect(CONTROLLER).toMatch(/await ensureHistoryIndexes\(db, retentionDays!\);\s*\n\s*await ensureReflectorHistoryIndexes\(db, retentionDays!\);/);
  });

  test('both read routes exist and the series route takes an optional peerIp', () => {
    expect(CONTROLLER).toContain("router.get('/server/history/summary'");
    expect(CONTROLLER).toContain("router.get('/server/history/series'");
    // One route, two shapes — the aggregate series and the per-peer
    // drill-down differ only by whether a peer was named.
    expect(CONTROLLER).toMatch(/queryReflectorPeerSeries\(db, peerIp,/);
    expect(CONTROLLER).toMatch(/: await queryReflectorSeries\(db, new Date\(fromMs\)/);
  });

  test('the per-peer series keeps ticks where the peer was absent', () => {
    // $unwind drops them, which silently turns presenceRatio into a constant
    // 1.0. $arrayElemAt over $filter keeps one row per tick either way.
    const peerSeries = STORE.slice(STORE.indexOf('export async function queryReflectorPeerSeries'));
    // Matched in their CODE forms: this function's own comments name both
    // operators to explain the choice, so a bare name match would stay green
    // after the pipeline itself was changed.
    expect(peerSeries).toContain('$arrayElemAt: [');
    expect(peerSeries).not.toContain('$unwind:');
    // $type, not a null comparison — $arrayElemAt leaves the field missing,
    // and missing-vs-null semantics are what would make every bucket read
    // as fully present.
    expect(peerSeries).toContain("$eq: [{ $type: '$_peer' }, 'object']");
  });

  test('one document is written per tick, so an idle or stopped reflector is still a sample', () => {
    // Per-peer documents would write nothing for a tick with no clients,
    // making a genuine zero indistinguishable from a sampler that was not
    // running.
    expect(MONITOR.match(/recordReflectorHistorySample\(/g) ?? []).toHaveLength(1);
    expect(MONITOR).toMatch(/if \(!isTwampServerInstalled\(\)\) return;/);
    expect(MONITOR).toMatch(/if \(!server\?\.listenPort\) return;/);
  });

  test('the sampler drops its counter baseline when the reflector is not running', () => {
    // Carrying a pre-restart counter across an outage would attribute the
    // whole gap to one 30-second sample.
    expect(MONITOR).toContain('this.prevCounters = serviceActive ? counters : {};');
    expect(MONITOR).toContain('this.prevSampleAt = serviceActive ? now : 0;');
  });

  test('the reflector metrics reader is shared with the Info & Stats route', () => {
    // Two copies of "what the reflector reports" is how a table and a graph
    // of the same thing start to disagree — the same reasoning
    // getFullConnections/getLightPeers already carry.
    expect(RUNNER).toContain('export async function getReflectorMetrics(');
    expect(RUNNER).toContain('export function lightPacketCountersByIp(');
    expect(CONTROLLER).toContain('const { available, data } = await getReflectorMetrics(hostExecutor);');
    expect(CONTROLLER).not.toContain('function parsePrometheusText');
    expect(MONITOR).toContain('lightPacketCountersByIp(metricsRes.data)');
  });

  test('the History tab offers both directions and renders both views', () => {
    expect(PAGE).toContain('<SubTab value="targets"');
    expect(PAGE).toContain('<SubTab value="reflector"');
    expect(PAGE).toMatch(/<TargetHistoryView timeRange=\{timeRange\}/);
    expect(PAGE).toMatch(/<ReflectorHistoryView timeRange=\{timeRange\}/);
  });

  test('the reflector view actually queries the reflector endpoints', () => {
    expect(API).toContain("api.get('/server/history/summary'");
    expect(API).toContain("api.get('/server/history/series'");
    expect(PAGE).toContain('twampApi.getReflectorHistorySummary(from, to)');
    expect(PAGE).toContain('twampApi.getReflectorHistorySeries(from, to)');
    expect(PAGE).toContain('twampApi.getReflectorHistoryPeerSeries(peerIp, from, to)');
  });

  test('the reflector view has a Connected Clients graph, which is the whole ask', () => {
    expect(PAGE).toContain('Reflector — Connected Clients Over Time');
    expect(PAGE).toMatch(/dataKey="avgTotalPeers"/);
    expect(PAGE).toMatch(/dataKey="maxTotalPeers"/);
    // Client counts are whole devices; a fractional axis tick reads as a bug.
    expect(PAGE).toMatch(/yAxisId="count"[^>]*allowDecimals=\{false\}/s);
  });

  test('a failed read is not rendered as "nothing was recorded"', () => {
    // The empty state asserts a fact about the store. Showing it after a
    // failed request states the opposite of what actually happened, and is
    // the kind of wrong that sends someone to check a radio.
    expect(PAGE).toContain('Reflector — History Unavailable');
    expect(PAGE).toMatch(/if \(loadError\) \{/);
    expect(PAGE).toMatch(/setLoadError\(err\?\.response\?\.data\?\.error/);
  });

  test('both halves share the time range and the refresh, so they cannot disagree about "now"', () => {
    expect(PAGE).toMatch(/interface HistoryViewProps \{\s*\n\s*timeRange: TimeRangeValue;\s*\n\s*reloadKey: number;/);
    // Both views' loaders re-run on a range change AND on Refresh.
    expect(PAGE.match(/\}, \[timeRange, reloadKey\]\);/g) ?? []).toHaveLength(4);
  });
});
