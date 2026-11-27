import { genieacsLineTimestamp } from '../genieacs-log-line';

/** A fixed clock, so the fallback is observable rather than "roughly now". */
const FROZEN = new Date('2026-11-27T12:00:00.000Z');
const now = (): Date => FROZEN;

describe('genieacsLineTimestamp', () => {
  it('reads an epoch-millis time, which is what GenieACS writes', () => {
    const line = JSON.stringify({ level: 30, time: 1764244800000, message: 'Inform' });
    expect(genieacsLineTimestamp(line, now)).toBe(new Date(1764244800000).toISOString());
  });

  it('reads an ISO-string time', () => {
    const line = JSON.stringify({ time: '2026-11-27T10:18:00.000Z', message: 'Inform' });
    expect(genieacsLineTimestamp(line, now)).toBe('2026-11-27T10:18:00.000Z');
  });

  it('does NOT throw on a time that cannot be a date', () => {
    // The defect. `new Date(x).toISOString()` on an Invalid Date throws, and
    // this runs inside a `.map()` with no try/catch of its own — so one odd
    // line cost the whole recent-logs response, not just its own timestamp.
    for (const time of ['not-a-date', '', {}, [], true, null, NaN, Infinity]) {
      expect(() => genieacsLineTimestamp(JSON.stringify({ time }), now)).not.toThrow();
      expect(genieacsLineTimestamp(JSON.stringify({ time }), now)).toBe(FROZEN.toISOString());
    }
  });

  it('falls back for a line with no time field', () => {
    expect(genieacsLineTimestamp(JSON.stringify({ message: 'x' }), now)).toBe(FROZEN.toISOString());
  });

  it('falls back for a line that is not JSON at all', () => {
    // GenieACS also writes plain-text lines during startup and on crash.
    for (const line of ['', '   ', 'GenieACS starting', '{broken', 'null', '5', '"str"']) {
      expect(genieacsLineTimestamp(line, now)).toBe(FROZEN.toISOString());
    }
  });

  it('accepts epoch 0 rather than treating it as absent', () => {
    // A falsy-but-valid reading: the old code tested `if (parsed.time)`, so
    // 0 took the fallback. Keeping it is strictly more faithful, and it sorts
    // where it belongs instead of jumping to the top as "now".
    expect(genieacsLineTimestamp(JSON.stringify({ time: 0 }), now)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('is usable as a sort key across a mixed batch', () => {
    const lines = [
      JSON.stringify({ time: 1764244800000 }),
      JSON.stringify({ time: '2026-01-01T00:00:00.000Z' }),
      'not json',
    ];
    const stamps = lines.map(l => genieacsLineTimestamp(l, now));
    expect([...stamps].sort()).toEqual([
      '2026-01-01T00:00:00.000Z',
      new Date(1764244800000).toISOString(),
      FROZEN.toISOString(),
    ].sort());
  });
});
