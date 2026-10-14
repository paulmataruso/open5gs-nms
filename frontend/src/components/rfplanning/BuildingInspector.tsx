import { useCallback, useState } from 'react';
import { Loader2, Building2 } from 'lucide-react';
import {
  rfSimulationApi,
  type PlanningBuilding, type QualityEntry,
} from '../../api/rfSimulation';

// Building inspector.
//
// Selecting a footprint on the map lands here, which is also where the
// outdoor-to-indoor entry loss calculation is reachable: O2I only means
// anything against a specific building's own construction, so a standalone
// calculator detached from the map was the wrong home for it.

interface Props {
  building: PlanningBuilding;
  quality: QualityEntry | null;
  frequencyGhz: number;
}

const QUALITY_TEXT: Record<string, string> = {
  good: 'Good — signal, SINR and RSRQ all above the service thresholds.',
  fair: 'Fair — usable, with margin eaten by interference or range.',
  poor: 'Poor — below at least one service threshold.',
  unusable: 'Unusable — no serving cell meets the thresholds here.',
};

export function BuildingInspector({ building, quality, frequencyGhz }: Props) {
  const [entry, setEntry] = useState<null | {
    profileId: string; externalWallLossDb: number; medianEntryLossDb: number;
    referenceShadowSigmaDb: number; applicable: boolean; applicabilityDetail: string; profileSource: string;
  }>(null);
  const [profileId, setProfileId] = useState<'low_loss' | 'high_loss'>('low_loss');
  const [depthM, setDepthM] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compute = useCallback(async () => {
    setBusy(true);
    setError(null);
    const response = await rfSimulationApi.buildingEntry({
      frequencyGhz, profileId, indoorDepthM: depthM, tags: building.tags,
    });
    setBusy(false);
    if (!response.ok || !response.result) {
      setError(response.error?.reason ?? 'could not compute entry loss');
      return;
    }
    setEntry(response.result);
  }, [frequencyGhz, profileId, depthM, building.tags]);

  const demand = building.demandWeight + building.residentialDemand;
  const indoorDbm = quality && entry ? quality.rsrpDbm - entry.medianEntryLossDb : null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Building2 className="w-4 h-4 shrink-0 text-nms-text-dim" aria-hidden="true" />
          <span className="truncate">{building.id}</span>
        </h3>
        <p className="text-xs text-nms-text-dim mt-1">
          Demand {demand.toFixed(0)}
          {building.heightM ? ` · ${building.heightM} m tall` : ' · height not in source data'}
          {building.tags?.building ? ` · ${building.tags.building}` : ''}
        </p>
      </div>

      <section className="space-y-1">
        <h4 className="text-xs font-medium">Outdoor signal</h4>
        {quality ? (
          <>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-nms-text-dim">RSRP</dt><dd>{quality.rsrpDbm} dBm</dd>
              <dt className="text-nms-text-dim">SINR</dt><dd>{quality.sinrDb} dB</dd>
              <dt className="text-nms-text-dim">RSRQ</dt><dd>{quality.rsrqDb} dB</dd>
              <dt className="text-nms-text-dim">RSSI</dt><dd>{quality.rssiDbm} dBm</dd>
              <dt className="text-nms-text-dim">Serving</dt><dd className="truncate">{quality.servingCellId}</dd>
              <dt className="text-nms-text-dim">Interferers</dt><dd>{quality.interfererCount}</dd>
            </dl>
            <p className="text-xs text-nms-text-dim">{QUALITY_TEXT[quality.qualityClass]}</p>
            {quality.interferenceLimited && (
              <p className="text-xs text-nms-amber">
                Interference-limited: more power will not help here, re-pointing or de-loading a neighbour will.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-nms-text-dim">
            Not evaluated yet — run Simulate, or this footprint falls outside every sector's beam.
          </p>
        )}
      </section>

      <section className="space-y-2 border-t border-nms-border pt-3">
        <h4 className="text-xs font-medium">Indoor penetration (O2I)</h4>
        <p className="text-xs text-nms-text-dim">
          3GPP TR 38.901 building entry loss at {frequencyGhz} GHz.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`o2i-profile-${building.id}`} className="text-xs text-nms-text-dim">Construction</label>
            <select
              id={`o2i-profile-${building.id}`} className="nms-input"
              value={profileId} onChange={e => setProfileId(e.target.value as 'low_loss' | 'high_loss')}
            >
              <option value="low_loss">Low loss (standard glass / concrete)</option>
              <option value="high_loss">High loss (IRR glass / concrete)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`o2i-depth-${building.id}`} className="text-xs text-nms-text-dim">Depth inside (m)</label>
            <input
              id={`o2i-depth-${building.id}`} type="number" step="1" min="0" className="nms-input"
              value={depthM} onChange={e => setDepthM(Number(e.target.value) || 0)}
            />
          </div>
        </div>
        <button
          type="button" onClick={compute} disabled={busy}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs border border-nms-border-strong hover:bg-nms-surface disabled:opacity-50"
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
          Compute entry loss
        </button>

        {error && <p className="text-xs text-nms-red">{error}</p>}

        {entry && (
          <div className="space-y-1 text-xs">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-nms-text-dim">External wall</dt><dd>{entry.externalWallLossDb.toFixed(2)} dB</dd>
              <dt className="text-nms-text-dim">Median entry loss</dt><dd>{entry.medianEntryLossDb.toFixed(2)} dB</dd>
              <dt className="text-nms-text-dim">Shadow σ</dt><dd>±{entry.referenceShadowSigmaDb.toFixed(1)} dB</dd>
            </dl>
            {indoorDbm !== null && (
              <p>
                Indoor estimate: <strong>{indoorDbm.toFixed(1)} dBm</strong>{' '}
                <span className="text-nms-text-dim">(outdoor RSRP less entry loss)</span>
              </p>
            )}
            {!entry.applicable && <p className="text-nms-amber">{entry.applicabilityDetail}</p>}
            <p className="text-nms-text-dim opacity-80">{entry.profileSource}</p>
          </div>
        )}
      </section>
    </div>
  );
}
