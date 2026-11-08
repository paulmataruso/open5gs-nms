import { upsertVtyPathDirectives, ownedDirectivesFromGenerated } from '../vty-config-ownership';

// Regression guard for a real, reproduced-live config corruption
// (clean host, 2026-11-07): osmo-bsc refused to start at all with
//
//   There is no such command.
//   Error occurred during reading the below line:
//    meas-feed destination 127.0.0.1 8888
//   Failed to parse the config file: '/etc/osmocom/osmo-bsc.cfg'
//
// The generator put `meas-feed` under `network` and `mgw endpoint-domain`
// under `msc 0`, both correct for osmo-bsc 1.9.0 (verified against the real
// binary). The MERGE then moved them to the very end of the file, where the
// last node header happens to be `bsc` — so osmo-bsc parsed them as `bsc`
// directives, which do not exist there, and 2G was down.
//
// Mechanism: the append loop located its insertion point with
// `out.lastIndexOf(marker)`, where `marker` was the RAW TEXT of the last line
// of the target node. When that same line is also an owned directive, the main
// loop has already rewritten it (here `timer net T3212 5` -> `timer net T3212
// 2`), so the original text is no longer present in `out`, `lastIndexOf`
// returns -1, and the fallback `at = out.length - 1` appends at end of file.
//
// Mutation check: restore the `out.lastIndexOf(marker)` lookup and
// "inserts into the declared node even when that node's last line was
// rewritten" must fail.

const KEY_TOKENS = [
  { match: /^meas-feed destination\b/, tokens: 2 },
  { match: /^mgw remote-ip\b/, tokens: 2 },
  { match: /^encryption a5\b/, tokens: 2 },
  { match: /^ipa unit-id\b/, tokens: 2 },
];

/** Resolve each line's node path the way osmo-bsc's parser does. */
function nodeOf(text: string, needle: string): string[] {
  const lines = text.split('\n');
  const stack: Array<{ header: string; indent: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(\S.*)$/.exec(lines[i]);
    if (!m || m[2].startsWith('!')) continue;
    const ind = m[1].length;
    while (stack.length > 0 && ind <= stack[stack.length - 1].indent) stack.pop();
    if (m[2].trim() === needle) return stack.map(s => s.header);
    let j = i + 1;
    while (j < lines.length && !/^\s*\S/.test(lines[j])) j++;
    const nm = j < lines.length ? /^(\s*)\S/.exec(lines[j]) : null;
    if (nm && nm[1].length > ind) stack.push({ header: m[2].trim(), indent: ind });
  }
  return ['<not found>'];
}

// Shape of the real Ubuntu osmo-bsc package example: a `network` node whose
// LAST direct child is `timer net T3212 5`, and an `msc 0` node. No `bsc`
// node at all, which is why the NMS's own `bsc` block lands at the end.
const PACKAGE_EXAMPLE = `! osmo-bsc default configuration
!
e1_input
 e1_line 0 driver ipa
network
 network country code 1
 mobile network code 1
 encryption a5 0
 neci 1
 handover 0
 ! T3212 is in units of 6min
 timer net T3212 5
msc 0
 allow-emergency allow
 mgw remote-ip 127.0.0.1
 mgw remote-port 2427
`;

const GENERATED = `e1_input
 e1_line 0 driver ipa
network
 network country code 001
 mobile network code 01
 encryption a5 1 3
 neci 1
 handover 0
 timer net T3212 2
 meas-feed destination 127.0.0.1 8888
 meas-feed scenario nms
msc 0
 allow-emergency allow
 mgw remote-ip 127.0.0.1
 mgw remote-port 2427
 mgw endpoint-domain mgw
bsc
 mid-call-timeout 0
`;

