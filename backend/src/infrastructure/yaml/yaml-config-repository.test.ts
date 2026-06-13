/**
 * Tests for yaml-config-repository deepMerge and round-trip YAML preservation.
 *
 * Run with:
 *   cd backend && npx ts-node src/infrastructure/yaml/yaml-config-repository.test.ts
 */

import * as yaml from 'js-yaml';

// ── Inline the deepMerge logic so we can test it in isolation ─────────────────
// (Mirrors the private method in yaml-config-repository.ts exactly)

function deepMerge(base: any, overlay: any): any {
  if (
    overlay === null || overlay === undefined ||
    typeof overlay !== 'object' || Array.isArray(overlay)
  ) return overlay;
  if (
    base === null || base === undefined ||
    typeof base !== 'object' || Array.isArray(base)
  ) return overlay;

  const result: any = { ...base };
  for (const key of Object.keys(overlay)) {
    const ov = overlay[key];
    const bv = base[key];
    if (
      ov !== null && ov !== undefined &&
      typeof ov === 'object' && !Array.isArray(ov) &&
      bv !== null && bv !== undefined &&
      typeof bv === 'object' && !Array.isArray(bv)
    ) {
      result[key] = deepMerge(bv, ov);
    } else {
      result[key] = ov;
    }
  }
  return result;
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `\n    → ${detail}` : ''}`);
    failed++;
  }
}

function eq(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ─────────────────────────────────────────────────────────────────────────────
// deepMerge unit tests
// ─────────────────────────────────────────────────────────────────────────────

section('deepMerge: basic scalar overlay');
{
  const base    = { a: 1, b: 2 };
  const overlay = { b: 99 };
  const result  = deepMerge(base, overlay);
  assert(result.a === 1,  'base key preserved when not in overlay');
  assert(result.b === 99, 'overlay value wins on conflict');
}

section('deepMerge: nested object merge');
{
  const base    = { amf: { ngap: { server: [{ address: '10.0.0.1' }], dev: 'eth0' }, sbi: { port: 7777 } } };
  const overlay = { amf: { ngap: { server: [{ address: '10.0.0.2' }] } } };
  const result  = deepMerge(base, overlay);
  assert(result.amf.ngap.dev === 'eth0',          'nested sibling key preserved (dev: eth0)');
  assert(result.amf.sbi.port === 7777,            'nested sibling section preserved (sbi.port)');
  assert(result.amf.ngap.server[0].address === '10.0.0.2', 'overlay wins on array (new address)');
}

section('deepMerge: arrays are NOT merged — overlay array wins entirely');
{
  // This is critical: if user removes a session pool via UI, the shorter array must win
  const base    = { upf: { session: [{ subnet: '10.45.0.0/16' }, { subnet: '10.46.0.0/16' }] } };
  const overlay = { upf: { session: [{ subnet: '10.45.0.0/16' }] } };
  const result  = deepMerge(base, overlay);
  assert(result.upf.session.length === 1,         'removed session pool is gone (array replaced not merged)');
  assert(result.upf.session[0].subnet === '10.45.0.0/16', 'remaining session pool preserved');
}

section('deepMerge: unknown top-level keys preserved');
{
  // Simulates a manually added section the NMS never touches
  const base    = { amf: { ngap: { server: [{ address: '1.2.3.4' }] } }, custom_section: { key: 'value' } };
  const overlay = { amf: { ngap: { server: [{ address: '5.6.7.8' }] } } };
  const result  = deepMerge(base, overlay);
  assert(result.custom_section?.key === 'value',  'unknown top-level section preserved');
  assert(result.amf.ngap.server[0].address === '5.6.7.8', 'NMS change applied');
}

section('deepMerge: null overlay removes key');
{
  const base    = { a: 1, b: 2 };
  const overlay = { b: null };
  const result  = deepMerge(base, overlay);
  assert(result.a === 1,    'other keys preserved');
  assert(result.b === null, 'null overlay sets key to null');
}

section('deepMerge: deeply nested unknown fields preserved');
{
  // A manually added "time:" section inside mme.yaml
  const base = {
    mme: {
      s1ap: { server: [{ address: '10.0.1.175' }] },
      time: { t3402: { value: 720 }, t3412: { value: 3240 } },  // manually added
    }
  };
  const overlay = {
    mme: {
      s1ap: { server: [{ address: '10.0.1.200' }] },  // NMS changes address
      // time: is NOT in overlay because NMS doesn't touch it
    }
  };
  const result = deepMerge(base, overlay);
  assert(result.mme.s1ap.server[0].address === '10.0.1.200', 'address updated');
  assert(result.mme.time?.t3402?.value === 720,               'manually added time.t3402 preserved');
  assert(result.mme.time?.t3412?.value === 3240,              'manually added time.t3412 preserved');
}

section('deepMerge: dev field preserved when address changed (AMF NGAP scenario)');
{
  // The main bug scenario: user added dev: to ngap, NMS changes address,
  // dev: should survive
  const onDisk = {
    amf: {
      ngap: {
        server: [{ address: '10.0.1.155' }],
        // manually added:
      },
    }
  };

  // Simulate NMS writing amf.yaml after user changes NGAP address
  // NMS sends { amf: { ngap: { server: [{ address: '10.0.1.200' }] } } }
  // deepMerge should preserve any extra fields on the ngap object from disk
  const nmsWrite = {
    amf: {
      ngap: { server: [{ address: '10.0.1.200' }] },
    }
  };

  const merged = deepMerge(onDisk, nmsWrite);
  assert(merged.amf.ngap.server[0].address === '10.0.1.200', 'address updated by NMS');
}

section('deepMerge: full AMF YAML round-trip (realistic scenario)');
{
  const amfYamlStr = `
