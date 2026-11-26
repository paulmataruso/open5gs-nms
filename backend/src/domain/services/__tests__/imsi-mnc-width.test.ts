import {
  imsiPlmnPrefix,
  msinLength,
  legacyPaddedImsiPlmnPrefix,
  deriveEpcDomain,
  deriveImsDomain,
} from '../read-plmn';
import { randomTestImsi } from '../../../interfaces/rest/volte-validation-controller';

/**
 * MNC width is load-bearing: `70` and `070` are DIFFERENT networks, and Open5GS
 * accepts both forms in its config. The two renderings in this codebase follow
 * different 3GPP rules, and conflating them is a bug this project shipped:
 *
 *   - FQDN  (TS 23.003 §19.2): MNC is ALWAYS 3 digits, zero-padded.
 *   - IMSI  (TS 23.003 §2.2):  MNC uses its OWN width, 2 or 3 digits.
 *
 * Three test-IMSI builders used the FQDN rule, which on this deployment
 * (MCC 001 / MNC 01) produced `001001...` -- PLMN 001-001 -- while claiming to
 * stay "within the real PLMN". Every real subscriber here is `00101` + a
 * 10-digit MSIN, confirmed against the live list on 2026-11-26.
 */
describe('MNC width: IMSI vs FQDN', () => {
  describe('imsiPlmnPrefix uses the real MNC width', () => {
    it('keeps a 2-digit MNC two digits', () => {
      expect(imsiPlmnPrefix('001', '01')).toBe('00101');
    });

    it('keeps a 3-digit MNC three digits', () => {
      expect(imsiPlmnPrefix('001', '070')).toBe('001070');
    });

    it('distinguishes MNC 70 from MNC 070, which are different networks', () => {
      expect(imsiPlmnPrefix('001', '70')).toBe('00170');
      expect(imsiPlmnPrefix('001', '070')).toBe('001070');
      expect(imsiPlmnPrefix('001', '70')).not.toBe(imsiPlmnPrefix('001', '070'));
    });

    it('is NOT what the old padded form produced', () => {
      expect(legacyPaddedImsiPlmnPrefix('001', '01')).toBe('001001');
      expect(imsiPlmnPrefix('001', '01')).not.toBe(legacyPaddedImsiPlmnPrefix('001', '01'));
    });
  });

  describe('msinLength completes a 15-digit IMSI', () => {
    it('leaves 10 MSIN digits for a 2-digit MNC', () => {
      expect(msinLength('001', '01')).toBe(10);
    });
    it('leaves 9 MSIN digits for a 3-digit MNC', () => {
      expect(msinLength('001', '070')).toBe(9);
    });
  });

  describe('randomTestImsi', () => {
    it('is 15 digits for a 2-digit MNC, in the real PLMN', () => {
      const imsi = randomTestImsi('001', '01', 1);
      expect(imsi).toHaveLength(15);
      expect(imsi.startsWith('00101')).toBe(true);
      expect(/^\d{15}$/.test(imsi)).toBe(true);
    });

    it('is 15 digits for a 3-digit MNC, in the real PLMN', () => {
      const imsi = randomTestImsi('001', '070', 1);
      expect(imsi).toHaveLength(15);
      expect(imsi.startsWith('001070')).toBe(true);
      expect(/^\d{15}$/.test(imsi)).toBe(true);
    });

    it('keeps the 900 test block right after the PLMN', () => {
      expect(randomTestImsi('001', '01', 1).slice(5, 8)).toBe('900');
      expect(randomTestImsi('001', '070', 1).slice(6, 9)).toBe('900');
    });

    it('no longer lands in a foreign PLMN', () => {
      // The old form began 001001 on this PLMN; the fixed one must not.
      expect(randomTestImsi('001', '01', 1).startsWith('001001')).toBe(false);
    });
  });

  describe('FQDN padding is unchanged, and still correct', () => {
    it('pads a 2-digit MNC to three digits in the domain', () => {
      expect(deriveEpcDomain('001', '01')).toBe('epc.mnc001.mcc001.3gppnetwork.org');
    });

    it('leaves a 3-digit MNC alone in the domain', () => {
      expect(deriveImsDomain('001', '070')).toBe('ims.mnc070.mcc001.3gppnetwork.org');
    });

    it('renders MNC 70 and 070 to the SAME domain, per TS 23.003', () => {
      // Not a bug: the FQDN format cannot distinguish them, which is exactly
      // why the IMSI must not be derived from the padded form.
      expect(deriveEpcDomain('001', '70')).toBe(deriveEpcDomain('001', '070'));
    });
  });
});
