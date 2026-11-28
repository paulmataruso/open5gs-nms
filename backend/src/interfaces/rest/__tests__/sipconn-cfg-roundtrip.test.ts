import { osmoSipConnectorCfg } from '../../../application/use-cases/osmo-sip-connector-build';
import * as fs from 'fs';
import * as path from 'path';

/**
 * /etc/osmocom/osmo-sip-connector.cfg is written by TWO modules, each with a
 * full overwrite rather than a merge:
 *
 *   - gsm-controller.ts, from the GSM page's SIP tab, regenerating from its
 *     own state file (state.sip.{localIp,localPort,remoteHost,remotePort});
 *   - asterisk-2g-controller.ts, from its own Configure, because being
 *     osmo-sip-connector's "remote" peer is the entire purpose of that module.
 *
 * Nothing merges, so the two are held together only by a round-trip: whatever
 * Asterisk-2G writes must be exactly what GSM would REGENERATE from the state
 * Asterisk-2G leaves behind. If that breaks, the next unrelated visit to the
 * SIP tab silently reverts the 2G voice wiring and no error is raised anywhere
 * -- a comment in asterisk-2g-controller.ts records that this has been a real
 * concern ("the live osmo-sip-connector.cfg and the SIP tab's own (stale) form
 * state would silently disagree").
 *
 * gsm-controller.ts has already had a bug of this family: a comment there
 * records that the restore-reapply path never regenerated this file at all.
 *
 * The round-trip holds today. These tests exist so it keeps holding, because
 * it depends on three separate things staying aligned: the state field names
 * Asterisk-2G READS, the ones it WRITES BACK, and both modules using the one
 * shared generator rather than a local copy.
 */

const SRC = path.resolve(__dirname, '../../..');
const read = (f: string): string => fs.readFileSync(path.join(SRC, f), 'utf-8');

const GSM = 'interfaces/rest/gsm-controller.ts';
const A2G = 'interfaces/rest/asterisk-2g-controller.ts';

/** GSM's own local SIP endpoint, as its state file carries it. */
const GSM_LOCAL = { ip: '127.0.1.6', port: 5060 };
/** Asterisk-2G's bind address — it wires itself in as the remote. */
const A2G_BIND = { ip: '127.0.1.7', port: 5060 };

describe('the cfg both modules overwrite', () => {
  it('encodes the local and remote endpoints it was given', () => {
    const cfg = osmoSipConnectorCfg(GSM_LOCAL.ip, GSM_LOCAL.port, A2G_BIND.ip, A2G_BIND.port);
    expect(cfg).toContain(` local ${GSM_LOCAL.ip} ${GSM_LOCAL.port}\n`);
    expect(cfg).toContain(` remote ${A2G_BIND.ip} ${A2G_BIND.port}\n`);
  });

  it('keeps local and remote distinct — a swap must be visible', () => {
    // Both endpoints are loopback addresses one digit apart on this
    // deployment, so a transposed argument pair is an easy mistake that would
    // otherwise produce a plausible-looking file.
    const right = osmoSipConnectorCfg(GSM_LOCAL.ip, GSM_LOCAL.port, A2G_BIND.ip, A2G_BIND.port);
    const swapped = osmoSipConnectorCfg(A2G_BIND.ip, A2G_BIND.port, GSM_LOCAL.ip, GSM_LOCAL.port);
    expect(swapped).not.toBe(right);
  });
});

