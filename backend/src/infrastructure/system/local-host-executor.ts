import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import { IHostExecutor, CommandResult } from '../../domain/interfaces/host-executor';

const execFileAsync = promisify(execFile);

export class LocalHostExecutor implements IHostExecutor {
  constructor(
    private readonly logger: pino.Logger,
    private readonly systemctlPath: string = '/usr/bin/systemctl',
  ) {}

  async executeCommand(
    command: string,
    args: string[],
    timeoutMs: number = 30000,
  ): Promise<CommandResult> {
    this.logger.debug({ command, args }, 'Executing command');

    try {
      const nsenterArgs = ['-t', '1', '-m', '-u', '-i', '-p', command, ...args];
      
      const { stdout, stderr } = await execFileAsync('nsenter', nsenterArgs, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        env: {
          ...process.env,
          DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket',
        },
      });

      this.logger.debug({ command, args, stdout, stderr }, 'Command executed successfully');
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number; signal?: string };
      this.logger.error({ command, args, error: error.stderr || String(err) }, 'Command execution failed');
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
    return result.stdout.trim() === 'enabled';
  }

  async isPortListening(port: number): Promise<boolean> {
    const result = await this.executeCommand('ss', ['-tlnp', `sport = :${port}`]);
    return result.stdout.includes(`:${port}`);
  }
}
