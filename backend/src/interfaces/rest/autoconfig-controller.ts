/**
 * Auto-Configuration (env-driven) — status, dry-run and manual trigger.
 *
 * NOT the same thing as `/api/auto-config`, which is the manual
 * Auto-Configuration Wizard the operator drives from a form. This one is the
 * `AUTOCONFIG_*` env-var feature: the operator declares an address range in
 * `.env`, runs `docker compose up`, and the whole deployment addresses and
 * configures itself.
 */

import { Router, Request, Response } from 'express';
import type pino from 'pino';
import type { AutoconfigOrchestrator } from '../../application/use-cases/autoconfig/autoconfig-orchestrator';
import { readManifest } from '../../application/use-cases/autoconfig/autoconfig-orchestrator';
import {
  readAutoconfigEnv, buildAutoconfigContext, allocateAddresses, describePlan,
} from '../../domain/services/autoconfig-plan';
import { probeAddresses, describeProbe, LivenessProbeResult } from '../../domain/services/address-liveness';
import {
  modulesToInstall, unknownModuleNames, ipPlanEntriesFor, allocateWithLazyProbe,
  excludeKnownAddresses,
} from '../../domain/services/autoconfig-apply';
import { HostLivenessRunner, listBoundAddresses } from '../../infrastructure/network/secondary-address';
import { detectMainInterface } from '../../infrastructure/network/main-interface';

export function createAutoconfigRouter(
  orchestrator: AutoconfigOrchestrator,
  logger: pino.Logger,
): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    const env = readAutoconfigEnv(process.env);
    res.json({
      enabled: env.enabled,
      request: {
        interfaceName: env.interfaceName,
        startIp: env.startIp,
        gateway: env.gateway,
        subnet: env.subnet,
        secgwPoolSize: env.secgwPoolSize,
        collisionCheck: env.skipIpCheck ? 'skipped' : 'ping+arp',
      },
      modules: modulesToInstall(process.env),
      unknownModules: unknownModuleNames(process.env),
      run: orchestrator.getRunState(),
      // Names the module currently installing, so the longest phase is not an
      // opaque wait.
      active: orchestrator.getSubState(),
      // Says plainly why an ENABLED feature is not running, rather than
      // leaving an operator to wonder at an idle status.
      bootRun: orchestrator.bootRunSkippable(),
      manifest: readManifest(),
    });
  });

  /**
   * Dry run: probe and allocate, change nothing.
   *
   * Worth having as its own route rather than only as a side effect of a real
   * run — an operator can see exactly which addresses would be taken, and
   * which are already occupied, before enabling anything.
   */
  router.get('/plan', async (_req: Request, res: Response) => {
    try {
      const env = readAutoconfigEnv(process.env);
      let iface = env.interfaceName;
      if (!iface) {
        const main = await detectMainInterface();
        if (!main) {
          return res.status(400).json({
            error: 'No interface owns the default IPv4 route, and AUTOCONFIG_INTERFACE is not set.',
          });
        }
        iface = main.name;
      }

      const ctxRes = buildAutoconfigContext({ ...env, interfaceName: iface });
      if (!ctxRes.ok) {
        return res.status(400).json({ error: 'Invalid Auto-Configuration settings', errors: ctxRes.errors });
      }

      // This mirrors a real run exactly -- the same exclusion of addresses
      // already on the interface, and the same collision-check opt-out. A
      // preview that probed when the run would not (or vice versa) would show
      // the operator addresses they are not going to get, and one without the
      // exclusion would offer them the management address.
      const ctx = excludeKnownAddresses(
        ctxRes.context,
        await listBoundAddresses(iface).catch(() => [] as string[]),
      );

      const runner = new HostLivenessRunner(iface);
      const merged = new Map<string, LivenessProbeResult>();
      let probed = 0;
      let alloc: ReturnType<typeof allocateAddresses>;

      if (env.skipIpCheck) {
        alloc = allocateAddresses(ctx, () => false);
      } else {
        const outcome = await allocateWithLazyProbe(
          ctx.candidates,
          ctx.minimumNeeded,
          {
            probe: async ips => {
              const results = await probeAddresses(runner, ips);
              return { taken: new Set([...results.values()].filter(r => r.taken).map(r => r.ip)), results };
            },
            allocate: isTaken => allocateAddresses(ctx, isTaken),
            ok: r => r.ok,
          },
        );
        for (const batch of outcome.probeResults) for (const [ip, r] of batch) merged.set(ip, r);
        probed = outcome.windowProbed;
        alloc = outcome.result;
      }

      if (!alloc.ok) {
        return res.status(400).json({
          error: 'Not enough free addresses in the given range',
          errors: alloc.errors,
          collisionCheck: env.skipIpCheck ? 'skipped' : 'ping+arp',
          probeReport: env.skipIpCheck ? undefined : describeProbe(merged),
          probeMethodsUnavailable: [...runner.unavailable],
        });
      }

      res.json({
        interfaceName: iface,
        plan: alloc.plan,
        ipPlanEntries: ipPlanEntriesFor(alloc.plan),
        modules: modulesToInstall(process.env),
        collisionCheck: env.skipIpCheck ? 'skipped' : 'ping+arp',
        addressesProbed: probed,
        candidatesAvailable: ctx.candidates.length,
        probeReport: env.skipIpCheck
          ? 'AUTOCONFIG_SKIP_IP_CHECK=true — no address was confirmed free.'
          : describeProbe(merged),
        probeMethodsUnavailable: [...runner.unavailable],
        report: describePlan(alloc.plan),
        dryRun: true,
      });
    } catch (err) {
      logger.error({ err: String(err) }, 'autoconfig: dry run failed');
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * Manual trigger.
   *
   * Forces past `AUTOCONFIG_ENABLED`, which governs the boot-time run only --
   * so an operator can preview with /plan and then run it, without editing
   * .env and restarting the backend, and without arming it for every future
   * boot. The addressing settings are still required.
   */
  router.post('/start', (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const started = orchestrator.start(user, { force: true });
    if (!started.started) return res.status(409).json({ error: started.reason });
    res.json({ started: true, run: orchestrator.getRunState() });
  });

  return router;
}
