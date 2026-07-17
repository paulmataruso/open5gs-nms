import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { nsenter } from '../../infrastructure/network/dummy-interface';

// Generic BIND9 management — install, service control, and a raw file editor over
// /etc/bind. Deliberately NOT a structured zone-generation UI (that's IMS's own
// DnsRecordsCard for IMS-specific records) — this is the shared admin tool other
// modules (VoWiFi, IMS) point users at for anything beyond what their own wizard covers.
const HOST_BIND_DIR = '/proc/1/root/etc/bind';

function isPathInBindDir(absPath: string): boolean {
  const resolved = path.resolve(`/proc/1/root${absPath}`);
  return resolved === HOST_BIND_DIR || resolved.startsWith(HOST_BIND_DIR + path.sep);
}

interface BindFile {
  path: string;   // e.g. /etc/bind/named.conf.local
  label: string;  // relative to /etc/bind, e.g. zones/mnc070.mcc999.pub.3gppnetwork.org.zone
}

function listBindFiles(): BindFile[] {
  if (!fs.existsSync(HOST_BIND_DIR)) return [];
  const results: BindFile[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && (entry.name === 'cache' || entry.name === 'bind')) continue; // skip bind9 runtime state dirs
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else {
        results.push({ path: `/etc/bind/${relPath}`, label: relPath });
      }
    }
  };
  walk(HOST_BIND_DIR, '');
  return results.sort((a, b) => a.label.localeCompare(b.label));
}

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const NAMED_OPTIONS_PATH = `${HOST_BIND_DIR}/named.conf.options`;

function readForwarders(): string[] {
  if (!fs.existsSync(NAMED_OPTIONS_PATH)) return [];
  const raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
  const m = raw.match(/forwarders\s*\{([^}]*)\}\s*;/);
  if (!m) return [];
  return m[1].split(';').map(s => s.trim()).filter(s => IP_RE.test(s));
}

function writeForwarders(forwarders: string[]): void {
  const block = `forwarders { ${forwarders.map(f => `${f};`).join(' ')} };`;
  let raw = fs.existsSync(NAMED_OPTIONS_PATH) ? fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8') : 'options {\n};\n';
  if (/forwarders\s*\{[^}]*\}\s*;/.test(raw)) {
    raw = raw.replace(/forwarders\s*\{[^}]*\}\s*;/, block);
  } else {
    // No forwarders block yet — insert just before the closing brace of options {}
    raw = raw.replace(/\}\s*;?\s*$/, `\t${block}\n};\n`);
  }
  fs.mkdirSync(path.dirname(NAMED_OPTIONS_PATH), { recursive: true });
  fs.writeFileSync(NAMED_OPTIONS_PATH, raw, 'utf-8');
}

// listen-on — the single, shared setting for which local IPs BIND actually binds to.
// Owned by this page only: IMS/VoWiFi each used to write their own copy of this line
// whenever their wizard ran, silently clobbering whatever the others (or the user) had
// set. Now they only manage their own zone files; this is the one place that touches
// the options{} block's listen-on line.
export function readListenOn(): string[] {
  if (!fs.existsSync(NAMED_OPTIONS_PATH)) return ['127.0.0.1'];
  const raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
  const m = raw.match(/listen-on\s*\{([^}]*)\}\s*;/);
  if (!m) return ['127.0.0.1'];
  const ips = m[1].split(';').map(s => s.trim()).filter(s => IP_RE.test(s));
  return ips.length > 0 ? ips : ['127.0.0.1'];
}

export function writeListenOn(ips: string[]): void {
  // Always keep 127.0.0.1 — every module here (IMS zone verification, VoWiFi, the DNS
  // migration wizard's own dig checks) assumes BIND answers on loopback regardless of
  // whatever else is configured.
  const all = Array.from(new Set(['127.0.0.1', ...ips]));
  const block = `listen-on { ${all.map(ip => `${ip};`).join(' ')} };`;
  let raw = fs.existsSync(NAMED_OPTIONS_PATH) ? fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8') : 'options {\n};\n';
  if (/listen-on\s*\{[^}]*\}\s*;/.test(raw)) {
    raw = raw.replace(/listen-on\s*\{[^}]*\}\s*;/, block);
  } else {
    raw = raw.replace(/\}\s*;?\s*$/, `\t${block}\n};\n`);
  }
  fs.mkdirSync(path.dirname(NAMED_OPTIONS_PATH), { recursive: true });
  fs.writeFileSync(NAMED_OPTIONS_PATH, raw, 'utf-8');
}

