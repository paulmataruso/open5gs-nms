import { Router, Request, Response } from 'express';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { createSocket } from 'dgram';
import { isIP } from 'net';
import type { Database } from 'better-sqlite3';
import type pino from 'pino';
import type { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import type { ActiveSessionsUseCase } from '../../application/use-cases/active-sessions';
import { requireAdmin } from './middleware/auth-middleware';

type RadioVendor = 'baicells' | 'generic';

interface RadioRow {
  id: string;
  name: string;
  vendor: RadioVendor;
  base_url: string;
  username: string;
  password_env: string;
  password_cipher?: string | null;
  password_iv?: string | null;
  password_tag?: string | null;
  metrics_path: string;
  enabled: number;
  allow_self_signed: number;
  updated_at: number;
}

interface NormalizedSignal {
  ueId: string;
  imsi?: string;
  rsrp?: number;
  rsrq?: number;
  rssi?: number;
  sinr?: number;
  snr?: number;
  dlMcs?: number;
  ulMcs?: number;
  bler?: number;
  dlMbps?: number;
  ulMbps?: number;
  txPower?: number;
  pathLoss?: number;
  primaryDlCqi?: number;
  secondaryDlCqi?: number;
  sampledAt?: number;
}

function finite(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function first(obj: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return undefined;
}

function normalizeUe(raw: Record<string, any>): NormalizedSignal | null {
  const ueId = String(first(raw, 'ueId', 'ue_id', 'ueID', 'id', 'rnti', 'crnti', 'cRnti') ?? '').trim();
  const imsi = String(first(raw, 'imsi', 'IMSI', 'supi') ?? '').replace(/\D/g, '');
  if (!ueId && !imsi) return null;
  return {
    ueId: ueId || imsi,
    imsi: imsi || undefined,
    rsrp: finite(first(raw, 'rsrp', 'RSRP')),
    rsrq: finite(first(raw, 'rsrq', 'RSRQ')),
    rssi: finite(first(raw, 'rssi', 'RSSI')),
    sinr: finite(first(raw, 'sinr', 'SINR', 'ulSinr', 'ul_sinr')),
    snr: finite(first(raw, 'snr', 'SNR')),
    dlMcs: finite(first(raw, 'dlMcs', 'dl_mcs', 'DL_MCS')),
    ulMcs: finite(first(raw, 'ulMcs', 'ul_mcs', 'UL_MCS')),
    bler: finite(first(raw, 'bler', 'BLER', 'ulBler', 'ul_bler')),
    dlMbps: finite(first(raw, 'dlMbps', 'dl_mbps', 'dlThroughput', 'dl_throughput')),
    ulMbps: finite(first(raw, 'ulMbps', 'ul_mbps', 'ulThroughput', 'ul_throughput')),
    txPower: finite(first(raw, 'txPower', 'tx_power', 'TX_POWER')),
    pathLoss: finite(first(raw, 'pathLoss', 'path_loss', 'PATH_LOSS')),
    primaryDlCqi: finite(first(raw, 'primaryDlCqi', 'primary_dl_cqi', 'dlCqi', 'DL_CQI')),
    secondaryDlCqi: finite(first(raw, 'secondaryDlCqi', 'secondary_dl_cqi')),
    sampledAt: finite(first(raw, 'sampledAt', 'sampled_at', 'timestamp')),
  };
}

function extractUes(payload: any): NormalizedSignal[] {
  const candidates = Array.isArray(payload)
    ? payload
    : first(payload ?? {}, 'ues', 'devices', 'data', 'results', 'items');
  const list = Array.isArray(candidates)
    ? candidates
    : Array.isArray(candidates?.ues)
      ? candidates.ues
      : [];
  return list.map((item: any) => normalizeUe(item ?? {})).filter(Boolean) as NormalizedSignal[];
}

function requestRadio(radio: RadioRow, path: string, form?: URLSearchParams, cookie?: string): Promise<{ body: string; status: number; location?: string }> {
  const url = new URL(path, radio.base_url.endsWith('/') ? radio.base_url : `${radio.base_url}/`);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: form ? 'POST' : 'GET',
      headers: {
        Accept: '*/*',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(url.protocol === 'https:' ? { rejectUnauthorized: !radio.allow_self_signed } : {}),
      timeout: 8000,
    } as https.RequestOptions, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        resolve({ body, status: response.statusCode ?? 500, location: response.headers.location });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Radio request timed out')));
    req.on('error', reject);
    req.end(form?.toString());
  });
}

