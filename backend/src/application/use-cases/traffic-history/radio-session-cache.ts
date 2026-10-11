import pino from 'pino';
import { ActiveSessionsUseCase } from '../active-sessions';

export interface RadioSessionRow {
  imsi: string;
  radioIp: string;
  generation: '4g' | '5g';
}

const REFRESH_INTERVAL_MS = 15_000;

/**
 * Background cache of which 4G/5G radio (eNB/gNB, by IP) each currently
 * active subscriber is attached through — feeds the shared
 * open5gs_radio_info gauge (radio-info-metrics.ts). Same fire-then-interval/
 * try-catch-keep-last-good shape as every other cache-refresh loop in this
 * codebase (e.g. gsm-controller.ts's startBtsCacheRefresh) — collect() must
 * never call ActiveSessionsUseCase directly, since that does real host I/O
 * (Open5GS NF API calls) and index.ts's single /metrics handler awaits
 * every registry in one response.
 *
 * Calls getActive5GUEs() once and threads the resulting IMSI set into
 * getActive4GUEs(imsi5GSet) — the same precedent snmp-controller.ts already
 * established — rather than two independent calls that would each redo the
 * equivalent work.
 */
export class RadioSessionCache {
  private timer: NodeJS.Timeout | null = null;
  private latest: RadioSessionRow[] = [];

  constructor(
    private readonly activeSessions: ActiveSessionsUseCase,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.refresh().catch(err => this.logger.warn({ err: String(err) }, 'radio session cache: initial refresh failed'));
    this.timer = setInterval(() => {
      this.refresh().catch(err => this.logger.warn({ err: String(err) }, 'radio session cache: refresh failed'));
    }, REFRESH_INTERVAL_MS);
  }

  getLatest(): RadioSessionRow[] {
    return this.latest;
  }

  private async refresh(): Promise<void> {
    const ues5 = await this.activeSessions.getActive5GUEs();
    const imsi5GSet = new Set(ues5.map(ue => ue.imsi));
    const ues4 = await this.activeSessions.getActive4GUEs(imsi5GSet);
    const rows: RadioSessionRow[] = [];
    for (const ue of ues5) {
      if (!ue.imsi || !ue.radioIp) continue;
      rows.push({ imsi: ue.imsi, radioIp: ue.radioIp, generation: '5g' });
    }
    for (const ue of ues4) {
      if (!ue.imsi || !ue.radioIp) continue;
      rows.push({ imsi: ue.imsi, radioIp: ue.radioIp, generation: '4g' });
    }
    this.latest = rows;
  }
}
