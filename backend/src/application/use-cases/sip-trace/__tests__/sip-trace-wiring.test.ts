import * as fs from 'fs';
import * as path from 'path';
import { CAPTURE_PORTS } from '../sip-trace-store';

// Static wiring guard, same idea as dns-boot-gate-wiring.test.ts.
//
// scscfIncludeCfg() regenerates the WHOLE include, and four separate setters
// call it. If a new caller forgets sipTracePort, flipping an unrelated toggle
// (SMS delivery mode, voice charging, CDR accounting) silently rewrites the
// config with CAPTURE_NODE dropped -- tracing stops, state still claims it is
// on, and nothing fails loudly. ims-controller.ts's own comments warn about
// exactly this class of bug for the other three toggles; this makes it a test
// rather than a comment.

const SRC = path.resolve(__dirname, '../../../..');
const IMS = fs.readFileSync(path.join(SRC, 'interfaces/rest/ims-controller.ts'), 'utf-8');

/** Strip comments so an assertion can never be satisfied by prose about it. */
function code(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
}
const IMS_CODE = code(IMS);

/** Every argument object literal passed to `fn(` in real code. */
function callArgs(src: string, fn: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // skip the declaration itself
    const before = src.slice(Math.max(0, m.index - 30), m.index);
    if (/function\s+$/.test(before) || /export function\s+$/.test(before)) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

describe('SIP tracing config wiring', () => {
  it.each(['pcscfIncludeCfg', 'icscfIncludeCfg', 'scscfIncludeCfg'])(
    '%s accepts a sipTracePort parameter',
    fn => {
      const sig = new RegExp(`function ${fn}\\(p: \\{[^)]*sipTracePort\\?: number`);
      expect(IMS_CODE).toMatch(sig);
    },
  );

  it.each(['pcscfIncludeCfg', 'icscfIncludeCfg', 'scscfIncludeCfg'])(
    '%s emits the CAPTURE_NODE define from that parameter',
    fn => {
      const body = IMS_CODE.slice(IMS_CODE.indexOf(`function ${fn}(`));
      const end = body.indexOf('\n}');
      expect(body.slice(0, end)).toMatch(/captureNodeDefine\(p\.sipTracePort/);
    },
  );

  it('every scscfIncludeCfg call site passes sipTracePort', () => {
    // The whole point of this suite: four setters regenerate this one file.
    const calls = callArgs(IMS_CODE, 'scscfIncludeCfg');
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const missing = calls.filter(c => !c.includes('sipTracePort'));
    expect(missing).toEqual([]);
  });

  it.each(['pcscfIncludeCfg', 'icscfIncludeCfg'])('every %s call site passes sipTracePort', fn => {
    const calls = callArgs(IMS_CODE, fn);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.filter(c => !c.includes('sipTracePort'))).toEqual([]);
  });

  it('every scscfIncludeCfg call site still preserves the three pre-existing toggles', () => {
    // Guards the reverse mistake too: adding tracing must not have dropped
    // what the existing setters were careful to preserve.
    for (const c of callArgs(IMS_CODE, 'scscfIncludeCfg')) {
      expect(c).toMatch(/cdrAccounting:/);
      expect(c).toMatch(/voiceCharging:/);
      expect(c).toMatch(/blockImsSms:|routeSmsToVectorcore:/);
    }
  });

  it('the capture define is driven off CAPTURE_PORTS, not a second hardcoded list', () => {
    // A duplicated port list is how the config and the collector would drift
    // apart and silently mislabel every message's source instance.
    expect(IMS_CODE).toMatch(/import \{ CAPTURE_PORTS \} from '\.\.\/\.\.\/application\/use-cases\/sip-trace\/sip-trace-store'/);
    expect(IMS_CODE).toMatch(/return enabled \? CAPTURE_PORTS\[instance\] : undefined/);
    for (const port of Object.values(CAPTURE_PORTS)) {
      // the literal port numbers must NOT appear in ims-controller
      expect(IMS_CODE).not.toMatch(new RegExp(`sip:127\\.0\\.0\\.1:${port}`));
    }
  });

  it('binds the collector to loopback only', () => {
    // HEP is unauthenticated; a routable bind would let anything on the RAN
    // inject forged SIP into the operator's trace.
    expect(IMS_CODE).toMatch(/const HEP_COLLECTOR_BIND = '127\.0\.0\.1'/);
  });

  it('Configure preserves the flag instead of silently turning tracing off', () => {
    expect(IMS_CODE).toMatch(/prevSaved\?\.sipTracingEnabled === true\) sipTracingEnabled = true/);
  });

  it('Configure never enables tracing on its own', () => {
    // Enabling restarts P-CSCF, which drops every UE's IPsec SA. A Configure
    // run must never do that as a side effect.
    expect(IMS_CODE).toMatch(/let sipTracingEnabled = false;/);
  });

  it('disabling uses the RPC and does NOT restart anything', () => {
    const fnStart = IMS_CODE.indexOf('export async function setSipTracingEnabled');
    expect(fnStart).toBeGreaterThan(-1);
    const body = IMS_CODE.slice(fnStart, IMS_CODE.indexOf('export function getSipTracingEnabled'));
    const disableBranch = body.slice(body.indexOf('if (!enabled)'), body.indexOf('return report;'));
    expect(disableBranch).toMatch(/siptraceRpc\(inst\.ctl, 'off'\)/);
    expect(disableBranch).not.toMatch(/systemctl/);
  });

  it('treats a kamcmd "command not found" body as a failed probe, not a success', () => {
    // Found live: kamcmd prints `error: 500 - command siptrace.status not found`
    // on STDOUT and exits 0 when the module is not loaded. Trusting the exit
    // code reported the module as loaded, which made the enable path skip the
    // restart that loads it -- tracing would silently never start.
    const fn = IMS_CODE.slice(
      IMS_CODE.indexOf('async function siptraceRpc'),
      IMS_CODE.indexOf('function writeCscfIncludes'),
    );
    expect(fn).toMatch(/\/\^error:\/i\.test\(raw\)/);
    expect(fn).toMatch(/not found\/i\.test\(raw\)/);
    expect(fn).toMatch(/return \{ ok: false/);
    // nsenter() resolves to { stdout, stderr }; String()-ing it yields
    // "[object Object]" and the checks above can then never match. Assert the
    // fields are read explicitly.
    expect(fn).toMatch(/res\?\.stdout/);
    expect(fn).toMatch(/res\?\.stderr/);
    expect(fn).not.toMatch(/String\(\(await nsenter/);
  });

  it('restarts the least disruptive instances before P-CSCF', () => {
    // P-CSCF last, so an earlier failure does not cost UE tunnels for nothing.
    const list = IMS_CODE.slice(IMS_CODE.indexOf('const SIP_TRACE_INSTANCES'));
    const order = ['scscf', 'icscf', 'pcscf'].map(r => list.indexOf(`role: '${r}' as const`));
    expect(order.every(i => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
