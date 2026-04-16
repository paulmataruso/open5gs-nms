import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';

export interface ActiveUE {
  ip: string;
  imsi: string;
}

export class ActiveSessionsUseCase {
  constructor(
    private hostExecutor: IHostExecutor,
    private configRepo: IConfigRepository,
    private subscriberRepo: ISubscriberRepository
  ) {}

  /**
   * Detect UE subnet ranges from SMF and UPF session pool configuration
   * Returns array of subnet strings (e.g., ["10.45.0.0/16"])
   */
  async getUESubnets(): Promise<string[]> {
    const subnets: string[] = [];
    
    try {
      // Read SMF config for session pools
      const smfConfig = await this.configRepo.loadSmf();
      const smfRaw = smfConfig as any;
      
      // Session can be at top level OR nested under smfRaw.rawYaml.smf.session
      const sessionPools = smfRaw?.session || smfRaw?.rawYaml?.smf?.session;
      
      if (sessionPools && Array.isArray(sessionPools)) {
        console.log(`SMF: Found ${sessionPools.length} session pool(s)`);
        for (const pool of sessionPools) {
          if (pool.subnet) {
            console.log(`  ├─ Subnet: ${pool.subnet}, Gateway: ${pool.gateway || 'N/A'}`);
            subnets.push(pool.subnet);
          }
        }
      } else {
        console.log('SMF: No session pools found');
      }
    } catch (err) {
      console.error('Failed to read SMF config for UE subnets:', err);
    }
    
    try {
      // Read UPF config for session pools (as backup/verification)
      const upfConfig = await this.configRepo.loadUpf();
      const upfRaw = upfConfig as any;
      
      // Session can be at top level OR nested under upfRaw.rawYaml.upf.session
      const sessionPools = upfRaw?.session || upfRaw?.rawYaml?.upf?.session;
      
      if (sessionPools && Array.isArray(sessionPools)) {
        console.log(`UPF: Found ${sessionPools.length} session pool(s)`);
        for (const pool of sessionPools) {
          if (pool.subnet) {
            console.log(`  ├─ Subnet: ${pool.subnet}, Gateway: ${pool.gateway || 'N/A'}`);
            subnets.push(pool.subnet);
          }
        }
      } else {
        console.log('UPF: No session pools found');
      }
    } catch (err) {
      console.error('Failed to read UPF config for UE subnets:', err);
    }
    
    if (subnets.length > 0) {
      console.log(`[Active Sessions] Detected ${subnets.length} UE subnet(s): ${subnets.join(', ')}`);
    } else {
      console.log('[Active Sessions] No UE subnets found in configuration');
    }
    // Return unique subnets
    return [...new Set(subnets)];
  }

  /**
   * Query conntrack for active UE IPs in the detected subnets
   * Only returns IPs with ESTABLISHED connections
   */
  async getActiveIPsFromConntrack(subnets: string[]): Promise<string[]> {
    const allIPs: Set<string> = new Set();
    
    for (const subnet of subnets) {
      try {
        // Extract network prefix for grep pattern
        // e.g., "10.45.0.0/16" → "10.45"
        const parts = subnet.split('/')[0].split('.');
        const prefix = parts.slice(0, 2).join('\\.');
        
        // Query conntrack for ESTABLISHED connections from this subnet
        const cmd = `conntrack -L -s ${subnet} 2>/dev/null | grep ESTABLISHED | awk '{print $5}' | cut -d= -f2 | grep "^${prefix}\\." | sort -u`;
        
        const result = await this.hostExecutor.executeCommand('bash', ['-c', cmd]);
        const ips = result.stdout.trim().split('\n').filter((ip: string) => ip.length > 0);
        ips.forEach((ip: string) => allIPs.add(ip));
      } catch (err) {
        console.error(`Failed to query conntrack for subnet ${subnet}:`, err);
      }
    }
    
    return Array.from(allIPs);
  }