describe('Asterisk-2G\'s write survives a later GSM regeneration', () => {
  it('round-trips byte-identically through GSM\'s state', () => {
    // What Asterisk-2G writes: GSM's local (read from state) + its own bind.
    const writtenByA2g = osmoSipConnectorCfg(
      GSM_LOCAL.ip, GSM_LOCAL.port, A2G_BIND.ip, A2G_BIND.port,
    );

    // What Asterisk-2G then records back into GSM's state file, merged over
    // whatever was already there (updateGsmSipRemote writes ONLY the remote).
    const stateAfter = {
      sip: {
        localIp: GSM_LOCAL.ip,
        localPort: GSM_LOCAL.port,
        remoteHost: A2G_BIND.ip,
        remotePort: A2G_BIND.port,
      },
    };

    // What GSM would regenerate on the operator's next visit to the SIP tab,
    // reading only its own state.
    const regeneratedByGsm = osmoSipConnectorCfg(
      stateAfter.sip.localIp, stateAfter.sip.localPort,
      stateAfter.sip.remoteHost, stateAfter.sip.remotePort,
    );

    // The whole point: a later, unrelated GSM save must not revert 2G voice.
    expect(regeneratedByGsm).toBe(writtenByA2g);
  });

  it('would NOT round-trip if the remote were never written back', () => {
    // Guards the assertion above against being vacuous. Had Asterisk-2G
    // skipped updateGsmSipRemote, GSM's state would still hold the old remote
    // and its next regeneration would overwrite the wiring -- this is the
    // failure the round-trip is protecting against, shown explicitly.
    const writtenByA2g = osmoSipConnectorCfg(
      GSM_LOCAL.ip, GSM_LOCAL.port, A2G_BIND.ip, A2G_BIND.port,
    );
    const staleRegen = osmoSipConnectorCfg(
      GSM_LOCAL.ip, GSM_LOCAL.port, '192.0.2.50', 5060,
    );
    expect(staleRegen).not.toBe(writtenByA2g);
  });
});

describe('the three things the round-trip depends on', () => {
  it('both modules use the one shared generator, not a local copy', () => {
    // A second copy of this generator is how the two writers would drift on
    // syntax -- the same defect already fixed for named.conf.local's zone
    // helpers and dispatcher.list's entry line.
    for (const f of [GSM, A2G]) {
      expect(read(f)).toMatch(/osmoSipConnectorCfg[\s\S]{0,400}?from '\.\.\/\.\.\/application\/use-cases\/osmo-sip-connector-build'/);
    }
    const defs = [GSM, A2G, 'application/use-cases/osmo-sip-connector-build.ts']
      .map((f) => (read(f).match(/function osmoSipConnectorCfg\b/g) ?? []).length);
    // Defined exactly once, in the build module.
    expect(defs).toEqual([0, 0, 1]);
  });

  it('Asterisk-2G reads the local endpoint from GSM\'s own state', () => {
    // If it ever derived the local address itself, the file it writes would
    // stop matching what GSM regenerates from state.
    const a2g = read(A2G);
    const fn = a2g.slice(a2g.indexOf('function readGsmSipPeer'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('state?.sip?.localIp');
    expect(body).toContain('state?.sip?.localPort');
  });

  it('Asterisk-2G writes the remote back under the names GSM reads', () => {
    const a2g = read(A2G);
    const fn = a2g.slice(a2g.indexOf('function updateGsmSipRemote'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('remoteHost');
    expect(body).toContain('remotePort');
    // Merged over the existing sip object, never replacing it -- otherwise
    // localIp/localPort would be dropped and GSM would regenerate 0.0.0.0.
    expect(body).toMatch(/\.\.\.\(state\.sip \?\? \{\}\)/);
  });

  it('GSM reads back exactly those four field names', () => {
    const gsm = read(GSM);
    for (const field of ['localIp', 'localPort', 'remoteHost', 'remotePort']) {
      expect(gsm).toContain(`current.${field}`);
    }
  });
});

describe('the 0.0.0.0 interlock between the two modules', () => {
  it('GSM may default its local address to the wildcard', () => {
    // Legitimate for a listener, and this is the value a fresh deployment has.
    expect(read(GSM)).toContain("|| '0.0.0.0'");
  });

  it('Asterisk-2G refuses to configure against that wildcard', () => {
    // A "remote" of 0.0.0.0 is not a destination, so Asterisk-2G gates on a
    // concrete address and tells the operator to set the SIP tab first,
    // instead of writing a cfg that cannot work.
    const a2g = read(A2G);
    const fn = a2g.slice(a2g.indexOf('function readGsmSipPeer'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain("ip === '0.0.0.0'");
    expect(a2g).toMatch(/no concrete local SIP address configured yet/);
  });
});
