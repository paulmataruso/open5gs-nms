import {
  CallScopeFilter,
  MAX_SUFFIX_LENGTH_DELTA,
  MIN_SUFFIX_DIGITS,
  decideScope,
  dialogScopeAllows,
  isKeepalive,
  isUnparseable,
  normaliseParty,
  partyMatches,
} from '../call-scope';

// Every fixture here is shaped from REAL messages observed in this
// deployment's own nms_sip_trace (8,465 documents inspected 2026-10-19), not
// invented -- including the exact values that make the dangerous cases
// dangerous.

const doc = (o: Partial<Parameters<typeof decideScope>[0]> = {}) => ({
  method: undefined,
  statusCode: undefined,
  cseqMethod: undefined,
  fromUser: undefined,
  toUser: undefined,
  ...o,
});

const filterFor = (parties: string[], o: Partial<CallScopeFilter> = {}): CallScopeFilter => ({
  sessionId: 'S1',
  parties: parties.map(normaliseParty),
  dialogScope: 'calls',
  tagOnly: false,
  ...o,
});

describe('normaliseParty', () => {
  it('reduces every human rendering of one number to the same digits', () => {
    for (const raw of ['15550000001', '+15550000001', '+1 (555) 000-0001', 'tel:+15550000001', 'sip:15550000001']) {
      expect(normaliseParty(raw).digits).toBe('15550000001');
    }
  });

  it('keeps no digit form for a value that is not a phone number', () => {
    // A bare host:port is exactly what sipUser() returns for the user-less URI
    // in every dispatcher keepalive, so this must NOT become digits.
    expect(normaliseParty('127.0.1.1:4060').digits).toBeUndefined();
    expect(normaliseParty('dispatcher').digits).toBeUndefined();
    expect(normaliseParty('alice@example.org').digits).toBeUndefined();
  });
});

describe('party matching', () => {
  it('matches the same number written with and without a country code', () => {
    // Real: this deployment dialled the same PSTN number both ways.
    expect(partyMatches(doc({ toUser: '16034771783' }), [normaliseParty('6034771783')])).toBe(true);
    expect(partyMatches(doc({ toUser: '6034771783' }), [normaliseParty('16034771783')])).toBe(true);
  });

  it('matches on either side, because an in-dialog request swaps From and To', () => {
    const f = [normaliseParty('15550000001')];
    expect(partyMatches(doc({ fromUser: '15550000001', toUser: '6034771783' }), f)).toBe(true);
    // the callee's own BYE
    expect(partyMatches(doc({ fromUser: '6034771783', toUser: '15550000001' }), f)).toBe(true);
  });

  it('never lets a short code suffix-match a longer number', () => {
    // Live data has toUser "600" and short codes of this shape; suffix
    // matching them would scoop up unrelated subscribers.
    expect(partyMatches(doc({ toUser: '15552020' }), [normaliseParty('2020')])).toBe(false);
    expect(partyMatches(doc({ toUser: '600' }), [normaliseParty('600')])).toBe(true);
    expect(partyMatches(doc({ toUser: '15550000600' }), [normaliseParty('600')])).toBe(false);
  });

  it('never suffix-matches an IMSI that shares the fromUser field', () => {
    // THE hazard: 001010000000001 is a real live fromUser value sitting in the
    // same field as MSISDNs. A 7-digit entry must not reach it.
    expect(partyMatches(doc({ fromUser: '001010000000001' }), [normaliseParty('0000001')])).toBe(false);
    expect(partyMatches(doc({ fromUser: '001010000000001' }), [normaliseParty('00000001')])).toBe(false);
    // ...but the operator's own resolved IMSI still matches exactly.
    expect(partyMatches(doc({ fromUser: '001010000053555' }), [normaliseParty('001010000053555')])).toBe(true);
  });

  it('never digit-matches a user part that is not wholly digits', () => {
    // sipUser("sip:127.0.1.1:4060") === "127.0.1.1:4060". Stripping
    // non-digits would give 1270114060 and make it eligible against a real
    // 10-digit MSISDN. It must stay ineligible.
    expect(partyMatches(doc({ toUser: '127.0.1.1:4060' }), [normaliseParty('1270114060')])).toBe(false);
    expect(partyMatches(doc({ fromUser: 'dispatcher' }), [normaliseParty('15550000001')])).toBe(false);
  });

  it('honours the documented thresholds exactly', () => {
    const sevenDigits = '1234567';
    expect(sevenDigits.length).toBe(MIN_SUFFIX_DIGITS);
    // at the delta limit -> matches
    const atLimit = '9'.repeat(MAX_SUFFIX_LENGTH_DELTA) + sevenDigits;
    expect(partyMatches(doc({ toUser: atLimit }), [normaliseParty(sevenDigits)])).toBe(true);
    // one past it -> does not
    const pastLimit = '9'.repeat(MAX_SUFFIX_LENGTH_DELTA + 1) + sevenDigits;
    expect(partyMatches(doc({ toUser: pastLimit }), [normaliseParty(sevenDigits)])).toBe(false);
    // one digit under the minimum -> exact only
    expect(partyMatches(doc({ toUser: '9123456' }), [normaliseParty('123456') ])).toBe(false);
  });
});

