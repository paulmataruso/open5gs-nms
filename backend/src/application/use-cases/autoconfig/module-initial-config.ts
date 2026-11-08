/**
 * Initial configuration for a freshly-installed module.
 *
 * `FreshHostBootstrapUseCase` is deliberately install-only — its own comment
 * explains why: Configure normally runs afterwards from
 * `backup-restart-usecase.ts`, once a restore has written each module's real
 * state JSON. That is correct for a restore, but it leaves a gap this feature
 * has to fill: on a fresh host with no backup there is no saved state, so
 * nothing ever configures the modules and they stay installed-but-dark.
 * `IpPlanApplyUseCase` will not close it either — with no saved config it
 * reports `saved-for-later`, which records the address without applying it.
 *
 * So this runs Configure once per module, seeded from the allocated plan.
 * It mirrors the module order and payloads of a real, verified manual
 * deployment rather than inventing them.
 *
 * Two rules it follows throughout:
 *
 *   - **Addresses come from the plan, never from a module's own default.**
 *     Several of those defaults collide on a real deployment (VoWiFi's
 *     `DEFAULT_EPDG_IP` is the address BIND uses; SecGW's default gateway is
 *     the one ePDG actually runs on), which is precisely what allocating a
 *     real range avoids.
 *   - **`interfaceMode: 'existing'`**, because this feature binds service
 *     addresses on one real NIC. The alternative, `'dummy'`, creates a /32
 *     netdev and expects a routing protocol to carry it — the layer-3 design
 *     this is explicitly not.
 */

import type pino from 'pino';
import type { ISubscriberRepository } from '../../../domain/interfaces/subscriber-repository';
import type { IHostExecutor } from '../../../domain/interfaces/host-executor';
import type { AutoconfigPlan } from '../../../domain/services/autoconfig-plan';
import { planAddress } from '../../../domain/services/autoconfig-plan';

import { configureIms, IMS_CONFIGURE_DEFAULTS, readCurrentImsConfig } from '../../../interfaces/rest/ims-controller';
import { configureSms } from '../../../interfaces/rest/sms-controller';
import { configureGsm } from '../../../interfaces/rest/gsm-controller';
import { configureAsterisk2g } from '../../../interfaces/rest/asterisk-2g-controller';
import { configureHnbgw } from '../../../interfaces/rest/hnbgw-controller';
import { configureVowifi, DEFAULT_AAA_LISTEN_IP } from '../../../interfaces/rest/vowifi-controller';
import { configureSecgw } from '../../../interfaces/rest/secgw-controller';
import { configureOcs } from '../../../interfaces/rest/ocs-controller';
import { configureMms } from '../../../interfaces/rest/mms-controller';
import { configurePstn } from '../../../interfaces/rest/pstn-controller';
import { configureVectorcoreSmsc } from '../../../interfaces/rest/vectorcore-smsc-controller';
import { configureTwampServer } from '../../../interfaces/rest/twamp-controller';

export interface ModuleConfigDeps {
  subscriberRepo: ISubscriberRepository;
  hostExecutor: IHostExecutor;
  mongoUri: string;
  logger: pino.Logger;
  /** PLMN read from the live core, so a module never guesses it. */
  mcc: string;
  mnc: string;
  /** The management address, for anything that should answer off-box as this host. */
  managementIp: string;
}

export interface ModuleConfigResult {
  moduleId: string;
  configured: boolean;
  skipped?: boolean;
  error?: string;
  detail?: string;
}

/**
 * One entry per bootstrap module id.
 *
 * Order is the install order, because the configure-time dependencies run the
 * same way: IMS underpins MMS, PSTN and the VectorCore SMSC, and HNBGW's
 * configure needs GSM's GPRS already applied.
 */
