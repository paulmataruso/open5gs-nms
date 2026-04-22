import { useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle } from 'lucide-react';

export function Field({
  label,
  value,
  onChange,
  placeholder,
  mono = true,
  type = 'text',
}: {
  label: string;
  value: string | number;
  onChange: (val: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
}): JSX.Element {
  return (
    <div>
      <label className="nms-label">{label}</label>
      <input
        type={type}
        className={clsx('nms-input', mono && 'font-mono text-xs')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <div>
      <label className="nms-label">{label}</label>
      <select
        className="nms-input font-mono text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function LoggerSection({
  logger,
  onChange,
}: {
  logger: { file?: { path?: string } | string; level?: string };
  onChange: (logger: any) => void;
}): JSX.Element {
  const logPath = typeof logger?.file === 'object' ? logger.file?.path || '' : logger?.file || '';
  const logLevel = logger?.level || 'info';

  const levels = [
    { value: 'fatal', label: 'fatal' },
    { value: 'error', label: 'error' },
    { value: 'warn', label: 'warn' },
    { value: 'info', label: 'info (default)' },
    { value: 'debug', label: 'debug' },
    { value: 'trace', label: 'trace' },
  ];

  return (
    <div>
      <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">Logger</h3>
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Log File Path"
          value={logPath}
          onChange={(v) => onChange({ ...logger, file: { path: v } })}
          placeholder="/var/log/open5gs/service.log"
        />
        <Select
          label="Log Level"
          value={logLevel}
          onChange={(v) => onChange({ ...logger, level: v })}
          options={levels}
        />
      </div>
    </div>
  );
}

// ── SBI Client Section ────────────────────────────────────────────────────────
// Shared by all 5G NFs that have an sbi.client block.
// Presents a 3-way mode selector: SCP only | NRF only | Both

type SbiClientMode = 'scp' | 'nrf' | 'both';

interface SbiClient {
  nrf?: Array<{ uri: string }>;
  scp?: Array<{ uri: string }>;
}

function detectMode(client: SbiClient | undefined): SbiClientMode {
  const hasNrf = !!(client?.nrf?.[0]?.uri);
  const hasScp = !!(client?.scp?.[0]?.uri);
  if (hasNrf && hasScp) return 'both';
  if (hasNrf) return 'nrf';
  return 'scp'; // default
}

export function SbiClientSection({
  client,
  onChange,
}: {
  client: SbiClient | undefined;
  onChange: (client: SbiClient) => void;
}): JSX.Element {
  const [mode, setMode] = useState<SbiClientMode>(() => detectMode(client));

  // Keep URI values in local state so switching modes doesn't wipe them
  const [scpUri, setScpUri] = useState(client?.scp?.[0]?.uri || '');
  const [nrfUri, setNrfUri] = useState(client?.nrf?.[0]?.uri || '');

  const buildClient = (m: SbiClientMode, scp: string, nrf: string): SbiClient => {
    const out: SbiClient = {};
    if (m === 'scp' || m === 'both') out.scp = [{ uri: scp }];
    if (m === 'nrf' || m === 'both') out.nrf = [{ uri: nrf }];
    return out;
  };

  const handleModeChange = (m: SbiClientMode) => {
    setMode(m);
    onChange(buildClient(m, scpUri, nrfUri));
  };

  const handleScpChange = (uri: string) => {
    setScpUri(uri);
    onChange(buildClient(mode, uri, nrfUri));
  };

  const handleNrfChange = (uri: string) => {
    setNrfUri(uri);
    onChange(buildClient(mode, scpUri, uri));
  };

  const modeButtons: Array<{ value: SbiClientMode; label: string; desc: string }> = [
    { value: 'scp', label: 'SCP',      desc: 'Indirect via Service Communication Proxy' },
    { value: 'nrf', label: 'NRF',      desc: 'Direct to NF Repository Function' },
    { value: 'both', label: 'Both',    desc: 'Both defined (not recommended)' },
  ];

  return (
    <div>
      <h3 className="text-sm font-semibold font-display text-nms-accent mb-1">SBI Client</h3>
      <p className="text-xs text-nms-text-dim mb-3">
        How this NF discovers and communicates with other network functions.
      </p>

      {/* Mode selector */}
      <div className="inline-flex rounded-lg bg-nms-bg border border-nms-border p-1 mb-4">
        {modeButtons.map((btn) => (
          <button
            key={btn.value}
            onClick={() => handleModeChange(btn.value)}
            className={clsx(
              'px-3 py-1.5 text-xs font-semibold rounded-md transition-all',
              mode === btn.value
                ? 'bg-nms-accent/15 text-nms-accent'
                : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface-2',
            )}
          >
            {btn.label}
          </button>
        ))}
      </div>

      {/* Warning for Both mode */}
      {mode === 'both' && (
        <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded bg-amber-500/5 border border-amber-500/20 text-xs text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Having both NRF and SCP defined is valid but not best practice.
            Use <strong>SCP</strong> for indirect communication (recommended for most deployments)
            or <strong>NRF</strong> for direct communication. Only use both if your network
            architecture specifically requires it.
          </span>
        </div>
      )}

      {/* URI fields */}
      <div className="space-y-3">
        {(mode === 'scp' || mode === 'both') && (
          <div>
            <label className="nms-label">SCP URI</label>
            <input
              className="nms-input font-mono text-xs w-full"
              value={scpUri}
              onChange={(e) => handleScpChange(e.target.value)}
              placeholder="http://127.0.0.200:7777"
            />
            <p className="text-xs text-nms-text-dim mt-1">
              Indirect communication — this NF delegates service discovery and routing to the SCP.
            </p>
          </div>
        )}
        {(mode === 'nrf' || mode === 'both') && (
          <div>
            <label className="nms-label">NRF URI</label>
            <input
              className="nms-input font-mono text-xs w-full"
              value={nrfUri}
              onChange={(e) => handleNrfChange(e.target.value)}
              placeholder="http://127.0.0.10:7777"
            />
            <p className="text-xs text-nms-text-dim mt-1">
              Direct communication — this NF queries the NRF directly for service discovery.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
