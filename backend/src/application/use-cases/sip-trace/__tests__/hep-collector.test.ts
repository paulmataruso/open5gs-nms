import * as dgram from 'dgram';
import pino from 'pino';
import { HepCollector, HepBinding } from '../hep-collector';
import { HEP_CHUNK, HEP_PROTO_SIP } from '../hep-parser';
import { SipTraceDocument } from '../sip-trace-store';
import { normaliseParty } from '../call-scope';

// Exercises the real UDP socket and the real batching path; only Mongo is
// stubbed. A collector that parses perfectly in unit tests but never actually
// receives a datagram would pass a parser-only suite.

function chunk(type: number, body: Buffer, vendor = 0): Buffer {
  const h = Buffer.alloc(6);
  h.writeUInt16BE(vendor, 0); h.writeUInt16BE(type, 2); h.writeUInt16BE(body.length + 6, 4);
  return Buffer.concat([h, body]);
}
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
const ip4 = (s: string) => Buffer.from(s.split('.').map(Number));

function hep(payload: string, protoType = HEP_PROTO_SIP): Buffer {
  const body = Buffer.concat([
    chunk(HEP_CHUNK.PROTOCOL_ID, u8(17)),
    chunk(HEP_CHUNK.IPV4_SRC, ip4('10.0.1.195')),
    chunk(HEP_CHUNK.IPV4_DST, ip4('10.0.1.178')),
    chunk(HEP_CHUNK.SRC_PORT, u16(5060)),
    chunk(HEP_CHUNK.DST_PORT, u16(5100)),
    chunk(HEP_CHUNK.TIMESTAMP_SEC, u32(1760000000)),
    chunk(HEP_CHUNK.TIMESTAMP_USEC, u32(0)),
    chunk(HEP_CHUNK.PROTOCOL_TYPE, u8(protoType)),
    chunk(HEP_CHUNK.CAPTURE_AGENT_ID, u32(0)), // stock template never sets this

    chunk(HEP_CHUNK.PAYLOAD, Buffer.from(payload, 'utf8')),
  ]);
  const head = Buffer.alloc(6);
  head.write('HEP3', 0, 'ascii');
  head.writeUInt16BE(body.length + 6, 4);
  return Buffer.concat([head, body]);
}

/**
 * The same message as hep(), in the HEPv1 encoding siptrace actually emits by
 * default (`hep_version` defaults to 1). The collector required HEP3 for a
 * while, so every real message was counted as a parse failure and dropped
 * while the UI still reported capture as running -- hence a collector-level
 * test, not just a parser one.
 */
function hep1(payload: string): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt8(1, 0);            // hp_v
  h.writeUInt8(16, 1);           // hp_l: 8 + two IPv4 addresses
  h.writeUInt8(2, 2);            // hp_f: AF_INET
  h.writeUInt8(17, 3);           // hp_p: UDP
  h.writeUInt16BE(5060, 4);
  h.writeUInt16BE(5100, 6);
  return Buffer.concat([h, ip4('10.0.1.195'), ip4('10.0.1.178'), Buffer.from(payload, 'utf8')]);
}

const sip = (callId: string, method = 'INVITE') =>
  [`${method} sip:bob@ims.mnc001.mcc001.3gppnetwork.org SIP/2.0`,
   `From: <sip:alice@ims.mnc001.mcc001.3gppnetwork.org>;tag=1`,
   `To: <sip:bob@ims.mnc001.mcc001.3gppnetwork.org>`,
   `Call-ID: ${callId}`, `CSeq: 1 ${method}`, '', ''].join('\r\n');

/** Minimal stand-in for the pieces of Db the store touches. */
function stubDb() {
  const inserted: SipTraceDocument[] = [];
  let failNext = false;
  const db: any = {
    collection: () => ({
      insertMany: async (docs: SipTraceDocument[]) => {
        if (failNext) { failNext = false; throw new Error('mongo down'); }
        inserted.push(...docs);
        return { insertedCount: docs.length };
      },
    }),
  };
  return { db, inserted, failMongoOnce: () => { failNext = true; } };
}

