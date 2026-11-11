import pino from 'pino';
import { YamlConfigRepository } from '../../../infrastructure/yaml/yaml-config-repository';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { validateMmeMobility } from '../mme-mobility-validation';

describe('inter-MME mobility through the real YAML repository', () => {
  it('round-trips neighbors without losing gateway, Diameter, logger or MCC/MNC settings', async () => {
    let text = `logger:
  level: info
mme:
  freeDiameter: /etc/freeDiameter/mme.conf
  gtpc:
    server:
      - address: 192.0.2.10
    client:
      sgwc:
        - address: 192.0.2.11
      smf:
        - address: 192.0.2.30
  gummei:
    - plmn_id:
        mcc: 001
        mnc: 01
      mme_gid: 2
      mme_code: 1
`;
    const host = {
      readFile: jest.fn().mockImplementation(async () => text),
      writeFile: jest.fn().mockImplementation(async (_file: string, content: string) => { text = content; }),
    } as unknown as IHostExecutor;
    const repo = new YamlConfigRepository(host, '/etc/open5gs', pino({ level: 'silent' }));
    const peers = ['01', '001'].map((mnc, index) => ({
      address: `192.0.2.${20 + index}`, port: 2123,
      gummei: { plmn_id: { mcc: '001', mnc }, mme_gid: 2, mme_code: 2 + index },
      tai: [{ plmn_id: { mcc: '001', mnc }, tac: 2 + index }],
    }));
    const loaded = await repo.loadMme();
    await repo.saveMme({ ...loaded, rawYaml: { mme: { gtpc: { client: { mme: peers } } } } });
    const reloaded = await repo.loadMme();
    expect(validateMmeMobility(reloaded.rawYaml)).toEqual(peers);
    expect(reloaded.rawYaml).toMatchObject({
      logger: { level: 'info' },
      mme: {
        freeDiameter: '/etc/freeDiameter/mme.conf',
        gtpc: { server: [{ address: '192.0.2.10' }], client: {
          sgwc: [{ address: '192.0.2.11' }], smf: [{ address: '192.0.2.30' }],
        } },
        gummei: [{ plmn_id: { mcc: '001', mnc: '01' }, mme_code: 1 }],
      },
    });
    // Explicit empty list must clear the old peers rather than deep-merge them back.
    await repo.saveMme({ rawYaml: { mme: { gtpc: { client: { mme: [] } } } } });
    expect(validateMmeMobility((await repo.loadMme()).rawYaml)).toEqual([]);
  });
});