function ensureRecursionAndAllowQuery(): boolean {
  if (!fs.existsSync(NAMED_OPTIONS_PATH)) return false;
  let raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
  let changed = false;
  if (!/recursion\s+yes\s*;/.test(raw)) {
    raw = raw.replace(/\}\s*;?\s*$/, '\trecursion yes;\n};\n');
    changed = true;
  }
  if (!/allow-query\s*\{[^}]*\}\s*;/.test(raw)) {
    raw = raw.replace(/\}\s*;?\s*$/, '\tallow-query { any; };\n};\n');
    changed = true;
  }
  if (changed) fs.writeFileSync(NAMED_OPTIONS_PATH, raw, 'utf-8');
  return changed;
}

// ─── Self-healing: recover from `apt purge bind9` (or any other event that resets
// named.conf.{local,options} to their stock package defaults) without losing zones ───
// Real incident (2026-07-17): a manual `apt purge bind9` wiped both conf files back to
// the stock Ubuntu template, but the zone *files* under zones/ survived (they aren't
// owned by the Debian package) — every 5GC NF that resolves its own advertise FQDN at
// startup crash-looped until this was manually repaired. This makes that repair a
// one-click, self-detecting action instead of requiring someone to SSH in and rebuild
// both conf files by hand.
const ZONE_FILE_RE = /^(.+)\.zone$/;

function zoneFilesOnDisk(): string[] {
  const zonesDir = `${HOST_BIND_DIR}/zones`;
  if (!fs.existsSync(zonesDir)) return [];
  return fs.readdirSync(zonesDir)
    .map(f => f.match(ZONE_FILE_RE)?.[1])
    .filter((name): name is string => !!name);
}

function zonesDeclaredInNamedLocal(): Set<string> {
  const namedLocalPath = `${HOST_BIND_DIR}/named.conf.local`;
  if (!fs.existsSync(namedLocalPath)) return new Set();
  const raw = fs.readFileSync(namedLocalPath, 'utf-8');
  const names = new Set<string>();
  const re = /zone\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) names.add(m[1]);
  return names;
}

export interface BindHealth {
  installed: boolean;
  undeclaredZones: string[];       // zone files on disk with no zone{} block in named.conf.local
  optionsNeedsRepair: boolean;     // missing recursion/allow-query/forwarders/listen-on
  resolvConfBypassesBind: boolean; // /etc/resolv.conf doesn't route through BIND on 127.0.0.1
}

function checkBindHealth(): BindHealth {
  const installed = fs.existsSync('/proc/1/root/usr/sbin/named');
  const onDisk = new Set(zoneFilesOnDisk());
  const declared = zonesDeclaredInNamedLocal();
  const undeclaredZones = [...onDisk].filter(z => !declared.has(z));

  let optionsNeedsRepair = true;
  if (fs.existsSync(NAMED_OPTIONS_PATH)) {
    const raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
    optionsNeedsRepair = !/recursion\s+yes\s*;/.test(raw)
      || !/allow-query\s*\{[^}]*\}\s*;/.test(raw)
      || !/forwarders\s*\{[^}]*\}\s*;/.test(raw)
      || !/listen-on\s*\{[^}]*127\.0\.0\.1/.test(raw);
  }

  let resolvConfBypassesBind = false;
  try {
    const resolvPath = '/proc/1/root/etc/resolv.conf';
    const real = fs.existsSync(resolvPath) ? fs.readFileSync(resolvPath, 'utf-8') : '';
    // systemd-resolved's stub (127.0.0.53) answering first means BIND is bypassed even
    // if BIND itself is perfectly healthy — the actual getaddrinfo() path never reaches it.
    const firstNameserver = real.match(/^nameserver\s+(\S+)/m)?.[1];
    resolvConfBypassesBind = firstNameserver !== undefined && firstNameserver !== '127.0.0.1';
  } catch { /* leave false if unreadable */ }

  return { installed, undeclaredZones, optionsNeedsRepair, resolvConfBypassesBind };
}

function repairZonesAndOptions(): { zonesRepaired: string[] } {
  const namedLocalPath = `${HOST_BIND_DIR}/named.conf.local`;
  const health = checkBindHealth();

  if (health.undeclaredZones.length > 0) {
    let raw = fs.existsSync(namedLocalPath) ? fs.readFileSync(namedLocalPath, 'utf-8') : '';
    for (const zoneName of health.undeclaredZones) {
      const zoneBlock = `\nzone "${zoneName}" {\n    type master;\n    file "/etc/bind/zones/${zoneName}.zone";\n};\n`;
      raw = raw.trimEnd() + '\n' + zoneBlock;
    }
    fs.mkdirSync(path.dirname(namedLocalPath), { recursive: true });
    fs.writeFileSync(namedLocalPath, raw.trimStart(), 'utf-8');
  }

  if (health.optionsNeedsRepair) {
    const existingForwarders = readForwarders();
    writeForwarders(existingForwarders.length > 0 ? existingForwarders : ['8.8.8.8', '8.8.4.4']);
    writeListenOn(readListenOn());
    ensureRecursionAndAllowQuery();
  }

  return { zonesRepaired: health.undeclaredZones };
}