function parseBaicellsUes(text: string): NormalizedSignal[] {
  const results: NormalizedSignal[] = [];
  for (const match of text.matchAll(/LTE_UE_SPEED_STATISTICS:="([^"]*)"/g)) {
    if (!match[1] || match[1] === 'NULL') continue;
    for (const entry of match[1].split(';').filter(Boolean)) {
      const parsed = entry.match(/^([^[]+)\[([^\]]*)\]$/);
      if (!parsed) continue;
      const fields = parsed[2].split(':');
      const imsi = /^\d{14,16}$/.test(fields[0] ?? '') ? fields[0] : undefined;
      results.push({
        ueId: parsed[1].trim(), imsi,
        dlMbps: finite(fields[2]), ulMbps: finite(fields[3]),
        sinr: finite(fields[6]), ulMcs: finite(fields[9]), dlMcs: finite(fields[10]),
        primaryDlCqi: finite(fields[7]), secondaryDlCqi: finite(fields[8]),
        txPower: finite(fields[12]), bler: finite(fields[13]), pathLoss: finite(fields[18]), sampledAt: Date.now(),
      });
    }
  }
  return results;
}

async function fetchBaicells(radio: RadioRow): Promise<NormalizedSignal[]> {
  const password = decryptPassword(radio);
  if (!password) throw new Error('Radio credentials are incomplete');
  const login = await requestRadio(radio, '/utility/get_password_cookie.sh', new URLSearchParams({
    username: radio.username, password, loginMode: '',
  }));
  if (login.status >= 400) throw new Error(`Baicells login HTTP ${login.status}`);
  // This Baicells UI returns its cookies inside the response body rather than
  // as normal HTTP Set-Cookie headers.
  const cookies = [...login.body.matchAll(/Set-Cookie:([^=;]+)=([^;]+)/g)]
    .map(match => `${match[1]}=${match[2]}`).join('; ');
  if (!cookies) throw new Error('Baicells login was rejected');
  const metrics = await requestRadio(radio, '/utility/get_UE_infos.sh', new URLSearchParams(), cookies);
  if (metrics.status >= 300 || metrics.location?.includes('expired=1')) throw new Error('Baicells session expired');
  return parseBaicellsUes(metrics.body);
}

async function fetchGeneric(radio: RadioRow): Promise<NormalizedSignal[]> {
  const password = decryptPassword(radio);
  if (!password) throw new Error('Radio credentials are incomplete');
  const url = new URL(radio.metrics_path, radio.base_url.endsWith('/') ? radio.base_url : `${radio.base_url}/`);
  const client = url.protocol === 'https:' ? https : http;
  const payload = await new Promise<any>((resolve, reject) => {
    const req = client.request(url, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${radio.username}:${password}`).toString('base64')}` },
      ...(url.protocol === 'https:' ? { rejectUnauthorized: !radio.allow_self_signed } : {}), timeout: 8000,
    } as https.RequestOptions, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Radio endpoint did not return JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('Radio request timed out'))); req.on('error', reject); req.end();
  });
  return extractUes(payload);
}

function credentialKey(): Buffer {
  const secret = process.env.RADIO_CREDENTIALS_KEY;
  if (!secret) throw new Error('RADIO_CREDENTIALS_KEY is not configured on the NMS server');
  return createHash('sha256').update(secret).digest();
}