const CONFIGURATORS: Array<{
  id: string;
  /** Returns a detail line, or null to record the module as deliberately skipped. */
  run: (plan: AutoconfigPlan, d: ModuleConfigDeps) => Promise<string | null>;
}> = [
  {
    id: 'ims',
    run: async (plan, d) => {
      const pcscfIp = planAddress(plan, 'pcscf');
      const dnsIp = planAddress(plan, 'dns');
      if (!pcscfIp || !dnsIp) throw new Error('plan has no P-CSCF or DNS address');
      // P-CSCF and rtpengine share one address, matching how a real
      // deployment binds them.
      await configureIms({
        ...IMS_CONFIGURE_DEFAULTS,
        pcscfIp,
        rtpEngineIp: pcscfIp,
        dnsIp,
        additionalPlmns: [],
        mcc: d.mcc,
        mnc: d.mnc,
      });
      return `P-CSCF/rtpengine ${pcscfIp}, DNS ${dnsIp}, PLMN ${d.mcc}-${d.mnc}`;
    },
  },
  {
    id: 'smsOverSgs',
    // Owns osmo-stp/osmo-hlr/osmo-msc, which 2G and 3G both layer on. Its
    // binds are loopback by design, so the plan contributes nothing here.
    run: async () => {
      await configureSms({ mscBindIp: '127.0.0.2', hlrBindIp: '127.0.0.1', mmeLocalIp: '' });
      return 'osmo-stp/hlr/msc on loopback';
    },
  },
  {
    id: 'gsm',
    run: async (plan, d) => {
      // `virtual` deliberately, not a real BTS. A real BTS transmits on real
      // spectrum, and an unattended run must never switch that on — the
      // operator chooses band/ARFCN/hardware on the GSM page.
      await configureGsm({ gprsEnabled: false });
      d.logger.info('autoconfig: 2G configured with a virtual BTS and GPRS off; ' +
        'set a real BTS, band and ARFCN on the GSM page before transmitting');
      return 'virtual BTS, GPRS off (a real BTS is an operator decision)';
    },
  },
  {
    id: 'asterisk2g',
    run: async (_plan, d) => {
      await configureAsterisk2g({}, d.mongoUri, d.subscriberRepo);
      return 'Asterisk-2G on its own loopback';
    },
  },
  {
    id: 'hnbgw',
    run: async () => {
      await configureHnbgw({});
      return 'OsmoHNBGW with default point codes';
    },
  },
  {
    id: 'vowifi',
    run: async (plan) => {
      const epdgIp = planAddress(plan, 'epdg');
      if (!epdgIp) throw new Error('plan has no ePDG address');
      await configureVowifi({ epdgIp, aaaListenIp: DEFAULT_AAA_LISTEN_IP, interfaceMode: 'existing' });
      return `ePDG ${epdgIp} on the existing interface`;
    },
  },
  {
    id: 'secgw',
    run: async (plan) => {
      const gatewayIp = planAddress(plan, 'secgw');
      if (!gatewayIp) throw new Error('plan has no Security Gateway address');
      // The pool is a single CIDR by design; the allocator guaranteed it is
      // aligned and entirely free, which is what makes it safe to hand one
      // address out of it per radio.
      await configureSecgw({ gatewayIp, interfaceMode: 'existing', poolCidr: plan.secgwPoolCidr });
      return `gateway ${gatewayIp}, per-radio pool ${plan.secgwPoolCidr}`;
    },
  },
  {
    id: 'ocs',
    run: async () => {
      await configureOcs({});
      return 'SigScale OCS with its own dedicated loopback';
    },
  },
  {
    id: 'mms',
    run: async (plan, d) => {
      const mm1 = planAddress(plan, 'mmsc');
      if (!mm1) throw new Error('plan has no MMSC address');
      await configureMms({ mm1PublicIp: mm1 }, d.subscriberRepo);
      return `MM1 public address ${mm1}`;
    },
  },
  {
    id: 'pstn',
    run: async (plan, d) => {
      // The PSTN module's own Asterisk binds a loopback for the IMS trunk;
      // the allocated PSTN address is the EXTERNAL trunk bind, which the
      // IP Plan step applies separately once a config exists.
      const ims = readCurrentImsConfig();
      if (!ims) return null;
      await configurePstn({ asteriskIp: '127.0.1.4' }, d.mongoUri, d.subscriberRepo, d.hostExecutor);
      return 'Asterisk on 127.0.1.4 (external trunk address applied separately)';
    },
  },
  {
    id: 'vectorcoreSmsc',
    run: async () => {
      await configureVectorcoreSmsc();
      return 'VectorCore SMSC';
    },
  },
  {
    id: 'twamp',
    run: async (_plan, d) => {
      // The reflector answers inbound tests from other devices, so it binds
      // the management address rather than a service address.
      await configureTwampServer({ listenIp: d.managementIp }, d.hostExecutor);
      return `reflector on ${d.managementIp}`;
    },
  },
  {
    id: 'syslog',
    // Forwarding targets are an operator decision (where to send logs); there
    // is nothing a declared address range implies about them.
    run: async () => null,
  },
];

