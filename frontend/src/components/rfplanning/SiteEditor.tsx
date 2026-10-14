import { Trash2, Plus, Radio as RadioIcon, MapPin } from 'lucide-react';
import {
  nextSectorLabel,
  type PlanningRadio,
} from '../../api/rfSimulation';

// Site-level inspector.
//
// The split between this and SectorEditor follows the physical install rather
// than the data model: everything on this panel is a property of the MAST —
// where it stands, how high it is, what channel the site runs — so editing it
// writes to every sector at once. Anything that belongs to an individual
// panel (where it points, how wide, how much power) lives on the sector.
//
// Getting that boundary wrong is what makes a multi-sector editor painful:
// if height is per-sector you have to change it three times and they silently
// drift; if azimuth is per-site you cannot build a sectored site at all.

interface Props {
  siteId: string;
  sectors: PlanningRadio[];
  selectedSectorId: string | null;
  onPatchSite: (patch: Partial<PlanningRadio>) => void;
  onRenameSite: (siteName: string) => void;
  onSelectSector: (id: string) => void;
  onAddSector: (sector: PlanningRadio) => void;
  onDeleteSite: () => void;
}

const BANDWIDTHS: Record<PlanningRadio['technology'], number[]> = {
  '4g': [1.4, 3, 5, 10, 15, 20],
  '5g': [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100],
};

function Field(props: { label: string; unit?: string; hint?: string; children: React.ReactNode; htmlFor: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={props.htmlFor} className="text-xs text-nms-text-dim">
        {props.label}{props.unit ? ` (${props.unit})` : ''}
      </label>
      {props.children}
      {props.hint && <p className="text-xs text-nms-text-dim opacity-80">{props.hint}</p>}
    </div>
  );
}

export function SiteEditor(props: Props) {
  const { siteId, sectors, selectedSectorId, onPatchSite, onRenameSite, onSelectSector, onAddSector, onDeleteSite } = props;
  const first = sectors[0];
  if (!first) return null;

  const id = (suffix: string) => `site-${siteId}-${suffix}`;
  const numeric = (key: keyof PlanningRadio) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) onPatchSite({ [key]: value } as Partial<PlanningRadio>);
  };

  const addSector = () => {
    const label = nextSectorLabel(sectors);
    // Point the new panel at the widest gap between existing azimuths, which
    // is almost always where someone adding a sector actually wants it.
    const azimuths = sectors.map(s => s.azimuthDeg).sort((a, b) => a - b);
    let azimuthDeg = 0;
    if (azimuths.length > 0) {
      let widest = -1;
      for (let i = 0; i < azimuths.length; i++) {
        const current = azimuths[i];
        const next = i === azimuths.length - 1 ? azimuths[0] + 360 : azimuths[i + 1];
        const gap = next - current;
        if (gap > widest) { widest = gap; azimuthDeg = Math.round((current + gap / 2) % 360); }
      }
    }
    onAddSector({
      ...first,
      id: `${siteId}-${Date.now()}`,
      sectorLabel: label,
      name: `${first.siteName} ${label}`,
      azimuthDeg,
      locked: false,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <label htmlFor={id('name')} className="sr-only">Site name</label>
          <input
            id={id('name')}
            className="nms-input w-full font-medium"
            value={first.siteName}
            onChange={e => onRenameSite(e.target.value)}
            placeholder="Site name"
          />
          <p className="text-xs text-nms-text-dim mt-1">
            {sectors.length} sector{sectors.length === 1 ? '' : 's'} · changes here apply to all of them
          </p>
        </div>
        <button
          type="button" onClick={onDeleteSite}
          className="nms-btn-ghost p-1.5 border border-nms-border shrink-0"
          aria-label={`Delete site ${first.siteName} and all ${sectors.length} of its sectors`}
        >
          <Trash2 className="w-3.5 h-3.5 text-nms-red" aria-hidden="true" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Antenna height" unit="m" htmlFor={id('h')} hint="Above ground, all sectors">
          <input id={id('h')} type="number" step="1" min="1" className="nms-input" value={first.antennaHeightM} onChange={numeric('antennaHeightM')} />
        </Field>
        <Field label="Frequency" unit="GHz" htmlFor={id('f')} hint="CBRS n48: 3.55–3.70">
          <input id={id('f')} type="number" step="0.01" min="0.4" max="100" className="nms-input" value={first.frequencyGhz} onChange={numeric('frequencyGhz')} />
        </Field>
        <Field label="Technology" htmlFor={id('tech')}>
          <select
            id={id('tech')} className="nms-input" value={first.technology}
            onChange={e => {
              const technology = e.target.value as PlanningRadio['technology'];
              // Keep the channel width valid for the new technology instead of
              // letting the simulate call fail validation later.
              const allowed = BANDWIDTHS[technology];
              const bandwidthMhz = allowed.includes(first.bandwidthMhz) ? first.bandwidthMhz : 20;
              onPatchSite({ technology, bandwidthMhz });
            }}
          >
            <option value="5g">5G NR</option>
            <option value="4g">4G LTE</option>
          </select>
        </Field>
        <Field label="Channel" unit="MHz" htmlFor={id('bw')}>
          <select id={id('bw')} className="nms-input" value={first.bandwidthMhz} onChange={e => onPatchSite({ bandwidthMhz: Number(e.target.value) })}>
            {BANDWIDTHS[first.technology].map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </Field>
        <Field label="Latitude" unit="°" htmlFor={id('lat')}>
          <input id={id('lat')} type="number" step="0.000001" className="nms-input" value={first.latitude} onChange={numeric('latitude')} />
        </Field>
        <Field label="Longitude" unit="°" htmlFor={id('lon')}>
          <input id={id('lon')} type="number" step="0.000001" className="nms-input" value={first.longitude} onChange={numeric('longitude')} />
        </Field>
      </div>

      <p className="text-xs text-nms-text-dim flex items-start gap-1.5">
        <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
        Drag the site marker on the map to reposition every sector together.
      </p>

      <div className="border-t border-nms-border pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium">Sectors</h4>
          <button
            type="button" onClick={addSector}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-nms-border-strong hover:bg-nms-surface"
          >
            <Plus className="w-3 h-3" aria-hidden="true" />Add sector
          </button>
        </div>
        <ul className="space-y-1">
          {sectors.map(sector => (
            <li key={sector.id}>
              <button
                type="button"
                onClick={() => onSelectSector(sector.id)}
                aria-current={sector.id === selectedSectorId ? 'true' : undefined}
                className={`w-full flex items-center gap-2 text-left px-2 py-1.5 rounded border text-xs ${
                  sector.id === selectedSectorId
                    ? 'border-nms-accent bg-nms-surface'
                    : 'border-nms-border hover:bg-nms-surface'
                }`}
              >
                <RadioIcon className="w-3.5 h-3.5 shrink-0 text-nms-text-dim" aria-hidden="true" />
                <span className="font-medium">{sector.sectorLabel}</span>
                <span className="text-nms-text-dim">
                  {sector.azimuthDeg}° / {sector.beamWidthDeg}° · {sector.txPowerDbm} dBm
                </span>
                {sector.locked && <span className="ml-auto text-nms-amber">locked</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
