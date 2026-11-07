import {
  parseUndersizedGtpuSockets,
  findOverridingSysctlConfLines,
  gtpuSysctlContent,
  GTPU_SOCKET_BUFFER_BYTES,
} from '../host-tuning';

// Real `ss -uanpm` output from the affected host, 2026-11-01. Note the shape the
// parser has to cope with: the address is on the header line and the buffer sizes
// are on the NEXT, indented line.
const SS_BEFORE = `UNCONN 0      0           127.0.0.4:2152       0.0.0.0:*    users:(("open5gs-smfd",pid=505254,fd=15))
\t skmem:(r0,rb212992,t0,tb212992,f4096,w0,o0,bl0,d0)
UNCONN 0      0          10.0.1.156:2152       0.0.0.0:*    users:(("open5gs-upfd",pid=967019,fd=9))
\t skmem:(r0,rb212992,t0,tb212992,f4096,w0,o0,bl0,d1363)
UNCONN 0      0          10.0.1.176:2152       0.0.0.0:*    users:(("open5gs-sgwud",pid=1042,fd=7))
\t skmem:(r0,rb212992,t0,tb212992,f4096,w0,o0,bl0,d49175)
UNCONN 0      0           127.0.0.1:53          0.0.0.0:*    users:(("named",pid=999,fd=1))
\t skmem:(r0,rb212992,t0,tb212992,f0,w0,o0,bl0,d0)`;

const SS_AFTER = `UNCONN 0      0          10.0.1.156:2152       0.0.0.0:*    users:(("open5gs-upfd",pid=2600621,fd=9))
\t skmem:(r0,rb4194304,t0,tb4194304,f4096,w0,o0,bl0,d0)
UNCONN 0      0          10.0.1.176:2152       0.0.0.0:*    users:(("open5gs-sgwud",pid=2600687,fd=7))
\t skmem:(r0,rb4194304,t0,tb4194304,f4096,w0,o0,bl0,d0)`;

describe('parseUndersizedGtpuSockets', () => {
  test('finds every GTP-U socket still on the stock 212992 buffers', () => {
    const found = parseUndersizedGtpuSockets(SS_BEFORE, GTPU_SOCKET_BUFFER_BYTES);
    expect(found.map(f => f.process)).toEqual(['open5gs-smfd', 'open5gs-upfd', 'open5gs-sgwud']);
    expect(found[1]).toMatchObject({ local: '10.0.1.156:2152', rmem: 212992, wmem: 212992 });
  });

  test('ignores non-GTP-U sockets even when they are undersized', () => {
    // The :53 named socket above is also at 212992 but is none of our business.
    expect(parseUndersizedGtpuSockets(SS_BEFORE, GTPU_SOCKET_BUFFER_BYTES)
      .some(f => f.local.endsWith(':53'))).toBe(false);
  });

  test('reports nothing once the NFs have been restarted — this is what clears the warning', () => {
    expect(parseUndersizedGtpuSockets(SS_AFTER, GTPU_SOCKET_BUFFER_BYTES)).toEqual([]);
  });

  test('flags a socket undersized in only ONE direction', () => {
    const mixed = `UNCONN 0 0 10.0.1.156:2152 0.0.0.0:* users:(("open5gs-upfd",pid=1,fd=9))
\t skmem:(r0,rb4194304,t0,tb212992,f0,w0,o0,bl0,d0)`;
    const found = parseUndersizedGtpuSockets(mixed, GTPU_SOCKET_BUFFER_BYTES);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rmem: 4194304, wmem: 212992 });
  });

  test('handles skmem on the same line as the header (ss version/width variance)', () => {
    const oneLine = 'UNCONN 0 0 10.0.1.156:2152 0.0.0.0:* users:(("open5gs-upfd",pid=1,fd=9)) skmem:(r0,rb212992,t0,tb212992,f0,w0,o0,bl0,d0)';
    expect(parseUndersizedGtpuSockets(oneLine, GTPU_SOCKET_BUFFER_BYTES)).toHaveLength(1);
  });

  test('a socket with no skmem line is skipped rather than counted as zero-sized', () => {
    const noSkmem = 'UNCONN 0 0 10.0.1.156:2152 0.0.0.0:* users:(("open5gs-upfd",pid=1,fd=9))';
    expect(parseUndersizedGtpuSockets(noSkmem, GTPU_SOCKET_BUFFER_BYTES)).toEqual([]);
  });

  test('tolerates empty/garbage input', () => {
    expect(parseUndersizedGtpuSockets('', GTPU_SOCKET_BUFFER_BYTES)).toEqual([]);
    expect(parseUndersizedGtpuSockets(undefined as any, GTPU_SOCKET_BUFFER_BYTES)).toEqual([]);
  });
});

