import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { requireAdmin } from './middleware/auth-middleware';
import { detectMainInterface, listHostInterfaces } from '../../infrastructure/network/main-interface';
import { suggestFreeIps } from '../../domain/services/ip-suggest';
import { deriveCurrentAutoConfigInput } from '../../application/use-cases/auto-config';
import { IpPlanApplyUseCase } from '../../application/use-cases/ip-plan-apply-usecase';
import { getSecgwStaleness } from './secgw-controller';
import { getVowifiStaleness } from './vowifi-controller';
import { readPstnState, getPstnStaleness } from './pstn-controller';
import { loadGsmState, getGsmStaleness } from './gsm-controller';
import { readCurrentImsConfig, getImsStaleness } from './ims-controller';
import { readMmsState, getMmsStaleness } from './mms-controller';

// Central "plan every static IP the system could need, up front" registry —
// built 2026-09-19, redesigned 2026-09-20 after the first version turned out
// to have the wrong shape (an ambient sync that silently pre-filled AND
// silently wrote back on every page visit — the user corrected this to a
// genuinely explicit "Propose IP Plan" -> review -> "Apply Plan" flow, never
// touching a module's real config except on that explicit Apply action).
// Owns this one concern only (BIND9-style ownership, CLAUDE.md pattern
// #4/#16 — one module owns the data, exports named accessors, never a
// generic shared-settings blob).
//
// Two distinct concepts, where a naive reading might conflate them:
//  - "current": live reality, read FRESH from each module's own state on
//    every GET / and every POST /propose — never from the small registry
//    file below. A module never configured reports current: null.
//  - "planned": the small registry file — now ONLY ever written by
//    POST /apply (via setPlannedIp, still the same accessor other modules'
//    own blank-field pre-fill reads through — see getPlannedIp below). A
//    module's own independent Configure success no longer writes here.
const STATE_DIR = '/proc/1/root/etc/open5gs-nms';
const STATE_PATH = `${STATE_DIR}/ip-plan-state.json`;

export type IpPlanCategory = 'core' | 'module';

export interface IpPlanCatalogEntry {
  service: string;
  label: string;
  category: IpPlanCategory;
  note?: string;
  // SEPP's 3 fields and bind-dns never live-apply (see header) — the
  // frontend disables their Apply-Plan checkbox and points at that module's
  // own page instead.
  liveApplyCapable: boolean;
}

const CATALOG: IpPlanCatalogEntry[] = [
  { service: 'mme-s1mme', label: 'MME S1-MME IP (S1AP)', category: 'core', note: 'eNodeBs dial this to attach', liveApplyCapable: true },
  { service: 'sgwc', label: 'SGW-C IP', category: 'core', note: 'Control-plane peer for the MME/SGW-U/SMF chain', liveApplyCapable: true },
  { service: 'sgwu-s1u', label: 'SGW-U S1-U IP (GTP-U)', category: 'core', note: 'eNodeBs send user-plane data here', liveApplyCapable: true },
  { service: 'amf-ngap', label: 'AMF NGAP IP', category: 'core', note: 'gNodeBs dial this to attach', liveApplyCapable: true },
  { service: 'upf-n3', label: 'UPF N3 IP (GTP-U)', category: 'core', note: 'gNodeBs send user-plane data here', liveApplyCapable: true },
  { service: 'smf-pfcp', label: 'SMF PFCP Address', category: 'core', note: 'Only needed if not using "Local UPF Only"', liveApplyCapable: true },
  { service: 'local-upf-pfcp', label: 'Local UPF PFCP Address', category: 'core', note: 'Only needed if not using "Local UPF Only"', liveApplyCapable: true },
  { service: 'secgw-gateway', label: 'SecGW Gateway IP', category: 'module', note: 'Radios establish IPsec tunnels here', liveApplyCapable: true },
  { service: 'vowifi-epdg', label: 'VoWiFi ePDG IP', category: 'module', note: 'UEs on Wi-Fi dial this to attach', liveApplyCapable: true },
  { service: 'pstn-external-trunk', label: 'PSTN External SIP Trunk Bind IP', category: 'module', note: 'Real SIP provider connects here', liveApplyCapable: true },
  { service: 'gsm-bsc-mgw', label: '2G BSC/MGW Bind IP', category: 'module', note: 'Pushed into real nanoBTS hardware as its OML target — a real BTS can never reach a loopback default here', liveApplyCapable: true },
  { service: 'gsm-sgsn-gb', label: '2G SGSN Gb Address (PCU)', category: 'module', note: 'A real nanoBTS PCU dials this for GPRS/EDGE — has an auto-derive fallback if left blank', liveApplyCapable: true },
  { service: 'ims-pcscf', label: 'IMS P-CSCF IP', category: 'module', note: 'UEs dial this first for VoLTE signaling', liveApplyCapable: true },
  { service: 'ims-rtpengine', label: 'IMS RTPengine IP (media relay)', category: 'module', note: 'Real VoLTE audio relay — conventionally the same address as P-CSCF', liveApplyCapable: true },
  { service: 'mms-mm1', label: 'MMS MM1 Public IP', category: 'module', note: 'Informational only (embedded in a URL) — conventionally the same address as P-CSCF, real UEs already reach it', liveApplyCapable: true },
  { service: 'bind-dns', label: 'BIND/DNS Server IP', category: 'module', note: 'IMS realm DNS (SRV/NAPTR records) — plan only, apply from the DNS (BIND9) page itself', liveApplyCapable: false },
  { service: 'sepp-sbi', label: 'SEPP SBI Address', category: 'module', note: 'Only needed for real N32 roaming — plan only, apply from the SEPP editor (restarts all 17 core NFs otherwise)', liveApplyCapable: false },
  { service: 'sepp-n32c', label: 'SEPP N32-c Address', category: 'module', note: 'Only needed for real N32 roaming — plan only, apply from the SEPP editor', liveApplyCapable: false },
  { service: 'sepp-n32f', label: 'SEPP N32-f Address', category: 'module', note: 'Only needed for real N32 roaming — plan only, apply from the SEPP editor', liveApplyCapable: false },
];

