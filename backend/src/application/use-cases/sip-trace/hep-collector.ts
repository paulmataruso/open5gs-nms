import * as dgram from 'dgram';
import { Db } from 'mongodb';
import { HepParseError, parseHep, HEP_PROTO_SIP } from './hep-parser';
import { insertMessages, toDocument, SipTraceDocument, SipTraceSource, CAPTURE_PORTS } from './sip-trace-store';
import pino from 'pino';

// ── HEP collector ────────────────────────────────────────────────────────────
//
// Listens for the HEP stream Kamailio's siptrace module duplicates to us and
// writes it into nms_sip_trace.
//
// Bound to loopback only. Every sender is a local Kamailio instance, so there
// is no reason to accept HEP from the network -- and HEP is unauthenticated by
// default, so a routable bind would let anything on the RAN inject forged SIP
// into the operator's trace view.
//
// Writes are batched. A busy IMS node emits several messages per call leg per
// transaction, and one Mongo round-trip per datagram would make the collector
// the bottleneck instead of the thing it is observing.

export const DEFAULT_HEP_BIND = '127.0.0.1';

/** One socket per Kamailio instance; see CAPTURE_PORTS for why. */
export interface HepBinding {
  port: number;
  source: SipTraceSource;
}

/** Default: every CSCF the IMS templates support CAPTURE_NODE on. */
export const DEFAULT_HEP_BINDINGS: HepBinding[] = (
  Object.entries(CAPTURE_PORTS) as [SipTraceSource, number][]
).map(([source, port]) => ({ source, port }));

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_AT_COUNT = 200;
/**
 * Hard ceiling on the in-memory queue. If Mongo is unavailable the queue would
 * otherwise grow until the backend is OOM-killed, taking the whole NMS with it
 * -- dropping trace messages is the correct trade against that.
 */
const MAX_QUEUE = 20000;

export interface HepCollectorStats {
  running: boolean;
  bind: string;
  /** Per-instance listeners, and whether each actually bound. */
  listeners: { source: SipTraceSource; port: number; bound: boolean }[];
  startedAt: Date | null;
  packetsReceived: number;
  /** Per-instance receive counts -- the quickest way to see one tap is silent. */
  packetsBySource: Record<string, number>;
  messagesStored: number;
  /** Non-SIP HEP payloads (e.g. RTCP) -- received and deliberately ignored. */
  nonSipIgnored: number;
  dropped: Record<string, number>;
  queueDepth: number;
  queueOverflowDrops: number;
  lastPacketAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}

