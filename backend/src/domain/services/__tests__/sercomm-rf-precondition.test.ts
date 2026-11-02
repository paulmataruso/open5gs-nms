import {
  assessSercommRfPrecondition, SERCOMM_RF_PRECONDITION_PARAMS,
} from '../sercomm-rf-precondition';

// The two fixtures are the REAL cached parameter values of this deployment's
// two Sercomm femtos, read 2026-11-01T18:46 — one that could not bring its
// cell up and one that was serving at that same moment. They differed in
// exactly one respect that matters, which is what the assessment has to catch.

function device(leaves: Record<string, string>): Record<string, any> {
  const d: Record<string, any> = {};
  for (const [dotPath, value] of Object.entries(leaves)) {
    const parts = dotPath.split('.');
    let node = d;
    for (const p of parts.slice(0, -1)) node = (node[p] ??= {});
    node[parts[parts.length - 1]] = { _value: value, _timestamp: '2026-11-01T18:46:19.497Z' };
  }
  return d;
}

const FAP = 'Device.Services.FAPService.1.';
const NE = 'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.';

// 2112CW5000195 — GPS lock 0/0, SAS enabled, no SAS client status, cell IDLE.
const BROKEN = device({
  [`${FAP}FAPControl.LTE.AdminState`]: 'False',
  [`${FAP}FAPControl.LTE.X_000E8F_SAS.Enable`]: 'True',
  [`${NE}X_000E8F_SAS_Status`]: '',
  [`${NE}X_000E8F_eNB_Status`]: 'IDLE',
  'Device.FAP.GPS.LockedLatitude': '0',
  'Device.FAP.GPS.LockedLongitude': '0',
});

// 2206CW5000768 — same model family, same SAS, serving.
const WORKING = device({
  [`${FAP}FAPControl.LTE.AdminState`]: 'True',
  [`${FAP}FAPControl.LTE.X_000E8F_SAS.Enable`]: 'True',
  [`${NE}X_000E8F_SAS_Status`]: 'SUCCESS',
  [`${NE}X_000E8F_eNB_Status`]: 'SUCCESS',
  'Device.FAP.GPS.LockedLatitude': '43353200',
  'Device.FAP.GPS.LockedLongitude': '-72183800',
});

describe('assessSercommRfPrecondition', () => {
  test('the radio that could not come up is reported as blocked, GPS first', () => {
    const p = assessSercommRfPrecondition(BROKEN);
    expect(p.blocked).toBe(true);
    expect(p.gpsLocked).toBe(false);
    expect(p.sasEnabled).toBe(true);
    expect(p.sasStatus).toBe('');
    expect(p.enbStatus).toBe('IDLE');
    expect(p.adminState).toBe(false);
    // The GPS gate is upstream of the grant, so it has to lead — telling an
    // operator "no grant" sends them to the SAS for a radio that never spoke
    // to it.
    expect(p.reasons[0]).toMatch(/GPS lock reads 0/);
    expect(p.reasons.join(' ')).toMatch(/not reporting any SAS client status/);
  });

  test('the radio that was serving at the same moment is not blocked', () => {
    expect(assessSercommRfPrecondition(WORKING)).toMatchObject({
      blocked: false, reasons: [], gpsLocked: true, sasStatus: 'SUCCESS', adminState: true,
    });
  });

  test('SAS disabled means there is no grant to wait for, so nothing is blocked', () => {
    // A radio running on a fixed EARFCN outside SAS mode must not be told it
    // needs a grant.
    const p = assessSercommRfPrecondition(device({
      [`${FAP}FAPControl.LTE.X_000E8F_SAS.Enable`]: 'False',
      [`${NE}X_000E8F_SAS_Status`]: '',
      'Device.FAP.GPS.LockedLatitude': '0',
      'Device.FAP.GPS.LockedLongitude': '0',
    }));
    expect(p).toMatchObject({ blocked: false, reasons: [], sasEnabled: false });
  });

  test('a SAS client reporting something other than SUCCESS is quoted back', () => {
    const p = assessSercommRfPrecondition(device({
      [`${FAP}FAPControl.LTE.X_000E8F_SAS.Enable`]: 'True',
      [`${NE}X_000E8F_SAS_Status`]: 'GRANT_TERMINATED',
      'Device.FAP.GPS.LockedLatitude': '43353200',
      'Device.FAP.GPS.LockedLongitude': '-72183800',
    }));
    expect(p.blocked).toBe(true);
    expect(p.reasons).toHaveLength(1);
    expect(p.reasons[0]).toMatch(/"GRANT_TERMINATED" rather than SUCCESS/);
    // Not a GPS problem, so it must not say it is one.
    expect(p.reasons.join(' ')).not.toMatch(/GPS/);
  });

  test('either coordinate at zero is not a lock', () => {
    for (const [lat, lon] of [['0', '-72183800'], ['43353200', '0'], ['0', '0']]) {
      const p = assessSercommRfPrecondition(device({
        [`${FAP}FAPControl.LTE.X_000E8F_SAS.Enable`]: 'True',
        [`${NE}X_000E8F_SAS_Status`]: 'SUCCESS',
        'Device.FAP.GPS.LockedLatitude': lat,
        'Device.FAP.GPS.LockedLongitude': lon,
      }));
      expect(p.gpsLocked).toBe(false);
      expect(p.blocked).toBe(true);
    }
  });

  test('a negative longitude is a perfectly good lock', () => {
    // Guards against a truthiness or sign slip putting the western hemisphere
    // permanently out of service.
    expect(assessSercommRfPrecondition(WORKING).gpsLocked).toBe(true);
  });

  test('absent or unreadable parameters never read as a satisfied precondition', () => {
    const empty = assessSercommRfPrecondition({});
    expect(empty).toMatchObject({ sasEnabled: false, gpsLocked: false, adminState: null, sasStatus: '', enbStatus: '' });
    // SAS state unknown, so no grant claim is made either way.
    expect(empty.blocked).toBe(false);

    const noGps = assessSercommRfPrecondition(device({
      [`${FAP}FAPControl.LTE.X_000E8F_SAS.Enable`]: 'True',
      [`${NE}X_000E8F_SAS_Status`]: 'SUCCESS',
    }));
    expect(noGps.gpsLocked).toBe(false);
    expect(noGps.blocked).toBe(true);
  });

  test('AdminState is reported as a tri-state, so "unknown" is not "off"', () => {
    expect(assessSercommRfPrecondition(device({})).adminState).toBeNull();
    expect(assessSercommRfPrecondition(device({ [`${FAP}FAPControl.LTE.AdminState`]: '1' })).adminState).toBe(true);
    expect(assessSercommRfPrecondition(device({ [`${FAP}FAPControl.LTE.AdminState`]: '0' })).adminState).toBe(false);
  });

  test('every parameter the assessment reads is in the refresh list', () => {
    // A parameter read but not refreshed is assessed from a stale cache — the
    // same class of bug as the IP staleness this module was written alongside.
    for (const p of [
      `${FAP}FAPControl.LTE.AdminState`,
      `${FAP}FAPControl.LTE.X_000E8F_SAS.Enable`,
      `${NE}X_000E8F_SAS_Status`,
      `${NE}X_000E8F_eNB_Status`,
      'Device.FAP.GPS.LockedLatitude',
      'Device.FAP.GPS.LockedLongitude',
    ]) {
      expect(SERCOMM_RF_PRECONDITION_PARAMS).toContain(p);
    }
  });
});
