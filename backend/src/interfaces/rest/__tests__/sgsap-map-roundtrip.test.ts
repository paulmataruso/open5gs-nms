import {
  sgsapYamlBlock, extractExistingMapEntries, mergeMapEntry, type SgsMapEntry,
} from '../sms-controller';

/**
 * The SGs-AP TAI->LAI map round trip inside mme.yaml.
 *
 * Open5GS expresses multiple mappings -- one per PLMN -- as *repeated* `map:`
 * sibling keys inside one sgsap client entry. That is not ordinary YAML:
 * js-yaml collapses duplicate keys to the last one, so a document with three
 * PLMNs parses as one. Open5GS's own mme-context.c increments map_num on every
 * `map:` key it meets, which is why the generator emits them that way and why
 * reading them back needs convertRepeatedMapKeysToArray() first. CLAUDE.md
 * records the matching past bug: "SGs-AP `map` is an object, not an array".
 *
 * The round trip matters because /configure does a full-section replace: it
 * reads the existing entries, merges one PLMN in, and writes the whole section
 * back. Anything the read loses is deleted from the live mme.yaml -- so a
 * second PLMN's SGs mapping disappears the next time the first one is
 * configured. Three pure functions, no test between them.
 */

const ONE: SgsMapEntry = { mcc: '001', mnc: '01', tac: 1 };

/** Round trip: generate the block, then read it back. */
const back = (entries: SgsMapEntry[], mscIp = '127.0.0.2', mmeIp = '127.0.0.1'): SgsMapEntry[] =>
  extractExistingMapEntries(sgsapYamlBlock(mscIp, mmeIp, entries));

describe('the generated block is what Open5GS expects', () => {
  it('emits one REPEATED map: key per entry, never a maps: sequence', () => {
    // An array is the natural thing to write and is the recorded past bug:
    // Open5GS's parser counts `map:` keys, so a sequence yields zero mappings
    // and SGs SMS silently never works.
    const out = sgsapYamlBlock('127.0.0.2', '127.0.0.1', [
      { mcc: '001', mnc: '01', tac: 1 },
      { mcc: '310', mnc: '260', tac: 7 },
    ]);
    expect(out.match(/^\s*map:\s*$/gm)).toHaveLength(2);
    expect(out).not.toMatch(/^\s*maps:/m);
    expect(out).not.toMatch(/^\s*-\s+tai:/m);
  });

  it('mirrors tac into lac, which is what makes the mapping a mapping', () => {
    const out = sgsapYamlBlock('127.0.0.2', '127.0.0.1', [{ mcc: '001', mnc: '01', tac: 42 }]);
    expect(out).toContain('tac: 42');
    expect(out).toContain('lac: 42');
  });

  it('omits local_address entirely when there is no MME address', () => {
    // An empty value would be emitted as `local_address:` with nothing after
    // it, which parses as null and is not the same as absent.
    const withIp = sgsapYamlBlock('127.0.0.2', '127.0.0.1', [ONE]);
    const without = sgsapYamlBlock('127.0.0.2', '', [ONE]);
    expect(withIp).toContain('local_address: 127.0.0.1');
    expect(without).not.toContain('local_address');
    expect(without).toContain('port: 29118');
  });

  it('stays nested under mme: at a 2-space indent', () => {
    // The block is spliced into mme.yaml, so its own indentation is what keeps
    // it inside the mme: mapping rather than at document root.
    const out = sgsapYamlBlock('127.0.0.2', '127.0.0.1', [ONE]);
    expect(out.startsWith('  sgsap:\n')).toBe(true);
    expect(out).toContain('    client:\n');
    expect(out).toContain('      - address: 127.0.0.2');
  });
});

describe('reading it back preserves the MNC and MCC WIDTH', () => {
  it('keeps a 2-digit MNC as two digits', () => {
    // yaml.load() turns `mnc: 01` into the number 1, and the width cannot be
    // recovered from a number -- 01 and 001 are different networks. The reader
    // regex-scans the raw text for this reason.
    expect(back([ONE])).toEqual([ONE]);
    expect(back([ONE])[0].mnc).toBe('01');
  });

  it('keeps a leading-zero 3-digit MNC, the case this deployment used to run', () => {
    // This host ran MNC 070 before migrating to 01.
    const old: SgsMapEntry = { mcc: '999', mnc: '070', tac: 1 };
    expect(back([old])).toEqual([old]);
  });

  it('keeps an MCC with leading zeros', () => {
    expect(back([{ mcc: '001', mnc: '01', tac: 1 }])[0].mcc).toBe('001');
  });

  it('handles an MNC that needs no padding at all', () => {
    expect(back([{ mcc: '310', mnc: '260', tac: 3 }])).toEqual([{ mcc: '310', mnc: '260', tac: 3 }]);
  });
});

