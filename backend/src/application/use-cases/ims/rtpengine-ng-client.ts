/**
 * rtpengine NG control protocol client — minimal, read-only.
 *
 * Wire format confirmed live against this project's own real rtpengine
 * instance (2026-09-25, adversarial review): `<cookie> <bencoded-dict>\n`
 * request, `<same-cookie> <bencoded-dict>` response — matches sipwise/
 * rtpengine's own documented protocol exactly (a real `ping`/`pong` round
 * trip was sent and confirmed, with zero log output on the rtpengine side —
 * this command class is informational, same as `statistics`/`list`, never
 * one of the mutating commands like offer/answer/delete).
 *
 * Uses the `bencode` package (not hand-rolled) — pinned to the 2.x line,
 * since 4.x is ESM-only and this backend is CommonJS. This is also what the
 * `rtpengine-client` npm package uses internally for the same protocol.
 *
 * Fresh dgram socket per request: created, sent, raced against a timeout,
 * closed in `finally` on every path (success, timeout, error) — no reused
 * persistent socket, no listener ever left dangling. UDP has no TCP-style
 * TIME_WAIT accumulation, so this is simpler and safer than pooling.
 */

import * as dgram from 'dgram';
import * as bencode from 'bencode';

const REQUEST_TIMEOUT_MS = 3000;

function randomCookie(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function rtpengineNgRequest(
  host: string, port: number, command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const cookie = randomCookie();
  const payload = Buffer.concat([Buffer.from(cookie + ' ', 'ascii'), bencode.encode(command)]);

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`rtpengine NG request timed out after ${timeoutMs}ms (${host}:${port})`)));
    }, timeoutMs);

    socket.on('error', (err) => {
      finish(() => reject(err));
    });

    socket.on('message', (msg) => {
      finish(() => {
        try {
          const space = msg.indexOf(0x20); // ASCII space — separates the echoed cookie from the bencoded dict
          if (space === -1) { reject(new Error('rtpengine NG response missing cookie separator')); return; }
          const echoedCookie = msg.subarray(0, space).toString('ascii');
          if (echoedCookie !== cookie) { reject(new Error(`rtpengine NG response cookie mismatch (sent ${cookie}, got ${echoedCookie})`)); return; }
          const decoded = bencode.decode(msg.subarray(space + 1), 'utf8') as Record<string, unknown>;
          resolve(decoded);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    socket.send(payload, port, host, (err) => {
      if (err) finish(() => reject(err));
    });
  });
}

export async function rtpengineStatistics(host: string, port = 2223): Promise<Record<string, unknown>> {
  const result = await rtpengineNgRequest(host, port, { command: 'statistics' });
  if (result.result !== 'ok') {
    throw new Error(`rtpengine statistics command returned result=${String(result.result)}`);
  }
  return result;
}
