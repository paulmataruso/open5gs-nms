import * as fs from 'fs';
import * as path from 'path';
import { smscMainCfg, smscIncludeCfg } from '../ims-controller';

// Guard for the generated kamailio_smsc.cfg (smscMainCfg()), written by
// configureIms() and by setSmsWorkerInterval() to
// /proc/1/root/etc/kamailio_smsc/kamailio_smsc.cfg (the host's
// /etc/kamailio_smsc/kamailio_smsc.cfg), next to the smsc.cfg that
// smscIncludeCfg() writes.
//
// Kamailio accepts nearly any edit to this file and starts, so every failure
// here is silent:
//   * the file is a 600-line template whose only deployment-specific inputs
//     arrive as preprocessor macros (SMS_DB_URL, DOMAIN, SMSC_SERVER, ...)
//     defined in the SEPARATE smsc.cfg. A macro used here but not defined
//     there is not an error for #!define-style names inside strings or
//     modparams -- it is passed through as literal text, so the SMSC runs with
//     a database URL of "SMS_DB_URL" and every queue insert fails at runtime;
//   * the SMS_WORKER rtimer is the ONLY thing that drains the store-and-forward
//     queue. If the timer name, the exec binding or the route name drift apart
//     the daemon is healthy, accepts MESSAGEs, queues them, and never delivers
//     one;
//   * the ctl socket path must agree with the path kamailio-stats-monitor.ts
//     polls and with the systemd RuntimeDirectory that creates its directory,
//     or the IMS dashboard shows the SMSC as permanently dead (or kamailio
//     fails to bind the socket). kex.so must be loaded as well, because
//     stats.get_statistics is registered by kex, not ctl -- the socket then
//     accepts connections and every stats call returns "not found".
//
// These tests assert the AGREEMENTS between those pieces, not the template's
// literal text.

const SRC = path.resolve(__dirname, '../../..');
const IMS_SRC = fs.readFileSync(path.join(SRC, 'interfaces/rest/ims-controller.ts'), 'utf-8');
const STATS_SRC = fs.readFileSync(
  path.join(SRC, 'application/use-cases/ims/kamailio-stats-monitor.ts'), 'utf-8');

// The systemd unit is a plain template literal with no interpolation, so the
// generated text can be read out of the source directly -- but ONLY out of
// this one function. Slicing to the end of the file would let an assertion
// pass on a line belonging to any later generator, which is the whole thing
// these tests exist to catch.
const SMSC_UNIT = ((): string => {
  const start = IMS_SRC.indexOf('function smscSystemdUnit');
  expect(start).toBeGreaterThan(-1);
  const end = IMS_SRC.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return IMS_SRC.slice(start, end);
})();

// Synthetic fixture values only.
const INCLUDE = smscIncludeCfg({ smscIp: '198.51.100.7', imsDomain: 'ims.test.invalid' });

