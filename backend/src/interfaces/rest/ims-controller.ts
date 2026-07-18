import { Router, Request, Response } from 'express';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { readListenOn, writeListenOn } from './bind-controller';

const execFileAsync = promisify(execFile);

const nsenter = async (cmd: string, args: string[] = [], timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout: timeoutMs,
    encoding: 'utf-8',
    env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });

// ── Constants ─────────────────────────────────────────────────────────────────
const HOST_KAMAILIO_ICSCF_DIR  = '/proc/1/root/etc/kamailio_icscf';
const HOST_KAMAILIO_SCSCF_DIR  = '/proc/1/root/etc/kamailio_scscf';
const HOST_BIND_DIR            = '/proc/1/root/etc/bind';
const HOST_BIND_ZONES_DIR      = '/proc/1/root/etc/bind/zones';
const HOST_RTPENGINE_CONF      = '/proc/1/root/etc/rtpengine/rtpengine.conf';
const HOST_SYSTEMD_DIR         = '/proc/1/root/etc/systemd/system';
const HOST_SMF_YAML            = '/proc/1/root/etc/open5gs/smf.yaml';
const HOST_MME_YAML            = '/proc/1/root/etc/open5gs/mme.yaml';
const HOST_PCRF_FD_CONF        = '/proc/1/root/etc/freeDiameter/pcrf.conf';
const HOST_UPF_YAML            = '/proc/1/root/etc/open5gs/upf.yaml';
const HOST_IMS_STATE           = '/proc/1/root/etc/open5gs/.ims-config.json';
const HOST_IMS_SMF_BAK         = '/proc/1/root/etc/open5gs/.ims-smf.bak';
const HOST_IMS_UPF_BAK         = '/proc/1/root/etc/open5gs/.ims-upf.bak';
const HOST_KAMAILIO_PCSCF_DIR  = '/proc/1/root/etc/kamailio_pcscf';
const HOST_KAMAILIO_SMSC_DIR   = '/proc/1/root/etc/kamailio_smsc';
const HOST_HSS_YAML            = '/proc/1/root/etc/open5gs/hss.yaml';
// Bundled Kamailio "main" routing-script templates (P/I/S-CSCF) — see the
// "── Systemd unit templates ──" section below for why these exist as files
// rather than generated strings: they're large (1000+ line) proven-working
// Kamailio IMS routing scripts, not host-specific data, so they ship as static
// assets (same pattern as src/config/defaults) rather than being reconstructed
// in TypeScript. The only per-host data inside them is rtpengine's own bind
// address, marked with the __RTPENGINE_IP__ placeholder token.
const IMS_TEMPLATES_DIR        = path.join(__dirname, '../../config/ims-templates');

function deployImsTemplate(templateRelPath: string, destPath: string, substitutions: Record<string, string> = {}): void {
  let content = fs.readFileSync(path.join(IMS_TEMPLATES_DIR, templateRelPath), 'utf-8');
  for (const [token, value] of Object.entries(substitutions)) {
    content = content.split(`__${token}__`).join(value);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, 'utf-8');
}

export interface ImsConfigureInput {
  pcscfIp: string;
  pcscfPort: number;
  icscfIp: string;
  icscfPort: number;
  scscfIp: string;
  scscfPort: number;
  rtpEngineIp: string;
  rtpPortMin: number;
  rtpPortMax: number;
  dnsIp: string;
  mcc?: string;
  mnc?: string;
  additionalPlmns?: { mcc: string; mnc: string }[];
}

// ── Domain helpers ────────────────────────────────────────────────────────────

function deriveImsDomain(mcc: string, mnc: string): string {
  return `ims.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

function deriveEpcDomain(mcc: string, mnc: string): string {
  return `epc.mnc${mnc.padStart(3, '0')}.mcc${mcc}.3gppnetwork.org`;
}

function readPcrfFreeDiameterInfo(): { fqdn: string; port: number } {
  try {
    const raw = fs.readFileSync('/proc/1/root/etc/freeDiameter/pcrf.conf', 'utf-8');
    const identityMatch = raw.match(/^\s*Identity\s*=\s*"([^"]+)"\s*;/m);
    const portMatch     = raw.match(/^\s*Port\s*=\s*(\d+)\s*;/m);
    return {
      fqdn: identityMatch?.[1] ?? 'pcrf.localdomain',
      port: portMatch ? parseInt(portMatch[1]) : 3868,
    };
  } catch {
    return { fqdn: 'pcrf.localdomain', port: 3868 };
  }
}

function readMccMnc(): { mcc: string; mnc: string } {
  let mcc = '001'; let mnc = '01';
  try {
    const mmeRaw = fs.readFileSync(HOST_MME_YAML, 'utf-8');
    const mccM = mmeRaw.match(/mcc:\s*['"]?(\d+)['"]?/);
    const mncM = mmeRaw.match(/mnc:\s*['"]?(\d+)['"]?/);
    if (mccM) mcc = mccM[1];
    if (mncM) mnc = mncM[1];
  } catch { /* use defaults */ }
  return { mcc, mnc };
}

// ── Kamailio include-file templates (written by Configure) ───────────────────

function pcscfIncludeCfg(p: { pcscfIp: string; pcscfPort: number; imsDomain: string; epcDomain: string; additionalDomains?: string[] }): string {
  const extraAliases = (p.additionalDomains ?? []).map(d => `alias=pcscf.${d}`).join('\n');
  return `# Open5GS NMS — P-CSCF include (generated by Configure)
listen=udp:${p.pcscfIp}:${p.pcscfPort}
listen=tcp:${p.pcscfIp}:${p.pcscfPort}

#!define IPSEC_LISTEN_ADDR "${p.pcscfIp}"
#!define IPSEC_CLIENT_PORT 5100
#!define IPSEC_SERVER_PORT 6100
#!define IPSEC_MAX_CONN 10
#!define IPSEC_DELETE_UNUSED_TUNNELS 1
#!define IPSEC_FORWARD_FLAGS 897
#!define RX_IMS_REG_DIALOG_DIRECTION 3
#!define RX_AF_SIGNALING_IP "${p.pcscfIp}"
#!substdef "/N5_BIND_IP/${p.pcscfIp}/g"
#!substdef "/N5_BIND_PORT/7777/g"
#!substdef "/SCP_BIND_IP/127.0.0.200/g"
#!substdef "/SCP_BIND_PORT/7777/g"

alias=pcscf.${p.imsDomain}
${extraAliases}
#!define MY_WS_PORT 80
#!define MY_WSS_PORT 443
#!define PCSCF_URL "sip:pcscf.${p.imsDomain}:${p.pcscfPort}"
#!define TCP_PROCESSES 8
#!substdef "/UE_REGISTRATION_EXPIRES/7200/g"
#!substdef "/CONTACT_DELETE_DELAY/120/g"
#!subst "/NETWORKNAME/${p.imsDomain}/g"
#!subst "/HOSTNAME/pcscf.${p.imsDomain}/g"
#!subst "/PCRF_REALM/${p.epcDomain}/g"
#!define DB_URL "mysql://pcscf:heslo@127.0.0.1/pcscf"
#!define SQLOPS_DBURL "pcscf=>mysql://pcscf:heslo@127.0.0.1/pcscf"
##!define WITH_RX
##!define WITH_N5
#!define WITH_NAT
#!define FORCE_RTPRELAY
#!define WITH_TCP
#!define WITH_IPSEC
#!define WITH_IMS_HDR_CACHE
#!define WITH_PING_UDP
#!define WITH_PING_TCP
`;
}

function icscfIncludeCfg(p: { icscfIp: string; icscfPort: number; imsDomain: string; additionalDomains?: string[] }): string {
  const extraAliases = (p.additionalDomains ?? []).map(d => `alias=${d}`).join('\n');
  return `# Open5GS NMS — I-CSCF include (generated by Configure)
listen=udp:${p.icscfIp}:${p.icscfPort}
listen=tcp:${p.icscfIp}:${p.icscfPort}

alias=${p.imsDomain}
${extraAliases}
#!define NETWORKNAME "${p.imsDomain}"
#!define HOSTNAME "icscf.${p.imsDomain}"
#!subst "/NETWORKNAME/${p.imsDomain}/"
#!substdef "/UE_REGISTRATION_EXPIRES/7200/g"
#!define DB_URL "mysql://icscf:heslo@127.0.0.1/icscf"
#!define WITH_TCP
`;
}

// P-CSCF's kamailio_pcscf.cfg dispatcher module routes to this list — currently
// just I-CSCF (the only "gateway" P-CSCF dispatches to in this deployment).
// Parameterized on icscfIp/icscfPort rather than a static template so it stays
// correct if I-CSCF's bind address is ever changed via Configure.
function pcscfDispatcherList(icscfIp: string, icscfPort: number): string {
  return `1 sip:${icscfIp}:${icscfPort}\n`;
}

function scscfIncludeCfg(p: { scscfIp: string; scscfPort: number; imsDomain: string; additionalDomains?: string[] }): string {
  const extraAliases = (p.additionalDomains ?? []).map(d => `alias=scscf.${d}`).join('\n');
  return `# Open5GS NMS — S-CSCF include (generated by Configure)
listen=udp:${p.scscfIp}:${p.scscfPort}
listen=tcp:${p.scscfIp}:${p.scscfPort}

#!define NETWORKNAME "${p.imsDomain}"
#!define NETWORKNAME_ESC "${p.imsDomain}"
#!define HOSTNAME "scscf.${p.imsDomain}"
#!define HOSTNAME_ESC "scscf\\.${p.imsDomain}"
#!define URI "sip:scscf.${p.imsDomain}:${p.scscfPort}"
#!subst "/NETWORKNAME/${p.imsDomain}/"
alias=scscf.${p.imsDomain}
${extraAliases}
#!define ENUM_SUFFIX "e164.arpa."
#!define DB_URL "mysql://scscf:heslo@127.0.0.1/scscf"
#!define REG_AUTH_DEFAULT_ALG "HSS-Selected"
#!define TCP_PROCESSES 3
#!substdef "/UE_REGISTRATION_EXPIRES/7200/g"
#!define WITH_TCP
#!define WITH_AUTH
`;
}

// ── Diameter XML templates ────────────────────────────────────────────────────

function pcscfDiameterXml(p: { pcscfIp: string; imsDomain: string; pcrfFqdn: string; pcrfPort: number }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DiameterPeer SYSTEM "DiameterPeer.dtd">
<DiameterPeer
    FQDN="pcscf.${p.imsDomain}"
    Realm="${p.imsDomain}"
    Vendor_Id="10415"
    Product_Name="Kamailio P-CSCF"
    AcceptUnknownPeers="1"
    DropUnknownOnDisconnect="1"
    DefaultAuthSessionTimeout="3600"
    MaxAuthSessionTimeout="3600"
    Tc="30"
    Workers="4"
    QueueLength="32">
  <Acceptor port="3871" bind="${p.pcscfIp}"/>
  <Auth id="16777236" vendor="10415"/>
  <Auth id="16777236" vendor="0"/>
  <SupportedVendor vendor="10415"/>
  <Peer FQDN="${p.pcrfFqdn}" port="${p.pcrfPort}"/>
  <DefaultRoute FQDN="${p.pcrfFqdn}" metric="10"/>
</DiameterPeer>
`;
}

function icscfDiameterXml(p: { icscfIp: string; imsDomain: string }): string {
  // cdp configparser only matches <Peer> — <ConnectPeer> is silently ignored.
  // <DefaultRoute> is NOT optional decoration — <Peer> alone only drives CER/CEA
  // connectivity; cdp's outbound message routing table (used by every
  // AAASendMessage(), including the UAR this module sends for every REGISTER) is
  // built exclusively from <DefaultRoute> elements (confirmed against cdp's own
  // configparser.c: DefaultRoute is the only element that populates x->r_table).
  // Without it the peer connection comes up (CER/CEA succeeds, TCP shows
  // ESTABLISHED) but every actual request fails with cdp's "Empty routing table"
  // — confirmed live, 2026-07-17, as "480 Temporarily Unavailable - Diameter Cx
  // interface failed" on every REGISTER.
  return `<?xml version="1.0" encoding="UTF-8"?>
<DiameterPeer
    FQDN="icscf.${p.imsDomain}"
    Realm="${p.imsDomain}"
    Vendor_Id="10415"
    Product_Name="Kamailio I-CSCF"
    AcceptUnknownPeers="0"
    DropUnknownOnDisconnect="1"
    Tc="30"
    Workers="1"
    QueueLength="32">
  <Acceptor port="3869" bind="${p.icscfIp}"/>
  <Auth id="16777216" vendor="10415"/>
  <Auth id="16777216" vendor="4491"/>
  <Auth id="16777216" vendor="13019"/>
  <Auth id="16777216" vendor="0"/>
  <SupportedVendor vendor="10415"/>
  <SupportedVendor vendor="4491"/>
  <SupportedVendor vendor="13019"/>
  <Peer FQDN="hss.${p.imsDomain}" port="3868"/>
  <DefaultRoute FQDN="hss.${p.imsDomain}" metric="10"/>
</DiameterPeer>
`;
}

function scscfDiameterXml(p: { scscfIp: string; imsDomain: string }): string {
  // See icscfDiameterXml()'s comment — same DefaultRoute requirement applies here
  // for S-CSCF's Cx (MAR/SAR) messages.
  return `<?xml version="1.0" encoding="UTF-8"?>
<DiameterPeer
    FQDN="scscf.${p.imsDomain}"
    Realm="${p.imsDomain}"
    Vendor_Id="10415"
    Product_Name="Kamailio S-CSCF"
    AcceptUnknownPeers="0"
    DropUnknownOnDisconnect="1"
    Tc="30"
    Workers="1"
    QueueLength="32">
  <Acceptor port="3870" bind="${p.scscfIp}"/>
  <Auth id="16777216" vendor="10415"/>
  <Auth id="16777216" vendor="4491"/>
  <Auth id="16777216" vendor="13019"/>
  <Auth id="16777216" vendor="0"/>
  <Auth id="4" vendor="10415"/>
  <Acct id="4" vendor="10415"/>
  <SupportedVendor vendor="10415"/>
  <SupportedVendor vendor="4491"/>
  <SupportedVendor vendor="13019"/>
  <Peer FQDN="hss.${p.imsDomain}" port="3868"/>
  <DefaultRoute FQDN="hss.${p.imsDomain}" metric="10"/>
</DiameterPeer>
`;
}

// ── Systemd unit templates ────────────────────────────────────────────────────
// Dependency ordering (After=/Wants=/Requires=) confirmed against a real,
// previously-working deployment (2026-07-17) — same provenance note as the
// PyHSS units above.

