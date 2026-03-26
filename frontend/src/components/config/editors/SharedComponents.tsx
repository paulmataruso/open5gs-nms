import { clsx } from 'clsx';

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
