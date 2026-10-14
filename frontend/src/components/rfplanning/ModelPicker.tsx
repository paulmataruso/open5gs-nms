import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import {
  rfSimulationApi,
  type PlanningRadio, type PropagationModelId, type PropagationModelInfo, type ModelOptions,
} from '../../api/rfSimulation';

// Propagation model picker.
//
// Every model is offered, but each is annotated against the radios actually on
// the map, because three of them are out of band on this deployment: Hata
// stops at 1.5 GHz, COST-231 at 2.0 GHz and Walfisch-Ikegami at 2.0 GHz, while
// CBRS n48 sits at 3.6 GHz. Those models hard-reject out-of-range inputs rather
// than extrapolating, so choosing one without warning produces an empty map.
//
// The check here is advisory and duplicated — the backend independently
// refuses an inapplicable run. This exists so the refusal is visible BEFORE
// pressing Simulate rather than after.

interface Props {
  model: PropagationModelId;
  modelOptions: ModelOptions;
  radios: PlanningRadio[];
  radiusM: number;
  onChange: (model: PropagationModelId) => void;
  onOptionsChange: (options: ModelOptions) => void;
}

interface Verdict { ok: boolean; reasons: string[] }

function verdictFor(info: PropagationModelInfo, radios: PlanningRadio[], radiusM: number): Verdict {
  const reasons: string[] = [];
  if (radios.length === 0) return { ok: true, reasons };
  const outside = (value: number, range: [number, number] | null) =>
    range != null && (value < range[0] || value > range[1]);

  for (const radio of radios) {
    if (outside(radio.frequencyGhz, info.frequencyRangeGhz)) {
      const [lo, hi] = info.frequencyRangeGhz!;
      reasons.push(`${radio.frequencyGhz} GHz is outside ${lo}–${hi} GHz`);
      break;
    }
  }
  for (const radio of radios) {
    if (outside(radio.antennaHeightM, info.txHeightRangeM)) {
      const [lo, hi] = info.txHeightRangeM!;
      reasons.push(`${radio.antennaHeightM} m antenna is outside ${lo}–${hi} m`);
      break;
    }
  }
  if (info.distanceRangeM && radiusM < info.distanceRangeM[0]) {
    reasons.push(`valid from ${info.distanceRangeM[0]} m, radius is ${radiusM} m`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function ModelPicker(props: Props) {
  const { model, modelOptions, radios, radiusM, onChange, onOptionsChange } = props;
  const [models, setModels] = useState<PropagationModelInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rfSimulationApi.models().then(response => {
      if (cancelled) return;
      if (response.ok && response.result) setModels(response.result.models);
      else setLoadError(response.error?.reason ?? 'could not load the model list');
    });
    return () => { cancelled = true; };
  }, []);

  const verdicts = useMemo(() => {
    const map = new Map<PropagationModelId, Verdict>();
    for (const info of models) map.set(info.id, verdictFor(info, radios, radiusM));
    return map;
  }, [models, radios, radiusM]);

  const active = models.find(m => m.id === model);
  const verdict = verdicts.get(model);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor="rf-model" className="text-xs text-nms-text-dim">Model</label>
        <select
          id="rf-model" className="nms-input w-56"
          value={model} onChange={e => onChange(e.target.value as PropagationModelId)}
        >
          {models.length === 0 && <option value={model}>Loading…</option>}
          {models.map(info => {
            const v = verdicts.get(info.id);
            return (
              <option key={info.id} value={info.id}>
                {info.label}{v && !v.ok ? ' — out of range here' : ''}
              </option>
            );
          })}
        </select>
      </div>

      {loadError && <p className="text-xs text-nms-red">{loadError}</p>}

      {active && (
        <p className="text-xs text-nms-text-dim max-w-md">{active.blurb}</p>
      )}

      {verdict && !verdict.ok && (
        <p className="text-xs text-nms-amber flex items-start gap-1.5 max-w-md" role="status">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {verdict.reasons.join('; ')}. This model refuses inputs outside its published validity rather than
            extrapolating, so the run will be rejected. Pick a model that covers this band.
          </span>
        </p>
      )}
      {verdict?.ok && active && radios.length > 0 && (
        <p className="text-xs text-nms-green flex items-center gap-1.5">
          <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          Valid for this configuration
        </p>
      )}

      {/* Model-specific knobs, shown only for the model that uses them. */}
      {model === 'hata' && (
        <div className="flex items-center gap-1.5">
          <label htmlFor="rf-hata-env" className="text-xs text-nms-text-dim">Environment</label>
          <select
            id="rf-hata-env" className="nms-input w-36"
            value={modelOptions.hataEnvironment ?? 'urban'}
            onChange={e => onOptionsChange({ ...modelOptions, hataEnvironment: e.target.value as ModelOptions['hataEnvironment'] })}
          >
            <option value="urban">Urban</option>
            <option value="suburban">Suburban</option>
            <option value="open">Open / rural</option>
          </select>
        </div>
      )}

      {(model === 'cost231-hata' || model === 'walfisch-ikegami') && (
        <div className="flex items-center gap-1.5">
          <label htmlFor="rf-city" className="text-xs text-nms-text-dim">City type</label>
          <select
            id="rf-city" className="nms-input w-44"
            value={modelOptions.cityType ?? 'medium'}
            onChange={e => onOptionsChange({ ...modelOptions, cityType: e.target.value as ModelOptions['cityType'] })}
          >
            <option value="medium">Medium city / suburban</option>
            <option value="metropolitan">Metropolitan centre</option>
          </select>
        </div>
      )}

      {model === 'walfisch-ikegami' && (
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label htmlFor="rf-wi-mode" className="text-xs text-nms-text-dim">Mode</label>
            <select
              id="rf-wi-mode" className="nms-input w-28"
              value={modelOptions.walfischIkegamiMode ?? 'nlos'}
              onChange={e => onOptionsChange({ ...modelOptions, walfischIkegamiMode: e.target.value as 'los' | 'nlos' })}
            >
              <option value="nlos">NLOS</option>
              <option value="los">LOS</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor="rf-wi-height" className="text-xs text-nms-text-dim">Rooftop height (m)</label>
            <input
              id="rf-wi-height" type="number" step="1" min="1" className="nms-input w-20"
              value={modelOptions.buildingHeightM ?? ''}
              placeholder="auto"
              onChange={e => {
                const value = e.target.value === '' ? undefined : Number(e.target.value);
                onOptionsChange({ ...modelOptions, buildingHeightM: Number.isFinite(value) ? value : undefined });
              }}
            />
          </div>
          <p className="text-xs text-nms-text-dim">
            Left blank, the median measured height of the imported footprints is used.
          </p>
        </div>
      )}

      {model === 'log-distance' && (
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label htmlFor="rf-ld-env" className="text-xs text-nms-text-dim">Environment</label>
            <select
              id="rf-ld-env" className="nms-input w-40"
              value={modelOptions.logDistanceEnvironment ?? 'urban'}
              onChange={e => onOptionsChange({ ...modelOptions, logDistanceEnvironment: e.target.value as ModelOptions['logDistanceEnvironment'] })}
            >
              <option value="free-space">Free space (n=2.0)</option>
              <option value="urban">Urban (n=3.0)</option>
              <option value="dense-urban">Dense urban (n=4.0)</option>
              <option value="indoor">Indoor LOS (n=1.7)</option>
              <option value="suburban">Suburban (n=3.0)</option>
              <option value="rural">Rural (n=3.5)</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor="rf-ld-n" className="text-xs text-nms-text-dim">Exponent</label>
            <input
              id="rf-ld-n" type="number" step="0.1" min="1" max="6" className="nms-input w-20"
              value={modelOptions.pathLossExponent ?? ''}
              placeholder="preset"
              onChange={e => {
                const value = e.target.value === '' ? undefined : Number(e.target.value);
                onOptionsChange({ ...modelOptions, pathLossExponent: Number.isFinite(value) ? value : undefined });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
