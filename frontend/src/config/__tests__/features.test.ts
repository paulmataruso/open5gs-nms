// Module visibility flags, and specifically their POLARITY.
//
// Why this is worth a test rather than a read-through: the two groups look
// almost identical in source (`!== 'false'` against `=== 'true'`) and getting
// one wrong has asymmetric, real consequences. A default-ON module written
// opt-in silently disappears from every existing deployment. A default-OFF
// module written opt-out is the dangerous direction — CLAUDE.md records why
// each of these is opt-in, and the reasons are real-world: `pstn` can bill a
// linked SIP trunk account, `gsm` transmits on actual spectrum, `secgw` sits
// in a live radio's S1/N2 backhaul, `dhcp` binds UDP/67 and can hand addresses
// out on a live segment, `cellBroadcast` drives public ETWS/CMAS alerting.
//
// Cell Broadcast is the precedent: it shipped "with no module flag at all, so
// its nav entry showed on every deployment" (cell-broadcast-wiring.test.ts).
// That is an omission, which is why the completeness test below matters more
// than any individual assertion here — it fails when a NEW key appears and
// nobody recorded which group it belongs to.
//
// Not duplicating the backend: dhcp-wiring and cell-broadcast-wiring read this
// file as TEXT and check their own one flag. This EXECUTES the module against
// stubbed env for every flag at once.
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The intended default for every flag, and the env var that overrides it.
 *
 * `on` means default-enabled / opt-OUT (`VITE_... !== 'false'`).
 * `off` means default-disabled / opt-IN (`VITE_... === 'true'`).
 */
const EXPECTED: Record<string, { env: string; dflt: 'on' | 'off' }> = {
  // Default-ON: core lab features, plus ueSignal which CLAUDE.md records as
  // "a visibility gate, not an install/uninstall lifecycle".
  sms: { env: 'VITE_ENABLE_SMS', dflt: 'on' },
  ims: { env: 'VITE_ENABLE_IMS', dflt: 'on' },
  validation: { env: 'VITE_ENABLE_VALIDATION', dflt: 'on' },
  vowifi: { env: 'VITE_ENABLE_VOWIFI', dflt: 'on' },
  dnsMigration: { env: 'VITE_ENABLE_DNS_MIGRATION', dflt: 'on' },
  pcap: { env: 'VITE_ENABLE_PCAP', dflt: 'on' },
  ueSignal: { env: 'VITE_ENABLE_UE_SIGNAL', dflt: 'on' },

  // Default-OFF: every module that installs a host service, builds a
  // third-party binary, touches live radio, or can cost real money.
  pstn: { env: 'VITE_ENABLE_PSTN', dflt: 'off' },
  mms: { env: 'VITE_ENABLE_MMS', dflt: 'off' },
  vectorcoreSmsc: { env: 'VITE_ENABLE_VECTORCORE_SMSC', dflt: 'off' },
  secgw: { env: 'VITE_ENABLE_SECGW', dflt: 'off' },
  gsm: { env: 'VITE_ENABLE_GSM', dflt: 'off' },
  asterisk2g: { env: 'VITE_ENABLE_ASTERISK_2G', dflt: 'off' },
  hnbgw: { env: 'VITE_ENABLE_HNBGW', dflt: 'off' },
  ocs: { env: 'VITE_ENABLE_OCS', dflt: 'off' },
  cdr: { env: 'VITE_ENABLE_CDR', dflt: 'off' },
  rfPlanning: { env: 'VITE_ENABLE_RF_PLANNING', dflt: 'off' },
  twamp: { env: 'VITE_ENABLE_TWAMP', dflt: 'off' },
  snmp: { env: 'VITE_ENABLE_SNMP', dflt: 'off' },
  dhcp: { env: 'VITE_ENABLE_DHCP', dflt: 'off' },
  cellBroadcast: { env: 'VITE_ENABLE_CELL_BROADCAST', dflt: 'off' },
};

/** Re-evaluates features.ts with `env` applied on top of a cleared env. */
async function featuresWith(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('../features')).FEATURES;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('FEATURES — completeness', () => {
  it('every flag this module exposes has a recorded intended default', async () => {
    // The guard against the Cell Broadcast failure mode: adding a module
    // without deciding its polarity. A new key fails here, naming itself.
    const actual = Object.keys(await featuresWith()).sort();
    const recorded = Object.keys(EXPECTED).sort();
    expect(actual).toEqual(recorded);
  });

  it('no two flags share an env var', async () => {
    // A copy-paste slip here is invisible: both modules would appear and
    // disappear together, and neither would be independently controllable.
    const envs = Object.values(EXPECTED).map(e => e.env);
    expect(new Set(envs).size).toBe(envs.length);
  });
});

describe('FEATURES — defaults with nothing set', () => {
  it('matches the recorded intent for all 21 flags', async () => {
    const f = await featuresWith();
    const got: Record<string, boolean> = {};
    const want: Record<string, boolean> = {};
    for (const [key, { dflt }] of Object.entries(EXPECTED)) {
      got[key] = f[key as keyof typeof f];
      want[key] = dflt === 'on';
    }
    // Compared as whole objects so a failure prints every disagreement at
    // once rather than stopping at the first.
    expect(got).toEqual(want);
  });
});

describe('FEATURES — polarity per flag', () => {
  for (const [key, { env, dflt }] of Object.entries(EXPECTED)) {
    describe(`${key} (${env}, default ${dflt})`, () => {
      it("'true' enables it and 'false' disables it", async () => {
        const on = await featuresWith({ [env]: 'true' });
        expect(on[key as keyof typeof on]).toBe(true);

        const off = await featuresWith({ [env]: 'false' });
        expect(off[key as keyof typeof off]).toBe(false);
      });

      it('falls back to its default on an unrecognised value', async () => {
        // Build args arrive as strings from .env, so a typo or a stray
        // 'True'/'1'/'yes' is realistic. Each comparison is exact-string, so
        // an opt-in module stays OFF and an opt-out module stays ON — which is
        // the safe direction in both cases. Pinned so a future refactor to
        // something looser (a truthiness check, a case-insensitive compare)
        // cannot quietly switch a live-radio or billing module on.
        for (const junk of ['True', 'TRUE', '1', 'yes', 'on', '']) {
          const f = await featuresWith({ [env]: junk });
          expect(f[key as keyof typeof f], `${env}=${JSON.stringify(junk)}`).toBe(
            dflt === 'on',
          );
        }
      });
    });
  }
});