type SavedPlan = Record<string, string>; // service -> ip

function loadSaved(): SavedPlan {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveSaved(plan: SavedPlan): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(plan, null, 2), 'utf-8');
}

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Named accessor other controllers import directly (BIND9-pattern) — e.g. a
// module's own page can still pre-fill a blank field from whatever was last
// planned. Only ever WRITTEN by POST /apply now (via the use-case below),
// never by a module's own independent Configure success.
export function getPlannedIp(service: string): string | null {
  return loadSaved()[service] ?? null;
}

export function setPlannedIp(service: string, ip: string): void {
  if (!IP_RE.test(ip)) return;
  const plan = loadSaved();
  plan[service] = ip;
  saveSaved(plan);
}

// A conservative "is this a real, deliberately-set address" check for the 7
// core-17 fields and SEPP's 3, which have no configured/hasSavedConfig flag
// of their own (core-17 NFs are always "installed"; SEPP always ships with
// its own loopback defaults) — see CATEGORY B in the design notes. Every
// other module below has its own actual configured flag and doesn't need
// this heuristic at all.
function isRealAddress(v: string | undefined | null): string | null {
  return v && !v.startsWith('127.') ? v : null;
}

const SEPP_DEFAULT_SBI = '127.0.1.250';
const SEPP_DEFAULT_N32C = '127.0.1.251';
const SEPP_DEFAULT_N32F = '127.0.1.252';

interface CurrentValues {
  values: Record<string, string | null>;
  // Only meaningful for smf-pfcp/local-upf-pfcp/sgwc — /propose uses these to
  // decide whether applying one of those 3 would be a silent no-op.
  localUpfOnly: boolean;
  localSgwuOnly: boolean;
}