describe('several PLMNs survive the round trip, each paired with its own TAC', () => {
  it('round-trips three distinct entries in order', () => {
    // The reader pairs values POSITIONALLY -- it takes mccMatches[i * 2],
    // relying on exactly two mcc occurrences per map block (tai and lai, equal
    // by construction). Three entries with all-different values is what
    // catches a skew in that arithmetic: a wrong stride still returns three
    // entries, just with the digits of its neighbours.
    const many: SgsMapEntry[] = [
      { mcc: '001', mnc: '01', tac: 1 },
      { mcc: '310', mnc: '260', tac: 7 },
      { mcc: '999', mnc: '070', tac: 4095 },
    ];
    expect(back(many)).toEqual(many);
  });

  it('is a fixed point: re-generating from what was read changes nothing', () => {
    const many: SgsMapEntry[] = [
      { mcc: '001', mnc: '01', tac: 1 },
      { mcc: '310', mnc: '260', tac: 7 },
    ];
    const once = sgsapYamlBlock('127.0.0.2', '127.0.0.1', many);
    expect(sgsapYamlBlock('127.0.0.2', '127.0.0.1', extractExistingMapEntries(once))).toBe(once);
  });

  it('reads the block out of a whole mme.yaml, stopping at the next sibling', () => {
    // How it is really called: on the entire live mme.yaml. extractSgsapBlock
    // takes everything indented deeper than `sgsap:` and stops at the first
    // line that is not -- so a sibling section following it must not be
    // swallowed into the block, and one preceding it must not be mistaken for
    // it.
    const many: SgsMapEntry[] = [
      { mcc: '001', mnc: '01', tac: 1 },
      { mcc: '310', mnc: '260', tac: 7 },
    ];
    const mmeYaml = `mme:
  freeDiameter: /etc/freeDiameter/mme.conf
  s1ap:
    server:
      - address: 10.0.1.175
  gtpc:
    server:
      - address: 127.0.0.2
${sgsapYamlBlock('127.0.0.2', '127.0.0.1', many)}  metrics:
    server:
      - address: 127.0.0.2
        port: 9090
`;
    expect(extractExistingMapEntries(mmeYaml)).toEqual(many);
  });

  it('returns nothing, rather than throwing, for text that is not an sgsap block', () => {
    // It is called on whatever the live mme.yaml holds, so malformed or absent
    // input has to be survivable -- an exception here would fail Configure.
    for (const junk of ['', 'mme:\n  s1ap:\n', '  sgsap:\n    client: []\n', 'not yaml: [']) {
      expect(extractExistingMapEntries(junk)).toEqual([]);
    }
  });
});

describe('mergeMapEntry keeps every other PLMN', () => {
  it('appends a PLMN that is not mapped yet', () => {
    const a: SgsMapEntry = { mcc: '001', mnc: '01', tac: 1 };
    const b: SgsMapEntry = { mcc: '310', mnc: '260', tac: 7 };
    expect(mergeMapEntry([a], b)).toEqual([a, b]);
  });

  it('updates a PLMN already mapped, in place, without duplicating it', () => {
    const a: SgsMapEntry = { mcc: '001', mnc: '01', tac: 1 };
    const b: SgsMapEntry = { mcc: '310', mnc: '260', tac: 7 };
    const merged = mergeMapEntry([a, b], { mcc: '001', mnc: '01', tac: 99 });
    expect(merged).toEqual([{ mcc: '001', mnc: '01', tac: 99 }, b]);
  });

  it('treats a different MNC width as a DIFFERENT PLMN', () => {
    // 01 and 001 are separate networks, so merging one must not overwrite the
    // other. This is the same width question as the reader's, on the key side.
    const two = mergeMapEntry([{ mcc: '001', mnc: '01', tac: 1 }], { mcc: '001', mnc: '001', tac: 2 });
    expect(two).toHaveLength(2);
  });

  it('does not mutate the array it was given', () => {
    const existing: SgsMapEntry[] = [{ mcc: '001', mnc: '01', tac: 1 }];
    const copy = [...existing];
    mergeMapEntry(existing, { mcc: '310', mnc: '260', tac: 7 });
    mergeMapEntry(existing, { mcc: '001', mnc: '01', tac: 9 });
    expect(existing).toEqual(copy);
  });
});

describe('the whole reason this round trip exists', () => {
  it('configuring one PLMN does not delete another PLMN mapping', () => {
    // The documented failure: /configure replaces the whole sgsap section, so
    // whatever the read drops is gone from the live mme.yaml. Here a second
    // PLMN is configured and the first has to still be there afterwards.
    const first: SgsMapEntry = { mcc: '001', mnc: '01', tac: 1 };
    const second: SgsMapEntry = { mcc: '310', mnc: '260', tac: 7 };

    const live = sgsapYamlBlock('127.0.0.2', '127.0.0.1', [first]);
    const next = sgsapYamlBlock(
      '127.0.0.2', '127.0.0.1',
      mergeMapEntry(extractExistingMapEntries(live), second),
    );

    expect(extractExistingMapEntries(next)).toEqual([first, second]);
    expect(next.match(/^\s*map:\s*$/gm)).toHaveLength(2);
    // And re-configuring the FIRST one again still leaves both.
    const again = sgsapYamlBlock(
      '127.0.0.2', '127.0.0.1',
      mergeMapEntry(extractExistingMapEntries(next), first),
    );
    expect(extractExistingMapEntries(again)).toEqual([first, second]);
  });
});
