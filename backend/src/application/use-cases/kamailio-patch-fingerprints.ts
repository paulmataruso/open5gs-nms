/**
 * Does the .so on disk actually CONTAIN the patch we think it does?
 *
 * `KAMAILIO_PATCH_REV` answers a different and weaker question. It is a
 * ledger: a successful build stamps an integer, and status compares that
 * integer with a constant. It never looks at an artifact, so it cannot see
 * the failure this project has hit four times -- a module deployed by an
 * earlier run of the build script, predating a patch the script has since
 * gained. The worst of those left every IMS call failing on both 4G and 5G
 * for about 24 hours while registration kept working, so it presented as a
 * vague "IMS is broken" with no single obvious cause. Bumping the rev is
 * also a thing a human has to remember, so the ledger relocates the bug
 * rather than closing it.
 *
 * A fingerprint asks the artifact instead. Each entry below names something
 * the compiled module must contain IF its patch was applied, chosen because
 * it is absent from an unpatched build of the same source.
 *
 * Three facts make this feasible here, all verified on this deployment
 * rather than assumed:
 *
 *   - The deployed modules are NOT stripped (`cdp.so` and `ims_charging.so`
 *     both report "with debug_info, not stripped"), so symbol and
 *     disassembly probes are available, not just strings.
 *   - A symbol probe demonstrably detects the real historical outage.
 *     `get_cc_request_type` is a function CDP_COMMON_C_PATCH adds, and
 *     walking the pre-swap build snapshots shows it present on
 *     2026-10-01T06-46, ABSENT again on 2026-10-02T07-02, and present on
 *     2026-10-11. Snapshots hold the state a build REPLACED, so the absence
 *     on 2026-10-02 is the stale cdp.so of the fourth recurrence, caught by
 *     this exact check.
 *   - A patch that only changes an integer literal can never be found by
 *     `strings`. CDP_MOD_C_PATCH raises cdp's process-slot reservation from
 *     2 to 3, which is visible solely as `add $0x3` before the
 *     `register_procs` call in `cdp_init` -- confirmed live at
 *     cdp.so+0x275c5.
 *
 * Deliberately NOT exhaustive, and the gaps are recorded as data rather than
 * omitted. Four patches have no probe that survives contact with reality,
 * and the two most consequential are among them: CCR_C_PATCH and
 * IMS_RO_C_PATCH mostly REMOVE AVP calls, and what they add is an indirect
 * call through `cdp_avp->base`, so nothing distinctive reaches either the
 * string table or the symbol table. Those two are precisely the pair behind
 * the 24-hour outage. Making them verifiable means giving each patch a
 * distinctive marker string of its own, which changes what gets compiled
 * into a live, working IMS -- a deliberate decision for an operator to take,
 * not a side effect of adding a check. Recording them as `unverifiable` with
 * the reason keeps the gap visible and keeps the accompanying test honest
 * about what this module can and cannot promise.
 *
 * Nothing here executes anything. These are pure descriptions; running them
 * is the caller's business.
 */

/** Where the source build installs its modules. */
export const KAMAILIO_MODULE_DIR = '/usr/lib/x86_64-linux-gnu/kamailio/modules';

export interface SymbolProbe {
  kind: 'symbol';
  module: string;
  /** A function the patch introduces; absent from an unpatched build. */
  symbol: string;
}

export interface StringProbe {
  kind: 'string';
  module: string;
  /** Literal text the patch introduces. */
  needle: string;
}

export interface DisasmProbe {
  kind: 'disasm';
  module: string;
  /** The function whose body carries the change. */
  fn: string;
  /** An instruction that must appear within `window` lines before `before`. */
  insn: string;
  before: string;
  window: number;
}

export interface Unverifiable {
  kind: 'unverifiable';
  /** Why no probe exists. Required: an unexplained gap reads as an oversight. */
  reason: string;
}

export type PatchFingerprint = SymbolProbe | StringProbe | DisasmProbe | Unverifiable;

/**
 * One entry per patch in the pipeline. The accompanying test asserts this
 * key set equals the set the build pipeline actually interpolates, so a new
 * patch cannot be added without either giving it a probe or stating why it
 * has none.
 */
