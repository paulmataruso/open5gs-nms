import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { Open5gsApiClient, parsePeerIP } from './open5gs-api-client';
import { loadState as loadSecgwState } from '../../interfaces/rest/secgw-controller';

// ── Baicells UE-count correlation ────────────────────────────────────────────
//
// Two genuinely different "UE count" numbers exist for a Baicells radio, and
// neither one is simply wrong — they measure different things:
//   - The radio's own self-reported X_COM_UE_Count/LteUECount (read via
//     GenieACS/TR-069) — confirmed live (2026-08-28) via a real before/after
//     test that a fresh, non-cached read of this parameter tracks the
//     radio's own RRC-CONNECTED count, not the core's full S1/EPS context
//     count — it read 0 on a radio MME simultaneously reported 2 UEs for.
//   - MME's own /enb-info num_connected_ues — the core's authoritative
//     count, which (per MME's own EMM/S1AP state machine) includes UEs MME
//     still holds context for even while they're RRC-idle.
// Rather than pick one, both are surfaced side by side (both the Radio
// Provisioning page's per-radio card and the RAN Network page's interface
// cards) — this module is the single shared place that computes both and
// correlates them, so neither consumer duplicates the matching logic below.
//
// Matching MME's peer IP back to a specific GenieACS device is not a direct
// IP-to-IP match when SecGW is involved: a Baicells radio behind the SecGW
// IPsec tunnel is seen by MME at its IPsec pool address (e.g. 10.0.50.201),
// not its real IP (e.g. 10.0.2.100) — confirmed live via a real S1AP peer
// address dump. secgw-controller.ts's own state already tracks exactly this
// genieacsDeviceId -> poolAddress mapping (set when a radio is added to
// SecGW), so it's reused here rather than re-deriving it. Radios not behind
// SecGW (or on a deployment where SecGW isn't installed — loadState()
// returns an empty radios list in that case, not an error) simply fall back
// to matching on their own real IP.

const FAP = 'Device.Services.FAPService.1.';

function getParam(device: Record<string, any>, dotPath: string): string {
  const parts = dotPath.split('.');
  let node: any = device;
  for (const part of parts) {
    if (node == null) return '';
    node = node[part];
  }
  return node?._value != null ? String(node._value) : '';
}

export interface BaicellsUeCountEntry {
  genieacsDeviceId: string;
  realIp: string;
  mmePeerIp: string;
  // Radio's own TR-069-reported count — null if the parameter has never
  // been populated in GenieACS's cache at all (not the same as a genuine 0).
  selfReportedUeCount: number | null;
  // MME's own /enb-info count for the matched peer — null if this radio
  // isn't currently associated with MME at all (not the same as 0 UEs on
  // an otherwise-connected eNB).
  mmeUeCount: number | null;
}

export class BaicellsUeCountsUseCase {
  private readonly apiClient: Open5gsApiClient;

  constructor(
    private readonly nbiUrl: string,
    hostExecutor: IHostExecutor,
    configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {
    this.apiClient = new Open5gsApiClient(hostExecutor, configRepo, logger);
  }

  async getAll(): Promise<BaicellsUeCountEntry[]> {
    try {
      const projection = [
        '_id',
        'Device.DeviceInfo.X_COM_UE_Count',
        `${FAP}X_COM.LTE.LteUECount`,
        'Device.IP.Interface.1.IPv4Address.1.IPAddress',
        'Device.ManagementServer.ConnectionRequestURL',
      ].join(',');
      const query = encodeURIComponent(JSON.stringify({ '_deviceId._OUI': '48BF74' }));
      const resp = await fetch(`${this.nbiUrl}/devices?query=${query}&projection=${encodeURIComponent(projection)}`);
      if (!resp.ok) throw new Error(`GenieACS NBI returned HTTP ${resp.status}`);
      const devices = (await resp.json()) as Record<string, any>[];

      const secgwState = loadSecgwState();
      const poolByDeviceId = new Map<string, string>();
      for (const radio of secgwState.radios) {
        if (radio.genieacsDeviceId && radio.poolAddress) {
          poolByDeviceId.set(radio.genieacsDeviceId, radio.poolAddress);
        }
      }

      const enbs = await this.apiClient.getMmeEnbInfo().catch(() => []);
      const mmeCountByPeerIp = new Map<string, number>();
      for (const enb of enbs) {
        mmeCountByPeerIp.set(parsePeerIP(enb.s1.sctp.peer), enb.num_connected_ues);
      }

      return devices.map((device): BaicellsUeCountEntry => {
        const genieacsDeviceId = device._id ?? 'unknown';
        const directIp = getParam(device, 'Device.IP.Interface.1.IPv4Address.1.IPAddress');
        const crUrl = getParam(device, 'Device.ManagementServer.ConnectionRequestURL');
        const realIp = directIp || (crUrl.match(/https?:\/\/([^:/]+)/)?.[1] ?? '');
        const mmePeerIp = poolByDeviceId.get(genieacsDeviceId) ?? realIp;

        const rawSelfReported = getParam(device, `${FAP}X_COM.LTE.LteUECount`) || getParam(device, 'Device.DeviceInfo.X_COM_UE_Count');
        const selfReportedUeCount = rawSelfReported !== '' ? parseInt(rawSelfReported, 10) : null;
        const mmeUeCount = mmeCountByPeerIp.has(mmePeerIp) ? mmeCountByPeerIp.get(mmePeerIp)! : null;

        return { genieacsDeviceId, realIp, mmePeerIp, selfReportedUeCount, mmeUeCount };
      });
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Failed to compute Baicells UE count correlation');
      return [];
    }
  }
}
