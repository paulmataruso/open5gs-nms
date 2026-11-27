import { IHostExecutor } from '../../domain/interfaces/host-executor';

export interface MmeMobilitySupport {
  status: 'supported' | 'unsupported' | 'unknown' | 'not_installed';
  message: string;
  executable?: string;
  runningExecutable?: string;
}

// These independent strings identify both the peer parser and the mobility
// handlers in the statically linked MME from Open5GS PR #5019. A version number
// alone cannot distinguish a stock release from a build with that change.
export const MME_MOBILITY_MARKERS = [
  'Invalid mme.gtpc.client.mme peer: address, port or GUMMEI',
  'S10 Context Request [ue:%u]',
  'S10 handover gateway updated [ue:%u]',
] as const;

export class MmeMobilitySupportUseCase {
  constructor(private readonly hostExecutor: IHostExecutor) {}

  async execute(): Promise<MmeMobilitySupport> {
    try {
      const unit = await this.hostExecutor.executeCommand('systemctl', [
        'show', 'open5gs-mmed.service', '--property=LoadState,ExecStart,MainPID', '--no-pager',
      ], 5000, { expectedFailure: true });
      if (unit.exitCode !== 0) return {
        status: 'unknown', message: 'Cannot inspect the host MME service. Check host access and retry.',
      };
      if (/^LoadState=not-found$/m.test(unit.stdout)) return {
        status: 'not_installed', message: 'Install an Open5GS MME build with inter-MME mobility support before configuring neighbors.',
      };
      const executable = /^ExecStart=.*?\bpath=(\/[^\s;{}]+)\s*;/m.exec(unit.stdout)?.[1];
      if (!executable || !/(?:^|\/)open5gs-mmed$/.test(executable)) return {
        status: 'unknown', message: 'Cannot verify the MME executable selected by systemd. A wrapper or custom launcher must be checked before enabling inter-MME mobility.',
      };
      const pid = /^MainPID=([1-9][0-9]*)$/m.exec(unit.stdout)?.[1];
      const runningExecutable = pid ? `/proc/${pid}/exe` : undefined;
      // Check the next-restart binary AND the running image. This also handles
      // an upgrade on disk while the old MME is still running (or vice versa).
      for (const file of [executable, ...(runningExecutable ? [runningExecutable] : [])]) {
        for (const marker of MME_MOBILITY_MARKERS) {
          const result = await this.hostExecutor.executeCommand('grep', [
            '-aFq', '--', marker, file,
          ], 5000, { expectedFailure: true });
          if (result.exitCode === 1) return {
            status: 'unsupported', executable, runningExecutable,
            message: 'Update Open5GS to a build that supports inter-MME mobility and restart the MME before adding neighbors. The installed or running MME does not contain the recognized implementation.',
          };
          if (result.exitCode !== 0) return {
            status: 'unknown', executable, runningExecutable,
            message: 'Cannot read the installed or running MME executable. Check host access and retry; support has not been confirmed.',
          };
        }
      }
      return { status: 'supported', executable, runningExecutable,
        message: 'The MME peer parser and inter-MME mobility handlers are present. Configure the reverse neighbor on each remote MME as well.' };
    } catch {
      return { status: 'unknown', message: 'Unable to verify MME support. Check host access and retry.' };
    }
  }
}
