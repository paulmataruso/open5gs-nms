import * as fs from 'fs';
import * as path from 'path';
import {
  PATCH_FINGERPRINTS,
  probeArgv,
  probeMatches,
  verifiablePatches,
  KAMAILIO_MODULE_DIR,
  type DisasmProbe,
  type SymbolProbe,
  type StringProbe,
} from '../kamailio-patch-fingerprints';

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf-8');

/**
 * The structural half of this test is the point: every patch the build
 * pipeline applies must be classified here, either with a probe or with a
 * stated reason it has none. That is what stops the gap this module exists
 * to close from quietly reopening -- a new patch added to the pipeline and
 * to nothing else is exactly how an unverifiable artifact got deployed four
 * times.
 */
describe('patch fingerprint coverage', () => {
  // Same derivation the revision test uses: read the names the pipeline
  // actually interpolates rather than restating a list that can drift.
  // CMD_C_PATCH_KAMAILIO6 does not end in `_PATCH`, so a naive /_PATCH\}/
  // match silently undercounts by one.
  const applied = [...new Set(
    [...read('application/use-cases/kamailio-source-build.ts')
      .matchAll(/\$\{([A-Z0-9_]*PATCH[A-Z0-9_]*)\}/g)].map((m) => m[1]),
  )].sort();

  it('derives a real patch set from the pipeline', () => {
    expect(applied.length).toBeGreaterThanOrEqual(8);
  });

  it('classifies every patch the pipeline applies', () => {
    expect(Object.keys(PATCH_FINGERPRINTS).sort()).toEqual(applied);
  });

  it('gives every unprobeable patch a stated reason', () => {
    // An unexplained gap reads as an oversight, and the next person deletes
    // it or trusts it. Both are worse than a recorded limitation.
    for (const [name, fp] of Object.entries(PATCH_FINGERPRINTS)) {
      if (fp.kind !== 'unverifiable') continue;
      expect({ name, long: fp.reason.length > 40 }).toEqual({ name, long: true });
    }
  });

  it('can check the two patches whose probes were confirmed against real artifacts', () => {
    // Both verified on this deployment: the symbol is absent from the
    // pre-swap snapshot of the fourth recurrence, and the instruction was
    // read out of the live cdp.so.
    expect(verifiablePatches()).toContain('CDP_COMMON_C_PATCH');
    expect(verifiablePatches()).toContain('CDP_MOD_C_PATCH');
    expect(PATCH_FINGERPRINTS.CDP_COMMON_C_PATCH).toEqual({
      kind: 'symbol', module: 'cdp.so', symbol: 'get_cc_request_type',
    });
    const mod = PATCH_FINGERPRINTS.CDP_MOD_C_PATCH as DisasmProbe;
    expect(mod.kind).toBe('disasm');
    expect(mod.insn).toContain('$0x3');
  });

  it('is honest that the pair behind the 2026-09-30 outage cannot be checked', () => {
    // If a future change makes these probeable, this assertion is what
    // brings someone back here to say so.
    for (const name of ['CCR_C_PATCH', 'IMS_RO_C_PATCH']) {
      expect(PATCH_FINGERPRINTS[name].kind).toBe('unverifiable');
    }
  });
});

describe('probeArgv', () => {
  it('reads symbols, strings and disassembly with the right tool', () => {
    const dir = KAMAILIO_MODULE_DIR;
    expect(probeArgv(PATCH_FINGERPRINTS.CDP_COMMON_C_PATCH as SymbolProbe))
      .toEqual({ cmd: 'nm', args: ['--defined-only', `${dir}/cdp.so`] });
    expect(probeArgv(PATCH_FINGERPRINTS.SAVE_C_PATCH as StringProbe))
      .toEqual({ cmd: 'strings', args: [`${dir}/ims_registrar_pcscf.so`] });
    expect(probeArgv(PATCH_FINGERPRINTS.CDP_MOD_C_PATCH as DisasmProbe))
      .toEqual({ cmd: 'objdump', args: ['-d', '--no-show-raw-insn', `${dir}/cdp.so`] });
  });

  it('honours an override directory, for probing a snapshot', () => {
    const { args } = probeArgv(PATCH_FINGERPRINTS.CDP_COMMON_C_PATCH as SymbolProbe, '/snap/modules-dir');
    expect(args[1]).toBe('/snap/modules-dir/cdp.so');
  });
});