export function createBindRouter(logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  // Upstream DNS forwarders — without this, a UE using this server as its DNS would
  // resolve IMS/VoWiFi-specific names fine but get nothing for general internet domains.
  // `recursion yes` + this forwarders list is what makes it a usable full DNS server, not
  // just an authoritative one for our own zones.
  router.get('/forwarders', (_req: Request, res: Response) => {
    res.json({ success: true, forwarders: readForwarders() });
  });

  router.put('/forwarders', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { forwarders } = req.body as { forwarders: string[] };
    if (!Array.isArray(forwarders) || forwarders.length === 0 || !forwarders.every(f => IP_RE.test(f))) {
      return res.status(400).json({ success: false, error: 'forwarders must be a non-empty array of IPv4 addresses' });
    }
    try {
      writeForwarders(forwarders);
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({ action: 'bind_config_save', user, target: 'forwarders', details: forwarders.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'forwarders', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Which local IPs BIND actually binds to — the single owner of this setting. IMS and
  // VoWiFi each build their own zone files, but neither writes listen-on anymore; if a
  // module needs BIND reachable on a specific IP (e.g. the one served to UEs via SMF
  // PCO), that IP needs to be added here too, not just referenced in a zone.
  router.get('/listen-on', (_req: Request, res: Response) => {
    res.json({ success: true, listenOn: readListenOn() });
  });

  router.put('/listen-on', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { listenOn } = req.body as { listenOn: string[] };
    if (!Array.isArray(listenOn) || listenOn.length === 0 || !listenOn.every(ip => IP_RE.test(ip))) {
      return res.status(400).json({ success: false, error: 'listenOn must be a non-empty array of IPv4 addresses' });
    }
    try {
      writeListenOn(listenOn);
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({ action: 'bind_config_save', user, target: 'listen-on', details: listenOn.join(','), success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'listen-on', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const installed = fs.existsSync('/proc/1/root/usr/sbin/named');
      const active = installed
        ? await nsenter('systemctl', ['is-active', 'bind9']).then(r => r.stdout.trim() === 'active').catch(() => false)
        : false;
      const health = checkBindHealth();
      res.json({
        success: true, installed, running: active, fileCount: listBindFiles().length,
        undeclaredZones: health.undeclaredZones,
        optionsNeedsRepair: health.optionsNeedsRepair,
        resolvConfBypassesBind: health.resolvConfBypassesBind,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /repair — self-heal named.conf.local/named.conf.options after they've been
  // reset to stock (e.g. `apt purge bind9` wipes conffiles but not the zones/ directory,
  // which the package doesn't own). Re-declares any zone file found on disk that's
  // missing its zone{} block, and re-asserts recursion/allow-query/forwarders/listen-on
  // if any are missing. Safe to call anytime — a no-op if nothing needs fixing.
  router.post('/repair', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { zonesRepaired } = repairZonesAndOptions();
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({
        action: 'bind_config_save', user, target: 'repair',
        details: `zones repaired: ${zonesRepaired.join(', ') || 'none'}`, success: true,
      });
      res.json({ success: true, zonesRepaired });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'repair', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /fix-resolver — separate, explicit action from /repair: disables
  // systemd-resolved's stub listener and replaces /etc/resolv.conf with a static file
  // pointing straight at BIND. This changes host-wide DNS resolution behavior (not just
  // BIND's own config), so it's deliberately not bundled into /repair — the operator
  // should consciously opt into it. Real incident (2026-07-17): even with BIND itself
  // perfectly healthy, getaddrinfo() (what every NF actually calls) was still bypassing
  // it entirely because /etc/resolv.conf pointed at systemd-resolved's 127.0.0.53 stub.
  router.post('/fix-resolver', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const resolvedConfPath = '/proc/1/root/etc/systemd/resolved.conf';
      if (fs.existsSync(resolvedConfPath)) {
        let raw = fs.readFileSync(resolvedConfPath, 'utf-8');
        raw = /^#?DNSStubListener=/m.test(raw)
          ? raw.replace(/^#?DNSStubListener=.*/m, 'DNSStubListener=no')
          : raw.trimEnd() + '\nDNSStubListener=no\n';
        fs.writeFileSync(resolvedConfPath, raw, 'utf-8');
      }
      await nsenter('systemctl', ['restart', 'systemd-resolved']).catch(() => {});
      // resolv.conf is normally a symlink into systemd-resolved's territory —
      // fs.writeFileSync() would follow it and overwrite systemd-resolved's own stub
      // file instead of replacing the symlink itself (which it would just regenerate
      // later, silently undoing this fix). Unlink first, exactly like the manual fix.
      const resolvConfPath = '/proc/1/root/etc/resolv.conf';
      try {
        const st = fs.lstatSync(resolvConfPath);
        if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(resolvConfPath);
      } catch { /* doesn't exist yet — fine */ }
      fs.writeFileSync(resolvConfPath, 'nameserver 127.0.0.1\n', 'utf-8');
      await auditLogger.log({ action: 'bind_config_save', user, target: 'fix-resolver', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: 'fix-resolver', details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /install — streamed synchronous install (apt only, fast — no build step)
  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const write = (s: string) => { res.write(s.endsWith('\n') ? s : s + '\n'); };

    const spawnStream = (bashScript: string): Promise<number> =>
      new Promise(resolve => {
        const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', '-c', bashScript],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => write(d.toString()));
        child.stderr.on('data', (d: Buffer) => write(d.toString()));
        child.on('close', code => resolve(code ?? 1));
      });

    try {
      write('=== Installing BIND9 ===');
      await spawnStream('DEBIAN_FRONTEND=noninteractive apt-get install -y bind9 bind9utils dnsutils 2>&1');
      fs.mkdirSync(`${HOST_BIND_DIR}/zones`, { recursive: true });
      // Seed a working baseline only if nothing configured it yet — stock apt-installed
      // bind9 has no forwarders and recursion left at its package default, which answers
      // fine for zones we add later but won't usefully resolve the wider internet until
      // this exists. Never overwrites an existing file — this page owns listen-on/
      // forwarders going forward, but if the user (or an old install) already customized
      // this file, leave it alone.
      if (!fs.existsSync(NAMED_OPTIONS_PATH)) {
        writeForwarders(['8.8.8.8', '8.8.4.4']);
        writeListenOn(['127.0.0.1']);
        let raw = fs.readFileSync(NAMED_OPTIONS_PATH, 'utf-8');
        if (!/recursion\s+yes\s*;/.test(raw)) {
          raw = raw.replace(/\}\s*;?\s*$/, '\trecursion yes;\n\tallow-query { any; };\n};\n');
          fs.writeFileSync(NAMED_OPTIONS_PATH, raw, 'utf-8');
        }
        write('Seeded default named.conf.options (recursion on, forwarders 8.8.8.8/8.8.4.4, listen-on 127.0.0.1).');
      }
      await auditLogger.log({ action: 'bind_install', user, success: true });
      write('\n✅ BIND9 installed.');
      res.end();
    } catch (err) {
      write(`\n❌ Install error: ${String(err)}`);
      await auditLogger.log({ action: 'bind_install', user, details: String(err), success: false });
      res.end();
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['enable', '--now', 'bind9']);
      await auditLogger.log({ action: 'bind_start', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_start', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/stop', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['stop', 'bind9']);
      await auditLogger.log({ action: 'bind_stop', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_stop', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.post('/restart', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await nsenter('systemctl', ['restart', 'bind9']);
      await auditLogger.log({ action: 'bind_restart', user, success: true });
      res.json({ ok: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_restart', user, details: String(err), success: false });
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get('/files', (_req: Request, res: Response) => {
    res.json({ success: true, files: listBindFiles() });
  });

  router.get('/files/content', (req: Request, res: Response) => {
    const p = String(req.query.path ?? '');
    if (!isPathInBindDir(p)) return res.status(400).json({ success: false, error: 'Path must be inside /etc/bind' });
    try {
      const content = fs.existsSync(`/proc/1/root${p}`) ? fs.readFileSync(`/proc/1/root${p}`, 'utf-8') : '';
      res.json({ success: true, content });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.put('/files/content', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { path: p, content, restart } = req.body as { path: string; content: string; restart?: boolean };
    if (!isPathInBindDir(p)) return res.status(400).json({ success: false, error: 'Path must be inside /etc/bind' });
    try {
      fs.mkdirSync(path.dirname(`/proc/1/root${p}`), { recursive: true });
      fs.writeFileSync(`/proc/1/root${p}`, content, 'utf-8');
      if (restart) await nsenter('systemctl', ['restart', 'bind9']).catch(() => {});
      await auditLogger.log({ action: 'bind_config_save', user, target: p, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_save', user, target: p, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.delete('/files', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const p = String(req.query.path ?? '');
    if (!isPathInBindDir(p)) return res.status(400).json({ success: false, error: 'Path must be inside /etc/bind' });
    try {
      if (fs.existsSync(`/proc/1/root${p}`)) fs.unlinkSync(`/proc/1/root${p}`);
      await auditLogger.log({ action: 'bind_config_delete', user, target: p, success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'bind_config_delete', user, target: p, details: String(err), success: false });
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
