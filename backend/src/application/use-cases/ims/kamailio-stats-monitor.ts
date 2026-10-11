/**
 * Kamailio stats background poller — one sampler covering all 4 IMS
 * instances (P-CSCF/I-CSCF/S-CSCF/SMSC), sibling to call-stats-monitor.ts's
 * own shape. `kamcmd stats.get_statistics all` (the literal string "all",
 * not a group prefix — confirmed live it returns every group in one call,
 * unlike passing multiple explicit prefixes, which call-stats-monitor.ts's
 * own comment already documents silently drops all but the first) against
 * each instance's already-existing control socket.
 *
 * Real, confirmed-live difference between instances (2026-09-25) — do not
 * assume every role has every stat group: S-CSCF has ims_auth/ims_charging/
 * ims_registrar_scscf/ims_usrloc_scscf/dialog_ng, no pike. P-CSCF has
 * ims_qos/ims_usrloc_pcscf/script/registrar/usrloc/dialog_ng/sctp, no pike.
 * I-CSCF has ims_icscf/pike, no dialog_ng (it's stateless routing, no
 * dialogs to track). Every role has cdp/core/dns/mysql/shmem/sl/tcp/tmx.
 * SMSC's own groups are inferred by analogy with its loaded modules
 * (usrloc/registrar/tm/tmx/sl/corex/dns/mysql/shmem) since it has no
 * control socket yet as of this addition — see ims-controller.ts's
 * smscMainCfg() for the new ctl.so/modparam lines that give it one.
 *
 * Unlike call-stats-monitor.ts, this does NOT persist cross-restart
 * cumulative totals — these are exposed as raw Gauges reading Kamailio's
 * own process-lifetime counters directly (see ims-kamailio-metrics.ts's own
 * comment on why Gauge, not Counter, and why that's fine: a kamailio-<role>
 * restart resetting a "since last restart" counter back toward 0 is
 * accurate, not a bug, for what these panels represent).
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';

export type KamailioRole = 'pcscf' | 'icscf' | 'scscf' | 'smsc';
export const KAMAILIO_ROLES: KamailioRole[] = ['pcscf', 'icscf', 'scscf', 'smsc'];

const ROLE_SOCKETS: Record<KamailioRole, string> = {
  pcscf: '/run/kamailio_pcscf/kamailio_ctl',
  icscf: '/run/kamailio_icscf/kamailio_ctl',
  scscf: '/run/kamailio_scscf/kamailio_ctl',
  smsc: '/run/kamailio_smsc/kamailio_ctl',
};

const POLL_INTERVAL_MS = 15_000;

export interface KamailioRoleStats {
  up: boolean;
  values: Map<string, number>; // raw "group:name" -> value, exactly as kamcmd reports it
}

export class KamailioStatsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private latest = new Map<KamailioRole, KamailioRoleStats>(
    KAMAILIO_ROLES.map(role => [role, { up: false, values: new Map() }]),
  );

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.sample().catch(err => this.logger.debug({ err: String(err) }, 'kamailio stats: initial sample failed'));
    this.timer = setInterval(() => {
      this.sample().catch(err => this.logger.debug({ err: String(err) }, 'kamailio stats: sample failed'));
    }, POLL_INTERVAL_MS);
  }

  getLatest(): Map<KamailioRole, KamailioRoleStats> {
    return this.latest;
  }

  private async sample(): Promise<void> {
    // One kamcmd call per role — deliberately not Promise.all-ing all 4 at
    // once (each is its own try/catch below regardless), independent
    // failures never affect the other 3 roles' data for this cycle.
    const next = new Map<KamailioRole, KamailioRoleStats>();
    for (const role of KAMAILIO_ROLES) {
      try {
        const result = await this.hostExecutor.executeCommand('kamcmd', ['-s', ROLE_SOCKETS[role], 'stats.get_statistics', 'all'], 10000);
        if (result.exitCode !== 0) {
          next.set(role, { up: false, values: new Map() });
          continue;
        }
        const values = new Map<string, number>();
        for (const line of result.stdout.split('\n')) {
          const m = line.match(/^([a-zA-Z0-9_]+:[a-zA-Z0-9_]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/);
          if (m) values.set(m[1], Number(m[2]));
        }
        next.set(role, { up: true, values });
      } catch {
        // Socket doesn't exist (instance not installed/running) or kamcmd
        // itself failed — leave this role reporting down, others unaffected.
        next.set(role, { up: false, values: new Map() });
      }
    }
    this.latest = next;
  }
}
