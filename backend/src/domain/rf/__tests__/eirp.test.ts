import { calculateEirpDbm } from '../eirp';

describe('eirp', () => {
  test('worked example: 40 − 2 − 0.5 + 17 = 54.5', () => {
    const eirp = calculateEirpDbm({ txPowerDbm: 40, cableLossDb: 2, connectorLossDb: 0.5, filterLossDb: 0, antennaGainDbi: 17 });
    expect(eirp).toBeCloseTo(54.5, 6);
  });
});
