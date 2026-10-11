import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { IHostExecutor, CommandResult } from '../../domain/interfaces/host-executor';
import { safeNsenter } from './safe-nsenter';

const execFileAsync = promisify(execFile);

// Node's child_process.execFile defaults maxBuffer to 1MB — plenty for the
// short, line-oriented output most commands here produce (systemctl, ip,
// etc.), but silently fatal for anything that can legitimately produce more:
// confirmed live (2026-07-19) with tshark's -T fields packet decode on a
// ~36k-packet capture producing 6.4MB of stdout — Node killed the process
// once the default limit was hit, giving a bare nonzero exit with no real
// stderr (the command never got a chance to report an actual error). Set a
// generous ceiling here so any current or future caller with legitimately
// large output doesn't hit this silently.
const MAX_BUFFER_BYTES = 100 * 1024 * 1024; // 100MB

export class LocalHostExecutor implements IHostExecutor {
  constructor(
    private readonly logger: pino.Logger,
    private readonly systemctlPath: string = 'systemctl',
  ) {}

  async executeCommand(
    command: string,
    args: string[],
    timeoutMs: number = 30000,
    options?: { expectedFailure?: boolean },
  ): Promise<CommandResult> {
    this.logger.debug({ command, args }, 'Executing command');

    try {
      // nsenter flags (see safe-nsenter.ts, which actually issues the
      // command): -t 1 targets PID 1 (host init); -m enters the host mount
      // namespace so /usr/bin/systemctl, /sbin/conntrack etc. resolve to
      // HOST binaries against the HOST's GLIBC (fixes the Ubuntu 24.04
      // GLIBC mismatch without needing -r); -u -i -p enter the UTS/IPC/PID
      // namespaces. We pass the bare command name (e.g. 'systemctl'), not a
      // full path — a full path would resolve in the CONTAINER filesystem
      // before nsenter runs; bare names resolve after entering the host
      // mount namespace.
      //
      // Uses safeNsenter, not a bare execFile+timeout — real, reproduced-
      // live bug (2026-09-25): nsenter -p forks internally before exec'ing
      // the wrapped command, unconditionally, so a plain execFile timeout
      // only kills the tracked nsenter PID and orphans the real wrapped
      // process (confirmed live for this exact call path, using these
      // exact spawn arguments — this was the single highest-consequence
      // caller of that bug, since KamailioStatsMonitor alone was already
      // calling through here every 15s, forever, in production). See
      // safe-nsenter.ts's own header comment for the full mechanism.
      const { stdout, stderr } = await safeNsenter(command, args, timeoutMs);

      this.logger.debug({ command, args, stdout, stderr }, 'Command executed successfully');
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number; signal?: string };
      // Use debug level for commands that are expected to fail (e.g. systemctl is-active
      // on a service that doesn't exist). Only escalate to error for unexpected failures.
      const isExpectedFailure = options?.expectedFailure || (
        (command === 'systemctl' || command.endsWith('/systemctl') || args[0] === 'systemctl') &&
        (args.includes('is-active') || args.includes('is-enabled'))
      );
      if (isExpectedFailure) {
        this.logger.debug({ command, args, error: String(err) }, 'Command execution failed (expected)');
      } else {
        this.logger.error({ command, args, error: error.stderr || String(err) }, 'Command execution failed');
      }
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || String(err),
        exitCode: error.code || 1,
      };
    }
  }

  // Run a command locally inside the container (no nsenter) — used for
  // tools like mongodump/mongorestore that connect over the network and
  // must write to container-mounted volumes, not the host filesystem.
  async executeLocalCommand(
    command: string,
    args: string[],
    timeoutMs: number = 120000,
  ): Promise<CommandResult> {
    this.logger.debug({ command, args }, 'Executing local command');

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER_BYTES,
      });

      this.logger.debug({ command, args, stdout, stderr }, 'Local command executed successfully');
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number; signal?: string };
      this.logger.error({ command, args, error: error.stderr || String(err) }, 'Local command execution failed');
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || String(err),
        exitCode: error.code || 1,
      };
    }
  }

  async readFile(filePath: string): Promise<string> {
    this.logger.debug({ filePath }, 'Reading file');
    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
    this.logger.debug({ filePath }, 'File written atomically');
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async copyFile(source: string, destination: string): Promise<void> {
    await fs.copyFile(source, destination);
  }

  async createDirectory(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath);
  }

  async restartService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Restarting service');
    return this.executeCommand(this.systemctlPath, ['restart', unitName]);
  }

  async startService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Starting service');
    return this.executeCommand(this.systemctlPath, ['start', unitName]);
  }

  async stopService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Stopping service');
    return this.executeCommand(this.systemctlPath, ['stop', unitName]);
  }

  async enableService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Enabling service at boot');
    return this.executeCommand(this.systemctlPath, ['enable', unitName]);
  }

  async disableService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Disabling service at boot');
    return this.executeCommand(this.systemctlPath, ['disable', unitName]);
  }

  async getServiceStatus(unitName: string): Promise<CommandResult> {
    return this.executeCommand(this.systemctlPath, ['status', unitName, '--no-pager']);
  }

  async isServiceActive(unitName: string): Promise<boolean> {
    const result = await this.executeCommand(this.systemctlPath, ['is-active', unitName]);
    return result.stdout.trim() === 'active';
  }

  async isServiceEnabled(unitName: string): Promise<boolean> {
    const result = await this.executeCommand(this.systemctlPath, ['is-enabled', unitName]);
    const state = result.stdout.trim();
    // 'enabled' = explicitly enabled, 'static' = enabled by default (no [Install] section),
    // 'indirect' = enabled via another unit — all mean the service will run
    return state === 'enabled' || state === 'static' || state === 'indirect';
  }

  async isPortListening(port: number): Promise<boolean> {
    const result = await this.executeCommand('ss', ['-tlnp', `sport = :${port}`]);
    return result.stdout.includes(`:${port}`);
  }
}
