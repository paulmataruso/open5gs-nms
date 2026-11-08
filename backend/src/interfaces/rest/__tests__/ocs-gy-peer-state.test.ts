import { parseGyPeerCount } from '../ocs-controller';

// Guards the contract between the Erlang snippet in isGyPeerOpen() and the
// TypeScript that reads its output.
//
// Why this check exists at all: the previous implementation grepped SMF's own
// log for `<originHost>.*STATE_OPEN`, which was a confirmed false negative on
// a clean host 2026-11-07 — the Gy peer was fully established (OCS's own
// `diameter:service_info` showed `{watchdog, {_,_,okay}}` and both
// Origin-Hosts negotiated) while the OCS page reported it down. Open5GS's
// bundled freeDiameter logs `CONNECTED TO '<peer>'` at INFO and never emits
// `STATE_*` at default verbosity: measured 16 vs 0 on the live host. It also
// logs no disconnect line at all, so a log grep could not answer "is it up
// now" even in principle.
describe('parseGyPeerCount', () => {
  it('reads a single open peer', () => {
    expect(parseGyPeerCount('GYPEERS=1\n')).toBe(1);
  });

  it('reads zero open peers', () => {
    expect(parseGyPeerCount('GYPEERS=0\n')).toBe(0);
  });

  it('reads more than one open peer', () => {
    expect(parseGyPeerCount('GYPEERS=3\n')).toBe(3);
  });

  it('tolerates the Erlang banner and warnings around the marker', () => {
    const noisy = [
      'Erlang/OTP 25 [erts-13.2.2.5] [source] [64-bit] [smp:4:4]',
      'Eshell V13.2.2.5  (abort with ^G)',
      'GYPEERS=1',
    ].join('\n');
    expect(parseGyPeerCount(noisy)).toBe(1);
  });

  it('returns 0 when the marker is absent, not NaN', () => {
    // An RPC that returned `undefined` (wrong service name — the real trap,
    // since the service is registered under a {Name,Addr,Port} tuple and a
    // bare atom yields `undefined`) prints no marker at all.
    expect(parseGyPeerCount('undefined\n')).toBe(0);
    expect(parseGyPeerCount('')).toBe(0);
  });

  it('returns 0 for a badly-formed marker rather than guessing', () => {
    expect(parseGyPeerCount('GYPEERS=\n')).toBe(0);
    expect(parseGyPeerCount('GYPEERS=abc\n')).toBe(0);
  });

  it('is not fooled by a node-down RPC reply', () => {
    expect(parseGyPeerCount('{badrpc,nodedown}\n')).toBe(0);
  });
});