async function readCurrentValues(configRepo: IConfigRepository): Promise<CurrentValues> {
  const values: Record<string, string | null> = {};

  const secgwStaleness = getSecgwStaleness();
  values['secgw-gateway'] = (secgwStaleness.installedOnDisk && secgwStaleness.hasSavedConfig)
    ? (secgwStaleness.savedGatewayIp ?? null) : null;

  const vowifiStaleness = getVowifiStaleness();
  values['vowifi-epdg'] = (vowifiStaleness.installedOnDisk && vowifiStaleness.hasSavedConfig)
    ? (vowifiStaleness.savedEpdgIp ?? null) : null;

  const [pstnStaleness, gsmStaleness, imsStaleness, mmsStaleness] = await Promise.all([
    getPstnStaleness(), getGsmStaleness(), getImsStaleness(), getMmsStaleness(),
  ]);

  const pstnState = readPstnState();
  values['pstn-external-trunk'] = (pstnStaleness.installed && pstnState?.externalTrunk != null)
    ? pstnState.externalTrunk.bindIp : null;

  if (gsmStaleness.installedOnDisk && gsmStaleness.configured) {
    const gsmState = loadGsmState();
    values['gsm-bsc-mgw'] = gsmState.bscMgwBindIp || null;
    values['gsm-sgsn-gb'] = gsmState.sgsnGbRemoteIp || null;
  } else {
    values['gsm-bsc-mgw'] = null;
    values['gsm-sgsn-gb'] = null;
  }

  if (imsStaleness.installed && imsStaleness.hasSavedConfig) {
    const imsConfig = readCurrentImsConfig();
    values['ims-pcscf'] = imsConfig?.pcscfIp || null;
    values['ims-rtpengine'] = imsConfig?.rtpEngineIp || null;
  } else {
    values['ims-pcscf'] = null;
    values['ims-rtpengine'] = null;
  }

  values['mms-mm1'] = (mmsStaleness.installed && mmsStaleness.hasSavedConfig)
    ? (readMmsState()?.mm1PublicIp || null) : null;

  const configs = await configRepo.loadAll();

  const seppRaw = (configs.sepp1 as any)?.rawYaml?.sepp;
  const sbiAddr = seppRaw?.sbi?.server?.[0]?.address;
  const n32Addr = seppRaw?.n32?.server?.[0]?.address;
  const n32fAddr = seppRaw?.n32?.server?.[0]?.n32f?.address;
  const seppStillDefault = sbiAddr === SEPP_DEFAULT_SBI
    && (!n32Addr || n32Addr === SEPP_DEFAULT_N32C)
    && (!n32fAddr || n32fAddr === SEPP_DEFAULT_N32F);
  values['sepp-sbi'] = seppStillDefault ? null : (sbiAddr || null);
  values['sepp-n32c'] = seppStillDefault ? null : (n32Addr || null);
  values['sepp-n32f'] = seppStillDefault ? null : (n32fAddr || null);

  values['bind-dns'] = null; // no per-module fact to derive this from — plan-only, see catalog note

  const derived = deriveCurrentAutoConfigInput(configs);
  values['mme-s1mme'] = isRealAddress(derived.s1mmeIP);
  values['amf-ngap'] = isRealAddress(derived.amfNgapIP);
  values['sgwu-s1u'] = isRealAddress(derived.sgwuGtpIP);
  values['upf-n3'] = isRealAddress(derived.upfGtpIP);
  values['sgwc'] = isRealAddress(derived.sgwcPfcpIP);
  values['smf-pfcp'] = isRealAddress(derived.smfPfcpIP);
  values['local-upf-pfcp'] = isRealAddress(derived.localUpfPfcpIP);

  return { values, localUpfOnly: !!derived.localUpfOnly, localSgwuOnly: !!derived.localSgwuOnly };
}

