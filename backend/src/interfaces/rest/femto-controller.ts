import { Router, Request, Response } from 'express';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';

const execFileAsync = promisify(execFile);
const FEMTO_SCRIPT = path.join(__dirname, '../../../tools/femto_provision.py');

// ── Probe helper — uses Python requests (handles old Sercomm TLS correctly) ──

async function pythonRun(code: string, timeout = 10000): Promise<string> {
  const result = await execFileAsync('python3', ['-c', code], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    timeout,
  });
  return result.stdout.trim();
}

export function createFemtoRouter(logger: pino.Logger): Router {
  const router = Router();

  // GET /api/femto/probe?ip=x.x.x.x
  // 1. Check WebUI reachability using Python requests (handles old TLS)
  // 2. Auto-fetch MAC via sc_femto SSH and derive WebUI password
  // 3. Login and pull current config from devComState.htm
  router.get('/probe', async (req: Request, res: Response) => {
    const { ip, webuiUser = 'debug', webuiPass } = req.query as Record<string, string>;
    if (!ip) return res.status(400).json({ success: false, error: 'ip required' });

    try {
      // Step 1 — check WebUI using Python (Node TLS rejects old Sercomm certs)
      const probeOut = await pythonRun([
        'import requests, urllib3, json',
        'urllib3.disable_warnings()',
        `ip="${ip}"`,
        'try:',
        '    r=requests.get(f"https://{ip}/logon.htm",timeout=5,verify=False)',
        '    up=r.status_code==200 and "SmallCell" in r.text',
        'except:',
        '    up=False',
        'print(json.dumps({"up":up}))',
      ].join('\n'), 8000);

      const { up } = JSON.parse(probeOut);
      if (!up) return res.json({ success: true, webui: false });

      // Step 2 — derive password from MAC (unless user provided one)
      let resolvedPass = webuiPass || null;
      let mac: string | null = null;

      if (!resolvedPass) {
        try {
          const macOut = await execFileAsync('python3', [
            '-u', FEMTO_SCRIPT, '--ip', ip, '--get-mac', '--mac-only',
          ], { env: { ...process.env, PYTHONUNBUFFERED: '1' }, timeout: 15000 });

          const m = macOut.stdout.match(/MAC:\s*([0-9A-Fa-f:]{17})/);
          if (m) {
            mac = m[1];
            const deriveOut = await pythonRun(
              `import sys; sys.path.insert(0,'${path.dirname(FEMTO_SCRIPT)}'); ` +
              `import femto_provision as fp; _,dbg=fp.derive_credentials('${mac}'); print(dbg)`,
              5000,
            );
            resolvedPass = deriveOut.trim();
          }
        } catch (e) {
          logger.warn({ ip, err: String(e) }, 'Could not get MAC for probe');
        }
      }

      if (!resolvedPass) {
        return res.json({
          success: true, webui: true, config: null,
          message: 'WebUI is enabled but could not derive credentials automatically — enter WebUI password manually.',
        });
      }

      // Step 3 — login + pull devComState.htm using Python
      const scriptDir = path.dirname(FEMTO_SCRIPT);
      const pullOut = await pythonRun([
        `import sys; sys.path.insert(0,'${scriptDir}')`,
        'import requests, urllib3, base64, re, json',
        'urllib3.disable_warnings()',
        `ip="${ip}"`,
        `user="${webuiUser}"`,
        `pwd="${resolvedPass}"`,
        's=requests.Session()',
        's.headers["User-Agent"]="Mozilla/5.0"',
        'un=base64.b64encode(user.encode()).decode()',
        'pw=base64.b64encode(pwd.encode()).decode()',
        'r=s.post(f"https://{ip}/status.htm",verify=False,allow_redirects=True,',
        '    data={"un":un,"pw":pw,"login_name":"","login_pwd":"",',
        '    "todo":"login","this_file":"logon.htm","next_file":"status.htm"})',
        'if "logon" in r.url.lower():',
        '    print(json.dumps({"ok":False,"error":"login failed"})); sys.exit()',
        'h=s.get(f"https://{ip}/devComState.htm",verify=False).text',
        'def ex(name):',
        '    m=re.search(rf\'name=["\\\']{name}["\\\'][^>]*value=["\\\'](.*?)["\\\']\',h)',
        '    if m: return m.group(1)',
        '    m=re.search(rf\'value=["\\\'](.*?)["\\\']\s[^>]*name=["\\\']{name}["\\\'] \',h)',
        '    return m.group(1) if m else ""',
        'def chk(name):',
        '    m=re.search(rf\'name=["\\\']{name}["\\\'][^>]*\',h)',
        '    return bool(m and re.search(r"checked",m.group(0),re.I))',
        'cfg={',
        '    "carrier_number":ex("cell_number") or "2",',
        '    "bandwidth":ex("bandwidth") or "20",',
        '    "freq_band":ex("freqband"),',
        '    "earfcn":ex("rf_earfcnul"),',
        '    "cell_identity":ex("cellidentity"),',
        '    "pci":ex("phycellid"),',
        '    "tx_power":ex("txpower"),',
        '    "sync_source":ex("sync_source") or "FREE_RUNNING",',
        '    "tunnel_type":ex("tunnel_type") or "IPv4",',
        '    "mme_ip":ex("mme_ip_addr"),',
        '    "plmn_id":ex("plmn_id"),',
        '    "tac":ex("enodeb_tac"),',
        '    "admin_state":chk("FAPService_FAPControl_LTE_AdminState"),',
        '    "carrier_aggregation":chk("enable_ca"),',
        '    "contiguous_cc":chk("contiguous_cc"),',
        '    "auto_internal_neighbors":chk("auto_internal_neighbors"),',
        '}',
        'print(json.dumps({"ok":True,"config":cfg}))',
      ].join('\n'), 15000);


      const pullData = JSON.parse(pullOut);

      if (!pullData.ok) {
        return res.json({
          success: true, webui: true, config: null,
          mac: mac || undefined,
          message: 'WebUI login failed — credentials may have changed. Enter WebUI password manually.',
        });
      }

      return res.json({
        success: true, webui: true,
        config: pullData.config,
        mac: mac || undefined,
        message: `🟢 WebUI enabled${mac ? ` — MAC: ${mac}` : ''} — current config loaded`,
      });

    } catch (err) {
      logger.error({ ip, err: String(err) }, 'Femto probe failed');
      return res.json({ success: true, webui: false });
    }
  });

  // POST /api/femto/provision
  router.post('/provision', async (req: Request, res: Response) => {
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

      // Script exited 0 — all config pages saved successfully
      res.json({ success: true, output });
    } catch (err) {
      // Script exited non-zero — check which pages actually saved.
      // devComState and TR098 are always attempted.
      // sasConf is always attempted but its result only matters if it was expected to succeed.
      // A page is reported as OK in the results summary as: '[+] OK  <page>.htm'
      // A page failure looks like: '[-] FAILED  <page>.htm'
      const coreOk = output.includes('[+] OK  devComState.htm') &&
                     output.includes('[+] OK  TR098_MgntServer.htm');

      // sasConf: only required if SAS was enabled in the config
      const sasAttempted = output.includes('sasConf.htm');
      const sasOk = !sasAttempted || output.includes('[+] OK  sasConf.htm');

      // Also treat it as success if no FAILED lines appear and core steps ran
      const noFailures = !output.includes('[-] FAILED') && !output.includes('[-]');
      const allOk = coreOk && sasOk;
      const likelyOk = noFailures && output.includes('[+] OK  devComState.htm');

      const success = allOk || likelyOk;
      res.json({ success, output, error: success ? undefined : String(err) });
    }
  });

  return router;
}