export class HepCollector {
  private socks: { sock: dgram.Socket; binding: HepBinding }[] = [];
  private queue: SipTraceDocument[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private flushing = false;

  private stats: HepCollectorStats = {
    running: false,
    bind: DEFAULT_HEP_BIND,
    listeners: [],
    startedAt: null,
    packetsReceived: 0,
    packetsBySource: {},
    messagesStored: 0,
    nonSipIgnored: 0,
    dropped: {},
    queueDepth: 0,
    queueOverflowDrops: 0,
    lastPacketAt: null,
    lastErrorAt: null,
    lastError: null,
  };

  constructor(
    private readonly db: Db,
    private readonly logger: pino.Logger,
    private readonly bindings: HepBinding[] = DEFAULT_HEP_BINDINGS,
    private readonly bind: string = DEFAULT_HEP_BIND,
  ) {
    this.stats.bind = bind;
    this.stats.listeners = bindings.map(b => ({ ...b, bound: false }));
  }

  getStats(): HepCollectorStats {
    return {
      ...this.stats,
      dropped: { ...this.stats.dropped },
      packetsBySource: { ...this.stats.packetsBySource },
      listeners: this.stats.listeners.map(l => ({ ...l })),
      queueDepth: this.queue.length,
    };
  }

  async start(): Promise<void> {
    if (this.socks.length) return;
    // Bind each instance's port independently. One port already in use must
    // not cost us the other two taps, so a failure is recorded against that
    // listener and the rest still come up -- the status endpoint shows which.
    for (const binding of this.bindings) {
      try {
        const sock = await this.bindOne(binding);
        this.socks.push({ sock, binding });
        const l = this.stats.listeners.find(x => x.port === binding.port);
        if (l) l.bound = true;
      } catch (err) {
        this.stats.lastError = `bind ${this.bind}:${binding.port} (${binding.source}): ${String(err)}`;
        this.stats.lastErrorAt = new Date();
        this.logger.error(
          { err: String(err), port: binding.port, source: binding.source },
          'HEP collector failed to bind a listener',
        );
      }
    }
    if (!this.socks.length) throw new Error(`HEP collector could not bind any listener: ${this.stats.lastError}`);

    this.stats.running = true;
    this.stats.startedAt = new Date();
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  private bindOne(binding: HepBinding): Promise<dgram.Socket> {
    return new Promise<dgram.Socket>((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      sock.on('message', buf => this.onDatagram(buf, binding.source));
      sock.on('error', err => {
        this.stats.lastError = String(err);
        this.stats.lastErrorAt = new Date();
        this.logger.error({ err: String(err), port: binding.port }, 'HEP socket error');
        if (!settled) { settled = true; reject(err); }
      });
      sock.on('listening', () => {
        if (!settled) { settled = true; resolve(sock); }
      });
      sock.bind(binding.port, this.bind);
    });
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const socks = this.socks;
    this.socks = [];
    this.stats.running = false;
    this.stats.listeners.forEach(l => { l.bound = false; });
    await Promise.all(socks.map(({ sock }) => new Promise<void>(res => sock.close(() => res()))));
    // Drain whatever was captured before shutting down rather than discarding it.
    await this.flush();
  }

  private onDatagram(buf: Buffer, source: SipTraceSource): void {
    this.stats.packetsReceived++;
    this.stats.packetsBySource[source] = (this.stats.packetsBySource[source] ?? 0) + 1;
    this.stats.lastPacketAt = new Date();
    try {
      // parseHep, not parseHep3: siptrace's `hep_version` defaults to 1 and
      // the CSCF templates cannot set it (a modparam must follow its own
      // loadmodule, and the generated include is imported above it), so the
      // datagrams this collector actually receives are v1. Requiring v3 here
      // is what made every captured message land in the bad_magic counter.
      const pkt = parseHep(buf);
      // siptrace only sends SIP, but a shared HEP port could receive RTCP or
      // log payloads from another agent; count those rather than storing them
      // as if they were SIP.
      if (pkt.payloadType !== HEP_PROTO_SIP && pkt.payloadType !== 0) {
        this.stats.nonSipIgnored++;
        return;
      }
      if (this.queue.length >= MAX_QUEUE) {
        this.stats.queueOverflowDrops++;
        return;
      }
      this.queue.push(toDocument(pkt, this.seq++, source));
      if (this.queue.length >= FLUSH_AT_COUNT) void this.flush();
    } catch (err) {
      const code = err instanceof HepParseError ? err.code : 'unknown';
      this.stats.dropped[code] = (this.stats.dropped[code] ?? 0) + 1;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.stats.lastErrorAt = new Date();
      // Deliberately not logged per-packet: a misdirected sender would turn a
      // parse failure into a log flood. The counters are the signal, and the
      // status endpoint surfaces them.
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      await insertMessages(this.db, batch);
      this.stats.messagesStored += batch.length;
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.stats.lastErrorAt = new Date();
      this.logger.error({ err: String(err), batch: batch.length }, 'HEP batch insert failed');
      // The batch is dropped rather than requeued: requeueing on a persistent
      // Mongo failure grows the queue without bound, and the TTL on this
      // collection means a lost trace batch is a far smaller problem than the
      // backend dying.
    } finally {
      this.flushing = false;
    }
  }
}
