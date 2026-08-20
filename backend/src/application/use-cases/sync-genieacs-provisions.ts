import pino from 'pino';

// Real bug found live (2026-08-16): GenieACS ships two built-in provision
// scripts ("default" and "inform", stored in its own MongoDB, not in this
// repo) that unconditionally declare TR-098 InternetGatewayDevice.* paths on
// every connected device. This deployment's entire radio fleet (Baicells,
// Sercomm 4G/5G, Nokia) is TR-181-only — confirmed live by inspecting each
// device's own reported data model, none have an InternetGatewayDevice root
// at all. Baicells (BaiBLQ firmware) hard-faults (cwmp.9005) the ENTIRE
// GetParameterNames/Values RPC batch if even one requested path doesn't
// exist on the device, so this was perpetually faulting on every single
// Inform for all 3 Baicells radios (confirmed via genieacs-cwmp-access.log).
// This is NOT a per-radio-brand issue needing brand-specific gating — every
// current radio type is TR-181-only, so the fix is a straight swap to the
// data model every radio here actually uses, not a conditional branch.
//
// GenieACS's own "provisions" collection lives outside this project's git
// tree (and outside its own config file management), so unlike everything
// else in this codebase it would NOT survive a GenieACS reinstall/reset and
// isn't reproducible on a fresh deployment without this sync. Mirrors
// SyncPrometheusConfigUseCase's pattern: regenerate on every backend
// startup, not gated behind any module's Install/Configure button, since
// GenieACS itself (like Prometheus) is part of the always-deployed stack,
// not an optional NMS-managed module.
const DEFAULT_PROVISION_SCRIPT = `const hourly = Date.now(3600000);

// Refresh basic parameters hourly. Scoped to only the two parameters
// confirmed to exist on every current radio type (Baicells, Sercomm,
// Nokia) rather than guessing TR-181 equivalents for WiFi/Hosts/WAN
// concepts that don't apply to RAN hardware. See sync-genieacs-provisions.ts
// for the full incident writeup — do not hand-edit this via the GenieACS UI,
// it is regenerated on every NMS backend startup.
declare("Device.DeviceInfo.HardwareVersion", {path: hourly, value: hourly});
declare("Device.DeviceInfo.SoftwareVersion", {path: hourly, value: hourly});
`;

const INFORM_PROVISION_SCRIPT = `// Device ID as user name
const username = declare("DeviceID.ID", {value: 1}).value[0]

// Password will be fixed for a given device because Math.random() is seeded with device ID by default.
const password = Math.trunc(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);

const informInterval = 300;

// Refresh values daily
const daily = Date.now(86400000);

// Unique inform offset per device for better load distribution
const informTime = daily % 86400000;

// TR-181 only — see sync-genieacs-provisions.ts for the full incident
// writeup. Do not hand-edit this via the GenieACS UI, it is regenerated on
// every NMS backend startup.
declare("Device.ManagementServer.ConnectionRequestUsername", {value: daily}, {value: username});
declare("Device.ManagementServer.ConnectionRequestPassword", {value: daily}, {value: password});
declare("Device.ManagementServer.PeriodicInformEnable", {value: daily}, {value: true});
declare("Device.ManagementServer.PeriodicInformInterval", {value: daily}, {value: informInterval});
declare("Device.ManagementServer.PeriodicInformTime", {value: daily}, {value: informTime});
`;

export class SyncGenieacsProvisionsUseCase {
  constructor(
    private readonly genieacsNbiUrl: string,
    private readonly logger: pino.Logger,
  ) {}

  private async putProvision(name: string, script: string): Promise<void> {
    const url = `${this.genieacsNbiUrl}/provisions/${name}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: script,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`PUT ${url} failed: HTTP ${response.status}`);
    }
  }

  /** Never throws — GenieACS provision sync failure is non-fatal, matching SyncPrometheusConfigUseCase. */
  async execute(): Promise<{ synced: boolean; error?: string }> {
    try {
      await this.putProvision('default', DEFAULT_PROVISION_SCRIPT);
      await this.putProvision('inform', INFORM_PROVISION_SCRIPT);
      this.logger.info('GenieACS default/inform provisions synced (TR-181-only, no InternetGatewayDevice.*)');
      return { synced: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: msg }, 'GenieACS provisions sync failed (non-fatal)');
      return { synced: false, error: msg };
    }
  }
}
