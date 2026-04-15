import { WebSocket } from 'ws';
import pino from 'pino';
import { spawn, ChildProcess } from 'child_process';
import { LogStreamingUseCase, LogEntry } from '../../application/use-cases/log-streaming';
import { DockerLogStreamingUseCase } from '../../application/use-cases/docker-log-streaming';

interface LogStreamSubscription {
  source: 'open5gs' | 'docker';
  services: Set<string>;
  processes: Map<string, ChildProcess>;
}

export class LogStreamHandler {
  private subscriptions: Map<WebSocket, LogStreamSubscription> = new Map();

  constructor(
    private readonly logStreamingUseCase: LogStreamingUseCase,
    private readonly dockerLogStreamingUseCase: DockerLogStreamingUseCase,
    private readonly logger: pino.Logger,
  ) {}

  handleConnection(ws: WebSocket): void {
    this.logger.info('Log stream client connected');

    ws.on('message', (data: string) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch (err) {
        this.logger.error({ err: String(err) }, 'Failed to parse WebSocket message');
      }
    });

    ws.on('close', () => {
      this.logger.info('Log stream client disconnected');
      this.unsubscribe(ws);
    });

    ws.on('error', (err) => {
      this.logger.error({ err: String(err) }, 'WebSocket error');
      this.unsubscribe(ws);
    });
  }

  private handleMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'subscribe_logs':
        this.subscribe(ws, message.source || 'open5gs', message.services || []);
        break;
      case 'unsubscribe_logs':
        this.unsubscribe(ws);
        break;
      case 'get_recent_logs':
        this.sendRecentLogs(ws, message.source || 'open5gs', message.services || [], message.limit || 100);
        break;
      default:
        this.logger.warn({ type: message.type }, 'Unknown message type');
    }
  }

  private async sendRecentLogs(ws: WebSocket, source: 'open5gs' | 'docker', services: string[], limit: number): Promise<void> {
    try {
      let logs: any[];
      
      if (source === 'docker') {
        const dockerLogs = await this.dockerLogStreamingUseCase.getRecentLogs(services, limit);
        // Convert Docker log format to unified log format
        logs = dockerLogs.map(log => ({
          timestamp: log.timestamp,
          service: log.container,
          message: `[${log.stream}] ${log.message}`,
        }));
      } else {
        logs = await this.logStreamingUseCase.getRecentLogs(services, limit);
      }
      
      ws.send(JSON.stringify({
        type: 'recent_logs',
        source,
        logs,
      }));
    } catch (err) {
      this.logger.error({ err: String(err), source }, 'Failed to send recent logs');
    }
  }

  private subscribe(ws: WebSocket, source: 'open5gs' | 'docker', services: string[]): void {
    // Unsubscribe existing streams
    this.unsubscribe(ws);

    const subscription: LogStreamSubscription = {
      source,
      services: new Set(services),
      processes: new Map(),
    };

    this.subscriptions.set(ws, subscription);

    // Start streaming for each service
    for (const service of services) {
      if (source === 'docker') {
        this.startDockerStream(ws, service, subscription);
      } else {
        this.startServiceStream(ws, service, subscription);
      }
    }

    // Only log if services array is not empty
    if (services.length > 0) {
      this.logger.debug({ source, services }, 'Log stream subscription started');
    }
  }

  private startServiceStream(ws: WebSocket, service: string, subscription: LogStreamSubscription): void {
    const logPath = this.logStreamingUseCase.getLogPath(service);

    // Use tail -f to follow log file
    const process = spawn('tail', [
      '-f',
      '-n',
      '0', // Start from end of file
      logPath,
    ]);

    subscription.processes.set(service, process);

    process.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());

      for (const line of lines) {
        const logEntry = this.parseLogLine(line, service);

        if (logEntry && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'log_entry',
            source: 'open5gs',
            log: logEntry,
          }));
        }
      }
    });

    process.stderr.on('data', (data: Buffer) => {
      this.logger.warn({ service, stderr: data.toString() }, 'tail stderr');
    });

    process.on('close', (code) => {
      // Only log errors, not normal closures
      if (code !== 0 && code !== null) {
        this.logger.warn({ service, code }, 'tail process closed with error');
      }
      subscription.processes.delete(service);
    });

    process.on('error', (err) => {
      this.logger.error({ service, err: String(err) }, 'tail process error');
      subscription.processes.delete(service);
    });
  }

  private parseLogLine(line: string, service: string): LogEntry | null {
    if (!line.trim()) return null;

    try {
      // Open5GS log format: MM/DD HH:MM:SS.mmm: [level] message
      const timestampMatch = line.match(/^(\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}):/);
      
      let timestamp: string;
      let message: string;

      if (timestampMatch) {
        const dateTimeStr = timestampMatch[1];
        const year = new Date().getFullYear();
        const [datePart, timePart] = dateTimeStr.split(/\s+/);
        const [month, day] = datePart.split('/');
        timestamp = new Date(`${year}-${month}-${day}T${timePart}Z`).toISOString();
        message = line.substring(timestampMatch[0].length).trim();
      } else {
        timestamp = new Date().toISOString();
        message = line;
      }

      return {
        timestamp,
        service,
        message,
      };
    } catch (err) {
      return {
        timestamp: new Date().toISOString(),
        service,
        message: line,
      };
    }
  }

  private startDockerStream(ws: WebSocket, container: string, subscription: LogStreamSubscription): void {
    const process = this.dockerLogStreamingUseCase.streamLogs(container, 0);

    subscription.processes.set(container, process);

    // Handle both stdout and stderr
    const handleData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());

      for (const line of lines) {
        const logEntry = this.parseDockerLogLine(line, container, stream);

        if (logEntry && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'log_entry',
            source: 'docker',
            log: {
              timestamp: logEntry.timestamp,
              service: logEntry.container,
              message: `[${logEntry.stream}] ${logEntry.message}`,
            },
          }));
        }
      }
    };

    if (process.stdout) {
      process.stdout.on('data', handleData('stdout'));
    }
    if (process.stderr) {
      process.stderr.on('data', handleData('stderr'));
    }

    process.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.logger.warn({ container, code }, 'docker logs process closed with error');
      }
      subscription.processes.delete(container);
    });

    process.on('error', (err) => {
      this.logger.error({ container, err: String(err) }, 'docker logs process error');
      subscription.processes.delete(container);
    });
  }

  private parseDockerLogLine(
    line: string,
    container: string,
    stream: 'stdout' | 'stderr',
  ): { timestamp: string; container: string; stream: string; message: string } | null {
    if (!line.trim()) return null;

    // Docker log format with timestamps: "2024-03-23T14:30:45.123456789Z message"
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/);

    if (match) {
      return {
        timestamp: match[1],
        container,
        stream,
        message: match[2],
      };
    }

    // Fallback if no timestamp
    return {
      timestamp: new Date().toISOString(),
      container,
      stream,
      message: line,
    };
  }

  private unsubscribe(ws: WebSocket): void {
    const subscription = this.subscriptions.get(ws);
    if (!subscription) return;

    // Kill all tail/docker processes
    for (const [service, process] of subscription.processes) {
      try {
        process.kill();
      } catch (err) {
        this.logger.error({ service, err: String(err) }, 'Failed to kill process');
      }
    }

    this.subscriptions.delete(ws);
    this.logger.debug('Log stream subscription stopped');
  }

  cleanup(): void {
    // Cleanup all subscriptions on shutdown
    for (const ws of this.subscriptions.keys()) {
      this.unsubscribe(ws);
    }
  }
}