export const PATCH_FINGERPRINTS: Record<string, PatchFingerprint> = {
  // Adds get_cc_request_type() to cdp's common.c. Verified: 1 hit in the
  // live cdp.so, 0 in the pre-swap snapshots from 2026-10-02 and earlier.
  CDP_COMMON_C_PATCH: { kind: 'symbol', module: 'cdp.so', symbol: 'get_cc_request_type' },

  // Raises the reserved process slots from 2 to 3. Integer literal only, so
  // strings and nm are both blind to it; the instruction is the signal.
  CDP_MOD_C_PATCH: {
    kind: 'disasm',
    module: 'cdp.so',
    fn: 'cdp_init',
    insn: 'add    $0x3,%eax',
    before: 'register_procs',
    window: 4,
  },

  // Adds a via-based fallback contact search to ims_registrar_pcscf's
  // save.c. Verified: 3 hits live, 0 in the apt-packaged original, so the
  // string is specific to the patch rather than ambient in the module.
  SAVE_C_PATCH: {
    kind: 'string',
    module: 'ims_registrar_pcscf.so',
    needle: 'via-based fallback search',
  },

  // Calls get_cc_request_type() from acctstatemachine.c. Its own additions
  // are a call and a branch through existing helpers, so nothing new reaches
  // the string or symbol tables. The CDP_COMMON symbol above proves the
  // function exists in the same artifact but NOT that this call site was
  // patched -- and a half-applied pair is exactly the fourth recurrence, so
  // inferring one from the other is the mistake that failure teaches against.
  CDP_ACCTSM_C_PATCH: {
    kind: 'unverifiable',
    reason:
      'adds only a call to get_cc_request_type() and a branch; no new string or symbol. '
      + 'CDP_COMMON_C_PATCH sharing the artifact does not imply this call site was patched.',
  },

  // Removes Accounting-Record-Type/Number and Vendor-Specific-Application-Id
  // from the CCR and adds Auth-Application-Id. Every one of those goes
  // through cdp_avp->base, an indirect call, so there is no symbol to find
  // and no literal added. One half of the pair behind the 24-hour outage.
  CCR_C_PATCH: {
    kind: 'unverifiable',
    reason:
      'the change is removed AVP calls plus one indirect call via cdp_avp->base; '
      + 'nothing distinctive reaches the string or symbol table. Behind the 2026-09-30 outage.',
  },

  IMS_RO_C_PATCH: {
    kind: 'unverifiable',
    reason:
      'same shape as CCR_C_PATCH -- AVP call-site edits through cdp_avp->base only. '
      + 'The other half of the pair behind the 2026-09-30 outage.',
  },

  // The "No security parameters found in contact" text is present in BOTH a
  // patched and an unpatched module (measured: 2 hits in the apt original, 6
  // live), so it discriminates nothing. A count threshold would be a guess
  // about compiler inlining, not a measurement.
  CMD_C_PATCH_KAMAILIO6: {
    kind: 'unverifiable',
    reason:
      'its candidate string occurs in the unpatched module too, so presence proves nothing; '
      + 'a hit-count threshold would encode an assumption about inlining rather than a fact.',
  },

  // "security-verify header" is present live and absent from the 5.8.8 apt
  // original -- but the comparison that matters is against stock 6.0.8,
  // which is not on this host, and the two differ by far more than this
  // patch. Treated as unproven rather than claimed.
  SECVERIFY_C_PATCH: {
    kind: 'unverifiable',
    reason:
      'its candidate string is absent from the 5.8.8 apt build but stock 6.0.8 was never '
      + 'compared, and 5.8.8-vs-6.0.8 differs for unrelated reasons, so a hit proves nothing.',
  },
};

/** The command that collects evidence for a probe. Pure; runs nothing. */
export function probeArgv(p: SymbolProbe | StringProbe | DisasmProbe, dir = KAMAILIO_MODULE_DIR): {
  cmd: string;
  args: string[];
} {
  const target = `${dir}/${p.module}`;
  switch (p.kind) {
    case 'symbol': return { cmd: 'nm', args: ['--defined-only', target] };
    case 'string': return { cmd: 'strings', args: [target] };
    case 'disasm': return { cmd: 'objdump', args: ['-d', '--no-show-raw-insn', target] };
  }
}

/** Whether the collected evidence shows the patch present. */
export function probeMatches(p: SymbolProbe | StringProbe | DisasmProbe, stdout: string): boolean {
  switch (p.kind) {
    case 'symbol':
      // Whole-word: a longer symbol that merely contains this one must not
      // count, or a rename to get_cc_request_type_v2 would read as present.
      return new RegExp(`(^|\\s)${p.symbol}($|\\s)`, 'm').test(stdout);
    case 'string':
      return stdout.includes(p.needle);
    case 'disasm': {
      // Scope to the one function first. objdump labels a function
      // `<name>:` and separates bodies with a blank line, so a match found
      // anywhere else in a 2MB disassembly is not evidence about this
      // function at all.
      const start = stdout.indexOf(`<${p.fn}>:`);
      if (start < 0) return false;
      const body = stdout.slice(start).split('\n\n')[0].split('\n');
      const callAt = body.findIndex((l) => l.includes(p.before));
      if (callAt < 0) return false;
      return body
        .slice(Math.max(0, callAt - p.window), callAt)
        .some((l) => l.includes(p.insn));
    }
  }
}

/** Patches this module can actually check, and those it cannot. */
export function verifiablePatches(): string[] {
  return Object.keys(PATCH_FINGERPRINTS)
    .filter((k) => PATCH_FINGERPRINTS[k].kind !== 'unverifiable')
    .sort();
}
