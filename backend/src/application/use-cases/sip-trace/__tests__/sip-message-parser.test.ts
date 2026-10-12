import { parseSipMessage, sipUser, messageLabel } from '../sip-message-parser';

const DOMAIN = 'ims.mnc001.mcc001.3gppnetwork.org';

const REGISTER = [
  `REGISTER sip:${DOMAIN} SIP/2.0`,
  'Via: SIP/2.0/UDP 10.0.1.195:5060;branch=z9hG4bK1',
  `From: <sip:001010000000001@${DOMAIN}>;tag=abc`,
  `To: <sip:001010000000001@${DOMAIN}>`,
  'Call-ID: reg-call-id-1',
  'CSeq: 1 REGISTER',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');

const OK_200 = [
  'SIP/2.0 200 OK',
  'Via: SIP/2.0/UDP 10.0.1.195:5060;branch=z9hG4bK1',
  `From: "Alice Smith" <sip:001010000000001@${DOMAIN}>;tag=abc`,
  `To: <sip:001010000000002@${DOMAIN}>;tag=def`,
  'Call-ID: inv-call-id-2',
  'CSeq: 314 INVITE',
  '',
  '',
].join('\r\n');

describe('parseSipMessage', () => {
  it('parses a request start line', () => {
    const p = parseSipMessage(REGISTER);
    expect(p.isRequest).toBe(true);
    expect(p.method).toBe('REGISTER');
    expect(p.statusCode).toBeUndefined();
    expect(p.callId).toBe('reg-call-id-1');
    expect(p.cseqMethod).toBe('REGISTER');
    expect(p.cseqNumber).toBe(1);
  });

  it('parses a response, including the method it answers', () => {
    // A bare "200" is useless in a ladder when REGISTER, INVITE and BYE are
    // all in flight -- the CSeq method is what disambiguates it.
    const p = parseSipMessage(OK_200);
    expect(p.isRequest).toBe(false);
    expect(p.statusCode).toBe(200);
    expect(p.statusReason).toBe('OK');
    expect(p.cseqMethod).toBe('INVITE');
    expect(p.method).toBeUndefined();
  });

  it('separates display name from URI', () => {
    const p = parseSipMessage(OK_200);
    expect(p.fromDisplay).toBe('Alice Smith');
    expect(p.fromUri).toBe(`sip:001010000000001@${DOMAIN}`);
    expect(p.toUri).toBe(`sip:001010000000002@${DOMAIN}`);
    expect(p.toDisplay).toBeUndefined();
  });

  it('understands compact header forms', () => {
    // RFC 3261 allows i/f/t; real UEs do use them to save bytes, and missing
    // them would silently drop the Call-ID and leave the message ungroupable.
    const msg = [
      `INVITE sip:bob@${DOMAIN} SIP/2.0`,
      'i: compact-call-id',
      `f: <sip:alice@${DOMAIN}>;tag=1`,
      `t: <sip:bob@${DOMAIN}>`,
      'CSeq: 7 INVITE',
      '',
      '',
    ].join('\r\n');
    const p = parseSipMessage(msg);
    expect(p.callId).toBe('compact-call-id');
    expect(p.fromUri).toBe(`sip:alice@${DOMAIN}`);
    expect(p.toUri).toBe(`sip:bob@${DOMAIN}`);
  });

  it('folds continuation lines into the header value', () => {
    const msg = [
      `INVITE sip:bob@${DOMAIN} SIP/2.0`,
      'Call-ID: folded-id',
      'From: "Long Name"',
      `  <sip:alice@${DOMAIN}>;tag=1`,
      'CSeq: 1 INVITE',
      '',
      '',
    ].join('\r\n');
    const p = parseSipMessage(msg);
    expect(p.fromUri).toBe(`sip:alice@${DOMAIN}`);
    expect(p.fromDisplay).toBe('Long Name');
  });

  it('accepts bare LF as well as CRLF', () => {
    const p = parseSipMessage(REGISTER.replace(/\r\n/g, '\n'));
    expect(p.method).toBe('REGISTER');
    expect(p.callId).toBe('reg-call-id-1');
  });

  it('handles a URI with no angle brackets', () => {
    const msg = ['BYE sip:x SIP/2.0', `From: sip:alice@${DOMAIN};tag=9`, 'Call-ID: nb', '', ''].join('\r\n');
    const p = parseSipMessage(msg);
    expect(p.fromUri).toBe(`sip:alice@${DOMAIN}`);
  });

  it('stops reading headers at the blank line, ignoring the body', () => {
    // An SDP body containing a line that looks like a header must not be
    // mistaken for one.
    const msg = [
      `INVITE sip:bob@${DOMAIN} SIP/2.0`,
      'Call-ID: real-id',
      'CSeq: 1 INVITE',
      '',
      'Call-ID: body-id-should-be-ignored',
      'o=- 0 0 IN IP4 10.0.1.195',
    ].join('\r\n');
    expect(parseSipMessage(msg).callId).toBe('real-id');
  });

  it('degrades gracefully on a malformed message instead of throwing', () => {
    // A malformed message is often the thing being hunted, so it must still
    // appear in the trace.
    const p = parseSipMessage('this is not SIP at all');
    expect(p.method).toBeUndefined();
    expect(p.statusCode).toBeUndefined();
    expect(p.startLine).toBe('this is not SIP at all');
    expect(() => parseSipMessage('')).not.toThrow();
  });
});

describe('sipUser', () => {
  it('extracts the user part from sip/sips/tel URIs', () => {
    expect(sipUser(`sip:001010000000001@${DOMAIN}`)).toBe('001010000000001');
    expect(sipUser(`sips:bob@${DOMAIN}`)).toBe('bob');
    expect(sipUser('tel:+15551234567')).toBe('+15551234567');
  });
  it('stops at parameters and is safe on junk', () => {
    expect(sipUser('sip:alice@x;transport=tcp')).toBe('alice');
    expect(sipUser(undefined)).toBeUndefined();
    expect(sipUser('garbage')).toBeUndefined();
  });
});

describe('messageLabel', () => {
  it('labels a request by method', () => {
    expect(messageLabel(parseSipMessage(REGISTER))).toBe('REGISTER');
  });
  it('labels a response with its code, reason and answered method', () => {
    expect(messageLabel(parseSipMessage(OK_200))).toBe('200 OK (INVITE)');
  });
  it('falls back to the start line for an unparseable message', () => {
    expect(messageLabel(parseSipMessage('???'))).toBe('???');
  });
});