// High ports so the suite never collides with a real collector on 9060-9062.
const PORTS = { pcscf: 19060, icscf: 19061, scscf: 19062 } as const;
const BINDINGS: HepBinding[] = [
  { source: 'pcscf', port: PORTS.pcscf },
  { source: 'icscf', port: PORTS.icscf },
  { source: 'scscf', port: PORTS.scscf },
];
const send = (buf: Buffer, port: number = PORTS.pcscf) =>
  new Promise<void>((res, rej) => {
    const s = dgram.createSocket('udp4');
    s.send(buf, port, '127.0.0.1', err => { s.close(); err ? rej(err) : res(); });
  });

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

describe('HepCollector over a real UDP socket', () => {
  let c: HepCollector;
  let stub: ReturnType<typeof stubDb>;
  const log = pino({ level: 'silent' });

  beforeEach(async () => {
    stub = stubDb();
    c = new HepCollector(stub.db, log, BINDINGS, '127.0.0.1');
    await c.start();
  });
  afterEach(async () => { await c.stop(); });

  it('binds one listener per instance, all on loopback', () => {
    const s = c.getStats();
    expect(s.running).toBe(true);
    expect(s.bind).toBe('127.0.0.1');
    expect(s.startedAt).toBeInstanceOf(Date);
    expect(s.listeners).toHaveLength(3);
    expect(s.listeners.every(l => l.bound)).toBe(true);
    expect(s.listeners.map(l => l.source).sort()).toEqual(['icscf', 'pcscf', 'scscf']);
  });

  it('receives a datagram, stores the message, and labels its source instance', async () => {
    await send(hep(sip('call-1')), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains, so this is the deterministic flush
    expect(stub.inserted).toHaveLength(1);
    expect(stub.inserted[0].callId).toBe('call-1');
    expect(stub.inserted[0].source).toBe('pcscf');
    expect(stub.inserted[0].method).toBe('INVITE');
    expect(stub.inserted[0].transport).toBe('UDP');
    expect(c.getStats().packetsReceived).toBe(1);
  });

  it('distinguishes all three CSCFs by RECEIVING PORT, not capture agent id', async () => {
    // The stock IMS template never sets hep_capture_id, so every instance
    // reports agent id 0 -- the port is the only thing that tells them apart.
    // These datagrams all carry agent id 0 on purpose.
    await send(hep(sip('c-p')), PORTS.pcscf);
    await send(hep(sip('c-i')), PORTS.icscf);
    await send(hep(sip('c-s')), PORTS.scscf);
    await settle(120);
    await c.stop();
    expect(stub.inserted.every(d => d.captureAgentId === 0)).toBe(true);
    const byCall = new Map(stub.inserted.map(d => [d.callId, d.source]));
    expect(byCall.get('c-p')).toBe('pcscf');
    expect(byCall.get('c-i')).toBe('icscf');
    expect(byCall.get('c-s')).toBe('scscf');
  });

  it('counts received packets per instance, so a silent tap is visible', async () => {
    await send(hep(sip('a')), PORTS.scscf);
    await send(hep(sip('b')), PORTS.scscf);
    await settle(120);
    const st = c.getStats();
    expect(st.packetsBySource.scscf).toBe(2);
    expect(st.packetsBySource.pcscf).toBeUndefined();
  });

  it('counts a non-SIP HEP payload as ignored instead of storing it', async () => {
    // A shared HEP port can carry RTCP; storing it as SIP would corrupt the view.
    await send(hep('not sip at all', 5 /* RTCP */), PORTS.pcscf);
    await settle();
    await c.stop();
    expect(stub.inserted).toHaveLength(0);
    expect(c.getStats().nonSipIgnored).toBe(1);
  });

  it('stores a HEPv1 datagram, the format siptrace sends by default', async () => {
    await send(hep1(sip('v1-call-1')), PORTS.pcscf);
    await settle();
    await c.stop();
    expect(stub.inserted).toHaveLength(1);
    expect(stub.inserted[0].callId).toBe('v1-call-1');
    expect(stub.inserted[0].method).toBe('INVITE');
    expect(stub.inserted[0].srcIp).toBe('10.0.1.195');
    expect(c.getStats().dropped).toEqual({});
  });

  it('accepts both encodings on the same listener', async () => {
    // A deployment can hold CSCFs configured either way, and a later
    // `hep_version 3` in the templates must not need a collector change.
    await send(hep1(sip('mixed-v1')), PORTS.pcscf);
    await send(hep(sip('mixed-v3')), PORTS.pcscf);
    await settle();
    await c.stop();
    expect(stub.inserted.map(d => d.callId).sort()).toEqual(['mixed-v1', 'mixed-v3']);
  });

  it('counts a non-HEP datagram by reason without storing anything', async () => {
    await send(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    await settle();
    await c.stop();
    expect(stub.inserted).toHaveLength(0);
    // `unsupported_version`, not `bad_magic`: the collector accepts both HEP
    // encodings (siptrace emits v1 by default), so anything without the HEP3
    // magic is read as a v1/v2 header, and 'G' is version 71. The point of
    // this test is that a stray datagram is counted under some reason and
    // never stored -- not which reason.
    expect(c.getStats().dropped.unsupported_version).toBe(1);
    expect(Object.values(c.getStats().dropped).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('keeps a message that has no Call-ID, under a synthetic id', async () => {
    // A malformed message is often exactly what is being hunted.
    const noCallId = 'INVITE sip:x SIP/2.0\r\nCSeq: 1 INVITE\r\n\r\n';
    await send(hep(noCallId), PORTS.pcscf);
    await settle();
    await c.stop();
    expect(stub.inserted).toHaveLength(1);
    expect(stub.inserted[0].callId).toMatch(/^_nocallid_/);
  });

  it('batches many datagrams rather than inserting one at a time', async () => {
    for (let i = 0; i < 25; i++) await send(hep(sip(`bulk-${i}`)), PORTS.scscf);
    await settle(150);
    await c.stop();
    expect(stub.inserted).toHaveLength(25);
    expect(new Set(stub.inserted.map(d => d.callId)).size).toBe(25);
  });

  it('survives a failing Mongo write and keeps collecting afterwards', async () => {
    stub.failMongoOnce();
    await send(hep(sip('lost')), PORTS.pcscf);
    await settle(1200); // let the interval flush fire and fail
    await send(hep(sip('kept')), PORTS.pcscf);
    await settle();
    await c.stop();
    expect(c.getStats().lastError).toContain('mongo down');
    expect(stub.inserted.map(d => d.callId)).toContain('kept');
    expect(c.getStats().running).toBe(false);
  });

  it('stop() is idempotent and leaves the port free to rebind', async () => {
    await c.stop();
    await c.stop();
    const again = new HepCollector(stub.db, log, BINDINGS, '127.0.0.1');
    await expect(again.start()).resolves.toBeUndefined();
    await again.stop();
  });
});

// ── Scoping and keepalive suppression, through the real socket ──────────────
//
// The pure decision logic is covered in call-scope.test.ts. This block exists
// because the WIRING is what actually drops a message: the filter is applied
// after parsing, before the queue, and a mistake there would be invisible to a
// pure-function test.

/** A SIP message with controllable From/To users and CSeq method. */
const sipParties = (callId: string, fromUser: string, toUser: string, method = 'INVITE', status?: number) => {
  const start = status
    ? `SIP/2.0 ${status} ${status === 200 ? 'OK' : 'Trying'}`
    : `${method} sip:${toUser}@ims.mnc001.mcc001.3gppnetwork.org SIP/2.0`;
  return [
    start,
    `From: <sip:${fromUser}@ims.mnc001.mcc001.3gppnetwork.org>;tag=1`,
    `To: <sip:${toUser}@ims.mnc001.mcc001.3gppnetwork.org>`,
    `Call-ID: ${callId}`,
    `CSeq: 1 ${method}`,
    '', '',
  ].join('\r\n');
};

describe('HepCollector keepalive suppression', () => {
  let c: HepCollector;
  let stub: ReturnType<typeof stubDb>;
  const log = pino({ level: 'silent' });

  beforeEach(async () => {
    stub = stubDb();
    c = new HepCollector(stub.db, log, BINDINGS, '127.0.0.1');
    await c.start();
  });
  afterEach(async () => { await c.stop(); });

  it('drops the dispatcher OPTIONS keepalive with no session running', async () => {
    // 68% of this deployment's real store, each one its own dialog.
    await send(hep(sipParties('ka-1', 'dispatcher', '127.0.1.1:4060', 'OPTIONS')), PORTS.scscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(0);
    expect(c.getStats().keepalivesIgnored).toBe(1);
  });

  it('drops the keepalive REPLY too, which carries no method at all', async () => {
    await send(hep(sipParties('ka-2', 'dispatcher', '127.0.1.1:4060', 'OPTIONS', 200)), PORTS.scscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(0);
    expect(c.getStats().keepalivesIgnored).toBe(1);
  });

  it('still stores a real call when keepalives are being suppressed', async () => {
    await send(hep(sipParties('real-1', '15550000001', '6034771783')), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(1);
    expect(c.getStats().keepalivesIgnored).toBe(0);
  });

  it('keeps keepalives when explicitly opted back in', async () => {
    c.setStoreKeepalives(true);
    await send(hep(sipParties('ka-3', 'dispatcher', '127.0.1.1:4060', 'OPTIONS')), PORTS.scscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(1);
  });
});

describe('HepCollector scoped to a Call Debug session', () => {
  let c: HepCollector;
  let stub: ReturnType<typeof stubDb>;
  const log = pino({ level: 'silent' });

  const scopeTo = (parties: string[], o: Partial<{ dialogScope: any; tagOnly: boolean }> = {}) =>
    c.setScopeFilter({
      sessionId: 'SESS-1',
      parties: parties.map(normaliseParty),
      dialogScope: o.dialogScope ?? 'calls',
      tagOnly: o.tagOnly ?? false,
    });

  beforeEach(async () => {
    stub = stubDb();
    c = new HepCollector(stub.db, log, BINDINGS, '127.0.0.1');
    await c.start();
  });
  afterEach(async () => { await c.stop(); });

  it('stores an in-scope call and stamps the session id on it', async () => {
    scopeTo(['15550000001', '6034771783']);
    await send(hep(sipParties('in-1', '15550000001', '6034771783')), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(1);
    expect(stub.inserted[0].sessionId).toBe('SESS-1');
  });

  it('drops a different subscriber entirely, and counts it', async () => {
    scopeTo(['15550000001']);
    await send(hep(sipParties('other-1', '15550000007', '15550000004')), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(0);
    expect(c.getStats().scopeFiltered).toBe(1);
  });

  it('excludes the reg-event SUBSCRIBE dialog even though it carries the MSISDN', async () => {
    // Measured live at 211/217/218 messages in ONE dialog -- party scoping
    // alone would drag that into every session.
    scopeTo(['15550000001']);
    await send(hep(sipParties('sub-1', '15550000001', '15550000001', 'SUBSCRIBE')), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(0);
  });

  it('includes REGISTER on the IMSI identity when registration context is asked for', async () => {
    scopeTo(['15550000001', '001010000053555'], { dialogScope: 'callsAndRegistration' });
    await send(hep(sipParties('reg-1', '001010000053555', '001010000053555', 'REGISTER')), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(1);
    expect(stub.inserted[0].sessionId).toBe('SESS-1');
  });

  it('stores a response whose request has not arrived yet', async () => {
    // Transaction-mode replies come back through tm callbacks on three
    // independent sockets, so a 100 Trying can genuinely be seen first.
    scopeTo(['15550000001']);
    await send(hep(sipParties('race-1', '15550000001', '6034771783', 'INVITE', 100)), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(1);
  });

  it('releases the scope when the filter is cleared', async () => {
    scopeTo(['15550000001']);
    c.setScopeFilter(null);
    await send(hep(sipParties('after-1', '15550000007', '15550000004')), PORTS.pcscf);
    await settle();
    await c.stop(); // stop() drains; the 1s flush interval has not fired yet
    expect(stub.inserted).toHaveLength(1);
    expect(stub.inserted[0].sessionId).toBeUndefined();
    expect(c.getStats().activeSessionId).toBeNull();
  });

  it('reports the active session id while scoped', async () => {
    scopeTo(['15550000001']);
    expect(c.getStats().activeSessionId).toBe('SESS-1');
  });
});