describe('findOverridingSysctlConfLines', () => {
  // `sysctl --system` applies /etc/sysctl.conf LAST, after every drop-in, so a
  // line there silently beats our file on the next boot.
  test('flags a net.core buffer line in /etc/sysctl.conf', () => {
    expect(findOverridingSysctlConfLines('net.ipv4.ip_forward=1\nnet.core.rmem_max = 212992\n'))
      .toEqual(['net.core.rmem_max = 212992']);
  });

  test('ignores commented-out lines', () => {
    expect(findOverridingSysctlConfLines('# net.core.rmem_max = 212992\n')).toEqual([]);
  });

  test('ignores unrelated settings', () => {
    expect(findOverridingSysctlConfLines('net.ipv4.ip_forward=1\nnet.core.somaxconn=1024\n')).toEqual([]);
  });

  test('catches all four keys we own', () => {
    const conf = ['net.core.rmem_default=1', 'net.core.wmem_default=1',
                  'net.core.rmem_max=1', 'net.core.wmem_max=1'].join('\n');
    expect(findOverridingSysctlConfLines(conf)).toHaveLength(4);
  });
});

describe('gtpuSysctlContent', () => {
  test('emits all five settings and documents why a restart is needed', () => {
    const c = gtpuSysctlContent();
    for (const k of ['rmem_default', 'wmem_default', 'rmem_max', 'wmem_max', 'netdev_max_backlog']) {
      expect(c).toContain(`net.core.${k}`);
    }
    expect(c).toContain('4194304');
    expect(c).toContain('SOCKET CREATION');
  });
});

// ── UE TCP MSS clamp ────────────────────────────────────────────────────────

import { mssForMtu, mssRuleArgs, findStaleMssRules, MSS_RULE_COMMENT } from '../host-tuning';

// Real `iptables -t mangle -S FORWARD` output shape, captured from this host
// 2026-11-06 by adding and removing a probe rule. Note what iptables itself
// normalises the rule to: it inserts `-m tcp` ahead of --tcp-flags, and prints
// the comment unquoted. A parser written against the arguments we PASS, rather
// than against what iptables prints back, silently matches nothing.
const MANGLE_STALE = `-P FORWARD ACCEPT
-A FORWARD -i ogstun -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment ${MSS_RULE_COMMENT} -j TCPMSS --set-mss 1360
-A FORWARD -o ogstun -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment ${MSS_RULE_COMMENT} -j TCPMSS --set-mss 1360`;

const MANGLE_CURRENT = `-P FORWARD ACCEPT
-A FORWARD -i ogstun -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment ${MSS_RULE_COMMENT} -j TCPMSS --set-mss 1340
-A FORWARD -o ogstun -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment ${MSS_RULE_COMMENT} -j TCPMSS --set-mss 1340`;

describe('mssForMtu', () => {
  test('subtracts only the inner IP and TCP headers', () => {
    // NOT the GTP/ESP overhead too — the UE MTU is already below the path MTU,
    // so subtracting encapsulation again would clamp twice and needlessly
    // shrink every segment.
    expect(mssForMtu(1380, 4)).toBe(1340);
    expect(mssForMtu(1380, 6)).toBe(1320);
    expect(mssForMtu(1400)).toBe(1360); // v4 is the default
  });
});

