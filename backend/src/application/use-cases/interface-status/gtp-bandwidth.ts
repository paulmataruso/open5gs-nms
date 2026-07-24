/**
 * GTP-U (N3) User-Plane Bandwidth Monitor
 *
 * Tracks live Up/Down throughput for UE traffic only — deliberately excludes
 * signaling (S1AP/NGAP/PFCP/Diameter). Rather than filtering by port on a
 * shared physical NIC, this reads the byte counters of the UPF's own
 * per-DNN tun devices (upf.yaml's session[].dev, e.g. ogstun/ogstun2) — those
 * interfaces carry nothing but decapsulated UE payload by construction, so a
 * plain interface-level rate is already exactly "GTP U-Plane traffic" with
 * zero risk of double-counting signaling that happens to share a physical NIC.
 *
 * From a TUN device's perspective: userspace (open5gs-upfd) writes decapsulated
 * uplink UE packets into the tun for kernel routing (counted as RX by the
 * kernel), and reads kernel-routed downlink reply packets back out to
 * re-encapsulate toward the UE (counted as TX). So RX bytes/sec = uplink
 * (UE upload), TX bytes/sec = downlink (UE download).
 *
 * Runs a lightweight background sampler (not per-request) so the REST
 * endpoint is always an instant, non-blocking read of the last computed rate.
 */

import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../../domain/interfaces/config-repository';

export interface DnnBandwidth {
  dnn: string;
  dev: string;
  upMbps: number;
  downMbps: number;
}

export interface GtpBandwidth {
  upMbps: number;
  downMbps: number;
  perDnn: DnnBandwidth[];
  sampledAt: number;
}

const SAMPLE_INTERVAL_MS = 2000;

export class GtpBandwidthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastSample: { ts: number; counters: Record<string, { rx: number; tx: number }> } | null = null;
  private latest: GtpBandwidth = { upMbps: 0, downMbps: 0, perDnn: [], sampledAt: 0 };

  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly configRepo: IConfigRepository,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.sample().catch(err => this.logger.warn({ err: String(err) }, 'GTP bandwidth: initial sample failed'));
    this.timer = setInterval(() => {
      this.sample().catch(err => this.logger.warn({ err: String(err) }, 'GTP bandwidth: sample failed'));
    }, SAMPLE_INTERVAL_MS);
  }

  getLatest(): GtpBandwidth {
    return this.latest;
  }

  private async getDnnDevices(): Promise<Array<{ dnn: string; dev: string }>> {
    const upf = await this.configRepo.loadUpf();
    const sessions: any[] = (upf as any).rawYaml?.upf?.session ?? [];
    return sessions
      .filter((s: any) => s?.dev)
      .map((s: any) => ({ dnn: s.dnn ?? s.dev, dev: s.dev as string }));
  }

  private async readCounter(dev: string): Promise<{ rx: number; tx: number } | null> {
    try {
      const [rxRaw, txRaw] = await Promise.all([
        this.hostExecutor.readFile(`/proc/1/root/sys/class/net/${dev}/statistics/rx_bytes`),
        this.hostExecutor.readFile(`/proc/1/root/sys/class/net/${dev}/statistics/tx_bytes`),
      ]);
      const rx = parseInt(rxRaw.trim(), 10);
      const tx = parseInt(txRaw.trim(), 10);
      if (isNaN(rx) || isNaN(tx)) return null;
      return { rx, tx };
    } catch {
      // Device not present (e.g. DNN removed from upf.yaml) — skip silently,
      // this is expected churn, not an error.
      return null;
    }
  }

  private async sample(): Promise<void> {
    const devices = await this.getDnnDevices();
    const now = Date.now();
    const counters: Record<string, { rx: number; tx: number }> = {};
    for (const { dev } of devices) {
      const c = await this.readCounter(dev);
      if (c) counters[dev] = c;
    }

    if (this.lastSample) {
      const dtSec = (now - this.lastSample.ts) / 1000;
      if (dtSec > 0) {
        let upBytes = 0;
        let downBytes = 0;
        const perDnn: DnnBandwidth[] = [];
        for (const { dnn, dev } of devices) {
          const cur = counters[dev];
          const prev = this.lastSample.counters[dev];
          if (!cur || !prev) continue;
          // Counters only ever grow, but guard against a reset (interface
          // recreated) producing a negative delta.
          const drx = Math.max(0, cur.rx - prev.rx);
          const dtx = Math.max(0, cur.tx - prev.tx);
          upBytes += drx;
          downBytes += dtx;
          perDnn.push({
            dnn, dev,
            upMbps: (drx * 8) / (dtSec * 1_000_000),
            downMbps: (dtx * 8) / (dtSec * 1_000_000),
          });
        }
        this.latest = {
          upMbps: (upBytes * 8) / (dtSec * 1_000_000),
          downMbps: (downBytes * 8) / (dtSec * 1_000_000),
          perDnn,
          sampledAt: now,
        };
      }
    }

    this.lastSample = { ts: now, counters };
  }
}