function pcscfSystemdUnit(): string {
  return `[Unit]
Description=Kamailio P-CSCF SIP Server
After=network.target mariadb.service named.service rtpengine-daemon.service kamailio-icscf.service kamailio-scscf.service

[Service]
Type=simple
RuntimeDirectory=kamailio
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_pcscf/kamailio_pcscf.cfg -m 32 -M 1024 -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function icscfSystemdUnit(): string {
  return `[Unit]
Description=Kamailio I-CSCF SIP Server
After=network.target mariadb.service named.service pyhss-diameter.service
Wants=pyhss-diameter.service

[Service]
Type=simple
RuntimeDirectory=kamailio
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_icscf/kamailio_icscf.cfg -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function scscfSystemdUnit(): string {
  return `[Unit]
Description=Kamailio S-CSCF SIP Server
After=network.target mariadb.service named.service pyhss-diameter.service
Wants=pyhss-diameter.service

[Service]
Type=simple
RuntimeDirectory=kamailio
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_scscf/kamailio_scscf.cfg -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

// ── PyHSS templates ───────────────────────────────────────────────────────────

function pyhssConfigYaml(p: { imsDomain: string; mcc: string; mnc: string; scscfIp: string; scscfPort: number; hssIp: string; additionalPlmns?: { mcc: string; mnc: string }[] }): string {
  const extraScscfs = (p.additionalPlmns ?? [])
    .map(ap => `    - 'sip:scscf.${deriveImsDomain(ap.mcc, ap.mnc)}:${p.scscfPort}'`)
    .join('\n');
  return `hss:
  transport: "TCP"
  bind_ip: ["${p.hssIp}"]
  bind_port: 3868
  OriginHost: "hss.${p.imsDomain}"
  OriginRealm: "${p.imsDomain}"
  ProductName: "pyHSS"
  MCC: "${p.mcc}"
  MNC: "${p.mnc}"
  scscf_pool:
    - 'sip:scscf.${p.imsDomain}:${p.scscfPort}'
${extraScscfs}
  client_socket_timeout: 300
  diameter_request_timeout: 3
  send_dwr: False
  active_diameter_peers_timeout: 10
  lock_provisioning: False
  provisioning_key: "open5gs-nms"
  SLh_enabled: False
  CancelLocationRequest_Enabled: False
  Default_iFC: 'pyhss/default_ifc.xml'
  Default_Sh_UserData: 'pyhss/default_sh_user_data.xml'

database:
  db_type: mysql
  server: 127.0.0.1
  username: pyhss
  password: ims_db_pass
  database: ims_hss_db

# Not actually used (single-HSS deployment, no geo-redundant peer) — but required
# to exist regardless: database.py's Update_Serving_CSCF() (called on every
# successful SIP REGISTER's Server-Assignment-Request) does an unguarded
# config['geored']['sync_actions'] with no .get()/default, unlike every other
# geored reference in the codebase — a missing section here throws KeyError:
# 'geored' and silently fails every registration's SAR. Confirmed live,
# 2026-07-17.
geored:
  enabled: False
  sync_actions: []
  endpoints: []

redis:
  host: localhost
  port: 6379

logging:
  level: INFO
  logfiles:
    hss_logging_file: /var/log/pyhss_hss.log
    diameter_logging_file: /var/log/pyhss_diameter.log
    geored_logging_file: /var/log/pyhss_geored.log
    metric_logging_file: /var/log/pyhss_metrics.log
  sqlalchemy_sql_echo: False
  sqlalchemy_pool_recycle: 15
  sqlalchemy_pool_size: 30
  sqlalchemy_max_overflow: 0

api:
  page_size: 200
  enable_insecure_auc: True
`;
}

function defaultIfcXml(imsDomain: string): string {
  // Jinja2 variables must be prefixed with `iFC_vars.` — PyHSS's Answer_16777216_301
  // renders with `template.render(iFC_vars=ims_subscriber_details)`, nesting every
  // field (imsi, msisdn, scscf_realm, ...) under a single top-level `iFC_vars` dict,
  // not as bare top-level template variables. A bare `{{ imsi }}` silently renders
  // as an empty string (Jinja2's default for an undefined variable — no error), which
  // is what produced `<PrivateID>@</PrivateID>` and got the whole SAA rejected by
  // Kamailio's XML schema validator — confirmed live, 2026-07-17. There's no
  // `ims_realm` field on the ims_subscriber row either; `scscf_realm` is what's
  // actually set (to the IMS domain) at subscriber-creation time — see
  // ims-controller.ts's `/sync-subscribers` route.
  //
  // <Identity>, not <IMSAddressOfRecord> — the real 3GPP Rel7 XSD
  // (CxDataType_Rel7.xsd, tPublicIdentity) requires the child element inside
  // PublicIdentity to be named "Identity"; "IMSAddressOfRecord" doesn't exist in
  // this schema at all and gets rejected with "This element is not expected.
  // Expected is ( Identity )." — confirmed live, 2026-07-17.
  return `<?xml version="1.0" encoding="UTF-8"?>
<IMSSubscription>
  <PrivateID>{{ iFC_vars.imsi }}@{{ iFC_vars.scscf_realm }}</PrivateID>
  <ServiceProfile>
    <PublicIdentity>
      <BarringIndication>0</BarringIndication>
      <Identity>sip:{{ iFC_vars.msisdn }}@{{ iFC_vars.scscf_realm }}</Identity>
    </PublicIdentity>
    <PublicIdentity>
      <BarringIndication>0</BarringIndication>
      <Identity>tel:{{ iFC_vars.msisdn }}</Identity>
    </PublicIdentity>
    <PublicIdentity>
      <BarringIndication>0</BarringIndication>
      <Identity>sip:{{ iFC_vars.imsi }}@{{ iFC_vars.scscf_realm }}</Identity>
    </PublicIdentity>

    <!-- Route SIP MESSAGE to SMSC (SMS over IMS) -->
    <InitialFilterCriteria>
      <Priority>20</Priority>
      <TriggerPoint>
        <ConditionTypeCNF>1</ConditionTypeCNF>
        <SPT>
          <ConditionNegated>0</ConditionNegated>
          <Group>0</Group>
          <Method>MESSAGE</Method>
          <Extension></Extension>
        </SPT>
        <SPT>
          <ConditionNegated>1</ConditionNegated>
          <Group>1</Group>
          <SIPHeader>
            <Header>Server</Header>
          </SIPHeader>
        </SPT>
        <SPT>
          <ConditionNegated>0</ConditionNegated>
          <Group>2</Group>
          <SessionCase>0</SessionCase>
          <Extension></Extension>
        </SPT>
      </TriggerPoint>
      <ApplicationServer>
        <ServerName>sip:smsc.${imsDomain}:7090</ServerName>
        <DefaultHandling>0</DefaultHandling>
      </ApplicationServer>
    </InitialFilterCriteria>
  </ServiceProfile>
</IMSSubscription>
`;
}

function defaultShUserDataXml(): string {
  // Same iFC_vars.-prefix requirement as defaultIfcXml() above.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Sh-Data>
  <PublicIdentifiers>
    <IMSPublicIdentity>sip:{{ iFC_vars.imsi }}@{{ iFC_vars.scscf_realm }}</IMSPublicIdentity>
  </PublicIdentifiers>
</Sh-Data>
`;
}

// Dependency order confirmed against a real, previously-working deployment
// (2026-07-17): pyhss-hss is what actually opens the Diameter Cx acceptor and is
// what api/diameter both depend on — NOT the other way around, which is what an
// earlier version of these templates assumed (and which was never actually wired
// up / exercised, since nothing called these functions — see the module-level
// comment above IMS_TEMPLATES_DIR). ExecStart uses plain /usr/bin/python3, not a
// venv — matches how POST /install actually provisions PyHSS's deps (`pip3
// install --break-system-packages`, no `python3 -m venv` step).
function pyhssHssUnit(): string {
  return `[Unit]
Description=PyHSS Main HSS Service
After=network.target mariadb.service redis-server.service
Requires=mariadb.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/pyhss
Environment=PYTHONUNBUFFERED=1
Environment=PYHSS_CONFIG=/opt/pyhss/config.yaml
ExecStart=/usr/bin/python3 /opt/pyhss/services/hssService.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function pyhssDiameterUnit(): string {
  return `[Unit]
Description=PyHSS Diameter Service
After=pyhss-hss.service
Requires=pyhss-hss.service

[Service]
Type=simple
WorkingDirectory=/opt/pyhss
Environment=PYTHONUNBUFFERED=1
Environment=PYHSS_CONFIG=/opt/pyhss/config.yaml
ExecStart=/usr/bin/python3 /opt/pyhss/services/diameterService.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function pyhssApiUnit(): string {
  return `[Unit]
Description=PyHSS REST API Service
After=pyhss-hss.service
Requires=pyhss-hss.service

[Service]
Type=simple
WorkingDirectory=/opt/pyhss
Environment=PYTHONUNBUFFERED=1
Environment=PYHSS_CONFIG=/opt/pyhss/config.yaml
ExecStart=/usr/bin/python3 /opt/pyhss/services/apiService.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

// ── SMSC templates ────────────────────────────────────────────────────────────

function smscIncludeCfg(p: { smscIp: string; imsDomain: string }): string {
  return `listen=udp:${p.smscIp}:7090
listen=tcp:${p.smscIp}:7090

#!define DOMAIN "${p.imsDomain}"
#!subst "/DOMAIN/${p.imsDomain}/"
#!define SMSC_SERVER "smsc.${p.imsDomain}"
#!subst "/SMSC_SERVER/smsc.${p.imsDomain}/"

#!define SMS_DB_URL "sms=>mysql://smsc:heslo@127.0.0.1/smsc"
#!define DIALPLAN_PUA_DB_URL "mysql://smsc:heslo@127.0.0.1/smsc"

#!subst "/NEXMO_APIKEY/disabled/"
#!subst "/NEXMO_APISECRET/disabled/"
#!subst "/SUBSCRIBE_EXPIRE/3600/"
`;
}

function smscMainCfg(): string {
  // Verbatim from herlesupreeth/docker_open5gs smsc/kamailio_smsc.cfg (BSD 2-Clause)
  return `#!KAMAILIO

include_file "smsc.cfg"

####### Global Parameters #########
debug=2
log_stderror=no
sip_warning=no
children=4

user_agent_header="User-Agent: Kamailio SMSC"
server_header="Server: Kamailio SMSC"
log_name="smsc"
auto_aliases=no
check_via=no
dns=no
rev_dns=no
tcp_accept_no_cl=yes

#!define SMS_3GPP 1
#!define SMS_TEXT 2

alias=SMSC_SERVER

mpath="/usr/lib64/kamailio/modules_k/:/usr/lib64/kamailio/modules/:/usr/lib/kamailio/modules_k/:/usr/lib/kamailio/modules/:/usr/lib/x86_64-linux-gnu/kamailio/modules/:/usr/local/lib64/kamailio/modules"

loadmodule "tm.so"
loadmodule "tmx.so"
loadmodule "corex.so"
loadmodule "smsops.so"
loadmodule "xlog.so"
loadmodule "maxfwd.so"
loadmodule "textops.so"
loadmodule "sl.so"
loadmodule "sanity.so"
loadmodule "siputils.so"
loadmodule "pv.so"
loadmodule "uac.so"
loadmodule "http_client.so"
loadmodule "xhttp.so"
loadmodule "utils.so"
loadmodule "json.so"
loadmodule "enum.so"
loadmodule "db_mysql.so"
loadmodule "dialplan.so"
loadmodule "sqlops.so"
loadmodule "htable.so"
loadmodule "rtimer.so"
loadmodule "usrloc.so"
loadmodule "registrar.so"
loadmodule "pua.so"
loadmodule "pua_reginfo.so"

modparam("sqlops", "sqlcon", SMS_DB_URL)
modparam("dialplan", "db_url", DIALPLAN_PUA_DB_URL)
modparam("uac", "restore_mode", "none")
modparam("htable", "htable", "sms_retries=>size=8;autoexpire=SUBSCRIBE_EXPIRE")
modparam("rtimer", "timer", "name=sms;interval=30;mode=1;")
modparam("rtimer", "exec", "timer=sms;route=SMS_WORKER")
modparam("pua_reginfo", "server_address", "sip:SMSC_SERVER")
modparam("pua_reginfo", "publish_reginfo", 0)
modparam("pua", "db_url", DIALPLAN_PUA_DB_URL)

route {
  xlog("L_DBG", "$rm ($fu ($si:$sp) to $tu, $ci)\\n");
  route(REQINIT);

  if (is_method("NOTIFY")) {
    route(NOTIFY);
    send_reply("202", "Accepted");
    exit;
  }

  if (!is_method("MESSAGE")) {
    append_to_reply("Allow: MESSAGE,NOTIFY\\r\\n");
    send_reply("405", "Method not allowed");
    exit;
  }

  if ($cT == "application/vnd.3gpp.sms") {
    route(SMS_FROM_3GPP);
  } else if ($cT == "text/plain") {
    route(SMS_FROM_SIP);
  } else {
    send_reply("488", "Content-Type not supported");
    exit;
  }
}

route[REQINIT] {
  if (!mf_process_maxfwd_header("10")) {
    sl_send_reply("483","Too Many Hops");
    exit;
  }
  if(!sanity_check("1511", "7")) {
    xlog("Malformed SIP message from $si:$sp\\n");
    exit;
  }
  if (is_method("OPTIONS") && (uri==myself)) {
    options_reply();
    exit;
  }
  if (t_lookup_request()) {
    exit;
  }
}

route[SMS_FROM_3GPP] {
  send_reply("202", "Accepted");
  if (isRPDATA()) {
    $uac_req(method) = "MESSAGE";
    $uac_req(ruri) = $ai;
    $uac_req(furi) = "sip:"+SMSC_SERVER;
    $uac_req(turi) = $ai;
    $uac_req(hdrs) = "Content-Type: application/vnd.3gpp.sms\\r\\nRequest-Disposition: no-fork\\r\\nAccept-Contact: *;+g.3gpp.smsip\\r\\n";
    $uac_req(body) = $smsack;
    uac_req_send();
    $avp(from) = $(ai{uri.user});
    $avp(to) = $tpdu(destination);
    $avp(dcs) = $tpdu(coding);
    dp_translate("1", "$avp(to)/$avp(to)");
    $avp(text) = $tpdu(payload);
    route(SMS);
  }
  exit;
}

route[SMS_FROM_SIP] {
  send_reply("200", "OK");
  $avp(from) = $(ai{uri.user});
  $avp(to) = $tU;
  dp_translate("1", "$avp(to)/$avp(to)");
  $avp(text) = $rb;
  route(SMS);
  exit;
}

event_route[xhttp:request] {
  if ($(hu{url.querystring}{s.len}) > 0) {
    $avp(from) = $(hu{url.querystring}{param.value,msisdn,&});
    $avp(to)   = $(hu{url.querystring}{param.value,to,&});
    $avp(text) = $(hu{url.querystring}{param.value,text,&}{s.replace,+,%20}{s.unescape.user});
    $avp(from_outbound) = 1;
    route(SMS);
  }
  xhttp_reply("200", "OK", "text/html", "<html><body>OK</body></html>");
}

route[SMS_TO_3GPP] {
  $rpdata(all) = $null;
  $rpdata(type) = 1;
  $rpdata(reference) = $avp(id);
  $rpdata(originator) = $avp(from);
  $tpdu(type) = 4;
  $tpdu(origen) = $avp(from);
  $tpdu(payload) = $avp(text);
  $tpdu(coding) = $avp(dcs);
  $uac_req(method) = "MESSAGE";
  $uac_req(ruri) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(furi) = "sip:"+SMSC_SERVER;
  $uac_req(turi) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(hdrs) = "Content-Type: application/vnd.3gpp.sms\\r\\nRequest-Disposition: no-fork\\r\\nAccept-Contact: *;+g.3gpp.smsip\\r\\nX-MSG-ID: "+$avp(id)+"\\r\\n";
  $uac_req(body) = $smsbody;
  $uac_req(evroute)=1;
  uac_req_send();
}

route[SMS_TO_SIP] {
  $uac_req(method) = "MESSAGE";
  $uac_req(ruri) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(furi) = "sip:+"+$avp(from)+"@"+DOMAIN;
  $uac_req(turi) = "sip:"+$avp(to)+"@"+DOMAIN;
  $uac_req(hdrs) = "Content-Type: text/plain\\r\\nX-MSG-ID: "+$avp(id)+"\\r\\n";
  $uac_req(evroute)=1;
  $uac_req(body) = $avp(text);
  uac_req_send();
}

route[SMS] {
  $var(enum) = "+"+$avp(to);
  if (!enum_pv_query("$var(enum)")) {
    return 1;
  }
  if (sql_query("sms", "insert into messages (caller, callee, text, dcs, valid) values ('$(avp(from){s.escape.common})', '$(avp(to){s.escape.common})', '$(avp(text){s.escape.common})', $avp(dcs), now());"))
    return 1;
  else
    return -1;
}

route[SMS_WORKER] {
  sql_query("sms", "select id, caller, callee, text, dcs from messages;", "q");
  if ($dbr(q=>rows) > 0) {
    $var(i) = 0;
    while ($var(i) < $dbr(q=>rows)) {
      if ($sht(sms_retries=>$dbr(q=>[$var(i),0])) == $null) {
        $sht(sms_retries=>$dbr(q=>[$var(i),0])) = 0;
      } else {
        $sht(sms_retries=>$dbr(q=>[$var(i),0])) = $sht(sms_retries=>$dbr(q=>[$var(i),0])) + 1;
      }
      if ($sht(sms_retries=>$dbr(q=>[$var(i),0])) > 2) {
        xlog("Dropping SMS after 2 retries\\n");
        sql_query("sms", "delete from messages where id=$dbr(q=>[$var(i),0]);");
        $sht(sms_retries=>$dbr(q=>[$var(i),0])) = $null;
      } else {
        $avp(id)   = $dbr(q=>[$var(i),0]);
        $avp(from) = $dbr(q=>[$var(i),1]);
        $avp(to)   = $dbr(q=>[$var(i),2]);
        $avp(text) = $dbr(q=>[$var(i),3]);
        $avp(dcs)  = $dbr(q=>[$var(i),4]);
        route(SEND_SMS);
      }
      $var(i) = $var(i) + 1;
    }
  }
  sql_result_free("q");
}

route[NOTIFY] {
  if (has_body("application/reginfo+xml")) {
    reginfo_handle_notify("location");
    send_reply("202", "Accepted");
  } else {
    send_reply("503", "Invalid Content-Type");
  }
  exit;
}

route[SEND_SMS] {
  $var(uri) = "sip:"+$avp(to)+"@"+DOMAIN;
  if (reg_fetch_contacts("location", "$var(uri)", "caller")) {
    $var(j) = 0;
    $var(is3gpp) = 0;
    while($var(j) < $(ulc(caller=>count))) {
      $var(k) = 0;
      while($var(k) < $(ulc(caller=>addr)[$var(j)]{param.count})) {
        if ($(ulc(caller=>addr)[$var(j)]{param.name,$var(k)}) == "+g.3gpp.smsip")
          $var(is3gpp) = 1;
        $var(k) = $var(k) + 1;
      }
      if ($var(is3gpp) == 1)
        route(SMS_TO_3GPP);
      else
        route(SMS_TO_SIP);
      $var(j) = $var(j) + 1;
    }
  } else {
    reginfo_subscribe("$var(uri)", "SUBSCRIBE_EXPIRE");
  }
}

event_route [tm:local-request] {
  if (is_method("SUBSCRIBE")) {
    append_hf("P-Asserted-Identity: $ru\\r\\n");
  }
}

event_route[uac:reply] {
  if (($uac_req(evtype) == 1) && ($uac_req(evcode) == 200) && ($uac_req(hdrs) != $null) && ($uac_req(hdrs) != "")) {
    $var(msgid) = $(uac_req(hdrs){line.sw,X-MSG-ID:}{s.substr,10,0}{s.int});
    sql_query("sms", "delete from messages where id=$var(msgid);");
  }
}
`;
}

function smscSystemdUnit(): string {
  return `[Unit]
Description=Kamailio SMSC (SMS over IMS)
After=network.target mariadb.service kamailio-scscf.service

[Service]
Type=simple
RuntimeDirectory=kamailio_smsc
RuntimeDirectoryMode=0755
ExecStartPre=/bin/mkdir -p /run/kamailio_smsc
ExecStart=/usr/sbin/kamailio -f /etc/kamailio_smsc/kamailio_smsc.cfg -m 32 -M 1024 -DD -E -e
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

// ── BIND9 templates ───────────────────────────────────────────────────────────

function bindZoneFile(p: {
  imsDomain: string; dnsIp: string; hssIp: string;
  pcscfIp: string; icscfIp: string; scscfIp: string;
  pcscfPort: number; icscfPort: number; scscfPort: number;
}): string {
  const serial = Math.floor(Date.now() / 1000);
  return `\$TTL 300
\$ORIGIN ${p.imsDomain}.

@   IN SOA   ns1 hostmaster (${serial} 3600 1800 604800 300)
@   IN NS    ns1
ns1 IN A     ${p.dnsIp}

; Apex A record, pointed at I-CSCF (not P-CSCF). Two independent things need this:
;  1. A UE/softphone that REGISTERs against the bare home-network domain (the
;     conventional Request-URI) needs it to resolve at all, or RFC 3263 UA-side
;     resolution hard-fails even with an explicit outbound proxy configured
;     (confirmed live, 2026-07-17: linphonec's belle-sip stack refused with
;     "Unresolvable destination" on a REGISTER to the bare domain).
;  2. More importantly: P-CSCF's own route[REGISTER] (route/register.cfg) never
;     sets an explicit destination — dispatcher.list is only consulted under
;     WITH_SBC, which isn't enabled here — so its final t_relay() falls back to
;     Kamailio's own RFC 3263 resolution of the Request-URI domain to decide
;     where to relay the REGISTER next. That must land on I-CSCF (which does the
;     Cx UAR/LIR S-CSCF lookup), not loop back to P-CSCF itself — confirmed live:
;     pointing this at P-CSCF caused P-CSCF to try relaying to itself and fail
;     with "504 Server Time-Out".
@ IN A ${p.icscfIp}

; CSCF A records
pcscf IN A   ${p.pcscfIp}
icscf IN A   ${p.icscfIp}
scscf IN A   ${p.scscfIp}
smsc  IN A   ${p.pcscfIp}
hss   IN A   ${p.hssIp}

; SRV records
_sip._udp        IN SRV 0 0 ${p.icscfPort} icscf
_sip._tcp        IN SRV 0 0 ${p.icscfPort} icscf
_sip._tcp.pcscf  IN SRV 0 0 ${p.pcscfPort} pcscf
_sip._udp.pcscf  IN SRV 0 0 ${p.pcscfPort} pcscf
_sips._tcp.pcscf IN SRV 0 0 5061 pcscf
_sip._udp.icscf  IN SRV 0 0 ${p.icscfPort} icscf
_sip._tcp.icscf  IN SRV 0 0 ${p.icscfPort} icscf
_sip._udp.scscf  IN SRV 0 0 ${p.scscfPort} scscf
_sip._tcp.scscf  IN SRV 0 0 ${p.scscfPort} scscf

; NAPTR records for P-CSCF discovery (RFC 3455) — both at the apex (for UEs that
; resolve the bare home-network domain per RFC 3263) and under pcscf (existing).
@     IN NAPTR 10 0 "s" "SIP+D2T" "" _sip._tcp
@     IN NAPTR 20 0 "s" "SIP+D2U" "" _sip._udp
pcscf IN NAPTR 10 0 "s" "SIP+D2T" "" _sip._tcp.pcscf
pcscf IN NAPTR 20 0 "s" "SIP+D2U" "" _sip._udp.pcscf
`;
}

function upsertNamedZone(raw: string, zoneName: string, zoneFilePath: string): string {
  const zoneBlock = `zone "${zoneName}" {\n    type master;\n    file "${zoneFilePath}";\n};\n`;
  if (raw.includes(`zone "${zoneName}"`)) {
    const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
    return raw.replace(zoneRe, zoneBlock);
  }
  return raw.trimEnd() + '\n\n' + zoneBlock;
}

function removeNamedZone(raw: string, zoneName: string): string {
  const zoneRe = new RegExp(`zone\\s+"${zoneName.replace(/\./g, '\\.')}"\\s*\\{[^}]*\\};?\\s*`, 'g');
  return raw.replace(zoneRe, '');
}

// ── SMF YAML helpers ──────────────────────────────────────────────────────────

// Per Open5GS v2.7.7: p-cscf belongs at the smf: level alongside dns: and mtu:,
// NOT inside the session block. The ims session entry must only have subnet/gateway/dnn.
function updateSmfImsSession(raw: string, pcscfIp: string, _dnsIp?: string): string {
  let lines = raw.split('\n');

  // Step 1: Ensure a clean ims session entry (subnet + gateway + dnn only)
  const imsIdx = lines.findIndex(l => /^\s+dnn:\s*ims\s*$/.test(l));
  if (imsIdx >= 0) {
    let startIdx = imsIdx;
    while (startIdx > 0 && !/^\s*-\s*(subnet|dnn):/.test(lines[startIdx])) startIdx--;
    const blockIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
    let endIdx = imsIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= blockIndent) break;
      endIdx++;
    }
    // Keep only the list-item lines that belong to subnet/gateway/dnn
    // Re-insert dns: pointing to our BIND9 server (pcscfIp hosts it)
    const kept = lines.slice(startIdx, endIdx)
      .filter(l => l.trim() === '' || /^\s*[-\s]*(subnet|gateway|dnn):\s/.test(l));
    const dnsLine = `      dns:\n        - ${pcscfIp}`;
    kept.push(...dnsLine.split('\n'));
    lines.splice(startIdx, endIdx - startIdx, ...kept);
  } else {
    // No ims session — add a minimal one to the session list
    const sessionIdx = lines.findIndex(l => /^\s*session:\s*$/.test(l));
    if (sessionIdx >= 0) {
      const sessionIndent = (lines[sessionIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
      let insertIdx = sessionIdx + 1;
      while (insertIdx < lines.length) {
        const line = lines[insertIdx];
        if (line.trim().length > 0) {
          const lineIndent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
          if (lineIndent <= sessionIndent && !line.trimStart().startsWith('-')) break;
        }
        insertIdx++;
      }
      const indent = ' '.repeat(sessionIndent + 2);
      const imsEntry = `${indent}- subnet: 10.46.0.0/24\n${indent}  gateway: 10.46.0.1\n${indent}  dnn: ims\n${indent}  dns:\n${indent}    - ${pcscfIp}`;
      lines.splice(insertIdx, 0, ...imsEntry.split('\n'));
    }
  }

  // Step 2: Add/update p-cscf at the smf: level (2-space indent, alongside dns: and mtu:)
  const pCscfEntry = `  p-cscf:\n    - ${pcscfIp}`;
  const pCscfIdx = lines.findIndex(l => /^ {2}p-cscf:\s*$/.test(l));
  if (pCscfIdx >= 0) {
    // Update existing p-cscf block
    let endIdx = pCscfIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 2) break;
      endIdx++;
    }
    lines.splice(pCscfIdx, endIdx - pCscfIdx, ...pCscfEntry.split('\n'));
  } else {
    // Insert before mtu: or before freeDiameter: as fallback
    const mtuIdx = lines.findIndex(l => /^ {2}mtu:\s/.test(l));
    const insertAt = mtuIdx >= 0 ? mtuIdx
      : (lines.findIndex(l => /^ {2}freeDiameter:/.test(l)) || lines.length);
    lines.splice(insertAt, 0, ...pCscfEntry.split('\n'));
  }

  // Step 3: Add parameter.no_ipv4v6_local_addr_in_packet_filter at smf: level
  // Required for VoLTE UEs that self-assign IPv6 local addresses
  const paramIdx = lines.findIndex(l => /^ {2}parameter:\s*$/.test(l));
  const flagLine  = '    no_ipv4v6_local_addr_in_packet_filter: true';
  if (paramIdx >= 0) {
    // Check if flag already present in parameter block
    const flagExists = lines.slice(paramIdx + 1).some(l => /no_ipv4v6_local_addr_in_packet_filter/.test(l) && (l.match(/^(\s*)/) ?? ['', ''])[1].length > 2);
    if (!flagExists) lines.splice(paramIdx + 1, 0, flagLine);
  } else {
    // Insert parameter block before mtu: or freeDiameter:
    const mtuIdx2 = lines.findIndex(l => /^ {2}mtu:\s/.test(l));
    const fdIdx   = lines.findIndex(l => /^ {2}freeDiameter:/.test(l));
    const at2     = mtuIdx2 >= 0 ? mtuIdx2 : (fdIdx >= 0 ? fdIdx : lines.length);
    lines.splice(at2, 0, '  parameter:', flagLine);
  }

  return lines.join('\n');
}

function removeSmfImsSession(raw: string): string {
  let lines = raw.split('\n');

  // Remove the dnn: ims session entry
  const imsIdx = lines.findIndex(l => /^\s+dnn:\s*ims\s*$/.test(l));
  if (imsIdx >= 0) {
    let startIdx = imsIdx;
    while (startIdx > 0 && !/^\s*-\s*(subnet|dnn):/.test(lines[startIdx])) startIdx--;
    const blockIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
    let endIdx = imsIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= blockIndent) break;
      endIdx++;
    }
    lines.splice(startIdx, endIdx - startIdx);
  }

  // Remove p-cscf from smf level
  const pCscfIdx = lines.findIndex(l => /^ {2}p-cscf:\s*$/.test(l));
  if (pCscfIdx >= 0) {
    let endIdx = pCscfIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 2) break;
      endIdx++;
    }
    lines.splice(pCscfIdx, endIdx - pCscfIdx);
  }

  // Remove parameter block (added for IMS)
  const paramIdx = lines.findIndex(l => /^ {2}parameter:\s*$/.test(l));
  if (paramIdx >= 0) {
    let endIdx = paramIdx + 1;
    while (endIdx < lines.length) {
      const line = lines[endIdx];
      if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= 2) break;
      endIdx++;
    }
    lines.splice(paramIdx, endIdx - paramIdx);
  }

  return lines.join('\n');
}

