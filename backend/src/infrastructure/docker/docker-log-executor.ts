import { spawn, ChildProcess } from 'child_process';
import pino from 'pino';

export interface DockerLogEntry {
  timestamp: string;
  container: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

/**
 * Docker Log Executor
 * Executes docker commands to stream and retrieve container logs
 */
export class DockerLogExecutor {
  constructor(
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Stream logs from a Docker container in real-time
   * @param containerName Name of the container
   * @param tail Number of historical lines to include (0 = no history, only new logs)
   * @returns ChildProcess for the docker logs command
   */
  streamLogs(containerName: string, tail: number = 0): ChildProcess {
    this.logger.debug({ containerName, tail }, 'Starting docker log stream');

    // docker logs -f --tail <n> --timestamps <container>
    const process = spawn('docker', [
      'logs',
      '-f',                          // Follow log output
      '--tail', tail.toString(),     // Number of lines from the end
      '--timestamps',                // Include timestamps
      containerName,
    ]);

    return process;
  }

  /**
   * Get recent logs from a container (non-streaming)
   * @param containerName Name of the container
   * @param lines Number of recent lines to retrieve
   * @returns Promise resolving to array of log entries
   */
  async getRecentLogs(containerName: string, lines: number = 100): Promise<DockerLogEntry[]> {
    this.logger.debug({ containerName, lines }, 'Fetching recent docker logs');

    return new Promise((resolve, reject) => {
      const process = spawn('docker', [
        'logs',
        '--tail', lines.toString(),
        '--timestamps',
        containerName,
      ]);

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code !== 0) {
          this.logger.error({ containerName, code }, 'docker logs command failed');
          return reject(new Error(`docker logs exited with code ${code}`));
        }

        const logs: DockerLogEntry[] = [];

        // Parse stdout lines
        stdout.split('\n').forEach((line) => {
          const entry = this.parseDockerLogLine(line, containerName, 'stdout');
          if (entry) logs.push(entry);
        });

        // Parse stderr lines
        stderr.split('\n').forEach((line) => {
          const entry = this.parseDockerLogLine(line, containerName, 'stderr');
          if (entry) logs.push(entry);
        });

        // Sort by timestamp
        logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        this.logger.debug({ containerName, count: logs.length }, 'Retrieved docker logs');
        resolve(logs);
      });

      process.on('error', (err) => {
        this.logger.error({ containerName, err: String(err) }, 'docker logs process error');
        reject(err);
      });
    });
  }

  /**
   * List all Open5GS NMS containers
   * @returns Promise resolving to array of container names
   */
  async getContainers(): Promise<string[]> {
    this.logger.debug('Listing NMS containers');

    return new Promise((resolve, reject) => {
      const process = spawn('docker', [
        'ps',
        '--filter', 'name=open5gs-nms',
        '--format', '{{.Names}}',
      ]);

      let output = '';

      process.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      process.on('close', (code) => {
        if (code !== 0) {
          this.logger.error({ code }, 'docker ps command failed');
          return reject(new Error(`docker ps exited with code ${code}`));
        }

        const containers = output
          .split('\n')
          .map((name) => name.trim())
          .filter((name) => name.length > 0);

        this.logger.debug({ containers }, 'Found NMS containers');
        resolve(containers);
      });

      process.on('error', (err) => {
        this.logger.error({ err: String(err) }, 'docker ps process error');
        reject(err);
      });
    });
  }

  /**
   * Parse a single line from docker logs output
   * Docker format with timestamps: "2024-03-23T14:30:45.123456789Z message"
   */
  private parseDockerLogLine(
    line: string,
    container: string,
    stream: 'stdout' | 'stderr',
  ): DockerLogEntry | null {
    if (!line.trim()) return null;

    // Docker timestamp format: ISO 8601 with nanoseconds
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/);

    if (match) {
      return {
        timestamp: match[1],
        container,
        stream,
        message: match[2],
      };
    }

    // Fallback if no timestamp (shouldn't happen with --timestamps flag)
    return {
      timestamp: new Date().toISOString(),
      container,
      stream,
      message: line,
    };
  }
}
