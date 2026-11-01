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
