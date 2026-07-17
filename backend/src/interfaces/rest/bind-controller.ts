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

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const installed = fs.existsSync('/proc/1/root/usr/sbin/named');
      const active = installed
        ? await nsenter('systemctl', ['is-active', 'bind9']).then(r => r.stdout.trim() === 'active').catch(() => false)
        : false;
      res.json({ success: true, installed, running: active, fileCount: listBindFiles().length });
    } catch (err) {
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