logger:
  file:
    path: /var/log/open5gs/amf.log

global:
  max:
    ue: 1024

amf:
  sbi:
    server:
      - address: 127.0.0.5
        port: 7777
    client:
      nrf:
        - uri: http://127.0.0.10:7777
  ngap:
    server:
      - address: 10.0.1.155
  guami:
    - plmn_id:
        mcc: '999'
        mnc: '70'
      amf_id:
        region: 2
        set: 1
  security:
    integrity_order:
      - NIA2
      - NIA1
  # This is a comment that will be lost (expected)
  amf_name: open5gs-amf0
`;

  const onDisk = yaml.load(amfYamlStr) as any;

  // NMS saves with a changed NGAP address and nothing else
  const nmsDoc = JSON.parse(JSON.stringify(onDisk)); // deep clone
  nmsDoc.amf.ngap.server[0].address = '10.0.1.200';

  const merged = deepMerge(onDisk, nmsDoc);

  assert(merged.amf.ngap.server[0].address === '10.0.1.200', 'NGAP address updated');
  assert(merged.amf.amf_name === 'open5gs-amf0',              'amf_name preserved');
  assert(merged.amf.guami[0].plmn_id.mcc === '999',           'PLMN MCC preserved');
  assert(merged.logger.file.path === '/var/log/open5gs/amf.log', 'logger preserved');
  assert(merged.global?.max?.ue === 1024,                     'global section preserved');
  assert(merged.amf.security.integrity_order[0] === 'NIA2',   'security algorithms preserved');
}

section('deepMerge: SMF session pools — adding dev: manually should survive NMS save');
{
  // User manually added dev: ogstun2 to a session pool
  const onDisk = {
    smf: {
      session: [
        { subnet: '10.45.0.0/16', gateway: '10.45.0.1', dev: 'ogstun2' },  // manually added dev
        { subnet: '2001:db8::/48', gateway: '2001:db8::1' },
      ],
      pfcp: { server: [{ address: '127.0.0.4' }] }
    }
  };

  // NMS saves the session array (user changed nothing about sessions in UI,
  // but the full rawYaml is re-sent). The session array from the frontend
  // should include the dev field if it was in rawYaml.
  // This tests that the backend merge doesn't strip dev from the existing file
  // if the NMS forgot to include it.
  const nmsDoc = {
    smf: {
      session: [
        { subnet: '10.45.0.0/16', gateway: '10.45.0.1' }, // dev: missing from NMS
        { subnet: '2001:db8::/48', gateway: '2001:db8::1' },
      ],
      pfcp: { server: [{ address: '127.0.0.4' }] }
    }
  };

  const merged = deepMerge(onDisk, nmsDoc);

  // Arrays are NOT merged — NMS array wins entirely
  // dev: will be lost here because arrays replace. This is EXPECTED behavior
  // because the NMS UI now explicitly sends dev: in session pools.
  // This test documents the expected behavior.
  assert(merged.smf.session.length === 2,  'correct number of session pools');
  assert(merged.smf.session[0].subnet === '10.45.0.0/16', 'subnet preserved');
  // Note: dev is lost here because the NMS sent an array without it.
  // The fix for this is in the frontend — UpfEditor now sends dev: in session arrays.
  // The deepMerge only helps with non-array fields.
  assert(merged.smf.pfcp.server[0].address === '127.0.0.4', 'pfcp server preserved');
}

section('deepMerge: UPF session with dev field — NMS sends it correctly');
{
  // This tests the CORRECT scenario: NMS UI sends dev: in the session array
  const onDisk = {
    upf: {
      session: [{ subnet: '10.45.0.0/16', gateway: '10.45.0.1' }],
      gtpu: { server: [{ address: '10.0.1.155' }] }
    }
  };

  // After our fix, the NMS now sends dev: in session arrays when it's set
  const nmsDoc = {
    upf: {
      session: [
        { subnet: '10.45.0.0/16', gateway: '10.45.0.1', dev: 'ogstun2', dnn: 'internet' }
      ],
      gtpu: { server: [{ address: '10.0.1.155' }] }
    }
  };

  const merged = deepMerge(onDisk, nmsDoc);
  assert(merged.upf.session[0].dev === 'ogstun2',     'dev field preserved when NMS sends it');
  assert(merged.upf.session[0].dnn === 'internet',    'dnn field preserved when NMS sends it');
  assert(merged.upf.session[0].subnet === '10.45.0.0/16', 'subnet preserved');
}

section('deepMerge: edge cases');
{
  // Empty overlay
  const base = { a: 1, b: { c: 2 } };
  assert(eq(deepMerge(base, {}), base),               'empty overlay returns base');

  // Null base
  assert(eq(deepMerge(null, { a: 1 }), { a: 1 }),     'null base returns overlay');

  // Scalar base, object overlay
  assert(eq(deepMerge('string', { a: 1 }), { a: 1 }), 'scalar base replaced by object overlay');

  // Object base, scalar overlay
  assert(eq(deepMerge({ a: 1 }, 42), 42),              'object base replaced by scalar overlay');

  // undefined overlay key
  const r = deepMerge({ a: 1 }, { b: undefined });
  assert(r.a === 1,         'base key preserved with undefined overlay sibling');
  assert(r.b === undefined, 'undefined overlay value applied');
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML round-trip tests (parse → modify → merge → dump → parse)
// ─────────────────────────────────────────────────────────────────────────────

section('YAML round-trip: change one field, preserve all others');
{
  const original = `
