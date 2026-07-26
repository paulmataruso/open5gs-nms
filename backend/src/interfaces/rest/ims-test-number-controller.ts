import { Router, Request, Response } from 'express';
import * as dgram from 'dgram';
import * as net from 'net';
import * as crypto from 'crypto';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import {
  readImsState, TestIdentity,
  provisionPyhssTestSubscriber, deprovisionPyhssTestSubscriber,
} from './volte-validation-controller';
import { pyhssApiCall } from './ims-controller';

// This feature's own test subscribers use a distinct "901" MSIN block —
// deliberately NOT the "900" block randomTestImsi() (VoLTE/VoWiFi E2E tests)
// uses — so reconcile() below can tell "leftover IMS Test Number bot
// instance from before a restart" apart from "leftover E2E test subscriber
// from a crashed test run" and never mistakenly resurrect the latter as a
// live SIP UAS.
function randomBotImsi(mcc: string, mnc: string): string {
  const plmn = mcc + mnc.padStart(3, '0');
  const suffix = '901' + crypto.randomInt(0, 100000).toString().padStart(5, '0');
  return (plmn + suffix).slice(0, 15).padEnd(15, '0');
}

// ── On-demand IMS test numbers ──────────────────────────────────────────────
//
// A real SIP UAS (not a simulator) that registers a PyHSS test subscriber and
// auto-answers/echoes any call placed to it — lets the user dial a real test
// number from a real phone against this project's real IMS core, without a
// second physical device. Promoted from an ad-hoc script into this permanent
// feature 2026-07-26 — see memory: ims-echo-test-bot, ims-real-iphone-call-flow
// for the full protocol writeup and the hard-won bugs already fixed here:
//
//   1. P-CSCF does not reliably honor the REGISTER Contact's `transport=`
//      param for the callback leg — observed forwarding INVITE over a brand
//      new TCP connection even when Contact said `transport=udp`. Every
//      instance listens on BOTH UDP and TCP on the same port.
//   2. A real phone's VoLTE offer is `a=inactive` + RFC 3312 preconditions
//      (`a=des:qos mandatory local sendrecv`) — a bare final 200 OK skipping
//      the 183/UPDATE precondition dance gets torn down immediately with
//      `BYE ... Reason: SIP;cause=200;text="Received reject SDP"`, even
//      though the SIP transaction itself completes with no error.
//   3. The final SDP answer must copy the offer's own `a=fmtp:<pt>` line for
//      whichever payload type is chosen — EVS/AMR are parametrized codecs;
//      an rtpmap with no matching fmtp is an incomplete codec negotiation
//      from the phone's perspective and reproduces the same reject-SDP BYE.
//   4. A registration refresh must redo the full unauthenticated->401->
//      authenticated challenge cycle — reusing a cached Authorization header
//      on refresh silently fails (nonce/response is single-use) while the
//      process keeps running with no visible error.
//
// Auth: PyHSS's S-CSCF "HSS-Selected" mode picks the auth scheme per
// subscriber, not globally — a provisionPyhssTestSubscriber()-created
// subscriber gets plain Digest-MD5 (Ki-as-password) automatically, with zero
// effect on any other (e.g. real AKA) subscriber's own registration. No
// global mode flip is ever needed for this feature.

function md5(s: string): string {
  return crypto.createHash('md5').update(s, 'utf-8').digest('hex');
}
function randHex(n: number): string {
  return crypto.randomBytes(n).toString('hex');
}

interface ParsedSip {
  statusLine: string;
  headers: Record<string, string>;
  body: string;
}

function parseSipMessage(raw: string): ParsedSip {
  const parts = raw.split('\r\n\r\n');
  const head = parts[0];
  const body = parts.slice(1).join('\r\n\r\n');
  const lines = head.split('\r\n');
  const statusLine = lines[0];
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  return { statusLine, headers, body };
}

function parseWwwAuth(h: string): { realm?: string; nonce?: string; qop: string } {
  return {
    realm: /realm="([^"]*)"/.exec(h)?.[1],
    nonce: /nonce="([^"]*)"/.exec(h)?.[1],
    qop: /qop="?([^",]*)"?/.exec(h)?.[1] || 'auth',
  };
}

// Extracts the bare URI from a Contact header value (e.g. "<sip:10.46.0.73:49949>;
// +g.3gpp...;audio" -> "sip:10.46.0.73:49949") — the correct RFC 3261 remote-target
// Request-URI for subsequent in-dialog requests, not the original dialed address.
function parseContactUri(contactHeader: string | undefined): string | undefined {
  if (!contactHeader) return undefined;
  return /<([^>]+)>/.exec(contactHeader)?.[1];
}

interface ActiveCall {
  rtpSock: dgram.Socket;
  toTag: string;
  finalSent: boolean;
  sendFinal200: () => void;
  sdpBody: (mediaDirection: string, extraLines?: string) => string;
}

export type OutboundCallState = 'dialing' | 'ringing' | 'answered' | 'ended' | 'failed';