function encryptPassword(password: string): { cipher: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return { cipher: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptPassword(radio: RadioRow): string {
  if (radio.password_cipher && radio.password_iv && radio.password_tag) {
    const decipher = createDecipheriv('aes-256-gcm', credentialKey(), Buffer.from(radio.password_iv, 'base64'));
    decipher.setAuthTag(Buffer.from(radio.password_tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(radio.password_cipher, 'base64')), decipher.final()]).toString('utf8');
  }
  return radio.password_env ? process.env[radio.password_env] ?? '' : '';
}

export function createRadioSignalRouter(
  db: Database,
  subscriberRepo: ISubscriberRepository,
  activeSessions: ActiveSessionsUseCase,
  logger: pino.Logger,
): Router {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_radios (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, vendor TEXT NOT NULL,
      base_url TEXT NOT NULL, username TEXT NOT NULL, password_env TEXT NOT NULL,
      metrics_path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      allow_self_signed INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, radio_id TEXT NOT NULL, ue_id TEXT NOT NULL,
      imsi TEXT, sampled_at INTEGER NOT NULL, rsrp REAL, rsrq REAL, rssi REAL,
      sinr REAL, snr REAL, dl_mcs REAL, ul_mcs REAL, bler REAL, dl_mbps REAL, ul_mbps REAL
    );
    CREATE INDEX IF NOT EXISTS idx_signal_samples_radio_ue_time
      ON signal_samples(radio_id, ue_id, sampled_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_radios_base_url ON signal_radios(base_url);
  `);
  const radioColumns = new Set((db.prepare('PRAGMA table_info(signal_radios)').all() as Array<{ name: string }>).map(c => c.name));
  for (const column of ['password_cipher', 'password_iv', 'password_tag']) {
    if (!radioColumns.has(column)) db.exec(`ALTER TABLE signal_radios ADD COLUMN ${column} TEXT`);
  }
  const sampleColumns = new Set((db.prepare('PRAGMA table_info(signal_samples)').all() as Array<{ name: string }>).map(c => c.name));
  for (const column of ['tx_power', 'path_loss', 'primary_dl_cqi', 'secondary_dl_cqi']) {
    if (!sampleColumns.has(column)) db.exec(`ALTER TABLE signal_samples ADD COLUMN ${column} REAL`);
  }

  const router = Router();
  const publicRadio = (row: RadioRow) => ({
    id: row.id, name: row.name, vendor: row.vendor, baseUrl: row.base_url,
    username: row.username, passwordConfigured: !!(row.password_cipher || row.password_env), metricsPath: row.metrics_path,
    enabled: !!row.enabled, allowSelfSigned: !!row.allow_self_signed,
  });

  router.get('/radios', (_req, res) => {
    const rows = db.prepare('SELECT * FROM signal_radios ORDER BY name').all() as RadioRow[];
    res.json({ radios: rows.map(publicRadio) });
  });

  router.post('/radios', requireAdmin, (req: Request, res: Response) => {
    const body = req.body ?? {};
    const id = String(body.id || randomUUID());
    const name = String(body.name || '').trim();
    const baseUrl = String(body.baseUrl || '').trim();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const metricsPath = String(body.metricsPath || '/api/ue/signals').trim();
    const existing = db.prepare('SELECT * FROM signal_radios WHERE id = ?').get(id) as RadioRow | undefined;
    if (!name || !baseUrl || !username || (!password && !existing?.password_cipher && !existing?.password_env)) {
      res.status(400).json({ error: 'Name, URL, username and password are required' });
      return;
    }
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { res.status(400).json({ error: 'Invalid radio URL' }); return; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { res.status(400).json({ error: 'Radio URL must use HTTP or HTTPS' }); return; }
    const encrypted = password ? encryptPassword(password) : null;
    db.prepare(`INSERT INTO signal_radios
      (id,name,vendor,base_url,username,password_env,password_cipher,password_iv,password_tag,metrics_path,enabled,allow_self_signed,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,vendor=excluded.vendor,base_url=excluded.base_url,
      username=excluded.username,
      password_cipher=COALESCE(excluded.password_cipher,signal_radios.password_cipher),
      password_iv=COALESCE(excluded.password_iv,signal_radios.password_iv),
      password_tag=COALESCE(excluded.password_tag,signal_radios.password_tag),metrics_path=excluded.metrics_path,
      enabled=excluded.enabled,allow_self_signed=excluded.allow_self_signed,updated_at=excluded.updated_at`)
      .run(id, name, body.vendor === 'generic' ? 'generic' : 'baicells', parsed.toString(), username,
        '', encrypted?.cipher ?? null, encrypted?.iv ?? null, encrypted?.tag ?? null, metricsPath,
        body.enabled === false ? 0 : 1, body.allowSelfSigned === false ? 0 : 1, Date.now());
    res.json({ success: true, id });
  });

  router.post('/discover', requireAdmin, async (_req, res) => {
    const [active, connectedRadios] = await Promise.all([
      activeSessions.getActive4GUEs(),
      activeSessions.getConnected4GRadios(),
    ]);
    const byIp = new Map<string, string[]>();
    for (const ue of active) {
      if (!ue.radioIp) continue;
      const imsis = byIp.get(ue.radioIp) ?? [];
      if (ue.imsi) imsis.push(ue.imsi);
      byIp.set(ue.radioIp, imsis);
    }
    const insert = db.prepare(`INSERT INTO signal_radios
      (id,name,vendor,base_url,username,password_env,metrics_path,enabled,allow_self_signed,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(base_url) DO NOTHING`);
    const radioIps = new Set([...connectedRadios.filter(r => r.connected).map(r => r.ip), ...byIp.keys()]);
    const discovered: Array<{ ip: string; enbId?: number; radioId: string; imsis: string[]; added: boolean }> = [];
    for (const ip of radioIps) {
      const imsis = byIp.get(ip) ?? [];
      const baseUrl = `https://${ip}/`;
      let existing = db.prepare('SELECT id FROM signal_radios WHERE base_url = ?').get(baseUrl) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      if (!existing) insert.run(id, `eNodeB ${ip}`, 'baicells', baseUrl, '', '', '/api/ue/signals', 0, 1, Date.now());
      discovered.push({ ip, enbId: connectedRadios.find(r => r.ip === ip)?.enbId, radioId: id, imsis, added: !existing });
    }
    res.json({ discovered });
  });

  router.delete('/radios/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM signal_radios WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM signal_samples WHERE radio_id = ?').run(req.params.id);
    res.json({ success: true });
  });

  router.post('/ingest/:radioId', requireAdmin, (req, res) => {
    const radio = db.prepare('SELECT * FROM signal_radios WHERE id = ?').get(req.params.radioId) as RadioRow | undefined;
    if (!radio) { res.status(404).json({ error: 'Radio not found' }); return; }
    const ues = extractUes(req.body);
    const insert = db.prepare(`INSERT INTO signal_samples
      (radio_id,ue_id,imsi,sampled_at,rsrp,rsrq,rssi,sinr,snr,dl_mcs,ul_mcs,bler,dl_mbps,ul_mbps,tx_power,path_loss,primary_dl_cqi,secondary_dl_cqi)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction((items: NormalizedSignal[]) => items.forEach(ue => insert.run(
      radio.id, ue.ueId, ue.imsi ?? null, ue.sampledAt ?? Date.now(), ue.rsrp ?? null, ue.rsrq ?? null,
      ue.rssi ?? null, ue.sinr ?? ue.snr ?? null, ue.snr ?? null, ue.dlMcs ?? null, ue.ulMcs ?? null,
      ue.bler ?? null, ue.dlMbps ?? null, ue.ulMbps ?? null, ue.txPower ?? null, ue.pathLoss ?? null,
      ue.primaryDlCqi ?? null, ue.secondaryDlCqi ?? null,
    )));
    tx(ues);
    res.json({ success: true, ingested: ues.length });
  });

  router.post('/poll', requireAdmin, async (_req, res) => {
    const radios = db.prepare('SELECT * FROM signal_radios WHERE enabled = 1').all() as RadioRow[];
    const activeByIp = new Map<string, string[]>();
    for (const ue of await activeSessions.getActive4GUEs()) {
      if (!ue.radioIp || !ue.imsi || !isIP(ue.ip)) continue;
      activeByIp.set(ue.radioIp, [...(activeByIp.get(ue.radioIp) ?? []), ue.imsi]);
    }
    const results = await Promise.all(radios.map(async radio => {
      try {
        const ues = radio.vendor === 'baicells' ? await fetchBaicells(radio) : await fetchGeneric(radio);
        const coreImsis = [...new Set(activeByIp.get(new URL(radio.base_url).hostname) ?? [])];
        if (ues.length === coreImsis.length) ues.forEach((ue, index) => { ue.imsi ||= coreImsis[index]; });
        const insert = db.prepare(`INSERT INTO signal_samples
          (radio_id,ue_id,imsi,sampled_at,rsrp,rsrq,rssi,sinr,snr,dl_mcs,ul_mcs,bler,dl_mbps,ul_mbps,tx_power,path_loss,primary_dl_cqi,secondary_dl_cqi)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const tx = db.transaction(() => ues.forEach(ue => insert.run(
          radio.id, ue.ueId, ue.imsi ?? null, ue.sampledAt ?? Date.now(), ue.rsrp ?? null, ue.rsrq ?? null,
          ue.rssi ?? null, ue.sinr ?? ue.snr ?? null, ue.snr ?? null, ue.dlMcs ?? null, ue.ulMcs ?? null,
          ue.bler ?? null, ue.dlMbps ?? null, ue.ulMbps ?? null, ue.txPower ?? null, ue.pathLoss ?? null,
          ue.primaryDlCqi ?? null, ue.secondaryDlCqi ?? null,
        )));
        tx();
        return { radioId: radio.id, success: true, count: ues.length };
      } catch (err) {
        logger.warn({ radioId: radio.id, err: String(err) }, 'Radio signal poll failed');
        return { radioId: radio.id, success: false, error: String(err) };
      }
    }));
    db.prepare('DELETE FROM signal_samples WHERE sampled_at < ?').run(Date.now() - 7 * 24 * 60 * 60 * 1000);
    res.json({ results });
  });

  router.post('/wake', requireAdmin, async (req, res) => {
    const radioId = String(req.body?.radioId || '');
    const imsi = String(req.body?.imsi || '').replace(/\D/g, '');
    const radio = db.prepare('SELECT * FROM signal_radios WHERE id = ?').get(radioId) as RadioRow | undefined;
    if (!radio) { res.status(404).json({ error: 'Radio not found' }); return; }
    const radioIp = new URL(radio.base_url).hostname;
    const sessions = (await activeSessions.getActive4GUEs()).filter(ue =>
      ue.radioIp === radioIp && (!imsi || ue.imsi === imsi) && isIP(ue.ip),
    );
    if (!sessions.length) {
      res.status(409).json({ error: 'No active core bearer/IP is available for this UE. It remains visible using radio measurements.' });
      return;
    }
    const payload = Buffer.from('open5gs-nms-wakeup');
    const ports = [9, 33434, 50000];
    await Promise.all(sessions.flatMap(ue => ports.map(port => new Promise<void>((resolve, reject) => {
      const socket = createSocket(isIP(ue.ip) === 6 ? 'udp6' : 'udp4');
      socket.send(payload, port, ue.ip, err => { socket.close(); err ? reject(err) : resolve(); });
    }))));
    logger.info({ radioId, imsi: imsi || undefined, targets: sessions.length }, 'UE downlink wake packets sent');
    res.json({ success: true, targets: sessions.length, packets: sessions.length * ports.length });
  });

  router.get('/overview', async (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const since = Date.now() - Math.min(Math.max(Number(req.query.hours) || 24, 1), 168) * 3600000;
    const radios = db.prepare('SELECT * FROM signal_radios ORDER BY name').all() as RadioRow[];
    const samples = db.prepare('SELECT * FROM signal_samples WHERE sampled_at >= ? ORDER BY sampled_at ASC').all(since) as any[];
    const subscribers = await subscriberRepo.findAllFull();
    const subscriberByImsi = new Map(subscribers.map(s => [s.imsi, s]));
    const latestByKey = new Map<string, any>();
    for (const sample of samples) latestByKey.set(`${sample.radio_id}:${sample.ue_id}`, sample);
    const historyByKey = new Map<string, any[]>();
    for (const sample of samples) {
      const key = `${sample.radio_id}:${sample.ue_id}`;
      const list = historyByKey.get(key) ?? [];
      list.push({ sampledAt: sample.sampled_at, rsrp: sample.rsrp, rsrq: sample.rsrq, rssi: sample.rssi, sinr: sample.sinr, bler: sample.bler });
      historyByKey.set(key, list);
    }
    const radioById = new Map(radios.map(r => [r.id, r]));
    const ues = [...latestByKey.entries()].map(([key, sample]) => {
      const sub = sample.imsi ? subscriberByImsi.get(sample.imsi) : undefined;
      const radio = radioById.get(sample.radio_id);
      return {
        radioId: sample.radio_id, radioName: radio?.name ?? sample.radio_id, vendor: radio?.vendor ?? 'generic',
        ueId: sample.ue_id, imsi: sample.imsi, iccid: sub?.iccid, msisdn: sub?.msisdn?.[0], nickname: sub?.nickname,
        sampledAt: sample.sampled_at, rsrp: sample.rsrp, rsrq: sample.rsrq, rssi: sample.rssi,
        sinr: sample.sinr, snr: sample.snr, dlMcs: sample.dl_mcs, ulMcs: sample.ul_mcs,
        bler: sample.bler, dlMbps: sample.dl_mbps, ulMbps: sample.ul_mbps,
        txPower: sample.tx_power, pathLoss: sample.path_loss, primaryDlCqi: sample.primary_dl_cqi,
        secondaryDlCqi: sample.secondary_dl_cqi, history: historyByKey.get(key) ?? [],
      };
    }).filter(ue => !search || [ue.ueId, ue.imsi, ue.iccid, ue.msisdn, ue.nickname, ue.radioName]
      .some(value => String(value ?? '').toLowerCase().includes(search)));
    res.json({ radios: radios.map(publicRadio), ues });
  });

  return router;
}
