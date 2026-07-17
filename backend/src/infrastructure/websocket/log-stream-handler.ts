import { WebSocket } from 'ws';
import pino from 'pino';
import { spawn, ChildProcess } from 'child_process';
import { LogStreamingUseCase, LogEntry } from '../../application/use-cases/log-streaming';
import { DockerLogStreamingUseCase } from '../../application/use-cases/docker-log-streaming';
import { classifyMajorEvent, MajorEvent, MajorEventType, MAJOR_EVENT_GREP_PATTERNS, EVENT_TYPE_SERVICES } from '../../application/use-cases/major-event-classifier';

interface LogStreamSubscription {
  source: 'open5gs' | 'docker' | 'genieacs' | 'frr';
  services: Set<string>;
  processes: Map<string, ChildProcess>;
  filter?: string; // optional line-content filter
  // Major Events mode — see major-event-classifier.ts. Empty/undefined sets mean "no
  // restriction on that axis" (only the majorEventsOnly flag itself narrows the stream).
  majorEventsOnly?: boolean;
  imsis?: Set<string>;
  radioIps?: Set<string>;
  eventTypes?: Set<MajorEventType>;
}

// AND across imsis/radioIps/eventTypes, OR within each (empty set = unrestricted on that
// axis) — lets a user narrow by "radio A or B" AND "IMSI X or Y" AND "attach or detach"
// simultaneously, e.g. picking just "UE Attach" shows every attach across all radios/IMSIs.
function matchesEventFilters(
  event: MajorEvent, imsis?: Set<string>, radioIps?: Set<string>, eventTypes?: Set<MajorEventType>,
): boolean {
  if (imsis && imsis.size > 0 && (!event.imsi || !imsis.has(event.imsi))) return false;
  if (radioIps && radioIps.size > 0 && (!event.radioIp || !radioIps.has(event.radioIp))) return false;
  if (eventTypes && eventTypes.size > 0 && !eventTypes.has(event.type)) return false;
  return true;
}

export class LogStreamHandler {
  private subscriptions: Map<WebSocket, LogStreamSubscription> = new Map();