  /**
   * Find IMSI for a given UE IP address by checking all subscribers
   * UE IPs are stored in slice[].session[].ue.ipv4 or ue.ipv6
   */
  private async findImsiByIP(targetIP: string): Promise<string | null> {
    try {
      // Get list of all subscriber IMSIs
      const subscriberList = await this.subscriberRepo.findAll(0, 10000); // Get a large batch
      
      // For each subscriber, fetch full details and check if IP matches
      for (const item of subscriberList) {
        const subscriber = await this.subscriberRepo.findByImsi(item.imsi);
        if (!subscriber || !subscriber.slice) continue;
        
        // Check all slices and sessions for matching IP
        for (const slice of subscriber.slice) {
          if (!slice.session) continue;
          
          for (const session of slice.session) {
            if (session.ue?.ipv4 === targetIP || session.ue?.ipv6 === targetIP) {
              return subscriber.imsi;
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error searching for IP ${targetIP}:`, err);
    }
    
    return null;
  }

  /**
   * Determine if a UE IP is connected via 5G based on actual interface usage
   * Checks if the IP appears in N3 conntrack (5G) vs S1-U conntrack (4G)
   */
  private async is5GConnection(ueIP: string): Promise<boolean> {
    try {
      // Check if IP appears in N3 conntrack (GTP-U port 2152 from gNodeB)
      const n3Check = await this.hostExecutor.executeCommand('bash', [
        '-c',
        `conntrack -L -p udp --dport 2152 -s ${ueIP} 2>/dev/null | grep -q ${ueIP} && echo "found" || echo "not_found"`
      ]);
      
      const isOnN3 = n3Check.stdout.trim() === 'found';
      
      console.log(`[Connection Check] UE ${ueIP}: N3=${isOnN3 ? 'YES' : 'NO'}`);
      
      return isOnN3;
    } catch (error) {
      console.error(`[Connection Check] Error checking UE ${ueIP}:`, error);
      return false;
    }
  }

  /**
   * Get active UEs with positive correlation:
   * - IP must exist in conntrack (active traffic)
   * - IP must exist in MongoDB subscriber database (valid subscriber)
   * Only returns UEs that meet BOTH criteria
   */
  async getActiveUEs(): Promise<ActiveUE[]> {
    // Step 1: Detect subnets from SMF/UPF configuration
    const subnets = await this.getUESubnets();
    if (subnets.length === 0) {
      console.warn('No UE subnets found in SMF/UPF configuration');
      return [];
    }
    

    
    // Step 2: Get active IPs from conntrack
    const conntrackIPs = await this.getActiveIPsFromConntrack(subnets);
    
    if (conntrackIPs.length === 0) {
      console.log('No active UE IPs found in conntrack');
      return [];
    }
    
    if (conntrackIPs.length > 0) {
      console.log(`[Active Sessions] Found ${conntrackIPs.length} active IP(s) in conntrack: ${conntrackIPs.join(', ')}`);
    }
    
    // Step 3: Positive correlation - find IMSI for each active IP
    const activeUEs: ActiveUE[] = [];
    
    for (const ip of conntrackIPs) {
      const imsi = await this.findImsiByIP(ip);
      
      // ONLY add if positive correlation exists (IMSI found for IP)
      if (imsi) {
        activeUEs.push({ ip, imsi });
      }
    }
    
    if (activeUEs.length > 0) {
      console.log(`[Active Sessions] ✓ ${activeUEs.length} active UE(s) with positive correlation:`);
      activeUEs.forEach(ue => console.log(`  ├─ ${ue.ip} → IMSI: ${ue.imsi}`));
    } else {
      console.log('[Active Sessions] No active UEs with positive correlation (IP in conntrack + subscriber in DB)');
    }
    
    return activeUEs;
  }

  /**
   * PLACEHOLDER: Currently returns all active UEs
   * TODO: Implement proper 5G detection once we determine the correct method
   */
  async getActive5GUEs(): Promise<ActiveUE[]> {
    const allActiveUEs = await this.getActiveUEs();
    
    if (allActiveUEs.length > 0) {
      console.log(`[Active Sessions] ✓ ${allActiveUEs.length} active UE(s) shown in 5G box (PLACEHOLDER - showing all UEs)`);
    }
    
    return allActiveUEs;
  }

  /**
   * PLACEHOLDER: Currently returns all active UEs
   * TODO: Implement proper 4G detection once we determine the correct method
   */
  async getActive4GUEs(): Promise<ActiveUE[]> {
    const allActiveUEs = await this.getActiveUEs();
    
    if (allActiveUEs.length > 0) {
      console.log(`[Active Sessions] ✓ ${allActiveUEs.length} active UE(s) shown in 4G box (PLACEHOLDER - showing all UEs)`);
    }
    
    return allActiveUEs;
  }
}