describe('keepalive suppression', () => {
  it('recognises both real keepalive senders', () => {
    // S-CSCF dispatcher -> Asterisk: 5,763 live documents, every one its own dialog.
    expect(isKeepalive(doc({ method: 'OPTIONS' }))).toBe(true);
    // ...and its reply, which has no method at all, only a CSeq.
    expect(isKeepalive(doc({ statusCode: 200, cseqMethod: 'OPTIONS' }))).toBe(true);
    expect(isKeepalive(doc({ method: 'INVITE' }))).toBe(false);
  });

  it('drops keepalives even with no session running', () => {
    expect(decideScope(doc({ method: 'OPTIONS', fromUser: 'dispatcher', toUser: '127.0.1.1:4060' }), null, false))
      .toEqual({ store: false, reason: 'keepalive' });
  });

  it('can be opted back in for debugging the keepalive itself', () => {
    const v = decideScope(doc({ method: 'OPTIONS', fromUser: 'dispatcher' }), null, true);
    expect(v.store).toBe(true);
  });
});

describe('malformed messages fail OPEN', () => {
  it('treats a message with no identity as unparseable', () => {
    expect(isUnparseable(doc())).toBe(true);
    expect(isUnparseable(doc({ method: 'INVITE' }))).toBe(true);            // no parties
    expect(isUnparseable(doc({ fromUser: '15550000001' }))).toBe(true);     // no method/status
    expect(isUnparseable(doc({ method: 'INVITE', fromUser: '15550000001' }))).toBe(false);
  });

  it('stores an unparseable message mid-session even though it matches nothing', () => {
    // sip-message-parser.ts and sip-trace-store.ts both carry explicit
    // comments that a malformed message is often the thing being hunted. A
    // party filter must not quietly reverse that.
    const v = decideScope(doc({ fromUser: undefined, toUser: undefined }), filterFor(['15550000001']), false);
    expect(v).toEqual({ store: true, reason: 'unparseable' });
  });
});