describe('findStaleMssRules', () => {
  test('returns a delete for a rule carrying the OLD mss after an MTU change', () => {
    // This is the whole reason the function exists. The "-C then -A" idiom used
    // for every other rule in auto-config.ts cannot catch this: -C reports the
    // 1340 rule absent, -A appends it, and the 1360 rule stays AHEAD of it in
    // the chain where it still wins. Without this, lowering the MTU appears to
    // work and changes nothing on the wire.
    const stale = findStaleMssRules(MANGLE_STALE, 'ogstun', 1340);
    expect(stale).toHaveLength(2);
    for (const args of stale) {
      expect(args).toContain('-D');
      expect(args).toContain('--set-mss');
      expect(args[args.length - 1]).toBe('1360'); // deletes the OLD value, not the new one
    }
    // One per direction, so neither half is left shadowing.
    expect(stale.some(a => a.includes('-i'))).toBe(true);
    expect(stale.some(a => a.includes('-o'))).toBe(true);
  });

  test('leaves an already-correct rule alone', () => {
    expect(findStaleMssRules(MANGLE_CURRENT, 'ogstun', 1340)).toEqual([]);
  });

  test("never touches an operator's own TCPMSS rule", () => {
    // Matching on our comment is what makes this safe. A deployment may well
    // have a hand-written clamp for an unrelated interface or purpose, and
    // deleting it because it happens to be a TCPMSS rule would be a real
    // regression with no way for the operator to see it coming.
    const handWritten = `-P FORWARD ACCEPT
-A FORWARD -i ogstun -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
-A FORWARD -o ens18 -p tcp -m tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1200`;
    expect(findStaleMssRules(handWritten, 'ogstun', 1340)).toEqual([]);
  });

  test('ignores our rules on a different device', () => {
    expect(findStaleMssRules(MANGLE_STALE, 'ogstun2', 1340)).toEqual([]);
  });

  test('does not confuse ogstun with ogstun2 by prefix', () => {
    // "-i ogstun2" contains "ogstun" as a prefix, so a naive includes() check
    // would delete ogstun2's rule while reconciling ogstun.
    const onTwo = `-A FORWARD -i ogstun2 -p tcp -m tcp --tcp-flags SYN,RST SYN -m comment --comment ${MSS_RULE_COMMENT} -j TCPMSS --set-mss 1360`;
    expect(findStaleMssRules(onTwo, 'ogstun', 1340)).toEqual([]);
    expect(findStaleMssRules(onTwo, 'ogstun2', 1340)).toHaveLength(1);
  });

  test('tolerates empty or missing input', () => {
    expect(findStaleMssRules('', 'ogstun', 1340)).toEqual([]);
    expect(findStaleMssRules(undefined as unknown as string, 'ogstun', 1340)).toEqual([]);
  });
});

describe('mssRuleArgs', () => {
  test('clamps both directions, because each fixes a different half', () => {
    // -i rewrites the UE's own SYN (so the server sends small enough segments);
    // -o rewrites the server's SYN-ACK (so the UE does). One alone leaves half
    // of every connection at full size.
    expect(mssRuleArgs('-A', 'ogstun', 'in', 1340)).toContain('-i');
    expect(mssRuleArgs('-A', 'ogstun', 'out', 1340)).toContain('-o');
  });

  test('matches SYN only, so established traffic is untouched', () => {
    const args = mssRuleArgs('-A', 'ogstun', 'in', 1340);
    expect(args.join(' ')).toContain('--tcp-flags SYN,RST SYN');
    expect(args.join(' ')).toContain('-t mangle');
    expect(args.join(' ')).toContain(`--comment ${MSS_RULE_COMMENT}`);
  });
});
