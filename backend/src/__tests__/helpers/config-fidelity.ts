/**
 * A reusable harness for "does what the UI set actually reach the config file".
 *
 * Nearly everything configured in this NMS ends up as text in a config file on
 * the host, and the generators that produce that text are the narrowest place
 * to check the whole chain. Two bugs recur in them, and both are invisible in a
 * passing build:
 *
 *   LEAK   -- a value is hardcoded, or one of several occurrences was missed,
 *             so changing it in the UI leaves the old value behind. The file
 *             stays syntactically valid and half of it points somewhere real.
 *             A found example: scscfIncludeCfg() read the PLMN for its Ro
 *             fields off the host's mme.yaml instead of its own parameters, so
 *             one file could name two different PLMNs.
 *
 *   INERT  -- a field is accepted and then never used, so the operator sets it
 *             and nothing happens. Also what an impure generator looks like
 *             from outside: the parameter changes and the output does not,
 *             because the value is really coming from somewhere else.
 *
 * Writing those two assertions by hand for every field of every generator
 * would be thousands of lines that rot. So a module declares ONE spec per
 * generator and this derives both checks for every field automatically. Adding
 * a field to a generator and forgetting to list it here is itself caught, by
 * the completeness test.
 *
 * WHAT THIS CANNOT DO, stated plainly so it is not mistaken for full coverage:
 * it only sees values that are PARAMETERS. A value the generator reads from
 * somewhere else entirely and that no parameter controls is invisible here --
 * the only reason the PLMN defect was catchable is that `imsDomain` was a
 * parameter whose change left `RO_MCC` behind. Proving the rest of the chain
 * (UI -> API -> the file on disk -> the running daemon) needs a fidelity test
 * at that level; this is the innermost link, not the whole chain.
 */

export interface FidelitySpec<P extends object> {
  /** How the file is known to an operator, e.g. 'ims/scscf.cfg'. */
  readonly name: string;
  readonly generate: (p: P) => string;
  /** A realistic, complete parameter set. Prefer a deployment's real values. */
  readonly baseline: P;
  /**
   * One DIFFERENT value per field. Every field of `baseline` should appear, or
   * be listed in `exempt` with a reason -- the completeness test enforces that,
   * so a newly added field cannot be silently skipped.
   */
  readonly variants: Partial<{ [K in keyof P]: P[K] }>;
  /**
   * Fields deliberately not varied, each with the reason. Use sparingly: a
   * field that cannot be varied usually means it does not belong in the
   * parameter object.
   */
  readonly exempt?: Partial<Record<keyof P, string>>;
  /**
   * Fields whose value legitimately does not appear verbatim in the output,
   * each with the reason -- a boolean that only gates a block, or a value the
   * generator transforms. These skip the leak check but still get the inert
   * check, because a field that changes nothing at all is still a bug.
   */
  readonly notVerbatim?: Partial<Record<keyof P, string>>;
}

/** Every primitive reachable in a value, as it would appear in text. */
function primitives(v: unknown, out: string[] = []): string[] {
  if (v === null || v === undefined) return out;
  if (typeof v === 'string') { out.push(v); return out; }
  if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v)); return out; }
  if (Array.isArray(v)) { for (const x of v) primitives(x, out); return out; }
  if (typeof v === 'object') { for (const x of Object.values(v)) primitives(x, out); return out; }
  return out;
}

/**
 * A value is only usable for a leak check if it is distinctive enough that
 * finding it in the output means something. `true`, `0`, `1` and very short
 * strings occur incidentally all over a config file.
 */
function usableForLeakCheck(s: string): boolean {
  if (s === 'true' || s === 'false') return false;
  return s.length >= 4;
}

export function describeConfigFidelity<P extends object>(spec: FidelitySpec<P>): void {
  const keys = Object.keys(spec.variants) as (keyof P)[];

  describe(`${spec.name}: every configured value reaches the file`, () => {
    test('is deterministic -- the same inputs give the same bytes', () => {
      expect(spec.generate(spec.baseline)).toBe(spec.generate(spec.baseline));
    });

    test('every parameter is either varied or exempt with a reason', () => {
      const declared = new Set<string>([
        ...keys.map(String),
        ...Object.keys(spec.exempt ?? {}),
      ]);
      const missing = Object.keys(spec.baseline).filter((k) => !declared.has(k));
      // Named in the failure so the fix is obvious: add a variant, or an
      // exemption saying why the field cannot be varied.
      expect(missing).toEqual([]);
    });

    describe.each(keys.map((k) => [String(k), k] as const))('%s', (label, key) => {
      const variantParams = { ...spec.baseline, [key]: spec.variants[key] } as P;

      test('changing it changes the generated file', () => {
        const before = spec.generate(spec.baseline);
        const after = spec.generate(variantParams);
        // A field that changes nothing is either unused, or the value is
        // really coming from somewhere other than this parameter.
        expect(after).not.toBe(before);
      });

      const skipReason = spec.notVerbatim?.[key];
      const oldValues = primitives(spec.baseline[key]).filter(usableForLeakCheck);
      const newValues = primitives(spec.variants[key]).filter(usableForLeakCheck);

      const shouldLeakCheck = !skipReason && oldValues.length > 0;
      /**
       * Counted, not merely searched for.
       *
       * Asserting the old value is ABSENT is wrong, because a value can
       * legitimately appear somewhere this field does not control -- the real
       * case that taught this: varying the OCS peer port 3868 -> 3870 in
       * scscf.xml leaves a 3868 behind, because the file also carries an HSS
       * peer on the standard Diameter port. The OCS port had changed correctly.
       *
       * What distinguishes a hardcoded field from a shared value is whether
       * ANY occurrence went away. Honoured: the count drops. Hardcoded or
       * ignored: the count is unchanged. That tolerates a shared value without
       * weakening the check the harness exists for.
       */
      (shouldLeakCheck ? test : test.skip)('at least one occurrence of the old value is replaced', () => {
        const before = spec.generate(spec.baseline);
        const after = spec.generate(variantParams);
        for (const old of oldValues) {
          if (newValues.includes(old)) continue;
          const was = before.split(old).length - 1;
          const now = after.split(old).length - 1;
          if (now >= was) {
            throw new Error(
              `${spec.name}: changing ${label} left every occurrence of "${old}" in place `
              + `(${was} before, ${now} after). Either the value is hardcoded, or one of its `
              + `occurrences was missed. Generated file:\n${after}`);
          }
        }
      });

      (shouldLeakCheck ? test : test.skip)('the new value is actually present', () => {
        const after = spec.generate(variantParams);
        for (const nv of newValues) {
          expect(`${spec.name} is missing the new ${label}: ${after}`).toContain(nv);
        }
      });
    });
  });
}
