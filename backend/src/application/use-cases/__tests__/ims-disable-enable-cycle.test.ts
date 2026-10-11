import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  updateSmfImsSession, removeSmfImsSession,
  updateUpfImsSession, removeUpfImsSession,
  writeYamlGuarded,
} from '../../../interfaces/rest/ims-controller';

// End-to-end exercise of exactly what POST /ims/disable and POST /ims/enable do
// to the YAML files, against this deployment's REAL smf.yaml and upf.yaml as
// fixtures. A user reported the files being wrecked on every IMS stop/start, so
// the round trip itself is what needs pinning — not just the individual
// transforms.
//
// Writing this caught a regression in the write guard that review had not:
// removeSmfImsSession legitimately removes the top-level `parameter:` block
// (IMS is what adds it), and the guard's "no top-level key may vanish" rule
// rejected that as corruption — which would have broken IMS Disable outright.
// Hence the ownedTopLevelKeys argument.
const OWNED_SMF_TOP = ['parameter'];

function fixtures() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imscycle-'));
  const smf = path.join(tmp, 'smf.yaml');
  const upf = path.join(tmp, 'upf.yaml');
  fs.copyFileSync(path.join(__dirname, '__fixtures__live-smf.yaml'), smf);
  fs.copyFileSync(path.join(__dirname, '__fixtures__live-upf.yaml'), upf);
  return { smf, upf };
}
const load = (f: string) => yaml.load(fs.readFileSync(f, 'utf-8')) as any;
const dnns = (f: string, nf: string) => (load(f)[nf].session ?? []).map((s: any) => s.dnn).sort();

const disable = (smf: string, upf: string) => {
  writeYamlGuarded(smf, removeSmfImsSession, 'disable', OWNED_SMF_TOP);
  writeYamlGuarded(upf, removeUpfImsSession, 'disable');
};
const enable = (smf: string, upf: string, pcscf: string) => {
  writeYamlGuarded(smf, raw => updateSmfImsSession(raw, pcscf, pcscf), 'enable', OWNED_SMF_TOP);
  writeYamlGuarded(upf, updateUpfImsSession, 'enable');
};

describe('IMS disable/enable against the real config files', () => {
  it('disable removes the IMS session from BOTH files and nothing else', () => {
    const { smf, upf } = fixtures();
    const before = { smf: load(smf), upf: load(upf) };
    disable(smf, upf);

    expect(dnns(smf, 'smf')).toEqual(['internet', 'internet']);
    expect(dnns(upf, 'upf')).toEqual(['internet', 'internet']);
    expect(load(smf).smf['p-cscf']).toBeUndefined();

    // Everything the original bug destroyed must still be here.
    for (const k of ['sbi', 'pfcp', 'gtpc', 'gtpu', 'metrics', 'dns', 'mtu', 'freeDiameter']) {
      expect(load(smf).smf[k]).toEqual(before.smf.smf[k]);
    }
    for (const k of ['pfcp', 'gtpu', 'metrics']) {
      expect(load(upf).upf[k]).toEqual(before.upf.upf[k]);
    }
    expect(load(smf).logger).toEqual(before.smf.logger);
    expect(load(upf).logger).toEqual(before.upf.logger);
  });

  it('enable puts it back, and the round trip is semantically identical', () => {
    const { smf, upf } = fixtures();
    const before = { smf: load(smf), upf: load(upf) };
    const pcscf = before.smf.smf['p-cscf'][0];

    disable(smf, upf);
    enable(smf, upf, pcscf);

    // Parsed content must match exactly. (The file gains one cosmetic blank
    // line from re-inserting the `parameter:` block; that is why this compares
    // parsed documents rather than text.)
    expect(load(smf)).toEqual(before.smf);
    expect(load(upf)).toEqual(before.upf);
  });

  it('repeated cycles are stable — nothing accumulates', () => {
    const { smf, upf } = fixtures();
    const pcscf = load(smf).smf['p-cscf'][0];
    disable(smf, upf); enable(smf, upf, pcscf);
    const after1 = { smf: fs.readFileSync(smf, 'utf-8'), upf: fs.readFileSync(upf, 'utf-8') };
    for (let i = 0; i < 3; i++) { disable(smf, upf); enable(smf, upf, pcscf); }
    // Byte-identical from the first cycle onward, so the blank line above is a
    // one-off and the file cannot grow without bound across stop/starts.
    expect(fs.readFileSync(smf, 'utf-8')).toBe(after1.smf);
    expect(fs.readFileSync(upf, 'utf-8')).toBe(after1.upf);
  });

  it('both files parse at every step of the cycle', () => {
    const { smf, upf } = fixtures();
    const pcscf = load(smf).smf['p-cscf'][0];
    const ok = () => {
      for (const f of [smf, upf]) {
        const d = yaml.load(fs.readFileSync(f, 'utf-8'));
        expect(d && typeof d === 'object' && !Array.isArray(d)).toBe(true);
      }
    };
    ok(); disable(smf, upf); ok(); enable(smf, upf, pcscf); ok();
  });

  it('disable twice in a row is a no-op, not a second deletion', () => {
    const { smf, upf } = fixtures();
    disable(smf, upf);
    const once = { smf: fs.readFileSync(smf, 'utf-8'), upf: fs.readFileSync(upf, 'utf-8') };
    disable(smf, upf);
    expect(fs.readFileSync(smf, 'utf-8')).toBe(once.smf);
    expect(fs.readFileSync(upf, 'utf-8')).toBe(once.upf);
  });
});
