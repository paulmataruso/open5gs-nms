import { ChildProcess } from 'child_process';

/**
 * Docker Log Entry
 * Represents a single log entry from a Docker container
 */
export interface DockerLogEntry {
  timestamp: string;
  container: string;
  stream: 'stdout' | 'stderr';
  message: string;
}

/**
 * Docker Executor Interface
 * Abstracts Docker operations for dependency inversion
 */
export interface IDockerExecutor {
  /**
   * Stream logs from a container in real-time
   */
  streamLogs(containerName: string, tail?: number): ChildProcess;

  /**
   * Get recent logs from a container
   */
  getRecentLogs(containerName: string, lines?: number): Promise<DockerLogEntry[]>;

  /**
   * List all NMS containers
   */
  getContainers(): Promise<string[]>;
}
