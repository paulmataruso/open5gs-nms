import * as dgram from 'dgram';
import pino from 'pino';
import { HepCollector, HepBinding } from '../hep-collector';
import { HEP_CHUNK, HEP_PROTO_SIP } from '../hep-parser';
import { SipTraceDocument } from '../sip-trace-store';

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

  it('counts a non-HEP datagram by reason without storing anything', async () => {
    await send(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    await settle();
    await c.stop();
    expect(stub.inserted).toHaveLength(0);
    expect(c.getStats().dropped.bad_magic).toBe(1);
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
