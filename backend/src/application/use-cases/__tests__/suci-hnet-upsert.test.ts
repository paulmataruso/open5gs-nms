import { upsertUdmHnetBlock } from '../suci-management';

// Guards CLAUDE.md architectural pattern #2 for udm.yaml. saveHnet() used to
// yaml.dump() the whole parsed document back over the file, which discards
// every comment and rewrites quoting/key order on one of the 17 core NFs.
// These assert on real file TEXT, because that is the only way to verify the
// thing that regressed.

const LIVE = `logger:
  level: debug
  file:
    path: /var/log/open5gs/udm.log
global:
  max:
    ue: 1024
udm:
  hnet:
    - id: 1
      scheme: 1
      key: /etc/open5gs/hnet/curve25519-1.key
    - id: 2
      scheme: 2
      key: /etc/open5gs/hnet/secp256r1-2.key
  sbi:
    server:
      - address: 127.0.0.12
        port: 7777
        advertise: udm.5gc.mnc001.mcc001.3gppnetwork.org:7777
    client:
      scp:
        - uri: http://scp.5gc.mnc001.mcc001.3gppnetwork.org:7777
`;

describe('upsertUdmHnetBlock', () => {
  it('replaces only the hnet block and leaves every other line byte-identical', () => {
    const out = upsertUdmHnetBlock(LIVE, [
      { id: 1, scheme: 1, key: '/etc/open5gs/hnet/curve25519-1.key' },
      { id: 3, scheme: 2, key: '/etc/open5gs/hnet/secp256r1-3.key' },
    ]);

    // Everything outside udm.hnet survives untouched.
    expect(out).toContain('  level: debug');
    expect(out).toContain('    ue: 1024');
    expect(out).toContain('        advertise: udm.5gc.mnc001.mcc001.3gppnetwork.org:7777');
    expect(out).toContain('        - uri: http://scp.5gc.mnc001.mcc001.3gppnetwork.org:7777');

    expect(out).toContain('      key: /etc/open5gs/hnet/secp256r1-3.key');
    expect(out).not.toContain('secp256r1-2.key');

    // The sbi block must not have moved, duplicated, or been reindented.
    expect(out.match(/^  sbi:$/gm)).toHaveLength(1);
    expect(out.split('\n').filter(l => l === '  sbi:')).toHaveLength(1);
  });

  it('preserves comments, which a yaml.dump round-trip destroys', () => {
    const commented = `# Managed by the operator — do not reformat.
logger:
  level: info   # trailing comment
udm:
  # Home network public keys for SUCI de-concealment.
  hnet:
    - id: 1
      scheme: 1
      key: /etc/open5gs/hnet/curve25519-1.key
  sbi:
    server:
      - address: 127.0.0.12
`;
    const out = upsertUdmHnetBlock(commented, [
      { id: 7, scheme: 1, key: '/etc/open5gs/hnet/curve25519-7.key' },
    ]);
    expect(out).toContain('# Managed by the operator — do not reformat.');
    expect(out).toContain('  level: info   # trailing comment');
    expect(out).toContain('  # Home network public keys for SUCI de-concealment.');
    expect(out).toContain('      key: /etc/open5gs/hnet/curve25519-7.key');
    expect(out).not.toContain('curve25519-1.key');
  });

  it('emits an explicit empty list rather than a bare key that parses as null', () => {
    const out = upsertUdmHnetBlock(LIVE, []);
    expect(out).toContain('  hnet: []');
    expect(out).not.toContain('curve25519-1.key');
    expect(out).toContain('  sbi:');
  });

  it('inserts hnet as udm\'s first child when the block is absent', () => {
    const noHnet = `udm:
  sbi:
    server:
      - address: 127.0.0.12
`;
    const out = upsertUdmHnetBlock(noHnet, [
      { id: 1, scheme: 1, key: '/k' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('udm:');
    expect(lines[1]).toBe('  hnet:');
    expect(out).toContain('  sbi:');
  });

  it('appends a udm section when the file has none', () => {
    const out = upsertUdmHnetBlock('logger:\n  level: info\n', [
      { id: 1, scheme: 1, key: '/k' },
    ]);
    expect(out).toContain('logger:');
    expect(out).toContain('udm:');
    expect(out).toContain('  hnet:');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('round-trips to the same parsed hnet a yaml load would produce', () => {
    // The text-level edit must still be valid YAML meaning the same thing.
    const yaml = require('js-yaml');
    const entries = [
      { id: 1, scheme: 1, key: '/etc/open5gs/hnet/curve25519-1.key' },
      { id: 4, scheme: 2, key: '/etc/open5gs/hnet/secp256r1-4.key' },
    ];
    const out = upsertUdmHnetBlock(LIVE, entries);
    const parsed = yaml.load(out) as any;
    expect(parsed.udm.hnet).toEqual(entries);
    // And the rest of the document is still intact and correct.
    expect(parsed.udm.sbi.server[0].advertise).toBe('udm.5gc.mnc001.mcc001.3gppnetwork.org:7777');
    expect(parsed.global.max.ue).toBe(1024);
  });
});
