import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_NATPING_INTERVAL_SECONDS,
  MAX_NATPING_INTERVAL_SECONDS,
  MIN_NATPING_INTERVAL_SECONDS,
} from '../ims-controller';

// Static wiring guard for the UE keepalive interval, same idea as
// sip-trace-wiring.test.ts.
//
// Background: route[NATPING] pings every registered contact on an rtimer, and
// the interval was hardcoded at 5s. That is shorter than any RRC inactivity
// timer, so it held every registered handset permanently out of idle --
// reported from the RAN side as a UE "staying active all day". The ping itself
// is required (without it an idle TCP contact goes stale before its
// registration expires and the next INVITE fails on a connect timeout), so
// the fix is to make the rate a setting, not to remove it.
//
// Two failure modes are worth pinning, because neither fails loudly:
//   * reverting to a hardcoded interval silently reintroduces the RAN problem;
//   * forgetting the new token in checkImsTemplateStaleness() renders the
//     P-CSCF template differently from how it was deployed, so every
//     deployment reports permanently stale and the operator is asked to
//     re-Configure forever. (Forgetting it in the DEPLOY path is already
//     caught loudly by deployImsTemplate()'s leftover-token guard.)

const SRC = path.resolve(__dirname, '../../..');
const IMS = fs.readFileSync(path.join(SRC, 'interfaces/rest/ims-controller.ts'), 'utf-8');
const PCSCF_TPL = fs.readFileSync(
  path.join(SRC, 'config/ims-templates/kamailio_pcscf/kamailio_pcscf.cfg'), 'utf-8');

describe('UE keepalive (NATPING) interval wiring', () => {
  it('takes the interval from a token, never a hardcoded value', () => {
    expect(PCSCF_TPL).toMatch(/modparam\("rtimer", "timer", "name=NATPING;interval=__NATPING_INTERVAL__;mode=1;"\)/);
    // The specific regression: a literal 5s on the NATPING timer.
    expect(PCSCF_TPL).not.toMatch(/name=NATPING;interval=\d+;/);
  });

  it('defaults to 30s, with the old 5s still reachable as the floor', () => {
    expect(DEFAULT_NATPING_INTERVAL_SECONDS).toBe(30);
    // 5 stays available deliberately: someone chasing a stale-contact problem
    // should be able to get back to the previous behaviour.
    expect(MIN_NATPING_INTERVAL_SECONDS).toBe(5);
    expect(MAX_NATPING_INTERVAL_SECONDS).toBe(300);
  });

  it('declares the token on the P-CSCF template entry', () => {
    // Without this the deploy loop substitutes nothing and
    // deployImsTemplate() refuses to write the file at all.
    expect(IMS).toMatch(/kamailio_pcscf\/kamailio_pcscf\.cfg'[^\n]*tokens: \['RTPENGINE_IP', 'NATPING_INTERVAL'\]/);
  });

  it('builds substitutions through one shared helper, not per-token special cases', () => {
    // The RTPENGINE_IP token was handled by three separate hardcoded checks;
    // a second token added the same way is how one of them gets missed.
    expect(IMS).toMatch(/function imsTemplateSubstitutions\(/);
    expect(IMS).not.toMatch(/tokens\?\.includes\('RTPENGINE_IP'\)/);
  });

  it('renders staleness with the configured interval, not the default', () => {
    // Every caller must pass it, or the P-CSCF template compares against a
    // different interval than was deployed and reads as permanently stale.
    const calls = IMS.match(/checkImsTemplateStaleness\([^)]*\)/g) ?? [];
    // Drop the declaration itself -- it matches the same shape, and its
    // parameter list legitimately mentions neither call site's argument.
    const realCalls = calls.filter(c => !c.includes(':') && c !== 'checkImsTemplateStaleness()');
    expect(realCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of realCalls) {
      expect(c).toMatch(/getNatpingIntervalSeconds\(\)/);
    }
  });

  it('applies the change by redeploying the template, then restarting only P-CSCF', () => {
    const fn = IMS.slice(IMS.indexOf('export async function setNatpingIntervalSeconds'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    // Through deployImsTemplate, because this file also carries
    // __RTPENGINE_IP__ and a hand-rolled rewrite is what once left that token
    // literal and broke RTP on every call.
    expect(body).toMatch(/deployImsTemplate\(/);
    expect(body).not.toMatch(/writeFileSync\([^\n]*kamailio_pcscf\.cfg/);
    // Only P-CSCF: nothing here should touch I-CSCF or S-CSCF.
    expect(body).toMatch(/restart', 'kamailio-pcscf'|'restart', 'kamailio-pcscf'/);
    expect(body).not.toMatch(/kamailio-icscf|kamailio-scscf/);
    // And it must persist, or the next Configure silently reverts it.
    expect(body).toMatch(/state\.natpingIntervalSeconds = seconds/);
  });

  it('validates the range server-side, not only in the UI', () => {
    const fn = IMS.slice(IMS.indexOf('export async function setNatpingIntervalSeconds'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toMatch(/Number\.isInteger\(seconds\)/);
    expect(body).toMatch(/MIN_NATPING_INTERVAL_SECONDS/);
    expect(body).toMatch(/MAX_NATPING_INTERVAL_SECONDS/);
  });
});