describe('upsertVtyPathDirectives append placement', () => {
  const merged = upsertVtyPathDirectives(
    PACKAGE_EXAMPLE,
    ownedDirectivesFromGenerated(GENERATED, KEY_TOKENS),
  );

  it('inserts into the declared node even when that node\'s last line was rewritten', () => {
    // The exact failure: both meas-feed lines belong to `network`.
    expect(nodeOf(merged, 'meas-feed destination 127.0.0.1 8888')).toEqual(['network']);
    expect(nodeOf(merged, 'meas-feed scenario nms')).toEqual(['network']);
  });

  it('puts mgw endpoint-domain under msc 0, which is where osmo-bsc accepts it', () => {
    expect(nodeOf(merged, 'mgw endpoint-domain mgw')).toEqual(['msc 0']);
  });

  it('still applies the rewrite that caused the marker to disappear', () => {
    expect(merged).toContain('timer net T3212 2');
    expect(merged).not.toContain('timer net T3212 5');
  });

  it('never lands an owned directive in a node it was not declared for', () => {
    // The precise failure mode: appended lines ended up after the file's LAST
    // node header, whatever that happened to be. Being the final line is fine
    // when that line's own node is last (here `msc 0` is, so
    // `mgw endpoint-domain` legitimately ends the file) — what must never
    // happen is the path changing.
    for (const d of ownedDirectivesFromGenerated(GENERATED, KEY_TOKENS)) {
      if (d.line === null) continue;
      const where = nodeOf(merged, d.line);
      if (where[0] === '<not found>') continue;   // node absent, skipped by design
      expect(where).toEqual(d.path);
    }
  });

  it('preserves the operator lines the generator does not model', () => {
    expect(merged).toContain('neci 1');
    expect(merged).toContain('! T3212 is in units of 6min');
  });

  it('applies the directives it did find in place', () => {
    expect(merged).toContain('network country code 001');
    expect(merged).toContain('mobile network code 01');
    expect(merged).toContain('encryption a5 1 3');
  });

  it('is idempotent — merging the result again changes nothing', () => {
    const again = upsertVtyPathDirectives(
      merged, ownedDirectivesFromGenerated(GENERATED, KEY_TOKENS),
    );
    expect(again).toBe(merged);
  });

  it('does not duplicate a directive that was appended on a previous run', () => {
    const again = upsertVtyPathDirectives(
      merged, ownedDirectivesFromGenerated(GENERATED, KEY_TOKENS),
    );
    const count = (again.match(/^\s*meas-feed scenario nms$/gm) ?? []).length;
    expect(count).toBe(1);
  });

  it('skips a node that is genuinely absent rather than appending at EOF', () => {
    // `bsc` does not exist in the package example, so its directive has no
    // home; the caller's fallback template covers that case. What must NOT
    // happen is it landing under whatever node came last.
    const bscPath = nodeOf(merged, 'mid-call-timeout 0');
    expect(bscPath).not.toEqual(['msc 0']);
    expect(bscPath).not.toEqual(['network']);
  });

  it('inserts after the last DIRECT child, not inside a trailing sub-node', () => {
    // A node whose last line is a sub-node header must not swallow the
    // appended directive.
    const withSub = `network
 network country code 1
 bts 0
  type osmo-bts
`;
    const gen = `network
 network country code 001
 meas-feed scenario nms
 bts 0
  type osmo-bts
`;
    const out = upsertVtyPathDirectives(withSub, ownedDirectivesFromGenerated(gen, KEY_TOKENS));
    expect(nodeOf(out, 'meas-feed scenario nms')).toEqual(['network']);
  });
});

describe('upsertVtyPathDirectives self-healing of an already-corrupted file', () => {
  // A file written by the buggy append: the correct copies are absent and
  // stale copies sit under the trailing `bsc` node. This is the real state of
  // /etc/osmocom/osmo-bsc.cfg on the clean-host test VM, where osmo-bsc then
  // refused to parse it.
  const CORRUPTED = `e1_input
 e1_line 0 driver ipa
network
 network country code 001
 mobile network code 01
 encryption a5 1 3
 neci 1
 handover 0
 timer net T3212 2
msc 0
 allow-emergency allow
 mgw remote-ip 127.0.0.1
 mgw remote-port 2427
bsc
 mid-call-timeout 0
 meas-feed destination 127.0.0.1 8888
 meas-feed scenario nms
 mgw endpoint-domain mgw
`;

  const healed = upsertVtyPathDirectives(
    CORRUPTED, ownedDirectivesFromGenerated(GENERATED, KEY_TOKENS),
  );

  it('removes the stale copies from the node they were never declared for', () => {
    const bscBlock = healed.slice(healed.indexOf('\nbsc\n'));
    expect(bscBlock).not.toContain('meas-feed');
    expect(bscBlock).not.toContain('mgw endpoint-domain');
  });

  it('leaves exactly one copy of each, in its declared node', () => {
    expect((healed.match(/meas-feed scenario nms/g) ?? []).length).toBe(1);
    expect((healed.match(/mgw endpoint-domain mgw/g) ?? []).length).toBe(1);
    expect(nodeOf(healed, 'meas-feed scenario nms')).toEqual(['network']);
    expect(nodeOf(healed, 'mgw endpoint-domain mgw')).toEqual(['msc 0']);
  });

  it('keeps the directive that genuinely belongs to bsc', () => {
    expect(nodeOf(healed, 'mid-call-timeout 0')).toEqual(['bsc']);
  });

  it('does NOT remove an operator line that merely shares an owned prefix', () => {
    // `mgw remote-ip` is owned under `msc 0`. An operator copy under a
    // different node, with a DIFFERENT value, is real config and must survive
    // — only verbatim generated output in the wrong place is removed.
    const withOperatorLine = `network
 network country code 001
 timer net T3212 2
msc 0
 mgw remote-ip 127.0.0.1
bsc
 mgw remote-ip 10.9.9.9
`;
    const out = upsertVtyPathDirectives(
      withOperatorLine, ownedDirectivesFromGenerated(GENERATED, KEY_TOKENS),
    );
    expect(out).toContain('mgw remote-ip 10.9.9.9');
  });

  it('is idempotent after healing', () => {
    const again = upsertVtyPathDirectives(
      healed, ownedDirectivesFromGenerated(GENERATED, KEY_TOKENS),
    );
    expect(again).toBe(healed);
  });
});

