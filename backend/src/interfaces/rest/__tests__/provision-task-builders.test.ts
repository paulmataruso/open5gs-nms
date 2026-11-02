import {
  buildSercommTasks, buildProvisionTasks,
  type SercommProvisionInput,
} from '../genieacs-controller';

// These builders are what actually reconfigures real CBRS radios, so the
// properties worth pinning are the ones whose failure is silent.
//
// The duplicate-parameter check below is not hypothetical: buildSercommTasks()
// shipped writing `Device.FAP.GPS.ScanOnBoot` TWICE in one SetParameterValues,
// '1' from Magma's enodebd map and 'false' from the Location block, with
// opposite meanings. TR-069 does not define which a CPE applies, and some
// reject a duplicate name with a fault — so a provision could leave a radio
// waiting on a GPS scan it can never complete (which blocks LTE cell startup
// on an indoor unit) with nothing in any log to say why.

const SERCOMM: SercommProvisionInput = {
  mcc: '001', mnc: '01', tac: '1',
  mmeIp: '10.0.1.175', mmeCfgIdList: '{1}',
  earfcn: '56200', earfcn2: '', pci: '360',
  cellIdentity: '254360', cellIdentity2: '254361',
  txPower: '12', bandwidth: '20', freqBand: '48',
  syncSource: 'FREE_RUNNING', carrierNumber: '1',
  caEnable: false, contiguousCC: false,
  sasEnable: true, sasMethod: '0', sasManufacturerPrefix: true,
  sasInstallMethod: '0', sasCpiEnable: false,
  sasCategory: 'A', sasChannelType: 'GAA',
  sasLocation: 'indoor', sasLocationSource: '0', sasHeightType: 'AGL',
  sasUserId: '254361', sasIcgGroupId: '', sasPeerCertVerify: false,
  sasGrantMethod: 'FREQ_GRANT_BY_CARRIER',
  latitude: '43353200', longitude: '-72183800',
  enable256QAM: true,
};

const URL = 'http://127.0.0.1:7557/devices/X/tasks?timeout=30000&connection_request';

function setsOf(tasks: ReturnType<typeof buildSercommTasks>) {
  return tasks
    .map(t => t.body as { name: string; parameterValues?: [string, string, string][] })
    .filter(b => b.name === 'setParameterValues');
}

describe('provisioning task builders', () => {
  test('no SetParameterValues writes the same parameter twice', () => {
    const tasks = [
      ...buildSercommTasks(URL, SERCOMM),
      ...buildProvisionTasks('http://127.0.0.1:7557', 'X', {
        mcc: '001', mnc: '01', tac: 1, mmeIp: '10.0.1.175', bandwidthMhz: '20',
        earfcn: 56200, cellId: 1, pci: 360, band: 48, txPower: '12',
      } as any),
    ];
    for (const body of setsOf(tasks)) {
      const seen = new Map<string, string[]>();
      for (const [name, value] of body.parameterValues ?? []) {
        seen.set(name, [...(seen.get(name) ?? []), value]);
      }
      const dupes = [...seen.entries()].filter(([, v]) => v.length > 1);
      expect(dupes).toEqual([]);
    }
  });

  test('ScanOnBoot is written false — a GPS scan must not gate cell startup', () => {
    // Both Sercomms on this deployment run false, including the serving one.
    const writes = setsOf(buildSercommTasks(URL, SERCOMM))
      .flatMap(b => b.parameterValues ?? [])
      .filter(([n]) => n === 'Device.FAP.GPS.ScanOnBoot');
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe('false');
  });

  test('the operator-supplied location reaches GPS.Locked*, which gates the SAS client', () => {
    const pv = setsOf(buildSercommTasks(URL, SERCOMM)).flatMap(b => b.parameterValues ?? []);
    expect(pv).toContainEqual(['Device.FAP.GPS.LockedLatitude', '43353200', 'xsd:int']);
    expect(pv).toContainEqual(['Device.FAP.GPS.LockedLongitude', '-72183800', 'xsd:int']);
    // And the saved-file source stays enabled, which is how a manually written
    // location survives on a radio that never gets a live fix.
    expect(pv).toContainEqual(
      ['Device.FAP.Location.X_000E8F_LocationInfoSourceSavedFile_Enable', '1', 'xsd:boolean'],
    );
  });

  test('bandwidth is MHz and becomes resource blocks, not passed through', () => {
    // 20 MHz is 100 RB. Passing the radio's own DLBandwidth of 100 would ask
    // for 500 RB, which is not a thing.
    const pv = setsOf(buildSercommTasks(URL, SERCOMM)).flatMap(b => b.parameterValues ?? []);
    const dl = pv.find(([n]) => n.endsWith('CellConfig.LTE.RAN.RF.DLBandwidth'));
    expect(dl?.[1]).toBe('100');
  });

  test('AdminState is sent in a LATER task than the invasive set', () => {
    // The first task triggers the radio's own reboot; asking it to go in
    // service in that same batch is asking before it can comply.
    const tasks = buildSercommTasks(URL, SERCOMM);
    const taskOf = (needle: string) => tasks.findIndex(
      t => ((t.body as any).parameterValues ?? []).some(([n]: [string]) => n.endsWith(needle)),
    );
    const admin = taskOf('FAPControl.LTE.AdminState');
    const loc = taskOf('Device.FAP.GPS.LockedLatitude');
    expect(admin).toBeGreaterThan(-1);
    expect(loc).toBeGreaterThan(-1);
    expect(admin).toBeGreaterThan(loc);
  });

  test('every task posts to the server-built URL, never a caller-supplied one', () => {
    for (const t of buildSercommTasks(URL, SERCOMM)) expect(t.url).toBe(URL);
  });
});
