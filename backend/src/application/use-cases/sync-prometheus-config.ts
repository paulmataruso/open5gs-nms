import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';

// The 7 NFs that expose Prometheus metrics in Open5GS
const METRICS_NFS = [
  { key: 'amf',  label: 'amf'  },
  { key: 'smf',  label: 'smf'  },
  { key: 'upf',  label: 'upf'  },
  { key: 'pcf',  label: 'pcf'  },
  { key: 'mme',  label: 'mme'  },
  { key: 'hss',  label: 'hss'  },
  { key: 'pcrf', label: 'pcrf' },
] as const;

export interface PrometheusTarget {
  address: string;
  port: number;
}

export class SyncPrometheusConfigUseCase {
  constructor(
    private readonly prometheusConfigPath: string,
    private readonly prometheusUrl: string,
    private readonly logger: pino.Logger,
    // Traffic History's own /metrics endpoint — scraped alongside the NFs so
    // it survives every regeneration of this file, not just NF metrics.
    private readonly backendMetricsPort: number,
  ) {}

  /**
   * Extract metrics address/port from a raw NF config object.
   * The rawYaml structure is { [nfKey]: { metrics: { server: [{ address, port }] } } }
   */
  private extractTarget(rawConfig: any, nfKey: string): PrometheusTarget | null {
    const server = rawConfig?.[nfKey]?.metrics?.server?.[0];
    if (!server?.address) return null;
    return {
      address: server.address,
      port: server.port ?? 9090,
    };
  }

  /**
   * Build the full prometheus.yml content from the current NF configs.
   *
   * Only the jobs this module OWNS are regenerated. Any other scrape job, and
   * a customised `global:` block, are carried forward from the existing file —
   * see extractForeignJobs()/extractGlobalBlock(). This used to rebuild the
   * whole file from scratch and overwrite it, which silently deleted every
   * scrape job an operator had added by hand (a node_exporter, a switch, any
   * third-party exporter) and reverted any tuned scrape interval, on a sync
   * that runs automatically whenever an NF's metrics endpoint changes. The
   * docstring here even claimed the global block was preserved; it was not.
   */
  private buildPrometheusYml(targets: Record<string, PrometheusTarget>, pyhssMetricsInstalled: boolean, vectorcoreSmscInstalled: boolean, vectorcoreMmscInstalled: boolean, existing = ''): string {
    const jobs = METRICS_NFS
      .filter(({ key }) => targets[key])
      .map(({ key, label }) => {
        const t = targets[key];
        return [
          `  - job_name: open5gs-${label}`,
          `    static_configs:`,
          `      - targets: ['${t.address}:${t.port}']`,
          `        labels:`,
          `          nf: ${label}`,
          `          generation: ${['amf', 'smf', 'upf', 'pcf'].includes(label) ? '5g' : '4g'}`,
        ].join('\n');
      });

    // No `generation:` label here (unlike the per-NF jobs above, where it's a real,
    // meaningful 4g/5g fact) — real, confirmed-live 2026-09-29 finding (full-session
    // wiring audit): this job's own `/metrics` endpoint now merges 13 separate
    // registries (traffic-history, twamp, gsm, ocs, cdr, asterisk, ims-kamailio,
    // ims-rtpengine, ims-sms, sgs-sms, ...), not just traffic-history's own — a static
    // `generation: traffic-history` label was misleadingly stamped onto every one of
    // them, and nothing anywhere actually queries on it (grepped every dashboard).
    const backendJob = [
      `  - job_name: open5gs-nms-backend`,
      `    static_configs:`,
      `      - targets: ['127.0.0.1:${this.backendMetricsPort}']`,
      `        labels:`,
      `          nf: nms-backend`,
    ].join('\n');
    jobs.push(backendJob);

    // Real, 2026-09-25 finding: PyHSS's own real Prometheus exporter
    // (metricService.py, ims-controller.ts's pyhssMetricsUnit()) isn't one
    // of the core-17 NFs, so it's structurally invisible to METRICS_NFS's
    // generic per-NF loop above — needs its own job, same shape as the NMS
    // backend's own. Conditional on the unit actually being installed
    // (checked by the caller) so hosts that never configured IMS don't get
    // a permanently-down scrape target.
    if (pyhssMetricsInstalled) {
      jobs.push([
        `  - job_name: pyhss-metrics`,
        `    static_configs:`,
        `      - targets: ['127.0.1.11:9191']`,
        `        labels:`,
        `          nf: pyhss`,
        `          generation: ims`,
      ].join('\n'));
    }

    // VectorCore SMSC/MMSC both already run their own real Prometheus
    // exporters (confirmed live 2026-09-26 — smsc_*/vectorcore_mmsc_* series,
    // neither ever scraped before) — same gating idiom as pyhss above so a
    // host that never installed either module doesn't get a permanently-down
    // scrape target. Confirmed neither exporter's own metric labels collide
    // with `nf`/`generation`/`instance`/`job` (only `interface`/`code`/
    // `quantile`/`version`/`le` — none reserved).
    if (vectorcoreSmscInstalled) {
      jobs.push([
        `  - job_name: vectorcore-smsc-metrics`,
        `    static_configs:`,
        `      - targets: ['127.0.0.1:8092']`,
        `        labels:`,
        `          nf: vectorcore-smsc`,
        `          generation: sms`,
      ].join('\n'));
    }
    if (vectorcoreMmscInstalled) {
      jobs.push([
        `  - job_name: vectorcore-mmsc-metrics`,
        `    static_configs:`,
        `      - targets: ['127.0.0.1:8090']`,
        `        labels:`,
        `          nf: vectorcore-mmsc`,
        `          generation: mms`,
      ].join('\n'));
    }

    // Every job name this module generates. Anything else found in the
    // existing file belongs to the operator and is preserved verbatim.
    const owned = new Set<string>([
      ...METRICS_NFS.filter(({ key }) => targets[key]).map(({ label }) => `open5gs-${label}`),
      'open5gs-nms-backend',
      'pyhss-metrics',
      'vectorcore-smsc-metrics',
      'vectorcore-mmsc-metrics',
      // Kept owned even when not currently emitted, so disabling a module
      // removes its job instead of the job being mistaken for an operator's.
      ...METRICS_NFS.map(({ label }) => `open5gs-${label}`),
    ]);
    const foreign = extractForeignJobs(existing, owned);
    const allJobs = [...jobs, ...foreign];

    const scrapeConfigs = allJobs.length > 0
      ? `scrape_configs:\n\n${allJobs.join('\n\n')}\n`
      : `scrape_configs: []\n`;

    const globalBlock = extractGlobalBlock(existing) ?? [
      `global:`,
      `  scrape_interval:     15s`,
      `  evaluation_interval: 15s`,
      `  scrape_timeout:      10s`,
    ].join('\n');

    return [
      `# ─────────────────────────────────────────────────────────────────────`,
      `# Prometheus configuration for Open5GS NMS`,
      `# PARTLY AUTO-GENERATED. The NMS regenerates its own open5gs-*,`,
      `# open5gs-nms-backend, pyhss-metrics and vectorcore-*-metrics jobs`,
      `# whenever metrics endpoints change — edits to those are overwritten.`,
      `# Any OTHER scrape job you add here, and the global: block below, are`,
      `# preserved across regeneration.`,
      `# To change an NMS-owned job, use the Metrics Endpoints page in the UI.`,
      `# ─────────────────────────────────────────────────────────────────────`,
      ``,
      globalBlock,
      ``,
      scrapeConfigs,
    ].join('\n');
  }

