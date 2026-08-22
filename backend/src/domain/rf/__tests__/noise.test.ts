import { thermalNoiseDbm } from '../noise';

describe('noise', () => {
  test('T=290K, B=1Hz ≈ -173.98 dBm (the famous "-174 dBm/Hz" reference figure)', () => {
    expect(thermalNoiseDbm({ temperatureK: 290, bandwidthHz: 1 })).toBeCloseTo(-173.98, 1);
  });

  test('T=290K, B=20MHz ≈ -100.96 dBm (well-known LTE 20MHz noise floor reference figure)', () => {
    expect(thermalNoiseDbm({ temperatureK: 290, bandwidthHz: 20_000_000 })).toBeCloseTo(-100.96, 1);
  });

  test('noise figure adds directly in dB', () => {
    const base = thermalNoiseDbm({ temperatureK: 290, bandwidthHz: 20_000_000 });
    const withNf = thermalNoiseDbm({ temperatureK: 290, bandwidthHz: 20_000_000, noiseFigureDb: 5 });
    expect(withNf - base).toBeCloseTo(5, 6);
  });
});
