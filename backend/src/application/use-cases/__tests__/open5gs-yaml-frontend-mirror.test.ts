import { readFileSync } from 'fs';
import { join } from 'path';

// The frontend consumes the same /api/config payload as the backend declares,
// but the two workspaces share no package, so the document types exist twice.
//
// That duplication is not incidental -- it is the exact mechanism that let the
// old DTO bug live on both sides at once. frontend/src/types/index.ts carried
// its own hand-written copy of all 17 NF shapes with the NF's inner fields at
// the document's top level, matching the backend's equally wrong DTOs, so
// neither compiler could contradict the other and every consumer papered over
// the result with `as any`.
//
// The frontend copy is therefore a VERBATIM mirror rather than a parallel
// hand-written set, and this test is what keeps it that way.
describe('open5gs-yaml.ts frontend mirror', () => {
  const backendPath = join(__dirname, '../../../domain/entities/open5gs-yaml.ts');
  const frontendPath = join(__dirname, '../../../../../frontend/src/types/open5gs-yaml.ts');

  it('is byte-identical to the backend source of truth', () => {
    const backend = readFileSync(backendPath, 'utf-8');
    const frontend = readFileSync(frontendPath, 'utf-8');
    expect(frontend).toBe(backend);
  });

  it('is self-contained, so a verbatim copy actually compiles in both workspaces', () => {
    // An import of anything backend-local would make the mirror uncompilable in
    // the frontend. Keep these shapes dependency-free.
    const backend = readFileSync(backendPath, 'utf-8');
    const imports = backend.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports).toEqual([]);
  });

  it('declares a document type for every one of the 17 core NFs', () => {
    const backend = readFileSync(backendPath, 'utf-8');
    // sepp1 and sepp2 share the `sepp` document, hence 16 document types for
    // 17 services -- and the SEPP one is named for the KEY INSIDE the file,
    // not for the service, which is the whole reason this is asserted.
    const expected = [
      'AmfYamlDocument', 'MmeYamlDocument', 'SmfYamlDocument', 'UpfYamlDocument',
      'SgwcYamlDocument', 'SgwuYamlDocument', 'NrfYamlDocument', 'ScpYamlDocument',
      'AusfYamlDocument', 'UdmYamlDocument', 'UdrYamlDocument', 'PcfYamlDocument',
      'NssfYamlDocument', 'BsfYamlDocument', 'SeppYamlDocument', 'HssYamlDocument',
      'PcrfYamlDocument',
    ];
    for (const name of expected) {
      expect(backend).toContain(`export interface ${name} extends YamlDocumentCommon`);
    }
  });
});