  /**
   * Write prometheus.yml and trigger a live reload via the Prometheus HTTP API.
   * Returns { reloaded: true } on success, { reloaded: false, error } on failure.
   * Never throws — Prometheus sync failure is non-fatal.
   */
  async execute(allConfigs: any): Promise<{ reloaded: boolean; error?: string }> {
    try {
      // 1. Extract targets from incoming configs
      const targets: Record<string, PrometheusTarget> = {};
      for (const { key } of METRICS_NFS) {
        const raw = allConfigs[key];
        const target = this.extractTarget(raw, key);
        if (target) {
          targets[key] = target;
        }
      }

      this.logger.info(
        { targets: Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, `${v.address}:${v.port}`])) },
        'Syncing Prometheus config',
      );

      // 1b. PyHSS metrics isn't one of the core-17 NFs (see buildPrometheusYml's
      // own comment) — detect it the same way every other optional-module
      // "is this installed" check in this codebase does, by unit-file presence.
      const pyhssMetricsInstalled = await fs.access('/proc/1/root/etc/systemd/system/pyhss-metrics.service')
        .then(() => true).catch(() => false);
      const vectorcoreSmscInstalled = await fs.access('/proc/1/root/etc/systemd/system/vectorcore-smsc.service')
        .then(() => true).catch(() => false);
      const vectorcoreMmscInstalled = await fs.access('/proc/1/root/etc/systemd/system/vectorcore-mmsc.service')
        .then(() => true).catch(() => false);

      // 2. Build the new prometheus.yml content, merging over what's there
      //    now so operator-owned jobs and global settings survive.
      const absPathForRead = path.resolve(this.prometheusConfigPath);
      const existing = await fs.readFile(absPathForRead, 'utf-8').catch(() => '');
      const content = this.buildPrometheusYml(targets, pyhssMetricsInstalled, vectorcoreSmscInstalled, vectorcoreMmscInstalled, existing);

      // 3. Write the file — overwrite in place so Prometheus reload picks it up correctly
      // NOTE: atomic rename (write tmp + rename) creates a new inode which confuses
      // Prometheus on Linux bind mounts. Direct overwrite keeps the same inode.
      const absPath = path.resolve(this.prometheusConfigPath);
      await fs.writeFile(absPath, content, 'utf-8');
      this.logger.info({ path: absPath }, 'prometheus.yml written');

      // 4. Trigger live reload via Prometheus HTTP API
      // POST /-/reload — requires --web.enable-lifecycle (already set in docker-compose)
      const reloadUrl = `${this.prometheusUrl}/-/reload`;
      const response = await fetch(reloadUrl, { method: 'POST', signal: AbortSignal.timeout(5000) });

      if (!response.ok) {
        const msg = `Prometheus reload HTTP ${response.status}`;
        this.logger.warn({ status: response.status, url: reloadUrl }, msg);
        return { reloaded: false, error: msg };
      }

      this.logger.info({ url: reloadUrl }, 'Prometheus reloaded successfully');
      return { reloaded: true };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: msg }, 'Prometheus sync failed (non-fatal)');
      return { reloaded: false, error: msg };
    }
  }
}

