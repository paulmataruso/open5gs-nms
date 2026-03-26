import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { ActiveSessionsUseCase, ActiveUE } from '../active-sessions';

export interface InterfaceStatus {
  s1mme: {
    active: boolean;
    connectedEnodebs: string[];  // IP addresses
  };
  s1u: {
    active: boolean;
    connectedEnodebs: string[];  // IP addresses
  };
  activeUEs: ActiveUE[];  // NEW: Active UE sessions (IP + IMSI with positive correlation)
}

export class GetInterfaceStatus {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
    private readonly activeSessionsUseCase: ActiveSessionsUseCase,  // NEW
  ) {}

  async execute(): Promise<InterfaceStatus> {
    const s1mmeStatus = await this.checkS1MME();
    const s1uStatus = await this.checkS1U();
    
    // NEW: Get active UE sessions with positive correlation
    let activeUEs: ActiveUE[] = [];
    try {
      activeUEs = await this.activeSessionsUseCase.getActiveUEs();
    } catch (error) {
      this.logger.error({ error }, 'Error getting active UE sessions');
    }
    
    return {
      s1mme: s1mmeStatus,
      s1u: s1uStatus,
      activeUEs,  // NEW
    };
  }

  private async checkS1MME(): Promise<{ active: boolean; connectedEnodebs: string[] }> {
    try {
      // Run: netstat -an | grep 36412 | grep ESTABLISHED
      const result = await this.hostExecutor.executeCommand('netstat', ['-an']);
      
      this.logger.info({ exitCode: result.exitCode, stdoutLength: result.stdout.length }, 'netstat command result');
      
      if (result.exitCode !== 0) {
        this.logger.warn({ stderr: result.stderr }, 'Failed to run netstat for S1-MME check');
        return { active: false, connectedEnodebs: [] };
      }

      // Parse output for SCTP connections on port 36412
      const lines = result.stdout.split('\n');
      const connectedIPs: string[] = [];
      
      this.logger.info({ totalLines: lines.length }, 'Parsing netstat output');
      
      for (const line of lines) {
        // Look for: sctp ... 10.0.1.175:36412 10.0.1.102:36412 ESTABLISHED
        if (line.includes('36412') && line.includes('ESTABLISHED') && line.includes('sctp')) {
          this.logger.info({ line }, 'Found SCTP connection on port 36412');
          const parts = line.trim().split(/\s+/);
          // Format: sctp 0 0 LOCAL_IP:36412 REMOTE_IP:36412 ESTABLISHED
          if (parts.length >= 5) {
            const remoteAddr = parts[4]; // e.g., "10.0.1.102:36412"
            const ip = remoteAddr.split(':')[0];
            if (ip && !connectedIPs.includes(ip)) {
              connectedIPs.push(ip);
              this.logger.info({ ip }, 'Added eNodeB IP');
            }
          }
        }
      }
      
      this.logger.info({ connectedIPs, count: connectedIPs.length }, 'S1-MME check complete');

      return {
        active: connectedIPs.length > 0,
        connectedEnodebs: connectedIPs,
      };
    } catch (error) {
      this.logger.error({ error }, 'Error checking S1-MME interface status');
      return { active: false, connectedEnodebs: [] };
    }
  }

  private async checkS1U(): Promise<{ active: boolean; connectedEnodebs: string[] }> {
    try {
      // Run: conntrack -L -p udp --dport 2152 | grep -oP 'src=\K[0-9.]+' | grep -vE '10\.0\.1\.175|10\.0\.1\.155' | sort -u
      const result = await this.hostExecutor.executeCommand('bash', [
        '-c',
        "conntrack -L -p udp --dport 2152 | grep -oP 'src=\\K[0-9.]+' | grep -vE '10\\.0\\.1\\.175|10\\.0\\.1\\.155' | sort -u"
      ]);
      
      this.logger.info({ exitCode: result.exitCode, stdoutLength: result.stdout.length }, 'conntrack command result');
      
      if (result.exitCode !== 0) {
        this.logger.warn({ stderr: result.stderr }, 'Failed to run conntrack for S1-U check');
        return { active: false, connectedEnodebs: [] };
      }

      // Parse output - each line is an IP
      const lines = result.stdout.split('\n').filter(line => line.trim().length > 0);
      const connectedIPs: string[] = [];
      
      this.logger.info({ totalLines: lines.length }, 'Parsing conntrack output');
      
      for (const line of lines) {
        const ip = line.trim();
        // Validate it's an IP address
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          connectedIPs.push(ip);
          this.logger.info({ ip }, 'Found S1-U connected eNodeB');
        }
      }
      
      this.logger.info({ connectedIPs, count: connectedIPs.length }, 'S1-U check complete');

      return {
        active: connectedIPs.length > 0,
        connectedEnodebs: connectedIPs,
      };
    } catch (error) {
      this.logger.error({ error }, 'Error checking S1-U interface status');
      return { active: false, connectedEnodebs: [] };
    }
  }
}