  private readonly genieacsLogBasePath = '/var/log/genieacs';
  private readonly frrLogPath = '/var/log/frr/frr.log';

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
        this.subscribe(
          ws, message.source || 'open5gs', message.services || [], message.filter,
          message.majorEventsOnly, message.imsis, message.radioIps, message.eventTypes,
        );
        break;
      case 'unsubscribe_logs':
        this.unsubscribe(ws);
        break;
      case 'get_recent_logs':
        this.sendRecentLogs(
          ws, message.source || 'open5gs', message.services || [], message.limit || 100, message.filter,
          message.majorEventsOnly, message.imsis, message.radioIps, message.eventTypes,
        );
        break;
      default:
        this.logger.warn({ type: message.type }, 'Unknown message type');
    }
  }

  private async sendRecentLogs(
    ws: WebSocket, source: 'open5gs' | 'docker' | 'genieacs' | 'frr', services: string[], limit: number, filter?: string,
    majorEventsOnly?: boolean, imsisArr?: string[], radioIpsArr?: string[], eventTypesArr?: string[],
  ): Promise<void> {
    try {
      let logs: any[];

      if (source === 'open5gs' && majorEventsOnly) {
        const eventTypes = eventTypesArr && eventTypesArr.length > 0
          ? new Set(eventTypesArr as MajorEventType[]) : undefined;
        // If the event-type filter can't possibly match a given service (e.g. filtering to
        // just PDU session up/down never needs mme.log/amf.log), skip grepping it entirely.
        const relevantServices = eventTypes
          ? new Set([...eventTypes].flatMap(t => EVENT_TYPE_SERVICES[t] ?? []))
          : undefined;
        const grepServices = Object.fromEntries(
          Object.entries(MAJOR_EVENT_GREP_PATTERNS)
            .filter(([svc]) => services.includes(svc) && (!relevantServices || relevantServices.has(svc))),
        );
        // A fixed-line tail (even a large one) doesn't work for major events — a single
        // chatty NF's multi-GB DEBUG log can crowd out a quiet one within seconds of wall
        // time. grep the relevant log files directly for known event patterns instead,
        // bounded to a recent byte window (see getGreppedLogs) so it stays fast even cold.
        // 2000/service is still generous relative to typical event volume (the final
        // response is sliced to `limit` anyway) — keeps parse/classify work down.
        const rawLines = await this.logStreamingUseCase.getGreppedLogs(grepServices, 2000);
        const imsis = imsisArr && imsisArr.length > 0 ? new Set(imsisArr) : undefined;
        const radioIps = radioIpsArr && radioIpsArr.length > 0 ? new Set(radioIpsArr) : undefined;
        logs = rawLines
          .flatMap((l): LogEntry[] => {
            const event = classifyMajorEvent(l.message, l.service);
            if (!event || !matchesEventFilters(event, imsis, radioIps, eventTypes)) return [];
            return [{ ...l, event }];
          })
          .slice(-limit);
      } else if (source === 'docker') {
        const dockerLogs = await this.dockerLogStreamingUseCase.getRecentLogs(services, limit * 4);
        logs = dockerLogs
          .filter(log => !filter || log.message.includes(`"module":"${filter}"`) || log.message.includes(`module:${filter}`))
          .slice(-limit)
          .map(log => ({
            timestamp: log.timestamp,
            service: log.container,
            message: `[${log.stream}] ${log.message}`,
          }));
      } else if (source === 'genieacs') {
        // Read GenieACS log files directly from the mounted path
        logs = [];
        for (const service of services) {
          const serviceLogs = await this.logStreamingUseCase.getRecentLogsFromPath(
            `${this.genieacsLogBasePath}/${service}.log`,
            service,
            limit * 10, // fetch more then filter down
          );
          // Apply device filter to recent logs
          const filtered = filter
            ? serviceLogs.filter(l => this.genieacsLineMatchesFilter(l.message, filter))
            : serviceLogs;
          logs.push(...filtered);
        }
        // getRecentLogsFromPath stamps every line with the fetch time (it
        // doesn't know these are GenieACS JSON lines with their own `time`
        // field), so re-derive the real timestamp from each line before
        // sorting — otherwise every line from one service ends up with
        // nearly the same "now" timestamp and a multi-service selection
        // still comes back as one service's block followed by the next's.
        logs = logs.map(l => ({ ...l, timestamp: this.parseGenieacsTimestamp(l.message) }));
        logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        logs = logs.slice(-limit);
      } else if (source === 'frr') {
        // Same story as GenieACS above — getRecentLogsFromPath doesn't know this file's own
        // timestamp format, so re-parse each raw line for its real time before sorting.
        const raw = await this.logStreamingUseCase.getRecentLogsFromPath(this.frrLogPath, 'frr', limit * 10);
        logs = raw
          .map(l => this.parseFrrLogLine(l.message, 'frr'))
          .filter((l): l is LogEntry => l !== null)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          .slice(-limit);
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

  private subscribe(
    ws: WebSocket, source: 'open5gs' | 'docker' | 'genieacs' | 'frr', services: string[], filter?: string,
    majorEventsOnly?: boolean, imsisArr?: string[], radioIpsArr?: string[], eventTypesArr?: string[],
  ): void {
    // Unsubscribe existing streams
    this.unsubscribe(ws);

    const eventTypes = eventTypesArr && eventTypesArr.length > 0
      ? new Set(eventTypesArr as MajorEventType[]) : undefined;
    // If the event-type filter can't possibly match a given service, no need to even tail it.
    const relevantServices = eventTypes
      ? new Set([...eventTypes].flatMap(t => EVENT_TYPE_SERVICES[t] ?? []))
      : undefined;

    const subscription: LogStreamSubscription = {
      source,
      services: new Set(services),
      processes: new Map(),
      filter,
      majorEventsOnly,
      imsis: imsisArr && imsisArr.length > 0 ? new Set(imsisArr) : undefined,
      radioIps: radioIpsArr && radioIpsArr.length > 0 ? new Set(radioIpsArr) : undefined,
      eventTypes,
    };

    this.subscriptions.set(ws, subscription);

    // Start streaming for each service
    for (const service of services) {
      // Major Events mode only ever produces matches for services with a classifier rule
      // (mme/amf/smf) — spawning a tail -f for the other ~13 NF logs just for them to sit
      // there discarding every line is pure overhead on every view load, so skip them.
      // Same idea for a specific event-type filter: skip services it can never match.
      if (majorEventsOnly && !(service in MAJOR_EVENT_GREP_PATTERNS)) continue;
      if (relevantServices && !relevantServices.has(service)) continue;

      if (source === 'docker') {
        this.startDockerStream(ws, service, subscription);
      } else if (source === 'genieacs') {
        this.startGenieacsStream(ws, service, subscription);
      } else if (source === 'frr') {
        this.startFrrStream(ws, subscription);
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
        if (!logEntry) continue;

        if (subscription.majorEventsOnly) {
          const event = classifyMajorEvent(logEntry.message, service);
          if (!event || !matchesEventFilters(event, subscription.imsis, subscription.radioIps, subscription.eventTypes)) continue;
          logEntry.event = event;
        }

        if (ws.readyState === WebSocket.OPEN) {
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
        // open5gs writes these timestamps in the HOST's local time, not UTC.
        // No "Z" suffix here — this must parse as local time (the container's
        // /etc/localtime is bind-mounted from the host, see docker-compose.yml)
        // so toISOString() converts it to true UTC instead of mislabeling it.
        timestamp = new Date(`${year}-${month}-${day}T${timePart}`).toISOString();
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

  private startGenieacsStream(ws: WebSocket, service: string, subscription: LogStreamSubscription): void {
    const logPath = `${this.genieacsLogBasePath}/${service}.log`;

    const process = spawn('tail', ['-f', '-n', '0', logPath]);
    subscription.processes.set(service, process);

    process.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      for (const line of lines) {
        // Apply device filter — GenieACS logs include the device _id in every line
        // Filter can be the device _id, serial, or IP address
        if (subscription.filter && !this.genieacsLineMatchesFilter(line, subscription.filter)) continue;

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type:   'log_entry',
            source: 'genieacs',
            log: {
              timestamp: this.parseGenieacsTimestamp(line),
              service,
              message: line,
            },
          }));
        }
      }
    });

    process.stderr.on('data', (data: Buffer) => {
      this.logger.warn({ service, stderr: data.toString() }, 'genieacs tail stderr');
    });

    process.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.logger.warn({ service, code }, 'genieacs tail process closed with error');
      }
      subscription.processes.delete(service);
    });

    process.on('error', (err) => {
      this.logger.error({ service, err: String(err) }, 'genieacs tail process error');
      subscription.processes.delete(service);
    });
  }

  // GenieACS log lines are JSON — device ID appears as "deviceId":"..." or in the message text
  // Also match on IP address if filter looks like an IP
  private genieacsLineMatchesFilter(line: string, filter: string): boolean {
    if (!filter) return true;
    // Decode URI encoding in filter for matching (e.g. %2D -> -)
    const decoded = decodeURIComponent(filter).toLowerCase();
    const lineLower = line.toLowerCase();
    // Try direct substring match first (works for serial numbers, IPs)
    if (lineLower.includes(decoded)) return true;
    // Also try the raw encoded form
    if (lineLower.includes(filter.toLowerCase())) return true;
    return false;
  }

  private parseGenieacsTimestamp(line: string): string {
    // GenieACS log lines are JSON: {"level":30,"time":1234567890,...}
    try {
      const parsed = JSON.parse(line);
      if (parsed.time) return new Date(parsed.time).toISOString();
    } catch { /* not JSON */ }
    return new Date().toISOString();
  }

  // FRR writes ONE combined file (all daemons — eigrpd, zebra, mgmtd, staticd — share the
  // same "log file" target), so there's no per-service split like open5gs/genieacs; the
  // frontend always subscribes with a single pseudo-service name of 'frr'.
  private startFrrStream(ws: WebSocket, subscription: LogStreamSubscription): void {
    const process = spawn('tail', ['-f', '-n', '0', this.frrLogPath]);
    subscription.processes.set('frr', process);

    process.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      for (const line of lines) {
        const logEntry = this.parseFrrLogLine(line, 'frr');
        if (logEntry && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'log_entry', source: 'frr', log: logEntry }));
        }
      }
    });

    process.stderr.on('data', (data: Buffer) => {
      this.logger.warn({ stderr: data.toString() }, 'frr tail stderr');
    });

    process.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.logger.warn({ code }, 'frr tail process closed with error');
      }
      subscription.processes.delete('frr');
    });

    process.on('error', (err) => {
      this.logger.error({ err: String(err) }, 'frr tail process error');
      subscription.processes.delete('frr');
    });
  }

  // FRR file-log format: "YYYY/MM/DD HH:MM:SS DAEMON: message" — no milliseconds, and no
  // severity word printed per-line unless "log record-priority" is configured (it isn't).
  // Same host-local-time convention as open5gs (see parseLogLine's comment) — the container's
  // TZ is set to match the host.
  private parseFrrLogLine(line: string, service: string): LogEntry | null {
    if (!line.trim()) return null;
    const m = line.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(.*)$/s);
    if (!m) {
      return { timestamp: new Date().toISOString(), service, message: line };
    }
    const [, year, month, day, time, rest] = m;
    try {
      return { timestamp: new Date(`${year}-${month}-${day}T${time}`).toISOString(), service, message: rest };
    } catch {
      return { timestamp: new Date().toISOString(), service, message: rest };
    }
  }

  private startDockerStream(ws: WebSocket, container: string, subscription: LogStreamSubscription): void {
    const process = this.dockerLogStreamingUseCase.streamLogs(container, 0);

    subscription.processes.set(container, process);

    // Handle both stdout and stderr
    const handleData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());

      for (const line of lines) {
        // Apply filter if set (e.g. 'sas' only passes lines with "module":"sas")
        if (subscription.filter) {
          const needle = `"module":"${subscription.filter}"`;
          if (!line.includes(needle)) continue;
        }

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
