import { withGsm2gEchoTest, dropLocallyOwnedCodes, CrossRanCode } from '../pstn-controller';

// ── Cross-RAN echo test routing ──────────────────────────────────────────────
//
// Real bug, confirmed live 2026-10-19: dialling Asterisk-2G's echo test (600)
// from a 4G/5G handset returned `603 Decline`, on three attempts from two
// different handsets. 2G SHORT CODES were forwarded to asterisk2g_trunk but
// the 2G ECHO TEST was not, so 600 had no exact match in `pstn-internal` and
// fell through to the outbound `_X.` catch-all -- which dialled it at the real
// external provider, which declined a number that is not a phone number.
//
// The number was already known to this side; it was used only to guard
// collisions, never to route. These tests pin the routing specifically.

const CODES: CrossRanCode[] = [
  { extension: '6060' },
  { extension: '7070' },
];

describe('withGsm2gEchoTest', () => {
  it("forwards Asterisk-2G's echo test alongside its short codes", () => {
    const out = withGsm2gEchoTest(CODES, '600', '500');
    expect(out.map(c => c.extension)).toEqual(['6060', '7070', '600']);
    expect(out.find(c => c.extension === '600')?.label).toBe('2G echo test');
  });

  it('is what stops the echo test reaching the external trunk', () => {
    // Regression guard stated in the terms of the actual failure: if 600 is
    // absent from this list it has no exact match, and the catch-all dials it
    // at the real provider.
    expect(withGsm2gEchoTest(CODES, '600', '500').some(c => c.extension === '600')).toBe(true);
    expect(CODES.some(c => c.extension === '600')).toBe(false);
  });

  it("never shadows this side's own echo test", () => {
    // Both configured to 500: emitting a forward would duplicate the local
    // echo-test extension and make one of the two silently unreachable.
    const out = withGsm2gEchoTest(CODES, '500', '500');
    expect(out.map(c => c.extension)).toEqual(['6060', '7070']);
  });

  it('does not duplicate a 2G short code that is already forwarded', () => {
    const out = withGsm2gEchoTest([{ extension: '600' }], '600', '500');
    expect(out.map(c => c.extension)).toEqual(['600']);
  });

  it('tolerates an unset or blank 2G echo number', () => {
    expect(withGsm2gEchoTest(CODES, '', '500')).toEqual(CODES);
    expect(withGsm2gEchoTest(CODES, '   ', '500')).toEqual(CODES);
  });

  it('does not mutate the input list', () => {
    const input: CrossRanCode[] = [{ extension: '6060' }];
    withGsm2gEchoTest(input, '600', '500');
    expect(input).toEqual([{ extension: '6060' }]);
  });
});

describe('dropLocallyOwnedCodes', () => {
  it('lets a local extension win over a forwarded peer code', () => {
    const out = dropLocallyOwnedCodes(
      [{ extension: '6060' }, { extension: '600' }],
      ['500', '1010', '600'],
    );
    expect(out.map(c => c.extension)).toEqual(['6060']);
  });

  it('keeps everything when nothing collides', () => {
    const out = dropLocallyOwnedCodes(CODES, ['500', '1010', '2020']);
    expect(out).toEqual(CODES);
  });

  it("drops a peer code colliding with this side's echo test", () => {
    expect(dropLocallyOwnedCodes([{ extension: '500' }], ['500'])).toEqual([]);
  });
});