interface OutboundCall {
  callId: string;
  targetNumber: string;
  rtpSock: dgram.Socket;
  localRtpPort: number;
  payloadType: string;
  codecLine: string;
  fmtpLine: string;
  state: OutboundCallState;
  toTag?: string;
  fromTag: string;
  cseq: number;
  inviteBranch: string;
  inviteCseq: number;
  // Peer's own Contact URI (e.g. "sip:10.46.0.73:49949"), captured from its first
  // response — the correct RFC 3261 remote-target Request-URI for every subsequent
  // in-dialog request (ACK/UPDATE/BYE), NOT the original dialed tel: address.
  remoteTarget?: string;
  // Record-Route value(s) from the dialog-establishing response, verbatim — per
  // RFC 3261 12.1.2, the UAC's route set for every subsequent in-dialog request.
  // A real iOS UAC's own ACK includes this; without it here, the far end kept
  // retransmitting its 200 OK as if our ACK never arrived.
  routeSet?: string;
  updateSent: boolean;
  failReason?: string;
}

export interface ImsTestNumberInfo {
  msisdn: string;
  imsi: string;
  localPort: number;
  createdAt: string;
  callsHandled: number;
  outboundCall: { targetNumber: string; state: OutboundCallState; failReason?: string } | null;
}

const BASE_SIP_PORT = 15100;
const MAX_INSTANCES = 50;
const REGISTER_REFRESH_MS = 600_000; // 10 min — well inside the 3600s Expires window

class ImsTestNumberInstance {
  private readonly sock = dgram.createSocket('udp4');
  private readonly tcpServer: net.Server;
  private readonly activeCalls = new Map<string, ActiveCall>();
  private readonly callId = `ims-test-${randHex(8)}`;
  private cseq = 1;
  private waitingResolve: ((p: ParsedSip) => void) | null = null;
  private refreshTimer?: NodeJS.Timeout;
  private outboundCall: OutboundCall | null = null;
  public callsHandled = 0;
  public readonly createdAt = new Date().toISOString();

  constructor(
    private readonly identity: TestIdentity,
    private readonly imsDomain: string,
    private readonly pcscfIp: string,
    private readonly pcscfPort: number,
    private readonly localPort: number,
    private readonly logger: pino.Logger,
  ) {
    this.tcpServer = net.createServer((conn) => {
      conn.on('data', (data) => this.handleIncoming(data.toString('utf-8'), (r) => conn.write(r, 'utf-8'), 'TCP'));
      conn.on('error', () => { /* connection reset by peer etc — not actionable */ });
    });
  }

  info(): ImsTestNumberInfo {
    return {
      msisdn: this.identity.msisdn,
      imsi: this.identity.imsi,
      localPort: this.localPort,
      createdAt: this.createdAt,
      callsHandled: this.callsHandled,
      outboundCall: this.outboundCall
        ? { targetNumber: this.outboundCall.targetNumber, state: this.outboundCall.state, failReason: this.outboundCall.failReason }
        : null,
    };
  }

  private send(msg: string, port = this.pcscfPort, ip = this.pcscfIp): void {
    this.sock.send(Buffer.from(msg, 'utf-8'), port, ip);
  }

  private buildRegister(authHeader?: string): string {
    const branch = `z9hG4bK${randHex(8)}`;
    const c = this.cseq++;
    let msg =
      `REGISTER sip:${this.imsDomain} SIP/2.0\r\n` +
      `Via: SIP/2.0/UDP ${this.pcscfIp}:${this.localPort};branch=${branch};rport\r\n` +
      `Max-Forwards: 70\r\n` +
      `To: <sip:${this.identity.imsi}@${this.imsDomain}>\r\n` +
      `From: <sip:${this.identity.imsi}@${this.imsDomain}>;tag=${randHex(6)}\r\n` +
      `Call-ID: ${this.callId}\r\n` +
      `CSeq: ${c} REGISTER\r\n` +
      `Contact: <sip:${this.identity.imsi}@${this.pcscfIp}:${this.localPort};transport=udp>\r\n` +
      `Expires: 3600\r\n`;
    if (authHeader) msg += `${authHeader}\r\n`;
    msg += `Content-Length: 0\r\n\r\n`;
    return msg;
  }

