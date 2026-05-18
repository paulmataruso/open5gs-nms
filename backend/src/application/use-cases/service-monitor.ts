import pino from 'pino';
import * as net from 'net';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IWebSocketBroadcaster } from '../../domain/interfaces/websocket-broadcaster';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ServiceStatus, ServiceName, SERVICE_UNIT_MAP, SERVICE_RESTART_ORDER } from '../../domain/entities/service-status';
import { ServiceActionDto, ServiceStatusDto } from '../dto';

export class ServiceMonitorUseCase {
  private statusCache: Record<string, ServiceStatus> = {};
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly wsBroadcaster: IWebSocketBroadcaster,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
  ) {}

  async getAll(): Promise<ServiceStatusDto[]> {
    const results: ServiceStatusDto[] = [];
    for (const [name, unitName] of Object.entries(SERVICE_UNIT_MAP)) {
      const status = await this.getServiceStatus(name as ServiceName, unitName);
      results.push(status);
    }
    return results;
  }

  async getOne(name: ServiceName): Promise<ServiceStatusDto> {
    const unitName = SERVICE_UNIT_MAP[name];
    return this.getServiceStatus(name, unitName);
  }

  async executeAction(dto: ServiceActionDto): Promise<{ success: boolean; message: string }> {
    const unitName = SERVICE_UNIT_MAP[dto.service];
    this.logger.info({ service: dto.service, action: dto.action }, 'Executing service action');

    try {
      let result;
      switch (dto.action) {
        case 'start':
          result = await this.hostExecutor.startService(unitName);
          break;
        case 'stop':
          result = await this.hostExecutor.stopService(unitName);
          break;
        case 'restart':
          result = await this.hostExecutor.restartService(unitName);
          break;
        case 'enable':
          result = await this.hostExecutor.enableService(unitName);
          break;
        case 'disable':
          result = await this.hostExecutor.disableService(unitName);
          break;
      }

      const success = result.exitCode === 0;
      await this.auditLogger.log({
        action: `service_${dto.action}` as any,
        user: 'admin',
        target: dto.service,
        details: success ? `${dto.action} successful` : result.stderr,
        success,
      });

      return {
        success,
        message: success ? `Service ${dto.service} ${dto.action} successful` : result.stderr,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: msg, service: dto.service }, 'Service action failed');
      return { success: false, message: msg };
    }
  }

  async executeAllAction(action: 'start' | 'stop' | 'restart', serviceFilter?: string[]): Promise<{ success: boolean; message: string; results: Array<{ service: string; success: boolean }> }> {
    this.logger.info({ action, serviceFilter }, 'Executing action on services');
    const results: Array<{ service: string; success: boolean }> = [];

    let services = action === 'stop'
      ? [...SERVICE_RESTART_ORDER].reverse()
      : SERVICE_RESTART_ORDER;

    // Filter to only the requested services if a filter was provided
    if (serviceFilter && serviceFilter.length > 0) {
      services = services.filter(s => serviceFilter.includes(s));
    }

    for (const service of services) {
      const result = await this.executeAction({ service, action });
      results.push({ service, success: result.success });
      if (!result.success) {
        this.logger.warn({ service, action }, 'Service action failed, continuing with others');
      }
      await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between services
    }

    const allSuccess = results.every(r => r.success);
    return {
      success: allSuccess,
      message: allSuccess ? `All services ${action} successful` : `Some services failed to ${action}`,
      results,
    };
  }

  startPolling(intervalMs: number = 3000): void {
    if (this.interval) return;
    this.logger.info({ intervalMs }, 'Starting service status polling');

    this.interval = setInterval(async () => {
      try {
        const statuses = await this.getAll();
        this.wsBroadcaster.broadcastServiceStatus(statuses);
      } catch (err) {
        this.logger.error({ err }, 'Polling error');
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStatusCache(): Record<string, ServiceStatus> {
    return { ...this.statusCache };
  }

  // ── MongoDB Docker fallback ─────────────────────────────────────────────────
  // When MongoDB runs in Docker there is no systemd unit — TCP ping instead.
  private checkMongoTcp(host = '127.0.0.1', port = 27017, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs);
      sock.on('connect',  () => finish(true));
      sock.on('error',    () => finish(false));
      sock.on('timeout',  () => finish(false));
      sock.connect(port, host);
    });
  }

  // Public method for topology endpoint to get fresh MongoDB status
  async getMongoStatus(): Promise<{ active: boolean; source: string }> {
    const status = await this.getMongoDockerStatus();
    return { active: status.active, source: status.source || 'direct' };
  }

  private async getMongoDockerStatus(): Promise<ServiceStatus> {
    const now = Date.now();
    const shouldLog = (now - this.lastMongoLogTime) >= ServiceMonitorUseCase.MONGO_LOG_INTERVAL_MS;
    if (shouldLog) this.lastMongoLogTime = now;

    const dockerResult = await this.hostExecutor.executeLocalCommand('bash', ['-c',
      `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null | grep -i mongo || true`,
    ]);

    if (shouldLog) {
      this.logger.info({ dockerOut: dockerResult.stdout.trim() }, 'MongoDB Docker probe output');
    }

    const line = dockerResult.stdout.trim().split('\n')[0] || '';
    const parts = line.split('\t');
    const containerName   = parts[0] || '';
    const containerStatus = parts[1] || '';
    const isRunning       = containerStatus.toLowerCase().startsWith('up');

    const tcpOk = await this.checkMongoTcp();

    if (shouldLog) {
      this.logger.info({ containerName, containerStatus, isRunning, tcpOk }, 'MongoDB Docker status resolved');
    }

    const active = tcpOk;

    return {
      name: 'mongodb',
      unitName: 'mongod',
      active,
      enabled: active,
      state:    active ? 'active'   : 'inactive',
      subState: active ? 'running'  : 'dead',
      pid:          null,
      uptime:       null,
      restartCount: 0,
      cpuPercent:   null,
      memoryBytes:  null,
      memoryPercent: null,
      lastChecked: new Date().toISOString(),
      source: containerName ? 'docker' : 'direct',
    };
  }

  // Timestamp of last MongoDB Docker probe log — used to throttle noisy log output
  private lastMongoLogTime = 0;
  private static MONGO_LOG_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  private async getServiceStatus(name: ServiceName, unitName: string): Promise<ServiceStatusDto> {
    // MongoDB special case: check Docker/TCP FIRST if systemctl says inactive
    // This handles users who run MongoDB in Docker instead of as a systemd service.
    if (name === 'mongodb') {
      try {
        const [isActive] = await Promise.all([
          this.hostExecutor.isServiceActive(unitName),
        ]);
        if (!isActive) {
          // systemctl says not active (expected when MongoDB runs in Docker) —
          // check Docker/TCP before reporting red. Log suppressed to once per 15 min.
          const dockerStatus = await this.getMongoDockerStatus();
          this.statusCache[name] = dockerStatus;
          return dockerStatus;
        }
      } catch {
        // systemctl itself failed (also expected when no mongod unit exists) —
        // try Docker/TCP fallback. Log suppressed to once per 15 min.
        try {
          const dockerStatus = await this.getMongoDockerStatus();
          this.statusCache[name] = dockerStatus;
          return dockerStatus;
        } catch (dockerErr) {
          this.logger.warn({ dockerErr: String(dockerErr) }, 'MongoDB Docker fallback failed');
        }
      }
    }

    try {
      const [isActive, isEnabled] = await Promise.all([
        this.hostExecutor.isServiceActive(unitName),
        this.hostExecutor.isServiceEnabled(unitName),
      ]);

      const showResult = await this.hostExecutor.executeCommand(
        'systemctl',
        ['show', unitName, '--no-pager', '--property=ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,MemoryCurrent,CPUUsageNSec'],
      );

      const props = this.parseSystemctlShow(showResult.stdout);

      const status: ServiceStatus = {
        name,
        unitName,
        active: isActive,
        enabled: isEnabled,
        state: props.ActiveState || 'unknown',
        subState: props.SubState || 'unknown',
        pid: props.MainPID ? parseInt(props.MainPID, 10) || null : null,
        uptime: props.ExecMainStartTimestamp || null,
        restartCount: props.NRestarts ? parseInt(props.NRestarts, 10) : 0,
        cpuPercent: props.CPUUsageNSec
          ? parseFloat(props.CPUUsageNSec) / 1_000_000_000
          : null,
        memoryBytes: props.MemoryCurrent && props.MemoryCurrent !== '[not set]'
          ? parseInt(props.MemoryCurrent, 10)
          : null,
        memoryPercent: null,
        lastChecked: new Date().toISOString(),
        source: 'systemd',
      };

      this.statusCache[name] = status;
      return status;
    } catch (err) {
      this.logger.debug({ err, name }, 'Failed to get service status');
      const fallback: ServiceStatus = {
        name,
        unitName,
        active: false,
        enabled: false,
        state: 'unknown',
        subState: 'unknown',
        pid: null,
        uptime: null,
        restartCount: 0,
        cpuPercent: null,
        memoryBytes: null,
        memoryPercent: null,
        lastChecked: new Date().toISOString(),
      };
      this.statusCache[name] = fallback;
      return fallback;
    }
  }

  private parseSystemctlShow(output: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim();
        result[key] = value;
      }
    }
    return result;
  }
}
