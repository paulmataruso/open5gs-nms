import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { isIP } from 'net';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { ActiveSessionsUseCase } from '../../application/use-cases/active-sessions';
import { Open5gsApiClient } from '../../application/use-cases/open5gs-api-client';
import { requireAdmin } from './middleware/auth-middleware';

const execFileAsync = promisify(execFile);
const HOST_ROOT = '/proc/1/root';
const MIB_PATH = `${HOST_ROOT}/usr/share/snmp/mibs/OPEN5GS-NMS-MIB.txt`;
const AGENT_PATH = `${HOST_ROOT}/usr/local/lib/open5gs-nms/snmp_agent.py`;
const CONF_PATH = `${HOST_ROOT}/etc/snmp/snmpd.conf`;

const MIB = `OPEN5GS-NMS-MIB DEFINITIONS ::= BEGIN

IMPORTS
    MODULE-IDENTITY, OBJECT-TYPE, Integer32, Counter64, Gauge32, enterprises
        FROM SNMPv2-SMI
    DisplayString
        FROM SNMPv2-TC;

open5gsNms MODULE-IDENTITY
    LAST-UPDATED "202609010000Z"
    ORGANIZATION "Open5GS NMS"
    DESCRIPTION "Operational health and mobile-core counters exported by Open5GS NMS."
    ::= { enterprises 8072 9999 55555 }

open5gsNmsObjects OBJECT IDENTIFIER ::= { open5gsNms 1 }

open5gsNmsVersion OBJECT-TYPE SYNTAX DisplayString MAX-ACCESS read-only STATUS current DESCRIPTION "MIB implementation version." ::= { open5gsNmsObjects 1 }
open5gsCpuPercent OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Host CPU utilization percentage." ::= { open5gsNmsObjects 2 }
open5gsMemoryPercent OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Host memory utilization percentage." ::= { open5gsNmsObjects 3 }
open5gsUe4gConnected OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Connected 4G/EPS user equipments." ::= { open5gsNmsObjects 4 }
open5gsUe5gConnected OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Connected 5G user equipments." ::= { open5gsNmsObjects 5 }
open5gsEnbConnected OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Connected eNodeBs (4G BBUs)." ::= { open5gsNmsObjects 6 }
open5gsGnbConnected OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Connected gNodeBs (5G BBUs)." ::= { open5gsNmsObjects 7 }
open5gsOgstunOperStatus OBJECT-TYPE SYNTAX Integer32 { down(0), up(1) } MAX-ACCESS read-only STATUS current DESCRIPTION "ogstun operational state." ::= { open5gsNmsObjects 8 }
open5gsOgstunRxBytes OBJECT-TYPE SYNTAX Counter64 MAX-ACCESS read-only STATUS current DESCRIPTION "Bytes received by ogstun." ::= { open5gsNmsObjects 9 }
open5gsOgstunTxBytes OBJECT-TYPE SYNTAX Counter64 MAX-ACCESS read-only STATUS current DESCRIPTION "Bytes transmitted by ogstun." ::= { open5gsNmsObjects 10 }
open5gsCoreServicesActive OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Active open5gs systemd services." ::= { open5gsNmsObjects 11 }
open5gsNetworkInterfaces OBJECT-TYPE SYNTAX Gauge32 MAX-ACCESS read-only STATUS current DESCRIPTION "Number of host network interfaces. Use IF-MIB for per-interface counters." ::= { open5gsNmsObjects 12 }

END
`;

