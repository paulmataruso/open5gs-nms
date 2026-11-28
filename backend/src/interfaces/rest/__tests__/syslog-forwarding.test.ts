import * as fs from 'fs';
import * as path from 'path';
import {
  generateRsyslogConf,
  parseTarget,
  isValidSyslogHost,
  configureSyslog,
} from '../syslog-controller';
import type { SyslogTarget } from '../syslog-controller';
import { OPEN5GS_DAEMON_SERVICES } from '../../../domain/interfaces/config-repository';

/**
 * generateRsyslogConf() builds /etc/rsyslog.d/71-open5gs-nms-forward.conf on
 * the HOST. configureSyslog() writes it, runs `rsyslogd -N1`, and only then
 * restarts rsyslog.
 *
 * That validation step is why the failures worth testing here are the ones it
 * CANNOT see. `-N1` rejects a file rsyslog cannot parse, and configureSyslog()
 * unlinks the drop-in when it does. It says nothing about a file that parses
 * perfectly and forwards nothing, which is what every drift below produces:
 *
 *   - omfwd's Protocol= is the only transport selector. A wrong value still
 *     parses, so the operator picks TCP and gets UDP datagrams at a TCP-only
 *     collector with no error anywhere.
 *   - every input() must name ruleset="open5gsNmsForward". Without that
 *     binding the lines go to the default ruleset and are never forwarded;
 *     without the ruleset's trailing `stop` they are forwarded AND written
 *     into the host's own /var/log/syslog.
 *   - Template="RSYSLOG_SyslogProtocol23Format" is the RFC 5424 format.
 *     Dropping it falls back to the traditional format, which strips the Tag
 *     and hostname fields a collector filters on.
 *   - the drop-in IS this module's persisted state. parseTarget() recovers it
 *     by regex from the same `Target="..." Port="..." Protocol="..."` run, so
 *     the writer and the reader have to agree on attribute order and quoting
 *     or /status reports nothing configured and a restore cannot re-apply the
 *     AppArmor override.
 */

const UDP: SyslogTarget = { host: 'collector.example.test', port: 514, protocol: 'udp' };
const TCP: SyslogTarget = { host: '192.0.2.10', port: 6514, protocol: 'tcp' };

function inputLines(conf: string): string[] {
  return conf.split('\n').filter(l => l.startsWith('input('));
}
function actionLine(conf: string): string {
  return conf.split('\n').find(l => l.includes('type="omfwd"'))!;
}

