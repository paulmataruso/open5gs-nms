import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';

export interface LogEntry {
  timestamp: string;
  service: string;
  message: string;
}

export interface LogStreamOptions {
  services: string[];
  maxLines?: number;
}

export class LogStreamingUseCase {
  private readonly logBasePath = '/var/log/open5gs';

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
  ) {}

  async getRecentLogs(services: string[], limit: number = 100): Promise<LogEntry[]> {
    const logs: LogEntry[] = [];

    for (const service of services) {
      try {
        const logPath = this.getLogPath(service);
        
        // Use tail to get last N lines
        const result = await this.hostExecutor.executeCommand('tail', [
          '-n',
          limit.toString(),
          logPath,
        ]);

        if (result.exitCode === 0) {
          const lines = result.stdout.split('\n').filter(line => line.trim());
          for (const line of lines) {
            const logEntry = this.parseLogLine(line, service);
            if (logEntry) {
              logs.push(logEntry);
            }
          }
        }
      } catch (err) {
        this.logger.warn({ service, err: String(err) }, 'Failed to fetch logs for service');
      }
    }

    // Sort by timestamp (approximate - using insertion order)
    return logs.slice(-limit);
  }

  private parseLogLine(line: string, service: string): LogEntry | null {
    if (!line.trim()) return null;

    try {
      // Open5GS log format is typically: MM/DD HH:MM:SS.mmm: [level] message
      // Example: 02/22 20:15:32.123: [info] NRF initialization...
      
      const timestampMatch = line.match(/^(\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}):/);
      
      let timestamp: string;
      let message: string;

      if (timestampMatch) {
        const dateTimeStr = timestampMatch[1];
        // Convert MM/DD HH:MM:SS.mmm to ISO format (approximate - use current year)
        const year = new Date().getFullYear();
        const [datePart, timePart] = dateTimeStr.split(/\s+/);
        const [month, day] = datePart.split('/');
        timestamp = new Date(`${year}-${month}-${day}T${timePart}Z`).toISOString();
        message = line.substring(timestampMatch[0].length).trim();
      } else {
        // Fallback if no timestamp found
        timestamp = new Date().toISOString();
        message = line;
      }

      return {
        timestamp,
        service,
        message,
      };
    } catch (err) {
      // Return raw line if parsing fails
      return {
        timestamp: new Date().toISOString(),
        service,
        message: line,
      };
    }
  }

  getLogPath(service: string): string {
    return `${this.logBasePath}/${service}.log`;
  }
}
