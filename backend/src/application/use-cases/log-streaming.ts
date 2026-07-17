import pino from 'pino';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { MajorEventType } from './major-event-classifier';

export interface LogEntry {
  timestamp: string;
  service: string;
  message: string;
  // Populated only for Major Events view subscriptions — see major-event-classifier.ts
  event?: { type: MajorEventType; imsi?: string; radioIp?: string; apn?: string };
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

    // Each service's lines were pushed as one contiguous block (tail per
    // service, in a loop) — sort by timestamp so a multi-service selection
    // actually interleaves instead of showing one service's block followed
    // by the next's.
    logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return logs.slice(-limit);
  }

  // For the Major Events view: getRecentLogs()'s "tail -n limit per service, then slice to
  // limit globally" doesn't work here — a single chatty NF (multi-GB DEBUG logs) can crowd
  // out a quiet one within seconds, so a fixed-line tail window ends up covering only a few
  // minutes of wall time even at a large limit.
  //
  // A naive "grep the whole file" fix (tried first) finds every match correctly, but grep
  // has to sequentially scan from byte 0 — measured at 12-17s on this host's 2.7GB mme.log
  // once it's not fully page-cached (which it won't be most of the time, since these files
  // grow constantly and evict their own older pages). Running multiple such greps in
  // parallel made it *worse* (16.8s vs 12.6s sequential) — disk I/O contention, not CPU, is
  // the bottleneck, so concurrency doesn't help.
  //
  // Fix: `tail -c <bytes>` seeks directly near the end of the file instead of scanning from
  // the start (measured ~0.5-1s for several hundred MB regardless of total file size), piped
  // into `grep` so only that bounded window is scanned. GREP_TAIL_BYTES below covers many
  // days on this host's actual log growth rate — comfortably more than the 24h+ this view
  // needs to show — while keeping worst-case latency to roughly one bounded read per
  // service. Sequential on purpose (see contention note above).
  private static readonly GREP_TAIL_BYTES = 300 * 1024 * 1024;

  private grepTail(logPath: string, pattern: string, tailBytes: number, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const tail = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', 'tail', '-c', String(tailBytes), logPath]);
      const grep = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', 'grep', '-a', '-E', pattern]);
      // grep.stdin can EPIPE if grep exits (e.g. killed on timeout) before tail finishes
      // writing — without this handler that's an unhandled 'error' event, which crashes the
      // whole Node process, not just this request.
      grep.stdin.on('error', () => {});
      tail.stdout.pipe(grep.stdin);
      tail.on('error', () => grep.stdin.end());

      let out = '';
      grep.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { tail.kill(); grep.kill(); resolve(out); }, timeoutMs);
      grep.on('close', () => { clearTimeout(timer); resolve(out); });
      grep.on('error', () => { clearTimeout(timer); resolve(out); });
    });
  }

  async getGreppedLogs(grepPatterns: Record<string, string>, maxPerService: number): Promise<LogEntry[]> {
    const logs: LogEntry[] = [];

    // Sequential, not Promise.all — see the contention note above.
    for (const [service, pattern] of Object.entries(grepPatterns)) {
      try {
        const logPath = this.getLogPath(service);
        const stdout = await this.grepTail(logPath, pattern, LogStreamingUseCase.GREP_TAIL_BYTES, 20000);
        const lines = stdout.split('\n').filter(line => line.trim()).slice(-maxPerService);
        for (const line of lines) {
          const logEntry = this.parseLogLine(line, service);
          if (logEntry) logs.push(logEntry);
        }
      } catch (err) {
        this.logger.warn({ service, err: String(err) }, 'Failed to grep log for major events');
      }
    }

    logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return logs;
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
        // open5gs writes these timestamps in the HOST's local time, not UTC.
        // No "Z" suffix here — this must parse as local time (the container's
        // /etc/localtime is bind-mounted from the host, see docker-compose.yml)
        // so toISOString() converts it to true UTC instead of mislabeling it.
        timestamp = new Date(`${year}-${month}-${day}T${timePart}`).toISOString();
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

  async getRecentLogsFromPath(logPath: string, serviceLabel: string, limit: number = 100): Promise<LogEntry[]> {
    try {
      const content = await readFile(logPath, 'utf8').catch(() => '');
      const lines   = content.split('\n').filter(l => l.trim()).slice(-limit);
      return lines.map(line => ({
        timestamp: new Date().toISOString(),
        service:   serviceLabel,
        message:   line,
      }));
    } catch {
      return [];
    }
  }
}