export function createIpPlanRouter(
  logger: pino.Logger,
  auditLogger: IAuditLogger,
  configRepo: IConfigRepository,
  applyUseCase: IpPlanApplyUseCase,
): Router {
  const router = Router();

  // GET /api/ip-plan — every catalog entry with its live current value (read
  // fresh every call, never cached) plus whatever's in the small registry.
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const saved = loadSaved();
      const { values: current } = await readCurrentValues(configRepo);
      const entries = CATALOG.map(c => ({ ...c, current: current[c.service] ?? null, planned: saved[c.service] ?? null }));
      res.json({ success: true, entries });
    } catch (err) {
      logger.error({ err: String(err) }, 'ip-plan list error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // GET /api/ip-plan/suggest — subnet-box pre-fill only now; the actual
  // per-entry suggestion logic lives in POST /propose below.
  router.get('/suggest', async (_req: Request, res: Response) => {
    try {
      const main = await detectMainInterface();
      res.json({ success: true, mainInterface: main });
    } catch (err) {
      logger.error({ err: String(err) }, 'ip-plan suggest error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ip-plan/propose — body: { subnet: "x.x.x.x/yy" }. Preview
  // only, nothing persisted. For every entry: already-real current value ->
  // proposed = current, defaultChecked false (nothing to apply). Otherwise a
  // fresh suggestion in `subnet`, defaultChecked true.
  router.post('/propose', async (req: Request, res: Response) => {
    try {
      const { subnet } = req.body as { subnet?: string };
      if (!subnet || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(subnet)) {
        return res.status(400).json({ success: false, error: 'subnet must be a CIDR, e.g. 10.0.1.0/24' });
      }
      const { values: current, localUpfOnly, localSgwuOnly } = await readCurrentValues(configRepo);
      const { interfaces } = await listHostInterfaces();

      const occupied = new Set<string>();
      for (const v of Object.values(current)) if (v) occupied.add(v);
      for (const iface of interfaces) for (const addr of iface.addresses) occupied.add(addr.split('/')[0]);

      // ims-pcscf computed first — ims-rtpengine/mms-mm1 default to reusing
      // its proposed value rather than an independent slot, matching the
      // existing "same address as P-CSCF" convention.
      const gapServices = CATALOG.filter(c => !current[c.service]).map(c => c.service);
      const orderedGaps = [
        ...gapServices.filter(s => s === 'ims-pcscf'),
        ...gapServices.filter(s => s !== 'ims-pcscf' && s !== 'ims-rtpengine' && s !== 'mms-mm1'),
        ...gapServices.filter(s => s === 'ims-rtpengine' || s === 'mms-mm1'),
      ];
      const suggestCount = orderedGaps.filter(s => s !== 'ims-rtpengine' && s !== 'mms-mm1').length;
      const candidates = suggestFreeIps(subnet, occupied, suggestCount);

      const suggestions: Record<string, string> = {};
      let candidateIdx = 0;
      for (const service of orderedGaps) {
        if (service === 'ims-rtpengine' || service === 'mms-mm1') {
          suggestions[service] = suggestions['ims-pcscf'] || candidates[candidateIdx] || '';
          if (!suggestions['ims-pcscf'] && candidates[candidateIdx]) candidateIdx++;
        } else {
          const ip = candidates[candidateIdx++];
          if (ip) { suggestions[service] = ip; occupied.add(ip); }
        }
      }

      const entries = CATALOG.map(c => {
        const currentValue = current[c.service];
        const isPfcpOverridden = (c.service === 'smf-pfcp' && localUpfOnly)
          || (c.service === 'local-upf-pfcp' && localUpfOnly)
          || (c.service === 'sgwc' && localSgwuOnly);
        const proposed = currentValue ?? (suggestions[c.service] || '');
        return {
          ...c,
          current: currentValue,
          proposed,
          defaultChecked: c.liveApplyCapable && !currentValue && !isPfcpOverridden,
          warning: isPfcpOverridden
            ? 'Local UPF/SGW-U Only is active — this address isn\'t used until you turn that off on the Auto-Config page'
            : undefined,
        };
      });

      res.json({ success: true, mainInterface: await detectMainInterface(), entries });
    } catch (err) {
      logger.error({ err: String(err) }, 'ip-plan propose error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /api/ip-plan/apply — body: { entries: [{service, ip}] } — only the
  // rows the operator left checked after reviewing a proposal. Starts an
  // async run (this can take minutes — IMS alone is 14+ sequential service
  // restarts) and returns immediately; poll GET /apply/status for progress.
  router.post('/apply', requireAdmin, (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    const body = req.body as { entries?: { service?: string; ip?: string }[] };
    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return res.status(400).json({ success: false, error: 'entries must be a non-empty array of { service, ip }' });
    }
    const knownServices = new Set(CATALOG.map(c => c.service));
    for (const e of body.entries) {
      if (!e.service || !knownServices.has(e.service)) {
        return res.status(400).json({ success: false, error: `Unknown service: ${e.service}` });
      }
      if (!e.ip || !IP_RE.test(e.ip)) {
        return res.status(400).json({ success: false, error: `Invalid IP for ${e.service}: ${e.ip}` });
      }
    }
    const result = applyUseCase.startApply(body.entries as { service: string; ip: string }[], user);
    if (!result.started) return res.status(409).json({ success: false, error: result.error });
    res.json({ success: true });
  });

  router.get('/apply/status', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, run: applyUseCase.getRunState() });
  });

  return router;
}