// ── UPF yaml IMS session helper ───────────────────────────────────────────────

function updateUpfImsSession(raw: string): string {
  const lines = raw.split('\n');
  const imsIdx = lines.findIndex(l => /^\s+dnn:\s*ims\s*$/.test(l));
  if (imsIdx >= 0) return raw; // already present

  const sessionIdx = lines.findIndex(l => /^\s*session:\s*$/.test(l));
  if (sessionIdx < 0) return raw;

  // Find end of session list
  const sessionIndent = (lines[sessionIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
  let insertIdx = sessionIdx + 1;
  while (insertIdx < lines.length) {
    const line = lines[insertIdx];
    if (line.trim().length > 0) {
      const ind = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
      if (ind <= sessionIndent && !line.trimStart().startsWith('-')) break;
    }
    insertIdx++;
  }
  const indent = ' '.repeat(sessionIndent + 2);
  const entry = `${indent}- subnet: 10.46.0.0/24\n${indent}  gateway: 10.46.0.1\n${indent}  dnn: ims\n${indent}  dev: ogstun2`;
  lines.splice(insertIdx, 0, ...entry.split('\n'));
  return lines.join('\n');
}

function removeUpfImsSession(raw: string): string {
  const lines = raw.split('\n');
  const imsIdx = lines.findIndex(l => /^\s+dnn:\s*ims\s*$/.test(l));
  if (imsIdx < 0) return raw;

  let startIdx = imsIdx;
  while (startIdx > 0 && !/^\s*-\s*(subnet|dnn):/.test(lines[startIdx])) startIdx--;
  const blockIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;
  let endIdx = imsIdx + 1;
  while (endIdx < lines.length) {
    const line = lines[endIdx];
    if (line.trim().length > 0 && (line.match(/^(\s*)/) ?? ['', ''])[1].length <= blockIndent) break;
    endIdx++;
  }
  lines.splice(startIdx, endIdx - startIdx);
  return lines.join('\n');
}

// ── PCRF freeDiameter helper ──────────────────────────────────────────────────

function upsertPcrfPcscfPeer(raw: string, pcscfFqdn: string, pcscfIp: string, pcscfPort: number): string {
  const peerLine = `ConnectPeer = "${pcscfFqdn}" { ConnectTo = "${pcscfIp}"; Port = ${pcscfPort}; No_TLS; };`;
  if (raw.includes(pcscfFqdn)) {
    return raw.replace(new RegExp(`ConnectPeer\\s*=\\s*"${pcscfFqdn.replace(/\./g, '\\.')}"[^\n]*`, 'g'), peerLine);
  }
  return raw.trimEnd() + '\n' + peerLine + '\n';
}

// ── Config file manifest ──────────────────────────────────────────────────────

interface ConfigFileEntry {
  path: string;
  label: string;
  group: string;
  language: string;
  restartServices: string[];
  exists: boolean;
}

function getImsConfigManifest(): ConfigFileEntry[] {
  let imsDomain = '';
  try {
    const state = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
    imsDomain = state.imsDomain ?? '';
  } catch { /* not configured yet */ }

  const entries: Omit<ConfigFileEntry, 'exists'>[] = [
    { group: 'P-CSCF', label: 'pcscf.cfg (include)',   path: '/etc/kamailio_pcscf/pcscf.cfg',   language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'P-CSCF', label: 'pcscf.xml (Diameter)',  path: '/etc/kamailio_pcscf/pcscf.xml',   language: 'xml', restartServices: ['kamailio-pcscf'] },
    { group: 'I-CSCF', label: 'icscf.cfg (include)',   path: '/etc/kamailio_icscf/icscf.cfg',   language: 'ini', restartServices: ['kamailio-icscf'] },
    { group: 'I-CSCF', label: 'icscf.xml (Diameter)',  path: '/etc/kamailio_icscf/icscf.xml',   language: 'xml', restartServices: ['kamailio-icscf'] },
    { group: 'S-CSCF', label: 'scscf.cfg (include)',   path: '/etc/kamailio_scscf/scscf.cfg',   language: 'ini', restartServices: ['kamailio-scscf'] },
    { group: 'S-CSCF', label: 'scscf.xml (Diameter)',  path: '/etc/kamailio_scscf/scscf.xml',   language: 'xml', restartServices: ['kamailio-scscf'] },
    { group: 'PyHSS', label: 'config.yaml',              path: '/opt/pyhss/config.yaml',              language: 'yaml', restartServices: ['pyhss-api', 'pyhss-diameter', 'pyhss-hss'] },
    { group: 'PyHSS', label: 'default_ifc.xml',          path: '/opt/pyhss/default_ifc.xml',          language: 'xml',  restartServices: [] },
    { group: 'PyHSS', label: 'default_sh_user_data.xml', path: '/opt/pyhss/default_sh_user_data.xml', language: 'xml',  restartServices: [] },
    { group: 'RTPengine',   label: 'rtpengine.conf',     path: '/etc/rtpengine/rtpengine.conf',          language: 'ini',       restartServices: ['rtpengine-daemon'] },
    { group: 'DNS / BIND9', label: 'named.conf.options', path: '/etc/bind/named.conf.options',           language: 'plaintext', restartServices: ['bind9'] },
    { group: 'DNS / BIND9', label: 'named.conf.local',   path: '/etc/bind/named.conf.local',             language: 'plaintext', restartServices: ['bind9'] },
    ...(imsDomain ? [
      { group: 'DNS / BIND9', label: `${imsDomain}.zone`, path: `/etc/bind/zones/${imsDomain}.zone`, language: 'plaintext', restartServices: ['bind9'] },
    ] as Omit<ConfigFileEntry, 'exists'>[] : []),
    { group: 'Open5GS', label: 'smf.yaml',  path: '/etc/open5gs/smf.yaml',        language: 'yaml',      restartServices: ['open5gs-smfd'] },
    { group: 'Open5GS', label: 'upf.yaml',  path: '/etc/open5gs/upf.yaml',        language: 'yaml',      restartServices: ['open5gs-upfd'] },
    { group: 'Open5GS', label: 'pcrf.yaml', path: '/etc/open5gs/pcrf.yaml',       language: 'yaml',      restartServices: ['open5gs-pcrfd'] },
    { group: 'Open5GS', label: 'pcrf.conf', path: '/etc/freeDiameter/pcrf.conf',  language: 'plaintext', restartServices: ['open5gs-pcrfd'] },
    { group: 'Systemd Units', label: 'kamailio-pcscf.service', path: '/etc/systemd/system/kamailio-pcscf.service', language: 'ini', restartServices: ['kamailio-pcscf'] },
    { group: 'Systemd Units', label: 'kamailio-icscf.service', path: '/etc/systemd/system/kamailio-icscf.service', language: 'ini', restartServices: ['kamailio-icscf'] },
    { group: 'Systemd Units', label: 'kamailio-scscf.service', path: '/etc/systemd/system/kamailio-scscf.service', language: 'ini', restartServices: ['kamailio-scscf'] },
    { group: 'Systemd Units', label: 'kamailio-smsc.service',  path: '/etc/systemd/system/kamailio-smsc.service',  language: 'ini', restartServices: ['kamailio-smsc'] },
    { group: 'SMSC',          label: 'smsc.cfg (include)',     path: '/etc/kamailio_smsc/smsc.cfg',               language: 'ini', restartServices: ['kamailio-smsc'] },
    { group: 'SMSC',          label: 'kamailio_smsc.cfg',      path: '/etc/kamailio_smsc/kamailio_smsc.cfg',      language: 'ini', restartServices: ['kamailio-smsc'] },
    { group: 'Systemd Units', label: 'pyhss-diameter.service', path: '/etc/systemd/system/pyhss-diameter.service', language: 'ini', restartServices: ['pyhss-diameter'] },
    { group: 'Systemd Units', label: 'pyhss-hss.service',      path: '/etc/systemd/system/pyhss-hss.service',      language: 'ini', restartServices: ['pyhss-hss'] },
    { group: 'Systemd Units', label: 'pyhss-api.service',      path: '/etc/systemd/system/pyhss-api.service',      language: 'ini', restartServices: ['pyhss-api'] },
  ];

  return entries.map(e => ({ ...e, exists: fs.existsSync(`/proc/1/root${e.path}`) }));
}

function isAllowedConfigPath(p: string): boolean {
  return getImsConfigManifest().some(e => e.path === p);
}

// ── MariaDB helpers ───────────────────────────────────────────────────────────

async function mysqlExec(sql: string, timeoutMs = 60000): Promise<string> {
  const { stdout } = await nsenter('mysql', ['--user=root', '--protocol=socket', '-e', sql], timeoutMs);
  return stdout;
}

async function mysqlExecFile(filePath: string, database: string): Promise<void> {
  await nsenter('bash', ['-c', `mysql --user=root --protocol=socket ${database} < ${filePath}`], 120000);
}

async function pyhssApiCall(method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: object): Promise<any> {
  const args = ['-s', '-f', '-X', method, `http://127.0.0.1:8080${path}`, '-H', 'Content-Type: application/json'];
  if (body) args.push('-d', JSON.stringify(body));
  const { stdout } = await nsenter('curl', args, 15000);
  return JSON.parse(stdout);
}

async function sourceKamSql(db: string, files: string[]): Promise<void> {
  const kamSqlDir = '/usr/share/kamailio/mysql';
  for (const f of files) {
    try {
      await nsenter('bash', ['-c', `[ -f ${kamSqlDir}/${f} ] && mysql --user=root --protocol=socket ${db} < ${kamSqlDir}/${f} 2>/dev/null || true`], 60000);
    } catch { /* non-fatal */ }
  }
}

async function initializeImsDatabase(p: {
  imsDomain: string;
  scscfIp: string;
  scscfPort: number;
}): Promise<void> {
  const scscfUri = `sip:scscf.${p.imsDomain}:${p.scscfPort}`;

  // Per-component MySQL users
  await mysqlExec(`CREATE USER IF NOT EXISTS 'icscf'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'icscf'@'127.0.0.1' IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'scscf'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'scscf'@'127.0.0.1' IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pcscf'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pcscf'@'127.0.0.1' IDENTIFIED BY 'heslo';`);

  // ── icscf ────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS icscf CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON icscf.* TO 'icscf'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON icscf.* TO 'icscf'@'127.0.0.1';`);
  await mysqlExec(`FLUSH PRIVILEGES;`);

  // Try official icscf.sql from Kamailio examples, fall back to hand-crafted
  const icscfSqlPath = '/usr/share/doc/kamailio/examples/ims/icscf/icscf.sql';
  const icscfSqlAlt  = '/usr/local/src/kamailio/misc/examples/ims/icscf/icscf.sql';
  const hasOfficialIcscf = await nsenter('bash', ['-c',
    `[ -f ${icscfSqlPath} ] && echo yes || ([ -f ${icscfSqlAlt} ] && echo yes || echo no)`], 10000)
    .then(r => r.stdout.trim() === 'yes').catch(() => false);

  if (hasOfficialIcscf) {
    await nsenter('bash', ['-c',
      `[ -f ${icscfSqlPath} ] && mysql --user=root --protocol=socket icscf < ${icscfSqlPath} 2>/dev/null || mysql --user=root --protocol=socket icscf < ${icscfSqlAlt} 2>/dev/null || true`], 60000).catch(() => {});
  } else {
    await mysqlExec(`USE icscf;
CREATE TABLE IF NOT EXISTS nds_trusted_domains (
  id             INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  trusted_domain VARCHAR(83)      NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS s_cscf (
  id         INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(83)  NOT NULL DEFAULT '',
  s_cscf_uri VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS s_cscf_capabilities (
  id         INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  id_s_cscf  INT(10) UNSIGNED NOT NULL DEFAULT 0,
  capability INT(10) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;`);
  }

  // Seed icscf trusted domain + S-CSCF
  await mysqlExec(`USE icscf;
INSERT INTO nds_trusted_domains (trusted_domain)
  SELECT '${p.imsDomain}' WHERE NOT EXISTS
  (SELECT 1 FROM nds_trusted_domains WHERE trusted_domain='${p.imsDomain}');`);

  await mysqlExec(`USE icscf;
DELETE FROM s_cscf WHERE s_cscf_uri NOT LIKE '%:${p.scscfPort}';
INSERT INTO s_cscf (name, s_cscf_uri)
  SELECT 'default', '${scscfUri}' WHERE NOT EXISTS
  (SELECT 1 FROM s_cscf WHERE s_cscf_uri='${scscfUri}');`);

  await mysqlExec(`USE icscf;
INSERT IGNORE INTO s_cscf_capabilities (id_s_cscf, capability)
  SELECT id, 0 FROM s_cscf WHERE s_cscf_uri='${scscfUri}';
INSERT IGNORE INTO s_cscf_capabilities (id_s_cscf, capability)
  SELECT id, 1 FROM s_cscf WHERE s_cscf_uri='${scscfUri}';`);

  // ── scscf ─────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS scscf CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON scscf.* TO 'scscf'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON scscf.* TO 'scscf'@'127.0.0.1';`);

  // Use official Kamailio SQL files when available
  await sourceKamSql('scscf', ['standard-create.sql', 'presence-create.sql', 'ims_usrloc_scscf-create.sql', 'ims_dialog-create.sql', 'ims_charging-create.sql']);

  // Fall-back hand-crafted tables (ignored if official files already created them)
  // Drop and recreate with correct ims_usrloc_scscf schema (previous schema was wrong)
  await mysqlExec(`USE scscf;
DROP TABLE IF EXISTS version, impu_subscriber, impu_contact, impu, contact, subscriber;`);

  await mysqlExec(`USE scscf;
CREATE TABLE IF NOT EXISTS version (table_name VARCHAR(32), table_version SMALLINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (table_name)) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contact (
  id         INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  contact    CHAR(255)        NOT NULL,
  params     VARCHAR(255)     DEFAULT NULL,
  path       VARCHAR(255)     DEFAULT NULL,
  received   VARCHAR(255)     DEFAULT NULL,
  user_agent VARCHAR(255)     DEFAULT NULL,
  expires    DATETIME         DEFAULT NULL,
  callid     VARCHAR(255)     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY contact (contact)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS impu (
  id                   INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  impu                 CHAR(64)         NOT NULL,
  barring              INT(1)           DEFAULT '0',
  reg_state            INT(11)          DEFAULT '0',
  ccf1 CHAR(64) DEFAULT NULL, ccf2 CHAR(64) DEFAULT NULL,
  ecf1 CHAR(64) DEFAULT NULL, ecf2 CHAR(64) DEFAULT NULL,
  ims_subscription_data BLOB,
  PRIMARY KEY (id),
  UNIQUE KEY impu (impu)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS impu_contact (
  id         INT(11)          NOT NULL AUTO_INCREMENT,
  impu_id    INT(11)          NOT NULL,
  contact_id INT(11)          NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY impu_id (impu_id, contact_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS subscriber (
  id               INT(11)      NOT NULL AUTO_INCREMENT,
  watcher_uri      VARCHAR(100) NOT NULL,
  watcher_contact  VARCHAR(100) NOT NULL,
  presentity_uri   VARCHAR(100) NOT NULL,
  event            INT(11)      NOT NULL,
  expires          DATETIME     NOT NULL,
  version          INT(11)      NOT NULL,
  local_cseq       INT(11)      NOT NULL,
  call_id          VARCHAR(50)  NOT NULL,
  from_tag         VARCHAR(50)  NOT NULL,
  to_tag           VARCHAR(50)  NOT NULL,
  record_route     VARCHAR(50)  NOT NULL,
  sockinfo_str     VARCHAR(50)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY watcher_uri (event, watcher_contact, presentity_uri)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS impu_subscriber (
  id            INT(11) NOT NULL AUTO_INCREMENT,
  impu_id       INT(11) NOT NULL,
  subscriber_id INT(11) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY impu_id (impu_id, subscriber_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS presentity (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  domain        VARCHAR(64)  NOT NULL,
  event         VARCHAR(64)  NOT NULL,
  etag          VARCHAR(128) NOT NULL,
  expires       INT(11)      NOT NULL,
  received_time INT(11)      NOT NULL,
  body          BLOB         NOT NULL,
  sender        VARCHAR(255) NOT NULL,
  priority      INT(11)      DEFAULT 0 NOT NULL,
  ruid          VARCHAR(64),
  PRIMARY KEY (id),
  CONSTRAINT presentity_idx UNIQUE (username, domain, event, etag),
  CONSTRAINT ruid_idx UNIQUE (ruid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS active_watchers (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  presentity_uri VARCHAR(128) NOT NULL,
  watcher_username VARCHAR(64) NOT NULL,
  watcher_domain VARCHAR(64) NOT NULL,
  to_user       VARCHAR(64)  NOT NULL,
  to_domain     VARCHAR(64)  NOT NULL,
  from_user     VARCHAR(64)  NOT NULL DEFAULT '',
  from_domain   VARCHAR(64)  NOT NULL DEFAULT '',
  event         VARCHAR(64)  NOT NULL DEFAULT 'presence',
  event_id      VARCHAR(64),
  to_tag        VARCHAR(128) NOT NULL,
  from_tag      VARCHAR(128) NOT NULL,
  callid        VARCHAR(128) NOT NULL,
  local_cseq    INT(11)      NOT NULL,
  remote_cseq   INT(11)      NOT NULL,
  contact       VARCHAR(128) NOT NULL,
  record_route  TEXT,
  expires       INT(11)      NOT NULL,
  status        INT(11)      NOT NULL DEFAULT 2,
  reason        VARCHAR(64),
  version       INT(11)      NOT NULL DEFAULT 0,
  socket_info   VARCHAR(64)  NOT NULL,
  local_contact VARCHAR(128) NOT NULL,
  ruid          VARCHAR(64)  NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY active_watchers_idx (callid, to_tag, from_tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS watchers (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  presentity_uri VARCHAR(128) NOT NULL,
  watcher_username VARCHAR(64) NOT NULL,
  watcher_domain VARCHAR(64) NOT NULL,
  event         VARCHAR(64)  NOT NULL DEFAULT 'presence',
  status        INT(11)      NOT NULL,
  reason        VARCHAR(64),
  inserted_time INT(11)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY watchers_idx (presentity_uri, watcher_username, watcher_domain, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS xcap (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  domain        VARCHAR(64)  NOT NULL,
  doc           LONGBLOB     NOT NULL,
  doc_type      INT(11)      NOT NULL,
  etag          VARCHAR(64)  NOT NULL,
  source        INT(11)      NOT NULL,
  doc_uri       VARCHAR(255) NOT NULL,
  port          VARCHAR(10),
  PRIMARY KEY (id),
  UNIQUE KEY xcap_idx (username, domain, doc_type, doc_uri)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

CREATE TABLE IF NOT EXISTS pua (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  pres_uri      VARCHAR(128) NOT NULL,
  pres_id       VARCHAR(255) NOT NULL,
  event         INT(11)      NOT NULL,
  expires       INT(11)      NOT NULL,
  desired_expires INT(11)    NOT NULL,
  flag          INT(11)      NOT NULL,
  etag          VARCHAR(64),
  tuple_id      VARCHAR(64),
  watcher_uri   VARCHAR(128),
  to_uri        VARCHAR(128),
  call_id       VARCHAR(128),
  to_tag        VARCHAR(64),
  from_tag      VARCHAR(64),
  cseq          INT(11),
  record_route  VARCHAR(255),
  contact       VARCHAR(128),
  remote_contact VARCHAR(128),
  version       INT(11),
  PRIMARY KEY (id),
  UNIQUE KEY pua_idx (pres_uri, pres_id, flag, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

INSERT IGNORE INTO version (table_name, table_version) VALUES
  ('presentity',    '5'),
  ('active_watchers','12'),
  ('watchers',      '3'),
  ('xcap',          '4'),
  ('pua',           '7');`);

  // ── pcscf ─────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS pcscf CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON pcscf.* TO 'pcscf'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON pcscf.* TO 'pcscf'@'127.0.0.1';`);
  await sourceKamSql('pcscf', ['standard-create.sql', 'presence-create.sql', 'ims_usrloc_pcscf-create.sql', 'ims_dialog-create.sql']);

  // ── ims_hss_db (PyHSS) ────────────────────────────────────────────────────────
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pyhss'@'localhost'  IDENTIFIED BY 'ims_db_pass';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'pyhss'@'127.0.0.1' IDENTIFIED BY 'ims_db_pass';`);
  // Always reset password — CREATE USER IF NOT EXISTS skips the password update when the user
  // already exists (e.g. after ims_remove + ims_configure cycle), leaving a stale hash.
  await mysqlExec(`ALTER USER 'pyhss'@'localhost'  IDENTIFIED BY 'ims_db_pass';`);
  await mysqlExec(`ALTER USER 'pyhss'@'127.0.0.1' IDENTIFIED BY 'ims_db_pass';`);
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS ims_hss_db CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON ims_hss_db.* TO 'pyhss'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON ims_hss_db.* TO 'pyhss'@'127.0.0.1';`);

  // ── smsc ──────────────────────────────────────────────────────────────────────
  await mysqlExec(`CREATE USER IF NOT EXISTS 'smsc'@'localhost'  IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE USER IF NOT EXISTS 'smsc'@'127.0.0.1' IDENTIFIED BY 'heslo';`);
  await mysqlExec(`CREATE DATABASE IF NOT EXISTS smsc CHARACTER SET utf8 COLLATE utf8_general_ci;`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON smsc.* TO 'smsc'@'localhost';`);
  await mysqlExec(`GRANT ALL PRIVILEGES ON smsc.* TO 'smsc'@'127.0.0.1';`);
  await sourceKamSql('smsc', ['standard-create.sql', 'dialplan-create.sql', 'presence-create.sql']);
  await mysqlExec(`USE smsc;
CREATE TABLE IF NOT EXISTS \`messages\` (
  \`id\`     INT(10) UNSIGNED AUTO_INCREMENT PRIMARY KEY NOT NULL,
  \`caller\` VARCHAR(255) NOT NULL,
  \`callee\` VARCHAR(255) NOT NULL,
  \`text\`   VARCHAR(512),
  \`dcs\`    INT(1),
  \`valid\`  DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
INSERT IGNORE INTO version (table_name, table_version) VALUES ('messages','1');`);

  await mysqlExec(`FLUSH PRIVILEGES;`);
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createImsRouter(
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  // GET /api/ims/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const [whichRes, pcscfRes, icscfRes, scscfRes, smscRes, rtpRes, dnsRes, mariaRes,
             pyhssDiamRes, pyhssHssRes, pyhssApiRes, redisRes] =
        await Promise.allSettled([
          nsenter('which', ['kamailio']),
          nsenter('systemctl', ['is-active', 'kamailio-pcscf']),
          nsenter('systemctl', ['is-active', 'kamailio-icscf']),
          nsenter('systemctl', ['is-active', 'kamailio-scscf']),
          nsenter('systemctl', ['is-active', 'kamailio-smsc']),
          nsenter('systemctl', ['is-active', 'rtpengine-daemon']),
          nsenter('systemctl', ['is-active', 'bind9']),
          nsenter('systemctl', ['is-active', 'mariadb']),
          nsenter('systemctl', ['is-active', 'pyhss-diameter']),
          nsenter('systemctl', ['is-active', 'pyhss-hss']),
          nsenter('systemctl', ['is-active', 'pyhss-api']),
          nsenter('systemctl', ['is-active', 'redis-server']),
        ]);

      const installed = whichRes.status === 'fulfilled' && whichRes.value.stdout.trim().length > 0;
      const pyhssInstalled = fs.existsSync('/proc/1/root/opt/pyhss');
      const svcActive = (r: PromiseSettledResult<any>) =>
        r.status === 'fulfilled' && r.value.stdout.trim() === 'active';

      const hasSavedConfig = fs.existsSync(HOST_IMS_STATE);
      let currentConfig: ImsConfigureInput | undefined;
      let imsDomain: string | undefined;
      if (hasSavedConfig) {
        try {
          const saved = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
          currentConfig = saved.config;
          imsDomain = saved.imsDomain;
        } catch { /* corrupt */ }
      }

      const services = {
        pcscf:            svcActive(pcscfRes),
        icscf:            svcActive(icscfRes),
        scscf:            svcActive(scscfRes),
        smsc:             svcActive(smscRes),
        rtpengine:        svcActive(rtpRes),
        bind9:            svcActive(dnsRes),
        mariadb:          svcActive(mariaRes),
        'pyhss-diameter': svcActive(pyhssDiamRes),
        'pyhss-hss':      svcActive(pyhssHssRes),
        'pyhss-api':      svcActive(pyhssApiRes),
        redis:            svcActive(redisRes),
      };

      const smfImsConfigured = fs.existsSync(HOST_SMF_YAML) &&
        /dnn:\s*ims/.test(fs.readFileSync(HOST_SMF_YAML, 'utf-8'));

      const dnsConfigured = fs.existsSync(HOST_BIND_ZONES_DIR) &&
        fs.readdirSync(HOST_BIND_ZONES_DIR).some(f => f.includes('3gppnetwork'));

      const imsEnabled = services.pcscf && services.icscf && services.scscf &&
        services['pyhss-diameter'] && services['pyhss-hss'] && smfImsConfigured;

      let imsSubscribers = 0;
      if (services['pyhss-api']) {
        try {
          const list = await pyhssApiCall('GET', '/ims_subscriber/list');
          imsSubscribers = Array.isArray(list) ? list.length : 0;
        } catch { /* api not ready */ }
      }

      const allSubs = await subscriberRepo.findAll();
      const open5gsSubscribers = allSubs.filter(s => s.msisdn && s.msisdn.length > 0).length;

      res.json({
        success: true,
        installed,
        pyhssInstalled,
        hssBackend: 'pyhss',
        services,
        imsSubscribers,
        open5gsSubscribers,
        smfImsConfigured,
        dnsConfigured,
        imsEnabled,
        hasSavedConfig,
        imsDomain,
        currentConfig,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'ims status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/install — streaming: packages + PyHSS install
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');  // disable nginx proxy buffering
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const write = (s: string) => { res.write(s); };

    // Helper: spawn a command via nsenter and stream output line-by-line
    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--',
          'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

    // Add Kamailio's official APT repo (5.8.x branch) before installing — Ubuntu
    // 24.04's own archive only has 5.7.4, which cannot correctly resolve a
    // #!substdef used across an import_file boundary (confirmed live, 2026-07-17:
    // the bundled kamailio_pcscf.cfg/kamailio_scscf.cfg templates below fail to
    // parse under 5.7.4 with "Can't set module parameter" / "unknown command,
    // missing loadmodule?" on UE_REGISTRATION_EXPIRES et al, but parse and run
    // cleanly under 5.8.8). This repo used to only exist as a hand-added file on
    // one dev host from an earlier, undocumented troubleshooting session — never
    // captured into this install step, so every other host silently got the
    // older, incompatible 5.7.4 instead. Idempotent: safe to re-run.
    write('=== Adding Kamailio 5.8 APT repo ===\n');
    await spawnStream(
      'set -e\n' +
      'curl -fsSL http://deb.kamailio.org/kamailiodebkey.gpg | gpg --dearmor -o /usr/share/keyrings/kamailio.gpg\n' +
      'CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")\n' +
      'cat > /etc/apt/sources.list.d/kamailio.list <<EOF\n' +
      'deb [arch=amd64 signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 ${CODENAME} main\n' +
      'deb-src [arch=amd64 signed-by=/usr/share/keyrings/kamailio.gpg] http://deb.kamailio.org/kamailio58 ${CODENAME} main\n' +
      'EOF\n' +
      'apt-get update -q\n' +
      'echo "✅ Kamailio 5.8 repo added."'
    );

    write('\n=== Installing IMS packages ===\n');
    // presence/sctp/json modules are all required by the bundled main-cfg
    // templates (kamailio_pcscf.cfg loads sctp+json, kamailio_scscf.cfg loads
    // presence) — confirmed live, 2026-07-17: omitting any of these makes the
    // corresponding kamailio-*.service crash-loop on "could not find module".
    const basePkgs = 'kamailio kamailio-ims-modules kamailio-mysql-modules kamailio-tls-modules kamailio-extra-modules kamailio-utils-modules ' +
      'kamailio-presence-modules kamailio-sctp-modules kamailio-json-modules ' +
      'rtpengine mariadb-server bind9 bind9utils mariadb-client dnsutils git dpkg-dev libxml2-dev';
    const pyhssPkgs = ' redis-server python3-pip python3-venv python3-dev';
    await spawnStream(
      `DEBIAN_FRONTEND=noninteractive apt-get install -y ${basePkgs}${pyhssPkgs} 2>&1`
    );

    // Patch cdp.so: the stock Kamailio 5.x cdp_mod.c registers one fewer process slot
    // than it actually forks, causing the CDP timer to fail with "Process limit exceeded"
    // — which breaks Cx/Rx Diameter (HSS/PCRF signaling) under load.
    // Fix: bump the register_procs() count from (2+workers+2*peers) to (3+workers+2*peers).
    write('\n=== Patching cdp.so (process slot fix) ===\n');
    const cdpPatchExitCode = await spawnStream(
      'set -e\n' +
      'CDP_SO=/usr/lib/x86_64-linux-gnu/kamailio/modules/cdp.so\n' +
      'MARKER=/usr/lib/x86_64-linux-gnu/kamailio/modules/cdp.so.patched\n' +
      '[ -f "$MARKER" ] && echo "cdp.so already patched — skipping." && exit 0\n' +
      'KVER=$(dpkg -s kamailio 2>/dev/null | grep ^Version | awk \'{print $2}\')\n' +
      'echo "Kamailio version: $KVER"\n' +
      // Real incident (2026-07-17): the previous check here — `grep -qr "deb-src"
      // /etc/apt/sources.list /etc/apt/sources.list.d/` — false-positived on a comment
      // inside cloud-init's ubuntu.sources.curtin.orig backup file ("## Types: Append
      // deb-src to enable..."), which literally contains the substring "deb-src" without
      // being a real enabled source. It also only knew how to edit the legacy
      // sources.list format; Ubuntu 24.04+ defaults to the new deb822 ubuntu.sources
      // format, where sources.list is just a placeholder comment with no "deb " lines to
      // transform. Net effect: `apt-get source` failed ("You must put some deb-src URIs
      // in your sources.list"), the patch silently never applied, and this step's exit
      // code was never checked — so the wizard reported "IMS installation complete" with
      // the crash-guard patch quietly missing. Fix: always (idempotently) write our own
      // explicit deb-src file, independent of whatever format the existing sources are
      // in — works on both legacy and deb822-based installs.
      'CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")\n' +
      'cat > /etc/apt/sources.list.d/deb-src-ims.list <<EOF\n' +
      'deb-src http://archive.ubuntu.com/ubuntu/ ${CODENAME} main restricted universe multiverse\n' +
      'deb-src http://archive.ubuntu.com/ubuntu/ ${CODENAME}-updates main restricted universe multiverse\n' +
      'deb-src http://security.ubuntu.com/ubuntu/ ${CODENAME}-security main restricted universe multiverse\n' +
      'EOF\n' +
      'apt-get update -q\n' +
      'cd /tmp && apt-get source "kamailio=$KVER" -q\n' +
      'SRCDIR=$(ls -d /tmp/kamailio-*/src 2>/dev/null | head -1 | sed "s|/src$||")\n' +
      '[ -z "$SRCDIR" ] && echo "ERROR: kamailio source not found" && exit 1\n' +
      'echo "Source dir: $SRCDIR"\n' +
      'sed -i "s/register_procs(2 + config->workers/register_procs(3 + config->workers/g" "$SRCDIR/src/modules/cdp/cdp_mod.c"\n' +
      'sed -i "s/cfg_register_child(2 + config->workers/cfg_register_child(3 + config->workers/g" "$SRCDIR/src/modules/cdp/cdp_mod.c"\n' +
      'cd "$SRCDIR" && make modules modules=src/modules/cdp 2>&1\n' +
      'cp "$SRCDIR/src/modules/cdp/cdp.so" "$CDP_SO"\n' +
      'touch "$MARKER"\n' +
      'echo "✅ cdp.so patched successfully."'
    );
    if (cdpPatchExitCode !== 0) {
      write('\n⚠️ WARNING: cdp.so patch FAILED (see errors above). Kamailio\'s CDP module ' +
        'may hit "Process limit exceeded" and Cx/Rx Diameter (HSS/PCRF signaling) may be ' +
        'unstable. Fix the underlying issue and re-run Install — the patch is not marked ' +
        'complete, so it will retry automatically.\n');
    }

    write('\n=== Installing PyHSS ===\n');
    const pyhssInstalled = fs.existsSync('/proc/1/root/opt/pyhss');
    if (!pyhssInstalled) {
      write('Cloning PyHSS...\n');
      await spawnStream('git clone https://github.com/nickvsnetworking/pyhss /opt/pyhss 2>&1');
    } else {
      write('PyHSS already cloned — skipping clone.\n');
    }
    await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get install -y libmariadb-dev pkg-config 2>&1');
    await spawnStream('pip3 install --break-system-packages -r /opt/pyhss/requirements.txt 2>&1');
    await spawnStream('mkdir -p /etc/pyhss');
    write('✅ PyHSS installed.\n');

    await auditLogger.log({ action: 'ims_install', user, details: 'packages + pyhss', success: true });
    write('\n✅ IMS installation complete. Run Configure next.\n');
    res.end();
  });

  // POST /api/ims/configure
  router.post('/configure', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const {
        pcscfIp    = '10.0.1.178',
        pcscfPort  = 5060,
        icscfIp    = '127.0.1.1',
        icscfPort  = 4060,
        scscfIp    = '127.0.1.2',
        scscfPort  = 6060,
        rtpEngineIp = pcscfIp,
        rtpPortMin  = 20000,
        rtpPortMax  = 30000,
        dnsIp       = pcscfIp,
        additionalPlmns = [],
      } = req.body as Partial<ImsConfigureInput>;

      // Primary PLMN: use explicit override if provided, else read from mme.yaml
      const bodyMcc = (req.body as any).mcc as string | undefined;
      const bodyMnc = (req.body as any).mnc as string | undefined;
      const { mcc: autoMcc, mnc: autoMnc } = readMccMnc();
      const mcc = bodyMcc || autoMcc;
      const mnc = bodyMnc || autoMnc;

      const imsDomain = deriveImsDomain(mcc, mnc);
      const zoneName  = imsDomain;
      const zoneFile  = `/etc/bind/zones/${zoneName}.zone`;

      // Derive additional IMS domains from additional PLMNs
      const additionalDomains = (additionalPlmns ?? []).map((p: { mcc: string; mnc: string }) =>
        deriveImsDomain(p.mcc, p.mnc),
      );

      // Domains that were configured before this call but aren't in the new list anymore
      // (e.g. a PLMN was removed) — their zone file + named.conf.local stanza must be
      // deleted here, not just left to accumulate. This previously only ever added/updated
      // zones, never removed ones for a PLMN the user took out.
      let removedDomains: string[] = [];
      if (fs.existsSync(HOST_IMS_STATE)) {
        try {
          const prevSaved = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
          const prevAdditionalPlmns: { mcc: string; mnc: string }[] = prevSaved?.config?.additionalPlmns ?? [];
          const prevDomains = prevAdditionalPlmns.map(p => deriveImsDomain(p.mcc, p.mnc));
          removedDomains = prevDomains.filter(d => d !== imsDomain && !additionalDomains.includes(d));
        } catch { /* corrupt state — nothing to clean up */ }
      }

      // 1. P-CSCF include config + Diameter XML
      const epcDomain = deriveEpcDomain(mcc, mnc);
      const { fqdn: pcrfFqdn, port: pcrfPort } = readPcrfFreeDiameterInfo();
      fs.mkdirSync(HOST_KAMAILIO_PCSCF_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_KAMAILIO_PCSCF_DIR}/pcscf.cfg`,
        pcscfIncludeCfg({ pcscfIp, pcscfPort, imsDomain, epcDomain, additionalDomains }), 'utf-8');
      fs.writeFileSync(`${HOST_KAMAILIO_PCSCF_DIR}/pcscf.xml`,
        pcscfDiameterXml({ pcscfIp, imsDomain, pcrfFqdn, pcrfPort }), 'utf-8');

      // 2. I-CSCF include config + Diameter XML
      fs.mkdirSync(HOST_KAMAILIO_ICSCF_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_KAMAILIO_ICSCF_DIR}/icscf.cfg`,
        icscfIncludeCfg({ icscfIp, icscfPort, imsDomain, additionalDomains }), 'utf-8');
      fs.writeFileSync(`${HOST_KAMAILIO_ICSCF_DIR}/icscf.xml`,
        icscfDiameterXml({ icscfIp, imsDomain }), 'utf-8');

      // 3. S-CSCF include config + Diameter XML
      fs.mkdirSync(HOST_KAMAILIO_SCSCF_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
        scscfIncludeCfg({ scscfIp, scscfPort, imsDomain, additionalDomains }), 'utf-8');
      fs.writeFileSync(`${HOST_KAMAILIO_SCSCF_DIR}/scscf.xml`,
        scscfDiameterXml({ scscfIp, imsDomain }), 'utf-8');

      // 3b. SMSC config — Kamailio SMS center on port 7090
      const smscIp = pcscfIp; // SMSC runs on same host as P-CSCF
      fs.mkdirSync(HOST_KAMAILIO_SMSC_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_KAMAILIO_SMSC_DIR}/smsc.cfg`,
        smscIncludeCfg({ smscIp, imsDomain }), 'utf-8');
      fs.writeFileSync(`${HOST_KAMAILIO_SMSC_DIR}/kamailio_smsc.cfg`,
        smscMainCfg(), 'utf-8');
      fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-smsc.service`,
        smscSystemdUnit(), 'utf-8');

      // 4. RTPengine config — listen-ng must match kamailio_pcscf.cfg's rtpengine_sock
      fs.mkdirSync('/proc/1/root/etc/rtpengine', { recursive: true });
      fs.writeFileSync(HOST_RTPENGINE_CONF,
        `[rtpengine]\ninterface = ${rtpEngineIp}\nlisten-ng = ${rtpEngineIp}:2223\ntos = 184\nport-min = ${rtpPortMin}\nport-max = ${rtpPortMax}\nlog-level = 5\n`,
        'utf-8');

      // 4b. Main Kamailio routing-script configs (P/I/S-CSCF) + P-CSCF's route/*.cfg
      // fragments + dispatcher lists. These are the large, proven-working routing
      // scripts that pcscf.cfg/icscf.cfg/scscf.cfg (written above) get import_file'd
      // into — deployed from the bundled templates every Configure run, same as
      // everything else here, so they can't silently go missing on a fresh install
      // the way they did before this was wired up (2026-07-17 incident: these were
      // never written by either /install or /configure — only ever placed once, by
      // hand, on one dev host — so every OTHER host's P/I/S-CSCF units referenced a
      // main cfg file that never existed).
      deployImsTemplate('kamailio_pcscf/kamailio_pcscf.cfg', `${HOST_KAMAILIO_PCSCF_DIR}/kamailio_pcscf.cfg`, { RTPENGINE_IP: rtpEngineIp });
      deployImsTemplate('kamailio_pcscf/route/mo.cfg', `${HOST_KAMAILIO_PCSCF_DIR}/route/mo.cfg`);
      deployImsTemplate('kamailio_pcscf/route/mt.cfg', `${HOST_KAMAILIO_PCSCF_DIR}/route/mt.cfg`);
      deployImsTemplate('kamailio_pcscf/route/register.cfg', `${HOST_KAMAILIO_PCSCF_DIR}/route/register.cfg`);
      deployImsTemplate('kamailio_pcscf/route/rtp.cfg', `${HOST_KAMAILIO_PCSCF_DIR}/route/rtp.cfg`, { RTPENGINE_IP: rtpEngineIp });
      fs.writeFileSync(`${HOST_KAMAILIO_PCSCF_DIR}/dispatcher.list`, pcscfDispatcherList(icscfIp, icscfPort), 'utf-8');
      deployImsTemplate('kamailio_icscf/kamailio_icscf.cfg', `${HOST_KAMAILIO_ICSCF_DIR}/kamailio_icscf.cfg`);
      deployImsTemplate('kamailio_scscf/kamailio_scscf.cfg', `${HOST_KAMAILIO_SCSCF_DIR}/kamailio_scscf.cfg`);
      deployImsTemplate('kamailio_scscf/dispatcher.list', `${HOST_KAMAILIO_SCSCF_DIR}/dispatcher.list`);
      // Required by modparam("ims_registrar_scscf", "user_data_xsd", ...) — without
      // it, every SAA's iFC XML fails schema validation and the whole SIP REGISTER
      // fails with "500 Server error on UAR select next S-CSCF" once no more
      // candidate S-CSCFs are left to retry (confirmed live, 2026-07-17). Sourced
      // directly from Kamailio's own ims_registrar_scscf module source — the exact
      // schema its own C code validates against, not a hand-authored guess.
      deployImsTemplate('kamailio_scscf/CxDataType_Rel7.xsd', `${HOST_KAMAILIO_SCSCF_DIR}/CxDataType_Rel7.xsd`);

      // 4c. Systemd units for P/I/S-CSCF + all 3 PyHSS services — same gap as 4b:
      // these generator functions existed but were never actually called anywhere.
      fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-pcscf.service`, pcscfSystemdUnit(), 'utf-8');
      fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-icscf.service`, icscfSystemdUnit(), 'utf-8');
      fs.writeFileSync(`${HOST_SYSTEMD_DIR}/kamailio-scscf.service`, scscfSystemdUnit(), 'utf-8');
      fs.writeFileSync(`${HOST_SYSTEMD_DIR}/pyhss-hss.service`, pyhssHssUnit(), 'utf-8');
      fs.writeFileSync(`${HOST_SYSTEMD_DIR}/pyhss-diameter.service`, pyhssDiameterUnit(), 'utf-8');
      fs.writeFileSync(`${HOST_SYSTEMD_DIR}/pyhss-api.service`, pyhssApiUnit(), 'utf-8');

      // 5. daemon-reload — picks up every unit file written in 3b/4c above.
      await nsenter('systemctl', ['daemon-reload']);

      // 6a. PyHSS config — deployed to /opt/pyhss/config.yaml + iFC XMLs. Services
      // are (re)started later in step 16, in dependency order, after step 8 below
      // has actually created the databases they need — restarting them here would
      // just fail against a nonexistent ims_hss_db on a fresh install.
      fs.writeFileSync('/proc/1/root/opt/pyhss/config.yaml',
        pyhssConfigYaml({ imsDomain, mcc, mnc, scscfIp, scscfPort, hssIp: '127.0.1.3', additionalPlmns }), 'utf-8');
      fs.writeFileSync('/proc/1/root/opt/pyhss/default_ifc.xml', defaultIfcXml(imsDomain), 'utf-8');
      fs.writeFileSync('/proc/1/root/opt/pyhss/default_sh_user_data.xml', defaultShUserDataXml(), 'utf-8');

      // 8. Initialize MariaDB (all databases)
      await initializeImsDatabase({ imsDomain, scscfIp, scscfPort });

      // 9. /etc/hosts — FQDN entry for HSS peer (cdp uses getaddrinfo)
      const hostsPath = '/proc/1/root/etc/hosts';
      const hssFqdn   = `hss.${imsDomain}`;
      const hssIp     = '127.0.1.3';
      let hostsContent = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf-8') : '';
      const hostsHssLine = `${hssIp}  ${hssFqdn}`;
      hostsContent = hostsContent.includes(hssFqdn)
        ? hostsContent.replace(/^[^\n]*hss\.ims\.[^\n]*/m, hostsHssLine)
        : `${hostsContent.trimEnd()}\n${hostsHssLine}\n`;
      fs.writeFileSync(hostsPath, hostsContent, 'utf-8');

      // 10. BIND9 zones — primary + one zone per additional PLMN
      fs.mkdirSync(HOST_BIND_ZONES_DIR, { recursive: true });
      fs.writeFileSync(`${HOST_BIND_ZONES_DIR}/${zoneName}.zone`,
        bindZoneFile({ imsDomain, dnsIp, hssIp, pcscfIp, icscfIp, scscfIp, pcscfPort, icscfPort, scscfPort }), 'utf-8');

      // listen-on itself is owned by the BIND page now (see bind-controller.ts) — it
      // manages install/forwarders/listen-on for every module sharing this one BIND9
      // instance, so nothing here overwrites the whole options{} block anymore. We still
      // need our own dnsIp actually listened on, so merge it in via the same safe upsert
      // the BIND page's own UI uses, rather than replacing whatever's already configured.
      writeListenOn([...readListenOn(), dnsIp]);

      let namedLocalRaw  = fs.existsSync(`${HOST_BIND_DIR}/named.conf.local`)
        ? fs.readFileSync(`${HOST_BIND_DIR}/named.conf.local`, 'utf-8')
        : '';
      namedLocalRaw = upsertNamedZone(namedLocalRaw, zoneName, zoneFile);

      // Additional PLMN zones — same server IPs, different domain names
      for (const addDomain of additionalDomains) {
        const addZoneFile = `/etc/bind/zones/${addDomain}.zone`;
        fs.writeFileSync(`${HOST_BIND_ZONES_DIR}/${addDomain}.zone`,
          bindZoneFile({ imsDomain: addDomain, dnsIp, hssIp, pcscfIp, icscfIp, scscfIp, pcscfPort, icscfPort, scscfPort }), 'utf-8');
        namedLocalRaw = upsertNamedZone(namedLocalRaw, addDomain, addZoneFile);
      }

      // Remove zones for PLMNs no longer configured
      for (const removedDomain of removedDomains) {
        const removedZoneFile = `${HOST_BIND_ZONES_DIR}/${removedDomain}.zone`;
        if (fs.existsSync(removedZoneFile)) fs.unlinkSync(removedZoneFile);
        namedLocalRaw = removeNamedZone(namedLocalRaw, removedDomain);
      }

      fs.writeFileSync(`${HOST_BIND_DIR}/named.conf.local`, namedLocalRaw, 'utf-8');

      // 11. Update SMF yaml
      if (fs.existsSync(HOST_SMF_YAML)) {
        if (!fs.existsSync(HOST_IMS_SMF_BAK)) fs.copyFileSync(HOST_SMF_YAML, HOST_IMS_SMF_BAK);
        const smfRaw = fs.readFileSync(HOST_SMF_YAML, 'utf-8');
        fs.writeFileSync(HOST_SMF_YAML, updateSmfImsSession(smfRaw, pcscfIp, dnsIp), 'utf-8');
      }

      // 11b. HSS yaml — sms_over_ims capability for 4G subscribers
      if (fs.existsSync(HOST_HSS_YAML)) {
        let hssRaw = fs.readFileSync(HOST_HSS_YAML, 'utf-8');
        const smscUri = `sip:smsc.${imsDomain}:7090;transport=tcp`;
        if (!hssRaw.includes('sms_over_ims')) {
          hssRaw = hssRaw.replace(/^(hss:\s*)$/m, `$1\n  sms_over_ims: "${smscUri}"`);
        } else {
          hssRaw = hssRaw.replace(/sms_over_ims:.*/, `sms_over_ims: "${smscUri}"`);
        }
        fs.writeFileSync(HOST_HSS_YAML, hssRaw, 'utf-8');
      }

      // 12. PCRF — add P-CSCF as Diameter peer for Rx interface
      if (fs.existsSync(HOST_PCRF_FD_CONF)) {
        const pcrfRaw   = fs.readFileSync(HOST_PCRF_FD_CONF, 'utf-8');
        const pcscfFqdn = `pcscf.${imsDomain}`;
        fs.writeFileSync(HOST_PCRF_FD_CONF, upsertPcrfPcscfPeer(pcrfRaw, pcscfFqdn, pcscfIp, 3871), 'utf-8');
      }

      // 13. ogstun2 — IMS data plane (idempotent)
      try {
        await nsenter('bash', ['-c',
          `ip link show ogstun2 2>/dev/null || ` +
          `(ip tuntap add name ogstun2 mode tun && ` +
          `ip addr add 10.46.0.1/24 dev ogstun2 && ` +
          `ip link set ogstun2 up && ` +
          `iptables -t nat -C POSTROUTING -s 10.46.0.0/24 ! -o ogstun2 -j MASQUERADE 2>/dev/null || ` +
          `iptables -t nat -A POSTROUTING -s 10.46.0.0/24 ! -o ogstun2 -j MASQUERADE)`
        ]).catch(() => {});
      } catch { /* non-fatal */ }

      // 13b. UPF yaml — add IMS session entry pointing to ogstun2
      if (fs.existsSync(HOST_UPF_YAML)) {
        if (!fs.existsSync(HOST_IMS_UPF_BAK)) fs.copyFileSync(HOST_UPF_YAML, HOST_IMS_UPF_BAK);
        const upfRaw = fs.readFileSync(HOST_UPF_YAML, 'utf-8');
        fs.writeFileSync(HOST_UPF_YAML, updateUpfImsSession(upfRaw), 'utf-8');
      }

      // 14. Save state
      fs.writeFileSync(HOST_IMS_STATE, JSON.stringify({
        imsDomain,
        hssBackend: 'pyhss',
        config: {
          mcc, mnc, additionalPlmns: additionalPlmns ?? [],
          pcscfIp, pcscfPort, icscfIp, icscfPort, scscfIp, scscfPort,
          rtpEngineIp, rtpPortMin, rtpPortMax, dnsIp,
        },
      }, null, 2), 'utf-8');

      // 15. Disable the default kamailio.service — it binds all interfaces on port 5060
      //     and conflicts with kamailio-pcscf if left running.
      await nsenter('systemctl', ['stop', 'kamailio']).catch(() => {});
      await nsenter('systemctl', ['disable', 'kamailio']).catch(() => {});

      // 16. Enable + start all services (ordered)
      const svcs = ['bind9', 'mariadb', 'redis-server', 'pyhss-hss', 'pyhss-api', 'pyhss-diameter',
                    'rtpengine-daemon', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-pcscf', 'kamailio-smsc'];
      for (const svc of svcs) {
        await nsenter('systemctl', ['enable', '--now', svc]).catch(() => {});
        if (svc === 'redis-server') {
          await new Promise(r => setTimeout(r, 2000)); // let redis bind before pyhss services
        }
      }
      // Reload bind9 zone after restart — systemctl restart alone can race with zone file writes
      await nsenter('rndc', ['reload']).catch(() => {});

      // 17. Restart SMF + PCRF + UPF
      await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
      await nsenter('systemctl', ['restart', 'open5gs-pcrfd']).catch(() => {});
      await nsenter('systemctl', ['restart', 'open5gs-upfd']).catch(() => {});

      await auditLogger.log({
        action: 'ims_configure', user,
        details: `domain=${imsDomain} pcscf=${pcscfIp}:${pcscfPort} icscf=${icscfIp}:${icscfPort} scscf=${scscfIp}:${scscfPort}`,
        success: true,
      });
      res.json({ success: true, message: 'IMS configured and services started.', imsDomain });
    } catch (err) {
      await auditLogger.log({ action: 'ims_configure', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'ims configure error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/sync-subscribers — Open5GS MongoDB → PyHSS REST API
  router.post('/sync-subscribers', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      if (!fs.existsSync(HOST_IMS_STATE)) {
        return res.status(400).json({ success: false, error: 'IMS not configured — run Configure first.' });
      }
      const savedState = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
      const imsDomain  = savedState.imsDomain;
      const savedConfig = savedState.config ?? {};

      const allSubs = await subscriberRepo.findAllFull();
      const toSync  = allSubs.filter(s => s.msisdn && s.msisdn.length > 0 && s.security?.k);

      // Build list of all known PLMNs (primary + additional) for per-subscriber domain lookup
      const primaryMcc = savedConfig.mcc ?? '';
      const primaryMnc = savedConfig.mnc ?? '';
      const additionalPlmns: { mcc: string; mnc: string }[] = savedConfig.additionalPlmns ?? [];
      const allPlmns = [
        { mcc: primaryMcc, mnc: primaryMnc, domain: imsDomain },
        ...additionalPlmns.map((p: { mcc: string; mnc: string }) => ({
          mcc: p.mcc, mnc: p.mnc, domain: deriveImsDomain(p.mcc, p.mnc),
        })),
      ];

      // Pick the IMS domain whose MCC+MNC prefix matches the subscriber's IMSI.
      // Falls back to primary domain for unrecognised prefixes.
      const domainForImsi = (imsi: string): string => {
        for (const plmn of allPlmns) {
          if (imsi.startsWith(plmn.mcc + plmn.mnc)) return plmn.domain;
        }
        return imsDomain;
      };

      // Ensure pyHSS config.yaml reflects the current PLMN list (covers the case where
      // additional PLMNs were added after the initial Configure run).
      const scscfPort = savedConfig.scscfPort ?? 6060;
      const scscfIp   = savedConfig.scscfIp   ?? '127.0.1.2';
      try {
        const updatedYaml = pyhssConfigYaml({
          imsDomain,
          mcc: primaryMcc, mnc: primaryMnc,
          scscfIp, scscfPort,
          hssIp: '127.0.1.3',
          additionalPlmns,
        });
        fs.writeFileSync('/proc/1/root/opt/pyhss/config.yaml', updatedYaml, 'utf-8');
        // Restart pyHSS so the new scscf_pool takes effect before subscriber records land.
        // pyhss-api Requires=pyhss-hss (see pyhssApiUnit() above), so this restart cascades
        // to pyhss-api too — and PyHSS's own startup (Diameter library init, then Flask)
        // reliably takes ~25-30s, confirmed live (2026-07-17). A fixed 3s wait here used to
        // be enough only because pyhss-api's unit previously had no dependency on pyhss-hss
        // at all (it was orphaned/never wired up — see the module-level comment above
        // IMS_TEMPLATES_DIR); now that the dependency is correct, every single subscriber
        // sync call was hitting a PyHSS API that hadn't finished starting yet and failing
        // uniformly. Poll for real readiness instead of guessing a fixed delay.
        await nsenter('systemctl', ['restart', 'pyhss-hss', 'pyhss-diameter']).catch(() => {});
        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
          try { await pyhssApiCall('GET', '/apn/list'); ready = true; break; } catch { /* not up yet */ }
          await new Promise(r => setTimeout(r, 1500));
        }
        if (!ready) logger.warn('PyHSS API did not become ready within 45s after restart — sync will likely fail');
      } catch (e) {
        logger.warn({ err: String(e) }, 'Could not update pyHSS config during sync — continuing anyway');
      }

      let synced = 0;
      const failed: string[] = [];

      {
        // ── PyHSS sync via REST API ───────────────────────────────────────────────

        // Ensure internet APN exists (needed as default_apn for subscriber)
        let internetApnId = 1;
        try {
          const apnList: any[] = await pyhssApiCall('GET', '/apn/list');
          const existing = Array.isArray(apnList) ? apnList.find((a: any) => a.apn === 'internet') : null;
          if (existing) {
            internetApnId = existing.apn_id;
          } else {
            const created = await pyhssApiCall('PUT', '/apn/', {
              apn: 'internet', apn_ambr_dl: 999999, apn_ambr_ul: 999999, qci: 9, arp_priority: 4,
            });
            internetApnId = created.apn_id ?? 1;
          }
        } catch { /* use default apn_id=1 */ }

        // Pre-fetch all PyHSS IMS subscribers to detect MSISDN conflicts across IMSIs
        const syncImsiSet = new Set(toSync.map(s => s.imsi));
        const msisdnOwnerMap = new Map<string, { imsi: string; id: number }>();
        try {
          const imsAll: any[] = await pyhssApiCall('GET', '/ims_subscriber/list');
          if (Array.isArray(imsAll)) {
            for (const e of imsAll) {
              if (e.msisdn) msisdnOwnerMap.set(String(e.msisdn), { imsi: String(e.imsi), id: e.ims_subscriber_id });
            }
          }
        } catch { /* proceed without conflict map */ }

        for (const sub of toSync) {
          const imsi   = sub.imsi;
          const msisdn = sub.msisdn![0];
          const k      = (sub.security?.k ?? '').toUpperCase();
          const opc    = (sub.security?.opc ?? '').toUpperCase();
          const amf    = (sub.security?.amf ?? '8000').toString();
          const sqnNum = Number(sub.security?.sqn ?? 0);

          if (!/^\d+$/.test(imsi) || !/^\d+$/.test(msisdn) || !/^[0-9a-fA-F]{32}$/.test(k)) {
            failed.push(`${imsi}: invalid IMSI/MSISDN/K format`);
            continue;
          }

          try {
            // Delete-then-recreate: handles any field change (k, opc, amf, msisdn, etc.)
            // Delete order: IMS subscriber → subscriber → AUC (reverse dependency)
            let existingIms: any = null;
            try { existingIms = await pyhssApiCall('GET', `/ims_subscriber/ims_subscriber_imsi/${imsi}`); } catch { /* not found */ }
            if (existingIms?.ims_subscriber_id) {
              try { await pyhssApiCall('DELETE', `/ims_subscriber/${existingIms.ims_subscriber_id}`); } catch { /* ignore */ }
              msisdnOwnerMap.delete(String(existingIms.msisdn ?? msisdn));
            }

            let existingSub: any = null;
            try { existingSub = await pyhssApiCall('GET', `/subscriber/imsi/${imsi}`); } catch { /* not found */ }
            if (existingSub?.subscriber_id) {
              try { await pyhssApiCall('DELETE', `/subscriber/${existingSub.subscriber_id}`); } catch { /* ignore */ }
            }

            let existingAuc: any = null;
            try { existingAuc = await pyhssApiCall('GET', `/auc/imsi/${imsi}`); } catch { /* not found */ }
            if (existingAuc?.auc_id) {
              try { await pyhssApiCall('DELETE', `/auc/${existingAuc.auc_id}`); } catch { /* ignore */ }
            }

            // Check if target MSISDN is still held by a different IMSI in PyHSS
            const conflict = msisdnOwnerMap.get(msisdn);
            if (conflict && conflict.imsi !== imsi) {
              if (!syncImsiSet.has(conflict.imsi)) {
                // Stale entry (IMSI no longer in Open5GS) — remove it
                try { await pyhssApiCall('DELETE', `/ims_subscriber/${conflict.id}`); } catch { /* ignore */ }
                msisdnOwnerMap.delete(msisdn);
              } else {
                // Genuine duplicate: two Open5GS subscribers share the same MSISDN
                throw new Error(`MSISDN ${msisdn} is also assigned to IMSI ${conflict.imsi} — fix duplicate MSISDNs on the Subscribers page`);
              }
            }

            // Create order: AUC → subscriber → IMS subscriber
            const newAuc = await pyhssApiCall('PUT', '/auc/', { ki: k, opc, amf, sqn: sqnNum, imsi });
            const aucId  = newAuc.auc_id;

            await pyhssApiCall('PUT', '/subscriber/', {
              imsi, msisdn, auc_id: aucId,
              default_apn: internetApnId,
              apn_list: String(internetApnId),
              enabled: true,
            });

            // Use the IMS domain that matches this subscriber's IMSI PLMN prefix
            const subDomain   = domainForImsi(imsi);
            const subScscfUri = `sip:scscf.${subDomain}:${scscfPort}`;
            await pyhssApiCall('PUT', '/ims_subscriber/', {
              imsi, msisdn,
              msisdn_list: msisdn,
              scscf: subScscfUri,
              scscf_realm: subDomain,
              scscf_peer: `scscf.${subDomain}`,
              // Must be set explicitly — PyHSS's own "fall back to the globally
              // configured Default_iFC" logic doesn't actually work: its SAR
              // handler (Answer_16777216_301) does
              // `templateEnv.get_template(ims_subscriber_details['ifc_path'])`
              // with no None-check, so a NULL ifc_path (the default for a row
              // created without this field) crashes with `AttributeError:
              // 'NoneType' object has no attribute 'split'` deep in Jinja2's
              // loader — confirmed live, 2026-07-17, and it's what was silently
              // timing out every SIP REGISTER's Server-Assignment-Request.
              // Path is relative to PyHSS's own Jinja2 FileSystemLoader
              // (`searchpath="../"`, resolved from its /opt/pyhss cwd → /opt) —
              // NOT the filesystem's /opt/pyhss/default_ifc.xml absolute path,
              // which 404s as a template name (confirmed live).
              ifc_path: 'pyhss/default_ifc.xml',
            });

            msisdnOwnerMap.set(msisdn, { imsi, id: 0 }); // mark MSISDN as claimed for subsequent subs
            synced++;
          } catch (e) {
            failed.push(`${imsi}: ${(e as Error).message ?? String(e)}`);
            logger.warn({ imsi, err: String(e) }, 'PyHSS subscriber sync failed');
          }
        }
      }

      // ── Reconciliation cleanup ────────────────────────────────────────────────
      // Remove PyHSS subscribers whose IMSI no longer exists in Open5GS (deleted
      // subscriber, or MSISDN/K cleared) — these are never touched by the sync
      // loop above since it only iterates over currently-eligible `toSync` IMSIs.
      let removed = 0;
      try {
        const currentImsiSet = new Set(toSync.map(s => s.imsi));
        const imsAll: any[] = await pyhssApiCall('GET', '/ims_subscriber/list');
        const staleImsis = Array.isArray(imsAll)
          ? imsAll.filter(e => e.imsi && !currentImsiSet.has(String(e.imsi))).map(e => String(e.imsi))
          : [];

        for (const staleImsi of staleImsis) {
          try {
            let existingIms: any = null;
            try { existingIms = await pyhssApiCall('GET', `/ims_subscriber/ims_subscriber_imsi/${staleImsi}`); } catch { /* not found */ }
            if (existingIms?.ims_subscriber_id) {
              await pyhssApiCall('DELETE', `/ims_subscriber/${existingIms.ims_subscriber_id}`).catch(() => {});
            }

            let existingSub: any = null;
            try { existingSub = await pyhssApiCall('GET', `/subscriber/imsi/${staleImsi}`); } catch { /* not found */ }
            if (existingSub?.subscriber_id) {
              await pyhssApiCall('DELETE', `/subscriber/${existingSub.subscriber_id}`).catch(() => {});
            }

            let existingAuc: any = null;
            try { existingAuc = await pyhssApiCall('GET', `/auc/imsi/${staleImsi}`); } catch { /* not found */ }
            if (existingAuc?.auc_id) {
              await pyhssApiCall('DELETE', `/auc/${existingAuc.auc_id}`).catch(() => {});
            }

            removed++;
          } catch (e) {
            logger.warn({ imsi: staleImsi, err: String(e) }, 'PyHSS stale subscriber cleanup failed');
          }
        }
      } catch (e) {
        logger.warn({ err: String(e) }, 'Could not fetch PyHSS ims_subscriber list for cleanup — skipping');
      }

      await auditLogger.log({
        action: 'ims_sync_subscribers', user,
        details: `synced=${synced} failed=${failed.length} removed=${removed}`, success: true,
      });
      res.json({ success: true, synced, failed, removed, total: toSync.length });
    } catch (err) {
      logger.error({ err: String(err) }, 'ims sync-subscribers error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/ims/dns-records
  router.get('/dns-records', async (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(HOST_IMS_STATE)) return res.json({ success: true, records: [] });
      const stateData = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
      const { imsDomain, config } = stateData;
      const additionalPlmns: { mcc: string; mnc: string }[] = config?.additionalPlmns ?? [];
      const additionalDomains = additionalPlmns.map((p: { mcc: string; mnc: string }) =>
        `ims.mnc${p.mnc.padStart(3, '0')}.mcc${p.mcc}.3gppnetwork.org`);
      const allDomains = [imsDomain, ...additionalDomains];

      const records: { name: string; type: string; value: string }[] = [];
      const rawParts: string[] = [];

      for (const domain of allDomains) {
        const zoneFile = `${HOST_BIND_ZONES_DIR}/${domain}.zone`;
        if (!fs.existsSync(zoneFile)) continue;
        const zoneRaw = fs.readFileSync(zoneFile, 'utf-8');
        rawParts.push(`; ═══ ${domain} ═══\n${zoneRaw}`);
        for (const line of zoneRaw.split('\n')) {
          if (line.startsWith(';') || line.startsWith('$') || line.trim() === '') continue;
          const m = line.match(/^(\S+|\s+)\s+(?:IN\s+)?(\w+)\s+(.+)$/);
          if (m) records.push({ name: m[1].trim() || '@', type: m[2], value: m[3].trim() });
        }
      }

      res.json({ success: true, records, raw: rawParts.join('\n\n') });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/validate
  router.post('/validate', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    type Check = { name: string; pass: boolean; detail: string; remediation?: string };
    const checks: Check[] = [];
    const add = (name: string, pass: boolean, detail: string, remediation?: string) =>
      checks.push({ name, pass, detail, remediation });

    try {
      if (!fs.existsSync(HOST_IMS_STATE)) {
        return res.json({
          success: true,
          checks: [{ name: 'IMS State', pass: false, detail: 'Not configured', remediation: 'Run Configure first.' }],
          allPass: false,
        });
      }
      const savedValidate = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
      const imsDomain = savedValidate.imsDomain;
      const config    = savedValidate.config;
      const dnsIp = config?.dnsIp ?? '127.0.0.1';

      // DNS checks — primary PLMN
      for (const host of ['pcscf', 'icscf', 'scscf']) {
        try {
          const { stdout } = await nsenter('dig', ['+short', `${host}.${imsDomain}`, `@${dnsIp}`]);
          const ip = stdout.trim();
          add(`DNS A: ${host}`, ip.length > 0, ip || 'no answer',
            ip.length === 0 ? 'Check BIND9 zone file and service status.' : undefined);
        } catch (e) {
          add(`DNS A: ${host}`, false, String(e));
        }
      }

      // SRV
      try {
        const { stdout } = await nsenter('dig', ['+short', `_sip._udp.pcscf.${imsDomain}`, 'SRV', `@${dnsIp}`]);
        add('DNS SRV: _sip._udp.pcscf', stdout.trim().length > 0, stdout.trim() || 'no answer');
      } catch (e) { add('DNS SRV', false, String(e)); }

      // DNS checks — additional PLMNs
      const additionalPlmnsVal: { mcc: string; mnc: string }[] = config?.additionalPlmns ?? [];
      for (const plmn of additionalPlmnsVal) {
        const addDomain = `ims.mnc${plmn.mnc.padStart(3, '0')}.mcc${plmn.mcc}.3gppnetwork.org`;
        for (const host of ['pcscf', 'icscf', 'scscf']) {
          try {
            const { stdout } = await nsenter('dig', ['+short', `${host}.${addDomain}`, `@${dnsIp}`]);
            const ip = stdout.trim();
            add(`DNS (${plmn.mcc}/${plmn.mnc}): ${host}`, ip.length > 0, ip || 'no answer',
              ip.length === 0 ? `Check BIND9 zone for ${addDomain}.` : undefined);
          } catch (e) {
            add(`DNS (${plmn.mcc}/${plmn.mnc}): ${host}`, false, String(e));
          }
        }
      }

      // HSS service check
      for (const svc of ['pyhss-diameter', 'pyhss-hss', 'pyhss-api']) {
        try {
          const { stdout } = await nsenter('systemctl', ['is-active', svc]);
          const active = stdout.trim() === 'active';
          add(`PyHSS: ${svc}`, active, stdout.trim(),
            !active ? `${svc} not running. Run Install + Configure.` : undefined);
        } catch { add(`PyHSS: ${svc}`, false, 'unknown'); }
      }
      // PyHSS Diameter port
      try {
        const { stdout } = await nsenter('bash', ['-c', `ss -tlnp | grep ':3868 ' | head -1`]);
        add('PyHSS Diameter port 3868', stdout.trim().length > 0, stdout.trim() || 'not listening',
          stdout.trim().length === 0 ? 'pyhss-diameter not listening on port 3868.' : undefined);
      } catch { add('PyHSS Diameter port 3868', false, 'check failed'); }
      // PyHSS subscriber count via API
      try {
        const list = await pyhssApiCall('GET', '/ims_subscriber/list');
        const count = Array.isArray(list) ? list.length : 0;
        add('PyHSS: IMS subscribers', true, `${count} IMS subscribers`,
          count === 0 ? 'Run Sync Subscribers.' : undefined);
      } catch (e) {
        add('PyHSS: IMS subscribers', false, String(e), 'PyHSS API not responding. Check pyhss-api service.');
      }

      // Kamailio processes
      try {
        const { stdout } = await nsenter('pgrep', ['-c', 'kamailio']);
        const count = parseInt(stdout.trim()) || 0;
        add('Kamailio processes', count >= 3, `${count} kamailio processes`,
          count < 3 ? 'Check kamailio-pcscf/icscf/scscf status.' : undefined);
      } catch { add('Kamailio processes', false, '0 processes'); }

      // RTPengine
      try {
        const { stdout } = await nsenter('systemctl', ['is-active', 'rtpengine-daemon']);
        add('RTPengine', stdout.trim() === 'active', stdout.trim());
      } catch { add('RTPengine', false, 'unknown'); }

      // SMF IMS DNN
      const smfHasIms = fs.existsSync(HOST_SMF_YAML) && /dnn:\s*ims/.test(fs.readFileSync(HOST_SMF_YAML, 'utf-8'));
      add('SMF IMS DNN', smfHasIms, smfHasIms ? 'ims DNN in smf.yaml' : 'not found',
        !smfHasIms ? 'Re-run Configure.' : undefined);

      const allPass = checks.every(c => c.pass);
      await auditLogger.log({ action: 'ims_validate', user, details: `allPass=${allPass}`, success: true });
      res.json({ success: true, checks, allPass });
    } catch (err) {
      logger.error({ err: String(err) }, 'ims validate error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/enable
  router.post('/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const svcs = ['bind9', 'mariadb', 'redis-server', 'pyhss-diameter', 'pyhss-hss', 'pyhss-api', 'rtpengine-daemon', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-pcscf', 'kamailio-smsc'];
      for (const svc of svcs) {
        await nsenter('systemctl', ['start', svc]).catch(() => {});
      }
      if (fs.existsSync(HOST_IMS_SMF_BAK) && fs.existsSync(HOST_IMS_STATE)) {
        const { config } = JSON.parse(fs.readFileSync(HOST_IMS_STATE, 'utf-8'));
        if (fs.existsSync(HOST_SMF_YAML) && config) {
          const smfRaw = fs.readFileSync(HOST_SMF_YAML, 'utf-8');
          fs.writeFileSync(HOST_SMF_YAML, updateSmfImsSession(smfRaw, config.pcscfIp, config.dnsIp), 'utf-8');
          await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
        }
      }
      await auditLogger.log({ action: 'ims_enable', user, details: 'IMS services started', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_enable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/disable
  router.post('/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      if (fs.existsSync(HOST_SMF_YAML)) {
        const smfRaw = fs.readFileSync(HOST_SMF_YAML, 'utf-8');
        fs.writeFileSync(HOST_SMF_YAML, removeSmfImsSession(smfRaw), 'utf-8');
        await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
      }
      if (fs.existsSync(HOST_UPF_YAML)) {
        const upfRaw = fs.readFileSync(HOST_UPF_YAML, 'utf-8');
        fs.writeFileSync(HOST_UPF_YAML, removeUpfImsSession(upfRaw), 'utf-8');
        await nsenter('systemctl', ['restart', 'open5gs-upfd']).catch(() => {});
      }
      const stopSvcs = ['kamailio-smsc', 'kamailio-scscf', 'kamailio-icscf', 'kamailio-pcscf', 'rtpengine-daemon', 'pyhss-api', 'pyhss-hss', 'pyhss-diameter'];
      for (const svc of stopSvcs) {
        await nsenter('systemctl', ['stop', svc]).catch(() => {});
      }
      await auditLogger.log({ action: 'ims_disable', user, details: 'IMS stopped, SMF IMS DNN removed', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_disable', user, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ims/remove — full teardown, as if IMS was never installed
  router.post('/remove', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    const write = (s: string) => { res.write(s); };
    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', '--',
          'bash', '-c', bashScript], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', (code) => resolve(code ?? 1));
      });

    // 1. Stop and disable all IMS services
    write('=== Stopping IMS services ===\n');
    // NOTE: bind9 is deliberately NOT in this list — it's shared infrastructure (VoWiFi's
    // ePDG zone, the DNS/FQDN migration wizard's 5gc/epc zones, SEPP's advertise FQDN all
    // depend on it staying up). Only IMS's own zone gets torn down, in step 5 below.
    const removeSvcs = ['kamailio-smsc', 'kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'rtpengine-daemon', 'pyhss-api', 'pyhss-hss', 'pyhss-diameter'];
    for (const svc of removeSvcs) {
      await nsenter('systemctl', ['stop', svc]).catch(() => {});
      await nsenter('systemctl', ['disable', svc]).catch(() => {});
      write(`  stopped + disabled: ${svc}\n`);
    }

    // 2. Remove IMS DNN and p-cscf from SMF YAML, restart SMF
    write('\n=== Removing IMS APN from SMF config ===\n');
    if (fs.existsSync(HOST_SMF_YAML)) {
      const smfRaw = fs.readFileSync(HOST_SMF_YAML, 'utf-8');
      fs.writeFileSync(HOST_SMF_YAML, removeSmfImsSession(smfRaw), 'utf-8');
      await nsenter('systemctl', ['restart', 'open5gs-smfd']).catch(() => {});
      write('  p-cscf + dnn:ims removed from smf.yaml, open5gs-smfd restarted.\n');
    } else {
      write('  smf.yaml not found — skipping.\n');
    }

    // 2b. Remove IMS session from UPF YAML, restart UPF
    write('\n=== Removing IMS session from UPF config ===\n');
    if (fs.existsSync(HOST_UPF_YAML)) {
      const upfRaw = fs.readFileSync(HOST_UPF_YAML, 'utf-8');
      fs.writeFileSync(HOST_UPF_YAML, removeUpfImsSession(upfRaw), 'utf-8');
      await nsenter('systemctl', ['restart', 'open5gs-upfd']).catch(() => {});
      write('  dnn:ims removed from upf.yaml, open5gs-upfd restarted.\n');
    } else {
      write('  upf.yaml not found — skipping.\n');
    }
    if (fs.existsSync(HOST_IMS_UPF_BAK)) { try { fs.unlinkSync(HOST_IMS_UPF_BAK); } catch { /* ok */ } }

    // 3. Remove IMS APN from all Open5GS subscriber profiles
    write('\n=== Removing IMS APN from subscriber profiles ===\n');
    try {
      const count = await subscriberRepo.removeImsSessionFromAll();
      write(`  Removed IMS APN from ${count} subscriber profile(s).\n`);
    } catch (err) {
      write(`  Warning: ${String(err)}\n`);
    }

    // 4. Drop MariaDB IMS databases
    write('\n=== Dropping IMS databases ===\n');
    for (const db of ['icscf', 'scscf', 'pcscf', 'ims_hss_db', 'ims_icscf', 'ims_scscf', 'hss_db']) {
      try {
        await mysqlExec(`DROP DATABASE IF EXISTS \`${db}\`;`);
        write(`  Dropped: ${db}\n`);
      } catch (err) {
        write(`  Warning dropping ${db}: ${String(err)}\n`);
      }
    }

    // 5. Remove BIND9 IMS zone file and zone block
    write('\n=== Removing BIND9 IMS zone ===\n');
    try {
      if (fs.existsSync(HOST_BIND_ZONES_DIR)) {
        const zoneFiles = fs.readdirSync(HOST_BIND_ZONES_DIR).filter(f => f.startsWith('ims.'));
        for (const f of zoneFiles) {
          fs.unlinkSync(path.join(HOST_BIND_ZONES_DIR, f));
          write(`  Removed zone file: ${f}\n`);
        }
      }
      const namedLocal = path.join(HOST_BIND_DIR, 'named.conf.local');
      if (fs.existsSync(namedLocal)) {
        const raw = fs.readFileSync(namedLocal, 'utf-8');
        const cleaned = raw.replace(/\nzone\s+"ims\.[^"]+"\s*\{[\s\S]*?\};\n?/g, '\n').trimEnd() + '\n';
        fs.writeFileSync(namedLocal, cleaned, 'utf-8');
        write('  Removed IMS zone block from named.conf.local.\n');
      }
      // Reload bind9 if running — ignore error if not
      await nsenter('systemctl', ['is-active', 'bind9'])
        .then(() => nsenter('systemctl', ['reload', 'bind9']).catch(() => {}))
        .catch(() => {});
    } catch (err) {
      write(`  Warning: ${String(err)}\n`);
    }

    // 6. Remove IMS include config and Diameter XML files
    write('\n=== Removing IMS config files ===\n');
    const imsFiles = [
      `${HOST_KAMAILIO_PCSCF_DIR}/pcscf.cfg`,
      `${HOST_KAMAILIO_PCSCF_DIR}/pcscf.xml`,
      `${HOST_KAMAILIO_ICSCF_DIR}/icscf.cfg`,
      `${HOST_KAMAILIO_ICSCF_DIR}/icscf.xml`,
      `${HOST_KAMAILIO_SCSCF_DIR}/scscf.cfg`,
      `${HOST_KAMAILIO_SCSCF_DIR}/scscf.xml`,
      HOST_RTPENGINE_CONF,
    ];
    for (const f of imsFiles) {
      try { fs.unlinkSync(f); write(`  Removed: ${f.replace('/proc/1/root', '')}\n`); }
      catch { /* already gone */ }
    }

    // 7. Remove systemd service files and reload
    write('\n=== Removing systemd service files ===\n');
    const svcFiles = ['kamailio-smsc', 'kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'pyhss-diameter', 'pyhss-hss', 'pyhss-api'];
    for (const svc of svcFiles) {
      const f = path.join(HOST_SYSTEMD_DIR, `${svc}.service`);
      try { fs.unlinkSync(f); write(`  Removed: ${svc}.service\n`); }
      catch { /* already gone */ }
    }
    await nsenter('systemctl', ['daemon-reload']).catch(() => {});
    write('  daemon-reload complete.\n');

    // 8. Remove PyHSS
    write('\n=== Removing PyHSS ===\n');
    try {
      fs.rmSync('/proc/1/root/opt/pyhss', { recursive: true, force: true });
      write('  Removed /opt/pyhss.\n');
    } catch (err) { write(`  Warning: ${String(err)}\n`); }
    try {
      fs.rmSync('/proc/1/root/etc/pyhss', { recursive: true, force: true });
      write('  Removed /etc/pyhss.\n');
    } catch (err) { write(`  Warning: ${String(err)}\n`); }

    // 9. Purge all IMS packages
    write('\n=== Purging IMS packages ===\n');
    // bind9/bind9utils/dnsutils deliberately excluded — see the removeSvcs comment above,
    // same reasoning: apt-get purge would wipe /etc/bind entirely (VoWiFi's zone, the DNS
    // migration wizard's zones, everything), not just IMS's own.
    const basePurgePkgs = 'kamailio kamailio-ims-modules kamailio-mysql-modules kamailio-tls-modules kamailio-extra-modules kamailio-utils-modules ' +
      'rtpengine mariadb-server mariadb-client mariadb-common';
    await spawnStream(
      `DEBIAN_FRONTEND=noninteractive apt-get purge -y ${basePurgePkgs} redis-server 2>&1 || true`
    );
    await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>&1 || true');

    // 10. Remove NMS IMS state files
    write('\n=== Removing IMS state files ===\n');
    for (const f of [HOST_IMS_STATE, HOST_IMS_SMF_BAK]) {
      try { fs.unlinkSync(f); write(`  Removed: ${path.basename(f)}\n`); }
      catch { /* already gone */ }
    }

    await auditLogger.log({ action: 'ims_remove', user, details: 'Full IMS removal', success: true });
    write('\n✅ IMS removed successfully.\n');
    write('   All services stopped, packages purged, configs deleted, subscriber IMS APNs cleared.\n');
    write('   The L3 IP address has not been changed. You may reinstall from scratch.\n');
    res.end();
  });

  // POST /api/ims/restart
  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const restartSvcs = ['bind9', 'mariadb', 'redis-server', 'pyhss-diameter', 'pyhss-hss', 'pyhss-api',
                           'rtpengine-daemon', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-pcscf', 'kamailio-smsc'];
      for (const svc of restartSvcs) {
        await nsenter('systemctl', ['restart', svc]).catch(() => {});
        if (svc === 'redis-server') {
          await new Promise(r => setTimeout(r, 2000)); // let redis bind before pyhss services
        }
      }
      await auditLogger.log({ action: 'ims_restart', user, details: 'IMS restarted', success: true });
      res.json({ success: true, message: 'IMS services restarted.' });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/ims/configs
  router.get('/configs', requireAdmin, (_req: Request, res: Response) => {
    try {
      res.json({ files: getImsConfigManifest() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/ims/configs/content?path=<encoded>
  router.get('/configs/content', requireAdmin, (req: Request, res: Response) => {
    const filePath = String(req.query.path ?? '');
    if (!filePath || !isAllowedConfigPath(filePath)) {
      return res.status(400).json({ error: 'Path not in allowlist' });
    }
    const hostPath = `/proc/1/root${filePath}`;
    if (!fs.existsSync(hostPath)) {
      return res.json({ content: '', exists: false });
    }
    try {
      res.json({ content: fs.readFileSync(hostPath, 'utf-8'), exists: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PUT /api/ims/configs/content
  router.put('/configs/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: filePath, content } = req.body as { path: string; content: string };
    if (!filePath || !isAllowedConfigPath(filePath)) {
      return res.status(400).json({ error: 'Path not in allowlist' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    const hostPath = `/proc/1/root${filePath}`;
    try {
      fs.mkdirSync(path.dirname(hostPath), { recursive: true });
      fs.writeFileSync(hostPath, content, 'utf-8');
      await auditLogger.log({ action: 'ims_configure', user, details: `config-edit: ${filePath}`, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'ims_configure', user, details: `config-edit failed: ${filePath}: ${String(err)}`, success: false });
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/ims/configs/restart
  router.post('/configs/restart', requireAdmin, async (req: Request, res: Response) => {
    const { services } = req.body as { services: string[] };
    if (!Array.isArray(services) || services.length === 0) {
      return res.status(400).json({ error: 'services must be a non-empty array' });
    }
    const allowed = new Set([
      'kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-smsc',
      'pyhss-api', 'pyhss-diameter', 'pyhss-hss',
      'rtpengine-daemon', 'bind9', 'open5gs-smfd', 'open5gs-pcrfd',
    ]);
    const bad = services.filter(s => !allowed.has(s));
    if (bad.length > 0) {
      return res.status(400).json({ error: `Not allowed: ${bad.join(', ')}` });
    }
    const results: string[] = [];
    try {
      await nsenter('systemctl', ['daemon-reload']).catch(() => {});
      for (const svc of services) {
        try {
          await nsenter('systemctl', ['restart', svc], 20000);
          results.push(`${svc}: restarted`);
        } catch (err) {
          results.push(`${svc}: error — ${String(err)}`);
        }
      }
      res.json({ success: true, results });
    } catch (err) {
      res.status(500).json({ error: String(err), results });
    }
  });

  return router;
}
