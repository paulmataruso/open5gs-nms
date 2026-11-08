import { prunedDirectivesFor, upsertVtyPathDirectives, ownedDirectivesFromGenerated } from '../vty-config-ownership';

// Regression guard for a real total outage reproduced on a clean host
// 2026-11-08: turning GPRS off for a BTS produced an osmo-bsc.cfg that
// osmo-bsc refused outright, taking all of 2G down.
//
//   Error occurred during reading the below line:
//     gprs nsvc 0 remote ip 127.0.0.1
//   % GPRS is not enabled on BTS 0
//   Failed to parse the config file: '/etc/osmocom/osmo-bsc.cfg'
//
// Cause: the generator emits the whole `gprs nsvc/nsei/cell bvci` block or
// none of it, and `upsertVtyPathDirectives` only ever replaces or ADDS what
// the generator currently emits — a line it has stopped emitting survives. For
// hand-maintained settings that is the whole point; for a family the generator
// owns end to end the leftovers are invalid on their own.

const FAMILIES = [/^gprs (nsvc|nsei|cell|mode|routing area code|network-control-order)\b/];
const KEY_TOKENS = [{ match: /^gprs nsvc \d+ remote ip\b/, tokens: 5 }];

const WITH_GPRS = `network
 network country code 001
 bts 0
  type osmo-bts
  gprs mode gprs
  gprs nsvc 0 remote ip 127.0.0.1
  gprs nsvc 0 remote udp port 23000
  gprs nsei 6969
  gprs cell bvci 6969
`;

const WITHOUT_GPRS = `network
 network country code 001
 bts 0
  type osmo-bts
  gprs mode none
`;

describe('prunedDirectivesFor', () => {
  it('removes the stale gprs block when the generator stops emitting it', () => {
    const removals = prunedDirectivesFor(WITH_GPRS, WITHOUT_GPRS, FAMILIES);
    const lines = removals.map(r => r.prefix.source);
    expect(removals.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/gprs nsvc 0 remote ip/);
    expect(lines.join('\n')).toMatch(/gprs nsei 6969/);
    // Every entry must be a removal.
    expect(removals.every(r => r.line === null)).toBe(true);
  });

  it('keeps a family member the generator still emits', () => {
    // `gprs mode` is emitted in both, just with a different value — it must be
    // replaced by the upsert, not pruned.
    const removals = prunedDirectivesFor(WITH_GPRS, WITHOUT_GPRS, FAMILIES);
    expect(removals.map(r => r.prefix.source).join('\n')).not.toMatch(/gprs mode none/);
  });

  it('removes nothing when the generator still emits the whole family', () => {
    expect(prunedDirectivesFor(WITH_GPRS, WITH_GPRS, FAMILIES)).toEqual([]);
  });

  it('leaves directives outside the declared families completely alone', () => {
    const removals = prunedDirectivesFor(WITH_GPRS, WITHOUT_GPRS, FAMILIES);
    const src = removals.map(r => r.prefix.source).join('\n');
    expect(src).not.toMatch(/type osmo-bts/);
    expect(src).not.toMatch(/network country code/);
  });

  it('is scoped PER PATH, so one BTS keeping GPRS does not protect another', () => {
    const twoBts = `network
 bts 0
  gprs mode gprs
  gprs nsei 1
 bts 1
  gprs mode gprs
  gprs nsei 2
`;
    const onlyBts0 = `network
 bts 0
  gprs mode gprs
  gprs nsei 1
 bts 1
  gprs mode none
`;
    const removals = prunedDirectivesFor(twoBts, onlyBts0, FAMILIES);
    // Every removal must belong to bts 1. bts 0's lines are still generated
    // verbatim, so none of them may be touched — that is the per-path point.
    expect(removals.length).toBeGreaterThan(0);
    for (const r of removals) expect(r.path).toEqual(['network', 'bts 1']);
    const src = removals.map(r => r.prefix.source).join('\n');
    expect(src).toMatch(/gprs nsei 2/);
    expect(src).not.toMatch(/gprs nsei 1/);
  });

  it('end to end: the merged config has no orphaned gprs lines', () => {
    // This is the shape osmo-bsc rejected.
    let merged = WITH_GPRS;
    merged = upsertVtyPathDirectives(merged, prunedDirectivesFor(merged, WITHOUT_GPRS, FAMILIES));
    merged = upsertVtyPathDirectives(merged, ownedDirectivesFromGenerated(WITHOUT_GPRS, KEY_TOKENS));
    expect(merged).toContain('gprs mode none');
    expect(merged).not.toMatch(/gprs nsvc/);
    expect(merged).not.toMatch(/gprs nsei/);
    expect(merged).not.toMatch(/gprs cell bvci/);
    // And the unrelated lines survive.
    expect(merged).toContain('type osmo-bts');
    expect(merged).toContain('network country code 001');
  });

  it('is idempotent — a second prune+upsert changes nothing', () => {
    let once = WITH_GPRS;
    once = upsertVtyPathDirectives(once, prunedDirectivesFor(once, WITHOUT_GPRS, FAMILIES));
    once = upsertVtyPathDirectives(once, ownedDirectivesFromGenerated(WITHOUT_GPRS, KEY_TOKENS));
    let twice = once;
    twice = upsertVtyPathDirectives(twice, prunedDirectivesFor(twice, WITHOUT_GPRS, FAMILIES));
    twice = upsertVtyPathDirectives(twice, ownedDirectivesFromGenerated(WITHOUT_GPRS, KEY_TOKENS));
    expect(twice).toBe(once);
  });
});