describe('probeMatches: symbol', () => {
  const p = PATCH_FINGERPRINTS.CDP_COMMON_C_PATCH as SymbolProbe;

  it('finds the symbol in real nm output', () => {
    expect(probeMatches(p, '0000000000027500 T cdp_init\n0000000000031a20 T get_cc_request_type\n')).toBe(true);
  });

  it('reports a build without it', () => {
    // This is the pre-swap snapshot of the fourth recurrence.
    expect(probeMatches(p, '0000000000027500 T cdp_init\n0000000000031a20 T get_avp_list\n')).toBe(false);
  });

  it('does not accept a longer symbol that merely contains it', () => {
    // A rename would otherwise read as "patch present".
    expect(probeMatches(p, '0000000000031a20 T get_cc_request_type_v2\n')).toBe(false);
    expect(probeMatches(p, '0000000000031a20 T my_get_cc_request_type\n')).toBe(false);
  });
});

describe('probeMatches: string', () => {
  const p = PATCH_FINGERPRINTS.SAVE_C_PATCH as StringProbe;

  it('finds the added text', () => {
    expect(probeMatches(p, 'some other literal\nvia-based fallback search\n')).toBe(true);
  });

  it('reports an unpatched module', () => {
    expect(probeMatches(p, 'some other literal\ncontact not found\n')).toBe(false);
  });
});

describe('probeMatches: disasm', () => {
  const p = PATCH_FINGERPRINTS.CDP_MOD_C_PATCH as DisasmProbe;
  const fn = (body: string): string =>
    `0000000000027500 <cdp_init>:\n${body}\n\n0000000000028000 <cdp_child_init>:\n   28000:\tret\n`;

  it('accepts the patched reservation', () => {
    expect(probeMatches(p, fn(
      '   275c0:\tmov    %rbx,%rdi\n'
      + '   275c5:\tadd    $0x3,%eax\n'
      + '   275c8:\tcall   1a80 <register_procs@plt>\n',
    ))).toBe(true);
  });

  it('reports the stock reservation', () => {
    expect(probeMatches(p, fn(
      '   275c5:\tadd    $0x2,%eax\n'
      + '   275c8:\tcall   1a80 <register_procs@plt>\n',
    ))).toBe(false);
  });

  it('ignores a matching instruction in a different function', () => {
    // The whole reason the probe scopes to one body first: a 2MB
    // disassembly contains `add $0x3` in many places, none of which say
    // anything about cdp's process-slot reservation.
    //
    // The ORDER here is what gives this test teeth. The decoy function and
    // its own register_procs call come FIRST, so an unscoped search finds
    // that call before cdp_init's and reads the decoy's `add $0x3` as
    // evidence. Putting the decoy after cdp_init instead makes the test pass
    // whether or not the probe scopes at all -- which is exactly how it was
    // written first, and a mutation removing the scoping survived it.
    const decoyFirst = '0000000000029000 <other_fn>:\n'
      + '   29004:\tadd    $0x3,%eax\n'
      + '   29008:\tcall   1a80 <register_procs@plt>\n\n'
      + '0000000000027500 <cdp_init>:\n'
      + '   275c0:\tmov    %rbx,%rdi\n'
      + '   275c8:\tcall   1a80 <register_procs@plt>\n';
    expect(probeMatches(p, decoyFirst)).toBe(false);
  });

  it('ignores the instruction when it is too far from the call', () => {
    const far = Array.from({ length: 10 }, (_, i) => `   275${i}0:\tnop\n`).join('');
    expect(probeMatches(p, fn(
      '   275c5:\tadd    $0x3,%eax\n' + far + '   275f0:\tcall   1a80 <register_procs@plt>\n',
    ))).toBe(false);
  });

  it('reports a module where the function is absent entirely', () => {
    expect(probeMatches(p, '0000000000029000 <unrelated>:\n   29004:\tret\n')).toBe(false);
  });

  it('reports a function that never calls the reservation at all', () => {
    expect(probeMatches(p, fn('   275c5:\tadd    $0x3,%eax\n   275c8:\tret\n'))).toBe(false);
  });

  it('stops at the end of the function, not the end of the file', () => {
    // Scoping to where the function STARTS is not enough: the body has to
    // end too. Here cdp_init never calls register_procs, and a later
    // function does with `add $0x3` right before it. Reading to end-of-file
    // finds that call and reports the patch present in the wrong function
    // entirely -- a mutation dropping only the body boundary survived every
    // other fixture here, because in each of those the decoy either precedes
    // cdp_init (so the scan start skips it) or cdp_init has no call at all.
    const decoyAfter = '0000000000027500 <cdp_init>:\n'
      + '   275c0:\tmov    %rbx,%rdi\n'
      + '   275c4:\tret\n\n'
      + '0000000000029000 <other_fn>:\n'
      + '   29004:\tadd    $0x3,%eax\n'
      + '   29008:\tcall   1a80 <register_procs@plt>\n';
    expect(probeMatches(p, decoyAfter)).toBe(false);
  });
});
