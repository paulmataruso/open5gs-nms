import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import pino from 'pino';

export interface AutoAssignIPsResult {
  success: boolean;
  assigned: number;
  skipped: number;
  failed: number;
  ipPool: string;
  errors?: string[];
}

export interface IPAssignment {
  imsi: string;
  ipv4: string;
}

/**
 * Auto-assign IPv4 addresses to all subscribers from the UPF session pool
 */
export class AutoAssignIPsUseCase {
  constructor(
    private readonly subscriberRepo: ISubscriberRepository,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  async execute(): Promise<AutoAssignIPsResult> {
    try {
      // Step 1: Get IP pool from UPF configuration
      const upfConfig = await this.configRepo.loadUpf();
      const rawYaml = (upfConfig as any).rawYaml;
      const session = rawYaml?.upf?.session?.[0];
      
      if (!session?.subnet) {
        throw new Error('No session pool subnet found in UPF configuration');
      }

      const ipPool = session.subnet; // e.g., "10.45.0.0/16"
      const gatewayIP = session.gateway; // e.g., "10.45.0.1" - must be excluded
      this.logger.info({ ipPool, gatewayIP }, 'Using IP pool from UPF configuration');

      // Step 2: Parse the subnet to get base IP and netmask
      const { baseIp, netmask, startIp, endIp } = this.parseSubnet(ipPool);
      const gatewayIPNum = gatewayIP ? this.ipToNumber(gatewayIP) : null;
      this.logger.info({ baseIp, netmask, startIp, endIp, gatewayIP }, 'Parsed IP pool');

      // Step 3: Get all subscribers
      const allSubscribers = await this.subscriberRepo.findAllFull();
      this.logger.info({ count: allSubscribers.length }, 'Found subscribers');

      // Step 4: Generate and assign IPs
      let assigned = 0;
      let skipped = 0;
      let failed = 0;
      const errors: string[] = [];
      let currentIp = this.ipToNumber(startIp);
      const endIpNum = this.ipToNumber(endIp);

      for (const subscriber of allSubscribers) {
        try {
          // Check if subscriber already has an IP assigned
          const hasIp = subscriber.slice?.some(slice =>
            slice.session?.some(session => session.ue?.ipv4)
          );

          if (hasIp) {
            skipped++;
            continue;
          }

          // Assign IP to the first session of the first slice
          if (currentIp > endIpNum) {
            errors.push(`IP pool exhausted after ${assigned} assignments`);
            failed++;
            break;
          }

          // Skip gateway IP if it matches current IP
          if (gatewayIPNum !== null && currentIp === gatewayIPNum) {
            this.logger.info({ skippedIP: this.numberToIp(currentIp) }, 'Skipping gateway IP');
            currentIp++;
            if (currentIp > endIpNum) {
              errors.push(`IP pool exhausted after ${assigned} assignments`);
              failed++;
              break;
            }
          }

          const assignedIp = this.numberToIp(currentIp);
          currentIp++;

          // Update subscriber with new IP
          await this.subscriberRepo.assignIPv4(subscriber.imsi, assignedIp);
          assigned++;
          
        } catch (error) {
          failed++;
          errors.push(`Failed to assign IP to ${subscriber.imsi}: ${error instanceof Error ? error.message : String(error)}`);
          this.logger.warn({ imsi: subscriber.imsi, error: String(error) }, 'Failed to assign IP');
        }
      }

      this.logger.info({ assigned, skipped, failed }, 'IP assignment completed');

      return {
        success: true,
        assigned,
        skipped,
        failed,
        ipPool,
        errors: errors.length > 0 ? errors : undefined,
      };

    } catch (error) {
      this.logger.error({ error: String(error) }, 'Auto-assign IPs failed');
      throw error;
    }
  }

  /**
   * Get list of all IP assignments for display
   */
  async getIPAssignments(): Promise<IPAssignment[]> {
    const subscribers = await this.subscriberRepo.findAllFull();
    const assignments: IPAssignment[] = [];

    for (const subscriber of subscribers) {
      // Find the first IPv4 address assigned
      const ipv4 = subscriber.slice
        ?.flatMap(slice => slice.session || [])
        ?.find(session => session.ue?.ipv4)
        ?.ue?.ipv4;

      if (ipv4) {
        assignments.push({
          imsi: subscriber.imsi,
          ipv4,
        });
      }
    }

    return assignments.sort((a, b) => a.imsi.localeCompare(b.imsi));
  }

  // Helper functions for IP manipulation
  private parseSubnet(cidr: string): { baseIp: string; netmask: number; startIp: string; endIp: string } {
    const [baseIp, netmaskStr] = cidr.split('/');
    const netmask = parseInt(netmaskStr, 10);

    if (!baseIp || isNaN(netmask) || netmask < 0 || netmask > 32) {
      throw new Error(`Invalid CIDR notation: ${cidr}`);
    }

    const baseIpNum = this.ipToNumber(baseIp);
    const hostBits = 32 - netmask;
    const networkMask = (0xFFFFFFFF << hostBits) >>> 0;
    const networkAddress = (baseIpNum & networkMask) >>> 0;

    // Start from .1 (skip network address)
    const startIp = this.numberToIp(networkAddress + 1);
    
    // End at broadcast address - 1 (skip broadcast)
    const broadcastAddress = (networkAddress | (~networkMask >>> 0)) >>> 0;
    const endIp = this.numberToIp(broadcastAddress - 1);

    return { baseIp, netmask, startIp, endIp };
  }

  private ipToNumber(ip: string): number {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  private numberToIp(num: number): string {
    return [
      (num >>> 24) & 0xFF,
      (num >>> 16) & 0xFF,
      (num >>> 8) & 0xFF,
      num & 0xFF,
    ].join('.');
  }
}
