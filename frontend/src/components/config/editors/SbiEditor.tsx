import type { Sbi } from '../../../types';

interface Props {
  sbi: Sbi;
  onChange: (sbi: Sbi) => void;
  serviceName?: string; // Optional, for future use
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string | number;
  onChange: (val: string) => void;
  placeholder?: string;
  type?: string;
}): JSX.Element {
  return (
    <div>
      <label className="nms-label">{label}</label>
      <input
        type={type}
        className="nms-input font-mono text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function SbiEditor({ sbi, onChange }: Props): JSX.Element {
  const server = sbi.server[0] || { address: '127.0.0.1', port: 7777 };

  const updateServer = (field: string, value: string | number) => {
    onChange({
      ...sbi,
      server: [{ ...server, [field]: value }],
    });
  };

  const updateNrfUri = (uri: string) => {
    onChange({
      ...sbi,
      client: {
        ...sbi.client,
        nrf: [{ uri }],
      },
    });
  };

  const updateScpUri = (uri: string) => {
    onChange({
      ...sbi,
      client: {
        ...sbi.client,
        scp: [{ uri }],
      },
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">
          SBI Server
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Bind Address"
            value={server.address}
            onChange={(v) => updateServer('address', v)}
            placeholder="127.0.0.1"
          />
          <Field
            label="Port"
            type="number"
            value={server.port}
            onChange={(v) => updateServer('port', parseInt(v) || 7777)}
            placeholder="7777"
          />
        </div>
      </div>

      {sbi.client && (
        <div>
          <h3 className="text-sm font-semibold font-display text-nms-accent mb-3">
            SBI Client
          </h3>
          <div className="grid grid-cols-2 gap-4">
            {sbi.client.nrf && (
              <Field
                label="NRF URI"
                value={sbi.client.nrf[0]?.uri || ''}
                onChange={updateNrfUri}
                placeholder="http://127.0.0.10:7777"
              />
            )}
            {sbi.client.scp && (
              <Field
                label="SCP URI"
                value={sbi.client.scp[0]?.uri || ''}
                onChange={updateScpUri}
                placeholder="http://127.0.0.200:7777"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