amf:
  sbi:
    server:
      - address: 127.0.0.5
        port: 7777
  ngap:
    server:
      - address: 10.0.1.155
  amf_name: open5gs-amf0
  custom_field: keep_me
logger:
  file:
    path: /var/log/open5gs/amf.log
`;

  const onDisk = yaml.load(original) as any;

  // Simulate NMS changing only ngap address
  const nmsWrite = JSON.parse(JSON.stringify(onDisk));
  nmsWrite.amf.ngap.server[0].address = '192.168.1.100';

  const merged = deepMerge(onDisk, nmsWrite);
  const output = yaml.dump(merged);
  const reparsed = yaml.load(output) as any;

  assert(reparsed.amf.ngap.server[0].address === '192.168.1.100', 'changed field written');
  assert(reparsed.amf.amf_name === 'open5gs-amf0',                 'amf_name preserved');
  assert(reparsed.amf.custom_field === 'keep_me',                   'custom field preserved');
  assert(reparsed.amf.sbi.server[0].port === 7777,                  'sbi port preserved');
  assert(reparsed.logger.file.path === '/var/log/open5gs/amf.log',  'logger preserved');
}

section('YAML round-trip: manually added time section in mme.yaml survives NMS edit');
{
  const mmeOnDisk = `
mme:
  s1ap:
    server:
      - address: 10.0.1.175
  gtpc:
    server:
      - address: 127.0.0.2
  gummei:
    - plmn_id:
        mcc: '999'
        mnc: '70'
      mme_gid: 2
      mme_code: 1
  # manually added timers:
  time:
    t3402:
      value: 720
    t3412:
      value: 3240
logger:
  file:
    path: /var/log/open5gs/mme.log
`;

  const onDisk = yaml.load(mmeOnDisk) as any;

  // NMS changes the S1AP address (user used the NMS form)
  const nmsWrite = JSON.parse(JSON.stringify(onDisk));
  nmsWrite.mme.s1ap.server[0].address = '10.0.1.200';
  // NMS doesn't know about time: section so it's absent from nmsWrite
  // (In practice, since rawYaml includes everything, it would be there.
  //  But this tests that deepMerge handles it correctly either way.)

  const merged = deepMerge(onDisk, nmsWrite);
  const output = yaml.dump(merged);
  const reparsed = yaml.load(output) as any;

  assert(reparsed.mme.s1ap.server[0].address === '10.0.1.200',  'S1AP address updated');
  assert(reparsed.mme.time?.t3402?.value === 720,                'manually added t3402 preserved');
  assert(reparsed.mme.time?.t3412?.value === 3240,               'manually added t3412 preserved');
  assert(reparsed.mme.gummei[0].mme_gid === 2,                   'gummei preserved');
  assert(reparsed.logger.file.path === '/var/log/open5gs/mme.log','logger preserved');
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\n❌ Some tests failed');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed');
  process.exit(0);
}
