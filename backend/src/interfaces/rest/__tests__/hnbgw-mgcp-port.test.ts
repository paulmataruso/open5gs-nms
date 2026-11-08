import { osmoHnbgwCfgForTest, HNBGW_STATE_DEFAULTS_FOR_TEST } from '../hnbgw-controller';

// Regression guard for a real collision found on a clean host 2026-11-08:
// osmo-hnbgw's compiled-in MGCP CLIENT local port is 2728, which is the exact
// port the 2G module configures for osme-bsc (`mgw local-port 2728`). Whichever
// daemon started first won the socket; the other died with
//   unable to bind socket: 127.0.0.1:2728: Address already in use
//   MGW (single) connect failed at (127.0.0.1:2427)
// so installing the 3G module took the 2G BSC — all of 2G — down, with a
// message naming neither module.
//
// Especially easy to miss because the MGCP client CONNECTs its UDP socket, so
// it shows as ESTAB and `ss -lnup` (listening only) does not list it at all.
describe('osmo-hnbgw MGCP client local port', () => {
  it('is explicit, not left to the 2728 compiled-in default', () => {
    const cfg = osmoHnbgwCfgForTest(HNBGW_STATE_DEFAULTS_FOR_TEST());
    expect(cfg).toMatch(/^\s*mgw local-port \d+$/m);
  });

  it('does not collide with osmo-bsc (2728) or osmo-msc (2727)', () => {
    const cfg = osmoHnbgwCfgForTest(HNBGW_STATE_DEFAULTS_FOR_TEST());
    const port = Number(/mgw local-port (\d+)/.exec(cfg)?.[1]);
    expect(port).not.toBe(2728);  // osmo-bsc
    expect(port).not.toBe(2727);  // osmo-msc
    expect(port).toBe(2729);
  });

  it('pins a local-ip too, so the bind address is never null', () => {
    // Without local-ip the failure reads `unable to bind socket: (null):2728`,
    // which hides which address was actually being contended.
    const cfg = osmoHnbgwCfgForTest(HNBGW_STATE_DEFAULTS_FOR_TEST());
    expect(cfg).toMatch(/^\s*mgw local-ip \d+\.\d+\.\d+\.\d+$/m);
  });

  it('honours an operator override', () => {
    const cfg = osmoHnbgwCfgForTest({ ...HNBGW_STATE_DEFAULTS_FOR_TEST(), mgcpLocalPort: 2799 });
    expect(cfg).toContain('mgw local-port 2799');
  });

  it('never emits an undefined port from a state file predating the field', () => {
    // A persisted state object written before mgcpLocalPort existed must not
    // produce `mgw local-port undefined`, which osmo-hnbgw rejects outright.
    const legacy = { ...HNBGW_STATE_DEFAULTS_FOR_TEST() } as Record<string, unknown>;
    delete legacy.mgcpLocalPort;
    const cfg = osmoHnbgwCfgForTest(legacy as never);
    expect(cfg).not.toContain('undefined');
  });

  it('keeps the mgcp directives inside the mgcp node', () => {
    const cfg = osmoHnbgwCfgForTest(HNBGW_STATE_DEFAULTS_FOR_TEST());
    const mgcpIdx = cfg.indexOf('\n mgcp\n');
    expect(mgcpIdx).toBeGreaterThan(-1);
    expect(cfg.slice(mgcpIdx)).toContain('mgw local-port');
  });
});
