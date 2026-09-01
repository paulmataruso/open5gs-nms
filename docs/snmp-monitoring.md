# SNMP monitoring

Open5GS NMS can install and manage a read-only Net-SNMP agent for PRTG and other SNMP managers. The **SNMP Monitoring** page shows a live preview before the agent is installed and provides the generated MIB as a download.

## Exported data

- CPU and memory utilization
- Active 4G and 5G UEs
- Connected eNodeBs and gNodeBs
- `ogstun` state and byte counters
- Active Open5GS service count
- Standard Linux interface data through `IF-MIB`

Open5GS-specific scalars live below the Net-SNMP experimental subtree `1.3.6.1.4.1.8072.9999.55555`. This avoids claiming an unassigned private enterprise number. A future assigned PEN can replace this subtree without changing the page or collector design.

## Installation

1. Open **SNMP Monitoring** as an NMS administrator.
2. Enter a strong read-only SNMPv2c community of at least eight characters.
3. Enter the narrowest CIDR containing the monitoring server. The safe initial value only permits localhost.
4. Select **Install and start SNMP**.
5. Download `OPEN5GS-NMS-MIB.txt` and import it into the monitoring platform.

The installer backs up an existing `/etc/snmp/snmpd.conf`, installs `snmpd`, writes a restricted read-only view, and enables `snmpd.service`. The community is never returned by the API or shown again after installation.

## Security

SNMPv2c does not encrypt its community or payload. Keep UDP/161 on a trusted management network, restrict the allowed CIDR, and enforce the same restriction in the host firewall. Do not expose UDP/161 to the public internet.

## PRTG

Use standard SNMP Traffic sensors for interfaces such as `ogstun`. Import the downloadable MIB or query the custom scalar OIDs for Open5GS-specific counters. The default SNMP port is UDP/161.