/** Indentation width of a line, or null for a blank/comment-only line. */
function promIndentOf(line: string): number | null {
  if (/^\s*$/.test(line) || /^\s*#/.test(line)) return null;
  return line.length - line.replace(/^\s*/, '').length;
}

/**
 * Pull out every scrape job in an existing prometheus.yml whose job_name is not
 * in `owned`, returned as verbatim text blocks ready to re-emit.
 *
 * Exported for unit testing: the whole value of this function is that it
 * preserves text an operator wrote, which can only be verified by asserting on
 * real file content.
 */
export function extractForeignJobs(existing: string, owned: Set<string>): string[] {
  if (!existing.trim()) return [];
  const lines = existing.split('\n');

  const scrapeIdx = lines.findIndex(l => /^scrape_configs:/.test(l));
  if (scrapeIdx === -1) return [];
  // `scrape_configs: []` has no entries at all.
  if (/^scrape_configs:\s*\[\s*\]\s*$/.test(lines[scrapeIdx])) return [];

  // The section ends at the next top-level KEY. A list item at indent 0 is
  // valid YAML (`scrape_configs:` followed by unindented `- job_name:`) and is
  // part of this section, not the start of a new one — treating it as a
  // boundary made every job in a 0-indent file invisible.
  let end = lines.length;
  for (let i = scrapeIdx + 1; i < lines.length; i++) {
    const ind = promIndentOf(lines[i]);
    if (ind === null) continue;
    if (ind === 0 && !/^\s*-/.test(lines[i])) { end = i; break; }
  }

  // Job entries are list items; take the indent from the first one seen so this
  // works whether the file uses 0- or 2-space list indentation.
  const starts: Array<{ i: number; name: string }> = [];
  let itemIndent: number | null = null;
  for (let i = scrapeIdx + 1; i < end; i++) {
    const m = lines[i].match(/^(\s*)-\s+job_name:\s*(.+?)\s*$/);
    if (!m) continue;
    const ind = m[1].length;
    if (itemIndent === null) itemIndent = ind;
    if (ind !== itemIndent) continue;
    starts.push({ i, name: m[2].replace(/^['"]|['"]$/g, '') });
  }

  // A comment sitting directly above a job documents THAT job, so it travels
  // with it. Without this, a comment above a foreign job was attributed to the
  // preceding block and silently dropped whenever that block was NMS-owned.
  const startOfJob = (i: number): number => {
    let from = i;
    while (from - 1 > scrapeIdx && /^\s*#/.test(lines[from - 1])) from--;
    return from;
  };

  const out: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    if (owned.has(starts[k].name)) continue;
    const from = startOfJob(starts[k].i);
    const to = k + 1 < starts.length ? startOfJob(starts[k + 1].i) : end;
    // Trim trailing blank lines so re-joining with '\n\n' keeps spacing even.
    const block = lines.slice(from, to);
    while (block.length > 0 && /^\s*$/.test(block[block.length - 1])) block.pop();
    if (block.length > 0) out.push(block.join('\n'));
  }
  return out;
}

/**
 * Return the existing `global:` block verbatim, or null if there isn't one.
 * Lets an operator's tuned scrape_interval/evaluation_interval survive a sync.
 */
export function extractGlobalBlock(existing: string): string | null {
  if (!existing.trim()) return null;
  const lines = existing.split('\n');
  const idx = lines.findIndex(l => /^global:\s*$/.test(l));
  if (idx === -1) return null;
  let last = idx;
  for (let i = idx + 1; i < lines.length; i++) {
    const ind = promIndentOf(lines[i]);
    if (ind === null) continue;
    if (ind === 0) break;
    last = i;
  }
  if (last === idx) return null; // `global:` with nothing under it — use ours.
  return lines.slice(idx, last + 1).join('\n');
}