  private waitFor(pred: (p: ParsedSip) => boolean, timeoutMs: number): Promise<ParsedSip> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waitingResolve = null;
        reject(new Error('timeout waiting for SIP response'));
      }, timeoutMs);
      this.waitingResolve = (parsed) => {
        if (pred(parsed)) {
          clearTimeout(timer);
          this.waitingResolve = null;
          resolve(parsed);
        }
      };
    });
  }

  private async registerOnce(): Promise<ParsedSip> {
    this.send(this.buildRegister());
    const challenge = await this.waitFor((p) => /^SIP\/2\.0 401/.test(p.statusLine), 5000);
    const { realm, nonce, qop } = parseWwwAuth(challenge.headers['www-authenticate'] ?? '');

    const username = `${this.identity.imsi}@${this.imsDomain}`;
    const uri = `sip:${this.imsDomain}`;
    const nc = '00000001';
    const cnonce = randHex(4);
    const ha1 = md5(`${username}:${realm}:${this.identity.ki}`);
    const ha2 = md5(`REGISTER:${uri}`);
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    const authHeader =
      `Authorization: Digest username="${username}", realm="${realm}", ` +
      `nonce="${nonce}", uri="${uri}", response="${response}", algorithm=MD5, ` +
      `qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;

    this.send(this.buildRegister(authHeader));
    return this.waitFor((p) => /^SIP\/2\.0 (200|4\d\d|5\d\d)/.test(p.statusLine), 5000);
  }

  private handleIncoming(raw: string, reply: (data: string) => void, transport: string): void {
    const parsed = parseSipMessage(raw);
    if (/^SIP\/2\.0/.test(parsed.statusLine)) {
      const respCid = parsed.headers['call-id'];
      // REGISTER always uses this.callId; an active outbound call uses its own
      // random Call-ID — route by which one the response actually belongs to,
      // so a register refresh firing mid-call can't steal the call's response.
      if (respCid === this.callId && this.waitingResolve) {
        this.waitingResolve(parsed);
      } else if (this.outboundCall && respCid === this.outboundCall.callId) {
        this.handleOutboundResponse(parsed);
      }
      return;
    }
    const methodMatch = /^(\w+) (\S+) SIP\/2\.0/.exec(parsed.statusLine);
    if (!methodMatch) return;
    const method = methodMatch[1];
    const via = parsed.headers['via'];
    const from = parsed.headers['from'];
    const to = parsed.headers['to'];
    const cid = parsed.headers['call-id'];
    const cseqHdr = parsed.headers['cseq'];

    if (method === 'INVITE') {
      this.callsHandled++;
      this.logger.info({ msisdn: this.identity.msisdn, from, transport }, 'ims-test-number: incoming call');
      reply(`SIP/2.0 100 Trying\r\nVia: ${via}\r\nFrom: ${from}\r\nTo: ${to}\r\nCall-ID: ${cid}\r\nCSeq: ${cseqHdr}\r\nContent-Length: 0\r\n\r\n`);

      const rtpmapMatch = /a=rtpmap:(\d+) (\S+)/.exec(parsed.body);
      const payloadType = rtpmapMatch ? rtpmapMatch[1] : '0';
      const codecLine = rtpmapMatch ? rtpmapMatch[2] : 'PCMU/8000';
      // Real VoLTE offers use parametrized codecs (EVS/AMR) whose fmtp params
      // are part of the codec identity — reusing rtpmap without the matching
      // fmtp is an incomplete negotiation from the UAC's perspective.
      const fmtpMatch = new RegExp(`a=fmtp:${payloadType} ([^\\r\\n]+)`).exec(parsed.body);
      const fmtpLine = fmtpMatch ? `a=fmtp:${payloadType} ${fmtpMatch[1]}\r\n` : '';
      // RFC 3312 preconditions — see file header point 2.
      const hasPrecondition = /a=des:qos mandatory local/.test(parsed.body);

      const rtpSock = dgram.createSocket('udp4');
      const localRtpPort = 16000 + Math.floor(Math.random() * 4000);
      rtpSock.bind(localRtpPort);
      rtpSock.on('message', (rtpMsg, rtpRinfo) => {
        rtpSock.send(rtpMsg, rtpRinfo.port, rtpRinfo.address); // echo straight back to live source
      });

      const toTag = randHex(6);
      const myIp = this.pcscfIp;
      const localPort = this.localPort;
      const identity = this.identity;

      const sdpBody = (mediaDirection: string, extraLines = ''): string =>
        `v=0\r\no=- ${Date.now()} 1 IN IP4 ${myIp}\r\ns=echo-test\r\n` +
        `c=IN IP4 ${myIp}\r\nt=0 0\r\n` +
        `m=audio ${localRtpPort} RTP/AVP ${payloadType}\r\n` +
        `a=rtpmap:${payloadType} ${codecLine}\r\n` +
        fmtpLine +
        `a=rtcp:${localRtpPort + 1}\r\na=ptime:20\r\n` +
        extraLines +
        `a=${mediaDirection}\r\n`;

      const call: ActiveCall = {
        rtpSock, toTag, finalSent: false, sdpBody,
        sendFinal200: () => {
          if (call.finalSent) return;
          call.finalSent = true;
          const sdpAnswer = sdpBody('sendrecv', 'a=curr:qos local sendrecv\r\na=curr:qos remote sendrecv\r\n');
          const okMsg =
            `SIP/2.0 200 OK\r\nVia: ${via}\r\nFrom: ${from}\r\nTo: ${to};tag=${toTag}\r\nCall-ID: ${cid}\r\nCSeq: ${cseqHdr}\r\n` +
            `Contact: <sip:${identity.imsi}@${myIp}:${localPort};transport=udp>\r\n` +
            `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdpAnswer)}\r\n\r\n${sdpAnswer}`;
          reply(okMsg);
          this.logger.info({ msisdn: identity.msisdn, localRtpPort }, 'ims-test-number: answered call');
        },
      };
      this.activeCalls.set(cid, call);

      if (hasPrecondition) {
        const sdpAnswer = sdpBody('inactive',
          'a=curr:qos local sendrecv\r\na=des:qos mandatory local sendrecv\r\n' +
          'a=curr:qos remote none\r\na=des:qos mandatory remote sendrecv\r\n');
        const progressMsg =
          `SIP/2.0 183 Session Progress\r\nVia: ${via}\r\nFrom: ${from}\r\nTo: ${to};tag=${toTag}\r\nCall-ID: ${cid}\r\nCSeq: ${cseqHdr}\r\n` +
          `Contact: <sip:${identity.imsi}@${myIp}:${localPort};transport=udp>\r\n` +
          `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdpAnswer)}\r\n\r\n${sdpAnswer}`;
        reply(progressMsg);
        // Fallback if the caller never sends UPDATE — don't hang the call forever.
        setTimeout(() => call.sendFinal200(), 8000);
      } else {
        setTimeout(() => call.sendFinal200(), 500);
      }
    } else if (method === 'UPDATE') {
      const call = this.activeCalls.get(cid);
      if (call) {
        const sdpAnswer = call.sdpBody('sendrecv', 'a=curr:qos local sendrecv\r\na=curr:qos remote sendrecv\r\n');
        reply(
          `SIP/2.0 200 OK\r\nVia: ${via}\r\nFrom: ${from}\r\nTo: ${to}\r\nCall-ID: ${cid}\r\nCSeq: ${cseqHdr}\r\n` +
          `Contact: <sip:${this.identity.imsi}@${this.pcscfIp}:${this.localPort};transport=udp>\r\n` +
          `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdpAnswer)}\r\n\r\n${sdpAnswer}`
        );
        call.sendFinal200();
      }
    } else if (method === 'BYE') {
      const call = this.activeCalls.get(cid);
      if (call) {
        try { call.rtpSock.close(); } catch { /* already closed */ }
        this.activeCalls.delete(cid);
      }
      if (this.outboundCall && cid === this.outboundCall.callId) {
        try { this.outboundCall.rtpSock.close(); } catch { /* already closed */ }
        this.outboundCall.state = 'ended';
        this.outboundCall = null;
      }
      reply(`SIP/2.0 200 OK\r\nVia: ${via}\r\nFrom: ${from}\r\nTo: ${to}\r\nCall-ID: ${cid}\r\nCSeq: ${cseqHdr}\r\nContent-Length: 0\r\n\r\n`);
    }
    // ACK: no-op
  }

  // Outbound SDP builder — mirrors sdpBody() used for the answering side, but as
  // the party WHO offered mandatory-local preconditions this time (see below).
  private outboundSdpBody(call: OutboundCall, mediaDirection: string, extraLines = ''): string {
    return (
      `v=0\r\no=- ${Date.now()} 1 IN IP4 ${this.pcscfIp}\r\ns=echo-test\r\n` +
      `c=IN IP4 ${this.pcscfIp}\r\nt=0 0\r\n` +
      `m=audio ${call.localRtpPort} RTP/AVP ${call.payloadType}\r\n` +
      `a=rtpmap:${call.payloadType} ${call.codecLine}\r\n` +
      call.fmtpLine +
      `a=rtcp:${call.localRtpPort + 1}\r\na=ptime:20\r\n` +
      extraLines +
      `a=${mediaDirection}\r\n`
    );
  }

  // Once we have ANY dialog-establishing response (early or final) and haven't yet
  // confirmed our own side, send an in-dialog UPDATE moving to sendrecv. We
  // declared our own precondition as "mandatory local" (mirroring what a real
  // iPhone declares as offerer — see memory: ims-real-iphone-call-flow) but the
  // callee's side as merely "optional remote", so we don't need to wait for
  // anything from the callee before doing this — matches the offerer's own half
  // of the precondition contract, not the answerer's.
  // RFC 3261 12.1.2 — the UAC's route set for every subsequent in-dialog request
  // is the Record-Route value(s) from the dialog-establishing response, verbatim.
  private routeHeader(call: OutboundCall): string {
    return call.routeSet ? `Route: ${call.routeSet}\r\n` : '';
  }

  private sendPreconditionUpdate(call: OutboundCall, toHeader: string): void {
    if (call.updateSent) return;
    call.updateSent = true;
    const branch = `z9hG4bK${randHex(8)}`;
    const cseqNum = this.cseq++;
    const sdpBody = this.outboundSdpBody(call, 'sendrecv', 'a=curr:qos local sendrecv\r\na=curr:qos remote none\r\n');
    const requestUri = call.remoteTarget ?? `tel:${call.targetNumber};phone-context=${this.imsDomain}`;
    const update =
      `UPDATE ${requestUri} SIP/2.0\r\n` +
      `Via: SIP/2.0/UDP ${this.pcscfIp}:${this.localPort};branch=${branch};rport\r\n` +
      `Max-Forwards: 70\r\n` +
      `To: ${toHeader}\r\n` +
      `From: <sip:${this.identity.imsi}@${this.imsDomain}>;tag=${call.fromTag}\r\n` +
      `Call-ID: ${call.callId}\r\n` +
      `CSeq: ${cseqNum} UPDATE\r\n` +
      this.routeHeader(call) +
      `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdpBody)}\r\n\r\n${sdpBody}`;
    this.send(update);
    this.logger.info({ msisdn: this.identity.msisdn, target: call.targetNumber, requestUri }, 'ims-test-number: sent precondition-confirming UPDATE');
  }

  private handleOutboundResponse(parsed: ParsedSip): void {
    const call = this.outboundCall;
    if (!call) return;
    const cseqMatch = /(\d+)\s+(\w+)/.exec(parsed.headers['cseq'] ?? '');
    const cseqMethod = cseqMatch?.[2];
    const toHeader = parsed.headers['to'] ?? '';
    const toTagMatch = /tag=([^;]+)/.exec(toHeader);
    const contactUri = parseContactUri(parsed.headers['contact']);
    if (contactUri) call.remoteTarget = contactUri;
    if (parsed.headers['record-route'] && !call.routeSet) call.routeSet = parsed.headers['record-route'];

    if (cseqMethod === 'UPDATE') {
      // 200 OK to our own precondition UPDATE — nothing further to do, media is
      // already presumed active on our side.
      return;
    }

    // Everything below is in response to the original INVITE.
    if (/^SIP\/2\.0 (180|183)/.test(parsed.statusLine)) {
      call.state = 'ringing';
      if (toTagMatch) {
        call.toTag = toTagMatch[1];
        this.sendPreconditionUpdate(call, toHeader);
      }
    } else if (/^SIP\/2\.0 200/.test(parsed.statusLine)) {
      if (toTagMatch) call.toTag = toTagMatch[1];
      call.state = 'answered';
      // If no provisional response ever arrived (straight to 200), we still need
      // to confirm our own precondition before real media can flow.
      if (!call.updateSent) this.sendPreconditionUpdate(call, toHeader);
      const branch = `z9hG4bK${randHex(8)}`;
      // RFC 3261: ACK's Request-URI must be the peer's own Contact (remote target),
      // not the original dialed address — confirmed live this matters: using the
      // static tel: address here caused the phone to never receive our ACK, so it
      // kept retransmitting its 200 OK, and the call never became a clean dialog.
      const requestUri = call.remoteTarget ?? `tel:${call.targetNumber};phone-context=${this.imsDomain}`;
      const ack =
        `ACK ${requestUri} SIP/2.0\r\n` +
        `Via: SIP/2.0/UDP ${this.pcscfIp}:${this.localPort};branch=${branch};rport\r\n` +
        `Max-Forwards: 70\r\n` +
        `To: ${toHeader}\r\n` +
        `From: <sip:${this.identity.imsi}@${this.imsDomain}>;tag=${call.fromTag}\r\n` +
        `Call-ID: ${call.callId}\r\n` +
        `CSeq: ${call.cseq} ACK\r\n` +
        this.routeHeader(call) +
        `Content-Length: 0\r\n\r\n`;
      this.send(ack);
      this.logger.info({ msisdn: this.identity.msisdn, target: call.targetNumber, requestUri }, 'ims-test-number: outbound call answered');
    } else if (/^SIP\/2\.0 [4-6]\d\d/.test(parsed.statusLine)) {
      call.state = 'failed';
      call.failReason = parsed.statusLine;
      try { call.rtpSock.close(); } catch { /* already closed */ }
      this.outboundCall = null;
    }
  }

  async placeCall(targetNumber: string): Promise<void> {
    if (this.outboundCall) throw new Error('This test number already has an active outbound call — hang up first.');
    const rtpSock = dgram.createSocket('udp4');
    const localRtpPort = 16000 + Math.floor(Math.random() * 4000);
    rtpSock.bind(localRtpPort);
    rtpSock.on('message', (rtpMsg, rtpRinfo) => {
      rtpSock.send(rtpMsg, rtpRinfo.port, rtpRinfo.address); // echo straight back to live source
    });

    const callId = `ims-test-call-${randHex(8)}`;
    const fromTag = randHex(6);
    const cseqNum = this.cseq++;
    // Reuse the exact codec (EVS/16000, payload 116) + fmtp a real iPhone has been
    // directly confirmed to accept, both as its own offer and inside a working
    // call — see memory: ims-real-iphone-call-flow. Safer than guessing at a
    // codec/fmtp combination that's never actually been proven against this phone.
    const payloadType = '116';
    const codecLine = 'EVS/16000';
    const fmtpLine = 'a=fmtp:116 br=5.9-24.4; bw=nb-swb; max-red=220; mode-set=0,1,2\r\n';
    // RFC 3312 preconditions, mirroring exactly what a real iPhone declares as
    // OFFERER (see memory: ims-real-iphone-call-flow) — "mandatory local" (we
    // require our own confirmation before real media) but only "optional remote"
    // (we don't require the callee's own confirmation). A bare sendrecv offer with
    // no precondition dance was tried first and let the call connect, but the
    // phone's own "End Call" never sent a real BYE afterwards — this offer-side
    // precondition dance is the fix, matching the answering side's own requirement.
    const sdpOffer =
      `v=0\r\no=- ${Date.now()} 1 IN IP4 ${this.pcscfIp}\r\ns=echo-test\r\n` +
      `c=IN IP4 ${this.pcscfIp}\r\nt=0 0\r\n` +
      `m=audio ${localRtpPort} RTP/AVP ${payloadType}\r\n` +
      `a=rtpmap:${payloadType} ${codecLine}\r\n` +
      fmtpLine +
      `a=rtcp:${localRtpPort + 1}\r\na=ptime:20\r\n` +
      `a=curr:qos local none\r\na=des:qos mandatory local sendrecv\r\n` +
      `a=curr:qos remote none\r\na=des:qos optional remote sendrecv\r\n` +
      `a=inactive\r\n`;

    const branch = `z9hG4bK${randHex(8)}`;
    const invite =
      `INVITE tel:${targetNumber};phone-context=${this.imsDomain} SIP/2.0\r\n` +
      `Via: SIP/2.0/UDP ${this.pcscfIp}:${this.localPort};branch=${branch};rport\r\n` +
      `Max-Forwards: 70\r\n` +
      `To: <tel:${targetNumber};phone-context=${this.imsDomain}>\r\n` +
      `From: <sip:${this.identity.imsi}@${this.imsDomain}>;tag=${fromTag}\r\n` +
      `Call-ID: ${callId}\r\n` +
      `CSeq: ${cseqNum} INVITE\r\n` +
      `Contact: <sip:${this.identity.imsi}@${this.pcscfIp}:${this.localPort};transport=udp>\r\n` +
      `Allow: ACK,BYE,CANCEL,INVITE,UPDATE\r\n` +
      // Deliberately NOT advertising `Supported: 100rel` — doing so tells the callee
      // it may send *reliable* provisional responses expecting a PRACK back, which
      // isn't implemented here. Confirmed live: with 100rel advertised, the phone
      // retransmitted 183 waiting for a PRACK that never came and gave up without
      // ever ringing. The answering side never advertises it either — same reasoning.
      `Content-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdpOffer)}\r\n\r\n${sdpOffer}`;

    this.outboundCall = {
      callId, targetNumber, rtpSock, localRtpPort, payloadType, codecLine, fmtpLine,
      state: 'dialing', fromTag, cseq: cseqNum, inviteBranch: branch, inviteCseq: cseqNum,
      updateSent: false,
    };
    this.send(invite);
    this.logger.info({ msisdn: this.identity.msisdn, targetNumber }, 'ims-test-number: placing outbound call');
  }

  async hangup(): Promise<void> {
    const call = this.outboundCall;
    if (!call) throw new Error('No active outbound call to hang up');
    if (call.state === 'answered' && call.toTag) {
      const branch = `z9hG4bK${randHex(8)}`;
      const cseqNum = this.cseq++;
      const requestUri = call.remoteTarget ?? `tel:${call.targetNumber};phone-context=${this.imsDomain}`;
      const bye =
        `BYE ${requestUri} SIP/2.0\r\n` +
        `Via: SIP/2.0/UDP ${this.pcscfIp}:${this.localPort};branch=${branch};rport\r\n` +
        `Max-Forwards: 70\r\n` +
        `To: <tel:${call.targetNumber};phone-context=${this.imsDomain}>;tag=${call.toTag}\r\n` +
        `From: <sip:${this.identity.imsi}@${this.imsDomain}>;tag=${call.fromTag}\r\n` +
        `Call-ID: ${call.callId}\r\n` +
        `CSeq: ${cseqNum} BYE\r\n` +
        this.routeHeader(call) +
        `Content-Length: 0\r\n\r\n`;
      this.send(bye);
    } else {
      // Not answered yet — CANCEL the pending INVITE (same branch/CSeq per RFC 3261).
      const cancel =
        `CANCEL tel:${call.targetNumber};phone-context=${this.imsDomain} SIP/2.0\r\n` +
        `Via: SIP/2.0/UDP ${this.pcscfIp}:${this.localPort};branch=${call.inviteBranch};rport\r\n` +
        `Max-Forwards: 70\r\n` +
        `To: <tel:${call.targetNumber};phone-context=${this.imsDomain}>\r\n` +
        `From: <sip:${this.identity.imsi}@${this.imsDomain}>;tag=${call.fromTag}\r\n` +
        `Call-ID: ${call.callId}\r\n` +
        `CSeq: ${call.inviteCseq} CANCEL\r\n` +
        `Content-Length: 0\r\n\r\n`;
      this.send(cancel);
    }
    try { call.rtpSock.close(); } catch { /* already closed */ }
    this.outboundCall = null;
  }

  async start(): Promise<void> {
    this.sock.on('message', (msg, rinfo) => {
      this.handleIncoming(msg.toString('utf-8'), (data) => this.send(data, rinfo.port, rinfo.address), 'UDP');
    });
    // Both sockets need an 'error' listener registered BEFORE bind/listen is
    // called — dgram/net emit 'error' (not a bind/listen callback error) on
    // failure (e.g. EADDRINUSE), and an EventEmitter 'error' with no listener
    // throws uncaught, which would crash the entire backend process rather
    // than just fail this one instance's start().
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.sock.once('error', onError);
      this.sock.bind(this.localPort, () => { this.sock.removeListener('error', onError); resolve(); });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.tcpServer.once('error', onError);
      this.tcpServer.listen(this.localPort, () => { this.tcpServer.removeListener('error', onError); resolve(); });
    });
    // Post-start: a UDP socket can still emit 'error' later (e.g. ICMP
    // port-unreachable from a bad peer) — log-and-continue instead of
    // leaving it unhandled (which would crash the backend process).
    this.sock.on('error', (err) => this.logger.warn({ err: String(err), msisdn: this.identity.msisdn }, 'ims-test-number: socket error'));
    this.tcpServer.on('error', (err) => this.logger.warn({ err: String(err), msisdn: this.identity.msisdn }, 'ims-test-number: tcp server error'));

    const final = await this.registerOnce();
    if (!/^SIP\/2\.0 200/.test(final.statusLine)) {
      throw new Error(`REGISTER failed: ${final.statusLine}`);
    }

    this.refreshTimer = setInterval(() => {
      this.registerOnce().catch((err) => this.logger.warn({ err: String(err), msisdn: this.identity.msisdn }, 'ims-test-number: re-register failed'));
    }, REGISTER_REFRESH_MS);
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const call of this.activeCalls.values()) {
      try { call.rtpSock.close(); } catch { /* already closed */ }
    }
    this.activeCalls.clear();
    if (this.outboundCall) {
      try { this.outboundCall.rtpSock.close(); } catch { /* already closed */ }
      this.outboundCall = null;
    }
    await new Promise<void>((resolve) => this.sock.close(() => resolve()));
    await new Promise<void>((resolve) => this.tcpServer.close(() => resolve()));
  }
}

export class ImsTestNumberManager {
  private readonly instances = new Map<string, ImsTestNumberInstance>(); // keyed by msisdn
  private readonly usedPorts = new Set<number>();

  constructor(private readonly logger: pino.Logger) {}

  private allocatePort(): number {
    for (let p = BASE_SIP_PORT; p < BASE_SIP_PORT + MAX_INSTANCES; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    throw new Error(`No free ports for a new test number (max ${MAX_INSTANCES} concurrent reached)`);
  }

  async create(msisdnInput?: string): Promise<ImsTestNumberInfo> {
    const state = readImsState();
    if (!state) throw new Error('IMS is not configured — configure it on the IMS page first.');
    const { mcc, mnc, pcscfIp, scscfPort = 6060 } = state.config;
    const pcscfPort = state.config.pcscfPort ?? 5060;

    let msisdn = msisdnInput?.trim();
    if (msisdn) {
      if (!/^\d{6,15}$/.test(msisdn)) throw new Error('MSISDN must be 6-15 digits');
      if (this.instances.has(msisdn)) throw new Error(`Test number ${msisdn} is already active`);
      // ims_subscriber.msisdn is a UNIQUE column in PyHSS — without this check, a
      // user-typed MSISDN that collides with a REAL subscriber (or a leftover test
      // number from a prior run) would surface as an opaque DB constraint error
      // instead of a clear one. Checked here, not left to bubble up from PyHSS.
      const alreadyExists = await pyhssApiCall('GET', `/ims_subscriber/ims_subscriber_msisdn/${msisdn}`)
        .then(() => true)
        .catch(() => false);
      if (alreadyExists) throw new Error(`MSISDN ${msisdn} is already in use by another subscriber — pick a different number.`);
    } else {
      do {
        msisdn = `9${crypto.randomInt(0, 10000000000).toString().padStart(10, '0')}`;
      } while (this.instances.has(msisdn));
    }

    const identity: TestIdentity = {
      imsi: randomBotImsi(mcc, mnc),
      msisdn,
      ki: crypto.randomBytes(16).toString('hex').toUpperCase(),
      opc: crypto.randomBytes(16).toString('hex').toUpperCase(),
    };

    await provisionPyhssTestSubscriber(identity, state.imsDomain, scscfPort);

    const localPort = this.allocatePort();
    const instance = new ImsTestNumberInstance(identity, state.imsDomain, pcscfIp, pcscfPort, localPort, this.logger);
    try {
      await instance.start();
    } catch (err) {
      this.usedPorts.delete(localPort);
      await deprovisionPyhssTestSubscriber(identity.imsi).catch(() => { /* best effort */ });
      throw err;
    }
    this.instances.set(msisdn, instance);
    return instance.info();
  }

  list(): ImsTestNumberInfo[] {
    return [...this.instances.values()].map((i) => i.info());
  }

  // `instances` is in-memory only, so a backend restart forgets every
  // previously created test number even though its PyHSS rows (and its
  // "901"-marked IMSI) survive — without this, the UI's list silently goes
  // empty after any restart even though the orphaned PyHSS subscriber lingers
  // forever. Called once at startup: finds those leftovers via the "901" MSIN
  // marker (never matches VoLTE/VoWiFi E2E test subscribers, which use "900")
  // and re-registers each as a live SIP UAS instance again. Best-effort and
  // never throws — a fresh/IMS-not-yet-configured install has nothing to do
  // here, and any single restore failure just deprovisions that one leftover
  // rather than blocking the rest or backend startup itself.
  async reconcile(): Promise<void> {
    const state = readImsState();
    if (!state) return;
    const { mcc, mnc, pcscfIp, scscfPort = 6060 } = state.config;
    const pcscfPort = state.config.pcscfPort ?? 5060;
    const plmnPrefix = mcc + mnc.padStart(3, '0') + '901';

    let list: any[];
    try {
      list = await pyhssApiCall('GET', '/subscriber/list');
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'ims-test-number: reconcile skipped — PyHSS unreachable');
      return;
    }
    const leftovers = (Array.isArray(list) ? list : []).filter(
      (s) => typeof s?.imsi === 'string' && s.imsi.startsWith(plmnPrefix),
    );

    for (const sub of leftovers) {
      try {
        const auc = await pyhssApiCall('GET', `/auc/imsi/${sub.imsi}`);
        const identity: TestIdentity = { imsi: sub.imsi, msisdn: String(sub.msisdn), ki: auc.ki, opc: auc.opc };
        const localPort = this.allocatePort();
        const instance = new ImsTestNumberInstance(identity, state.imsDomain, pcscfIp, pcscfPort, localPort, this.logger);
        await instance.start();
        this.instances.set(identity.msisdn, instance);
        this.logger.info({ msisdn: identity.msisdn, imsi: identity.imsi }, 'ims-test-number: restored after restart');
      } catch (err) {
        this.logger.warn({ err: String(err), imsi: sub.imsi }, 'ims-test-number: failed to restore leftover test number, deprovisioning it');
        await deprovisionPyhssTestSubscriber(sub.imsi).catch(() => { /* best effort */ });
      }
    }
  }

  async stop(msisdn: string): Promise<void> {
    const instance = this.instances.get(msisdn);
    if (!instance) throw new Error(`No active test number ${msisdn}`);
    const { localPort, imsi } = instance.info();
    await instance.stop();
    this.usedPorts.delete(localPort);
    this.instances.delete(msisdn);
    await deprovisionPyhssTestSubscriber(imsi).catch(() => { /* best effort */ });
  }

  private getInstance(msisdn: string): ImsTestNumberInstance {
    const instance = this.instances.get(msisdn);
    if (!instance) throw new Error(`No active test number ${msisdn}`);
    return instance;
  }

  async placeCall(msisdn: string, targetNumber: string): Promise<void> {
    if (!/^\d{3,15}$/.test(targetNumber.trim())) throw new Error('Target number must be 3-15 digits');
    await this.getInstance(msisdn).placeCall(targetNumber.trim());
  }

  async hangup(msisdn: string): Promise<void> {
    await this.getInstance(msisdn).hangup();
  }

  async stopAll(): Promise<void> {
    for (const msisdn of [...this.instances.keys()]) {
      await this.stop(msisdn).catch(() => { /* best effort during shutdown */ });
    }
  }
}

export function createImsTestNumberRouter(manager: ImsTestNumberManager, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, testNumbers: manager.list() });
  });

  router.post('/', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const info = await manager.create(req.body?.msisdn);
      await auditLogger.log({
        action: 'ims_test_number_create', user,
        details: `msisdn=${info.msisdn} imsi=${info.imsi}`, success: true,
      });
      res.json({ success: true, testNumber: info });
    } catch (err) {
      await auditLogger.log({ action: 'ims_test_number_create', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: (err as Error).message ?? String(err) });
    }
  });

  router.delete('/:msisdn', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await manager.stop(req.params.msisdn);
      await auditLogger.log({
        action: 'ims_test_number_stop', user,
        details: `msisdn=${req.params.msisdn}`, success: true,
      });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_test_number_stop', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: (err as Error).message ?? String(err) });
    }
  });

  router.post('/:msisdn/call', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const target = req.body?.targetNumber;
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ success: false, error: 'targetNumber is required' });
    }
    try {
      await manager.placeCall(req.params.msisdn, target);
      await auditLogger.log({
        action: 'ims_test_number_call', user,
        details: `msisdn=${req.params.msisdn} target=${target}`, success: true,
      });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_test_number_call', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: (err as Error).message ?? String(err) });
    }
  });

  router.post('/:msisdn/hangup', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await manager.hangup(req.params.msisdn);
      await auditLogger.log({
        action: 'ims_test_number_hangup', user,
        details: `msisdn=${req.params.msisdn}`, success: true,
      });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_test_number_hangup', user, details: String(err), success: false });
      res.status(400).json({ success: false, error: (err as Error).message ?? String(err) });
    }
  });

  return router;
}
