import { validCommunity, validNetwork } from '../interfaces/rest/snmp-controller';

describe('SNMP configuration validation', () => {
  test.each(['monitorOnly', 'prtg_site-01', 'NMS.read_only'])('accepts safe community %s', value => {
    expect(validCommunity(value)).toBe(true);
  });

  test.each(['public', 'contains space', 'bad!character', ''])('rejects unsafe community %s', value => {
    expect(validCommunity(value)).toBe(false);
  });

  test.each(['127.0.0.1/32', '10.0.0.0/8', '0.0.0.0/0', '2001:db8::/64'])('accepts valid CIDR %s', value => {
    expect(validNetwork(value)).toBe(true);
  });

  test.each(['999.1.1.1/24', '10.0.0.0/33', '10.0.0.1', '2001:db8::/129', 'host/24'])('rejects invalid CIDR %s', value => {
    expect(validNetwork(value)).toBe(false);
  });
});
