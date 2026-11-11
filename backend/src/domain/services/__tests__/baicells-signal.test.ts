import { parseBaicellsUes, signalNumber } from '../baicells-signal';

const row = (imsi: string, sinr = '18.5') =>
  imsi + ':vmac:10.5:1.25:172.20.1.5:1234:' + sinr + ':12:10:15:20:18:23:0.5:1:2:3:4:110';

describe('Baicells native UE measurements', () => {
  it('maps the firmware fields and keeps cell-local UE IDs distinct', () => {
    const text = 'FAP.0.FAP_LTE.0: LTE_UE_SPEED_STATISTICS:="7[' + row('001010000000001') + '];"\n'
      + 'FAP.0.FAP_LTE.1: LTE_UE_SPEED_STATISTICS:="7[' + row('001010000000002') + '];"';
    const ues = parseBaicellsUes(text, 123);
    expect(ues.map(ue => ue.ueId)).toEqual(['0/7','1/7']);
    expect(ues[0]).toMatchObject({imsi:'001010000000001',sinr:18.5,dlMbps:10.5,ulMbps:1.25,primaryDlCqi:12,secondaryDlCqi:10,ulMcs:15,dlMcs:20,txPower:23,bler:0.5,pathLoss:110,sampledAt:123});
    expect(ues[0].details).toMatchObject({cellIndex:0,radioUeId:'7',secondaryDlMcs:'18',primaryDlBlerTb1:'1',secondaryDlBlerTb2:'4'});
    expect(ues[0].rssi).toBeUndefined();
    expect(ues[0].rsrp).toBeUndefined();
    expect(ues[0].snr).toBeUndefined();
  });
  it('accepts a valid empty radio result and rejects a login/error page', () => {
    expect(parseBaicellsUes('FAP.0.FAP_LTE.0: LTE_UE_SPEED_STATISTICS:="NULL"')).toEqual([]);
    expect(() => parseBaicellsUes('<html>Session expired</html>')).toThrow('unrecognized UE response');
  });
  it('does not invent IMSIs or turn missing metrics into zero', () => {
    const ues = parseBaicellsUes('FAP.0.FAP_LTE.0: LTE_UE_SPEED_STATISTICS:="9[' + row('NULL','') + '];"');
    expect(ues[0].imsi).toBeUndefined();
    expect(ues[0].sinr).toBeUndefined();
    expect(signalNumber('')).toBeUndefined();
    expect(signalNumber(null)).toBeUndefined();
    expect(signalNumber('NULL')).toBeUndefined();
    expect(signalNumber('12 14')).toBeUndefined();
    expect(signalNumber('0')).toBe(0);
    expect(signalNumber('-105.2')).toBe(-105.2);
  });
});
