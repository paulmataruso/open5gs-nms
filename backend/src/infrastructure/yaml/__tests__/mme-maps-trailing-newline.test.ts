import { convertMapsArrayToRepeatedMapKeys } from '../yaml-config-repository';

/**
 * Every mme.yaml save stripped the file's trailing newline.
 *
 * Found by a same-PLMN PLMN-migration test on the live host (2026-11-26):
 * Phase A rewrote mme/amf/smf/nrf and 17 of 18 configs came back
 * byte-identical, with mme.yaml differing by exactly one missing newline.
 * amf.yaml and nrf.yaml kept theirs, which is what pointed at this function --
 * it is the one step gated on `service === 'mme'`.
 *
 * Mechanism: the map-sequence loops skip a blank line without re-emitting it,
 * and split('\n') on a newline-terminated file ends in an empty element. When
 * the `maps:` block is the last thing in the document -- which it is in
 * mme.yaml, whose sgsap map sits at the end -- that element is consumed as a
 * blank line.
 *
 * Cosmetic (Open5GS parses it either way) but it made the save a non-identity
 * round-trip, so a file was never byte-stable across the first write.
 */
const withMapsAtEnd = `mme:
  sgsap:
    client:
      - sgsap:
        maps:
          - tai:
              plmn_id:
                mcc: 001
                mnc: 01
              tac: 1
            lai:
              plmn_id:
                mcc: 001
                mnc: 01
              lac: 1
`;

describe('mme maps conversion preserves the trailing newline', () => {
  it('keeps it when the maps: block ends the file', () => {
    const out = convertMapsArrayToRepeatedMapKeys(withMapsAtEnd);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('still converts the sequence to repeated map: keys', () => {
    const out = convertMapsArrayToRepeatedMapKeys(withMapsAtEnd);
    expect(out).toMatch(/^\s+map:$/m);
    expect(out).not.toMatch(/maps:/);
  });

  it('does not ADD a newline to input that had none', () => {
    const noTrailing = withMapsAtEnd.replace(/\n$/, '');
    expect(convertMapsArrayToRepeatedMapKeys(noTrailing).endsWith('\n')).toBe(false);
  });

  it('is idempotent on its own output, newline included', () => {
    const once = convertMapsArrayToRepeatedMapKeys(withMapsAtEnd);
    expect(convertMapsArrayToRepeatedMapKeys(once)).toBe(once);
  });

  it('leaves a document with no maps: block byte-identical', () => {
    const plain = 'mme:\n  gummei:\n    - plmn_id:\n        mcc: 001\n        mnc: 01\n';
    expect(convertMapsArrayToRepeatedMapKeys(plain)).toBe(plain);
  });
});
