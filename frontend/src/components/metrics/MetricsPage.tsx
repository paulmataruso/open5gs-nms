import { useEffect, useState, useCallback } from 'react';
import { BarChart2, RefreshCw, Save, AlertTriangle, ExternalLink, Table2, FileCode2, Info } from 'lucide-react';
import { useConfigStore } from '../../stores';
import { configApi } from '../../api';
import type { AllConfigs } from '../../types';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

// ── Types ─────────────────────────────────────────────────────────────────────

type EditMode = 'table' | 'scrape';

interface MetricsRow {
  key: keyof AllConfigs;
  label: string;
  fullName: string;
  group: '5G Core' | '4G EPC';
}

interface EditState {
  address: string;
  port: string;
}

// ── NF definitions ────────────────────────────────────────────────────────────

const METRICS_NFS: MetricsRow[] = [
  { key: 'amf',  label: 'AMF',  fullName: 'Access & Mobility Management Function', group: '5G Core' },
  { key: 'smf',  label: 'SMF',  fullName: 'Session Management Function',           group: '5G Core' },
  { key: 'upf',  label: 'UPF',  fullName: 'User Plane Function',                   group: '5G Core' },
  { key: 'pcf',  label: 'PCF',  fullName: 'Policy Control Function',               group: '5G Core' },
  { key: 'mme',  label: 'MME',  fullName: 'Mobility Management Entity',            group: '4G EPC'  },
  { key: 'hss',  label: 'HSS',  fullName: 'Home Subscriber Server',                group: '4G EPC'  },
  { key: 'pcrf', label: 'PCRF', fullName: 'Policy & Charging Rules Function',      group: '4G EPC'  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMetrics(configs: AllConfigs, key: keyof AllConfigs): { address: string; port: number } {
  const raw    = (configs[key] as any)?.[key as string];
  const server = raw?.metrics?.server?.[0];
  return {
    address: server?.address ?? '',
    port:    server?.port    ?? 9090,
  };
}

function setMetrics(configs: AllConfigs, key: keyof AllConfigs, address: string, port: number): AllConfigs {
  const fullYaml  = configs[key] as any;
  const nfSection = fullYaml?.[key as string] ?? {};
  return {
    ...configs,
    [key]: {
      ...fullYaml,
      [key as string]: {
        ...nfSection,
        metrics: { server: [{ address, port }] },
      },
    },
  };
}

/** Build the editable scrape config YAML from current edits state */
function buildScrapeYaml(edits: Partial<Record<keyof AllConfigs, EditState>>): string {
  const lines: string[] = ['scrape_configs:'];
  METRICS_NFS.forEach(({ key, label }) => {
    const e = edits[key];
    const addr = e?.address || '';
    const port = e?.port || '9090';
    lines.push('');
    lines.push(`  - job_name: open5gs-${label.toLowerCase()}`);
    lines.push(`    static_configs:`);
    lines.push(`      - targets: ['${addr}:${port}']`);
    lines.push(`        labels:`);
    lines.push(`          nf: ${label.toLowerCase()}`);
    lines.push(`          generation: ${['AMF', 'SMF', 'UPF', 'PCF'].includes(label) ? '5g' : '4g'}`);
  });
  return lines.join('\n');
}

/**
 * Parse the scrape config YAML textarea back into edits state.
 * Looks for job_name lines matching open5gs-{nf} and extracts the target address:port.
 * Returns null if parsing fails (invalid YAML structure).
 */
function parseScrapeYaml(yaml: string): Partial<Record<keyof AllConfigs, EditState>> | null {
  try {
    const result: Partial<Record<keyof AllConfigs, EditState>> = {};

    // Build a map of nf label -> key
    const nfMap: Record<string, keyof AllConfigs> = {};
    METRICS_NFS.forEach(({ key, label }) => {
      nfMap[label.toLowerCase()] = key;
    });

    // Split into job blocks by finding job_name lines
    const lines = yaml.split('\n');
    let currentNf: keyof AllConfigs | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Match job_name: open5gs-amf etc.
      const jobMatch = trimmed.match(/^-?\s*job_name:\s*open5gs-(\w+)/);
      if (jobMatch) {
        const nfLabel = jobMatch[1].toLowerCase();
        currentNf = nfMap[nfLabel] ?? null;
        continue;
      }

      // Match target: ['address:port'] or - 'address:port'
      if (currentNf) {
        const targetMatch = trimmed.match(/['"]?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)['"]?/);
        if (targetMatch) {
          result[currentNf] = {
            address: targetMatch[1],
            port:    targetMatch[2],
          };
          currentNf = null;
        }
      }
    }

    return result;
  } catch {
    return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MetricsPage(): JSX.Element {
  const configs       = useConfigStore((s) => s.configs);
  const loading       = useConfigStore((s) => s.loading);
  const fetchConfigs  = useConfigStore((s) => s.fetchConfigs);
  const updateConfigs = useConfigStore((s) => s.updateConfigs);

  const [applying,   setApplying]   = useState(false);
  const [editMode,   setEditMode]   = useState<EditMode>('table');
  const [edits,      setEdits]      = useState<Partial<Record<keyof AllConfigs, EditState>>>({});
  const [baseline,   setBaseline]   = useState<Partial<Record<keyof AllConfigs, EditState>>>({});
  const [scrapeText, setScrapeText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  // Initialise edits from configs
  useEffect(() => {
    if (!loading && configs) {
      const init: Partial<Record<keyof AllConfigs, EditState>> = {};
      METRICS_NFS.forEach(({ key }) => {
        const m   = getMetrics(configs, key);
        init[key] = { address: m.address, port: String(m.port) };
      });
      setEdits(init);
      setBaseline(init);
      setScrapeText(buildScrapeYaml(init));
    }
  }, [configs, loading]);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  // Keep scrapeText in sync when edits change from the table mode
  useEffect(() => {
    if (editMode === 'table') {
      setScrapeText(buildScrapeYaml(edits));
    }
  }, [edits, editMode]);

  // When switching TO scrape mode, regenerate from current edits
  const handleModeSwitch = (mode: EditMode) => {
    if (mode === 'scrape') {
      setScrapeText(buildScrapeYaml(edits));
      setParseError(null);
    }
    setEditMode(mode);
  };

  // Handle scrape config textarea changes — parse back into edits
  const handleScrapeChange = useCallback((value: string) => {
    setScrapeText(value);
    const parsed = parseScrapeYaml(value);
    if (parsed && Object.keys(parsed).length > 0) {
      // Merge parsed values into edits — keep existing values for NFs not found in parse
      setEdits((prev) => ({ ...prev, ...parsed }));
      setParseError(null);
    } else if (value.trim() && (!parsed || Object.keys(parsed).length === 0)) {
      setParseError('Could not parse any valid targets — check address:port format');
    }
  }, []);

  // Dirty detection
  const dirtyKeys = METRICS_NFS
    .map(({ key }) => key)
    .filter((key) => {
      const e = edits[key];
      const b = baseline[key];
      return e && b && (e.address !== b.address || e.port !== b.port);
    });
  const isDirty = dirtyKeys.length > 0;

  const handleChange = (key: keyof AllConfigs, field: 'address' | 'port', value: string) => {
    setEdits((prev) => ({ ...prev, [key]: { ...prev[key]!, [field]: value } }));
  };

  const handleApply = async () => {
    if (!configs) return;
    setApplying(true);
    try {
      let updated = configs;
      dirtyKeys.forEach((key) => {
        const e    = edits[key]!;
        const port = parseInt(e.port) || 9090;
        updated    = setMetrics(updated, key, e.address, port);
      });

      updateConfigs(updated);
      const result = await configApi.apply(updated);

      if (result.success) {
        toast.success(
          dirtyKeys.length === 1
            ? `Metrics updated for ${dirtyKeys[0].toUpperCase()}`
            : `Metrics updated for ${dirtyKeys.length} network functions`,
        );
        if (result.prometheusReloaded) {
          toast.success('Prometheus scrape config updated and reloaded', { icon: '📡' });
        } else if (result.prometheusReloadError) {
          toast.error(`Prometheus reload failed: ${result.prometheusReloadError}`, { duration: 6000 });
        }
        const newBase = { ...baseline };
        dirtyKeys.forEach((key) => {
          const e      = edits[key]!;
          newBase[key] = { address: e.address, port: String(parseInt(e.port) || 9090) };
        });
        setBaseline(newBase);
        setScrapeText(buildScrapeYaml(newBase as Partial<Record<keyof AllConfigs, EditState>>));
        useConfigStore.getState().setDirty(false);
      } else if (result.rollback) {
        toast.error('Apply failed — configuration rolled back');
      } else {
        toast.error('Apply failed');
      }
    } catch {
      toast.error('Apply failed');
    } finally {
      setApplying(false);
    }
  };

  const handleRefresh = async () => {
    await fetchConfigs();
    toast.success('Refreshed from disk');
  };

  if (loading || !configs) {
    return (
      <div className="p-6 flex items-center justify-center h-64 text-nms-text-dim">
        Loading configurations…
      </div>
    );
  }

  const groups: Array<'5G Core' | '4G EPC'> = ['5G Core', '4G EPC'];

  return (
    <div className="p-6 space-y-6">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold font-display flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-nms-accent" />
            Metrics Endpoints
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Configure where each network function exposes Prometheus metrics.
            Changes update <span className="font-mono">/etc/open5gs/*.yaml</span>, restart affected services, and reload Prometheus automatically.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {isDirty && (
            <span className="text-xs text-nms-amber flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {dirtyKeys.length} unsaved change{dirtyKeys.length > 1 ? 's' : ''}
            </span>
          )}
          <a
            href={`http://${window.location.hostname}:${import.meta.env.VITE_PROMETHEUS_PORT || '9099'}`}
            target="_blank"
            rel="noopener noreferrer"
            className="nms-btn-ghost flex items-center gap-2 text-sm"
            title="Open Prometheus UI"
          >
            <ExternalLink className="w-4 h-4" />
            Prometheus
          </a>
          <a
            href={`http://${window.location.hostname}:${import.meta.env.VITE_GRAFANA_PORT || '3000'}`}
            target="_blank"
            rel="noopener noreferrer"
            className="nms-btn-ghost flex items-center gap-2 text-sm text-nms-accent border-nms-accent/30 hover:border-nms-accent/60"
            title="Open Grafana dashboards"
          >
            <ExternalLink className="w-4 h-4" />
            Grafana
          </a>
          <button
            onClick={handleRefresh}
            disabled={applying}
            className="nms-btn-ghost flex items-center gap-2 text-sm"
          >
            <RefreshCw className={clsx('w-4 h-4', applying && 'animate-spin')} />
            Refresh
          </button>
          <button
            onClick={handleApply}
            disabled={applying || !isDirty}
            className="nms-btn-primary flex items-center gap-2 text-sm"
          >
            {applying
              ? <RefreshCw className="w-4 h-4 animate-spin" />
              : <Save className="w-4 h-4" />
            }
            {applying
              ? 'Applying…'
              : isDirty
                ? `Apply ${dirtyKeys.length} Change${dirtyKeys.length > 1 ? 's' : ''}`
                : 'Apply Changes'
            }
          </button>
        </div>
      </div>

      {/* ── Mode toggle ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="inline-flex rounded-lg bg-nms-surface border border-nms-border p-1">
          <button
            onClick={() => handleModeSwitch('table')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all',
              editMode === 'table'
                ? 'bg-nms-accent/10 text-nms-accent'
                : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
            )}
          >
            <Table2 className="w-4 h-4" />
            Endpoint Editor
          </button>
          <button
            onClick={() => handleModeSwitch('scrape')}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all',
              editMode === 'scrape'
                ? 'bg-nms-accent/10 text-nms-accent'
                : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
            )}
          >
            <FileCode2 className="w-4 h-4" />
            Scrape Config Editor
          </button>
        </div>
        <span className="text-xs text-nms-text-dim">
          {editMode === 'table'
            ? 'Edit each NF address and port individually'
            : 'Edit the Prometheus scrape config directly'
          }
        </span>
      </div>

      {/* ── Mode-specific info banner ─────────────────────────────────────── */}
      {editMode === 'scrape' ? (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-nms-text-dim">
          <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>
            <span className="text-amber-400 font-semibold">Scrape Config mode — </span>
            Editing the targets here updates the <span className="font-mono text-nms-text">metrics.server</span> address
            and port inside each NF's <span className="font-mono text-nms-text">/etc/open5gs/*.yaml</span> config file.
            It is exactly the same as using the Endpoint Editor above — both views are always in sync.
            When you hit Apply, the NF YAML is updated, the service is restarted with the new metrics address,
            and <span className="font-mono text-nms-text">prometheus.yml</span> is regenerated and live-reloaded automatically.
            Only <span className="font-mono text-nms-text">targets</span> values are editable — other fields are read-only structure.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-nms-accent/5 border border-nms-accent/20 text-xs text-nms-text-dim">
          <ExternalLink className="w-4 h-4 text-nms-accent shrink-0 mt-0.5" />
          <span>
            Each NF exposes Prometheus metrics at{' '}
            <span className="font-mono text-nms-text">http://&lt;address&gt;:&lt;port&gt;/metrics</span>.
            When you apply changes, <span className="text-nms-text">prometheus.yml is automatically regenerated and Prometheus is live-reloaded</span> — no manual steps needed.
            NFs without a <span className="font-mono">metrics:</span> block (NRF, SCP, AUSF, UDM, UDR, NSSF, BSF, SGW-C, SGW-U) do not expose Prometheus metrics.
          </span>
        </div>
      )}

      {/* ── Table mode ───────────────────────────────────────────────────── */}
      {editMode === 'table' && groups.map((group) => {
        const rows    = METRICS_NFS.filter((r) => r.group === group);
        const is5G    = group === '5G Core';
        const accentClass = is5G
          ? { badge: 'bg-nms-accent/15 text-nms-accent',  nfBadge: 'bg-nms-accent/10 text-nms-accent'  }
          : { badge: 'bg-purple-500/15 text-purple-400',  nfBadge: 'bg-purple-500/10 text-purple-400'  };

        return (
          <div key={group} className="nms-card overflow-hidden p-0">
            <div className="px-5 py-3 border-b border-nms-border bg-nms-surface-2/40">
              <span className={clsx('text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded', accentClass.badge)}>
                {group}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-nms-border text-nms-text-dim text-xs uppercase tracking-wider">
                  <th className="text-left px-5 py-3 w-28  font-semibold">NF</th>
                  <th className="text-left px-5 py-3       font-semibold">Full Name</th>
                  <th className="text-left px-5 py-3 w-52  font-semibold">Metrics Address</th>
                  <th className="text-left px-5 py-3 w-28  font-semibold">Port</th>
                  <th className="text-left px-5 py-3       font-semibold">Scrape URL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ key, label, fullName }, idx) => {
                  const edit      = edits[key]    ?? { address: '', port: '9090' };
                  const base      = baseline[key] ?? { address: '', port: '9090' };
                  const rowDirty  = edit.address !== base.address || edit.port !== base.port;
                  const addrDirty = edit.address !== base.address;
                  const portDirty = edit.port    !== base.port;
                  const scrapeUrl = edit.address ? `http://${edit.address}:${edit.port}/metrics` : null;

                  return (
                    <tr
                      key={key}
                      className={clsx(
                        'border-b border-nms-border/50 transition-colors',
                        idx % 2 === 0 ? 'bg-transparent' : 'bg-nms-surface-2/20',
                        rowDirty && 'border-l-2 border-l-nms-amber',
                      )}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className={clsx('font-mono font-bold text-xs px-2 py-1 rounded', accentClass.nfBadge)}>
                            {label}
                          </span>
                          {rowDirty && <span className="w-1.5 h-1.5 rounded-full bg-nms-amber shrink-0" title="Unsaved" />}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-nms-text-dim text-xs">{fullName}</td>
                      <td className="px-5 py-3.5">
                        <input
                          type="text"
                          className={clsx('nms-input font-mono text-xs w-full', addrDirty && 'border-nms-amber/60 focus:border-nms-amber')}
                          value={edit.address}
                          placeholder="127.0.0.1"
                          onChange={(e) => handleChange(key, 'address', e.target.value)}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <input
                          type="number"
                          className={clsx('nms-input font-mono text-xs w-full', portDirty && 'border-nms-amber/60 focus:border-nms-amber')}
                          value={edit.port}
                          min={1}
                          max={65535}
                          onChange={(e) => handleChange(key, 'port', e.target.value)}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        {scrapeUrl
                          ? <span className="font-mono text-xs text-nms-text-dim">{scrapeUrl}</span>
                          : <span className="text-xs text-nms-text-dim/40 italic">—</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* ── Scrape config editor mode ─────────────────────────────────────── */}
      {editMode === 'scrape' && (
        <div className="nms-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold font-display text-nms-accent flex items-center gap-2">
              <FileCode2 className="w-4 h-4" />
              Prometheus Scrape Config
            </h3>
            {parseError && (
              <span className="text-xs text-nms-red flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                {parseError}
              </span>
            )}
            {isDirty && !parseError && (
              <span className="text-xs text-nms-amber flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                Unsaved changes detected
              </span>
            )}
          </div>
          <p className="text-xs text-nms-text-dim mb-3">
            Edit the <span className="font-mono text-nms-text">targets</span> values below.
            Each target maps directly to a network function's metrics listen address and port.
            The rest of the structure is fixed.
          </p>
          <textarea
            className={clsx(
              'w-full h-[480px] bg-nms-bg border rounded p-4 text-xs font-mono text-nms-text',
              'focus:outline-none focus:border-nms-accent/60 transition-colors resize-none leading-relaxed',
              parseError ? 'border-nms-red/50' : 'border-nms-border',
            )}
            value={scrapeText}
            onChange={(e) => handleScrapeChange(e.target.value)}
            spellCheck={false}
          />
          <p className="text-xs text-nms-text-dim mt-2">
            Tip: switch to <strong className="text-nms-text">Endpoint Editor</strong> to see the parsed address and port for each NF side by side.
          </p>
        </div>
      )}

    </div>
  );
}