const AGENT = `#!/usr/bin/env python3
import json, os, subprocess, sys, time, urllib.request

BASE = '.1.3.6.1.4.1.8072.9999.55555.1'

def cmd(args):
    try: return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=4).strip()
    except Exception: return ''

def metric(url, names):
    try:
        text = urllib.request.urlopen(url, timeout=3).read().decode()
        for line in text.splitlines():
            if not line or line.startswith('#'): continue
            key, _, value = line.rpartition(' ')
            if key.split('{', 1)[0] in names: return max(0, int(float(value)))
    except Exception: pass
    return 0

def metrics_url(nf, fallback):
    """Resolve metrics address from the active Open5GS YAML without PyYAML."""
    try:
        lines = open('/etc/open5gs/%s.yaml' % nf).read().splitlines()
        in_metrics = False; metrics_indent = -1; address = None; port = 9090
        for line in lines:
            stripped = line.strip(); indent = len(line) - len(line.lstrip())
            if stripped == 'metrics:': in_metrics = True; metrics_indent = indent; continue
            if in_metrics and stripped and indent <= metrics_indent: break
            if in_metrics and stripped.startswith('address:') and address is None:
                address = stripped.split(':', 1)[1].strip().strip('\"\\\'')
            if in_metrics and stripped.startswith('port:'):
                try: port = int(stripped.split(':', 1)[1].strip())
                except ValueError: pass
        if address: return 'http://%s:%d/metrics' % (address, port)
    except Exception: pass
    return fallback

def cpu():
    try:
        a = list(map(int, open('/proc/stat').readline().split()[1:])); time.sleep(.15)
        b = list(map(int, open('/proc/stat').readline().split()[1:])); d = [y-x for x,y in zip(a,b)]
        return int(round(100 * (sum(d)-d[3]-d[4]) / max(1,sum(d))))
    except Exception: return 0

def mem():
    try:
        d = {x.split(':')[0]: int(x.split()[1]) for x in open('/proc/meminfo') if ':' in x}
        return int(round(100 * (d['MemTotal']-d.get('MemAvailable',d.get('MemFree',0))) / d['MemTotal']))
    except Exception: return 0

def net(name, field):
    try: return int(open('/sys/class/net/%s/statistics/%s_bytes' % (name,field)).read())
    except Exception: return 0

def values():
    links = os.listdir('/sys/class/net') if os.path.isdir('/sys/class/net') else []
    active = cmd(['systemctl','list-units','--type=service','--state=active','--no-legend','open5gs-*']).count('open5gs-')
    mme_metrics = metrics_url('mme', 'http://127.0.0.2:9090/metrics')
    amf_metrics = metrics_url('amf', 'http://127.0.0.5:9090/metrics')
    return {
      BASE+'.1.0': ('string','1.0'), BASE+'.2.0': ('gauge',str(cpu())), BASE+'.3.0': ('gauge',str(mem())),
      BASE+'.4.0': ('gauge',str(metric(mme_metrics, {'enb_ue','mme_session'}))),
      BASE+'.5.0': ('gauge',str(metric(amf_metrics, {'ran_ue','amf_session'}))),
      BASE+'.6.0': ('gauge',str(metric(mme_metrics, {'enb'}))),
      BASE+'.7.0': ('gauge',str(metric(amf_metrics, {'gnb'}))),
      BASE+'.8.0': ('integer','1' if os.path.exists('/sys/class/net/ogstun/operstate') and open('/sys/class/net/ogstun/operstate').read().strip() != 'down' else '0'),
      BASE+'.9.0': ('counter64',str(net('ogstun','rx'))), BASE+'.10.0': ('counter64',str(net('ogstun','tx')),
      BASE+'.11.0': ('gauge',str(active)), BASE+'.12.0': ('gauge',str(len(links))) }

while True:
    line = sys.stdin.readline()
    if not line: break
    op = line.strip()
    if op == 'PING': print('PONG', flush=True); continue
    if op not in ('get','getnext'): print('NONE', flush=True); continue
    oid = sys.stdin.readline().strip(); data = values(); keys = sorted(data, key=lambda x: [int(p) for p in x.strip('.').split('.')])
    key = oid if op == 'get' and oid in data else next((k for k in keys if [int(p) for p in k.strip('.').split('.')] > [int(p) for p in oid.strip('.').split('.')]), None)
    if not key: print('NONE', flush=True); continue
    typ,val=data[key]; print(key); print(typ); print(val); sys.stdout.flush()
`;

async function host(cmd: string, args: string[] = [], timeout = 30000) {
  return execFileAsync('nsenter', ['-t', '1', '-m', '-u', '-i', '-p', cmd, ...args], {
    timeout, encoding: 'utf-8', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket' },
  });
}

export function validCommunity(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_.-]{8,64}$/.test(v);
}

export function validNetwork(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const [address, prefix, extra] = v.split('/');
  if (extra !== undefined || prefix === undefined) return false;
  const family = isIP(address);
  const bits = Number(prefix);
  return (family === 4 && Number.isInteger(bits) && bits >= 0 && bits <= 32)
    || (family === 6 && Number.isInteger(bits) && bits >= 0 && bits <= 128);
}

