import pino from 'pino';
import { ChildProcess } from 'child_process';
import { IDockerExecutor, DockerLogEntry } from '../../domain/interfaces/docker-executor';

/**
 * Docker Log Streaming Use Case
 * Orchestrates Docker container log streaming and retrieval
 */
export class DockerLogStreamingUseCase {
  constructor(
    private readonly dockerExecutor: IDockerExecutor,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Get list of all NMS containers
   * @returns Array of container names
   */
  async getContainers(): Promise<string[]> {
    try {
      const containers = await this.dockerExecutor.getContainers();
      this.logger.info({ count: containers.length }, 'Retrieved container list');
      return containers;
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Failed to list containers');
      return [];
    }
  }

  /**
   * Get recent logs from multiple containers
   * @param containers Array of container names
   * @param limit Maximum number of total log lines to return
   * @returns Combined and sorted log entries
   */
  async getRecentLogs(containers: string[], limit: number = 100): Promise<DockerLogEntry[]> {
    if (containers.length === 0) {
      return [];
    }

    const allLogs: DockerLogEntry[] = [];

    // Fetch logs from each container
    for (const container of containers) {
      try {
        const logs = await this.dockerExecutor.getRecentLogs(container, limit);
        allLogs.push(...logs);
      } catch (err) {
        this.logger.warn(
          { container, err: String(err) },
          'Failed to fetch logs for container',
        );
      }
    }

    // Sort by timestamp and limit total
    const sortedLogs = allLogs.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const limitedLogs = sortedLogs.slice(-limit);

    this.logger.debug(
      { containers, totalLogs: allLogs.length, returnedLogs: limitedLogs.length },
      'Retrieved recent Docker logs',
    );

    return limitedLogs;
  }

  /**
   * Stream logs from a container
   * @param container Container name
   * @param tail Number of historical lines to include
   * @returns ChildProcess for the docker logs stream
   */
  streamLogs(container: string, tail: number = 0): ChildProcess {
    this.logger.info({ container, tail }, 'Starting Docker log stream');
    return this.dockerExecutor.streamLogs(container, tail);
  }
}