describe('generateRsyslogConf -- omfwd action per transport', () => {
  it('emits Protocol="udp" for a udp target', () => {
    expect(actionLine(generateRsyslogConf(UDP))).toContain('Protocol="udp"');
  });

  it('emits Protocol="tcp" for a tcp target', () => {
    expect(actionLine(generateRsyslogConf(TCP))).toContain('Protocol="tcp"');
  });

  it('never uses the legacy @ / @@ selector syntax', () => {
    // Mixing legacy "@@host" lines with omfwd would double-forward or fail to
    // parse; they are two different configuration languages.
    for (const t of [UDP, TCP]) {
      expect(generateRsyslogConf(t)).not.toMatch(/^\s*[^#\n]*\*\.\*\s+@/m);
    }
  });

  it('writes Target and Port as quoted attributes, in parseTarget()\'s order', () => {
    expect(actionLine(generateRsyslogConf(TCP))).toContain(
      'Target="192.0.2.10" Port="6514" Protocol="tcp"',
    );
  });

  it('uses the RFC 5424 template so Tag and hostname survive to the collector', () => {
    expect(actionLine(generateRsyslogConf(UDP)))
      .toContain('Template="RSYSLOG_SyslogProtocol23Format"');
  });

  it('transport choice changes only the Protocol attribute', () => {
    const a = generateRsyslogConf({ ...UDP, protocol: 'udp' });
    const b = generateRsyslogConf({ ...UDP, protocol: 'tcp' });
    expect(a.replace('Protocol="udp"', 'Protocol="tcp"')).toBe(b);
  });
});

describe('generateRsyslogConf -- ruleset wiring', () => {
  const conf = generateRsyslogConf(UDP);

  it('loads imfile with a polling interval', () => {
    // Polling mode is what lets imfile pick a file back up after a rotation.
    expect(conf).toContain('module(load="imfile" PollingInterval="10")');
  });

  it('defines the ruleset once, with the action followed by stop', () => {
    expect(conf.match(/ruleset\(name="open5gsNmsForward"\)/g)).toHaveLength(1);
    const body = conf.slice(conf.indexOf('ruleset(name='));
    expect(body.indexOf('type="omfwd"')).toBeLessThan(body.indexOf('stop'));
    expect(body.indexOf('stop')).toBeLessThan(body.indexOf('}'));
  });

  it('binds every imfile input to that ruleset', () => {
    const inputs = inputLines(conf);
    expect(inputs.length).toBeGreaterThan(0);
    for (const l of inputs) expect(l).toContain('ruleset="open5gsNmsForward"');
  });

  it('declares the module and ruleset before the first input', () => {
    expect(conf.indexOf('module(load="imfile"')).toBeLessThan(conf.indexOf('ruleset(name='));
    expect(conf.indexOf('ruleset(name=')).toBeLessThan(conf.indexOf('input(type='));
  });

  it('has balanced braces and a trailing newline', () => {
    expect((conf.match(/\{/g) ?? []).length).toBe((conf.match(/\}/g) ?? []).length);
    expect(conf.endsWith('\n')).toBe(true);
  });
});

describe('generateRsyslogConf -- forwarded log files and tags', () => {
  const conf = generateRsyslogConf(UDP);
  const inputs = inputLines(conf);

  it('forwards one log per Open5GS NF daemon, derived from the shared list', () => {
    // Taken from OPEN5GS_DAEMON_SERVICES rather than written out again: this
    // list was a 16-entry literal here and silently omitted sepp1.log.
    for (const nf of OPEN5GS_DAEMON_SERVICES) {
      expect(conf).toContain(`File="/var/log/open5gs/${nf}.log" Tag="open5gs-${nf}:"`);
    }
  });

  it('forwards the FRR log with an unprefixed tag', () => {
    expect(conf).toContain('File="/var/log/frr/frr.log" Tag="frr:"');
  });

  it('forwards both GenieACS access logs with their own tags', () => {
    // The directory comes from GENIEACS_LOG_HOST_DIR at import time, so this
    // matches the filename rather than the path.
    expect(conf).toMatch(/File="[^"]*\/genieacs-cwmp-access\.log" Tag="genieacs-cwmp-access:"/);
    expect(conf).toMatch(/File="[^"]*\/genieacs-nbi-access\.log" Tag="genieacs-nbi-access:"/);
  });

  it('emits exactly one input per file and no duplicates', () => {
    expect(inputs).toHaveLength(OPEN5GS_DAEMON_SERVICES.length + 3);
    const files = inputs.map(l => /File="([^"]+)"/.exec(l)![1]);
    expect(new Set(files).size).toBe(files.length);
  });

  it('every tag ends with a colon', () => {
    // The colon terminates the syslog TAG; without it the tag runs into the
    // message and a collector filtering on tag matches nothing.
    for (const l of inputs) expect(l).toMatch(/Tag="[^"]+:"/);
  });

  it('sets Severity info and Facility local0 on every input', () => {
    for (const l of inputs) expect(l).toContain('Severity="info" Facility="local0"');
  });
});

describe('generateRsyslogConf -- parseTarget round trip', () => {
  it.each([UDP, TCP])('recovers the target from its own output (%j)', (t) => {
    // The conf file IS the persisted state; /status and restore read it back.
    expect(parseTarget(generateRsyslogConf(t))).toEqual(t);
  });

  it('recovers the port as a number, not a string', () => {
    expect(typeof parseTarget(generateRsyslogConf(TCP))!.port).toBe('number');
  });

  it('recovers an IPv6 literal host', () => {
    const t: SyslogTarget = { host: '2001:db8::1', port: 514, protocol: 'udp' };
    expect(parseTarget(generateRsyslogConf(t))).toEqual(t);
  });

  it('accepts the port boundaries 1 and 65535 verbatim', () => {
    expect(actionLine(generateRsyslogConf({ ...UDP, port: 1 }))).toContain('Port="1"');
    expect(actionLine(generateRsyslogConf({ ...UDP, port: 65535 }))).toContain('Port="65535"');
  });
});

describe('isValidSyslogHost', () => {
  it('accepts the address shapes a collector can actually have', () => {
    for (const host of [
      'collector.example.test', 'logs', 'log-host-01.corp.example.com',
      '192.0.2.10', '10.0.1.5', 'example.test.',
      '2001:db8::1', '::1', 'fe80::1', '::ffff:192.0.2.1',
      'a'.repeat(63),
    ]) {
      expect({ host, ok: isValidSyslogHost(host) }).toEqual({ host, ok: true });
    }
  });

  it('refuses a quote, which would close the Target attribute early', () => {
    // The real consequence: everything after the quote is read by rsyslog as
    // further action parameters, in a file it parses as root.
    expect(isValidSyslogHost('a" Template="x')).toBe(false);
    expect(isValidSyslogHost('a"b')).toBe(false);
    expect(isValidSyslogHost('2001:db8::1" x="y')).toBe(false);
  });

  it('refuses a newline, which would add whole statements to the drop-in', () => {
    expect(isValidSyslogHost('h\n*.* ~')).toBe(false);
    expect(isValidSyslogHost('h\n')).toBe(false);
    expect(isValidSyslogHost('\n')).toBe(false);
  });

  it('refuses whitespace, backslashes and shell metacharacters', () => {
    for (const host of [
      'a b', ' host', 'host ', 'a\tb', 'a\\b', 'a;b', 'a$(id)b', 'a`id`b',
      'a|b', 'a<b', 'a&b', "a'b", 'a#b',
    ]) {
      expect({ host, ok: isValidSyslogHost(host) }).toEqual({ host, ok: false });
    }
  });

  it('refuses the empty string and an over-length name', () => {
    expect(isValidSyslogHost('')).toBe(false);
    // A single label is capped at 63 characters by DNS.
    expect(isValidSyslogHost('a'.repeat(64))).toBe(false);
    // And the WHOLE name at 253, which needs a case every individual label
    // passes -- 'a'.repeat(254) is rejected by the 63-char label rule long
    // before the total is consulted, so it does not exercise this at all.
    const manyValidLabels = 'ab.'.repeat(90);
    expect(manyValidLabels.length).toBeGreaterThan(253);
    expect(manyValidLabels.replace(/\.$/, '').split('.').every(l => l === 'ab')).toBe(true);
    expect(isValidSyslogHost(manyValidLabels)).toBe(false);
  });

  it('refuses a malformed hostname that would still have parsed', () => {
    // Not a security case -- these reach the collector's resolver as garbage
    // and fail there, which is a worse place to find out.
    for (const host of ['a..b', '.a', '-a', 'a-', 'a.-b', 'a.b-']) {
      expect({ host, ok: isValidSyslogHost(host) }).toEqual({ host, ok: false });
    }
  });

  it('every accepted host survives the generate/parse round trip', () => {
    // The reason escaping was not an option: parseTarget() reads the host back
    // out of Target="..." with [^"]+, so an accepted host must contain no
    // quote and must re-read identically.
    for (const host of ['collector.example.test', '192.0.2.10', '2001:db8::1', '::ffff:192.0.2.1']) {
      const t: SyslogTarget = { host, port: 514, protocol: 'udp' };
      expect(parseTarget(generateRsyslogConf(t))).toEqual(t);
    }
  });
});

describe('configureSyslog refuses a bad host before touching the host', () => {
  // Only the refusal path is exercised: the guard is the first statement in
  // the function, so these return without reaching nsenter, without writing
  // the drop-in and without restarting anything. A host that PASSED
  // validation would do all three, which is why no such case appears here.
  const BAD = [
    '1.2.3.4" Queue.Type="LinkedList',
    'collector\nmodule(load="imexec")',
    'collector; rm -rf /',
    '',
  ];

  it.each(BAD)('refuses %j without running anything', async (host) => {
    const result = await configureSyslog({ host, port: 514, protocol: 'udp' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/hostname or an IP address/);
  });

  it('refuses it for the restore path too, not just the route', () => {
    // backup-restart-usecase.ts recovers a target with parseTarget() from a
    // drop-in on disk and calls configureSyslog() directly, bypassing the
    // route's own checks entirely -- so the guard has to live in here.
    const usecase = fs.readFileSync(
      path.resolve(__dirname, '../../../application/use-cases/backup-restart-usecase.ts'), 'utf-8');
    expect(usecase).toContain('configureSyslog(');
    // And the guard really is ahead of the install probe, so nothing runs first.
    const src = fs.readFileSync(path.resolve(__dirname, '../syslog-controller.ts'), 'utf-8');
    const guard = src.indexOf('isValidSyslogHost(target.host)');
    const probe = src.indexOf("nsenter('which', ['rsyslogd'])");
    expect(guard).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(guard);
  });
});
