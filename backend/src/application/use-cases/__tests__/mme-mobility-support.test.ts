import { MmeMobilitySupportUseCase, MME_MOBILITY_MARKERS } from '../mme-mobility-support';
import { IHostExecutor, CommandResult } from '../../../domain/interfaces/host-executor';

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const unit = (pid = 0) => ok(`LoadState=loaded\nMainPID=${pid}\nExecStart={ path=/usr/bin/open5gs-mmed ; argv[]=/usr/bin/open5gs-mmed -c /etc/open5gs/mme.yaml ; }\n`);

describe('inter-MME mobility compatibility', () => {
  function setup(response = unit()) {
    const executeCommand = jest.fn().mockImplementation(async (command: string) => command === 'systemctl' ? response : ok());
    const host = { executeCommand } as unknown as IHostExecutor;
    return { executeCommand, useCase: new MmeMobilitySupportUseCase(host) };
  }

  it('recognizes the deployed implementation without executing or reconfiguring the MME', async () => {
    const { useCase, executeCommand } = setup();
    expect((await useCase.execute()).status).toBe('supported');
    expect(executeCommand.mock.calls.slice(1).map(call => call[1])).toEqual(
      MME_MOBILITY_MARKERS.map(marker => ['-aFq', '--', marker, '/usr/bin/open5gs-mmed']),
    );
  });

  it('does not infer support from a service existing or a version number', async () => {
    const { useCase, executeCommand } = setup();
    executeCommand.mockResolvedValueOnce(unit()).mockResolvedValueOnce({ ...ok(), exitCode: 1 });
    expect(await useCase.execute()).toMatchObject({ status: 'unsupported', message: expect.stringContaining('Update Open5GS') });
  });

  it('refuses an upgraded file while an old MME is still running', async () => {
    const { useCase, executeCommand } = setup(unit(42));
    executeCommand.mockImplementation(async (command: string, args: string[]) =>
      command === 'systemctl' ? unit(42) : args.includes('/proc/42/exe') ? { ...ok(), exitCode: 1 } : ok());
    expect((await useCase.execute()).status).toBe('unsupported');
  });

  it('checks the restart target even when the running MME is supported', async () => {
    const { useCase, executeCommand } = setup(unit(42));
    executeCommand.mockImplementation(async (command: string, args: string[]) =>
      command === 'systemctl' ? unit(42) : args.includes('/usr/bin/open5gs-mmed') ? { ...ok(), exitCode: 1 } : ok());
    expect((await useCase.execute()).status).toBe('unsupported');
  });

  it('reports inaccessible host/binary state as unknown rather than supported', async () => {
    const { useCase, executeCommand } = setup();
    executeCommand.mockResolvedValueOnce(unit()).mockResolvedValueOnce({ ...ok(), exitCode: 2 });
    expect((await useCase.execute()).status).toBe('unknown');
    executeCommand.mockRejectedValueOnce(new Error('host unavailable'));
    expect((await useCase.execute()).status).toBe('unknown');
  });

  it('reports a missing service and does not guess a PATH binary', async () => {
    const { useCase, executeCommand } = setup(ok('LoadState=not-found\nMainPID=0\n'));
    expect((await useCase.execute()).status).toBe('not_installed');
    expect(executeCommand).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a shell wrapper for a verified MME', async () => {
    const { useCase } = setup(ok('LoadState=loaded\nExecStart={ path=/bin/sh ; argv[]=/bin/sh /opt/start-mme ; }\n'));
    expect((await useCase.execute()).status).toBe('unknown');
  });
});
