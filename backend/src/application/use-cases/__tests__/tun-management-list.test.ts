// Regression coverage for GitHub issue #29: TunManagementUseCase.list() only ever
// recognized ogstun/ogstun<N>-pattern names, so a custom-named upf.yaml session
// device (e.g. `dev: ptt` for a non-default DNN) was invisible on the TUN
// Interfaces page — live, carrying traffic, and never shown, not even as an error.
import { TunManagementUseCase } from '../tun-management';

// `ogstun` + `ptt` live; `video`/`surveillance` are NOT (upf.yaml declares them but
// UPF hasn't created them yet — the "not yet live" case). `ogstun9` is live and
// matches the ogstun<N> pattern this page has always recognized, but has no
// matching upf.yaml session and no NMS .netdev file — a real "Manual" case (this
// page intentionally never shows arbitrary host interfaces like lo/ens20/docker0;
// only ogstun-pattern or upf.yaml-declared ones were ever in scope, before or
// after this fix — #29 only adds the third source, upf.yaml's own dev list).
const LINK_OUTPUT = [
  '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN',
  '77: ogstun: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UNKNOWN',
  '78: ptt: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UNKNOWN',
  '80: ogstun9: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UNKNOWN',
].join('\n');

const ADDR_OUTPUT = [
  '77: ogstun    inet 10.45.0.1/24 brd 10.45.0.255 scope global ogstun',
  '78: ptt    inet 198.51.100.1/24 brd 198.51.100.255 scope global ptt',
  '80: ogstun9    inet 172.16.5.1/30 brd 172.16.5.3 scope global ogstun9',
].join('\n');

function makeUseCase(opts: { managedNames?: string[] } = {}) {
  const executeLocalCommand = jest.fn(async (_cmd: string, args: string[]) => {
    const shellCmd = args[1] as string;
    if (shellCmd.includes('-o link show')) return { stdout: LINK_OUTPUT, stderr: '', exitCode: 0 };
    if (shellCmd.includes('-o addr show')) return { stdout: ADDR_OUTPUT, stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const executeCommand = jest.fn(async () => ({
    stdout: (opts.managedNames ?? []).join('\n'),
    stderr: '',
    exitCode: 0,
  }));
  const hostExecutor = { executeLocalCommand, executeCommand } as any;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const configRepo = {
    loadSmf: jest.fn().mockResolvedValue({
      session: [
        { dnn: 'internet', subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
        { dnn: 'ptt.example.com', subnet: '198.51.100.0/24', gateway: '198.51.100.1' },
        { dnn: 'video.example.com', subnet: '203.0.113.0/24', gateway: '203.0.113.1' },
      ],
    }),
    loadUpf: jest.fn().mockResolvedValue({
      session: [
        { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun' },
        { subnet: '198.51.100.0/24', gateway: '198.51.100.1', dev: 'ptt' },
        { subnet: '203.0.113.0/24', gateway: '203.0.113.1', dev: 'video' },
      ],
    }),
  } as any;
  return new TunManagementUseCase(hostExecutor, logger, configRepo);
}

describe('TunManagementUseCase.list — issue #29', () => {
  test('a custom-named upf.yaml device that is live appears with the correct DNN join', async () => {
    const uc = makeUseCase();
    const list = await uc.list();
    const ptt = list.find((i) => i.name === 'ptt');
    expect(ptt).toBeDefined();
    expect(ptt!.exists).toBe(true);
    expect(ptt!.state).toBe('up');
    expect(ptt!.ip).toBe('198.51.100.1');
    expect(ptt!.fromUpfConfig).toBe(true);
    expect(ptt!.dnn).toBe('ptt.example.com');
    expect(ptt!.subnet).toBe('198.51.100.0/24');
  });

  test('a custom-named upf.yaml device that is not yet live still appears, as exists:false', async () => {
    const uc = makeUseCase();
    const list = await uc.list();
    const video = list.find((i) => i.name === 'video');
    expect(video).toBeDefined();
    expect(video!.exists).toBe(false);
    expect(video!.fromUpfConfig).toBe(true);
    expect(video!.dnn).toBe('video.example.com');
  });

  test('a live ogstun-pattern interface with no upf.yaml session and no .netdev is not fromUpfConfig or managed', async () => {
    const uc = makeUseCase();
    const list = await uc.list();
    const manual = list.find((i) => i.name === 'ogstun9');
    expect(manual).toBeDefined();
    expect(manual!.exists).toBe(true);
    expect(manual!.fromUpfConfig).toBe(false);
    expect(manual!.managed).toBe(false);
    expect(manual!.dnn).toBeNull();
  });

  test('ogstun is always present and resolves its DNN via the primary dnn-match', async () => {
    const uc = makeUseCase();
    const list = await uc.list();
    const ogstun = list.find((i) => i.name === 'ogstun');
    expect(ogstun).toBeDefined();
    expect(ogstun!.default).toBe(true);
    expect(ogstun!.exists).toBe(true);
    expect(ogstun!.dnn).toBe('internet');
  });

  test('ogstun is present even with no UPF sessions configured at all', async () => {
    const executeLocalCommand = jest.fn(async (_cmd: string, args: string[]) => {
      const shellCmd = args[1] as string;
      if (shellCmd.includes('-o link show')) return { stdout: '', stderr: '', exitCode: 0 };
      if (shellCmd.includes('-o addr show')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const executeCommand = jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const hostExecutor = { executeLocalCommand, executeCommand } as any;
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
    const configRepo = {
      loadSmf: jest.fn().mockResolvedValue({ session: [] }),
      loadUpf: jest.fn().mockResolvedValue({ session: [] }),
    } as any;
    const uc = new TunManagementUseCase(hostExecutor, logger, configRepo);
    const list = await uc.list();
    expect(list.find((i) => i.name === 'ogstun')).toBeDefined();
  });

  test('an NMS-managed interface is reported as managed regardless of UPF config', async () => {
    const uc = makeUseCase({ managedNames: ['ogstun3'] });
    const list = await uc.list();
    const managed = list.find((i) => i.name === 'ogstun3');
    expect(managed).toBeDefined();
    expect(managed!.managed).toBe(true);
  });
});
