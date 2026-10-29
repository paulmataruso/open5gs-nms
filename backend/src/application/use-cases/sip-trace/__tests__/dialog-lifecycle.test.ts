import { dialogLifecycle, DialogEvent } from '../sip-trace-store';

// ── Call duration semantics ──────────────────────────────────────────────────
//
// Fixtures are shaped from a REAL captured call (15550000001 -> 6034771783,
// 2026-10-19 20:12:31Z): 19 messages, INVITE -> 100 -> 183 -> 200 -> ACK, with
// the conversation then producing no SIP at all for minutes. That silence is
// the whole reason these rules exist -- the last captured message of a live
// call is its ACK, so last-minus-first is the SETUP time and reported a real
// 3-minute call as 5 seconds.

const T = (iso: string) => new Date(iso);

/** The real sequence, up to the point the call was still in progress. */
const LIVE_CALL: DialogEvent[] = [
  { t: T('2026-10-19T20:12:31.472Z'), m: 'INVITE', c: 'INVITE' },
  { t: T('2026-10-19T20:12:31.473Z'), s: 100, c: 'INVITE' },
  { t: T('2026-10-19T20:12:34.679Z'), s: 183, c: 'INVITE' },
  { t: T('2026-10-19T20:12:36.574Z'), s: 200, c: 'INVITE' },
  { t: T('2026-10-19T20:12:36.631Z'), m: 'ACK', c: 'ACK' },
];

describe('dialogLifecycle', () => {
  it('reports a call still in progress as answered but not terminated', () => {
    const r = dialogLifecycle(LIVE_CALL);
    expect(r.answerTime?.toISOString()).toBe('2026-10-19T20:12:36.574Z');
    expect(r.terminatedAt).toBeUndefined();
  });

  it('does not let the ACK end the call', () => {
    // The ACK is the last message for the entire conversation. If it were
    // treated as the end, every live call would read ~5s forever.
    const r = dialogLifecycle(LIVE_CALL);
    expect(r.terminatedAt).toBeUndefined();
  });

  it('measures talk time from the answer, not from the INVITE', () => {
    const r = dialogLifecycle([
      ...LIVE_CALL,
      { t: T('2026-10-19T20:15:36.574Z'), m: 'BYE', c: 'BYE' },
    ]);
    const talk = r.terminatedAt!.getTime() - r.answerTime!.getTime();
    expect(talk).toBe(180_000); // exactly 3 minutes of conversation
    // From the INVITE it would be 185.1s -- the 5.1s it spent ringing must
    // not be billed as conversation.
    const fromInvite = r.terminatedAt!.getTime() - LIVE_CALL[0].t.getTime();
    expect(fromInvite).toBe(185_102);
  });

  it('ends an established dialog on a BYE identified only by CSeq', () => {
    // A BYE's own 200 response carries no method, only cseqMethod.
    const r = dialogLifecycle([...LIVE_CALL, { t: T('2026-10-19T20:13:00.000Z'), s: 200, c: 'BYE' }]);
    expect(r.terminatedAt?.toISOString()).toBe('2026-10-19T20:13:00.000Z');
  });

  it('does NOT treat a failed re-INVITE as a hangup', () => {
    // The trap: a declined hold or a codec renegotiation mid-call is a >=300
    // response to an INVITE while the two parties are still talking. Stopping
    // the timer there would under-report a call that is still up.
    const r = dialogLifecycle([
      ...LIVE_CALL,
      { t: T('2026-10-19T20:13:10.000Z'), m: 'INVITE', c: 'INVITE' },
      { t: T('2026-10-19T20:13:10.100Z'), s: 488, c: 'INVITE' },
    ]);
    expect(r.answerTime?.toISOString()).toBe('2026-10-19T20:12:36.574Z');
    expect(r.terminatedAt).toBeUndefined();
  });

  it('terminates an UNanswered call on a rejection', () => {
    const r = dialogLifecycle([
      { t: T('2026-10-19T20:12:31.472Z'), m: 'INVITE', c: 'INVITE' },
      { t: T('2026-10-19T20:12:31.900Z'), s: 100, c: 'INVITE' },
      { t: T('2026-10-19T20:12:40.000Z'), s: 486, c: 'INVITE' },
    ]);
    expect(r.answerTime).toBeUndefined();
    expect(r.terminatedAt?.toISOString()).toBe('2026-10-19T20:12:40.000Z');
  });

  it('terminates an UNanswered call on a CANCEL', () => {
    const r = dialogLifecycle([
      { t: T('2026-10-19T20:12:31.472Z'), m: 'INVITE', c: 'INVITE' },
      { t: T('2026-10-19T20:12:35.000Z'), m: 'CANCEL', c: 'CANCEL' },
    ]);
    expect(r.answerTime).toBeUndefined();
    expect(r.terminatedAt?.toISOString()).toBe('2026-10-19T20:12:35.000Z');
  });

  it('reports a still-ringing call as neither answered nor terminated', () => {
    const r = dialogLifecycle([
      { t: T('2026-10-19T20:12:31.472Z'), m: 'INVITE', c: 'INVITE' },
      { t: T('2026-10-19T20:12:31.900Z'), s: 180, c: 'INVITE' },
    ]);
    expect(r.answerTime).toBeUndefined();
    expect(r.terminatedAt).toBeUndefined();
  });

  it('never reads a 200 to another transaction as the call being answered', () => {
    // A REGISTER refresh or an in-dialog OPTIONS keepalive both produce a 200.
    // Keying on cseqMethod is what keeps them out.
    const r = dialogLifecycle([
      { t: T('2026-10-19T20:12:31.472Z'), m: 'INVITE', c: 'INVITE' },
      { t: T('2026-10-19T20:12:31.500Z'), s: 200, c: 'REGISTER' },
      { t: T('2026-10-19T20:12:31.600Z'), s: 200, c: 'OPTIONS' },
    ]);
    expect(r.answerTime).toBeUndefined();
  });

  it('takes the FIRST 2xx as the answer when a 200 is retransmitted', () => {
    // Observed in the real capture: the 200 appears four times as it is
    // relayed hop by hop. The earliest is when the callee actually picked up.
    const r = dialogLifecycle([
      { t: T('2026-10-19T20:12:36.574Z'), s: 200, c: 'INVITE' },
      { t: T('2026-10-19T20:12:36.575Z'), s: 200, c: 'INVITE' },
      { t: T('2026-10-19T20:12:36.577Z'), s: 200, c: 'INVITE' },
    ]);
    expect(r.answerTime?.toISOString()).toBe('2026-10-19T20:12:36.574Z');
  });

  it('handles an empty dialog without inventing times', () => {
    expect(dialogLifecycle([])).toEqual({ answerTime: undefined, terminatedAt: undefined });
  });
});
