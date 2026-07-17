import { Router, Request, Response } from 'express';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';
import { requireAdmin } from './middleware/auth-middleware';

const execFileAsync = promisify(execFile);
const FEMTO_SCRIPT = path.join(__dirname, '../../../tools/femto_provision.py');

export function createFemtoRouter(logger: pino.Logger): Router {
  const router = Router();

  // GET /api/femto/derive-credentials?mac=xx:xx:xx:xx:xx:xx
  // Returns root SSH password and debug WebUI password derived from MAC.
  // Security: MAC is validated then passed as CLI argv — never interpolated into code.
  router.get('/derive-credentials', requireAdmin, async (req: Request, res: Response) => {
    const { mac } = req.query as Record<string, string>;
    if (!mac) return res.status(400).json({ success: false, error: 'mac required' });

    // Strict MAC validation — xx:xx:xx:xx:xx:xx only
    if (!/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(mac)) {
      return res.status(400).json({ success: false, error: 'Invalid MAC address format' });
    }

    try {
      const result = await execFileAsync(
        'python3', ['-u', FEMTO_SCRIPT, '--ip', '0.0.0.0', '--derive-credentials', mac],
        { env: { ...process.env, PYTHONUNBUFFERED: '1' }, timeout: 5000 },
      );
      const creds = JSON.parse(result.stdout.trim());
      res.json({ success: true, ...creds });
    } catch (err) {
      logger.error({ mac, err: String(err) }, 'Credential derivation failed');
      res.status(500).json({ success: false, error: 'Could not derive credentials' });
    }
  });

  // GET /api/femto/probe?ip=x.x.x.x[&webuiUser=debug][&webuiPass=xxx]
  // 1. Check WebUI reachability
  // 2. Auto-fetch MAC and derive WebUI password
  // 3. Login and pull current config from devComState.htm
  // Security: ip, webuiUser, webuiPass are validated/passed as CLI argv — never interpolated.
  router.get('/probe', requireAdmin, async (req: Request, res: Response) => {
    const { ip, webuiUser = 'debug', webuiPass } = req.query as Record<string, string>;
    if (!ip) return res.status(400).json({ success: false, error: 'ip required' });

    // Strict IPv4 validation
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return res.status(400).json({ success: false, error: 'Invalid IP address format' });
    }
    // Alphanumeric + underscore only for username
    if (webuiUser && !/^[a-zA-Z0-9_]{1,32}$/.test(webuiUser)) {
      return res.status(400).json({ success: false, error: 'Invalid webuiUser format' });
    }

    try {
      // All probe logic lives in femto_provision.py --probe
      // ip, webuiUser, webuiPass passed as argv — never concatenated into code strings
      const probeArgs = ['-u', FEMTO_SCRIPT, '--probe', ip, '--webui-user', webuiUser];
      if (webuiPass) probeArgs.push('--webui-pass', webuiPass);

      const probeResult = await execFileAsync(
        'python3', probeArgs,
        { env: { ...process.env, PYTHONUNBUFFERED: '1' }, timeout: 20000 },
      );

      const data = JSON.parse(probeResult.stdout.trim());

      // Normalise to the shape the frontend expects
      if (!data.up) {
        return res.json({ success: true, webui: false });
      }

      if (!data.credentials_available) {
        return res.json({
          success: true, webui: true, config: null,
          mac: data.mac || undefined,
          message: 'WebUI is enabled but could not derive credentials automatically — enter WebUI password manually.',
        });
      }

      if (!data.login_ok) {
        return res.json({
          success: true, webui: true, config: null,
          mac: data.mac || undefined,
          message: 'WebUI login failed — credentials may have changed. Enter WebUI password manually.',
        });
      }

      return res.json({
        success: true, webui: true,
        config: data.config ?? null,
        mac: data.mac || undefined,
        message: `🟢 WebUI enabled${data.mac ? ` — MAC: ${data.mac}` : ''} — current config loaded`,
      });

    } catch (err) {
      logger.error({ ip, err: String(err) }, 'Femto probe failed');
      return res.json({ success: true, webui: false });
    }
  });

  // POST /api/femto/provision
  // All args passed via argv to femto_provision.py — safe against injection.
  router.post('/provision', requireAdmin, async (req: Request, res: Response) => {
    const { ip, mac, rootPass, webuiUser, webuiPass, dryRun, config } = req.body;

    if (!ip) return res.status(400).json({ success: false, error: 'ip is required' });
    if (!fs.existsSync(FEMTO_SCRIPT)) {
      return res.status(500).json({ success: false, error: `femto_provision.py not found at ${FEMTO_SCRIPT}` });
    }

    const args: string[] = ['--ip', ip];
    if (mac)       args.push('--mac',         mac);
    else           args.push('--get-mac');
    if (rootPass)  args.push('--root-pass',   rootPass);
    if (webuiUser) args.push('--webui-user',  webuiUser);
    if (webuiPass) args.push('--webui-pass',  webuiPass);
    if (config)    args.push('--config-json', JSON.stringify(config));
    if (dryRun)    args.push('--dry-run');

    logger.info({ ip, mac, dryRun }, 'Running femto provisioning');

    let output = '';

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('python3', ['-u', FEMTO_SCRIPT, ...args], {
          timeout: dryRun ? 30000 : 600000,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
        proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
        req.on('close', () => proc.kill());
      });

      res.json({ success: true, output });
    } catch (err) {
      const coreOk = output.includes('[+] OK  devComState.htm') &&
                     output.includes('[+] OK  TR098_MgntServer.htm');
      const sasAttempted = output.includes('sasConf.htm');
      const sasOk = !sasAttempted || output.includes('[+] OK  sasConf.htm');
      const noFailures = !output.includes('[-] FAILED') && !output.includes('[-]');
      const allOk = coreOk && sasOk;
      const likelyOk = noFailures && output.includes('[+] OK  devComState.htm');
      const success = allOk || likelyOk;
      res.json({ success, output, error: success ? undefined : String(err) });
    }
  });

  return router;
}