describe('smscMainCfg -- store-and-forward worker timer', () => {
  it('defaults the poll interval to 30 seconds', () => {
    // 30 is the upstream hardcoded value; also the fallback configureIms()
    // uses when no saved state exists, so the two must agree.
    expect(smscMainCfg()).toContain('name=sms;interval=30;');
    expect(IMS_SRC).toMatch(/let smsWorkerIntervalSeconds = 30;/);
  });

  it('carries the requested interval into the rtimer definition exactly once', () => {
    const cfg = smscMainCfg(7);
    const hits = cfg.match(/interval=\d+/g) ?? [];
    // A second interval= would mean a stray hardcoded timer still polling.
    expect(hits).toEqual(['interval=7']);
    expect(cfg).toContain('name=sms;interval=7;mode=1;');
  });

  it('binds the timer to a route that actually exists, under the same timer name', () => {
    const cfg = smscMainCfg();
    const timerName = /"name=(\w+);interval=/.exec(cfg)?.[1];
    const exec = /modparam\("rtimer",\s*"exec",\s*"timer=(\w+);route=(\w+)"\)/.exec(cfg);
    expect(timerName).toBeDefined();
    // exec naming a timer that is not defined is accepted and never fires.
    expect(exec?.[1]).toBe(timerName);
    // A renamed route leaves the timer firing into nothing: no delivery.
    expect(cfg).toContain(`route[${exec?.[2]}] {`);
  });

  it('keeps the retry htable name identical in its definition and every use', () => {
    const cfg = smscMainCfg();
    const def = /"htable",\s*"(\w+)=>/.exec(cfg)?.[1];
    expect(def).toBe('sms_retries');
    const uses = [...cfg.matchAll(/\$sht\((\w+)=>/g)].map(m => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    // $sht() on an undefined table reads $null forever, so the drop-after-N
    // counter never advances and an undeliverable message retries indefinitely.
    expect(new Set(uses)).toEqual(new Set([def]));
  });

  it('expires retry counters with the macro the include file defines', () => {
    // autoexpire=SUBSCRIBE_EXPIRE is substituted from smsc.cfg; an undefined
    // name here is a non-numeric autoexpire.
    expect(smscMainCfg()).toContain('autoexpire=SUBSCRIBE_EXPIRE');
    expect(INCLUDE).toMatch(/#!subst "\/SUBSCRIBE_EXPIRE\/\d+\/"/);
  });
});

describe('smscMainCfg -- agreement with smsc.cfg (smscIncludeCfg)', () => {
  const MACROS = ['SMS_DB_URL', 'DIALPLAN_PUA_DB_URL', 'DOMAIN', 'SMSC_SERVER', 'SUBSCRIBE_EXPIRE'];

  it('pulls in the include file under the filename configureIms() writes', () => {
    const inc = /include_file "([^"]+)"/.exec(smscMainCfg())?.[1];
    expect(inc).toBe('smsc.cfg');
    // The include is resolved relative to this file's directory, so both must
    // be written into the same directory.
    expect(IMS_SRC).toContain('`${HOST_KAMAILIO_SMSC_DIR}/smsc.cfg`');
    expect(IMS_SRC).toContain('`${HOST_KAMAILIO_SMSC_DIR}/kamailio_smsc.cfg`');
  });

  it.each(MACROS)('every use of %s in the main config is defined or substituted in the include', (name) => {
    expect(smscMainCfg()).toMatch(new RegExp(`\\b${name}\\b`));
    const defined = new RegExp(`#!define ${name}\\b|#!subst "/${name}/`);
    expect(INCLUDE).toMatch(defined);
  });

  it('refers to the SMSC identity only through the port-bearing SMSC_SERVER macro', () => {
    const cfg = smscMainCfg();
    // Past bug: a portless smsc.<domain> resolved to P-CSCF's 5060 instead of
    // the SMSC's 7090. The port lives in the macro, so a bare "smsc." literal
    // here would reintroduce it.
    expect(cfg).toContain('alias=SMSC_SERVER');
    expect(cfg).toContain('"server_address", "sip:SMSC_SERVER"');
    expect(cfg).toContain('$uac_req(furi) = "sip:"+SMSC_SERVER;');
    expect(cfg).not.toMatch(/smsc\.(?!cfg)[a-z0-9.-]+/i);
    expect(INCLUDE).toMatch(/#!define SMSC_SERVER "smsc\.[^"]+:7090"/);
  });

  it('never embeds database credentials or URLs itself', () => {
    // Credentials belong in smsc.cfg only, so there is one place to change.
    expect(smscMainCfg()).not.toMatch(/mysql:\/\//);
  });

  it('points both SQL consumers at the macros, not at literals', () => {
    const cfg = smscMainCfg();
    expect(cfg).toContain('modparam("sqlops", "sqlcon", SMS_DB_URL)');
    expect(cfg).toContain('modparam("dialplan", "db_url", DIALPLAN_PUA_DB_URL)');
    expect(cfg).toContain('modparam("pua", "db_url", DIALPLAN_PUA_DB_URL)');
    // Queries address the connection by the name given before "=>" in SMS_DB_URL.
    const conName = /^#!define SMS_DB_URL "(\w+)=>/m.exec(INCLUDE)?.[1];
    expect(conName).toBe('sms');
    const used = [...smscMainCfg().matchAll(/sql_query\("(\w+)"/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set([conName]));
  });
});

describe('smscMainCfg -- control socket agrees with its consumers', () => {
  const ctl = /modparam\("ctl",\s*"binrpc",\s*"unix:([^"]+)"\)/.exec(smscMainCfg())?.[1];

  it('loads both ctl.so and kex.so', () => {
    const cfg = smscMainCfg();
    expect(cfg).toContain('loadmodule "ctl.so"');
    // stats.get_statistics lives in kex, not ctl: without it the socket
    // answers but every statistics call fails with "not found".
    expect(cfg).toContain('loadmodule "kex.so"');
  });

  it('uses the socket path the stats monitor polls (/var/run is /run)', () => {
    expect(ctl).toBeDefined();
    const monitor = /smsc:\s*'([^']+)'/.exec(STATS_SRC)?.[1];
    expect(monitor).toBeDefined();
    expect(ctl!.replace(/^\/var\/run\//, '/run/')).toBe(monitor);
  });

  it('has its directory created by the generated systemd unit', () => {
    const dir = path.posix.dirname(ctl!).replace(/^\/var\/run\//, '/run/');
    // Kamailio will not create the directory itself; RuntimeDirectory and
    // the mkdir must both name the same directory the socket lives in.
    expect(SMSC_UNIT).toContain(`RuntimeDirectory=${path.posix.basename(dir)}`);
    expect(SMSC_UNIT).toContain(`ExecStartPre=/bin/mkdir -p ${dir}`);
  });

  it('is the config path the systemd unit starts kamailio with', () => {
    // The unit names an absolute host path; the writer names the same path
    // under /proc/1/root. A change to either alone starts the daemon on a
    // config nothing generates.
    const hostDir = /HOST_KAMAILIO_SMSC_DIR\s*=\s*'\/proc\/1\/root(\S+?)'/.exec(IMS_SRC)?.[1];
    expect(hostDir).toBe('/etc/kamailio_smsc');
    expect(SMSC_UNIT).toContain(`ExecStart=/usr/sbin/kamailio -f ${hostDir}/kamailio_smsc.cfg `);
  });
});

describe('smscMainCfg -- generated text integrity', () => {
  it('turns the template-literal \\n escapes into literal backslash-n, not real newlines', () => {
    const cfg = smscMainCfg();
    // A real newline inside a Kamailio string is a config parse error and the
    // whole SMSC fails to start, so the generator must emit the two characters
    // backslash-n. A broken escape splits one line into two, leaving an odd
    // number of quotes on each half -- which is what this counts, across EVERY
    // non-comment line rather than only the xlog() ones. Comments are excluded
    // because several carry prose quotations that legitimately span lines.
    const offenders = cfg.split('\n')
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) => !text.trim().startsWith('#'))
      .filter(({ text }) => ((text.replace(/\\"/g, '').match(/"/g) ?? []).length % 2) === 1);
    expect(offenders).toEqual([]);
    expect(cfg).toContain('Content-Type: application/vnd.3gpp.sms\\r\\n');
  });

  it('starts with the Kamailio config marker', () => {
    expect(smscMainCfg().startsWith('#!KAMAILIO\n')).toBe(true);
  });

  it('is deterministic for a given interval (no clock or random content)', () => {
    expect(smscMainCfg(45)).toBe(smscMainCfg(45));
  });

  it('only the interval differs between two generated intervals', () => {
    expect(smscMainCfg(10).replace('interval=10;', 'interval=X;'))
      .toBe(smscMainCfg(90).replace('interval=90;', 'interval=X;'));
  });
});