export function createSnmpRouter(
  activeSessions: ActiveSessionsUseCase,
  hostExecutor: IHostExecutor,
  configRepo: IConfigRepository,
  audit: IAuditLogger,
  logger: pino.Logger,
): Router {
  const router = Router();
  const open5gsApi = new Open5gsApiClient(hostExecutor, configRepo, logger);

  router.get('/status', async (_req, res) => {
    const installed = await host('dpkg-query', ['-W', '-f=${Status}', 'snmpd']).then(r => r.stdout.includes('install ok installed')).catch(() => false);
    const active = installed && await host('systemctl', ['is-active', 'snmpd']).then(r => r.stdout.trim() === 'active').catch(() => false);
    const enabled = installed && await host('systemctl', ['is-enabled', 'snmpd']).then(r => r.stdout.trim() === 'enabled').catch(() => false);
    res.json({ installed, active, enabled, port: 161, mibInstalled: await fs.access(MIB_PATH).then(() => true).catch(() => false) });
  });

  router.get('/stats', async (_req, res) => {
    try {
      const [ues5, ues4, enbs, gnbs, linksRaw, cpuRaw, memRaw] = await Promise.all([
        activeSessions.getActive5GUEs(), activeSessions.getActive4GUEs(),
        open5gsApi.getMmeEnbInfo(), open5gsApi.getAmfGnbInfo(),
        host('ip', ['-j', '-s', 'link', 'show']).then(r => r.stdout),
        host('sh', ['-c', "top -bn1 | awk '/Cpu\\(s\\)/ {print 100-$8}'"]).then(r => r.stdout.trim()).catch(() => '0'),
        fs.readFile(`${HOST_ROOT}/proc/meminfo`, 'utf8'),
      ]);
      const links = JSON.parse(linksRaw || '[]');
      const mem = Object.fromEntries(memRaw.split('\n').filter(Boolean).map(l => { const p=l.split(/:\\s+|\\s+/); return [p[0], Number(p[1])||0]; }));
      res.json({ cpuPercent: Math.round(Number(cpuRaw)||0), memoryPercent: Math.round(100*((mem.MemTotal||0)-(mem.MemAvailable||0))/Math.max(1,mem.MemTotal||1)), ue4g: ues4.length, ue5g: ues5.length, enb: enbs.filter(e => e.s1?.setup_success).length, gnb: gnbs.filter(g => g.ng?.setup_success).length, interfaces: links.map((l:any) => ({ name:l.ifname, state:l.operstate, mtu:l.mtu, rxBytes:l.stats64?.rx?.bytes ?? l.stats?.rx?.bytes ?? 0, txBytes:l.stats64?.tx?.bytes ?? l.stats?.tx?.bytes ?? 0 })) });
    } catch (err) { logger.error({ err }, 'SNMP stats failed'); res.status(500).json({ error: 'Unable to collect host statistics' }); }
  });

  router.get('/mib', (_req, res) => { res.type('text/plain').attachment('OPEN5GS-NMS-MIB.txt').send(MIB); });

  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const community = req.body?.community; const network = req.body?.network ?? '127.0.0.1/32';
    if (!validCommunity(community) || !validNetwork(network)) { res.status(400).json({ error: 'Invalid community or CIDR network' }); return; }
    try {
      await host('apt-get', ['update','-qq'], 180000); await host('apt-get', ['install','-y','-qq','snmpd'], 180000);
      await host('mkdir', ['-p','/usr/local/lib/open5gs-nms','/usr/share/snmp/mibs','/etc/snmp']);
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      await host('test', ['-f','/etc/snmp/snmpd.conf']).then(() => host('cp',['-a','/etc/snmp/snmpd.conf',`/etc/snmp/snmpd.conf.nms-backup-${stamp}`])).catch(() => undefined);
      await fs.writeFile(AGENT_PATH, AGENT, { mode: 0o755 }); await fs.writeFile(MIB_PATH, MIB);
      const conf = `# Managed by Open5GS NMS\nagentAddress udp:161\nsysLocation Open5GS Core\nsysContact NMS Administrator\nview open5gsView included .1.3.6.1.2.1\nview open5gsView included .1.3.6.1.4.1.8072.9999.55555\nrocommunity ${community} ${network} -V open5gsView\npass_persist .1.3.6.1.4.1.8072.9999.55555.1 /usr/local/lib/open5gs-nms/snmp_agent.py\n`;
      await fs.writeFile(CONF_PATH, conf); await host('systemctl',['enable','--now','snmpd']); await host('systemctl',['restart','snmpd']);
      await audit.log({ action: 'snmp_install', user: req.user?.username ?? 'unknown', details: `read-only access restricted to ${network}`, success: true });
      res.json({ success:true, message:'SNMP agent installed and started on UDP/161' });
    } catch (err:any) { logger.error({ err }, 'SNMP installation failed'); res.status(500).json({ error: err?.stderr || err?.message || 'Installation failed' }); }
  });

  router.post('/:action', requireAdmin, async (req, res) => {
    if (!['start','stop','restart'].includes(req.params.action)) { res.status(400).json({ error:'Invalid action' }); return; }
    try {
      await host('systemctl',[req.params.action,'snmpd']);
      await audit.log({ action: `snmp_${req.params.action}` as 'snmp_start'|'snmp_stop'|'snmp_restart', user: req.user?.username ?? 'unknown', details: `snmpd ${req.params.action}`, success: true });
      res.json({success:true});
    }
    catch (err:any) { res.status(500).json({error:err?.stderr || 'Action failed'}); }
  });
  return router;
}
