import { readSmfDiameterRealmFromText } from '../ocs-controller';

// Regression guard for a real clean-host failure, 2026-11-08: enabling the OCS
// module broke ALL 4G data.
//
// Open5GS SMF addresses the Gy CCR to its OWN freeDiameter realm:
//   AVP: 'Destination-Realm'(283) l=8 f=-M val="localdomain"
// OCS derived its Origin-Realm from the PLMN instead
// (epc.mnc001.mcc001.3gppnetwork.org), so freeDiameter had no peer in the
// realm the request was addressed to:
//   smf: ERROR DIAMETER Result Code(3002)        <- UNABLE_TO_DELIVER
//   smf: Unexpected Diameter Result Code 3002/-1, defaulting to severe network failure
// and since SMF treats a failed Gy CCA-Initial as FATAL to the Create Session
// Response, every 4G PDN session was torn down ~100ms after the bearer was
// created — the UE attached and instantly lost its session, with nothing in
// the MME log mentioning charging.
//
// It only ever worked on the reference host because the DNS/FQDN Migration
// Wizard had rewritten smf.conf's Realm to the PLMN realm there. Realigning
// moved the result code 3002 -> 5030 (USER_UNKNOWN), i.e. the CCR reached OCS.
describe('readSmfDiameterRealmFromText', () => {
  it('reads the stock Open5GS realm', () => {
    const conf = [
      '# freeDiameter configuration',
      'Identity = "smf.localdomain";',
      'Realm = "localdomain";',
      'ListenOn = "127.0.0.4";',
    ].join('\n');
    expect(readSmfDiameterRealmFromText(conf)).toBe('localdomain');
  });

  it('reads a PLMN realm after the DNS/FQDN migration has run', () => {
    const conf = [
      'Identity = "smf.epc.mnc001.mcc001.3gppnetwork.org";',
      'Realm = "epc.mnc001.mcc001.3gppnetwork.org";',
    ].join('\n');
    expect(readSmfDiameterRealmFromText(conf))
      .toBe('epc.mnc001.mcc001.3gppnetwork.org');
  });

  it('ignores a commented-out Realm line', () => {
    const conf = '#Realm = "example.net";\nRealm = "localdomain";';
    expect(readSmfDiameterRealmFromText(conf)).toBe('localdomain');
  });

  it('tolerates leading whitespace and odd spacing', () => {
    expect(readSmfDiameterRealmFromText('   Realm   =   "localdomain";')).toBe('localdomain');
  });

  it('returns null when there is no Realm directive, so the caller can fall back', () => {
    expect(readSmfDiameterRealmFromText('Identity = "smf.localdomain";')).toBeNull();
  });

  it('returns null for an empty value rather than an empty realm', () => {
    // An empty Origin-Realm would be worse than the PLMN guess.
    expect(readSmfDiameterRealmFromText('Realm = "";')).toBeNull();
    expect(readSmfDiameterRealmFromText('Realm = "   ";')).toBeNull();
  });

  it('takes the first Realm directive, matching freeDiameter own parse order', () => {
    expect(readSmfDiameterRealmFromText('Realm = "first";\nRealm = "second";')).toBe('first');
  });
});
