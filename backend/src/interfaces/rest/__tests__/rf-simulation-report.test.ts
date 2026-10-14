import { winAnsi, isPng } from '../rf-simulation-report';

describe('winAnsi', () => {
  it('transliterates the symbols an RF tool emits that WinAnsi cannot encode', () => {
    // The real bug: a legend label "≥ -80 dBm" rendered as '"e -80 dBm'.
    expect(winAnsi('≥ -80 dBm')).toBe('>= -80 dBm');
    expect(winAnsi('≤ 0 dB')).toBe('<= 0 dB');
    expect(winAnsi('± 4.4 dB')).toBe('+/- 4.4 dB');
    expect(winAnsi('shadow σ')).toBe('shadow sigma');
    expect(winAnsi('A → B')).toBe('A -> B');
  });

  it('leaves characters WinAnsi DOES encode untouched', () => {
    // These all have WinAnsi slots and rendered correctly in the live PDF,
    // which is precisely why the missing ones were easy to overlook.
    for (const sample of ['25 m · 400 m', 'a — b', 'en – dash', '65°', '“quoted”', 'bullet •']) {
      expect(winAnsi(sample)).toBe(sample);
    }
  });

  it('replaces an unmappable codepoint with a space rather than a wrong glyph', () => {
    const out = winAnsi('tower 中文 site');
    expect(out).not.toMatch(/[Ā-￿]/);
    // Words stay separated rather than running together.
    expect(out).toBe('tower    site');
  });

  it('passes plain ASCII through unchanged', () => {
    expect(winAnsi('Site 1 A, 3.6 GHz / 20 MHz')).toBe('Site 1 A, 3.6 GHz / 20 MHz');
  });
});

describe('isPng', () => {
  it('accepts a real PNG signature', () => {
    expect(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toBe(true);
  });

  it('rejects anything else, including a JPEG and a truncated header', () => {
    expect(isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isPng(Buffer.from([0x89, 0x50, 0x4e]))).toBe(false);
    expect(isPng(Buffer.from('<svg onload=alert(1)>'))).toBe(false);
    expect(isPng(Buffer.alloc(0))).toBe(false);
  });
});
