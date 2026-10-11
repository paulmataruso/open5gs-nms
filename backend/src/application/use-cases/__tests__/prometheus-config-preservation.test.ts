import * as fs from 'fs';
import * as path from 'path';
import { extractForeignJobs, extractGlobalBlock } from '../sync-prometheus-config';

// SyncPrometheusConfigUseCase used to rebuild prometheus.yml from scratch and
// overwrite it, so any scrape job an operator had added by hand — a
// node_exporter, a switch, any third-party exporter — was silently deleted on
// the next automatic sync, and a tuned scrape_interval reverted to 15s. These
// guard the ownership-merge that replaced it.

const OWNED = new Set([
  'open5gs-amf', 'open5gs-smf', 'open5gs-upf', 'open5gs-pcf',
  'open5gs-mme', 'open5gs-hss', 'open5gs-pcrf',
  'open5gs-nms-backend', 'pyhss-metrics',
  'vectorcore-smsc-metrics', 'vectorcore-mmsc-metrics',
]);

describe('prometheus.yml ownership merge', () => {
  it('keeps nothing from the real live file, which is 100% NMS-owned', () => {
    // Guards against the opposite failure: duplicating our own jobs on every
    // sync because the owned-name set drifted out of sync with what we emit.
    const live = fs.readFileSync(
      path.resolve(__dirname, '../../../../../monitoring/prometheus.yml'), 'utf-8',
    );
    expect(extractForeignJobs(live, OWNED)).toEqual([]);
  });

  it('preserves an operator-added job verbatim, comments and all', () => {
    const existing = `global:
  scrape_interval: 15s

scrape_configs:

  - job_name: open5gs-amf
    static_configs:
      - targets: ['127.0.0.5:9090']

  # Added by hand — our rack switch.
  - job_name: switch-snmp
    scrape_interval: 60s
    static_configs:
      - targets: ['10.0.0.1:9116']
        labels:
          site: rack-a
`;
    const foreign = extractForeignJobs(existing, OWNED);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toContain('# Added by hand — our rack switch.');
    expect(foreign[0]).toContain('- job_name: switch-snmp');
    expect(foreign[0]).toContain('    scrape_interval: 60s');
    expect(foreign[0]).toContain('          site: rack-a');
    // And it must NOT drag our own job along with it.
    expect(foreign[0]).not.toContain('open5gs-amf');
  });

  it('preserves several foreign jobs and drops every owned one', () => {
    const existing = `scrape_configs:

  - job_name: node-exporter
    static_configs:
      - targets: ['10.0.0.9:9100']

  - job_name: open5gs-smf
    static_configs:
      - targets: ['127.0.0.4:9090']

  - job_name: blackbox
    static_configs:
      - targets: ['10.0.0.8:9115']
`;
    const foreign = extractForeignJobs(existing, OWNED);
    expect(foreign.map(f => f.match(/job_name:\s*(\S+)/)![1])).toEqual(['node-exporter', 'blackbox']);
  });

  it('handles quoted job names and a 0-indent list style', () => {
    const existing = `scrape_configs:
- job_name: "my-exporter"
  static_configs:
  - targets: ['10.0.0.7:1234']
- job_name: 'open5gs-amf'
  static_configs:
  - targets: ['127.0.0.5:9090']
`;
    const foreign = extractForeignJobs(existing, OWNED);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).toContain('my-exporter');
  });

  it('returns nothing for an empty file, a missing section, or an empty list', () => {
    expect(extractForeignJobs('', OWNED)).toEqual([]);
    expect(extractForeignJobs('global:\n  scrape_interval: 15s\n', OWNED)).toEqual([]);
    expect(extractForeignJobs('scrape_configs: []\n', OWNED)).toEqual([]);
  });

  it('stops at the next top-level key rather than swallowing it', () => {
    const existing = `scrape_configs:

  - job_name: mine
    static_configs:
      - targets: ['1.2.3.4:1']

rule_files:
  - /etc/prometheus/rules.yml
`;
    const foreign = extractForeignJobs(existing, OWNED);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]).not.toContain('rule_files');
    expect(foreign[0]).not.toContain('rules.yml');
  });

  it('preserves a tuned global block, and falls back when there is none', () => {
    const tuned = `global:
  scrape_interval:     30s
  evaluation_interval: 30s
  external_labels:
    cluster: prod

scrape_configs: []
`;
    const g = extractGlobalBlock(tuned);
    expect(g).toContain('scrape_interval:     30s');
    expect(g).toContain('    cluster: prod');
    expect(g).not.toContain('scrape_configs');

    expect(extractGlobalBlock('scrape_configs: []\n')).toBeNull();
    expect(extractGlobalBlock('')).toBeNull();
    // A bare `global:` with no body is not worth preserving.
    expect(extractGlobalBlock('global:\nscrape_configs: []\n')).toBeNull();
  });
});
