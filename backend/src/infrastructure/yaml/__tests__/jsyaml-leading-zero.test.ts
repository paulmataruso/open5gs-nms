import * as yaml from 'js-yaml';

/**
 * What js-yaml actually does to a bare leading-zero scalar, pinned because six
 * comments in this codebase asserted the wrong mechanism.
 *
 * Those comments said js-yaml's default (YAML 1.1) schema reads `070` as OCTAL,
 * giving 56. Measured against the installed js-yaml 4.3.1 on 2026-11-26, that is
 * false: `070` parses as the decimal integer 70, and octal needs the explicit
 * `0o` prefix. js-yaml 4 defaults to the YAML 1.2 core schema, which dropped
 * YAML 1.1's bare-octal form.
 *
 * The BUG those comments were describing is real and unchanged -- a bare
 * `mcc: 001` loses its leading zeros and comes back as the number 1, which is
 * why loadRaw() recovers mcc/mnc/sd from the raw text. Only the mechanism and
 * the "= 56" example were wrong. This test exists so the corrected comments are
 * backed by something that runs, instead of a fresh assertion nobody checks.
 */
describe('js-yaml leading-zero scalars', () => {
  it('parses a bare leading-zero integer as DECIMAL, not octal', () => {
    expect(yaml.load('v: 070')).toEqual({ v: 70 });
    expect(yaml.load('v: 010')).toEqual({ v: 10 });
  });

  it('needs an explicit 0o prefix for octal', () => {
    expect(yaml.load('v: 0o70')).toEqual({ v: 56 });
  });

  it('still loses the leading zeros, which is the real problem', () => {
    // This is what makes a raw-text pass necessary for mcc/mnc/sd: the digits
    // are gone from the parsed value, so no amount of padding can recover the
    // original WIDTH of a value like a 3-digit MNC.
    expect(yaml.load('mcc: 001\nmnc: 01')).toEqual({ mcc: 1, mnc: 1 });
  });

  it('cannot be recovered by padding, for a 3-digit MNC', () => {
    // The trap this pins: `mnc: 070` parses to 70, and padding to the 2-digit
    // MNC width yields "70" -- a DIFFERENT network from 070. Width is not
    // recoverable from the parsed number, which is why the text is re-read.
    const parsed = yaml.load('mnc: 070') as { mnc: number };
    expect(String(parsed.mnc).padStart(2, '0')).toBe('70');
    expect(String(parsed.mnc).padStart(2, '0')).not.toBe('070');
  });

  it('keeps the string when the file quotes it', () => {
    expect(yaml.load("mcc: '001'")).toEqual({ mcc: '001' });
    expect(yaml.load('mcc: "001"')).toEqual({ mcc: '001' });
  });
});