describe('dialog scope', () => {
  const invite = doc({ method: 'INVITE', cseqMethod: 'INVITE', fromUser: '15550000001', toUser: '6034771783' });
  const register = doc({ method: 'REGISTER', cseqMethod: 'REGISTER', fromUser: '001010000053555', toUser: '001010000053555' });
  const subscribe = doc({ method: 'SUBSCRIBE', cseqMethod: 'SUBSCRIBE', fromUser: '15550000001', toUser: '15550000001' });

  it('keeps the whole call, including in-dialog methods', () => {
    for (const m of ['INVITE', 'ACK', 'BYE', 'CANCEL', 'PRACK', 'UPDATE']) {
      expect(dialogScopeAllows(doc({ cseqMethod: m }), 'calls')).toBe(true);
    }
  });

  it('excludes the reg-event SUBSCRIBE/NOTIFY dialog by default', () => {
    // Measured live at 211/217/218 messages in ONE dialog, and it carries the
    // subscriber's own MSISDN -- so party scoping alone does not exclude it.
    expect(dialogScopeAllows(subscribe, 'calls')).toBe(false);
    expect(dialogScopeAllows(doc({ cseqMethod: 'NOTIFY' }), 'calls')).toBe(false);
    expect(dialogScopeAllows(subscribe, 'all')).toBe(true);
  });

  it('excludes REGISTER by default but includes it on request', () => {
    expect(dialogScopeAllows(register, 'calls')).toBe(false);
    expect(dialogScopeAllows(register, 'callsAndRegistration')).toBe(true);
  });

  it('classifies a response identically to its request, whichever arrives first', () => {
    // Transaction-mode replies arrive via tm callbacks on three independent
    // sockets, so a 100 Trying can genuinely be processed before its INVITE.
    // A response has no method -- only CSeq -- and must still be in scope.
    const trying = doc({ statusCode: 100, cseqMethod: 'INVITE', fromUser: '15550000001', toUser: '6034771783' });
    const f = filterFor(['15550000001']);
    expect(decideScope(trying, f, false)).toEqual({ store: true, sessionId: 'S1', reason: 'in-scope' });
    expect(decideScope(invite, f, false)).toEqual({ store: true, sessionId: 'S1', reason: 'in-scope' });
  });
});

describe('decideScope end to end', () => {
  it('stamps the session id on an in-scope call message', () => {
    const v = decideScope(
      doc({ method: 'INVITE', cseqMethod: 'INVITE', fromUser: '15550000001', toUser: '6034771783' }),
      filterFor(['15550000001', '6034771783']),
      false,
    );
    expect(v).toEqual({ store: true, sessionId: 'S1', reason: 'in-scope' });
  });

  it('drops another subscriber entirely while a session is scoped', () => {
    const v = decideScope(
      doc({ method: 'INVITE', cseqMethod: 'INVITE', fromUser: '15550000007', toUser: '15550000004' }),
      filterFor(['15550000001', '6034771783']),
      false,
    );
    expect(v).toEqual({ store: false, reason: 'out-of-scope' });
  });

  it('keeps out-of-scope traffic untagged in tagOnly mode', () => {
    const v = decideScope(
      doc({ method: 'INVITE', cseqMethod: 'INVITE', fromUser: '15550000007', toUser: '15550000004' }),
      filterFor(['15550000001'], { tagOnly: true }),
      false,
    );
    expect(v).toEqual({ store: true, reason: 'out-of-scope-tagged' });
  });

  it('matches the resolved IMSI as well as the typed MSISDN', () => {
    // Real: REGISTER uses the IMSI-form IMPU (001010000053555) while INVITE
    // uses the MSISDN (15550000001) -- 210 live messages separate them. An
    // operator typing only the MSISDN must still get registration context
    // once the resolver adds the IMSI.
    const f = filterFor(['15550000001', '001010000053555'], { dialogScope: 'callsAndRegistration' });
    const reg = doc({ method: 'REGISTER', cseqMethod: 'REGISTER', fromUser: '001010000053555', toUser: '001010000053555' });
    expect(decideScope(reg, f, false)).toEqual({ store: true, sessionId: 'S1', reason: 'in-scope' });
  });

  it('suppresses a keepalive before any party check, so it can never be tagged in', () => {
    const f = filterFor(['127.0.1.1:4060'], { tagOnly: true });
    expect(decideScope(doc({ method: 'OPTIONS', fromUser: 'dispatcher', toUser: '127.0.1.1:4060' }), f, false))
      .toEqual({ store: false, reason: 'keepalive' });
  });
});
