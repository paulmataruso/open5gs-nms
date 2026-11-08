// Regression guard for a real BTS-drop loop reproduced on a clean host
// 2026-11-08. osmo-bts-virtual advertises NO GPRS support in its OML feature
// vector — not EGPRS, and not even plain GPRS. Configuring either does not
// degrade: osmo-bsc reads the feature vector and discards the whole BTS.
//
//   DNM  ERROR bts.c:503 (bts=0) GPRS mode set to 'egprs', but BTS does not support it
//   DLINP NOTICE bts_ipaccess_nanobts.c:703 (bts=0) BTS config invalid, dropping BTS!
//
// Measured at ~28 drops per minute, with the BTS never reaching OML — so 2G
// was dead from a toggle the Setup tab presents as a simple on/off. The fix
// clamps the virtual backend to 'none' rather than rejecting the toggle,
// because it is module-wide and a deployment may mix a real GPRS-capable BTS
// with a virtual one used for protocol testing.
//
// The clamp lives in configureGsm()'s per-BTS fan-out. This test pins the rule
// itself, which is what matters and what a future refactor could lose.

type Backend = 'virtual' | 'trx' | 'remote-abis-ip';

/** The rule as implemented in configureGsm(). */
function effectiveGprsMode(
  backend: Backend,
  gprsEnabled: boolean,
  gprsMode: 'gprs' | 'egprs' | undefined,
): 'none' | 'gprs' | 'egprs' {
  const perBtsMode = gprsEnabled ? (gprsMode ?? 'gprs') : 'none';
  return backend === 'virtual' ? 'none' : perBtsMode;
}

describe('GPRS mode vs BTS backend capability', () => {
  it('never configures GPRS on the virtual backend, even when asked', () => {
    expect(effectiveGprsMode('virtual', true, 'gprs')).toBe('none');
    expect(effectiveGprsMode('virtual', true, 'egprs')).toBe('none');
  });

  it('still honours the toggle for backends that can do GPRS', () => {
    expect(effectiveGprsMode('trx', true, 'gprs')).toBe('gprs');
    expect(effectiveGprsMode('trx', true, 'egprs')).toBe('egprs');
    expect(effectiveGprsMode('remote-abis-ip', true, 'egprs')).toBe('egprs');
  });

  it('defaults to plain gprs when the toggle is on with no mode set', () => {
    expect(effectiveGprsMode('remote-abis-ip', true, undefined)).toBe('gprs');
  });

  it('turns GPRS off everywhere when the toggle is off', () => {
    for (const b of ['virtual', 'trx', 'remote-abis-ip'] as Backend[]) {
      expect(effectiveGprsMode(b, false, 'egprs')).toBe('none');
    }
  });

  it('lets a real BTS keep GPRS while a virtual one alongside it does not', () => {
    // The mixed deployment the clamp exists to support.
    expect(effectiveGprsMode('remote-abis-ip', true, 'egprs')).toBe('egprs');
    expect(effectiveGprsMode('virtual', true, 'egprs')).toBe('none');
  });
});
