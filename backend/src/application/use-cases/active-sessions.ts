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
   * Find the network interface that owns a given IP address.
   * e.g. "10.0.1.155" → "ens34"
   */
  private async getInterfaceForIP(ip: string): Promise<string | null> {
    try {
      const result = await this.hostExecutor.executeCommand('bash', [
        '-c',
        `ip -4 addr show | grep -B2 "inet ${ip}/" | grep -oP '(?<=\\d: )\\w+'  | head -1`,
      ]);
      const iface = result.stdout.trim();
      return iface.length > 0 ? iface : null;
    } catch {
      return null;
    }
  }

  /**
   * Get the verified UPF GTP-U IP — must be in upf.yaml AND assigned to a
   * host interface (same logic as get-interface-status.ts).
   */
  private async getVerifiedUpfGtpuIP(): Promise<string | null> {
    try {
      const upfConfig = await this.configRepo.loadUpf();
      const upfRaw = upfConfig as any;
      const gtpuAddr =
        upfRaw?.gtpu?.server?.[0]?.address ||
        upfRaw?.gtpu?.addr ||
        upfRaw?.rawYaml?.upf?.gtpu?.server?.[0]?.address ||
        upfRaw?.rawYaml?.upf?.gtpu?.addr;

      if (!gtpuAddr) return null;

      // Confirm the IP is actually assigned to this host
      const ipResult = await this.hostExecutor.executeCommand('bash', [
        '-c',
        `ip -4 addr show | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | grep -v '^127\\.' | sort -u`,
      ]);
      const hostIPs = ipResult.stdout.split('\n').map(l => l.trim()).filter(Boolean);
      return hostIPs.includes(gtpuAddr) ? gtpuAddr : null;
    } catch {
      return null;
    }
  }

  /**
   * Run tshark for a bounded window (3 s / 100 pkts) on the interface that
   * owns the UPF GTP-U IP, capturing GTP-U traffic to/from that IP.
   *
   * Each output line looks like:
   *   "172.16.1.67,10.45.0.102  10.0.1.155,10.45.0.1  0x0000f5f2"
   *   ip.src (outer,inner)     ip.dst (outer,inner)   teid
   *
   * The UE IP is the SECOND element of ip.src (the GTP inner source).
   * Returns the set of unique UE IPs seen.
   */
  async getActive5GUEIPsViaTshark(): Promise<string[]> {
    const upfIP = await this.getVerifiedUpfGtpuIP();
    if (!upfIP) {
      console.warn('[5G Sessions] No verified UPF GTP-U IP found — skipping tshark');
      return [];
    }

    const iface = await this.getInterfaceForIP(upfIP);
    if (!iface) {
      console.warn(`[5G Sessions] Could not find interface for UPF IP ${upfIP}`);
      return [];
    }

    console.log(`[5G Sessions] Running tshark on ${iface} for UPF ${upfIP}`);

    try {
      const result = await this.hostExecutor.executeCommand(
        'tshark',
        [
          '-i', iface,
          '-f', `udp port 2152 and (host ${upfIP})`,
          '-T', 'fields',
          '-e', 'ip.src',
          '-e', 'ip.dst',
          '-e', 'gtp.teid',
          '-c', '100',          // max 100 packets
          '-a', 'duration:3',   // stop after 3 seconds
        ],
        8000,  // 8 s timeout — gives tshark time to run its 3 s window
      );

      const ueIPs = new Set<string>();
      const lines = result.stdout.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        // ip.src field may be comma-separated when GTP inner header is decoded:
        //   "172.16.1.67,10.45.0.102"
        // The UE IP is the SECOND value (inner GTP source)
        const cols = line.split('\t');
        if (cols.length < 2) continue;
        const srcField = cols[0].trim();
        const srcParts = srcField.split(',');
        if (srcParts.length < 2) continue;
        const ueIP = srcParts[1].trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ueIP)) {
          ueIPs.add(ueIP);
        }
      }

      const result2 = Array.from(ueIPs);
      console.log(`[5G Sessions] tshark found ${result2.length} unique UE IP(s): ${result2.join(', ')}`);
      return result2;
    } catch (err) {
      console.error('[5G Sessions] tshark error:', err);
      return [];
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
   * Active 5G UEs — tshark-based, positive correlation required.
   * 1. Run tshark on the UPF GTP-U interface to extract inner UE IPs
   * 2. For each IP, look up IMSI in MongoDB
   * 3. Only return UEs where both IP and IMSI are confirmed
   */
  async getActive5GUEs(): Promise<ActiveUE[]> {
    const ueIPs = await this.getActive5GUEIPsViaTshark();
    if (ueIPs.length === 0) return [];

    const activeUEs: ActiveUE[] = [];
    for (const ip of ueIPs) {
      const imsi = await this.findImsiByIP(ip);
      if (imsi) {
        activeUEs.push({ ip, imsi });
        console.log(`[5G Sessions] ✓ ${ip} → IMSI: ${imsi}`);
      } else {
        console.log(`[5G Sessions] ✗ ${ip} — no matching subscriber (skipped)`);
      }
    }

    console.log(`[5G Sessions] ${activeUEs.length} active 5G UE(s) with positive correlation`);
    return activeUEs;
  }

  /**
   * Active 4G UEs — conntrack-based.
   * Any IMSI already detected via tshark (5G) is excluded to prevent
   * the same subscriber appearing in both the 4G and 5G session boxes.
   */
  async getActive4GUEs(): Promise<ActiveUE[]> {
    // Run both in parallel — 5G list is needed to deduplicate
    const [allConntrack, active5G] = await Promise.all([
      this.getActiveUEs(),
      this.getActive5GUEs(),
    ]);

    const imsi5GSet = new Set(active5G.map(ue => ue.imsi));
    const deduplicated = allConntrack.filter(ue => !imsi5GSet.has(ue.imsi));

    if (allConntrack.length !== deduplicated.length) {
      console.log(
        `[4G Sessions] Removed ${allConntrack.length - deduplicated.length} duplicate IMSI(s) ` +
        `already present in 5G sessions`,
      );
    }

    return deduplicated;
  }
}