describe('upsertVtyPathDirectives creating a node that does not exist yet', () => {
  // Real, reproduced bug (clean host, 2026-11-08): 2G radio access was
  // silently impossible after adding a BTS.
  //
  // The first GSM Configure runs with btsEntries == [], which prunes the apt
  // package example's `bts 0` subtree out of osmo-bsc.cfg (correct — a BTS
  // removed in the UI must lose its whole subtree). Adding a BTS afterwards
  // then regenerates a config that DOES contain `network > bts 0 > ...`, but
  // the merge skipped every one of those directives because their parent node
  // was absent from the target file. Measured: `grep -c '^ bts [0-9]'` stayed
  // at 0 across two Configures with a BTS in the module state, osmo-bsc never
  // opened its OML listener on :3002, and osmo-bts-virtual sat in
  // `WAIT_RECONNECT`/`SIGN_LINK_DOWN` forever.
  //
  // Skipping was introduced as the fix for appending at EOF (which put lines
  // under the wrong node). Both are wrong: a genuinely new node has to be
  // CREATED inside its parent.

  const TARGET_NO_BTS = `e1_input
 e1_line 0 driver ipa
network
 network country code 001
 mobile network code 01
 timer net T3212 2
msc 0
 allow-emergency allow
 mgw remote-ip 127.0.0.1
`;

  const GENERATED_WITH_BTS = `e1_input
 e1_line 0 driver ipa
network
 network country code 001
 mobile network code 01
 timer net T3212 2
 bts 0
  type osmo-bts
  band GSM900
  ipa unit-id 6969 0
  trx 0
   arfcn 40
msc 0
 allow-emergency allow
 mgw remote-ip 127.0.0.1
`;

  const merged = upsertVtyPathDirectives(
    TARGET_NO_BTS, ownedDirectivesFromGenerated(GENERATED_WITH_BTS, KEY_TOKENS),
  );

  it('creates the missing bts node so osmo-bsc actually learns about the BTS', () => {
    expect(merged).toMatch(/^\s*bts 0$/m);
    expect(merged).toContain('ipa unit-id 6969 0');
  });

  it('puts the new node INSIDE network, not at the end of the file', () => {
    expect(nodeOf(merged, 'type osmo-bts')).toEqual(['network', 'bts 0']);
    expect(nodeOf(merged, 'band GSM900')).toEqual(['network', 'bts 0']);
  });

  it('creates nested nodes too, so a trx under a new bts works', () => {
    expect(nodeOf(merged, 'arfcn 40')).toEqual(['network', 'bts 0', 'trx 0']);
  });

  it('keeps the new node before the next sibling at the parent level', () => {
    // `bts 0` must land inside `network`, i.e. above `msc 0`.
    expect(merged.indexOf('bts 0')).toBeLessThan(merged.indexOf('msc 0'));
  });

  it('does not disturb the directives that already existed', () => {
    expect(merged).toContain('network country code 001');
    expect(merged).toContain('allow-emergency allow');
    expect(nodeOf(merged, 'mgw remote-ip 127.0.0.1')).toEqual(['msc 0']);
  });

  it('is idempotent once the node exists', () => {
    const again = upsertVtyPathDirectives(
      merged, ownedDirectivesFromGenerated(GENERATED_WITH_BTS, KEY_TOKENS),
    );
    expect(again).toBe(merged);
  });

  it('does not create a duplicate bts node on a second merge', () => {
    const again = upsertVtyPathDirectives(
      merged, ownedDirectivesFromGenerated(GENERATED_WITH_BTS, KEY_TOKENS),
    );
    expect((again.match(/^\s*bts 0$/gm) ?? []).length).toBe(1);
  });
});
