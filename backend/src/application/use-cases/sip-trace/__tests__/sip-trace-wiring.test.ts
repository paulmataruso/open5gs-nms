import * as fs from 'fs';
import * as path from 'path';
import { CAPTURE_PORTS } from '../sip-trace-store';

// Static wiring guard, same idea as dns-boot-gate-wiring.test.ts.
//
// scscfIncludeCfg() regenerates the WHOLE include, and four separate setters
// call it. If a new caller forgets `sipTracing`, flipping an unrelated toggle
// (SMS delivery mode, voice charging, CDR accounting) silently rewrites the
// config without CAPTURE_TRACE_ON -- capture then dies at the next restart of
// that CSCF while state still claims it is on, and nothing fails loudly.
// ims-controller.ts's own comments warn about exactly this class of bug for
// the other three toggles; this makes it a test rather than a comment.
//
// The suite also pins the two properties the restart-free design rests on:
// CAPTURE_NODE (the loadmodule switch) must be UNCONDITIONAL, and nothing in
// the toggle may restart a service. Losing either one brings back a P-CSCF
// restart -- and with it every registered handset's IPsec SA -- as the price
// of looking at a call flow.

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
    '%s accepts a sipTracing parameter',
    fn => {
      const sig = new RegExp(`function ${fn}\\(p: \\{[^)]*sipTracing\\?: boolean`);
      expect(IMS_CODE).toMatch(sig);
    },
  );

  it.each([
    ['pcscfIncludeCfg', 'pcscf'],
    ['icscfIncludeCfg', 'icscf'],
    ['scscfIncludeCfg', 'scscf'],
  ])('%s emits the capture defines for its own instance', (fn, role) => {
    // Each generator must name its OWN role: passing another instance's would
    // point two CSCFs at one collector port and mislabel every message's
    // source, which the parser cannot detect afterwards.
    const body = IMS_CODE.slice(IMS_CODE.indexOf(`function ${fn}(`));
    const end = body.indexOf('\n}');
    expect(body.slice(0, end)).toMatch(
      new RegExp(`captureNodeDefine\\('${role}', p\\.sipTracing === true\\)`),
    );
  });

  it('every scscfIncludeCfg call site passes sipTracing', () => {
    // The whole point of this suite: four setters regenerate this one file.
    const calls = callArgs(IMS_CODE, 'scscfIncludeCfg');
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const missing = calls.filter(c => !c.includes('sipTracing'));
    expect(missing).toEqual([]);
  });

  it.each(['pcscfIncludeCfg', 'icscfIncludeCfg'])('every %s call site passes sipTracing', fn => {
    const calls = callArgs(IMS_CODE, fn);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.filter(c => !c.includes('sipTracing'))).toEqual([]);
  });

  it('CAPTURE_NODE does not depend on tracing being on, so siptrace stays loaded', () => {
    // The module can only be loaded at startup. If this define went back to
    // tracking the on/off state, enabling capture would need a CSCF restart,
    // and restarting P-CSCF drops every registered UE's IPsec SA.
    const fn = IMS_CODE.slice(
      IMS_CODE.indexOf('function captureNodeDefine'),
      IMS_CODE.indexOf('export function pcscfIncludeCfg'),
    );
    expect(fn).toMatch(/#!define CAPTURE_NODE/);
    // the on/off state rides on its own define, not on CAPTURE_NODE's presence
    expect(fn).toMatch(/traceOn \? '#!define CAPTURE_TRACE_ON/);
    // exactly ONE early return, and only for the old-template fallback below
    expect(fn.match(/return '';/g) ?? []).toHaveLength(1);
    expect(fn).toMatch(/if \(!traceOn && !templateHandlesCaptureTraceOn\(instance\)\) return '';/);
  });

  it.each([
    ['kamailio_pcscf/kamailio_pcscf.cfg'],
    ['kamailio_icscf/kamailio_icscf.cfg'],
    ['kamailio_scscf/kamailio_scscf.cfg'],
  ])('%s starts tracing off unless CAPTURE_TRACE_ON is defined', rel => {
    // A template hardcoding `trace_on 1` would make merely loading the module
    // start duplicating every SIP message to a port nobody asked for.
    const cfg = fs.readFileSync(path.join(SRC, 'config/ims-templates', rel), 'utf-8');
    expect(cfg).toMatch(/#!ifdef CAPTURE_TRACE_ON\nmodparam\("siptrace", "trace_on", 1\)\n#!else\nmodparam\("siptrace", "trace_on", 0\)\n#!endif/);
    expect(cfg).toMatch(/modparam\("siptrace", "trace_to_database", 0\)/);
  });

  it.each([
    ['kamailio_pcscf/kamailio_pcscf.cfg'],
    ['kamailio_icscf/kamailio_icscf.cfg'],
    ['kamailio_scscf/kamailio_scscf.cfg'],
  ])('%s traces the whole transaction, not just the one message', rel => {
    // The bug this pins, found live 2026-10-13: siptrace's default mode is
    // "message", so a bare sip_trace() mirrors the single message in hand and
    // NO replies. The capture then contains requests and not one 100/180/200,
    // which is not a call flow at all -- and it looks like a working feature,
    // because messages are being stored.
    //
    // Worse, the mode was order-dependent: sip_trace() with no argument picks
    // transaction mode only if `msg->flags & trace_flag` is already set, and
    // the template called sip_trace() BEFORE setflag(FLT_CAPTURE). Stating the
    // mode explicitly removes the dependency on line order entirely.
    const cfg = fs.readFileSync(path.join(SRC, 'config/ims-templates', rel), 'utf-8');
    expect(cfg).toMatch(/sip_trace_mode\("t"\);/);
    // No bare sip_trace() anywhere -- that is the call that silently means
    // "message mode" unless a flag happens to have been set first.
    expect(cfg).not.toMatch(/\bsip_trace\(\)\s*;/);
    // Belt and braces: the flag still precedes the trace call, so even the
    // implicit path would choose transaction mode.
    const flag = cfg.indexOf('setflag(FLT_CAPTURE);');
    const trace = cfg.indexOf('sip_trace_mode("t");');
    expect(flag).toBeGreaterThan(-1);
    expect(trace).toBeGreaterThan(flag);
  });

  it('lists calls, not every SIP dialog, unless explicitly asked for all', () => {
    // Measured on this deployment the day the flow view shipped: 187 captured
    // dialogs, of which 1 was a call -- 184 were P-CSCF->I-CSCF OPTIONS
    // keepalives and 2 were CANCEL fragments. Defaulting to the unfiltered
    // list puts the one thing the page is open for on page 8.
    const store = fs.readFileSync(
      path.join(SRC, 'application/use-cases/sip-trace/sip-trace-store.ts'), 'utf-8');
    expect(store).toMatch(/if \(\(f\.kind \?\? 'calls'\) === 'calls'\) pipeline\.push\(\{ \$match: \{ methods: 'INVITE' \} \}\)/);

    // After $group, not before: matching INVITE on raw messages would return a
    // dialog holding only its INVITE, losing the replies, ACK and BYE.
    const group = store.indexOf('$group');
    const kindMatch = store.indexOf("(f.kind ?? 'calls') === 'calls'");
    expect(group).toBeGreaterThan(-1);
    expect(kindMatch).toBeGreaterThan(group);

    // Only an explicit 'all' widens it, so a caller that never considered the
    // question still gets the useful view.
    const ctl = fs.readFileSync(path.join(SRC, 'interfaces/rest/sip-trace-controller.ts'), 'utf-8');
    expect(ctl).toMatch(/kind: q\.kind === 'all' \? 'all' : 'calls'/);
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

  it('falls back to the old define meaning against a template that predates CAPTURE_TRACE_ON', () => {
    // An old template reads CAPTURE_NODE itself as "trace" (it hardcodes
    // trace_on 1), so emitting it while tracing is off would start a capture
    // nobody asked for at that CSCF's next restart, with the UI still
    // reporting tracing off.
    const fn = IMS_CODE.slice(
      IMS_CODE.indexOf('function templateHandlesCaptureTraceOn'),
      IMS_CODE.indexOf('export function pcscfIncludeCfg'),
    );
    expect(fn).toMatch(/includes\('CAPTURE_TRACE_ON'\)/);
    // a missing file is a fresh install, where Configure is about to write the
    // current template -- it must not be read as "old template"
    expect(fn).toMatch(/catch \{\s*return true;/);
    expect(fn).toMatch(/if \(!traceOn && !templateHandlesCaptureTraceOn\(instance\)\) return '';/);
  });

  it('Configure deploys the static templates BEFORE generating the includes', () => {
    // The includes are written to match what the deployed template
    // understands, so reading the outgoing template and then replacing it
    // leaves the two disagreeing until the next Configure.
    //
    // Deliberately against the RAW source, not IMS_CODE: code() strips block
    // comments with a non-greedy /*...*/ and this file has more `*/` than
    // `/*` (several live inside string literals and regexes), so the stripped
    // copy loses whole regions -- including this loop. The two strings matched
    // below are statements, which cannot appear in a comment.
    const cfgStart = IMS.indexOf('export async function configureIms');
    expect(cfgStart).toBeGreaterThan(-1);
    const body = IMS.slice(cfgStart);
    const deploy = body.indexOf('for (const entry of IMS_STATIC_TEMPLATES) {');
    const include = body.indexOf('pcscfIncludeCfg({');
    expect(deploy).toBeGreaterThan(-1);
    expect(include).toBeGreaterThan(-1);
    expect(deploy).toBeLessThan(include);
  });

  it('the capture define is driven off CAPTURE_PORTS, not a second hardcoded list', () => {
    // A duplicated port list is how the config and the collector would drift
    // apart and silently mislabel every message's source instance.
    expect(IMS_CODE).toMatch(/import \{ CAPTURE_PORTS \} from '\.\.\/\.\.\/application\/use-cases\/sip-trace\/sip-trace-store'/);
    expect(IMS_CODE).toMatch(/CAPTURE_PORTS\[instance\]/);
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

  it('Configure preserves an explicit opt-out instead of silently re-enabling', () => {
    // Polarity matters: `=== false`, so only a deliberate "off" survives a
    // Configure. Matching on `=== true` would pin a deployment that predates
    // the flag to off forever, which is the old default by another route.
    expect(IMS_CODE).toMatch(/prevSaved\?\.sipTracingEnabled === false\) sipTracingEnabled = false/);
  });

  it('Configure PERSISTS the tracing flag into the state file', () => {
    // The regression this exists for, and the reason the opt-out above was
    // self-defeating: Configure carried the old value into the generated
    // includes -- so the CSCFs really did come up with CAPTURE_TRACE_ON and
    // really were tracing -- and then omitted the key from the state file it
    // wrote. getSipTracingEnabled() therefore read false and the UI reported
    // tracing off while all three CSCFs filled the trace store, and the next
    // Configure saw no key at all. The sibling toggles were always persisted;
    // this one was not, and nothing covered it.
    const start = IMS_CODE.indexOf('fs.writeFileSync(HOST_IMS_STATE, JSON.stringify({');
    expect(start).toBeGreaterThan(-1);
    const payload = IMS_CODE.slice(start, IMS_CODE.indexOf('}, null, 2), \'utf-8\');', start));
    expect(payload).toMatch(/\bvoiceChargingEnabled,/);
    expect(payload).toMatch(/\bcdrAccountingEnabled,/);
    expect(payload).toMatch(/\bsipTracingEnabled,/);
  });

  it('Configure comes up tracing, because enabling costs no restart', () => {
    // Reversed deliberately on 2026-10-19, on the operator's instruction.
    //
    // This previously asserted `= false`, on the reasoning that "Configure
    // makes capture available; it does not begin duplicating every SIP
    // message on an operator's behalf." The privacy/storage half of that is
    // real, but it was weighed against a restart cost that does not exist:
    // siptrace is loaded unconditionally and the toggle is a pure RPC
    // (pinned by the restart test below, and verified live -- all three CSCFs
    // went Disabled -> Enabled with HEP arriving in seconds and their
    // ActiveEnterTimestamps unchanged). Defaulting off therefore bought no
    // restart saving at all, and cost the operator a capture that is empty
    // the first time they look at a real call.
    //
    // The storage half is answered separately by keepalive suppression, which
    // removed 68% of what always-on used to store.
    expect(IMS_CODE).toMatch(/let sipTracingEnabled = true;/);
  });

  it('neither direction of the toggle restarts anything', () => {
    // The entire reason siptrace is loaded unconditionally. A restart here
    // would drop every registered UE's IPsec SA (CLAUDE.md gotcha) as the
    // price of starting a capture.
    const fnStart = IMS_CODE.indexOf('export async function setSipTracingEnabled');
    expect(fnStart).toBeGreaterThan(-1);
    const body = IMS_CODE.slice(fnStart, IMS_CODE.indexOf('export function getSipTracingEnabled'));
    expect(body).toMatch(/siptraceRpc\(inst\.ctl, 'off'\)/);
    expect(body).toMatch(/siptraceRpc\(inst\.ctl, 'on'\)/);
    expect(body).not.toMatch(/systemctl/);
    expect(body).not.toMatch(/restart/);
  });

  it('an instance with no module loaded is reported, not restarted', () => {
    const body = IMS_CODE.slice(
      IMS_CODE.indexOf('export async function setSipTracingEnabled'),
      IMS_CODE.indexOf('export function getSipTracingEnabled'),
    );
    expect(body).toMatch(/needsConfigure = true/);
    expect(body).toMatch(/action: 'not-loaded'/);
  });

  it('SIP_TRACE_INSTANCES carries no systemd unit names', () => {
    // Nothing needs them any more, and having them to hand is how a restart
    // path quietly grows back.
    const list = IMS_CODE.slice(
      IMS_CODE.indexOf('const SIP_TRACE_INSTANCES'),
      IMS_CODE.indexOf('export interface SipTracingApplyReport'),
    );
    expect(list).not.toMatch(/kamailio-(pcscf|icscf|scscf)/);
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

  it('covers all three CSCFs', () => {
    const list = IMS_CODE.slice(IMS_CODE.indexOf('const SIP_TRACE_INSTANCES'));
    for (const r of ['scscf', 'icscf', 'pcscf']) {
      expect(list).toContain(`role: '${r}' as const`);
    }
  });
});
