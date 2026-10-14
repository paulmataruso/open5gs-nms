import * as https from 'https';
import { EventEmitter } from 'events';
import { fetchOsmBuildings, clearOsmBuildingCache } from '../osm-buildings';

// These tests drive the real fetch logic against a stubbed https.request, so
// the mirror hedging, the transient retry and — most importantly — the
// error-remark guard are exercised without touching the public Overpass
// instances (which are rate-limited donated infrastructure; hammering them
// from a test suite would be both rude and flaky).

type Responder = (url: string, attempt: number) => { status: number; body: string } | 'hang';

let responder: Responder;
const attempts: string[] = [];
const attemptCounts = new Map<string, number>();

function hostOf(options: https.RequestOptions): string {
  return String(options.hostname ?? '');
}

jest.mock('https', () => ({ request: jest.fn() }));

beforeEach(() => {
  clearOsmBuildingCache();
  attempts.length = 0;
  attemptCounts.clear();
  jest.useFakeTimers();
  (https.request as unknown as jest.Mock).mockImplementation(
    (options: https.RequestOptions, callback: (res: unknown) => void) => {
      const host = hostOf(options);
      const count = (attemptCounts.get(host) ?? 0) + 1;
      attemptCounts.set(host, count);
      attempts.push(host);

      const request = new EventEmitter() as EventEmitter & {
        write: () => void; end: () => void; destroy: (e?: Error) => void; setTimeout?: unknown;
      };
      request.write = () => {};
      request.end = () => {};
      request.destroy = (error?: Error) => { request.emit('error', error ?? new Error('destroyed')); };

      const outcome = responder(host, count);
      if (outcome !== 'hang') {
        // Deliver on a macrotask so the hedging loop can observe ordering.
        setTimeout(() => {
          const response = new EventEmitter() as EventEmitter & { statusCode: number };
          response.statusCode = outcome.status;
          callback(response);
          response.emit('data', Buffer.from(outcome.body));
          response.emit('end');
        }, 1);
      }
      return request;
    },
  );
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

/** Drive timers until the promise settles. */
async function resolveWithTimers<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
  for (let i = 0; i < 400; i++) {
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    await Promise.resolve();
  }
  const result = await settled;
  if (result.ok) return result.v;
  throw result.e;
}

const BOUNDS: [number, number, number, number] = [-72.19, 43.37, -72.17, 43.38];

function waysBody(count: number): string {
  const elements = Array.from({ length: count }, (_, i) => ({
    type: 'way',
    id: 1000 + i,
    tags: { building: 'house' },
    geometry: [
      { lat: 43.375, lon: -72.18 }, { lat: 43.3751, lon: -72.18 },
      { lat: 43.3751, lon: -72.1799 }, { lat: 43.375, lon: -72.1799 },
      { lat: 43.375, lon: -72.18 },
    ],
  }));
  return JSON.stringify({ elements });
}

describe('fetchOsmBuildings error handling', () => {
  it('NEVER reports an error remark as an empty area', async () => {
    // Overpass answers HTTP 200 with an empty elements array AND a runtime
    // error remark. Treating that as authoritative would tell the operator
    // "no buildings here", which is a false statement about the world rather
    // than an error about the request — the worst possible failure mode.
    responder = () => ({
      status: 200,
      body: JSON.stringify({
        version: 0.6,
        elements: [],
        remark: 'runtime error: Query timed out in "query" at line 1 after 55 seconds.',
      }),
    });
    await expect(resolveWithTimers(fetchOsmBuildings(BOUNDS))).rejects.toThrow(/runtime error|timed out/i);
  });

  it('reports a genuinely empty bbox as zero buildings, not as a failure', async () => {
    responder = () => ({ status: 200, body: JSON.stringify({ version: 0.6, elements: [] }) });
    const result = await resolveWithTimers(fetchOsmBuildings(BOUNDS));
    expect(result.features).toHaveLength(0);
    expect(result.rawWays).toBe(0);
  });

  it('surfaces Overpass’s own error text out of a 504 body', async () => {
    responder = () => ({
      status: 504,
      body: '<html><body><p><strong style="color:#FF0000">Error</strong>: runtime error: ' +
            'Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy. </p></body></html>',
    });
    await expect(resolveWithTimers(fetchOsmBuildings(BOUNDS)))
      .rejects.toThrow(/too busy/i);
  });

  it('retries a transient 504 on the same mirror before giving up on it', async () => {
    responder = (_host, attempt) => attempt === 1
      ? { status: 504, body: 'busy' }
      : { status: 200, body: waysBody(2) };
    const result = await resolveWithTimers(fetchOsmBuildings(BOUNDS));
    expect(result.features).toHaveLength(2);
    // Same host tried twice rather than immediately abandoning it.
    expect(attemptCounts.get('overpass.kumi.systems')).toBeGreaterThanOrEqual(2);
  });

  it('does not retry a non-transient rejection', async () => {
    responder = () => ({ status: 400, body: 'bad query' });
    await expect(resolveWithTimers(fetchOsmBuildings(BOUNDS))).rejects.toThrow(/HTTP 400/);
    // One shot per mirror, three mirrors — no retry on a rejected query.
    expect(attemptCounts.get('overpass.kumi.systems')).toBe(1);
  });

  it('hedges onto another mirror when the first one hangs, and still succeeds', async () => {
    // Exactly the measured production failure: the first-choice mirror hangs
    // while a later one answers quickly.
    responder = host => (host === 'overpass.kumi.systems' ? 'hang' : { status: 200, body: waysBody(3) });
    const result = await resolveWithTimers(fetchOsmBuildings(BOUNDS));
    expect(result.features).toHaveLength(3);
    expect(result.endpoint).not.toContain('kumi');
  });

  it('names every mirror it tried when all of them fail', async () => {
    responder = () => ({ status: 503, body: 'down' });
    await expect(resolveWithTimers(fetchOsmBuildings(BOUNDS))).rejects.toThrow(/kumi|overpass-api\.de|private\.coffee/);
  });
});

describe('fetchOsmBuildings caching', () => {
  it('serves a repeat of the same bbox from cache without touching the network', async () => {
    responder = () => ({ status: 200, body: waysBody(4) });
    const first = await resolveWithTimers(fetchOsmBuildings(BOUNDS));
    expect(first.cached).toBeUndefined();
    const callsAfterFirst = (https.request as unknown as jest.Mock).mock.calls.length;

    const second = await resolveWithTimers(fetchOsmBuildings(BOUNDS));
    expect(second.cached).toBe(true);
    expect(second.features).toHaveLength(4);
    expect((https.request as unknown as jest.Mock).mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not let a failure poison the cache', async () => {
    responder = () => ({ status: 503, body: 'down' });
    await expect(resolveWithTimers(fetchOsmBuildings(BOUNDS))).rejects.toThrow();
    responder = () => ({ status: 200, body: waysBody(1) });
    const result = await resolveWithTimers(fetchOsmBuildings(BOUNDS));
    expect(result.features).toHaveLength(1);
  });

  it('treats a different bbox as a different key', async () => {
    responder = () => ({ status: 200, body: waysBody(2) });
    await resolveWithTimers(fetchOsmBuildings(BOUNDS));
    const calls = (https.request as unknown as jest.Mock).mock.calls.length;
    await resolveWithTimers(fetchOsmBuildings([-72.30, 43.40, -72.28, 43.41]));
    expect((https.request as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(calls);
  });
});