/** Module ids this can configure, in the order it does so. */
export const CONFIGURABLE_MODULE_IDS: readonly string[] = CONFIGURATORS.map(c => c.id);

/**
 * The IP Plan services each module's Configure above already sets from the plan.
 *
 * Used to stop the `module-addresses` phase re-applying an address this phase
 * just applied. That second Configure is pure redundancy -- the value is
 * identical -- and it is not harmless: running IMS's Configure twice in one
 * run left `smf.yaml` with a DUPLICATE `dnn: ims` session entry, and Open5GS
 * refuses to start with overlapping subnets ("Overlapping subnets in SMF
 * configuration file: 10.46.0.1/24 and 10.46.0.1/24"), taking the SMF down.
 *
 * `updateSmfImsSession()` is itself idempotent (verified directly against a
 * real smf.yaml), so the duplication comes from an interaction between the two
 * write paths that is NOT fully explained. This mapping removes the second
 * call rather than relying on that interaction being safe.
 */
export const MODULE_OWNED_IP_PLAN_SERVICES: Readonly<Record<string, readonly string[]>> = {
  ims: ['ims-pcscf', 'ims-rtpengine'],
  vowifi: ['vowifi-epdg'],
  secgw: ['secgw-gateway'],
  mms: ['mms-mm1'],
  // PSTN's Configure above sets only its loopback Asterisk bind; the external
  // trunk address is genuinely the IP Plan step's to apply.
  pstn: [],
} as const;

/** The IP Plan services already covered by configuring these modules. */
export function servicesAlreadyConfigured(moduleIds: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of moduleIds) {
    for (const svc of MODULE_OWNED_IP_PLAN_SERVICES[id] ?? []) out.add(svc);
  }
  return out;
}

/**
 * Configures each installed module once.
 *
 * A failure is recorded and the run continues: these modules are independent
 * enough that one broken install should not deny the operator every other
 * working one. The exception is already handled upstream — IMS is first, and
 * the modules that genuinely depend on it check for its config themselves.
 */
export async function configureInstalledModules(
  plan: AutoconfigPlan,
  installedModuleIds: string[],
  deps: ModuleConfigDeps,
): Promise<ModuleConfigResult[]> {
  const wanted = new Set(installedModuleIds);
  const out: ModuleConfigResult[] = [];

  for (const c of CONFIGURATORS) {
    if (!wanted.has(c.id)) continue;
    try {
      const detail = await c.run(plan, deps);
      if (detail === null) {
        out.push({ moduleId: c.id, configured: false, skipped: true, detail: 'nothing a declared address range implies' });
      } else {
        out.push({ moduleId: c.id, configured: true, detail });
        deps.logger.info({ module: c.id, detail }, 'autoconfig: module configured');
      }
    } catch (err) {
      const error = String(err);
      out.push({ moduleId: c.id, configured: false, error });
      deps.logger.error({ module: c.id, error }, 'autoconfig: module configure failed');
    }
  }
  return out;
}

export function describeModuleConfig(results: ModuleConfigResult[]): string {
  const ok = results.filter(r => r.configured);
  const skipped = results.filter(r => r.skipped);
  const failed = results.filter(r => !r.configured && !r.skipped);
  const parts = [`${ok.length} configured`];
  if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
  if (failed.length > 0) {
    parts.push(`${failed.length} FAILED: ` + failed.map(f => `${f.moduleId} (${f.error ?? 'no error reported'})`).join('; '));
  }
  return parts.join(', ');
}
